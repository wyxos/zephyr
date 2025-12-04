import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'
import process from 'node:process'
import crypto from 'node:crypto'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { NodeSSH } from 'node-ssh'
import { releaseNode } from './release-node.mjs'
import { releasePackagist } from './release-packagist.mjs'

const IS_WINDOWS = process.platform === 'win32'

const PROJECT_CONFIG_DIR = '.zephyr'
const PROJECT_CONFIG_FILE = 'config.json'
const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.config', 'zephyr')
const SERVERS_FILE = path.join(GLOBAL_CONFIG_DIR, 'servers.json')
const PROJECT_LOCK_FILE = 'deploy.lock'
const PENDING_TASKS_FILE = 'pending-tasks.json'
const RELEASE_SCRIPT_NAME = 'release'
const RELEASE_SCRIPT_COMMAND = 'npx @wyxos/zephyr@latest'

const logProcessing = (message = '') => console.log(chalk.yellow(message))
const logSuccess = (message = '') => console.log(chalk.green(message))
const logWarning = (message = '') => console.warn(chalk.yellow(message))
const logError = (message = '') => console.error(chalk.red(message))

let logFilePath = null

async function getLogFilePath(rootDir) {
  if (logFilePath) {
    return logFilePath
  }

  const configDir = getProjectConfigDir(rootDir)
  await ensureDirectory(configDir)

  const now = new Date()
  const dateStr = now.toISOString().replace(/:/g, '-').replace(/\..+/, '')
  logFilePath = path.join(configDir, `${dateStr}.log`)

  return logFilePath
}

async function writeToLogFile(rootDir, message) {
  const logPath = await getLogFilePath(rootDir)
  const timestamp = new Date().toISOString()
  await fs.appendFile(logPath, `${timestamp} - ${message}\n`)
}

async function closeLogFile() {
  logFilePath = null
}

async function cleanupOldLogs(rootDir) {
  const configDir = getProjectConfigDir(rootDir)

  try {
    const files = await fs.readdir(configDir)
    const logFiles = files
      .filter((file) => file.endsWith('.log'))
      .map((file) => ({
        name: file,
        path: path.join(configDir, file)
      }))

    if (logFiles.length <= 3) {
      return
    }

    // Get file stats and sort by modification time (newest first)
    const filesWithStats = await Promise.all(
      logFiles.map(async (file) => {
        const stats = await fs.stat(file.path)
        return {
          ...file,
          mtime: stats.mtime
        }
      })
    )

    filesWithStats.sort((a, b) => b.mtime - a.mtime)

    // Keep the 3 newest, delete the rest
    const filesToDelete = filesWithStats.slice(3)

    for (const file of filesToDelete) {
      try {
        await fs.unlink(file.path)
      } catch (error) {
        // Ignore errors when deleting old logs
      }
    }
  } catch (error) {
    // Ignore errors during log cleanup
    if (error.code !== 'ENOENT') {
      // Only log if it's not a "directory doesn't exist" error
    }
  }
}

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
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      stdio: silent ? 'ignore' : 'inherit',
      cwd
    }

    // On Windows, use shell for commands that might need PATH resolution (php, composer, etc.)
    // Git commands work fine without shell
    if (IS_WINDOWS && command !== 'git') {
      spawnOptions.shell = true
    }

    const child = spawn(command, args, spawnOptions)

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        const error = new Error(`${command} exited with code ${code}`)
        error.exitCode = code
        reject(error)
      }
    })
  })
}

async function runCommandCapture(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const spawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd
    }

    // On Windows, use shell for commands that might need PATH resolution (php, composer, etc.)
    // Git commands work fine without shell
    if (IS_WINDOWS && command !== 'git') {
      spawnOptions.shell = true
    }

    const child = spawn(command, args, spawnOptions)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        const error = new Error(`${command} exited with code ${code}: ${stderr.trim()}`)
        error.exitCode = code
        reject(error)
      }
    })
  })
}

async function getCurrentBranch(rootDir) {
  const output = await runCommandCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: rootDir
  })

  return output.trim()
}

async function getGitStatus(rootDir) {
  const output = await runCommandCapture('git', ['status', '--porcelain'], {
    cwd: rootDir
  })

  return output.trim()
}

function hasStagedChanges(statusOutput) {
  if (!statusOutput || statusOutput.length === 0) {
    return false
  }

  const lines = statusOutput.split('\n').filter((line) => line.trim().length > 0)

  return lines.some((line) => {
    const firstChar = line[0]
    // In git status --porcelain format:
    // - First char is space: unstaged changes (e.g., " M file")
    // - First char is '?': untracked files (e.g., "?? file")
    // - First char is letter (M, A, D, etc.): staged changes (e.g., "M  file")
    // Only return true for staged changes, not unstaged or untracked
    return firstChar && firstChar !== ' ' && firstChar !== '?'
  })
}

async function getUpstreamRef(rootDir) {
  try {
    const output = await runCommandCapture('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: rootDir
    })

    const ref = output.trim()
    return ref.length > 0 ? ref : null
  } catch {
    return null
  }
}

