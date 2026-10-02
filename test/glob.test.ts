import { describe, expect, it } from 'vitest'
import { globRoot, matches } from '../src/glob.js'

describe('glob', () => {
  it('matches path globs', () => {
    expect(matches('src/users/a.ts', 'src/users/**')).toBe(true)
    expect(matches('src/users/deep/a.ts', 'src/users/**')).toBe(true)
    expect(matches('src/usersx/a.ts', 'src/users/**')).toBe(false)
    expect(matches('a.spec.ts', '**/*.spec.ts')).toBe(true)
    expect(matches('src/a/b.spec.ts', '**/*.spec.ts')).toBe(true)
    expect(matches('src/app.module.ts', 'src/*')).toBe(true)
    expect(matches('src/users/a.ts', 'src/*')).toBe(false)
    expect(matches('src/a.ts', 'src/*.{ts,js}')).toBe(true)
    expect(matches('@nestjs/common', '@nestjs/*')).toBe(true)
    expect(matches('@nestjs/common/x', '@nestjs/*')).toBe(false)
  })

  it('finds the static root of a glob', () => {
    expect(globRoot('src/users/**')).toBe('src/users')
    expect(globRoot('src/*')).toBe('src')
    expect(globRoot('**/*.ts')).toBe('')
  })
})
