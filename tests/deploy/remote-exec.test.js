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


describe('remote output streaming', () => {
  async function executor(execCommand, overrides = {}) {
    const {createRemoteExecutor} = await import('#src/deploy/remote-exec.mjs')
    const dependencies = {
      ssh: {execCommand}, rootDir: '/tmp/proj', remoteCwd: '/srv/app',
      writeToLogFile: vi.fn().mockResolvedValue(), logProcessing: vi.fn(),
      logSuccess: vi.fn(), logError: vi.fn(), logOutput: vi.fn(), ...overrides
    }
    return {run: createRemoteExecutor(dependencies), ...dependencies}
  }

  it('delivers both streams before completion and logs each chunk only once', async () => {
    let finish
    const pending = new Promise(resolve => { finish = resolve })
    const execCommand = vi.fn((_command, options) => {
      options.onStdout(Buffer.from('installing\n'))
      options.onStderr(Buffer.from('warning\n'))
      return pending
    })
    const test = await executor(execCommand)
    const running = test.run('Dependencies', 'install')
    expect(test.logOutput.mock.calls.map(([event]) => event)).toEqual([
      {label: 'Dependencies', stream: 'stdout', chunk: 'installing\n'},
      {label: 'Dependencies', stream: 'stderr', chunk: 'warning\n'}
    ])
    expect(test.logSuccess).not.toHaveBeenCalled()
    finish({code: 0, stdout: 'installing\n', stderr: 'warning\n'})
    await running
    expect(test.writeToLogFile).toHaveBeenCalledTimes(2)
    expect(test.logOutput).toHaveBeenCalledTimes(2)
    expect(test.logSuccess).toHaveBeenCalledWith('Dependencies')
  })

  it('keeps UTF-8 characters intact across split chunks', async () => {
    const character = String.fromCodePoint(0x2713)
    const test = await executor(vi.fn(async (_command, options) => {
      const bytes = Buffer.from(character)
      options.onStdout(bytes.subarray(0, 1))
      options.onStdout(bytes.subarray(1))
      return {code: 0, stdout: character, stderr: ''}
    }))
    await test.run('Build', 'build')
    expect(test.logOutput).toHaveBeenCalledTimes(1)
    expect(test.logOutput).toHaveBeenCalledWith({label: 'Build', stream: 'stdout', chunk: character})
  })

  it('falls back to buffered output for clients without streaming callbacks', async () => {
    const test = await executor(vi.fn().mockResolvedValue({code: 0, stdout: 'done', stderr: 'notice'}))
    await test.run('Build', 'build')
    expect(test.writeToLogFile).toHaveBeenCalledTimes(2)
    expect(test.logOutput).toHaveBeenCalledTimes(2)
  })

  it('exposes confirmed failure exit codes and does not replay already streamed text', async () => {
    const test = await executor(vi.fn(async (_command, options) => {
      options.onStderr(Buffer.from('compiler failed'))
      return {code: 17, stdout: '', stderr: 'compiler failed'}
    }))
    await expect(test.run('Build', 'build')).rejects.toMatchObject({
      code: 'REMOTE_COMMAND_FAILED', data: {stepLabel: 'Build', exitCode: 17}
    })
    expect(test.logOutput).toHaveBeenCalledTimes(1)
    expect(test.logError).toHaveBeenCalledWith('Remote step "Build" failed with exit code 17.')
    expect(test.logSuccess).not.toHaveBeenCalled()
  })

  it.each([
    {code: null, stdout: '', stderr: ''},
    {code: 255, stdout: '', stderr: 'connection lost', outcomeUnknown: true}
  ])('marks missing remote exit status as unknown even with allowFailure: $code', async result => {
    const test = await executor(vi.fn().mockResolvedValue(result))
    await expect(test.run('Build', 'build', {allowFailure: true})).rejects.toMatchObject({code: 'REMOTE_OUTCOME_UNKNOWN'})
    expect(test.ssh.execCommand).toHaveBeenCalledTimes(1)
    expect(test.logSuccess).not.toHaveBeenCalled()
  })

  it('preserves partial output when a connection is interrupted without retrying', async () => {
    const test = await executor(vi.fn(async (_command, options) => {
      options.onStdout(Buffer.from('migration started'))
      throw new Error('connection reset')
    }))
    await expect(test.run('Migration', 'migrate')).rejects.toMatchObject({
      code: 'REMOTE_OUTCOME_UNKNOWN', data: {stepLabel: 'Migration', exitCode: null}
    })
    expect(test.writeToLogFile).toHaveBeenCalledTimes(1)
    expect(test.writeToLogFile).toHaveBeenCalledWith('/tmp/proj', '[Migration] STDOUT:\nmigration started')
    expect(test.ssh.execCommand).toHaveBeenCalledTimes(1)
  })
})


it('keeps explicitly hidden command stdout out of terminal events while retaining the log', async () => {
  const {createRemoteExecutor} = await import('#src/deploy/remote-exec.mjs')
  const logOutput = vi.fn()
  const writeToLogFile = vi.fn().mockResolvedValue()
  const run = createRemoteExecutor({
    ssh: {execCommand: vi.fn(async (_command, options) => {
      options.onStdout(Buffer.from('machine result'))
      return {code: 0, stdout: 'machine result', stderr: ''}
    })}, rootDir: '/tmp/proj', remoteCwd: '/srv/app', logOutput, writeToLogFile
  })
  await run('Inspect', 'inspect', {printStdout: false})
  expect(logOutput).not.toHaveBeenCalled()
  expect(writeToLogFile).toHaveBeenCalledTimes(1)
  expect(writeToLogFile).toHaveBeenCalledWith('/tmp/proj', '[Inspect] STDOUT:\nmachine result')
})


it('keeps live multiline and quoted chunks valid NDJSON through the shared logger', async () => {
  const {createRemoteExecutor} = await import('#src/deploy/remote-exec.mjs')
  const {createJsonEventEmitter, createJsonLogger} = await import('#src/utils/output.mjs')
  const lines = []
  const emitEvent = createJsonEventEmitter({workflow: 'deploy', writeEvent: line => lines.push(line)})
  const logs = createJsonLogger({emitEvent})
  const run = createRemoteExecutor({
    ssh: {execCommand: vi.fn(async (_command, options) => {
      options.onStdout(Buffer.from('first "quoted" line\nsecond line\n'))
      options.onStderr(Buffer.from('warning\r\n'))
      return {code: 0, stdout: 'first "quoted" line\nsecond line\n', stderr: 'warning\r\n'}
    })}, rootDir: '/tmp/proj', remoteCwd: '/srv/app',
    writeToLogFile: vi.fn().mockResolvedValue(), ...logs
  })
  await run('Build', 'build')
  const events = lines.map(line => JSON.parse(line))
  expect(events).toHaveLength(4)
  expect(events[1]).toMatchObject({event: 'log', workflow: 'deploy', message: '[Build] stdout: first "quoted" line\nsecond line\n'})
  expect(events[2]).toMatchObject({event: 'log', message: '[Build] stderr: warning\r\n'})
})
