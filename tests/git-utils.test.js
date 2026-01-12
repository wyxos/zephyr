import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockSpawn = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: mockSpawn
}))

describe('git utils', () => {
  beforeEach(() => {
    mockSpawn.mockReset()
  })

  it('getUpstreamRef returns null when git command fails', async () => {
    mockSpawn.mockImplementationOnce(() => {
      const handlers = { error: [], close: [] }
      queueMicrotask(() => handlers.close.forEach((h) => h(1)))
      return {
        stdout: { on: vi.fn() },
        stderr: { on: (event, handler) => {} },
        on: (event, handler) => {
          handlers[event].push(handler)
        }
      }
    })

    const { getUpstreamRef } = await import('../src/utils/git.mjs?' + Math.random())
    const upstream = await getUpstreamRef(process.cwd())
    expect(upstream).toBe(null)
  })
})

