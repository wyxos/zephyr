import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import crypto from 'node:crypto'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { NodeSSH } from 'node-ssh'
import { releaseNode } from './release-node.mjs'
import { releasePackagist } from './release-packagist.mjs'
import { validateLocalDependencies } from './dependency-scanner.mjs'
import { checkAndUpdateVersion } from './version-checker.mjs'
import { createChalkLogger, writeStderrLine, writeStdoutLine } from './utils/output.mjs'
import { runCommand as runCommandBase, runCommandCapture as runCommandCaptureBase } from './utils/command.mjs'
import { planLaravelDeploymentTasks } from './utils/task-planner.mjs'
import {
  ensureDirectory,
  getProjectConfigPath,
  PENDING_TASKS_FILE,
  PROJECT_CONFIG_DIR,
  PROJECT_CONFIG_FILE
} from './utils/paths.mjs'
import { cleanupOldLogs, closeLogFile, getLogFilePath, writeToLogFile } from './utils/log-file.mjs'
import {
  acquireRemoteLock,
  compareLocksAndPrompt,
  releaseLocalLock,
  releaseRemoteLock
} from './deploy/locks.mjs'
import {
  clearPendingTasksSnapshot,
  loadPendingTasksSnapshot,
  savePendingTasksSnapshot
} from './deploy/snapshots.mjs'
import {
  ensureGitignoreEntry as ensureGitignoreEntryImpl,
  ensureProjectReleaseScript as ensureProjectReleaseScriptImpl
} from './project/bootstrap.mjs'
import {
  commitLintingChanges as commitLintingChangesImpl,
  hasPrePushHook as hasPrePushHookImpl,
  isLocalLaravelProject as isLocalLaravelProjectImpl,
  runLinting as runLintingImpl
} from './deploy/preflight.mjs'
import { createRemoteExecutor } from './deploy/remote-exec.mjs'
import {
  ensureSshDetails as ensureSshDetailsImpl,
  isPrivateKeyFile as isPrivateKeyFileImpl,
  listSshKeys as listSshKeysImpl,
  promptSshDetails as promptSshDetailsImpl,
  resolveSshKeyPath as resolveSshKeyPathImpl
} from './ssh/keys.mjs'
import {
  ensureLocalRepositoryState as ensureLocalRepositoryStateImpl,
  getGitStatus as getGitStatusImpl,
  hasUncommittedChanges as hasUncommittedChangesImpl
} from './deploy/local-repo.mjs'
import {
  defaultProjectPath as defaultProjectPathImpl,
  listGitBranches as listGitBranchesImpl,
  promptAppDetails as promptAppDetailsImpl,
  promptServerDetails as promptServerDetailsImpl,
  selectApp as selectAppImpl,
  selectPreset as selectPresetImpl,
  selectServer as selectServerImpl
} from './utils/config-flow.mjs'

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.config', 'zephyr')
const SERVERS_FILE = path.join(GLOBAL_CONFIG_DIR, 'servers.json')
const RELEASE_SCRIPT_NAME = 'release'
const RELEASE_SCRIPT_COMMAND = 'npx @wyxos/zephyr@latest'

const { logProcessing, logSuccess, logWarning, logError } = createChalkLogger(chalk)

const createSshClient = () => {
  if (typeof globalThis !== 'undefined' && globalThis.__zephyrSSHFactory) {
    return globalThis.__zephyrSSHFactory()
  }

  return new NodeSSH()
}

const runPrompt = async (questions) => {
  if (typeof globalThis !== 'undefined' && globalThis.__zephyrPrompt) {
    return globalThis.__zephyrPrompt(questions)
  }

  return inquirer.prompt(questions)
}

async function runCommand(command, args, { silent = false, cwd } = {}) {
  const stdio = silent ? 'ignore' : 'inherit'
  return runCommandBase(command, args, { cwd, stdio })
}

async function runCommandCapture(command, args, { cwd } = {}) {
  const { stdout } = await runCommandCaptureBase(command, args, { cwd })
  return stdout
}

// Local repository state moved to src/deploy/local-repo.mjs

