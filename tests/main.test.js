import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockReadFile = vi.fn()
const mockReaddir = vi.fn()
const mockAccess = vi.fn()
const mockWriteFile = vi.fn()
const mockAppendFile = vi.fn()
const mockMkdir = vi.fn()
const mockUnlink = vi.fn()
const mockStat = vi.fn()
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
    unlink: mockUnlink,
    stat: mockStat
  },
  readFile: mockReadFile,
  readdir: mockReaddir,
  access: mockAccess,
  writeFile: mockWriteFile,
  appendFile: mockAppendFile,
  mkdir: mockMkdir,
  unlink: mockUnlink,
  stat: mockStat
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

const mockValidateLocalDependencies = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/dependency-scanner.mjs', () => ({
  validateLocalDependencies: mockValidateLocalDependencies
}))

describe('zephyr deployment helpers', () => {
  let originalStdoutWrite
  let originalStderrWrite

  beforeEach(() => {
    // Suppress terminal output during tests
    originalStdoutWrite = process.stdout.write
    originalStderrWrite = process.stderr.write
    process.stdout.write = vi.fn()
    process.stderr.write = vi.fn()

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
    mockStat.mockReset()
    mockExecCommand.mockReset()
    mockConnect.mockReset()
    mockDispose.mockReset()
    mockPrompt.mockReset()
    mockValidateLocalDependencies.mockReset()
    
    // Default mock implementations
    mockMkdir.mockResolvedValue(undefined)
    mockValidateLocalDependencies.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue([]) // Empty directory for log cleanup
    mockStat.mockImplementation(async (path) => {
      return { mtime: new Date() }
    })
    globalThis.__zephyrSSHFactory = () => ({
      connect: mockConnect,
      execCommand: mockExecCommand,
      dispose: mockDispose
    })
    globalThis.__zephyrPrompt = mockPrompt
  })

  afterEach(() => {
    // Restore terminal output after tests
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    delete globalThis.__zephyrSSHFactory
    delete globalThis.__zephyrPrompt
  })


  it('resolves remote paths correctly', async () => {
    const { resolveRemotePath } = await import('../src/main.mjs')

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

    const { isPrivateKeyFile } = await import('../src/main.mjs')

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
    const { listSshKeys } = await import('../src/main.mjs')

    const result = await listSshKeys()

    expect(result).toEqual({
      sshDir: path.default.join('/home/local', '.ssh'),
      keys: ['id_rsa', 'deploy_key']
    })
  })

  describe('configuration management', () => {
    it('registers a new server when none exist', async () => {
      mockPrompt.mockResolvedValueOnce({ serverName: 'production', serverIp: '203.0.113.10' })

      const { selectServer } = await import('../src/main.mjs')

      const servers = []
      const server = await selectServer(servers)

      expect(server).toMatchObject({ serverName: 'production', serverIp: '203.0.113.10' })
      expect(server.id).toBeDefined()
      expect(typeof server.id).toBe('string')
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

      const { selectApp } = await import('../src/main.mjs')

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

      const { selectApp } = await import('../src/main.mjs')

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

    const { ensureProjectReleaseScript } = await import('../src/main.mjs')

    await ensureProjectReleaseScript('/workspace/project')

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]workspace[\\/]project[\\/]package\.json/),
      expect.stringContaining('"release": "npx @wyxos/zephyr@latest"')
    )
  })

  it('schedules Laravel tasks based on diff', async () => {
    // Mock reads: composer.json for Laravel detection, package.json for lint check, then SSH key
    mockReadFile
      .mockResolvedValueOnce('{"require":{"laravel/framework":"^10.0"}}') // composer.json for Laravel detection
      .mockResolvedValueOnce('{"scripts":{}}') // package.json - no lint script
      .mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----') // SSH key
    // Mock fs.access for artisan file check, hook detection, and pint check
    mockAccess.mockImplementation(async (filePath) => {
      if (filePath.includes('artisan')) {
        return undefined // artisan file exists
      }
      // Reject for all hook paths (hook doesn't exist)
      if (filePath.includes('pre-push')) {
        throw new Error('ENOENT')
      }
      // Reject for pint (doesn't exist)
      if (filePath.includes('vendor/bin/pint')) {
        throw new Error('ENOENT')
      }
      return undefined
    })
    // Mock log cleanup (readdir returns empty, no old logs to clean)
    mockReaddir.mockResolvedValueOnce([])
    queueSpawnResponse({ stdout: 'main\n' })
    queueSpawnResponse({ stdout: '' }) // git status - no changes
    queueSpawnResponse({}) // php artisan test

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
            'package.json\n' +
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

    const { runRemoteTasks } = await import('../src/main.mjs')

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
    expect(executedCommands.some((cmd) => cmd.includes('npm install'))).toBe(true)
    expect(executedCommands.some((cmd) => cmd.includes('npm run build'))).toBe(true)
    expect(executedCommands.some((cmd) => cmd.includes('cache:clear'))).toBe(true)
    expect(executedCommands.some((cmd) => cmd.includes('horizon:terminate'))).toBe(true)

    // Verify local lock was created
    const lockFileWrites = mockWriteFile.mock.calls.filter(([filePath]) =>
      filePath.includes('deploy.lock')
    )
    expect(lockFileWrites.length).toBeGreaterThan(0)

    // Verify local test command was executed (not remote)
    // Check that php artisan test was called locally via spawn with --compact flag
    const phpTestCalls = mockSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === 'php' && Array.isArray(args) && args.includes('artisan') && args.includes('test') && args.includes('--compact')
    )
    expect(phpTestCalls.length).toBeGreaterThan(0)
  })

  it('skips Laravel tests when pre-push hook exists', async () => {
    // Mock reads: SSH key (linting and tests skipped, so no package.json/composer.json reads needed)
    mockReadFile.mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----') // SSH key
    // Mock fs.access for hook detection and SSH key access
    mockAccess.mockImplementation(async (filePath) => {
      // Resolve for pre-push hook path (hook exists)
      if (filePath.includes('pre-push')) {
        return undefined
      }
      // Resolve for SSH key path
      if (filePath.includes('.ssh') || filePath.includes('id_rsa')) {
        return undefined
      }
      throw new Error('ENOENT')
    })
    // Mock fs.stat for hook file check
    mockStat.mockResolvedValueOnce({ isFile: () => true })
    // Mock log cleanup (readdir returns empty, no old logs to clean)
    mockReaddir.mockResolvedValueOnce([])
    queueSpawnResponse({ stdout: 'main\n' })
    queueSpawnResponse({ stdout: '' })

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
          stdout: 'composer.json\n'
        }
      }

      return response
    })

    const { runRemoteTasks } = await import('../src/main.mjs')

    await runRemoteTasks({
      serverIp: '127.0.0.1',
      projectPath: '~/app',
      branch: 'main',
      sshUser: 'forge',
      sshKey: '~/.ssh/id_rsa'
    })

    // Verify local test command was NOT executed
    const phpTestCalls = mockSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === 'php' && Array.isArray(args) && args.includes('artisan') && args.includes('test')
    )
    expect(phpTestCalls.length).toBe(0)
  })

  it.skip('runs linting and commits changes before tests', async () => {
    // Mock reads: composer.json for Laravel detection, package.json with lint script, then SSH key
    mockReadFile
      .mockResolvedValueOnce('{"require":{"laravel/framework":"^10.0"}}') // composer.json for Laravel detection
      .mockResolvedValueOnce('{"scripts":{"lint":"eslint ."}}') // package.json - has lint script
      .mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----') // SSH key
    // Mock fs.access for artisan file check and hook detection
    mockAccess.mockImplementation(async (filePath) => {
      if (filePath.includes('artisan')) {
        return undefined // artisan file exists
      }
      // Reject for all hook paths (hook doesn't exist)
      if (filePath.includes('pre-push')) {
        throw new Error('ENOENT')
      }
      return undefined
    })
    // Mock log cleanup (readdir returns empty, no old logs to clean)
    mockReaddir.mockResolvedValueOnce([])
    queueSpawnResponse({ stdout: 'main\n' }) // git rev-parse --abbrev-ref HEAD
    queueSpawnResponse({ stdout: '' }) // git status --porcelain (ensureLocalRepositoryState - initial)
    queueSpawnResponse({ stdout: '## main...origin/main\n' }) // git status --short --branch
    queueSpawnResponse({}) // npm run lint
    queueSpawnResponse({ stdout: ' M src/file.js\n' }) // git status --porcelain (hasUncommittedChanges)
    queueSpawnResponse({}) // git add -A
    queueSpawnResponse({ stdout: 'M  src/file.js\n' }) // git status --porcelain (commitLintingChanges after staging)
    queueSpawnResponse({}) // git commit
    queueSpawnResponse({}) // php artisan test

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
        return { ...response, stdout: '' }
      }

      return response
    })

    const { runRemoteTasks } = await import('../src/main.mjs')

    await runRemoteTasks({
      serverIp: '127.0.0.1',
      projectPath: '~/app',
      branch: 'main',
      sshUser: 'forge',
      sshKey: '~/.ssh/id_rsa'
    })

    // Verify lint command was executed
    const lintCalls = mockSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === 'npm' && Array.isArray(args) && args.includes('run') && args.includes('lint')
    )
    expect(lintCalls.length).toBeGreaterThan(0)

    // Verify git add and commit were called
    // Note: git add uses 'add' and '-A' as separate args
    const gitAddCalls = mockSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && Array.isArray(args) && args.includes('add') && args.includes('-A')
    )
    expect(gitAddCalls.length).toBeGreaterThan(0)

    const gitCommitCalls = mockSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && Array.isArray(args) && args.includes('commit') && args.some(arg => typeof arg === 'string' && arg.includes('style: apply linting fixes'))
    )
    expect(gitCommitCalls.length).toBeGreaterThan(0)

    // Verify test command was executed
    const phpTestCalls = mockSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === 'php' && Array.isArray(args) && args.includes('artisan') && args.includes('test')
    )
    expect(phpTestCalls.length).toBeGreaterThan(0)
  })

  it('skips Laravel tasks when framework not detected', async () => {
    mockReadFile.mockResolvedValue('-----BEGIN RSA PRIVATE KEY-----')
    // Mock log cleanup (readdir returns empty, no old logs to clean)
    mockReaddir.mockResolvedValueOnce([])
    queueSpawnResponse({ stdout: 'main\n' })
    queueSpawnResponse({ stdout: '' })

    mockConnect.mockResolvedValue()
    mockDispose.mockResolvedValue()

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '/home/runcloud', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'LOCK_NOT_FOUND', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'no', stderr: '', code: 0 })
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 })

    const { runRemoteTasks } = await import('../src/main.mjs')

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

      const { ensureLocalRepositoryState } = await import('../src/main.mjs')

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

      const { ensureLocalRepositoryState } = await import('../src/main.mjs')

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

      const { ensureLocalRepositoryState } = await import('../src/main.mjs')

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
              key: 'prod-server:~/webapps/app',
              branch: 'main'
            }
          ]
        })
      )

      const { loadProjectConfig } = await import('../src/main.mjs')

      const config = await loadProjectConfig(process.cwd())

      expect(config.presets).toHaveLength(1)
      expect(config.presets[0].name).toBe('production')
      expect(config.presets[0].key).toBe('prod-server:~/webapps/app')
      expect(config.presets[0].branch).toBe('main')
    })

    it('saves presets to project config with unique key', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          apps: [],
          presets: []
        })
      )

      const { loadProjectConfig, saveProjectConfig } = await import('../src/main.mjs')

      const config = await loadProjectConfig(process.cwd())
      config.presets.push({
        name: 'staging',
        key: 'staging-server:~/webapps/staging',
        branch: 'develop'
      })

      await saveProjectConfig(process.cwd(), config)

      const [writePath, payload] = mockWriteFile.mock.calls.at(-1)
      expect(writePath.replace(/\\/g, '/')).toContain('.zephyr/config.json')
      const saved = JSON.parse(payload)
      expect(saved.presets).toHaveLength(1)
      expect(saved.presets[0].name).toBe('staging')
      expect(saved.presets[0].key).toBe('staging-server:~/webapps/staging')
      expect(saved.presets[0].branch).toBe('develop')
      // Verify preset doesn't duplicate server/app details
      expect(saved.presets[0].serverName).toBeUndefined()
      expect(saved.presets[0].projectPath).toBeUndefined()
    })
  })
})
