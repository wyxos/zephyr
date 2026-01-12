import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const mockReadFile = vi.fn()
const mockSpawn = vi.fn()
const mockHttpsGet = vi.fn()

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile
}))

vi.mock('node:child_process', () => ({
  spawn: mockSpawn
}))

vi.mock('node:https', () => ({
  default: {
    get: mockHttpsGet
  }
}))

describe('version-checker', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    delete process.env.ZEPHYR_SKIP_VERSION_CHECK
    mockReadFile.mockReset()
    mockSpawn.mockReset()
    mockHttpsGet.mockReset()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('skips when ZEPHYR_SKIP_VERSION_CHECK=1', async () => {
    process.env.ZEPHYR_SKIP_VERSION_CHECK = '1'
    const { checkAndUpdateVersion } = await import('../src/version-checker.mjs?' + Math.random())

    const result = await checkAndUpdateVersion(async () => ({ shouldUpdate: true }), [])
    expect(result).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('prompts and re-executes when newer version exists and user agrees', async () => {
    // Current version (from package.json)
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.1.0' }))

    // Latest version (from npm registry)
    mockHttpsGet.mockImplementationOnce((_url, _options, callback) => {
      const response = new EventEmitter()
      response.statusCode = 200
      response.setEncoding = vi.fn()

      callback(response)

      queueMicrotask(() => {
        response.emit('data', JSON.stringify({ version: '0.2.0' }))
        response.emit('end')
      })

      return {
        on: vi.fn(),
        end: vi.fn()
      }
    })

    // Spawn should "succeed"
    mockSpawn.mockImplementationOnce((_cmd, _args, _opts) => {
      const handlers = { error: [], close: [] }
      queueMicrotask(() => handlers.close.forEach((h) => h(0)))
      return {
        on: (event, handler) => {
          handlers[event].push(handler)
        }
      }
    })

    const promptFn = vi.fn().mockResolvedValue({ shouldUpdate: true })
    const { checkAndUpdateVersion } = await import('../src/version-checker.mjs?' + Math.random())

    const didReExec = await checkAndUpdateVersion(promptFn, ['--type=node'])
    expect(didReExec).toBe(true)
    expect(promptFn).toHaveBeenCalled()
    expect(mockSpawn).toHaveBeenCalled()
  })

  it('does not re-exec when user declines', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ version: '0.1.0' }))

    mockHttpsGet.mockImplementationOnce((_url, _options, callback) => {
      const response = new EventEmitter()
      response.statusCode = 200
      response.setEncoding = vi.fn()

      callback(response)

      queueMicrotask(() => {
        response.emit('data', JSON.stringify({ version: '0.2.0' }))
        response.emit('end')
      })

      return {
        on: vi.fn(),
        end: vi.fn()
      }
    })

    const promptFn = vi.fn().mockResolvedValue({ shouldUpdate: false })
    const { checkAndUpdateVersion } = await import('../src/version-checker.mjs?' + Math.random())

    const didReExec = await checkAndUpdateVersion(promptFn, [])
    expect(didReExec).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })
})

