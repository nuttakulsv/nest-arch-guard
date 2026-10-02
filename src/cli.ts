import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { analyzeProject } from './analyze.js'
import { type ArchConfig, findConfig, loadConfig } from './config.js'
import { diagramModel, toMermaid, toSvg, updateMarkdown } from './diagram.js'
import { initConfig } from './init.js'
import { bold, dim, github, green, json, pretty, red } from './report.js'
import { checkGraph, readBaseline, writeBaseline } from './rules.js'

const HELP = `Usage: nest-arch-guard [command] [options]

Commands:
  check              Check the project against arch.config (default)
  diagram            Write the module diagram into docs/architecture.md
  init               Create arch.config.ts from the current structure

Options:
  -c, --config <file>    Config file (default: arch.config.{ts,mts,js,mjs,json})
  -p, --project <file>   tsconfig to read (default: tsconfig.json)
  -f, --format <name>    check output: pretty, github or json
      --update-baseline  Accept every current violation into the baseline
      --no-baseline      Report baselined violations too
  -o, --output <file>    Markdown file for the diagram (default: docs/architecture.md)
      --svg <file>       Also write the diagram as SVG
      --check            Fail if the diagram file is out of date
      --force            Let init overwrite an existing config
      --cwd <dir>        Project root (default: current directory)
  -h, --help
  -v, --version`

const DEFAULTS: ArchConfig = { rules: { noCycles: true, onlyThroughPublicApi: true } }

export async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        project: { type: 'string', short: 'p' },
        format: { type: 'string', short: 'f' },
        'update-baseline': { type: 'boolean' },
        'no-baseline': { type: 'boolean' },
        output: { type: 'string', short: 'o' },
        svg: { type: 'string' },
        check: { type: 'boolean' },
        force: { type: 'boolean' },
        cwd: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`)
    return 2
  }
  const { values: o, positionals } = args
  if (o.help) return print(HELP)
  if (o.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    return print(pkg.version)
  }
  const command = positionals[0] ?? 'check'
  if (!['check', 'diagram', 'init'].includes(command)) {
    console.error(`Unknown command "${command}"\n\n${HELP}`)
    return 2
  }
  const cwd = resolve(o.cwd ?? '.')

  try {
    const configFile = o.config ? resolve(cwd, o.config) : findConfig(cwd)
    if (o.config && !existsSync(configFile!)) throw new Error(`Config file not found: ${o.config}`)
    if (command === 'init') return init(cwd, o.project, o.force, configFile)

    const config = configFile ? await loadConfig(configFile) : DEFAULTS
    const started = performance.now()
    const graph = analyzeProject(cwd, { project: o.project ?? config.project, exclude: config.exclude })
    const all = checkGraph(config, graph)
    const ms = Math.round(performance.now() - started)

    if (command === 'diagram') {
      const model = diagramModel(config, graph, all)
      const out = resolve(cwd, o.output ?? config.diagram ?? 'docs/architecture.md')
      const current = existsSync(out) ? readFileSync(out, 'utf8') : undefined
      const next = updateMarkdown(current, toMermaid(model))
      const shown = relative(cwd, out)
      if (o.check) {
        if (current === next) return print(`${shown} is up to date`)
        console.error(`${shown} is out of date. Run \`nest-arch-guard diagram\` and commit the result.`)
        return 1
      }
      write(out, next)
      if (o.svg) write(resolve(cwd, o.svg), toSvg(model))
      return print(`Wrote ${[shown, o.svg].filter(Boolean).join(' and ')}`)
    }

    const baselineFile = resolve(cwd, config.baseline ?? 'arch-baseline.json')
    if (o['update-baseline']) {
      writeBaseline(baselineFile, all)
      return print(`Wrote ${all.length} violations to ${relative(cwd, baselineFile)}`)
    }
    const baseline = o['no-baseline'] ? new Set<string>() : readBaseline(baselineFile)
    const violations = all.filter((v) => !baseline.has(v.key))
    const present = new Set(all.map((v) => v.key))
    const summary = {
      files: graph.files.length,
      modules: graph.modules.length,
      baselined: all.length - violations.length,
      stale: [...baseline].filter((k) => !present.has(k)).length,
      ms,
    }

    const format = o.format ?? 'pretty'
    if (format === 'json') print(json(violations, summary))
    else if (format === 'github') print(github(violations))
    else if (format === 'pretty') {
      if (!configFile)
        console.log(
          dim(
            'No arch.config found, checking cycles and module public APIs only. Run `nest-arch-guard init` for more.\n',
          ),
        )
      print(pretty(violations, summary))
      if (process.env.GITHUB_ACTIONS === 'true' && violations.length) print(github(violations))
    } else {
      throw new Error(`Unknown format "${format}". Use pretty, github or json.`)
    }
    return violations.some((v) => v.severity === 'error') ? 1 : 0
  } catch (err) {
    console.error(red((err as Error).message))
    return 2
  }
}

function init(
  cwd: string,
  project: string | undefined,
  force: boolean | undefined,
  existing: string | undefined,
) {
  if (existing && !force) {
    console.error(`${relative(cwd, existing)} already exists. Use --force to overwrite it.`)
    return 2
  }
  const graph = analyzeProject(cwd, { project })
  const { config, source } = initConfig(graph)
  const file = resolve(cwd, existsSync(resolve(cwd, 'tsconfig.json')) ? 'arch.config.ts' : 'arch.config.json')
  write(file, file.endsWith('.json') ? `${JSON.stringify(config, null, 2)}\n` : source)
  const count = checkGraph(config, graph).length
  print(
    [
      `${green('Created')} ${relative(cwd, file)} with ${Object.keys(config.boundaries!).length} boundaries from ${graph.modules.length} Nest modules.`,
      '',
      count
        ? `${bold(String(count))} existing violations. To adopt the rules without fixing them all today:\n  npx nest-arch-guard --update-baseline`
        : 'No violations found.',
      '',
      'Then tighten the rules in the config and add `npx nest-arch-guard` to CI.',
    ].join('\n'),
  )
  return 0
}

function write(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function print(s: string) {
  console.log(s)
  return 0
}
