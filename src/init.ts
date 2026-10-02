import { dirOf, isUnder, type ProjectGraph } from './analyze.js'
import type { ArchConfig } from './config.js'
import { boundariesOf, boundaryLookup } from './rules.js'

const kebab = (s: string) =>
  s
    .replace(/Module$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase() || 'root'

/** Builds a config that describes the project as it is today, so the first run passes on dependencies. */
export function initConfig(graph: ProjectGraph): { config: ArchConfig; source: string } {
  const boundaries: Record<string, string> = {}
  const taken = new Set<string>()
  const unique = (name: string) => {
    let n = name
    for (let i = 2; taken.has(n); i++) n = `${name}-${i}`
    taken.add(n)
    return n
  }
  const dirs = new Set<string>()
  for (const m of graph.modules) {
    if (dirs.has(m.dir)) continue
    dirs.add(m.dir)
    const base = m.dir ? `${m.dir}/` : ''
    // A root module like AppModule only owns its own files, see owner() in analyze.ts.
    const root =
      graph.modules.some((o) => o.dir !== m.dir && isUnder(o.dir, m.dir)) && !graph.owner(`${base}x/x.ts`)
    boundaries[unique(kebab(m.name))] = root ? `${base}*` : `${base}**`
  }
  // Folders without a module (src/common, src/shared) become boundaries of their own.
  for (const file of graph.files) {
    if (graph.owner(file)) continue
    const dir = dirOf(file)
    const parent = graph.modules
      .filter((m) => m.dir !== dir && isUnder(dir, m.dir))
      .sort((a, b) => b.dir.length - a.dir.length)[0]
    if (!parent) continue
    const top = dir
      .split('/')
      .slice(0, parent.dir ? parent.dir.split('/').length + 1 : 1)
      .join('/')
    if (dirs.has(top)) continue
    dirs.add(top)
    boundaries[unique(top.split('/').pop()!)] = `${top}/**`
  }

  const config: ArchConfig = { boundaries, rules: { noCycles: true, onlyThroughPublicApi: true } }
  const boundaryOf = boundaryLookup(boundariesOf(config, graph), graph)
  const deps = new Map<string, Set<string>>()
  for (const imp of graph.imports) {
    if (!imp.to) continue
    const a = boundaryOf(imp.from)
    const b = boundaryOf(imp.to)
    if (!a || !b || a === b) continue
    deps.set(a, (deps.get(a) ?? new Set()).add(b))
  }
  const dependencies = Object.keys(boundaries).map((from) => ({
    from,
    allow: [...(deps.get(from) ?? [])].sort(),
  }))
  config.rules!.dependencies = dependencies

  const has = (suffix: string) => graph.files.some((f) => f.endsWith(suffix))
  const layers = ['controller', 'service', 'repository'].filter((l) => has(`.${l}.ts`))
  if (layers.length > 1) {
    config.rules!.layers = { order: layers.map((name) => ({ name, files: `**/*.${name}.ts` })) }
  }

  const q = (s: string) => `'${s}'`
  const lines = [
    "import { defineConfig } from 'nest-arch-guard'",
    '',
    'export default defineConfig({',
    '  boundaries: {',
    ...Object.entries(boundaries).map(([k, v]) => `    ${/^[a-z_$][\w$]*$/i.test(k) ? k : q(k)}: ${q(v)},`),
    '  },',
    '  rules: {',
    '    noCycles: true,',
    '    onlyThroughPublicApi: true,',
  ]
  if (config.rules!.layers) {
    lines.push(
      '    layers: {',
      '      order: [',
      ...config.rules!.layers.order.map(
        (l) => `        { name: ${q(l.name)}, files: ${q(l.files as string)} },`,
      ),
      '      ],',
      '    },',
    )
  }
  lines.push(
    '    // Written from the current imports. Remove entries to tighten the rules.',
    '    dependencies: [',
    ...dependencies.map((d) => `      { from: ${q(d.from)}, allow: [${d.allow.map(q).join(', ')}] },`),
    '    ],',
    '  },',
    '})',
    '',
  )
  return { config, source: lines.join('\n') }
}
