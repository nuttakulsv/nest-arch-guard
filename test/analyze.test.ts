import { describe, expect, it } from 'vitest'
import { analyzeProject } from '../src/analyze.js'
import { fixture } from './helpers.js'

const graph = analyzeProject(fixture('shop'))
const mod = (name: string) => graph.modules.find((m) => m.name === name)!

describe('analyzeProject', () => {
  it('finds every Nest module, including ones with metadata in a const', () => {
    expect(graph.modules.map((m) => m.name)).toEqual([
      'AppModule',
      'ConfigModule',
      'LoggingModule',
      'OrdersModule',
      'PaymentsModule',
      'UsersModule',
    ])
    expect(mod('LoggingModule').providers).toEqual(['src/logging/logger.ts#Logger'])
  })

  it('follows spread arrays, forRoot() calls and barrel re-exports', () => {
    expect(mod('AppModule').imports.map((r) => r.name)).toEqual([
      'ConfigModule',
      'LoggingModule',
      'OrdersModule',
      'PaymentsModule',
      'UsersModule',
    ])
    expect(mod('AppModule').imports.every((r) => r.file?.startsWith('src/'))).toBe(true)
  })

  it('reads dynamic module metadata from static methods', () => {
    const config = mod('ConfigModule')
    expect(config.global).toBe(true)
    expect(config.providers).toContain('src/config/tokens.ts#CONFIG_OPTIONS')
    expect(config.exports).toEqual(['src/config/config.service.ts#ConfigService'])
  })

  it('marks forwardRef imports', () => {
    expect(mod('OrdersModule').imports[0]).toMatchObject({ name: 'PaymentsModule', forwardRef: true })
  })

  it('resolves tsconfig paths and .js suffixes', () => {
    const alias = graph.imports.find((i) => i.specifier === '@app/orders/orders.repository.js')
    expect(alias?.to).toBe('src/orders/orders.repository.ts')
    expect(graph.imports.find((i) => i.specifier === '@nestjs/common')?.pkg).toBe('@nestjs/common')
  })

  it('marks type-only imports', () => {
    const typeImport = graph.imports.find(
      (i) => i.from === 'src/users/users.service.ts' && i.to === 'src/orders/domain/order.ts',
    )
    expect(typeImport?.typeOnly).toBe(true)
    const interfaceOnly = graph.imports.find((i) => i.from === 'src/users/users.types.ts')
    expect(interfaceOnly?.typeOnly).toBe(true)
    const classImport = graph.imports.find(
      (i) => i.from === 'src/orders/orders.controller.ts' && i.to === 'src/orders/orders.service.ts',
    )
    expect(classImport?.typeOnly).toBe(false)
  })

  it('maps files to the closest module folder', () => {
    expect(graph.owner('src/orders/domain/order.ts')?.name).toBe('OrdersModule')
    expect(graph.owner('src/shared-modules.ts')?.name).toBe('AppModule')
    expect(graph.owner('src/payments/index.ts')?.name).toBe('PaymentsModule')
  })

  it('records constructor injections by type and by @Inject token', () => {
    const tokens = graph.injections.map((i) => `${i.className} ${i.tokenName}`)
    expect(tokens).toEqual(
      expect.arrayContaining([
        'ConfigService CONFIG_OPTIONS',
        'OrdersController OrdersService',
        'OrdersController Logger',
        'OrdersService PaymentsService',
        'PaymentsService OrdersRepository',
      ]),
    )
  })

  it('collects ignore comments', () => {
    expect(graph.ignoredLines.get('src/users/users.service.ts')).toEqual(new Set([4]))
  })
})
