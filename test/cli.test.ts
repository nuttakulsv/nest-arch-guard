import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyFixture, run } from './helpers.js'

describe('cli', () => {
  it('fails with a readable report', async () => {
    const dir = copyFixture('shop')
    const r = await run(['--cwd', dir])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('onlyThroughPublicApi')
    expect(r.stdout).toContain('src/payments/payments.service.ts:7')
    expect(r.stdout).toContain('11 errors, 0 warnings')
  })

  it('prints GitHub annotations and JSON', async () => {
    const dir = copyFixture('shop')
    const gh = await run(['--cwd', dir, '--format', 'github'])
    expect(gh.stdout.split('\n')[0]).toBe(
      '::error file=src/users/users.service.ts,line=2,title=nest-arch-guard/dependencies::users may not depend on orders (imports src/orders/orders.service.ts)',
    )
    const js = await run(['--cwd', dir, '-f', 'json'])
    const data = JSON.parse(js.stdout) as {
      summary: { errors: number; modules: number }
      violations: unknown[]
    }
    expect(data.summary).toMatchObject({ errors: 11, modules: 6 })
    expect(data.violations).toHaveLength(11)
  })

  it('adopts existing violations through the baseline', async () => {
    const dir = copyFixture('shop')
    expect((await run(['--cwd', dir, '--update-baseline'])).stdout).toBe(
      'Wrote 11 violations to arch-baseline.json',
    )
    const clean = await run(['--cwd', dir])
    expect(clean.code).toBe(0)
    expect(clean.stdout).toContain('0 errors, 0 warnings, 11 baselined')

    const service = join(dir, 'src/users/users.service.ts')
    writeFileSync(
      service,
      readFileSync(service, 'utf8').replace(
        "import { OrdersService } from '../orders/orders.service.js'\n",
        "import { OrdersService } from '../orders/index.js'\n",
      ),
    )
    writeFileSync(join(dir, 'src/orders/index.ts'), "export { OrdersService } from './orders.service.js'\n")
    const fixed = await run(['--cwd', dir])
    expect(fixed.stdout).toContain('1 baselined violation fixed')

    writeFileSync(
      join(dir, 'src/users/extra.ts'),
      "export { PAYMENT_FEE } from '../payments/payments.internal.js'\n",
    )
    const regressed = await run(['--cwd', dir])
    expect(regressed.code).toBe(1)
    expect(regressed.stdout).toContain('src/users/extra.ts:1')
    // The new src/orders/index.ts turns on noDeepImports for orders, so the full list grows.
    expect((await run(['--cwd', dir, '--no-baseline'])).stdout).toContain('17 errors')
  })

  it('writes the diagram and fails --check when it is stale', async () => {
    const dir = copyFixture('shop')
    expect((await run(['diagram', '--cwd', dir, '--check'])).code).toBe(1)
    const w = await run(['diagram', '--cwd', dir, '--svg', 'docs/architecture.svg'])
    expect(w.stdout).toBe('Wrote docs/architecture.md and docs/architecture.svg')
    expect(readFileSync(join(dir, 'docs/architecture.md'), 'utf8')).toContain('```mermaid')
    expect(existsSync(join(dir, 'docs/architecture.svg'))).toBe(true)
    expect((await run(['diagram', '--cwd', dir, '--check'])).code).toBe(0)

    rmSync(join(dir, 'src/users/users.service.ts'))
    writeFileSync(
      join(dir, 'src/users/users.service.ts'),
      "import { Injectable } from '@nestjs/common'\n@Injectable()\nexport class UsersService {}\n",
    )
    const stale = await run(['diagram', '--cwd', dir, '--check'])
    expect(stale.code).toBe(1)
    expect(stale.stderr).toContain('docs/architecture.md is out of date')
  })

  it('init writes a TypeScript config that passes on dependencies and loads again', async () => {
    const dir = copyFixture('shop')
    rmSync(join(dir, 'arch.config.json'))
    const init = await run(['init', '--cwd', dir])
    expect(init.code).toBe(0)
    const source = readFileSync(join(dir, 'arch.config.ts'), 'utf8')
    expect(source).toContain("import { defineConfig } from 'nest-arch-guard'")
    expect(source).toContain("orders: 'src/orders/**',")
    expect(source).toContain("app: 'src/*',")

    const check = await run(['--cwd', dir, '-f', 'json'])
    const rules = (JSON.parse(check.stdout) as { violations: { rule: string }[] }).violations.map(
      (v) => v.rule,
    )
    expect(rules).not.toContain('dependencies')
    expect(rules).toContain('noCycles')
    expect((await run(['init', '--cwd', dir])).code).toBe(2)
  })

  it('uses defaults without a config and explains config errors', async () => {
    const dir = copyFixture('shop')
    rmSync(join(dir, 'arch.config.json'))
    const r = await run(['--cwd', dir])
    expect(r.stdout).toContain('No arch.config found')
    expect(r.stdout).not.toContain('forbidden')

    writeFileSync(
      join(dir, 'arch.config.json'),
      JSON.stringify({ rules: { forbidden: [{ from: 'nope', packages: ['x'] }] } }),
    )
    const bad = await run(['--cwd', dir])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('Unknown boundary "nope"')
    expect((await run(['lint'])).code).toBe(2)
  })
})
