import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('release-packagist module', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('loads without syntax errors and exports releasePackagist', async () => {
    const module = await import('../src/release-packagist.mjs?' + Math.random())
    expect(typeof module.releasePackagist).toBe('function')
  })
})

