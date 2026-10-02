import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

export type Severity = 'error' | 'warn'
export type RuleId =
  'dependencies' | 'layers' | 'noCycles' | 'onlyThroughPublicApi' | 'noDeepImports' | 'forbidden'

export interface BoundaryDef {
  /** Path globs relative to the project root, e.g. "src/users/**" */
  paths?: string | string[]
  /** Nest module class names, e.g. "UsersModule" */
  modules?: string | string[]
}

export interface DependencyRule {
  /** Boundary name(s) the rule applies to, or "*" */
  from: string | string[]
  /** Only these boundaries may be used. Anything else is a violation. */
  allow?: string[]
  /** These boundaries may not be used. */
  deny?: string[]
  severity?: Severity
  message?: string
}

export interface LayerDef {
  name: string
  files: string | string[]
}

export interface ForbiddenRule {
  from: string | string[]
  /** Package names or globs, e.g. "@nestjs/*", "typeorm" */
  packages: string[]
  severity?: Severity
  message?: string
}

export interface ArchConfig {
  /** tsconfig used to read the project. Default "tsconfig.json" */
  project?: string
  /** Files left out of the analysis. Default: spec/test files and test/ */
  exclude?: string[]
  /** Named groups of code. Without boundaries every Nest module is its own boundary. */
  boundaries?: Record<string, string | string[] | BoundaryDef>
  rules?: {
    dependencies?: DependencyRule[]
    /** Ordered from top to bottom. A layer may only use layers below it. */
    layers?: { order: LayerDef[]; strict?: boolean; severity?: Severity }
    noCycles?: boolean | { modules?: boolean; files?: boolean; severity?: Severity }
    /**
     * Code outside a Nest module may only use its module file, index file, exported providers
     * and contract-like files (`files`, default DEFAULT_PUBLIC_FILES; [] for strict).
     * `types: true` also checks imports that only bring in types.
     */
    onlyThroughPublicApi?: boolean | { files?: string[]; types?: boolean; severity?: Severity }
    /** Imports across boundaries must go through the boundary's index file. */
    noDeepImports?: boolean | { severity?: Severity }
    forbidden?: ForbiddenRule[]
  }
  /** Default "arch-baseline.json" */
  baseline?: string
  /** Markdown file the diagram command writes into. Default "docs/architecture.md" */
  diagram?: string
}

export const defineConfig = (config: ArchConfig): ArchConfig => config

export const DEFAULT_EXCLUDE = [
  '**/*.spec.ts',
  '**/*.test.ts',
  '**/*.e2e-spec.ts',
  'test/**',
  'dist/**',
  'arch.config.*',
]

/** DTOs, enums, types, interfaces, constants and decorators are meant to be shared. */
export const DEFAULT_PUBLIC_FILES = [
  '**/*.dto.ts',
  '**/dto/**',
  '**/*.enum.ts',
  '**/*.types.ts',
  '**/*.interface.ts',
  '**/*.constants.ts',
  '**/*.decorator.ts',
  '**/decorators.ts',
]

export const CONFIG_FILES = [
  'arch.config.ts',
  'arch.config.mts',
  'arch.config.js',
  'arch.config.mjs',
  'arch.config.json',
]

export function findConfig(cwd: string): string | undefined {
  return CONFIG_FILES.map((f) => join(cwd, f)).find((f) => existsSync(f))
}

export async function loadConfig(file: string): Promise<ArchConfig> {
  const path = resolve(file)
  if (path.endsWith('.json')) return JSON.parse(readFileSync(path, 'utf8')) as ArchConfig
  if (!/\.m?ts$/.test(path)) return importDefault(path)

  // Compile next to the original so relative imports keep working. defineConfig is inlined
  // and any other package import points at this copy, so the config loads through npx too.
  const self = new URL('./index.js', import.meta.url).href
  const out = ts
    .transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .outputText.replace(
      /import\s*\{\s*defineConfig\s*\}\s*from\s*(['"])nest-arch-guard\1;?/,
      'const defineConfig = (c) => c;',
    )
    .replace(/(['"])nest-arch-guard\1/g, JSON.stringify(self))
  const tmp = `${path}.${process.pid}.tmp.mjs`
  writeFileSync(tmp, out)
  try {
    return await importDefault(tmp)
  } finally {
    rmSync(tmp, { force: true })
  }
}

async function importDefault(path: string): Promise<ArchConfig> {
  const mod = (await import(pathToFileURL(path).href)) as { default?: ArchConfig }
  if (!mod.default) throw new Error(`${path} has no default export`)
  return mod.default
}
