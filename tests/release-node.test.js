import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('release-node module', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('loads without syntax errors and exports releaseNode', async () => {
    const module = await import('../src/release-node.mjs?' + Math.random())
    expect(typeof module.releaseNode).toBe('function')
  })
})

