import { basename, dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { DEFAULT_EXCLUDE } from './config.js'
import { matches } from './glob.js'

export interface Ref {
  name: string
  /** Project file that declares it, undefined for library code */
  file?: string
  /** Where the reference appears */
  at: { file: string; line: number }
  forwardRef?: boolean
}

export interface NestModule {
  name: string
  file: string
  dir: string
  line: number
  global: boolean
  imports: Ref[]
  /** Token ids this module provides */
  providers: string[]
  /** Token ids of exported providers and re-exported modules */
  exports: string[]
}

export interface FileImport {
  from: string
  to?: string
  pkg?: string
  specifier: string
  line: number
  typeOnly: boolean
}

export interface Injection {
  /** Id of the injecting module, "file#Name" */
  module: string
  className: string
  file: string
  line: number
  token: string
  tokenName: string
}

export interface ProjectGraph {
  root: string
  files: string[]
  modules: NestModule[]
  imports: FileImport[]
  injections: Injection[]
  ignoredLines: Map<string, Set<number>>
  /** Modules whose folder holds other modules and sits under no module, usually AppModule */
  roots: NestModule[]
  owner(file: string): NestModule | undefined
}

export interface AnalyzeOptions {
  project?: string
  exclude?: string[]
}

const NEST_PACKAGES = new Set(['@nestjs/common'])

export function analyzeProject(root: string, options: AnalyzeOptions = {}): ProjectGraph {
  root = resolve(root)
  const tsconfig = resolve(root, options.project ?? 'tsconfig.json')
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile)
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig))
  const exclude = options.exclude ?? DEFAULT_EXCLUDE
  const rel = (f: string) => relative(root, f).split('\\').join('/')
  const inProject = (f: string) => !f.includes('/node_modules/') && !rel(f).startsWith('..')

  const rootNames = parsed.fileNames.filter(
    (f) => !f.endsWith('.d.ts') && inProject(f) && !matches(rel(f), exclude),
  )
  const compilerOptions = { ...parsed.options, noEmit: true, types: [], incremental: false }
  const program = ts.createProgram({ rootNames, options: compilerOptions })
  const resolutionCache = ts.createModuleResolutionCache(root, (f) => f, compilerOptions)
  const checker = program.getTypeChecker()
  const sources = rootNames.map((f) => program.getSourceFile(f)).filter((sf): sf is ts.SourceFile => !!sf)

  const lineOf = (node: ts.Node) => {
    const sf = node.getSourceFile()
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  }
  const at = (node: ts.Node) => ({ file: rel(node.getSourceFile().fileName), line: lineOf(node) })

  const nestNames = new Map<ts.SourceFile, Map<string, string>>()
  const nestName = (sf: ts.SourceFile, callee: ts.Expression): string | undefined => {
    let names = nestNames.get(sf)
    if (!names) {
      names = new Map()
      for (const s of sf.statements) {
        if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue
        if (!NEST_PACKAGES.has(s.moduleSpecifier.text)) continue
        const b = s.importClause?.namedBindings
        if (b && ts.isNamespaceImport(b)) names.set(b.name.text, '*')
        if (b && ts.isNamedImports(b)) {
          for (const el of b.elements) names.set(el.name.text, (el.propertyName ?? el.name).text)
        }
      }
      nestNames.set(sf, names)
    }
    if (ts.isIdentifier(callee)) return names.get(callee.text)
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      names.get(callee.expression.text) === '*'
    ) {
      return callee.name.text
    }
  }
  const decorators = (node: ts.Node) => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
  const decoratorName = (d: ts.Decorator) => {
    const e = d.expression
    return nestName(d.getSourceFile(), ts.isCallExpression(e) ? e.expression : e)
  }

  const declarationOf = (node: ts.Node): ts.Declaration | undefined => {
    let sym = checker.getSymbolAtLocation(node)
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
    return sym?.declarations?.[0]
  }
  const declFile = (decl: ts.Declaration | undefined) => {
    const f = decl?.getSourceFile().fileName
    return f && inProject(f) && !f.endsWith('.d.ts') ? rel(f) : undefined
  }
  const declName = (decl: ts.Declaration | undefined, fallback: string) => {
    const name = decl && ts.getNameOfDeclaration(decl)
    return name && ts.isIdentifier(name) ? name.text : fallback
  }
  // `import { Foo }` where every Foo is an interface or type alias is erased at runtime like `import type`.
  const onlyTypesUsed = (s: ts.ImportDeclaration) => {
    const c = s.importClause
    const b = c?.namedBindings
    if (!c || (b && !ts.isNamedImports(b))) return false
    const names = [
      ...(c.name ? [c.name] : []),
      ...(b && ts.isNamedImports(b) ? b.elements.map((e) => e.name) : []),
    ]
    return (
      names.length > 0 &&
      names.every((n) => {
        let sym = checker.getSymbolAtLocation(n)
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
        return !!sym?.declarations?.length && !(sym.flags & ts.SymbolFlags.Value)
      })
    )
  }
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)
      ? unwrap(e.expression)
      : e
  const initializerOf = (e: ts.Expression) => {
    const decl = declarationOf(e)
    return decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined
  }

  const elements = (e: ts.Expression | undefined, depth = 0): ts.Expression[] => {
    if (!e || depth > 10) return []
    e = unwrap(e)
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.flatMap((el) => (ts.isSpreadElement(el) ? elements(el.expression, depth + 1) : [el]))
    }
    if (ts.isConditionalExpression(e)) {
      return [...elements(e.whenTrue, depth + 1), ...elements(e.whenFalse, depth + 1)]
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) return elements(initializerOf(e), depth + 1)
    return []
  }

  const moduleRef = (e: ts.Expression, site: ts.Node = e, depth = 0): Ref | undefined => {
    if (depth > 10) return
    e = unwrap(e)
    if (ts.isCallExpression(e)) {
      const callee = e.expression
      const fn = e.arguments[0]
      if (ts.isIdentifier(callee) && callee.text === 'forwardRef') {
        if (fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
          const ref = moduleRef(fn.body, site, depth + 1)
          return ref && { ...ref, forwardRef: true }
        }
        return
      }
      return ts.isPropertyAccessExpression(callee) ? moduleRef(callee.expression, site, depth + 1) : undefined
    }
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return
    const decl = declarationOf(e)
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return moduleRef(decl.initializer, site, depth + 1)
    }
    return { name: declName(decl, e.getText()), file: declFile(decl), at: at(site) }
  }

  const tokenOf = (e: ts.Expression): { token: string; name: string } | undefined => {
    e = unwrap(e)
    if (ts.isStringLiteralLike(e)) return { token: JSON.stringify(e.text), name: JSON.stringify(e.text) }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'forwardRef') {
      const fn = e.arguments[0]
      return fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body) ? tokenOf(fn.body) : undefined
    }
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return
    const decl = declarationOf(e)
    const name = declName(decl, e.getText())
    const file = declFile(decl)
    return { token: file ? `${file}#${name}` : `external#${name}`, name }
  }
  const classOf = (e: ts.Expression | undefined) => {
    if (!e) return
    const decl = declarationOf(unwrap(e))
    return decl && ts.isClassDeclaration(decl) && declFile(decl) ? decl : undefined
  }

  const modules: NestModule[] = []
  const imports: FileImport[] = []
  const injections: Injection[] = []
  const ignoredLines = new Map<string, Set<number>>()
  const pendingInjections: { module: string; cls: ts.ClassDeclaration }[] = []

  const readMetadata = (obj: ts.ObjectLiteralExpression, mod: NestModule) => {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue
      const key = keyOf(prop)
      const value = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name
      if (key === 'global' && value.kind === ts.SyntaxKind.TrueKeyword) mod.global = true
      if (key === 'imports') {
        for (const el of elements(value)) {
          const ref = moduleRef(el)
          if (ref) mod.imports.push(ref)
        }
      }
      if (key === 'exports') {
        for (const el of elements(value)) {
          const t = tokenOf(el)
          if (t) mod.exports.push(t.token)
        }
      }
      if (key === 'controllers' || key === 'providers') {
        for (const el of elements(value)) {
          const item = unwrap(el)
          if (ts.isObjectLiteralExpression(item)) {
            const get = (k: string) => {
              const p = item.properties.find((p) => keyOf(p) === k)
              return p && ts.isPropertyAssignment(p) ? p.initializer : undefined
            }
            const provide = get('provide')
            const t = provide && tokenOf(provide)
            if (t) mod.providers.push(t.token)
            const cls = classOf(get('useClass'))
            if (cls) pendingInjections.push({ module: moduleId(mod), cls })
            continue
          }
          const t = tokenOf(item)
          if (t && key === 'providers') mod.providers.push(t.token)
          const cls = classOf(item)
          if (cls) pendingInjections.push({ module: moduleId(mod), cls })
        }
      }
    }
  }

  for (const sf of sources) {
    const file = rel(sf.fileName)
    const lines = sf.text.split('\n')
    lines.forEach((l, i) => {
      if (!l.includes('arch-guard-ignore-next-line')) return
      const set = ignoredLines.get(file) ?? new Set()
      set.add(i + 2)
      ignoredLines.set(file, set)
    })

    const addImport = (spec: ts.StringLiteralLike, typeOnly: boolean) => {
      const mode = ts.getModeForUsageLocation(sf, spec, compilerOptions)
      const resolved = ts.resolveModuleName(
        spec.text,
        sf.fileName,
        compilerOptions,
        ts.sys,
        resolutionCache,
        undefined,
        mode,
      ).resolvedModule
      const target = resolved?.resolvedFileName
      const internal = target && !resolved.isExternalLibraryImport && inProject(target)
      const relative = spec.text.startsWith('.')
      if (!internal && relative) return
      imports.push({
        from: file,
        to: internal ? rel(target) : undefined,
        pkg: internal ? undefined : packageName(spec.text),
        specifier: spec.text,
        line: lineOf(spec),
        typeOnly,
      })
    }
    for (const s of sf.statements) {
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
        addImport(s.moduleSpecifier, isTypeOnlyImport(s) || onlyTypesUsed(s))
      } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
        addImport(s.moduleSpecifier, s.isTypeOnly)
      } else if (
        ts.isImportEqualsDeclaration(s) &&
        ts.isExternalModuleReference(s.moduleReference) &&
        ts.isStringLiteral(s.moduleReference.expression)
      ) {
        addImport(s.moduleReference.expression, s.isTypeOnly)
      }
    }
    if (sf.text.includes('import(')) {
      const visit = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          n.expression.kind === ts.SyntaxKind.ImportKeyword &&
          n.arguments[0] &&
          ts.isStringLiteralLike(n.arguments[0])
        ) {
          addImport(n.arguments[0], false)
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }

    for (const s of sf.statements) {
      if (!ts.isClassDeclaration(s) || !s.name) continue
      const decs = decorators(s)
      const moduleDec = decs.find((d) => decoratorName(d) === 'Module')
      if (!moduleDec) continue
      const mod: NestModule = {
        name: s.name.text,
        file,
        dir: dirOf(file),
        line: lineOf(s.name),
        global: decs.some((d) => decoratorName(d) === 'Global'),
        imports: [],
        providers: [],
        exports: [],
      }
      const arg = ts.isCallExpression(moduleDec.expression) ? moduleDec.expression.arguments[0] : undefined
      const meta = arg && objectOf(arg)
      if (meta) readMetadata(meta, mod)
      // Dynamic modules: static forRoot()/register() returning { module: X, imports, providers, exports }.
      for (const m of s.members) {
        if (!ts.isMethodDeclaration(m) || !m.body) continue
        if (!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)) continue
        const visit = (n: ts.Node): void => {
          if (ts.isObjectLiteralExpression(n) && n.properties.some((p) => keyOf(p) === 'module')) {
            readMetadata(n, mod)
          }
          ts.forEachChild(n, visit)
        }
        visit(m.body)
      }
      modules.push(mod)
    }
  }

  function objectOf(e: ts.Expression): ts.ObjectLiteralExpression | undefined {
    e = unwrap(e)
    if (ts.isObjectLiteralExpression(e)) return e
    if (ts.isIdentifier(e)) {
      const init = initializerOf(e)
      return init && objectOf(init)
    }
  }

  const seen = new Set<string>()
  for (const { module, cls } of pendingInjections) {
    const key = `${module}|${cls.getSourceFile().fileName}|${cls.name?.text}`
    if (seen.has(key)) continue
    seen.add(key)
    const ctor = cls.members.find(ts.isConstructorDeclaration)
    for (const p of ctor?.parameters ?? []) {
      const decs = decorators(p)
      const inject = decs.find((d) => decoratorName(d) === 'Inject')
      let t: { token: string; name: string } | undefined
      if (inject) {
        const a = ts.isCallExpression(inject.expression) ? inject.expression.arguments[0] : undefined
        t = a && tokenOf(a)
      } else if (!decs.length && p.type && ts.isTypeReferenceNode(p.type)) {
        const decl = declarationOf(p.type.typeName)
        const file = declFile(decl)
        if (decl && file && ts.isClassDeclaration(decl)) {
          const name = declName(decl, p.type.typeName.getText())
          t = { token: `${file}#${name}`, name }
        }
      }
      if (!t || t.token.startsWith('external#')) continue
      injections.push({
        module,
        className: cls.name?.text ?? 'anonymous class',
        file: rel(cls.getSourceFile().fileName),
        line: lineOf(p),
        token: t.token,
        tokenName: t.name,
      })
    }
  }

  modules.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file))
  // The top module folder (AppModule in src/) holds shared code next to the feature modules, so it
  // only owns its own files. Feature modules own their subfolders that have no module of their own.
  const contains = (m: NestModule, o: NestModule) => o.dir !== m.dir && isUnder(o.dir, m.dir)
  const roots = new Set(
    modules.filter((m) => modules.some((o) => contains(m, o)) && !modules.some((o) => contains(o, m))),
  )
  const ownerCache = new Map<string, NestModule | undefined>()
  const owner = (file: string) => {
    if (ownerCache.has(file)) return ownerCache.get(file)
    const dir = dirOf(file)
    const candidates = modules.filter((m) => isUnder(dir, m.dir))
    const depth = Math.max(-1, ...candidates.map((m) => m.dir.length))
    let closest = candidates.filter((m) => m.dir.length === depth)
    if (closest[0] && roots.has(closest[0]) && dir !== closest[0].dir) closest = []
    const own = closest.find((m) => m.file === file) ?? bestNameMatch(closest, file)
    ownerCache.set(file, own)
    return own
  }

  return {
    root,
    files: sources.map((sf) => rel(sf.fileName)),
    modules,
    imports,
    injections,
    ignoredLines,
    roots: [...roots],
    owner,
  }
}

function keyOf(p: ts.ObjectLiteralElementLike): string | undefined {
  return p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined
}

function isTypeOnlyImport(s: ts.ImportDeclaration): boolean {
  const c = s.importClause
  if (!c) return false
  if (c.isTypeOnly) return true
  if (c.name) return false
  const b = c.namedBindings
  return !!b && ts.isNamedImports(b) && b.elements.length > 0 && b.elements.every((e) => e.isTypeOnly)
}

export function packageName(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

export const moduleId = (m: { file: string; name: string }) => `${m.file}#${m.name}`

export const dirOf = (file: string) => {
  const d = dirname(file)
  return d === '.' ? '' : d
}

export const isUnder = (dir: string, parent: string) =>
  parent === '' || dir === parent || dir.startsWith(`${parent}/`)

function bestNameMatch(mods: NestModule[], file: string): NestModule | undefined {
  if (mods.length < 2) return mods[0]
  const name = basename(file)
  const prefix = (a: string) => {
    let i = 0
    while (i < a.length && a[i] === name[i]) i++
    return i
  }
  return mods.reduce((best, m) => (prefix(basename(m.file)) > prefix(basename(best.file)) ? m : best))
}
