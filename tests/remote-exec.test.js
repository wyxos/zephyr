import { describe, it, expect, vi } from 'vitest'

describe('deploy/remote-exec', () => {
  it('logs stdout/stderr to log file and throws on non-zero exit by default', async () => {
    const { createRemoteExecutor } = await import('../src/deploy/remote-exec.mjs')

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
    expect(logProcessing).toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
    expect(logSuccess).not.toHaveBeenCalled()
  })

  it('supports env injection when bootstrapEnv is false', async () => {
    const { createRemoteExecutor } = await import('../src/deploy/remote-exec.mjs')

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
})

