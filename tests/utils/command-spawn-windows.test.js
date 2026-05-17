import { describe, it, expect, vi } from 'vitest'
import process from 'node:process'

const spawnCalls = []
const spawnSyncCalls = []

function createMockChild({ stdout = '', stderr = '', exitCode = 0 } = {}) {
  const closeHandlers = []
  const errorHandlers = []
  const stdoutHandlers = []
  const stderrHandlers = []

  const child = {
    stdout: {
      on: (event, handler) => {
        if (event === 'data') stdoutHandlers.push(handler)
      }
    },
    stderr: {
      on: (event, handler) => {
        if (event === 'data') stderrHandlers.push(handler)
      }
    },
    on: (event, handler) => {
      if (event === 'close') closeHandlers.push(handler)
      if (event === 'error') errorHandlers.push(handler)
    }
  }

  setImmediate(() => {
    // no error path in these tests
    if (stdout) stdoutHandlers.forEach((h) => h(Buffer.from(stdout)))
    if (stderr) stderrHandlers.forEach((h) => h(Buffer.from(stderr)))
    closeHandlers.forEach((h) => h(exitCode))
    errorHandlers.forEach(() => {})
  })

  return child
}

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn((command, argsOrOptions, maybeOptions) => {
      spawnCalls.push([command, argsOrOptions, maybeOptions])
      return createMockChild({ stdout: 'ok\n', stderr: '', exitCode: 0 })
    }),
    spawnSync: vi.fn((command, args, options) => {
      spawnSyncCalls.push([command, args, options])
      return { status: 0 }
    })
  }
})

describe('command spawning behavior', () => {
  it('uses shell=true + command string for Windows .cmd shims (npm)', async () => {
    if (process.platform !== 'win32') {
      // This behavior is Windows-specific; avoid failing on other OSes.
      return
    }

    spawnCalls.length = 0

    const { runCommand, runCommandCapture } = await import('#src/utils/command.mjs')

    await runCommand('npm', ['--version'])
    await runCommandCapture('npm', ['--version'])

    // For shim commands we expect spawn(commandString, options) (no args array)
    expect(spawnCalls.length).toBe(2)

    const [cmd1, args1, opts1] = spawnCalls[0]
    expect(typeof cmd1).toBe('string')
    expect(cmd1.toLowerCase()).toContain('npm.cmd')
    expect(cmd1).toContain('--version')
    expect(args1).toMatchObject({ shell: true })
    expect(opts1).toBeUndefined()

    const [cmd2, args2, opts2] = spawnCalls[1]
    expect(typeof cmd2).toBe('string')
    expect(cmd2.toLowerCase()).toContain('npm.cmd')
    expect(cmd2).toContain('--version')
    expect(args2).toMatchObject({ shell: true })
    expect(opts2).toBeUndefined()
  })

  it('checks command existence on Windows without shell args', async () => {
    if (process.platform !== 'win32') {
      // This behavior is Windows-specific; avoid failing on other OSes.
      return
    }

    spawnSyncCalls.length = 0

    const { commandExists } = await import('#src/utils/command.mjs')

    expect(commandExists('npm')).toBe(true)
    expect(spawnSyncCalls).toHaveLength(1)
    expect(spawnSyncCalls[0][0]).toBe('where.exe')
    expect(spawnSyncCalls[0][1]).toEqual(['npm.cmd'])
    expect(spawnSyncCalls[0][2]).toEqual({
      stdio: ['ignore', 'pipe', 'ignore']
    })
  })

  it('captures output when runCommand capture mode is requested directly', async () => {
    spawnCalls.length = 0

    const { runCommand } = await import('#src/utils/command.mjs')

    await expect(runCommand('git', ['status'], {capture: true})).resolves.toEqual({
      stdout: 'ok\n',
      stderr: ''
    })
    expect(spawnCalls[0][0]).toBe('git')
    expect(spawnCalls[0][1]).toEqual(['status'])
    expect(spawnCalls[0][2]).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe']
    })
  })

  it('uses spawn(command, args, options) for non-shim commands (git)', async () => {
    spawnCalls.length = 0

    const { runCommand, runCommandCapture } = await import('#src/utils/command.mjs')

    await runCommand('git', ['--version'])
    await runCommandCapture('git', ['--version'])

    expect(spawnCalls.length).toBe(2)

    const [cmd1, args1, opts1] = spawnCalls[0]
    expect(cmd1).toBe('git')
    expect(args1).toEqual(['--version'])
    expect(opts1).toMatchObject({ stdio: 'inherit' })

    const [cmd2, args2, opts2] = spawnCalls[1]
    expect(cmd2).toBe('git')
    expect(args2).toEqual(['--version'])
    expect(opts2).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] })
  })
})
