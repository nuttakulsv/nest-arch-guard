import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isUnder, moduleId, type NestModule, type ProjectGraph } from './analyze.js'
import {
  type ArchConfig,
  type BoundaryDef,
  DEFAULT_PUBLIC_FILES,
  type RuleId,
  type Severity,
} from './config.js'
import { globRoot, matches } from './glob.js'

export interface Violation {
  rule: RuleId
  severity: Severity
  file: string
  line: number
  message: string
  /** Stable id for the baseline, without line numbers */
  key: string
  /** Module pairs involved, used to highlight edges in diagrams */
  edges?: [string, string][]
}

export interface Boundary {
  name: string
  paths: string[]
  modules: string[]
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

function normalizePath(p: string): string {
  p = p.replace(/^\.\//, '').replace(/\/$/, '')
  const last = p.split('/').pop() ?? ''
  return /[*?{[]/.test(p) || last.includes('.') ? p : `${p}/**`
}

export function boundariesOf(config: ArchConfig, graph: ProjectGraph): Boundary[] {
  if (!config.boundaries) {
    return graph.modules.map((m) => ({ name: m.name, paths: [], modules: [m.name] }))
  }
  return Object.entries(config.boundaries).map(([name, def]) => {
    const d: BoundaryDef = typeof def === 'string' || Array.isArray(def) ? { paths: def } : def
    return { name, paths: arr(d.paths).map(normalizePath), modules: arr(d.modules) }
  })
}

/** The most specific boundary wins, so `src/orders/domain` beats `src/orders` in any order. */
export function boundaryLookup(boundaries: Boundary[], graph: ProjectGraph) {
  const cache = new Map<string, string | undefined>()
  return (file: string) => {
    if (cache.has(file)) return cache.get(file)
    const owner = graph.owner(file)
    let best: string | undefined
    let score = -1
    for (const b of boundaries) {
      for (const p of b.paths) {
        const s = globRoot(p).length
        if (s > score && matches(file, p)) [best, score] = [b.name, s]
      }
      if (owner && b.modules.includes(owner.name) && owner.dir.length > score) {
        ;[best, score] = [b.name, owner.dir.length]
      }
    }
    cache.set(file, best)
    return best
  }
}

function validate(config: ArchConfig, boundaries: Boundary[]) {
  const names = new Set([...boundaries.map((b) => b.name), '*'])
  const check = (list: string[] | string | undefined, where: string) => {
    for (const n of arr(list)) {
      if (!names.has(n)) {
        throw new Error(
          `Unknown boundary "${n}" in ${where}. Known: ${[...names].filter((x) => x !== '*').join(', ')}`,
        )
      }
    }
  }
  config.rules?.dependencies?.forEach((r, i) => {
    check(r.from, `rules.dependencies[${i}].from`)
    check(r.allow, `rules.dependencies[${i}].allow`)
    check(r.deny, `rules.dependencies[${i}].deny`)
  })
  config.rules?.forbidden?.forEach((r, i) => check(r.from, `rules.forbidden[${i}].from`))
}

export function checkGraph(config: ArchConfig, graph: ProjectGraph): Violation[] {
  const rules = config.rules ?? {}
  const boundaries = boundariesOf(config, graph)
  validate(config, boundaries)
  const boundaryOf = boundaryLookup(boundaries, graph)
  const out: Violation[] = []
  const add = (v: Omit<Violation, 'severity'>, severity: Severity = 'error') => out.push({ ...v, severity })
  const pair = (a: string, b: string): [string, string][] => {
    const x = graph.owner(a)
    const y = graph.owner(b)
    return x && y && x !== y ? [[moduleId(x), moduleId(y)]] : []
  }
  const internal = graph.imports.filter((i): i is typeof i & { to: string } => i.to !== undefined)

  for (const rule of rules.dependencies ?? []) {
    const from = arr(rule.from)
    for (const imp of internal) {
      const a = boundaryOf(imp.from)
      const b = boundaryOf(imp.to)
      if (!a || !b || a === b || !(from.includes(a) || from.includes('*'))) continue
      const denied = rule.deny?.includes(b) || rule.deny?.includes('*')
      const notAllowed = rule.allow && !rule.allow.includes(b) && !rule.allow.includes('*')
      if (!denied && !notAllowed) continue
      add(
        {
          rule: 'dependencies',
          file: imp.from,
          line: imp.line,
          message: rule.message ?? `${a} may not depend on ${b} (imports ${imp.to})`,
          key: `dependencies:${imp.from}:${imp.to}`,
          edges: pair(imp.from, imp.to),
        },
        rule.severity,
      )
    }
  }

  if (rules.layers) {
    const { order, strict, severity } = rules.layers
    const layerOf = (f: string) => order.findIndex((l) => matches(f, l.files))
    for (const imp of internal) {
      const i = layerOf(imp.from)
      const j = layerOf(imp.to)
      if (i < 0 || j < 0 || i === j) continue
      const up = j < i
      if (!up && !(strict && j > i + 1)) continue
      const [lower, upper] = [order[i]!.name, order[j]!.name]
      add(
        {
          rule: 'layers',
          file: imp.from,
          line: imp.line,
          message: up
            ? `${lower} may not use ${upper}, which is a higher layer (imports ${imp.to})`
            : `${lower} skips ${order[i + 1]!.name} to use ${upper} (imports ${imp.to})`,
          key: `layers:${imp.from}:${imp.to}`,
          edges: pair(imp.from, imp.to),
        },
        severity,
      )
    }
  }

  if (rules.noCycles) {
    const opts = rules.noCycles === true ? {} : rules.noCycles
    if (opts.modules !== false) moduleCycles(graph, opts.severity, add)
    if (opts.files !== false) fileCycles(graph, opts.severity, add)
  }

  if (rules.onlyThroughPublicApi) {
    const opts = rules.onlyThroughPublicApi === true ? {} : rules.onlyThroughPublicApi
    const fileSet = new Set(graph.files)
    // A module nested in another one's folder (an adapter under users/infrastructure) is part of that feature.
    const sameFeature = (a: NestModule, b: NestModule) =>
      !graph.roots.includes(a) && !graph.roots.includes(b) && (isUnder(a.dir, b.dir) || isUnder(b.dir, a.dir))
    const publicFiles = new Map<NestModule, Set<string>>()
    const publicOf = (m: NestModule) => {
      let set = publicFiles.get(m)
      if (!set) {
        set = new Set([
          m.file,
          ...['index.ts', 'index.mts', 'index.js'].map((f) => (m.dir ? `${m.dir}/${f}` : f)),
        ])
        for (const t of m.exports) set.add(t.slice(0, t.lastIndexOf('#')))
        publicFiles.set(m, set)
      }
      return set
    }
    for (const imp of internal) {
      const target = graph.owner(imp.to)
      const source = graph.owner(imp.from)
      if (!target || source === target || !fileSet.has(imp.to) || (imp.typeOnly && !opts.types)) continue
      if (source && sameFeature(source, target)) continue
      if (publicOf(target).has(imp.to) || matches(imp.to, opts.files ?? DEFAULT_PUBLIC_FILES)) continue
      add(
        {
          rule: 'onlyThroughPublicApi',
          file: imp.from,
          line: imp.line,
          message: `${source?.name ?? imp.from} imports ${imp.to}, which is internal to ${target.name}`,
          key: `onlyThroughPublicApi:${imp.from}:${imp.to}`,
          edges: pair(imp.from, imp.to),
        },
        opts.severity,
      )
    }

    const byId = new Map(graph.modules.map((m) => [moduleId(m), m]))
    const providedBy = new Map<string, NestModule[]>()
    for (const m of graph.modules) {
      for (const t of m.providers) providedBy.set(t, [...(providedBy.get(t) ?? []), m])
    }
    for (const inj of graph.injections) {
      const own = byId.get(inj.module)
      if (!own || own.providers.includes(inj.token)) continue
      const providers = (providedBy.get(inj.token) ?? []).filter((m) => m !== own)
      if (!providers.length || providers.some((m) => m.exports.includes(inj.token))) continue
      add(
        {
          rule: 'onlyThroughPublicApi',
          file: inj.file,
          line: inj.line,
          message: `${inj.className} injects ${inj.tokenName}, which ${providers[0]!.name} provides but does not export`,
          key: `onlyThroughPublicApi:inject:${inj.file}:${inj.token}`,
          edges: [[inj.module, moduleId(providers[0]!)]],
        },
        opts.severity,
      )
    }
  }

  if (rules.noDeepImports) {
    const severity = rules.noDeepImports === true ? undefined : rules.noDeepImports.severity
    const fileSet = new Set(graph.files)
    const entries = new Map<string, string | undefined>()
    for (const b of boundaries) {
      const mod = graph.modules.find((m) => b.modules.includes(m.name))
      const root = b.paths[0] !== undefined ? globRoot(b.paths[0]) : mod?.dir
      if (root === undefined) continue
      const entry = ['index.ts', 'index.mts', 'index.js']
        .map((f) => (root ? `${root}/${f}` : f))
        .find((f) => fileSet.has(f))
      entries.set(b.name, entry)
    }
    for (const imp of internal) {
      const a = boundaryOf(imp.from)
      const b = boundaryOf(imp.to)
      const entry = b && entries.get(b)
      if (!a || !b || a === b || !entry || imp.to === entry) continue
      add(
        {
          rule: 'noDeepImports',
          file: imp.from,
          line: imp.line,
          message: `Imports ${imp.to} directly. Use ${entry} instead`,
          key: `noDeepImports:${imp.from}:${imp.to}`,
          edges: pair(imp.from, imp.to),
        },
        severity,
      )
    }
  }

  for (const rule of rules.forbidden ?? []) {
    const from = arr(rule.from)
    for (const imp of graph.imports) {
      if (!imp.pkg) continue
      const b = boundaryOf(imp.from)
      if (!b || !(from.includes(b) || from.includes('*'))) continue
      if (!matches(imp.pkg, rule.packages) && !matches(imp.specifier, rule.packages)) continue
      add(
        {
          rule: 'forbidden',
          file: imp.from,
          line: imp.line,
          message: rule.message ?? `${b} may not use ${imp.specifier}`,
          key: `forbidden:${imp.from}:${imp.specifier}`,
        },
        rule.severity,
      )
    }
  }

  const ignored = (v: Violation) => graph.ignoredLines.get(v.file)?.has(v.line)
  const unique = new Map<string, Violation>()
  for (const v of out) if (!ignored(v)) unique.set(`${v.key}:${v.line}`, v)
  return [...unique.values()].sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line,
  )
}

type Add = (v: Omit<Violation, 'severity'>, severity?: Severity) => void

function moduleCycles(graph: ProjectGraph, severity: Severity | undefined, add: Add) {
  const byFile = new Map(graph.modules.map((m) => [moduleId(m), m]))
  const edges = new Map<string, { to: string; line: number; file: string; forwardRef?: boolean }[]>()
  for (const m of graph.modules) {
    const list = m.imports
      .filter((r) => r.file && byFile.has(`${r.file}#${r.name}`))
      .map((r) => ({ to: `${r.file}#${r.name}`, line: r.at.line, file: r.at.file, forwardRef: r.forwardRef }))
    edges.set(moduleId(m), list)
  }
  for (const cycle of findCycles([...byFile.keys()], (n) => edges.get(n)?.map((e) => e.to) ?? [])) {
    const first = edges.get(cycle[0]!)!.find((e) => e.to === cycle[1])!
    const names = cycle.map((id) => byFile.get(id)!.name)
    const forwardRef = cycle.some((id, i) => edges.get(id)?.find((e) => e.to === cycle[i + 1])?.forwardRef)
    add(
      {
        rule: 'noCycles',
        file: first.file,
        line: first.line,
        message: `Module cycle: ${names.join(' → ')}${forwardRef ? ' (held together with forwardRef)' : ''}`,
        key: `noCycles:modules:${[...new Set(names)].sort().join(',')}`,
        edges: cycle.slice(1).map((id, i) => [cycle[i]!, id]),
      },
      severity,
    )
  }
}

function fileCycles(graph: ProjectGraph, severity: Severity | undefined, add: Add) {
  const edges = new Map<string, { to: string; line: number }[]>()
  for (const imp of graph.imports) {
    if (!imp.to || imp.typeOnly) continue
    edges.set(imp.from, [...(edges.get(imp.from) ?? []), { to: imp.to, line: imp.line }])
  }
  for (const cycle of findCycles(graph.files, (n) => edges.get(n)?.map((e) => e.to) ?? [])) {
    const first = edges.get(cycle[0]!)!.find((e) => e.to === cycle[1])!
    const shown = cycle.length > 7 ? [...cycle.slice(0, 6), '…', cycle.at(-1)!] : cycle
    add(
      {
        rule: 'noCycles',
        file: cycle[0]!,
        line: first.line,
        message: `Import cycle: ${shown.join(' → ')}`,
        key: `noCycles:files:${[...new Set(cycle)].sort().join(',')}`,
      },
      severity,
    )
  }
}

/** One shortest cycle per strongly connected component, as [a, b, ..., a]. */
export function findCycles(nodes: string[], next: (n: string) => string[]): string[][] {
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const sccs: string[][] = []
  const strong = (v: string) => {
    idx.set(v, index)
    low.set(v, index++)
    stack.push(v)
    onStack.add(v)
    for (const w of next(v)) {
      if (!idx.has(w)) {
        strong(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!))
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
      } while (w !== v)
      if (scc.length > 1 || next(v).includes(v)) sccs.push(scc)
    }
  }
  for (const n of nodes) if (!idx.has(n)) strong(n)

  return sccs.map((scc) => {
    const members = new Set(scc)
    const start = [...scc].sort()[0]!
    const parent = new Map<string, string>()
    const queue = [start]
    while (queue.length) {
      const v = queue.shift()!
      for (const w of next(v)) {
        if (!members.has(w)) continue
        if (w === start) {
          const path = [v]
          while (path[0] !== start) path.unshift(parent.get(path[0]!)!)
          return [...path, start]
        }
        if (!parent.has(w)) {
          parent.set(w, v)
          queue.push(w)
        }
      }
    }
    return [start, start]
  })
}

export interface Baseline {
  note: string
  violations: string[]
}

export function readBaseline(file: string): Set<string> {
  if (!existsSync(file)) return new Set()
  return new Set((JSON.parse(readFileSync(file, 'utf8')) as Baseline).violations)
}

export function writeBaseline(file: string, violations: Violation[]) {
  const data: Baseline = {
    note: 'Violations accepted when the rules were introduced. Fix them over time, then run nest-arch-guard --update-baseline.',
    violations: [...new Set(violations.map((v) => v.key))].sort(),
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}
