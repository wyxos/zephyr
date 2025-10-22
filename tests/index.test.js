import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockReadFile = vi.fn()
const mockReaddir = vi.fn()
const mockAccess = vi.fn()
const mockWriteFile = vi.fn()
const mockExecCommand = vi.fn()
const mockConnect = vi.fn()
const mockDispose = vi.fn()
const mockPrompt = vi.fn()

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    readdir: mockReaddir,
    access: mockAccess,
    writeFile: mockWriteFile
  },
  readFile: mockReadFile,
  readdir: mockReaddir,
  access: mockAccess,
  writeFile: mockWriteFile
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

vi.mock('inquirer', () => ({
  default: {
    prompt: mockPrompt
  }
}))

vi.mock('node-ssh', () => ({
  NodeSSH: vi.fn(() => ({
    connect: mockConnect,
    execCommand: mockExecCommand,
    dispose: mockDispose
  }))
}))

vi.mock('node:os', () => ({
  default: {
    homedir: () => '/home/local',
    userInfo: () => ({ username: 'localuser' })
  },
  homedir: () => '/home/local',
  userInfo: () => ({ username: 'localuser' })
}))

describe('zephyr deployment helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnQueue.length = 0
    mockSpawn.mockClear()
    mockReadFile.mockReset()
    mockReaddir.mockReset()
    mockAccess.mockReset()
    mockWriteFile.mockReset()
    mockExecCommand.mockReset()
    mockConnect.mockReset()
    mockDispose.mockReset()
    mockPrompt.mockReset()
    globalThis.__zephyrSSHFactory = () => ({
      connect: mockConnect,
      execCommand: mockExecCommand,
      dispose: mockDispose
    })
    globalThis.__zephyrPrompt = mockPrompt
  })

  afterEach(() => {
    delete globalThis.__zephyrSSHFactory
    delete globalThis.__zephyrPrompt
  })

  it('resolves remote paths correctly', async () => {
    const { resolveRemotePath } = await import('../src/index.mjs')

    expect(resolveRemotePath('~/webapps/app', '/home/runcloud')).toBe(
      '/home/runcloud/webapps/app'
    )
    expect(resolveRemotePath('app', '/home/runcloud')).toBe('/home/runcloud/app')
    expect(resolveRemotePath('/var/www/html', '/home/runcloud')).toBe(
      '/var/www/html'
    )
    expect(resolveRemotePath('~', '/home/runcloud')).toBe('/home/runcloud')
  })

  it('detects private key files from contents', async () => {
    mockReadFile.mockResolvedValueOnce('-----BEGIN OPENSSH PRIVATE KEY-----')

    const { isPrivateKeyFile } = await import('../src/index.mjs')

    await expect(isPrivateKeyFile('/home/local/.ssh/id_rsa')).resolves.toBe(true)

    mockReadFile.mockResolvedValueOnce('not-a-key')
    await expect(isPrivateKeyFile('/home/local/.ssh/config')).resolves.toBe(false)
  })

  it('lists only valid SSH private keys', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'id_rsa', isFile: () => true },
      { name: 'id_rsa.pub', isFile: () => true },
      { name: '.DS_Store', isFile: () => true },
      { name: 'config', isFile: () => true },
      { name: 'deploy_key', isFile: () => true }
    ])

    mockReadFile.mockImplementation(async (filePath) => {
      if (filePath.endsWith('id_rsa')) {
        return '-----BEGIN RSA PRIVATE KEY-----'
      }

      if (filePath.endsWith('deploy_key')) {
        return '-----BEGIN OPENSSH PRIVATE KEY-----'
      }

      return 'invalid'
    })

    // Import path module to ensure cross-platform path handling
    const path = await import('node:path')
    const { listSshKeys } = await import('../src/index.mjs')

    const result = await listSshKeys()

    expect(result).toEqual({
      sshDir: path.default.join('/home/local', '.ssh'),
      keys: ['id_rsa', 'deploy_key']
    })
  })

  it('schedules Laravel tasks based on diff', async () => {
    queueSpawnResponse({ stdout: 'main\n' })
    queueSpawnResponse({ stdout: '' })

    mockConnect.mockResolvedValue()
    mockDispose.mockResolvedValue()

    mockExecCommand.mockImplementation(async (command) => {
      const response = { stdout: '', stderr: '', code: 0 }

      if (command.includes('printf "%s" "$HOME"')) {
        return { ...response, stdout: '/home/runcloud' }
      }

      if (command.includes('grep -q "laravel/framework"')) {
        return { ...response, stdout: 'yes' }
      }

      if (command.startsWith('git diff')) {
        return {
          ...response,
          stdout:
            'composer.json\n' +
            'database/migrations/2025_10_21_000000_create_table.php\n' +
            'resources/js/app.js\n' +
            'resources/views/welcome.blade.php\n' +
            'config/horizon.php\n'
        }
      }

      if (command.includes('config/horizon.php')) {
        return { ...response, stdout: 'yes' }
      }

      return response
    })

    const { runRemoteTasks } = await import('../src/index.mjs')

    await runRemoteTasks({
      serverIp: '127.0.0.1',
      projectPath: '~/app',
      branch: 'main',
      sshUser: 'forge',
      sshKey: '~/.ssh/id_rsa'
    })

    const cwdValues = mockExecCommand.mock.calls
      .map(([, options]) => options?.cwd)
      .filter(Boolean)
    expect(cwdValues.length).toBeGreaterThan(0)
    expect(cwdValues.every((cwd) => typeof cwd === 'string')).toBe(true)
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('git pull origin main'),
      expect.objectContaining({ cwd: expect.any(String) })
    )
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('composer update'),
      expect.objectContaining({ cwd: expect.any(String) })
    )
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('php artisan migrate'),
      expect.objectContaining({ cwd: expect.any(String) })
    )
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('npm run build'),
      expect.objectContaining({ cwd: expect.any(String) })
    )
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('cache:clear'),
      expect.objectContaining({ cwd: expect.any(String) })
    )
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('horizon:terminate'),
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it('skips Laravel tasks when framework not detected', async () => {
    queueSpawnResponse({ stdout: 'main\n' })
    queueSpawnResponse({ stdout: '' })

    mockConnect.mockResolvedValue()
    mockDispose.mockResolvedValue()

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '/home/runcloud', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'no', stderr: '', code: 0 })
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 })

    const { runRemoteTasks } = await import('../src/index.mjs')

    await runRemoteTasks({
      serverIp: '127.0.0.1',
      projectPath: '~/app',
      branch: 'main',
      sshUser: 'forge',
      sshKey: '~/.ssh/id_rsa'
    })

    expect(mockExecCommand).not.toHaveBeenCalledWith(
      expect.stringContaining('composer update'),
      expect.anything()
    )
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('git pull origin main'),
      expect.anything()
    )
  })

  describe('ensureLocalRepositoryState', () => {
    it('switches to the target branch when clean', async () => {
      queueSpawnResponse({ stdout: 'develop\n' })
      queueSpawnResponse({ stdout: '' })
      queueSpawnResponse({})
      queueSpawnResponse({ stdout: '' })

      const { ensureLocalRepositoryState } = await import('../src/index.mjs')

      await expect(
        ensureLocalRepositoryState('main', process.cwd())
      ).resolves.toBeUndefined()

      expect(
        mockSpawn.mock.calls.some(
          ([command, args]) => command === 'git' && args.includes('checkout') && args.includes('main')
        )
      ).toBe(true)
    })

    it('throws when attempting to switch branches with uncommitted changes', async () => {
      queueSpawnResponse({ stdout: 'develop\n' })
      queueSpawnResponse({ stdout: ' M file.txt\n' })

      const { ensureLocalRepositoryState } = await import('../src/index.mjs')

      await expect(
        ensureLocalRepositoryState('main', process.cwd())
      ).rejects.toThrow(/uncommitted changes/)
    })

    it('commits and pushes pending changes on the target branch', async () => {
      queueSpawnResponse({ stdout: 'main\n' })
      queueSpawnResponse({ stdout: ' M file.php\n' })
      queueSpawnResponse({})
      queueSpawnResponse({})
      queueSpawnResponse({})
      queueSpawnResponse({ stdout: '' })

      mockPrompt.mockResolvedValueOnce({ commitMessage: 'Prepare deployment' })

      const { ensureLocalRepositoryState } = await import('../src/index.mjs')

      await expect(
        ensureLocalRepositoryState('main', process.cwd())
      ).resolves.toBeUndefined()

      expect(mockPrompt).toHaveBeenCalledTimes(1)
      expect(
        mockSpawn.mock.calls.some(
          ([command, args]) => command === 'git' && args[0] === 'commit'
        )
      ).toBe(true)
      expect(
        mockSpawn.mock.calls.some(
          ([command, args]) => command === 'git' && args[0] === 'push' && args.includes('main')
        )
      ).toBe(true)
    })
  })
})
