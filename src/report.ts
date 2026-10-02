import type { Violation } from './rules.js'

export interface Summary {
  files: number
  modules: number
  baselined: number
  stale: number
  ms: number
}

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
export const red = paint(31)
export const yellow = paint(33)
export const green = paint(32)
export const dim = paint(2)
export const bold = paint(1)

export function pretty(violations: Violation[], s: Summary): string {
  const lines = [dim(`nest-arch-guard  ${s.files} files, ${s.modules} Nest modules, ${s.ms} ms`), '']
  let rule = ''
  for (const v of violations) {
    if (v.rule !== rule) {
      if (rule) lines.push('')
      lines.push(bold(v.rule))
      rule = v.rule
    }
    const tag = v.severity === 'error' ? red('error') : yellow('warn ')
    lines.push(`  ${tag}  ${v.file}:${v.line}`, `         ${v.message}`)
  }
  if (violations.length) lines.push('')
  const errors = violations.filter((v) => v.severity === 'error').length
  const warnings = violations.length - errors
  const parts = [
    errors ? red(`${errors} ${plural(errors, 'error')}`) : green('0 errors'),
    `${warnings} ${plural(warnings, 'warning')}`,
  ]
  if (s.baselined) parts.push(dim(`${s.baselined} baselined`))
  lines.push(parts.join(', '))
  if (s.stale) {
    lines.push(
      dim(
        `${s.stale} baselined ${plural(s.stale, 'violation')} fixed. Run with --update-baseline to drop ${s.stale === 1 ? 'it' : 'them'} from the baseline.`,
      ),
    )
  }
  return lines.join('\n')
}

const plural = (n: number, word: string) =>
  n === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`

const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProp = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

export function github(violations: Violation[]): string {
  return violations
    .map(
      (v) =>
        `::${v.severity === 'error' ? 'error' : 'warning'} file=${escapeProp(v.file)},line=${v.line},title=${escapeProp(`nest-arch-guard/${v.rule}`)}::${escapeData(v.message)}`,
    )
    .join('\n')
}

export function json(violations: Violation[], s: Summary): string {
  const errors = violations.filter((v) => v.severity === 'error').length
  return JSON.stringify(
    {
      summary: { ...s, errors, warnings: violations.length - errors },
      violations: violations.map(({ edges: _edges, ...v }) => v),
    },
    null,
    2,
  )
}
