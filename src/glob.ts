const cache = new Map<string, RegExp>()
const escape = (s: string) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')

export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{' && glob.includes('}', i)) {
      const end = glob.indexOf('}', i)
      re += `(?:${glob
        .slice(i + 1, end)
        .split(',')
        .map(escape)
        .join('|')})`
      i = end
    } else {
      re += escape(c)
    }
  }
  return new RegExp(`^${re}$`)
}

export function matches(path: string, patterns: string | string[] | undefined): boolean {
  if (!patterns) return false
  for (const p of Array.isArray(patterns) ? patterns : [patterns]) {
    let re = cache.get(p)
    if (!re) cache.set(p, (re = globToRegExp(p)))
    if (re.test(path)) return true
  }
  return false
}

/** The directory part of a glob before its first wildcard, e.g. "src/users" for "src/users/**". */
export function globRoot(glob: string): string {
  const parts = glob.split('/')
  const i = parts.findIndex((p) => /[*?{[]/.test(p))
  return (i === -1 ? parts.slice(0, -1) : parts.slice(0, i)).join('/')
}