async function getGitStatus(rootDir) {
  return await getGitStatusImpl(rootDir, { runCommandCapture })
}

async function hasUncommittedChanges(rootDir) {
  return await hasUncommittedChangesImpl(rootDir, { getGitStatus })
}

async function ensureLocalRepositoryState(targetBranch, rootDir = process.cwd()) {
  return await ensureLocalRepositoryStateImpl(targetBranch, rootDir, {
    runPrompt,
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess,
    logWarning
  })
}

async function ensureProjectReleaseScript(rootDir) {
  return await ensureProjectReleaseScriptImpl(rootDir, {
    runPrompt,
    runCommand,
    logSuccess,
    logWarning,
    releaseScriptName: RELEASE_SCRIPT_NAME,
    releaseScriptCommand: RELEASE_SCRIPT_COMMAND
  })
}

// Locks and snapshots moved to src/deploy/*

async function ensureGitignoreEntry(rootDir) {
  return await ensureGitignoreEntryImpl(rootDir, {
    projectConfigDir: PROJECT_CONFIG_DIR,
    runCommand,
    logSuccess,
    logWarning
  })
}

function generateId() {
  return crypto.randomBytes(8).toString('hex')
}

function migrateServers(servers) {
  if (!Array.isArray(servers)) {
    return []
  }

  let needsMigration = false
  const migrated = servers.map((server) => {
    if (!server.id) {
      needsMigration = true
      return {
        ...server,
        id: generateId()
      }
    }
    return server
  })

  return { servers: migrated, needsMigration }
}

function migrateApps(apps, servers) {
  if (!Array.isArray(apps)) {
    return { apps: [], needsMigration: false }
  }

  // Create a map of serverName -> serverId for migration
  const serverNameToId = new Map()
  servers.forEach((server) => {
    if (server.id && server.serverName) {
      serverNameToId.set(server.serverName, server.id)
    }
  })

  let needsMigration = false
  const migrated = apps.map((app) => {
    const updated = { ...app }

    if (!app.id) {
      needsMigration = true
      updated.id = generateId()
    }

    // Migrate serverName to serverId if needed
    if (app.serverName && !app.serverId) {
      const serverId = serverNameToId.get(app.serverName)
      if (serverId) {
        needsMigration = true
        updated.serverId = serverId
      }
    }

    return updated
  })

  return { apps: migrated, needsMigration }
}

function migratePresets(presets, apps) {
  if (!Array.isArray(presets)) {
    return { presets: [], needsMigration: false }
  }

  // Create a map of serverName:projectPath -> appId for migration
  const keyToAppId = new Map()
  apps.forEach((app) => {
    if (app.id && app.serverName && app.projectPath) {
      const key = `${app.serverName}:${app.projectPath}`
      keyToAppId.set(key, app.id)
    }
  })

  let needsMigration = false
  const migrated = presets.map((preset) => {
    const updated = { ...preset }

    // Migrate from key-based to appId-based if needed
    if (preset.key && !preset.appId) {
      const appId = keyToAppId.get(preset.key)
      if (appId) {
        needsMigration = true
        updated.appId = appId
        // Keep key for backward compatibility during transition, but it's deprecated
      }
    }

    return updated
  })

  return { presets: migrated, needsMigration }
}

async function loadServers() {
  try {
    const raw = await fs.readFile(SERVERS_FILE, 'utf8')
    const data = JSON.parse(raw)
    const servers = Array.isArray(data) ? data : []

    const { servers: migrated, needsMigration } = migrateServers(servers)

    if (needsMigration) {
      await saveServers(migrated)
      logSuccess('Migrated servers configuration to use unique IDs.')
    }

    return migrated
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    logWarning('Failed to read servers.json, starting with an empty list.')
    return []
  }
}

async function saveServers(servers) {
  await ensureDirectory(GLOBAL_CONFIG_DIR)
  const payload = JSON.stringify(servers, null, 2)
  await fs.writeFile(SERVERS_FILE, `${payload}\n`)
}

