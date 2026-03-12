import { describe, it, expect, vi } from 'vitest'

describe('deploy/remote-exec', () => {
  it('logs stdout/stderr to log file and throws on non-zero exit by default', async () => {
    const { createRemoteExecutor } = await import('#src/deploy/remote-exec.mjs')

    const writeToLogFile = vi.fn().mockResolvedValue()
    const logProcessing = vi.fn()
    const logSuccess = vi.fn()
    const logError = vi.fn()

    const ssh = {
      execCommand: vi.fn().mockResolvedValue({
        code: 2,
        stdout: 'out',
        stderr: 'err'
      })
    }

    const executeRemote = createRemoteExecutor({
      ssh,
      rootDir: 'D:/proj',
      remoteCwd: '/srv/app',
      writeToLogFile,
      logProcessing,
      logSuccess,
      logError
    })

    await expect(executeRemote('Test', 'do-thing')).rejects.toThrow('Command failed: do-thing')
    expect(writeToLogFile).toHaveBeenCalledTimes(2)
    expect(logProcessing).toHaveBeenCalledWith('\nTest')
    expect(logError).toHaveBeenCalled()
    expect(logSuccess).not.toHaveBeenCalled()
  })

  it('supports env injection when bootstrapEnv is false', async () => {
    const { createRemoteExecutor } = await import('#src/deploy/remote-exec.mjs')

    const ssh = {
      execCommand: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    }

    const executeRemote = createRemoteExecutor({
      ssh,
      rootDir: 'D:/proj',
      remoteCwd: '/srv/app',
      writeToLogFile: vi.fn().mockResolvedValue(),
      logProcessing: vi.fn(),
      logSuccess: vi.fn(),
      logError: vi.fn()
    })

    await executeRemote('Env', 'echo ok', { bootstrapEnv: false, env: { FOO: "bar'baz" } })

    const calledCommand = ssh.execCommand.mock.calls[0][0]
    expect(calledCommand).toContain("FOO='bar'\\''baz'")
    expect(calledCommand).toContain('echo ok')
  })

  it('passes plain labels to the shared logger so prefixes are not duplicated', async () => {
    const { createRemoteExecutor } = await import('#src/deploy/remote-exec.mjs')

    const logProcessing = vi.fn()
    const logSuccess = vi.fn()

    const executeRemote = createRemoteExecutor({
      ssh: {
        execCommand: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
      },
      rootDir: '/tmp/proj',
      remoteCwd: '/srv/app',
      writeToLogFile: vi.fn().mockResolvedValue(),
      logProcessing,
      logSuccess,
      logError: vi.fn()
    })

    await executeRemote('Fetch latest changes for main', 'git fetch origin main')

    expect(logProcessing).toHaveBeenCalledWith('\nFetch latest changes for main')
    expect(logSuccess).toHaveBeenCalledWith('Fetch latest changes for main')
  })
})
