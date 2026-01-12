import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockValidateLocalDependencies = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/dependency-scanner.mjs', () => ({
  validateLocalDependencies: mockValidateLocalDependencies
}))

describe('release-node module', () => {
  beforeEach(() => {
    vi.resetModules()
    mockValidateLocalDependencies.mockClear()
  })

  it('loads without syntax errors and exports releaseNode', async () => {
    const module = await import('../src/release-node.mjs?' + Math.random())
    expect(typeof module.releaseNode).toBe('function')
  })
})