async function loadProjectConfig(rootDir, servers = []) {
  const configPath = getProjectConfigPath(rootDir)

  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const data = JSON.parse(raw)
    const apps = Array.isArray(data?.apps) ? data.apps : []
    const presets = Array.isArray(data?.presets) ? data.presets : []

    // Migrate apps first (needs servers for serverName -> serverId mapping)
    const { apps: migratedApps, needsMigration: appsNeedMigration } = migrateApps(apps, servers)

    // Migrate presets (needs migrated apps for key -> appId mapping)
    const { presets: migratedPresets, needsMigration: presetsNeedMigration } = migratePresets(presets, migratedApps)

    if (appsNeedMigration || presetsNeedMigration) {
      await saveProjectConfig(rootDir, {
        apps: migratedApps,
        presets: migratedPresets
      })
      logSuccess('Migrated project configuration to use unique IDs.')
    }

    return {
      apps: migratedApps,
      presets: migratedPresets
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { apps: [], presets: [] }
    }

    logWarning('Failed to read .zephyr/config.json, starting with an empty list of apps.')
    return { apps: [], presets: [] }
  }
}

async function saveProjectConfig(rootDir, config) {
  const configDir = path.join(rootDir, PROJECT_CONFIG_DIR)
  await ensureDirectory(configDir)
  const payload = JSON.stringify(
    {
      apps: config.apps ?? [],
      presets: config.presets ?? []
    },
    null,
    2
  )
  await fs.writeFile(path.join(configDir, PROJECT_CONFIG_FILE), `${payload}\n`)
}

function defaultProjectPath(currentDir) {
  return defaultProjectPathImpl(currentDir)
}

async function listGitBranches(currentDir) {
  return await listGitBranchesImpl(currentDir, { runCommandCapture, logWarning })
}

async function listSshKeys() {
  return await listSshKeysImpl()
}

async function isPrivateKeyFile(filePath) {
  return await isPrivateKeyFileImpl(filePath)
}

async function promptSshDetails(currentDir, existing = {}) {
  return await promptSshDetailsImpl(currentDir, existing, { runPrompt })
}

async function ensureSshDetails(config, currentDir) {
  return await ensureSshDetailsImpl(config, currentDir, { runPrompt, logProcessing })
}

async function resolveSshKeyPath(targetPath) {
  return await resolveSshKeyPathImpl(targetPath)
}

function resolveRemotePath(projectPath, remoteHome) {
  if (!projectPath) {
    return projectPath
  }

  const sanitizedHome = remoteHome.replace(/\/+$/, '')

  if (projectPath === '~') {
    return sanitizedHome
  }

  if (projectPath.startsWith('~/')) {
    const remainder = projectPath.slice(2)
    return remainder ? `${sanitizedHome}/${remainder}` : sanitizedHome
  }

  if (projectPath.startsWith('/')) {
    return projectPath
  }

  return `${sanitizedHome}/${projectPath}`
}

async function runLinting(rootDir) {
  return await runLintingImpl(rootDir, { runCommand, logProcessing, logSuccess })
}

async function commitLintingChanges(rootDir) {
  return await commitLintingChangesImpl(rootDir, {
    getGitStatus,
    runCommand,
    logProcessing,
    logSuccess
  })
}

