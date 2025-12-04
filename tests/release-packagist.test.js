import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockAccess = vi.fn()
const mockStat = vi.fn()

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile
  },
  readFile: mockReadFile,
  writeFile: mockWriteFile
}))

vi.mock('node:fs', () => ({
  default: {
    promises: {
      access: mockAccess,
      stat: mockStat
    }
  }
}))

const spawnQueue = []

const queueSpawnResponse = (response = {}) => {
  spawnQueue.push(response)
}

const mockSpawn = vi.fn((command, args) => {
  const { stdout = '', stderr = '', exitCode = 0, error } =
    spawnQueue.length > 0 ? spawnQueue.shift() : {}

  const stdoutHandlers = []
  const stderrHandlers = []
  const closeHandlers = []
  const errorHandlers = []

  setImmediate(() => {
    if (error) {
      errorHandlers.forEach((handler) => handler(error))
      return
    }

    if (stdout) {
      const chunk = Buffer.from(stdout)
      stdoutHandlers.forEach((handler) => handler(chunk))
    }

    if (stderr) {
      const chunk = Buffer.from(stderr)
      stderrHandlers.forEach((handler) => handler(chunk))
    }

    closeHandlers.forEach((handler) => handler(exitCode))
  })

  return {
    stdout: {
      on: (event, handler) => {
        if (event === 'data') {
          stdoutHandlers.push(handler)
        }
      }
    },
    stderr: {
      on: (event, handler) => {
        if (event === 'data') {
          stderrHandlers.push(handler)
        }
      }
    },
    on: (event, handler) => {
      if (event === 'close') {
        closeHandlers.push(handler)
      }

      if (event === 'error') {
        errorHandlers.push(handler)
      }
    }
  }
})

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  default: {
    spawn: mockSpawn
  }
}))

describe('release-packagist module', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnQueue.length = 0
    mockSpawn.mockClear()
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockAccess.mockReset()
    mockStat.mockReset()
  })

  it('loads without syntax errors and exports releasePackagist', async () => {
    const module = await import('../src/release-packagist.mjs?' + Math.random())
    expect(typeof module.releasePackagist).toBe('function')
  })

  it('pushChanges pushes commits first, then tags separately', async () => {
    // Mock composer.json
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        name: 'test/package',
        version: '1.0.0'
      })
    )

    // Mock file system checks (no artisan, no pint)
    mockAccess.mockRejectedValue(new Error('ENOENT'))
    mockStat.mockResolvedValue({ isFile: () => false })

    // Queue git command responses
    queueSpawnResponse({ stdout: '' }) // git status --porcelain (clean working tree)
    queueSpawnResponse({ stdout: 'main\n' }) // git branch --show-current
    queueSpawnResponse({ stdout: 'origin/main\n' }) // git rev-parse --abbrev-ref --symbolic-full-name @{u}
    queueSpawnResponse({}) // git fetch origin main
    queueSpawnResponse({ stdout: '0\n' }) // git rev-list --count origin/main..HEAD (ahead)
    queueSpawnResponse({ stdout: '0\n' }) // git rev-list --count HEAD..origin/main (behind)
    queueSpawnResponse({}) // git add composer.json
    queueSpawnResponse({}) // git commit -m "chore: release 1.0.1"
    queueSpawnResponse({}) // git tag v1.0.1
    queueSpawnResponse({}) // git push (commits)
    queueSpawnResponse({}) // git push origin --tags (tags)

    const module = await import('../src/release-packagist.mjs?' + Math.random())

    // This will fail because we're not in a real git repo, but we can verify the commands
    // Let's just verify the push commands are called in the right order
    try {
      await module.releasePackagist()
    } catch {
      // Expected to fail, but we can check the calls
    }

    // Find all git push calls
    const pushCalls = mockSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && Array.isArray(args) && args[0] === 'push'
    )

    // Should have exactly 2 push calls
    expect(pushCalls.length).toBe(2)

    // First push should be just 'push' (commits only)
    const firstPush = pushCalls[0]
    expect(firstPush[1]).toEqual(['push'])

    // Second push should be 'push origin --tags' (tags)
    const secondPush = pushCalls[1]
    expect(secondPush[1]).toEqual(['push', 'origin', '--tags'])

    // Verify the order: commits push comes before tags push
    expect(pushCalls.indexOf(firstPush)).toBeLessThan(pushCalls.indexOf(secondPush))
  })
})

