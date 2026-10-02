import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeProject } from '../src/analyze.js'
import type { ArchConfig } from '../src/config.js'
import { checkGraph, findCycles } from '../src/rules.js'
import { fixture } from './helpers.js'

const graph = analyzeProject(fixture('shop'))
const config = JSON.parse(readFileSync(join(fixture('shop'), 'arch.config.json'), 'utf8')) as ArchConfig
const list = (c: ArchConfig) => checkGraph(c, graph).map((v) => `${v.rule} ${v.file}:${v.line}`)

describe('checkGraph', () => {
  it('reports every deliberate violation in the fixture, once', () => {
    expect(list(config)).toEqual([
      'dependencies src/users/users.service.ts:2',
      'forbidden src/orders/domain/order.ts:1',
      'layers src/orders/orders.repository.ts:3',
      'noCycles src/orders/orders.module.ts:2',
      'noCycles src/orders/orders.module.ts:8',
      'noCycles src/orders/orders.repository.ts:3',
      'noDeepImports src/orders/orders.controller.ts:3',
      'noDeepImports src/orders/orders.service.ts:2',
      'onlyThroughPublicApi src/orders/orders.controller.ts:3',
      'onlyThroughPublicApi src/payments/payments.service.ts:2',
      'onlyThroughPublicApi src/payments/payments.service.ts:7',
    ])
  })

  it('explains the injection problem', () => {
    const v = checkGraph(config, graph).find(
      (v) => v.file === 'src/payments/payments.service.ts' && v.line === 7,
    )
    expect(v?.message).toBe(
      'PaymentsService injects OrdersRepository, which OrdersModule provides but does not export',
    )
  })

  it('mentions forwardRef in module cycles', () => {
    const v = checkGraph(config, graph).find((v) => v.message.startsWith('Module cycle'))
    expect(v?.message).toBe(
      'Module cycle: OrdersModule → PaymentsModule → OrdersModule (held together with forwardRef)',
    )
  })

  it('skips lines with an ignore comment', () => {
    expect(list(config).some((l) => l.includes('users.service.ts:4'))).toBe(false)
  })

  it('checks type-only imports only when asked', () => {
    const rules = (types: boolean): ArchConfig => ({
      boundaries: config.boundaries,
      rules: { dependencies: [{ from: 'users', deny: ['orders-domain'] }], onlyThroughPublicApi: { types } },
    })
    expect(list(rules(false))).toEqual([
      'dependencies src/users/users.service.ts:5',
      'dependencies src/users/users.types.ts:1',
      'onlyThroughPublicApi src/orders/orders.controller.ts:3',
      'onlyThroughPublicApi src/payments/payments.service.ts:2',
      'onlyThroughPublicApi src/payments/payments.service.ts:7',
    ])
    expect(list(rules(true))).toEqual(
      expect.arrayContaining([
        'onlyThroughPublicApi src/users/users.service.ts:5',
        'onlyThroughPublicApi src/users/users.types.ts:1',
      ]),
    )
  })

  it('uses allow lists and severities', () => {
    const vs = checkGraph(
      {
        boundaries: config.boundaries,
        rules: { dependencies: [{ from: 'orders', allow: ['logging'], severity: 'warn' }] },
      },
      graph,
    )
    expect(vs.map((v) => `${v.severity} ${v.file}:${v.line}`)).toEqual([
      'warn src/orders/orders.controller.ts:3',
      'warn src/orders/orders.module.ts:2',
      'warn src/orders/orders.repository.ts:2',
      'warn src/orders/orders.service.ts:2',
    ])
  })

  it('flags skipped layers in strict mode', () => {
    const vs = checkGraph(
      {
        rules: {
          layers: {
            strict: true,
            order: [
              { name: 'controller', files: '**/*.controller.ts' },
              { name: 'service', files: '**/*.service.ts' },
              { name: 'repository', files: '**/*.repository.ts' },
            ],
          },
        },
      },
      graph,
    )
    expect(vs.map((v) => v.message)).toContain(
      'repository may not use service, which is a higher layer (imports src/orders/orders.service.ts)',
    )
  })

  it('treats every module as a boundary when none are configured', () => {
    const vs = checkGraph(
      { rules: { dependencies: [{ from: 'UsersModule', deny: ['OrdersModule'] }] } },
      graph,
    )
    expect(vs.map((v) => `${v.file}:${v.line}`)).toEqual([
      'src/users/users.service.ts:2',
      'src/users/users.service.ts:5',
      'src/users/users.types.ts:1',
    ])
  })

  it('rejects unknown boundary names', () => {
    expect(() =>
      checkGraph({ boundaries: config.boundaries, rules: { dependencies: [{ from: 'billing' }] } }, graph),
    ).toThrow('Unknown boundary "billing" in rules.dependencies[0].from')
  })
})

describe('findCycles', () => {
  it('returns one shortest cycle per component', () => {
    const edges: Record<string, string[]> = { a: ['b'], b: ['c', 'a'], c: ['a'], d: ['d'], e: [] }
    expect(findCycles(Object.keys(edges), (n) => edges[n] ?? [])).toEqual([
      ['a', 'b', 'a'],
      ['d', 'd'],
    ])
  })
})