async function runRemoteTasks(config, options = {}) {
  const { snapshot = null, rootDir = process.cwd() } = options

  await cleanupOldLogs(rootDir)
  await ensureLocalRepositoryState(config.branch, rootDir)

  const isLaravel = await isLocalLaravelProjectImpl(rootDir)
  const hasHook = await hasPrePushHookImpl(rootDir)

  if (!hasHook) {
    // Run linting before tests
    const lintRan = await runLinting(rootDir)
    if (lintRan) {
      // Check if linting made changes and commit them
      const hasChanges = await hasUncommittedChanges(rootDir)
      if (hasChanges) {
        await commitLintingChanges(rootDir)
      }
    }

    // Run tests for Laravel projects
    if (isLaravel) {
      logProcessing('Running Laravel tests locally...')
      try {
        await runCommand('php', ['artisan', 'test', '--compact'], { cwd: rootDir })
        logSuccess('Local tests passed.')
      } catch (error) {
        throw new Error(`Local tests failed. Fix test failures before deploying. ${error.message}`)
      }
    }
  } else {
    logProcessing('Pre-push git hook detected. Skipping local linting and test execution.')
  }

  const ssh = createSshClient()
  const sshUser = config.sshUser || os.userInfo().username
  const privateKeyPath = await resolveSshKeyPath(config.sshKey)
  const privateKey = await fs.readFile(privateKeyPath, 'utf8')

  logProcessing(`\nConnecting to ${config.serverIp} as ${sshUser}...`)

  let lockAcquired = false

  try {
    await ssh.connect({
      host: config.serverIp,
      username: sshUser,
      privateKey
    })

    const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
    const remoteHome = remoteHomeResult.stdout.trim() || `/home/${sshUser}`
    const remoteCwd = resolveRemotePath(config.projectPath, remoteHome)

    logProcessing(`Connection established. Acquiring deployment lock on server...`)
    await acquireRemoteLock(ssh, remoteCwd, rootDir, { runPrompt, logWarning })
    lockAcquired = true
    logProcessing(`Lock acquired. Running deployment commands in ${remoteCwd}...`)

    const executeRemote = createRemoteExecutor({
      ssh,
      rootDir,
      remoteCwd,
      writeToLogFile,
      logProcessing,
      logSuccess,
      logError
    })

    const laravelCheck = await ssh.execCommand(
      'if [ -f artisan ] && [ -f composer.json ] && grep -q "laravel/framework" composer.json; then echo "yes"; else echo "no"; fi',
      { cwd: remoteCwd }
    )
    const isLaravel = laravelCheck.stdout.trim() === 'yes'

    if (isLaravel) {
      logSuccess('Laravel project detected.')
    } else {
      logWarning('Laravel project not detected; skipping Laravel-specific maintenance tasks.')
    }

    let changedFiles = []

    if (snapshot && snapshot.changedFiles) {
      changedFiles = snapshot.changedFiles
      logProcessing('Resuming deployment with saved task snapshot.')
    } else if (isLaravel) {
      await executeRemote(`Fetch latest changes for ${config.branch}`, `git fetch origin ${config.branch}`)

      const diffResult = await executeRemote(
        'Inspect pending changes',
        `git diff --name-only HEAD..origin/${config.branch}`,
        { printStdout: false }
      )

      changedFiles = diffResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      if (changedFiles.length > 0) {
        const preview = changedFiles
          .slice(0, 20)
          .map((file) => ` - ${file}`)
          .join('\n')

        logProcessing(
          `Detected ${changedFiles.length} changed file(s):\n${preview}${changedFiles.length > 20 ? '\n - ...' : ''
          }`
        )
      } else {
        logProcessing('No upstream file changes detected.')
      }
    }

    const hasPhpChanges = isLaravel && changedFiles.some((file) => file.endsWith('.php'))

    let horizonConfigured = false
    if (hasPhpChanges) {
      const horizonCheck = await ssh.execCommand(
        'if [ -f config/horizon.php ]; then echo "yes"; else echo "no"; fi',
        { cwd: remoteCwd }
      )
      horizonConfigured = horizonCheck.stdout.trim() === 'yes'
    }

    const steps = planLaravelDeploymentTasks({
      branch: config.branch,
      isLaravel,
      changedFiles,
      horizonConfigured
    })

    const usefulSteps = steps.length > 1

    let pendingSnapshot

    if (usefulSteps) {
      pendingSnapshot = snapshot ?? {
        serverName: config.serverName,
        branch: config.branch,
        projectPath: config.projectPath,
        sshUser: config.sshUser,
        createdAt: new Date().toISOString(),
        changedFiles,
        taskLabels: steps.map((step) => step.label)
      }

      await savePendingTasksSnapshot(rootDir, pendingSnapshot)

      const payload = Buffer.from(JSON.stringify(pendingSnapshot)).toString('base64')
      await executeRemote(
        'Record pending deployment tasks',
        `mkdir -p .zephyr && echo '${payload}' | base64 --decode > .zephyr/${PENDING_TASKS_FILE}`,
        { printStdout: false }
      )
    }

    if (steps.length === 1) {
      logProcessing('No additional maintenance tasks scheduled beyond git pull.')
    } else {
      const extraTasks = steps
        .slice(1)
        .map((step) => step.label)
        .join(', ')

      logProcessing(`Additional tasks scheduled: ${extraTasks}`)
    }

    let completed = false

    try {
      for (const step of steps) {
        await executeRemote(step.label, step.command)
      }

      completed = true
    } finally {
      if (usefulSteps && completed) {
        await executeRemote(
          'Clear pending deployment snapshot',
          `rm -f .zephyr/${PENDING_TASKS_FILE}`,
          { printStdout: false, allowFailure: true }
        )
        await clearPendingTasksSnapshot(rootDir)
      }
    }

    logSuccess('\nDeployment commands completed successfully.')

    const logPath = await getLogFilePath(rootDir)
    logSuccess(`\nAll task output has been logged to: ${logPath}`)
  } catch (error) {
    const logPath = await getLogFilePath(rootDir).catch(() => null)
    if (logPath) {
      logError(`\nTask output has been logged to: ${logPath}`)
    }

    // If lock was acquired but deployment failed, check for stale locks
    if (lockAcquired && ssh) {
      try {
        const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
        const remoteHome = remoteHomeResult.stdout.trim() || `/home/${sshUser}`
        const remoteCwd = resolveRemotePath(config.projectPath, remoteHome)
        await compareLocksAndPrompt(rootDir, ssh, remoteCwd, { runPrompt, logWarning })
      } catch (_lockError) {
        // Ignore lock comparison errors during error handling
      }
    }

    throw new Error(`Deployment failed: ${error.message}`)
  } finally {
    if (lockAcquired && ssh) {
      try {
        const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
        const remoteHome = remoteHomeResult.stdout.trim() || `/home/${sshUser}`
        const remoteCwd = resolveRemotePath(config.projectPath, remoteHome)
        await releaseRemoteLock(ssh, remoteCwd, { logWarning })
        await releaseLocalLock(rootDir, { logWarning })
      } catch (error) {
        logWarning(`Failed to release lock: ${error.message}`)
      }
    }
    await closeLogFile()
    if (ssh) {
      ssh.dispose()
    }
  }
}

