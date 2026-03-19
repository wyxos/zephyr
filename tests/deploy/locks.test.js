import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockMkdir = vi.fn()
const mockUnlink = vi.fn()

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    unlink: mockUnlink
  },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  unlink: mockUnlink
}))

describe('deploy/locks', () => {
  beforeEach(() => {
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockMkdir.mockReset()
    mockUnlink.mockReset()

    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  })

  it('readRemoteLock returns parsed JSON when lock exists', async () => {
    const { readRemoteLock } = await import('#src/deploy/locks.mjs')

    const ssh = {
      execCommand: vi.fn().mockResolvedValue({ code: 0, stdout: '{"user":"alice"}', stderr: '' })
    }

    const result = await readRemoteLock(ssh, '/srv/app')
    expect(result).toEqual({ user: 'alice' })
  })

  it('readRemoteLock returns null when lock not found marker is returned', async () => {
    const { readRemoteLock } = await import('#src/deploy/locks.mjs')

    const ssh = {
      execCommand: vi.fn().mockResolvedValue({ code: 0, stdout: 'LOCK_NOT_FOUND', stderr: '' })
    }

    const result = await readRemoteLock(ssh, '/srv/app')
    expect(result).toBeNull()
  })

  it('compareLocksAndPrompt removes stale remote lock when user chooses delete', async () => {
    const { compareLocksAndPrompt } = await import('#src/deploy/locks.mjs')

    const lockPayload = {
      user: 'joey',
      hostname: 'host',
      pid: 123,
      startedAt: '2026-01-01T00:00:00.000Z'
    }

    mockReadFile.mockResolvedValueOnce(JSON.stringify(lockPayload))
    mockUnlink.mockResolvedValueOnce(undefined)

    const ssh = {
      execCommand: vi
        .fn()
        // readRemoteLock
        .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(lockPayload), stderr: '' })
        // rm -f
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    }

    const runPrompt = vi.fn().mockResolvedValue({ action: 'delete' })
    const logWarning = vi.fn()

    const removed = await compareLocksAndPrompt('D:/proj', ssh, '/srv/app', { runPrompt, logWarning })
    expect(removed).toBe(true)
    expect(runPrompt).toHaveBeenCalled()
    expect(ssh.execCommand).toHaveBeenCalledTimes(2)
    expect(mockUnlink).toHaveBeenCalledTimes(1)
    expect(logWarning).not.toHaveBeenCalled()
  })

  it('acquireRemoteLock resumes when the lock disappears after polling', async () => {
    const { acquireRemoteLock } = await import('#src/deploy/locks.mjs')

    const lockPayload = {
      user: 'joey',
      hostname: 'host',
      pid: 123,
      startedAt: '2026-01-01T00:00:00.000Z'
    }

    mockWriteFile.mockResolvedValueOnce(undefined)

    const ssh = {
      execCommand: vi
        .fn()
        // Initial remote lock read
        .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(lockPayload), stderr: '' })
        // Remote lock disappeared after the wait
        .mockResolvedValueOnce({ code: 0, stdout: 'LOCK_NOT_FOUND', stderr: '' })
        // Lock file creation
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    }

    const runPrompt = vi.fn().mockResolvedValue({ action: 'wait' })
    const wait = vi.fn().mockResolvedValue(undefined)
    const logProcessing = vi.fn()
    const logWarning = vi.fn()

    await acquireRemoteLock(ssh, '/srv/app', 'D:/proj', {
      runPrompt,
      logProcessing,
      logWarning,
      wait
    })

    expect(runPrompt).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledWith(60_000)
    expect(logProcessing).toHaveBeenCalledWith('Waiting 60 seconds before checking the remote deployment lock again...')
    expect(ssh.execCommand).toHaveBeenCalledTimes(3)
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(logWarning).not.toHaveBeenCalled()
  })

  it('prompts again when the lock is still present after polling', async () => {
    const { acquireRemoteLock } = await import('#src/deploy/locks.mjs')

    const lockPayload = {
      user: 'joey',
      hostname: 'host',
      pid: 123,
      startedAt: '2026-01-01T00:00:00.000Z'
    }

    mockWriteFile.mockResolvedValueOnce(undefined)

    const ssh = {
      execCommand: vi
        .fn()
        // Initial remote lock read
        .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(lockPayload), stderr: '' })
        // Remote lock still exists after the wait
        .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(lockPayload), stderr: '' })
        // Remove the remote lock after the second prompt
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        // Lock file creation
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    }

    const runPrompt = vi
      .fn()
      .mockResolvedValueOnce({ action: 'wait' })
      .mockResolvedValueOnce({ action: 'delete' })
    const wait = vi.fn().mockResolvedValue(undefined)
    const logProcessing = vi.fn()

    await acquireRemoteLock(ssh, '/srv/app', 'D:/proj', {
      runPrompt,
      logProcessing,
      logWarning: vi.fn(),
      wait
    })

    expect(runPrompt).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(ssh.execCommand).toHaveBeenCalledTimes(4)
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
  })

  it('fails in non-interactive mode when a matching stale remote lock is detected', async () => {
    const { compareLocksAndPrompt } = await import('#src/deploy/locks.mjs')

    const lockPayload = {
      user: 'joey',
      hostname: 'host',
      pid: 123,
      startedAt: '2026-01-01T00:00:00.000Z'
    }

    mockReadFile.mockResolvedValueOnce(JSON.stringify(lockPayload))

    const ssh = {
      execCommand: vi.fn().mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify(lockPayload),
        stderr: ''
      })
    }

    await expect(compareLocksAndPrompt('/workspace/project', ssh, '/srv/app', {
      runPrompt: vi.fn(),
      logWarning: vi.fn(),
      interactive: false
    })).rejects.toMatchObject({
      code: 'ZEPHYR_STALE_REMOTE_LOCK'
    })
  })
})