async function ensureCommittedChangesPushed(targetBranch, rootDir) {
  const upstreamRef = await getUpstreamRef(rootDir)

  if (!upstreamRef) {
    logWarning(`Branch ${targetBranch} does not track a remote upstream; skipping automatic push of committed changes.`)
    return { pushed: false, upstreamRef: null }
  }

  const [remoteName, ...upstreamParts] = upstreamRef.split('/')
  const upstreamBranch = upstreamParts.join('/')

  if (!remoteName || !upstreamBranch) {
    logWarning(`Unable to determine remote destination for ${targetBranch}. Skipping automatic push.`)
    return { pushed: false, upstreamRef }
  }

  try {
    await runCommand('git', ['fetch', remoteName], { cwd: rootDir, silent: true })
  } catch (error) {
    logWarning(`Unable to fetch from ${remoteName} before push: ${error.message}`)
  }

  let remoteExists = true

  try {
    await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${upstreamRef}`], {
      cwd: rootDir,
      silent: true
    })
  } catch {
    remoteExists = false
  }

  let aheadCount = 0
  let behindCount = 0

  if (remoteExists) {
    const aheadOutput = await runCommandCapture('git', ['rev-list', '--count', `${upstreamRef}..HEAD`], {
      cwd: rootDir
    })

    aheadCount = parseInt(aheadOutput.trim() || '0', 10)

    const behindOutput = await runCommandCapture('git', ['rev-list', '--count', `HEAD..${upstreamRef}`], {
      cwd: rootDir
    })

    behindCount = parseInt(behindOutput.trim() || '0', 10)
  } else {
    aheadCount = 1
  }

  if (Number.isFinite(behindCount) && behindCount > 0) {
    throw new Error(
      `Local branch ${targetBranch} is behind ${upstreamRef} by ${behindCount} commit${behindCount === 1 ? '' : 's'}. Pull or rebase before deployment.`
    )
  }

  if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
    return { pushed: false, upstreamRef }
  }

  const commitLabel = aheadCount === 1 ? 'commit' : 'commits'
  logProcessing(`Found ${aheadCount} ${commitLabel} not yet pushed to ${upstreamRef}. Pushing before deployment...`)

  await runCommand('git', ['push', remoteName, `${targetBranch}:${upstreamBranch}`], { cwd: rootDir })
  logSuccess(`Pushed committed changes to ${upstreamRef}.`)

  return { pushed: true, upstreamRef }
}

async function ensureLocalRepositoryState(targetBranch, rootDir = process.cwd()) {
  if (!targetBranch) {
    throw new Error('Deployment branch is not defined in the release configuration.')
  }

  const currentBranch = await getCurrentBranch(rootDir)

  if (!currentBranch) {
    throw new Error('Unable to determine the current git branch. Ensure this is a git repository.')
  }

  const initialStatus = await getGitStatus(rootDir)
  const hasPendingChanges = initialStatus.length > 0

  const statusReport = await runCommandCapture('git', ['status', '--short', '--branch'], {
    cwd: rootDir
  })

  const lines = statusReport.split(/\r?\n/)
  const branchLine = lines[0] || ''
  const aheadMatch = branchLine.match(/ahead (\d+)/)
  const behindMatch = branchLine.match(/behind (\d+)/)
  const aheadCount = aheadMatch ? parseInt(aheadMatch[1], 10) : 0
  const behindCount = behindMatch ? parseInt(behindMatch[1], 10) : 0

  if (aheadCount > 0) {
    logWarning(`Local branch ${currentBranch} is ahead of upstream by ${aheadCount} commit${aheadCount === 1 ? '' : 's'}.`)
  }

  if (behindCount > 0) {
    logProcessing(`Synchronizing local branch ${currentBranch} with its upstream...`)
    try {
      await runCommand('git', ['pull', '--ff-only'], { cwd: rootDir })
      logSuccess('Local branch fast-forwarded with upstream changes.')
    } catch (error) {
      throw new Error(
        `Unable to fast-forward ${currentBranch} with upstream changes. Resolve conflicts manually, then rerun the deployment.\n${error.message}`
      )
    }
  }

  if (currentBranch !== targetBranch) {
    if (hasPendingChanges) {
      throw new Error(
        `Local repository has uncommitted changes on ${currentBranch}. Commit or stash them before switching to ${targetBranch}.`
      )
    }

    logProcessing(`Switching local repository from ${currentBranch} to ${targetBranch}...`)
    await runCommand('git', ['checkout', targetBranch], { cwd: rootDir })
    logSuccess(`Checked out ${targetBranch} locally.`)
  }

  const statusAfterCheckout = currentBranch === targetBranch ? initialStatus : await getGitStatus(rootDir)

  if (statusAfterCheckout.length === 0) {
    await ensureCommittedChangesPushed(targetBranch, rootDir)
    logProcessing('Local repository is clean. Proceeding with deployment.')
    return
  }

  if (!hasStagedChanges(statusAfterCheckout)) {
    await ensureCommittedChangesPushed(targetBranch, rootDir)
    logProcessing('No staged changes detected. Unstaged or untracked files will not affect deployment. Proceeding with deployment.')
    return
  }

  logWarning(`Staged changes detected on ${targetBranch}. A commit is required before deployment.`)

  const { commitMessage } = await runPrompt([
    {
      type: 'input',
      name: 'commitMessage',
      message: 'Enter a commit message for pending changes before deployment',
      validate: (value) => (value && value.trim().length > 0 ? true : 'Commit message cannot be empty.')
    }
  ])

  const message = commitMessage.trim()

  logProcessing('Committing staged changes before deployment...')
  await runCommand('git', ['commit', '-m', message], { cwd: rootDir })
  await runCommand('git', ['push', 'origin', targetBranch], { cwd: rootDir })
  logSuccess(`Committed and pushed changes to origin/${targetBranch}.`)

  const finalStatus = await getGitStatus(rootDir)

  if (finalStatus.length > 0) {
    throw new Error('Local repository still has uncommitted changes after commit. Aborting deployment.')
  }

  await ensureCommittedChangesPushed(targetBranch, rootDir)
  logProcessing('Local repository is clean after committing pending changes.')
}

async function ensureProjectReleaseScript(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json')

  let raw
  try {
    raw = await fs.readFile(packageJsonPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }

    throw error
  }

  let packageJson
  try {
    packageJson = JSON.parse(raw)
  } catch (error) {
    logWarning('Unable to parse package.json; skipping release script injection.')
    return false
  }

  const currentCommand = packageJson?.scripts?.[RELEASE_SCRIPT_NAME]

  if (currentCommand && currentCommand.includes('@wyxos/zephyr')) {
    return false
  }

  const { installReleaseScript } = await runPrompt([
    {
      type: 'confirm',
      name: 'installReleaseScript',
      message: 'Add "release" script to package.json that runs "npx @wyxos/zephyr@latest"?',
      default: true
    }
  ])

  if (!installReleaseScript) {
    return false
  }

  if (!packageJson.scripts || typeof packageJson.scripts !== 'object') {
    packageJson.scripts = {}
  }

  packageJson.scripts[RELEASE_SCRIPT_NAME] = RELEASE_SCRIPT_COMMAND

  const updatedPayload = `${JSON.stringify(packageJson, null, 2)}\n`
  await fs.writeFile(packageJsonPath, updatedPayload)
  logSuccess('Added release script to package.json.')

  let isGitRepo = false

  try {
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootDir, silent: true })
    isGitRepo = true
  } catch (error) {
    logWarning('Not a git repository; skipping commit for release script addition.')
  }

  if (isGitRepo) {
    try {
      await runCommand('git', ['add', 'package.json'], { cwd: rootDir, silent: true })
      await runCommand('git', ['commit', '-m', 'chore: add zephyr release script'], { cwd: rootDir, silent: true })
      logSuccess('Committed package.json release script addition.')
    } catch (error) {
      if (error.exitCode === 1) {
        logWarning('Git commit skipped: nothing to commit or pre-commit hook prevented commit.')
      } else {
        throw error
      }
    }
  }

  return true
}

function getProjectConfigDir(rootDir) {
  return path.join(rootDir, PROJECT_CONFIG_DIR)
}

function getPendingTasksPath(rootDir) {
  return path.join(getProjectConfigDir(rootDir), PENDING_TASKS_FILE)
}

function getLockFilePath(rootDir) {
  return path.join(getProjectConfigDir(rootDir), PROJECT_LOCK_FILE)
}

function createLockPayload() {
  return {
    user: os.userInfo().username,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString()
  }
}

async function acquireLocalLock(rootDir) {
  const lockPath = getLockFilePath(rootDir)
  const configDir = getProjectConfigDir(rootDir)
  await ensureDirectory(configDir)

  const payload = createLockPayload()
  const payloadJson = JSON.stringify(payload, null, 2)
  await fs.writeFile(lockPath, payloadJson, 'utf8')

  return payload
}

async function releaseLocalLock(rootDir) {
  const lockPath = getLockFilePath(rootDir)
  try {
    await fs.unlink(lockPath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logWarning(`Failed to remove local lock file: ${error.message}`)
    }
  }
}

async function readLocalLock(rootDir) {
  const lockPath = getLockFilePath(rootDir)
  try {
    const content = await fs.readFile(lockPath, 'utf8')
    return JSON.parse(content)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function readRemoteLock(ssh, remoteCwd) {
  const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
  const escapedLockPath = lockPath.replace(/'/g, "'\\''")
  const checkCommand = `mkdir -p .zephyr && if [ -f '${escapedLockPath}' ]; then cat '${escapedLockPath}'; else echo "LOCK_NOT_FOUND"; fi`

  const checkResult = await ssh.execCommand(checkCommand, { cwd: remoteCwd })

  if (checkResult.stdout && checkResult.stdout.trim() !== 'LOCK_NOT_FOUND' && checkResult.stdout.trim() !== '') {
    try {
      return JSON.parse(checkResult.stdout.trim())
    } catch (error) {
      return { raw: checkResult.stdout.trim() }
    }
  }

  return null
}

async function compareLocksAndPrompt(rootDir, ssh, remoteCwd) {
  const localLock = await readLocalLock(rootDir)
  const remoteLock = await readRemoteLock(ssh, remoteCwd)

  if (!localLock || !remoteLock) {
    return false
  }

  // Compare lock contents - if they match, it's likely stale
  const localKey = `${localLock.user}@${localLock.hostname}:${localLock.pid}:${localLock.startedAt}`
  const remoteKey = `${remoteLock.user}@${remoteLock.hostname}:${remoteLock.pid}:${remoteLock.startedAt}`

  if (localKey === remoteKey) {
    const startedBy = remoteLock.user ? `${remoteLock.user}@${remoteLock.hostname ?? 'unknown'}` : 'unknown user'
    const startedAt = remoteLock.startedAt ? ` at ${remoteLock.startedAt}` : ''
    const { shouldRemove } = await runPrompt([
      {
        type: 'confirm',
        name: 'shouldRemove',
        message: `Stale lock detected on server (started by ${startedBy}${startedAt}). This appears to be from a failed deployment. Remove it?`,
        default: true
      }
    ])

    if (shouldRemove) {
      const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
      const escapedLockPath = lockPath.replace(/'/g, "'\\''")
      const removeCommand = `rm -f '${escapedLockPath}'`
      await ssh.execCommand(removeCommand, { cwd: remoteCwd })
      await releaseLocalLock(rootDir)
      return true
    }
  }

  return false
}

async function acquireRemoteLock(ssh, remoteCwd, rootDir) {
  const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
  const escapedLockPath = lockPath.replace(/'/g, "'\\''")
  const checkCommand = `mkdir -p .zephyr && if [ -f '${escapedLockPath}' ]; then cat '${escapedLockPath}'; else echo "LOCK_NOT_FOUND"; fi`

  const checkResult = await ssh.execCommand(checkCommand, { cwd: remoteCwd })

  if (checkResult.stdout && checkResult.stdout.trim() !== 'LOCK_NOT_FOUND' && checkResult.stdout.trim() !== '') {
    // Check if we have a local lock and compare
    const localLock = await readLocalLock(rootDir)
    if (localLock) {
      const removed = await compareLocksAndPrompt(rootDir, ssh, remoteCwd)
      if (removed) {
        // Lock was removed, continue to create new one
      } else {
        // User chose not to remove, throw error
        let details = {}
        try {
          details = JSON.parse(checkResult.stdout.trim())
        } catch (error) {
          details = { raw: checkResult.stdout.trim() }
        }

        const startedBy = details.user ? `${details.user}@${details.hostname ?? 'unknown'}` : 'unknown user'
        const startedAt = details.startedAt ? ` at ${details.startedAt}` : ''
        throw new Error(
          `Another deployment is currently in progress on the server (started by ${startedBy}${startedAt}). Remove ${remoteCwd}/${lockPath} if you are sure it is stale.`
        )
      }
    } else {
      // No local lock, but remote lock exists
      let details = {}
      try {
        details = JSON.parse(checkResult.stdout.trim())
      } catch (error) {
        details = { raw: checkResult.stdout.trim() }
      }

      const startedBy = details.user ? `${details.user}@${details.hostname ?? 'unknown'}` : 'unknown user'
      const startedAt = details.startedAt ? ` at ${details.startedAt}` : ''
      throw new Error(
        `Another deployment is currently in progress on the server (started by ${startedBy}${startedAt}). Remove ${remoteCwd}/${lockPath} if you are sure it is stale.`
      )
    }
  }

  const payload = createLockPayload()
  const payloadJson = JSON.stringify(payload, null, 2)
  const payloadBase64 = Buffer.from(payloadJson).toString('base64')
  const createCommand = `mkdir -p .zephyr && echo '${payloadBase64}' | base64 --decode > '${escapedLockPath}'`

  const createResult = await ssh.execCommand(createCommand, { cwd: remoteCwd })

  if (createResult.code !== 0) {
    throw new Error(`Failed to create lock file on server: ${createResult.stderr}`)
  }

  // Create local lock as well
  await acquireLocalLock(rootDir)

  return lockPath
}

async function releaseRemoteLock(ssh, remoteCwd) {
  const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
  const escapedLockPath = lockPath.replace(/'/g, "'\\''")
  const removeCommand = `rm -f '${escapedLockPath}'`

  const result = await ssh.execCommand(removeCommand, { cwd: remoteCwd })
  if (result.code !== 0 && result.code !== 1) {
    logWarning(`Failed to remove lock file: ${result.stderr}`)
  }
}

async function loadPendingTasksSnapshot(rootDir) {
  const snapshotPath = getPendingTasksPath(rootDir)

  try {
    const raw = await fs.readFile(snapshotPath, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

async function savePendingTasksSnapshot(rootDir, snapshot) {
  const configDir = getProjectConfigDir(rootDir)
  await ensureDirectory(configDir)
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`
  await fs.writeFile(getPendingTasksPath(rootDir), payload)
}

async function clearPendingTasksSnapshot(rootDir) {
  try {
    await fs.unlink(getPendingTasksPath(rootDir))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
}

async function ensureGitignoreEntry(rootDir) {
  const gitignorePath = path.join(rootDir, '.gitignore')
  const targetEntry = `${PROJECT_CONFIG_DIR}/`
  let existingContent = ''

  try {
    existingContent = await fs.readFile(gitignorePath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }

  const hasEntry = existingContent
    .split(/\r?\n/)
    .some((line) => line.trim() === targetEntry)

  if (hasEntry) {
    return
  }

  const updatedContent = existingContent
    ? `${existingContent.replace(/\s*$/, '')}\n${targetEntry}\n`
    : `${targetEntry}\n`

  await fs.writeFile(gitignorePath, updatedContent)
  logSuccess('Added .zephyr/ to .gitignore')

  let isGitRepo = false
  try {
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], {
      silent: true,
      cwd: rootDir
    })
    isGitRepo = true
  } catch (error) {
    logWarning('Not a git repository; skipping commit for .gitignore update.')
  }

  if (!isGitRepo) {
    return
  }

  try {
    await runCommand('git', ['add', '.gitignore'], { cwd: rootDir })
    await runCommand('git', ['commit', '-m', 'chore: ignore zephyr config'], { cwd: rootDir })
  } catch (error) {
    if (error.exitCode === 1) {
      logWarning('Git commit skipped: nothing to commit or pre-commit hook prevented commit.')
    } else {
      throw error
    }
  }
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
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

function getProjectConfigPath(rootDir) {
  return path.join(rootDir, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE)
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
  return `~/webapps/${path.basename(currentDir)}`
}

async function listGitBranches(currentDir) {
  try {
    const output = await runCommandCapture(
      'git',
      ['branch', '--format', '%(refname:short)'],
      { cwd: currentDir }
    )

    const branches = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    return branches.length ? branches : ['master']
  } catch (error) {
    logWarning('Unable to read git branches; defaulting to master.')
    return ['master']
  }
}

async function listSshKeys() {
  const sshDir = path.join(os.homedir(), '.ssh')

  try {
    const entries = await fs.readdir(sshDir, { withFileTypes: true })

    const candidates = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        if (!name) return false
        if (name.startsWith('.')) return false
        if (name.endsWith('.pub')) return false
        if (name.startsWith('known_hosts')) return false
        if (name === 'config') return false
        return name.trim().length > 0
      })

    const keys = []

    for (const name of candidates) {
      const filePath = path.join(sshDir, name)
      if (await isPrivateKeyFile(filePath)) {
        keys.push(name)
      }
    }

    return {
      sshDir,
      keys
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        sshDir,
        keys: []
      }
    }

    throw error
  }
}

