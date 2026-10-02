import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeProject } from '../src/analyze.js'
import type { ArchConfig } from '../src/config.js'
import { diagramModel, toMermaid, toSvg, updateMarkdown } from '../src/diagram.js'
import { checkGraph } from '../src/rules.js'
import { fixture } from './helpers.js'

const graph = analyzeProject(fixture('shop'))
const config = JSON.parse(readFileSync(join(fixture('shop'), 'arch.config.json'), 'utf8')) as ArchConfig
const model = diagramModel(config, graph, checkGraph(config, graph))

describe('diagram', () => {
  it('has module imports, hidden usage and violations as edges', () => {
    const name = (id: string) => model.nodes.find((n) => n.id === id)!.name
    const edges = model.edges.map(
      (e) => `${name(e.from)} ${e.kind} ${name(e.to)}${e.violation ? ' !' : ''}${e.forwardRef ? ' fwd' : ''}`,
    )
    expect(edges).toEqual([
      'AppModule import ConfigModule',
      'AppModule import LoggingModule',
      'AppModule import OrdersModule',
      'AppModule import PaymentsModule',
      'AppModule import UsersModule',
      'OrdersModule uses LoggingModule',
      'OrdersModule import PaymentsModule ! fwd',
      'PaymentsModule import OrdersModule ! fwd',
      'UsersModule uses OrdersModule !',
      'UsersModule uses PaymentsModule',
    ])
  })

  it('renders mermaid with boundaries, red violations and dashed globals', () => {
    const m = toMermaid(model)
    expect(m).toContain('subgraph b4["payments"]')
    expect(m).toContain('m3 -->|forwardRef| m4')
    expect(m).toMatch(/linkStyle [\d,]+ stroke:#cf222e/)
    expect(m).toContain('m1["ConfigModule (global)"]')
  })

  it('replaces only the generated block in markdown', () => {
    const first = updateMarkdown(undefined, 'flowchart TD\n  a')
    expect(first.startsWith('# Architecture')).toBe(true)
    const edited = `${first}\nNotes written by hand.\n`
    const next = updateMarkdown(edited, 'flowchart TD\n  b')
    expect(next).toContain('Notes written by hand.')
    expect(next).toContain('  b\n')
    expect(next).not.toContain('  a\n')
    expect(updateMarkdown(next, 'flowchart TD\n  b')).toBe(next)
  })

  it('renders a standalone SVG', () => {
    const svg = toSvg(model)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.match(/<rect x=/g)?.length).toBeGreaterThanOrEqual(model.nodes.length)
    expect(svg).toContain('#cf222e')
  })
})
