import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockReadFile = vi.fn()
const mockReaddir = vi.fn()
const mockAccess = vi.fn()
const mockWriteFile = vi.fn()
const mockAppendFile = vi.fn()
const mockMkdir = vi.fn()
const mockUnlink = vi.fn()
const mockExecCommand = vi.fn()
const mockConnect = vi.fn()
const mockDispose = vi.fn()
const mockPrompt = vi.fn()

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    readdir: mockReaddir,
    access: mockAccess,
    writeFile: mockWriteFile,
    appendFile: mockAppendFile,
    mkdir: mockMkdir,
    unlink: mockUnlink
  },
  readFile: mockReadFile,
  readdir: mockReaddir,
  access: mockAccess,
  writeFile: mockWriteFile,
  appendFile: mockAppendFile,
  mkdir: mockMkdir,
  unlink: mockUnlink
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

vi.mock('inquirer', () => {
  class Separator {}

  return {
    default: {
      prompt: mockPrompt,
      Separator
    },
    Separator,
    prompt: mockPrompt
  }
})

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
    userInfo: () => ({ username: 'localuser' }),
    hostname: () => 'test-host'
  },
  homedir: () => '/home/local',
  userInfo: () => ({ username: 'localuser' }),
  hostname: () => 'test-host'
}))