async function promptServerDetails(existingServers = []) {
  return await promptServerDetailsImpl(existingServers, { runPrompt, generateId })
}

async function selectServer(servers) {
  return await selectServerImpl(servers, {
    runPrompt,
    logProcessing,
    logSuccess,
    saveServers,
    promptServerDetails
  })
}

async function promptAppDetails(currentDir, existing = {}) {
  return await promptAppDetailsImpl(currentDir, existing, {
    runPrompt,
    listGitBranches,
    defaultProjectPath,
    promptSshDetails
  })
}

async function selectApp(projectConfig, server, currentDir) {
  return await selectAppImpl(projectConfig, server, currentDir, {
    runPrompt,
    logWarning,
    logProcessing,
    logSuccess,
    saveProjectConfig,
    generateId,
    promptAppDetails
  })
}

async function selectPreset(projectConfig, servers) {
  return await selectPresetImpl(projectConfig, servers, { runPrompt })
}

async function main(releaseType = null) {
  // Best-effort update check (skip during tests or when explicitly disabled)
  // If an update is accepted, the process will re-execute via npx @latest and we should exit early.
  if (
    process.env.ZEPHYR_SKIP_VERSION_CHECK !== '1' &&
    process.env.NODE_ENV !== 'test' &&
    process.env.VITEST !== 'true'
  ) {
    try {
      const args = process.argv.slice(2)
      const reExecuted = await checkAndUpdateVersion(runPrompt, args)
      if (reExecuted) {
        return
      }
    } catch (_error) {
      // Never block execution due to update check issues
    }
  }

  // Handle node/vue package release
  if (releaseType === 'node' || releaseType === 'vue') {
    try {
      await releaseNode()
      return
    } catch (error) {
      logError('\nRelease failed:')
      logError(error.message)
      if (error.stack) {
        writeStderrLine(error.stack)
      }
      process.exit(1)
    }
  }

  // Handle packagist/composer package release
  if (releaseType === 'packagist') {
    try {
      await releasePackagist()
      return
    } catch (error) {
      logError('\nRelease failed:')
      logError(error.message)
      if (error.stack) {
        writeStderrLine(error.stack)
      }
      process.exit(1)
    }
  }

  // Default: Laravel deployment workflow
  const rootDir = process.cwd()

  await ensureGitignoreEntry(rootDir)
  await ensureProjectReleaseScript(rootDir)

  // Validate dependencies if package.json or composer.json exists
  const packageJsonPath = path.join(rootDir, 'package.json')
  const composerJsonPath = path.join(rootDir, 'composer.json')
  const hasPackageJson = await fs.access(packageJsonPath).then(() => true).catch(() => false)
  const hasComposerJson = await fs.access(composerJsonPath).then(() => true).catch(() => false)

  if (hasPackageJson || hasComposerJson) {
    logProcessing('Validating dependencies...')
    await validateLocalDependencies(rootDir, runPrompt, logSuccess)
  }

  // Load servers first (they may be migrated)
  const servers = await loadServers()
  // Load project config with servers for migration
  const projectConfig = await loadProjectConfig(rootDir, servers)

  let server = null
  let appConfig = null
  let isCreatingNewPreset = false

  const preset = await selectPreset(projectConfig, servers)

  if (preset === 'create') {
    // User explicitly chose to create a new preset
    isCreatingNewPreset = true
    server = await selectServer(servers)
    appConfig = await selectApp(projectConfig, server, rootDir)
  } else if (preset) {
    // User selected an existing preset - look up by appId
    if (preset.appId) {
      appConfig = projectConfig.apps?.find((a) => a.id === preset.appId)

      if (!appConfig) {
        logWarning(`Preset references app configuration that no longer exists. Creating new configuration.`)
        server = await selectServer(servers)
        appConfig = await selectApp(projectConfig, server, rootDir)
      } else {
        server = servers.find((s) => s.id === appConfig.serverId || s.serverName === appConfig.serverName)

        if (!server) {
          logWarning(`Preset references server that no longer exists. Creating new configuration.`)
          server = await selectServer(servers)
          appConfig = await selectApp(projectConfig, server, rootDir)
        } else if (preset.branch && appConfig.branch !== preset.branch) {
          // Update branch if preset has a different branch
          appConfig.branch = preset.branch
          await saveProjectConfig(rootDir, projectConfig)
          logSuccess(`Updated branch to ${preset.branch} from preset.`)
        }
      }
    } else if (preset.key) {
      // Legacy preset format - migrate it
      const keyParts = preset.key.split(':')
      const serverName = keyParts[0]
      const projectPath = keyParts[1]
      const presetBranch = preset.branch || (keyParts.length === 3 ? keyParts[2] : null)

      server = servers.find((s) => s.serverName === serverName)

      if (!server) {
        logWarning(`Preset references server "${serverName}" which no longer exists. Creating new configuration.`)
        server = await selectServer(servers)
        appConfig = await selectApp(projectConfig, server, rootDir)
      } else {
        appConfig = projectConfig.apps?.find(
          (a) => (a.serverId === server.id || a.serverName === serverName) && a.projectPath === projectPath
        )

        if (!appConfig) {
          logWarning(`Preset references app configuration that no longer exists. Creating new configuration.`)
          appConfig = await selectApp(projectConfig, server, rootDir)
        } else {
          // Migrate preset to use appId
          preset.appId = appConfig.id
          if (presetBranch && appConfig.branch !== presetBranch) {
            appConfig.branch = presetBranch
          }
          preset.branch = appConfig.branch
          await saveProjectConfig(rootDir, projectConfig)
        }
      }
    } else {
      logWarning(`Preset format is invalid. Creating new configuration.`)
      server = await selectServer(servers)
      appConfig = await selectApp(projectConfig, server, rootDir)
    }
  } else {
    // No presets exist, go through normal flow
    server = await selectServer(servers)
    appConfig = await selectApp(projectConfig, server, rootDir)
  }

  const updated = await ensureSshDetails(appConfig, rootDir)

  if (updated) {
    await saveProjectConfig(rootDir, projectConfig)
    logSuccess('Updated .zephyr/config.json with SSH details.')
  }

  const deploymentConfig = {
    serverName: server.serverName,
    serverIp: server.serverIp,
    projectPath: appConfig.projectPath,
    branch: appConfig.branch,
    sshUser: appConfig.sshUser,
    sshKey: appConfig.sshKey
  }

  logProcessing('\nSelected deployment target:')
  writeStdoutLine(JSON.stringify(deploymentConfig, null, 2))

  if (isCreatingNewPreset || !preset) {
    const { presetName } = await runPrompt([
      {
        type: 'input',
        name: 'presetName',
        message: 'Enter a name for this preset (leave blank to skip)',
        default: isCreatingNewPreset ? '' : undefined
      }
    ])

    const trimmedName = presetName?.trim()

    if (trimmedName && trimmedName.length > 0) {
      const presets = projectConfig.presets ?? []

      // Find app config to get its ID
      const appId = appConfig.id

      if (!appId) {
        logWarning('Cannot save preset: app configuration missing ID.')
      } else {
        // Check if preset with this appId already exists
        const existingIndex = presets.findIndex((p) => p.appId === appId)
        if (existingIndex >= 0) {
          presets[existingIndex].name = trimmedName
          presets[existingIndex].branch = deploymentConfig.branch
        } else {
          presets.push({
            name: trimmedName,
            appId: appId,
            branch: deploymentConfig.branch
          })
        }

        projectConfig.presets = presets
        await saveProjectConfig(rootDir, projectConfig)
        logSuccess(`Saved preset "${trimmedName}" to .zephyr/config.json`)
      }
    }
  }

  const existingSnapshot = await loadPendingTasksSnapshot(rootDir)
  let snapshotToUse = null

  if (existingSnapshot) {
    const matchesSelection =
      existingSnapshot.serverName === deploymentConfig.serverName &&
      existingSnapshot.branch === deploymentConfig.branch

    const messageLines = [
      'Pending deployment tasks were detected from a previous run.',
      `Server: ${existingSnapshot.serverName}`,
      `Branch: ${existingSnapshot.branch}`
    ]

    if (existingSnapshot.taskLabels && existingSnapshot.taskLabels.length > 0) {
      messageLines.push(`Tasks: ${existingSnapshot.taskLabels.join(', ')}`)
    }

    const { resumePendingTasks } = await runPrompt([
      {
        type: 'confirm',
        name: 'resumePendingTasks',
        message: `${messageLines.join(' | ')}. Resume using this plan?`,
        default: matchesSelection
      }
    ])

    if (resumePendingTasks) {
      snapshotToUse = existingSnapshot
      logProcessing('Resuming deployment using saved task snapshot...')
    } else {
      await clearPendingTasksSnapshot(rootDir)
      logWarning('Discarded pending deployment snapshot.')
    }
  }

  await runRemoteTasks(deploymentConfig, { rootDir, snapshot: snapshotToUse })
}

export {
  ensureGitignoreEntry,
  ensureProjectReleaseScript,
  listSshKeys,
  resolveRemotePath,
  isPrivateKeyFile,
  runRemoteTasks,
  promptServerDetails,
  selectServer,
  promptAppDetails,
  selectApp,
  promptSshDetails,
  ensureSshDetails,
  ensureLocalRepositoryState,
  loadServers,
  loadProjectConfig,
  saveProjectConfig,
  main,
  releaseNode,
  releasePackagist,
  createSshClient,
  resolveSshKeyPath,
  selectPreset,
  logProcessing,
  logSuccess,
  logWarning,
  logError,
  writeToLogFile,
  getLogFilePath,
  ensureDirectory,
  runCommand,
  runCommandCapture
}
