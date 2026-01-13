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
  })

  it('readRemoteLock returns parsed JSON when lock exists', async () => {
    const { readRemoteLock } = await import('../src/deploy/locks.mjs')

    const ssh = {
      execCommand: vi.fn().mockResolvedValue({ code: 0, stdout: '{"user":"alice"}', stderr: '' })
    }

    const result = await readRemoteLock(ssh, '/srv/app')
    expect(result).toEqual({ user: 'alice' })
  })

  it('readRemoteLock returns null when lock not found marker is returned', async () => {
    const { readRemoteLock } = await import('../src/deploy/locks.mjs')

    const ssh = {
      execCommand: vi.fn().mockResolvedValue({ code: 0, stdout: 'LOCK_NOT_FOUND', stderr: '' })
    }

    const result = await readRemoteLock(ssh, '/srv/app')
    expect(result).toBeNull()
  })

  it('compareLocksAndPrompt removes stale remote lock when user confirms', async () => {
    const { compareLocksAndPrompt } = await import('../src/deploy/locks.mjs')

    const lockPayload = {
      user: 'joey',
      hostname: 'host',
      pid: 123,
      startedAt: '2026-01-01T00:00:00.000Z'
    }

    mockReadFile.mockResolvedValueOnce(JSON.stringify(lockPayload))
    mockUnlink.mockResolvedValueOnce()

    const ssh = {
      execCommand: vi
        .fn()
        // readRemoteLock
        .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(lockPayload), stderr: '' })
        // rm -f
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    }

    const runPrompt = vi.fn().mockResolvedValue({ shouldRemove: true })
    const logWarning = vi.fn()

    const removed = await compareLocksAndPrompt('D:/proj', ssh, '/srv/app', { runPrompt, logWarning })
    expect(removed).toBe(true)
    expect(runPrompt).toHaveBeenCalled()
    expect(ssh.execCommand).toHaveBeenCalledTimes(2)
    expect(mockUnlink).toHaveBeenCalledTimes(1)
    expect(logWarning).not.toHaveBeenCalled()
  })
})