async function isPrivateKeyFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)
  } catch (error) {
    return false
  }
}

async function promptSshDetails(currentDir, existing = {}) {
  const { sshDir, keys: sshKeys } = await listSshKeys()
  const defaultUser = existing.sshUser || os.userInfo().username
  const fallbackKey = path.join(sshDir, 'id_rsa')
  const preselectedKey = existing.sshKey || (sshKeys.length ? path.join(sshDir, sshKeys[0]) : fallbackKey)

  const sshKeyPrompt = sshKeys.length
    ? {
      type: 'list',
      name: 'sshKeySelection',
      message: 'SSH key',
      choices: [
        ...sshKeys.map((key) => ({ name: key, value: path.join(sshDir, key) })),
        new inquirer.Separator(),
        { name: 'Enter custom SSH key path…', value: '__custom' }
      ],
      default: preselectedKey
    }
    : {
      type: 'input',
      name: 'sshKeySelection',
      message: 'SSH key path',
      default: preselectedKey
    }

  const answers = await runPrompt([
    {
      type: 'input',
      name: 'sshUser',
      message: 'SSH user',
      default: defaultUser
    },
    sshKeyPrompt
  ])

  let sshKey = answers.sshKeySelection

  if (sshKey === '__custom') {
    const { customSshKey } = await runPrompt([
      {
        type: 'input',
        name: 'customSshKey',
        message: 'SSH key path',
        default: preselectedKey
      }
    ])

    sshKey = customSshKey.trim() || preselectedKey
  }

  return {
    sshUser: answers.sshUser.trim() || defaultUser,
    sshKey: sshKey.trim() || preselectedKey
  }
}

