import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'

describe('quality-check page dark mode', () => {
  const src = readFileSync(
    join(__dirname, '../quality-check/page.tsx'),
    'utf-8'
  )

  it('has dark background on summary card', () => {
    expect(src).toContain('dark:bg-gray-900')
  })

  it('preserves light background classes', () => {
    expect(src).toContain('bg-white')
  })

  it('has dark border on summary card', () => {
    expect(src).toContain('dark:border-gray-800')
  })

  it('preserves light border classes', () => {
    expect(src).toContain('border-gray-200')
  })

  it('has dark text on heading', () => {
    expect(src).toContain('dark:text-gray-100')
  })

  it('preserves light heading text', () => {
    expect(src).toContain('text-gray-800')
  })

  it('has dark muted text', () => {
    expect(src).toContain('dark:text-gray-400')
  })

  it('preserves light muted text', () => {
    expect(src).toContain('text-gray-500')
  })

  it('select has dark 3-point set', () => {
    expect(src).toContain('dark:bg-gray-900')
    expect(src).toContain('dark:text-gray-100')
    expect(src).toContain('dark:border-gray-700')
  })

  it('load-more button has dark border and text', () => {
    expect(src).toContain('dark:text-gray-200')
    expect(src).toContain('dark:hover:bg-gray-800')
  })

  it('neutral summary card count has dark text supplement', () => {
    expect(src).toContain('text-gray-800 dark:text-gray-100')
  })
})