describe('zephyr deployment helpers', () => {
  let originalConsoleLog
  let originalConsoleWarn
  let originalConsoleError

  beforeEach(() => {
    // Suppress console output during tests
    originalConsoleLog = console.log
    originalConsoleWarn = console.warn
    originalConsoleError = console.error
    console.log = vi.fn()
    console.warn = vi.fn()
    console.error = vi.fn()

    vi.resetModules()
    spawnQueue.length = 0
    mockSpawn.mockClear()
    mockReadFile.mockReset()
    mockReaddir.mockReset()
    mockAccess.mockReset()
    mockWriteFile.mockReset()
    mockAppendFile.mockReset()
  mockUnlink.mockReset()
  mockMkdir.mockReset()
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
    // Restore console output after tests
    console.log = originalConsoleLog
    console.warn = originalConsoleWarn
    console.error = originalConsoleError
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

  describe('configuration management', () => {
    it('registers a new server when none exist', async () => {
      mockPrompt.mockResolvedValueOnce({ serverName: 'production', serverIp: '203.0.113.10' })

      const { selectServer } = await import('../src/index.mjs')

      const servers = []
      const server = await selectServer(servers)

      expect(server).toEqual({ serverName: 'production', serverIp: '203.0.113.10' })
      expect(servers).toHaveLength(1)
      expect(mockMkdir).toHaveBeenCalledWith(expect.stringMatching(/[\\/]\.config[\\/]zephyr/), { recursive: true })
      const [writePath, payload] = mockWriteFile.mock.calls.at(-1)
      expect(writePath).toContain('servers.json')
      expect(payload).toContain('production')
    })

    it('creates a new application configuration when none exist for a server', async () => {
      queueSpawnResponse({ stdout: 'main\n' })
      mockPrompt
        .mockResolvedValueOnce({ projectPath: '~/webapps/demo', branchSelection: 'main' })
        .mockResolvedValueOnce({ sshUser: 'forge', sshKeySelection: '/home/local/.ssh/id_rsa' })
      mockReaddir.mockResolvedValue([])

      const { selectApp } = await import('../src/index.mjs')

      const projectConfig = { apps: [] }
      const server = { serverName: 'production', serverIp: '203.0.113.10' }

      const app = await selectApp(projectConfig, server, process.cwd())

      expect(app).toMatchObject({
        serverName: 'production',
        projectPath: '~/webapps/demo',
        branch: 'main',
        sshUser: 'forge',
        sshKey: '/home/local/.ssh/id_rsa'
      })
      expect(projectConfig.apps).toHaveLength(1)
      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('.zephyr'), { recursive: true })
      const [writePath, payload] = mockWriteFile.mock.calls.at(-1)
      expect(writePath.replace(/\\/g, '/')).toContain('.zephyr/config.json')
      expect(payload).toContain('~/webapps/demo')
    })

    it('shows existing applications when apps exist for a server', async () => {
      mockPrompt.mockResolvedValueOnce({ selection: 0 })

      const { selectApp } = await import('../src/index.mjs')

      const projectConfig = {
        apps: [
          {
            serverName: 'production',
            projectPath: '~/webapps/app1',
            branch: 'main',
            sshUser: 'deploy',
            sshKey: '~/.ssh/id_rsa'
          },
          {
            serverName: 'production',
            projectPath: '~/webapps/app2',
            branch: 'develop',
            sshUser: 'deploy',
            sshKey: '~/.ssh/id_rsa'
          },
          {
            serverName: 'staging',
            projectPath: '~/webapps/app3',
            branch: 'main',
            sshUser: 'deploy',
            sshKey: '~/.ssh/id_rsa'
          }
        ]
      }
      const server = { serverName: 'production', serverIp: '203.0.113.10' }

      const app = await selectApp(projectConfig, server, process.cwd())

      expect(app).toMatchObject({
        serverName: 'production',
        projectPath: '~/webapps/app1',
        branch: 'main'
      })
      expect(mockPrompt).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Select application for production',
            choices: expect.arrayContaining([
              expect.objectContaining({ name: '~/webapps/app1 (main)' }),
              expect.objectContaining({ name: '~/webapps/app2 (develop)' })
            ])
          })
        ])
      )
    })
  })

  it('adds release script to package.json when user agrees', async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        name: 'demo-app',
        scripts: {
          test: 'vitest'
        }
      })
    )
    mockPrompt.mockResolvedValueOnce({ installReleaseScript: true })
    queueSpawnResponse({}) // git rev-parse
    queueSpawnResponse({}) // git add package.json
    queueSpawnResponse({}) // git commit

    const { ensureProjectReleaseScript } = await import('../src/index.mjs')

    await ensureProjectReleaseScript('/workspace/project')

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]workspace[\\/]project[\\/]package\.json/),
      expect.stringContaining('"release": "npx @wyxos/zephyr@latest"')
    )
  })

  it('schedules Laravel tasks based on diff', async () => {
    // Mock reads: composer.json for Laravel detection first, then SSH key later
    mockReadFile
      .mockResolvedValueOnce('{"require":{"laravel/framework":"^10.0"}}') // composer.json for Laravel detection
      .mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----') // SSH key
    // Mock fs.access for artisan file check
    mockAccess.mockResolvedValueOnce(undefined) // artisan file exists
    queueSpawnResponse({ stdout: 'main\n' })
    queueSpawnResponse({ stdout: '' })
    queueSpawnResponse({}) // php artisan test --compact

    mockConnect.mockResolvedValue()
    mockDispose.mockResolvedValue()

    mockExecCommand.mockImplementation(async (command) => {
      const response = { stdout: '', stderr: '', code: 0 }

      if (command.includes('printf "%s" "$HOME"')) {
        return { ...response, stdout: '/home/runcloud' }
      }

      if (command.includes('LOCK_NOT_FOUND') || command.includes('deploy.lock')) {
        if (command.includes('cat')) {
          return { ...response, stdout: 'LOCK_NOT_FOUND' }
        }
        return response
      }

      if (command.includes('grep -q "laravel/framework"')) {
        return { ...response, stdout: 'yes' }
      }

      if (command.includes('git diff')) {
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

    const executedCommands = mockExecCommand.mock.calls.map(([cmd]) => cmd)
    expect(executedCommands.some((cmd) => cmd.includes('git pull origin main'))).toBe(true)
    expect(executedCommands.some((cmd) => cmd.includes('composer update'))).toBe(true)
    expect(executedCommands.some((cmd) => cmd.includes('php artisan migrate'))).toBe(true)
    expect(executedCommands.some((cmd) => cmd.includes('npm run build'))).toBe(true)
    expect(executedCommands.some((cmd) => cmd.includes('cache:clear'))).toBe(true)
    expect(executedCommands.some((cmd) => cmd.includes('horizon:terminate'))).toBe(true)

    // Verify local test command was executed (not remote)
    // Check that php artisan test --compact was called locally via spawn
    const phpTestCalls = mockSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === 'php' && Array.isArray(args) && args.includes('artisan') && args.includes('test') && args.includes('--compact')
    )
    expect(phpTestCalls.length).toBeGreaterThan(0)
  })

  it('skips Laravel tasks when framework not detected', async () => {
    mockReadFile.mockResolvedValue('-----BEGIN RSA PRIVATE KEY-----')
    queueSpawnResponse({ stdout: 'main\n' })
    queueSpawnResponse({ stdout: '' })

    mockConnect.mockResolvedValue()
    mockDispose.mockResolvedValue()

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '/home/runcloud', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'LOCK_NOT_FOUND', stderr: '', code: 0 })
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

    const skippedCommands = mockExecCommand.mock.calls.map(([cmd]) => cmd)
    expect(skippedCommands.every((cmd) => !cmd.includes('composer update'))).toBe(true)
    expect(skippedCommands.some((cmd) => cmd.includes('git pull origin main'))).toBe(true)
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

  describe('preset management', () => {
    it('loads presets from project config', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          apps: [],
          presets: [
            {
              name: 'production',
              serverName: 'prod-server',
              projectPath: '~/webapps/app',
              branch: 'main',
              sshUser: 'deploy',
              sshKey: '~/.ssh/id_rsa'
            }
          ]
        })
      )

      const { loadProjectConfig } = await import('../src/index.mjs')

      const config = await loadProjectConfig(process.cwd())

      expect(config.presets).toHaveLength(1)
      expect(config.presets[0].name).toBe('production')
    })

    it('saves presets to project config', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          apps: [],
          presets: []
        })
      )

      const { loadProjectConfig, saveProjectConfig } = await import('../src/index.mjs')

      const config = await loadProjectConfig(process.cwd())
      config.presets.push({
        name: 'staging',
        serverName: 'staging-server',
        projectPath: '~/webapps/staging',
        branch: 'develop',
        sshUser: 'deploy',
        sshKey: '~/.ssh/id_rsa'
      })

      await saveProjectConfig(process.cwd(), config)

      const [writePath, payload] = mockWriteFile.mock.calls.at(-1)
      expect(writePath.replace(/\\/g, '/')).toContain('.zephyr/config.json')
      const saved = JSON.parse(payload)
      expect(saved.presets).toHaveLength(1)
      expect(saved.presets[0].name).toBe('staging')
    })
  })
})