async function ensureSshDetails(config, currentDir) {
  if (config.sshUser && config.sshKey) {
    return false
  }

  logProcessing('SSH details missing. Please provide them now.')
  const details = await promptSshDetails(currentDir, config)
  Object.assign(config, details)
  return true
}

function expandHomePath(targetPath) {
  if (!targetPath) {
    return targetPath
  }

  if (targetPath.startsWith('~')) {
    return path.join(os.homedir(), targetPath.slice(1))
  }

  return targetPath
}

async function resolveSshKeyPath(targetPath) {
  const expanded = expandHomePath(targetPath)

  try {
    await fs.access(expanded)
  } catch (error) {
    throw new Error(`SSH key not accessible at ${expanded}`)
  }

  return expanded
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

async function hasPrePushHook(rootDir) {
  const hookPaths = [
    path.join(rootDir, '.git', 'hooks', 'pre-push'),
    path.join(rootDir, '.husky', 'pre-push'),
    path.join(rootDir, '.githooks', 'pre-push')
  ]

  for (const hookPath of hookPaths) {
    try {
      await fs.access(hookPath)
      const stats = await fs.stat(hookPath)
      if (stats.isFile()) {
        return true
      }
    } catch {
      // Hook doesn't exist at this path, continue checking
    }
  }

  return false
}

async function hasLintScript(rootDir) {
  try {
    const packageJsonPath = path.join(rootDir, 'package.json')
    const raw = await fs.readFile(packageJsonPath, 'utf8')
    const packageJson = JSON.parse(raw)
    return packageJson.scripts && typeof packageJson.scripts.lint === 'string'
  } catch {
    return false
  }
}

async function hasLaravelPint(rootDir) {
  try {
    const pintPath = path.join(rootDir, 'vendor', 'bin', 'pint')
    await fs.access(pintPath)
    const stats = await fs.stat(pintPath)
    return stats.isFile()
  } catch {
    return false
  }
}

async function runLinting(rootDir) {
  const hasNpmLint = await hasLintScript(rootDir)
  const hasPint = await hasLaravelPint(rootDir)

  if (hasNpmLint) {
    logProcessing('Running npm lint...')
    await runCommand('npm', ['run', 'lint'], { cwd: rootDir })
    logSuccess('Linting completed.')
    return true
  } else if (hasPint) {
    logProcessing('Running Laravel Pint...')
    await runCommand('php', ['vendor/bin/pint'], { cwd: rootDir })
    logSuccess('Linting completed.')
    return true
  }

  return false
}

async function hasUncommittedChanges(rootDir) {
  const status = await getGitStatus(rootDir)
  return status.length > 0
}

async function commitLintingChanges(rootDir) {
  const status = await getGitStatus(rootDir)

  if (!hasStagedChanges(status)) {
    // Stage only modified tracked files (not untracked files)
    await runCommand('git', ['add', '-u'], { cwd: rootDir })
    const newStatus = await getGitStatus(rootDir)
    if (!hasStagedChanges(newStatus)) {
      return false
    }
  }

  logProcessing('Committing linting changes...')
  await runCommand('git', ['commit', '-m', 'style: apply linting fixes'], { cwd: rootDir })
  logSuccess('Linting changes committed.')
  return true
}

async function isLocalLaravelProject(rootDir) {
  try {
    const artisanPath = path.join(rootDir, 'artisan')
    const composerPath = path.join(rootDir, 'composer.json')

    await fs.access(artisanPath)
    const composerContent = await fs.readFile(composerPath, 'utf8')
    const composerJson = JSON.parse(composerContent)

    return (
      composerJson.require &&
      typeof composerJson.require === 'object' &&
      'laravel/framework' in composerJson.require
    )
  } catch {
    return false
  }
}

async function runRemoteTasks(config, options = {}) {
  const { snapshot = null, rootDir = process.cwd() } = options

  await cleanupOldLogs(rootDir)
  await ensureLocalRepositoryState(config.branch, rootDir)

  const isLaravel = await isLocalLaravelProject(rootDir)
  const hasHook = await hasPrePushHook(rootDir)

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
        await runCommand('php', ['artisan', 'test'], { cwd: rootDir })
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
    await acquireRemoteLock(ssh, remoteCwd, rootDir)
    lockAcquired = true
    logProcessing(`Lock acquired. Running deployment commands in ${remoteCwd}...`)

    // Robust environment bootstrap that works even when profile files don't export PATH
    // for non-interactive shells. This handles:
    // 1. Sourcing profile files (may not export PATH for non-interactive shells)
    // 2. Loading nvm if available (common Node.js installation method)
    // 3. Finding and adding common Node.js/npm installation paths
    const profileBootstrap = [
      // Source profile files (may set PATH, but often skip for non-interactive shells)
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
      'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"; fi',
      'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
      'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile"; fi',
      'if [ -f "$HOME/.zshrc" ]; then . "$HOME/.zshrc"; fi',
      // Load nvm if available (common Node.js installation method)
      'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi',
      'if [ -s "$HOME/.config/nvm/nvm.sh" ]; then . "$HOME/.config/nvm/nvm.sh"; fi',
      'if [ -s "/usr/local/opt/nvm/nvm.sh" ]; then . "/usr/local/opt/nvm/nvm.sh"; fi',
      // Try to find npm/node in common locations and add to PATH
      'if command -v npm >/dev/null 2>&1; then :',
      'elif [ -d "$HOME/.nvm/versions/node" ]; then NODE_VERSION=$(ls -1 "$HOME/.nvm/versions/node" | tail -1) && export PATH="$HOME/.nvm/versions/node/$NODE_VERSION/bin:$PATH"',
      'elif [ -d "/usr/local/lib/node_modules/npm/bin" ]; then export PATH="/usr/local/lib/node_modules/npm/bin:$PATH"',
      'elif [ -d "/opt/homebrew/bin" ] && [ -f "/opt/homebrew/bin/npm" ]; then export PATH="/opt/homebrew/bin:$PATH"',
      'elif [ -d "/usr/local/bin" ] && [ -f "/usr/local/bin/npm" ]; then export PATH="/usr/local/bin:$PATH"',
      'elif [ -d "$HOME/.local/bin" ] && [ -f "$HOME/.local/bin/npm" ]; then export PATH="$HOME/.local/bin:$PATH"',
      'fi'
    ].join('; ')

    const escapeForDoubleQuotes = (value) => value.replace(/(["\\$`])/g, '\\$1')

    const executeRemote = async (label, command, options = {}) => {
      const { cwd = remoteCwd, allowFailure = false, printStdout = true, bootstrapEnv = true } = options
      logProcessing(`\n→ ${label}`)

      let wrappedCommand = command
      let execOptions = { cwd }

      if (bootstrapEnv) {
        const cwdForShell = escapeForDoubleQuotes(cwd)
        wrappedCommand = `${profileBootstrap}; cd "${cwdForShell}" && ${command}`
        execOptions = {}
      }

      const result = await ssh.execCommand(wrappedCommand, execOptions)

      // Log all output to file
      if (result.stdout && result.stdout.trim()) {
        await writeToLogFile(rootDir, `[${label}] STDOUT:\n${result.stdout.trim()}`)
      }

      if (result.stderr && result.stderr.trim()) {
        await writeToLogFile(rootDir, `[${label}] STDERR:\n${result.stderr.trim()}`)
      }

      // Only show errors in terminal
      if (result.code !== 0) {
        if (result.stdout && result.stdout.trim()) {
          logError(`\n[${label}] Output:\n${result.stdout.trim()}`)
        }

        if (result.stderr && result.stderr.trim()) {
          logError(`\n[${label}] Error:\n${result.stderr.trim()}`)
        }
      }

      if (result.code !== 0 && !allowFailure) {
        const stderr = result.stderr?.trim() ?? ''
        if (/command not found/.test(stderr) || /is not recognized/.test(stderr)) {
          throw new Error(
            `Command failed: ${command}. Ensure the remote environment loads required tools for non-interactive shells (e.g. export PATH in profile scripts).`
          )
        }

        throw new Error(`Command failed: ${command}`)
      }

      // Show success confirmation with command
      if (result.code === 0) {
        logSuccess(`✓ ${command}`)
      }

      return result
    }

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

    const shouldRunComposer =
      isLaravel &&
      changedFiles.some(
        (file) =>
          file === 'composer.json' ||
          file === 'composer.lock' ||
          file.endsWith('/composer.json') ||
          file.endsWith('/composer.lock')
      )

    const shouldRunMigrations =
      isLaravel &&
      changedFiles.some(
        (file) => file.startsWith('database/migrations/') && file.endsWith('.php')
      )

    const hasPhpChanges = isLaravel && changedFiles.some((file) => file.endsWith('.php'))

    const shouldRunNpmInstall =
      isLaravel &&
      changedFiles.some(
        (file) =>
          file === 'package.json' ||
          file === 'package-lock.json' ||
          file.endsWith('/package.json') ||
          file.endsWith('/package-lock.json')
      )

    const hasFrontendChanges =
      isLaravel &&
      changedFiles.some((file) =>
        ['.vue', '.css', '.scss', '.js', '.ts', '.tsx', '.less'].some((ext) =>
          file.endsWith(ext)
        )
      )

    const shouldRunBuild = isLaravel && (hasFrontendChanges || shouldRunNpmInstall)
    const shouldClearCaches = hasPhpChanges
    const shouldRestartQueues = hasPhpChanges

    let horizonConfigured = false
    if (shouldRestartQueues) {
      const horizonCheck = await ssh.execCommand(
        'if [ -f config/horizon.php ]; then echo "yes"; else echo "no"; fi',
        { cwd: remoteCwd }
      )
      horizonConfigured = horizonCheck.stdout.trim() === 'yes'
    }

    const steps = [
      {
        label: `Pull latest changes for ${config.branch}`,
        command: `git pull origin ${config.branch}`
      }
    ]

    if (shouldRunComposer) {
      steps.push({
        label: 'Update Composer dependencies',
        command: 'composer update --no-dev --no-interaction --prefer-dist'
      })
    }

    if (shouldRunMigrations) {
      steps.push({
        label: 'Run database migrations',
        command: 'php artisan migrate --force'
      })
    }

    if (shouldRunNpmInstall) {
      steps.push({
        label: 'Install Node dependencies',
        command: 'npm install'
      })
    }

    if (shouldRunBuild) {
      steps.push({
        label: 'Compile frontend assets',
        command: 'npm run build'
      })
    }

    if (shouldClearCaches) {
      steps.push({
        label: 'Clear Laravel caches',
        command: 'php artisan cache:clear && php artisan config:clear && php artisan view:clear'
      })
    }

    if (shouldRestartQueues) {
      steps.push({
        label: horizonConfigured ? 'Restart Horizon workers' : 'Restart queue workers',
        command: horizonConfigured ? 'php artisan horizon:terminate' : 'php artisan queue:restart'
      })
    }

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
    const logPath = logFilePath || await getLogFilePath(rootDir).catch(() => null)
    if (logPath) {
      logError(`\nTask output has been logged to: ${logPath}`)
    }

    // If lock was acquired but deployment failed, check for stale locks
    if (lockAcquired && ssh) {
      try {
        const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
        const remoteHome = remoteHomeResult.stdout.trim() || `/home/${sshUser}`
        const remoteCwd = resolveRemotePath(config.projectPath, remoteHome)
        await compareLocksAndPrompt(rootDir, ssh, remoteCwd)
      } catch (lockError) {
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
        await releaseRemoteLock(ssh, remoteCwd)
        await releaseLocalLock(rootDir)
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
  const defaults = {
    serverName: existingServers.length === 0 ? 'home' : `server-${existingServers.length + 1}`,
    serverIp: '1.1.1.1'
  }

  const answers = await runPrompt([
    {
      type: 'input',
      name: 'serverName',
      message: 'Server name',
      default: defaults.serverName
    },
    {
      type: 'input',
      name: 'serverIp',
      message: 'Server IP address',
      default: defaults.serverIp
    }
  ])

  return {
    id: generateId(),
    serverName: answers.serverName.trim() || defaults.serverName,
    serverIp: answers.serverIp.trim() || defaults.serverIp
  }
}

async function selectServer(servers) {
  if (servers.length === 0) {
    logProcessing("No servers configured. Let's create one.")
    const server = await promptServerDetails()
    servers.push(server)
    await saveServers(servers)
    logSuccess('Saved server configuration to ~/.config/zephyr/servers.json')
    return server
  }

  const choices = servers.map((server, index) => ({
    name: `${server.serverName} (${server.serverIp})`,
    value: index
  }))

  choices.push(new inquirer.Separator(), {
    name: '➕ Register a new server',
    value: 'create'
  })

  const { selection } = await runPrompt([
    {
      type: 'list',
      name: 'selection',
      message: 'Select server or register new',
      choices,
      default: 0
    }
  ])

  if (selection === 'create') {
    const server = await promptServerDetails(servers)
    servers.push(server)
    await saveServers(servers)
    logSuccess('Appended server configuration to ~/.config/zephyr/servers.json')
    return server
  }

  return servers[selection]
}

async function promptAppDetails(currentDir, existing = {}) {
  const branches = await listGitBranches(currentDir)
  const defaultBranch = existing.branch || (branches.includes('master') ? 'master' : branches[0])
  const defaults = {
    projectPath: existing.projectPath || defaultProjectPath(currentDir),
    branch: defaultBranch
  }

  const answers = await runPrompt([
    {
      type: 'input',
      name: 'projectPath',
      message: 'Remote project path',
      default: defaults.projectPath
    },
    {
      type: 'list',
      name: 'branchSelection',
      message: 'Branch to deploy',
      choices: [
        ...branches.map((branch) => ({ name: branch, value: branch })),
        new inquirer.Separator(),
        { name: 'Enter custom branch…', value: '__custom' }
      ],
      default: defaults.branch
    }
  ])

  let branch = answers.branchSelection

  if (branch === '__custom') {
    const { customBranch } = await runPrompt([
      {
        type: 'input',
        name: 'customBranch',
        message: 'Custom branch name',
        default: defaults.branch
      }
    ])

    branch = customBranch.trim() || defaults.branch
  }

  const sshDetails = await promptSshDetails(currentDir, existing)

  return {
    projectPath: answers.projectPath.trim() || defaults.projectPath,
    branch,
    ...sshDetails
  }
}

async function selectApp(projectConfig, server, currentDir) {
  const apps = projectConfig.apps ?? []
  const matches = apps
    .map((app, index) => ({ app, index }))
    .filter(({ app }) => app.serverId === server.id || app.serverName === server.serverName)

  if (matches.length === 0) {
    if (apps.length > 0) {
      const availableServers = [...new Set(apps.map((app) => app.serverName).filter(Boolean))]
      if (availableServers.length > 0) {
        logWarning(
          `No applications configured for server "${server.serverName}". Available servers: ${availableServers.join(', ')}`
        )
      }
    }
    logProcessing(`No applications configured for ${server.serverName}. Let's create one.`)
    const appDetails = await promptAppDetails(currentDir)
    const appConfig = {
      id: generateId(),
      serverId: server.id,
      serverName: server.serverName,
      ...appDetails
    }
    projectConfig.apps.push(appConfig)
    await saveProjectConfig(currentDir, projectConfig)
    logSuccess('Saved deployment configuration to .zephyr/config.json')
    return appConfig
  }

  const choices = matches.map(({ app, index }, matchIndex) => ({
    name: `${app.projectPath} (${app.branch})`,
    value: matchIndex
  }))

  choices.push(new inquirer.Separator(), {
    name: '➕ Configure new application for this server',
    value: 'create'
  })

  const { selection } = await runPrompt([
    {
      type: 'list',
      name: 'selection',
      message: `Select application for ${server.serverName}`,
      choices,
      default: 0
    }
  ])

  if (selection === 'create') {
    const appDetails = await promptAppDetails(currentDir)
    const appConfig = {
      id: generateId(),
      serverId: server.id,
      serverName: server.serverName,
      ...appDetails
    }
    projectConfig.apps.push(appConfig)
    await saveProjectConfig(currentDir, projectConfig)
    logSuccess('Appended deployment configuration to .zephyr/config.json')
    return appConfig
  }

  const chosen = matches[selection].app
  return chosen
}

async function promptPresetName() {
  const { presetName } = await runPrompt([
    {
      type: 'input',
      name: 'presetName',
      message: 'Enter a name for this preset',
      validate: (value) => (value && value.trim().length > 0 ? true : 'Preset name cannot be empty.')
    }
  ])

  return presetName.trim()
}

function generatePresetKey(serverName, projectPath) {
  return `${serverName}:${projectPath}`
}

async function selectPreset(projectConfig, servers) {
  const presets = projectConfig.presets ?? []
  const apps = projectConfig.apps ?? []

  if (presets.length === 0) {
    return null
  }

  const choices = presets.map((preset, index) => {
    let displayName = preset.name

    if (preset.appId) {
      // New format: look up app by ID
      const app = apps.find((a) => a.id === preset.appId)
      if (app) {
        const server = servers.find((s) => s.id === app.serverId || s.serverName === app.serverName)
        const serverName = server?.serverName || 'unknown'
        const branch = preset.branch || app.branch || 'unknown'
        displayName = `${preset.name} (${serverName} → ${app.projectPath} [${branch}])`
      }
    } else if (preset.key) {
      // Legacy format: parse from key
      const keyParts = preset.key.split(':')
      const serverName = keyParts[0]
      const projectPath = keyParts[1]
      const branch = preset.branch || (keyParts.length === 3 ? keyParts[2] : 'unknown')
      displayName = `${preset.name} (${serverName} → ${projectPath} [${branch}])`
    }

    return {
      name: displayName,
      value: index
    }
  })

  choices.push(new inquirer.Separator(), {
    name: '➕ Create new preset',
    value: 'create'
  })

  const { selection } = await runPrompt([
    {
      type: 'list',
      name: 'selection',
      message: 'Select preset or create new',
      choices,
      default: 0
    }
  ])

  if (selection === 'create') {
    return 'create' // Return a special marker instead of null
  }

  return presets[selection]
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
        console.error(error.stack)
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
        console.error(error.stack)
      }
      process.exit(1)
    }
  }

  // Default: Laravel deployment workflow
  const rootDir = process.cwd()

  await ensureGitignoreEntry(rootDir)
  await ensureProjectReleaseScript(rootDir)

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
  console.log(JSON.stringify(deploymentConfig, null, 2))

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
  releasePackagist
}
