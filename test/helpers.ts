import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { main } from '../src/cli.js'

export const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name)

export function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `nag-${name}-`))
  cpSync(fixture(name), dir, { recursive: true })
  return dir
}

export async function run(args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(s))
  const error = vi.spyOn(console, 'error').mockImplementation((s: string) => void err.push(s))
  try {
    const code = await main(args)
    return { code, stdout: out.join('\n'), stderr: err.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}
