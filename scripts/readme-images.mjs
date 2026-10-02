// Renders docs/images/*.png from real output. Run `npm run images` after changing the report or diagram code.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { analyzeProject, checkGraph, diagramModel, toSvg } from '../dist/index.js'

const root = resolve(import.meta.dirname, '..')
const shop = join(root, 'test/fixtures/shop')
const out = join(root, 'docs/images')
mkdirSync(out, { recursive: true })

const png = (svg, file) => {
  const image = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 }, font: { loadSystemFonts: true } })
  writeFileSync(join(out, file), image.render().asPng())
  console.log(`docs/images/${file}`)
}

const config = JSON.parse(readFileSync(join(shop, 'arch.config.json'), 'utf8'))
const graph = analyzeProject(shop)
png(toSvg(diagramModel(config, graph, checkGraph(config, graph))), 'diagram.png')

let output
try {
  output = execFileSync('node', [join(root, 'dist/bin.js')], { cwd: shop, encoding: 'utf8' })
} catch (err) {
  output = err.stdout
}
png(terminal(`$ npx nest-arch-guard\n${output.trimEnd()}`), 'check.png')

function terminal(text) {
  const lines = text.split('\n')
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const cw = 7.8
  const lh = 19
  const w = Math.ceil(Math.max(...lines.map((l) => l.length)) * cw + 48)
  const h = lines.length * lh + 64
  const body = lines.map((line, i) => {
    const y = 52 + i * lh
    let fill = '#c9d1d9'
    let content = esc(line)
    if (line.startsWith('$')) fill = '#7ee787'
    else if (/^[a-zA-Z]+$/.test(line)) content = `<tspan font-weight="bold" fill="#f0f6fc">${content}</tspan>`
    else if (line.startsWith('  error'))
      content = content.replace('error', '<tspan fill="#ff7b72">error</tspan>')
    else if (/^\d+ errors?/.test(line)) fill = '#ff7b72'
    else if (line.startsWith('nest-arch-guard')) fill = '#8b949e'
    return `<text x="24" y="${y}" fill="${fill}" xml:space="preserve">${content}</text>`
  })
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="Menlo, Consolas, monospace" font-size="13">`,
    `<rect width="${w}" height="${h}" rx="10" fill="#0d1117"/>`,
    ...['#ff5f57', '#febc2e', '#28c840'].map(
      (c, i) => `<circle cx="${22 + i * 18}" cy="20" r="6" fill="${c}"/>`,
    ),
    ...body,
    '</svg>',
  ].join('\n')
}
