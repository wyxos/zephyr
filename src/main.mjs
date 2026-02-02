import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { NodeSSH } from 'node-ssh'
import { releaseNode } from './release-node.mjs'
import { releasePackagist } from './release-packagist.mjs'
import { validateLocalDependencies } from './dependency-scanner.mjs'
import { createChalkLogger, writeStderrLine, writeStdoutLine } from './utils/output.mjs'
import { runCommand as runCommandBase, runCommandCapture as runCommandCaptureBase, commandExists } from './utils/command.mjs'
import { planLaravelDeploymentTasks } from './utils/task-planner.mjs'
import { getPhpVersionRequirement, findPhpBinary } from './utils/php-version.mjs'
import {
  PENDING_TASKS_FILE,
  PROJECT_CONFIG_DIR
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
import * as bootstrap from './project/bootstrap.mjs'
import * as preflight from './deploy/preflight.mjs'
import * as sshKeys from './ssh/keys.mjs'
import * as localRepo from './deploy/local-repo.mjs'
import * as configFlow from './utils/config-flow.mjs'
import { createRemoteExecutor } from './deploy/remote-exec.mjs'
import { createRunPrompt } from './runtime/prompt.mjs'
import { createSshClientFactory } from './runtime/ssh-client.mjs'
import { createLocalCommandRunners } from './runtime/local-command.mjs'
import { generateId } from './utils/id.mjs'
import { loadServers, saveServers } from './config/servers.mjs'
import { loadProjectConfig, saveProjectConfig } from './config/project.mjs'
import { resolveRemotePath } from './utils/remote-path.mjs'

const RELEASE_SCRIPT_NAME = 'release'
const RELEASE_SCRIPT_COMMAND = 'npx @wyxos/zephyr@latest'

const { logProcessing, logSuccess, logWarning, logError } = createChalkLogger(chalk)

const runPrompt = createRunPrompt({ inquirer })
const createSshClient = createSshClientFactory({ NodeSSH })
const { runCommand, runCommandCapture } = createLocalCommandRunners({
  runCommandBase,
  runCommandCaptureBase
})

// Local repository state moved to src/deploy/local-repo.mjs

async function getGitStatus(rootDir) {
  return await localRepo.getGitStatus(rootDir, { runCommandCapture })
}

async function hasUncommittedChanges(rootDir) {
  return await localRepo.hasUncommittedChanges(rootDir, { getGitStatus })
}

async function ensureLocalRepositoryState(targetBranch, rootDir = process.cwd()) {
  return await localRepo.ensureLocalRepositoryState(targetBranch, rootDir, {
    runPrompt,
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess,
    logWarning
  })
}

async function ensureProjectReleaseScript(rootDir) {
  return await bootstrap.ensureProjectReleaseScript(rootDir, {
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
  return await bootstrap.ensureGitignoreEntry(rootDir, {
    projectConfigDir: PROJECT_CONFIG_DIR,
    runCommand,
    logSuccess,
    logWarning
  })
}

// Config storage/migrations moved to src/config/*

function defaultProjectPath(currentDir) {
  return configFlow.defaultProjectPath(currentDir)
}

async function listGitBranches(currentDir) {
  return await configFlow.listGitBranches(currentDir, { runCommandCapture, logWarning })
}

async function promptSshDetails(currentDir, existing = {}) {
  return await sshKeys.promptSshDetails(currentDir, existing, { runPrompt })
}

async function ensureSshDetails(config, currentDir) {
  return await sshKeys.ensureSshDetails(config, currentDir, { runPrompt, logProcessing })
}

async function resolveSshKeyPath(targetPath) {
  return await sshKeys.resolveSshKeyPath(targetPath)
}

// resolveRemotePath moved to src/utils/remote-path.mjs

async function runLinting(rootDir) {
  return await preflight.runLinting(rootDir, { runCommand, logProcessing, logSuccess, logWarning, commandExists })
}

async function commitLintingChanges(rootDir) {
  return await preflight.commitLintingChanges(rootDir, {
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

  // Detect PHP version requirement from local composer.json
  let requiredPhpVersion = null
  try {
    requiredPhpVersion = await getPhpVersionRequirement(rootDir)
  } catch {
    // Ignore - composer.json might not exist or be unreadable
  }

  const isLaravel = await preflight.isLocalLaravelProject(rootDir)
  const hasHook = await preflight.hasPrePushHook(rootDir)

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
      // Check if PHP is available before trying to run tests
      if (!commandExists('php')) {
        logWarning(
          'PHP is not available in PATH. Skipping local Laravel tests.\n' +
          '  To run tests locally, ensure PHP is installed and added to your PATH.\n' +
          '  On Windows with Laravel Herd, you may need to add Herd\'s PHP to your system PATH.'
        )
      } else {
        logProcessing('Running Laravel tests locally...')
        try {
          await runCommand('php', ['artisan', 'test', '--compact'], { cwd: rootDir })
          logSuccess('Local tests passed.')
        } catch (error) {
          // Provide clearer error message based on error type
          if (error.code === 'ENOENT') {
            throw new Error(
              'Failed to run Laravel tests: PHP executable not found.\n' +
              'Make sure PHP is installed and available in your PATH.'
            )
          }
          throw new Error(`Local tests failed. Fix test failures before deploying.\n${error.message}`)
        }
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

    // Find the appropriate PHP binary based on local composer.json requirement
    let phpCommand = 'php'
    if (requiredPhpVersion) {
      try {
        phpCommand = await findPhpBinary(ssh, remoteCwd, requiredPhpVersion)
        
        if (phpCommand !== 'php') {
          logProcessing(`Detected PHP requirement: ${requiredPhpVersion}, using ${phpCommand}`)
        }
      } catch (error) {
        // If we can't find the PHP binary, fall back to default 'php'
        logWarning(`Could not find PHP binary for version ${requiredPhpVersion}: ${error.message}`)
      }
    }

    const steps = planLaravelDeploymentTasks({
      branch: config.branch,
      isLaravel,
      changedFiles,
      horizonConfigured,
      phpCommand
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
  return await configFlow.promptServerDetails(existingServers, { runPrompt, generateId })
}

async function selectServer(servers) {
  return await configFlow.selectServer(servers, {
    runPrompt,
    logProcessing,
    logSuccess,
    saveServers,
    promptServerDetails
  })
}

async function promptAppDetails(currentDir, existing = {}) {
  return await configFlow.promptAppDetails(currentDir, existing, {
    runPrompt,
    listGitBranches,
    defaultProjectPath,
    promptSshDetails
  })
}

async function selectApp(projectConfig, server, currentDir) {
  return await configFlow.selectApp(projectConfig, server, currentDir, {
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
  return await configFlow.selectPreset(projectConfig, servers, { runPrompt })
}

async function main(releaseType = null) {
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
  const servers = await loadServers({ logSuccess, logWarning })
  // Load project config with servers for migration
  const projectConfig = await loadProjectConfig(rootDir, servers, { logSuccess, logWarning })

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

export { main, runRemoteTasks }
