import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { NodeSSH } from 'node-ssh'

const PROJECT_CONFIG_DIR = '.zephyr'
const PROJECT_CONFIG_FILE = 'config.json'
const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.config', 'zephyr')
const SERVERS_FILE = path.join(GLOBAL_CONFIG_DIR, 'servers.json')
const PROJECT_LOCK_FILE = 'deploy.lock'
const PENDING_TASKS_FILE = 'pending-tasks.json'
const RELEASE_SCRIPT_NAME = 'release'
const RELEASE_SCRIPT_COMMAND = 'npx @wyxos/zephyr@release'

const logProcessing = (message = '') => console.log(chalk.yellow(message))
const logSuccess = (message = '') => console.log(chalk.green(message))
const logWarning = (message = '') => console.warn(chalk.yellow(message))
const logError = (message = '') => console.error(chalk.red(message))

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
    const child = spawn(command, args, {
      stdio: silent ? 'ignore' : 'inherit',
      cwd
    })

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

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd
    })

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

  logWarning(`Uncommitted changes detected on ${targetBranch}. A commit is required before deployment.`)

  const { commitMessage } = await runPrompt([
    {
      type: 'input',
      name: 'commitMessage',
      message: 'Enter a commit message for pending changes before deployment',
      validate: (value) => (value && value.trim().length > 0 ? true : 'Commit message cannot be empty.')
    }
  ])

  const message = commitMessage.trim()

  logProcessing('Committing local changes before deployment...')
  await runCommand('git', ['add', '-A'], { cwd: rootDir })
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
      message: 'Add "release" script to package.json that runs "npx @wyxos/zephyr@release"?',
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

async function acquireProjectLock(rootDir) {
  const lockDir = getProjectConfigDir(rootDir)
  await ensureDirectory(lockDir)
  const lockPath = getLockFilePath(rootDir)

  try {
    const existing = await fs.readFile(lockPath, 'utf8')
    let details = {}
    try {
      details = JSON.parse(existing)
    } catch (error) {
      details = { raw: existing }
    }

    const startedBy = details.user ? `${details.user}@${details.hostname ?? 'unknown'}` : 'unknown user'
    const startedAt = details.startedAt ? ` at ${details.startedAt}` : ''
    throw new Error(
      `Another deployment is currently in progress (started by ${startedBy}${startedAt}). Remove ${lockPath} if you are sure it is stale.`
    )
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }

  const payload = {
    user: os.userInfo().username,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString()
  }

  await fs.writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`)
  return lockPath
}

async function releaseProjectLock(rootDir) {
  const lockPath = getLockFilePath(rootDir)
  try {
    await fs.unlink(lockPath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
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

async function loadServers() {
  try {
    const raw = await fs.readFile(SERVERS_FILE, 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data : []
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

async function loadProjectConfig(rootDir) {
  const configPath = getProjectConfigPath(rootDir)

  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const data = JSON.parse(raw)
    return {
      apps: Array.isArray(data?.apps) ? data.apps : []
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { apps: [] }
    }

    logWarning('Failed to read .zephyr/config.json, starting with an empty list of apps.')
    return { apps: [] }
  }
}

async function saveProjectConfig(rootDir, config) {
  const configDir = path.join(rootDir, PROJECT_CONFIG_DIR)
  await ensureDirectory(configDir)
  const payload = JSON.stringify({ apps: config.apps ?? [] }, null, 2)
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

async function runRemoteTasks(config, options = {}) {
  const { snapshot = null, rootDir = process.cwd() } = options

  await ensureLocalRepositoryState(config.branch, rootDir)

  const ssh = createSshClient()
  const sshUser = config.sshUser || os.userInfo().username
  const privateKeyPath = await resolveSshKeyPath(config.sshKey)
  const privateKey = await fs.readFile(privateKeyPath, 'utf8')

  logProcessing(`\nConnecting to ${config.serverIp} as ${sshUser}...`)

  try {
    await ssh.connect({
      host: config.serverIp,
      username: sshUser,
      privateKey
    })

    const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
    const remoteHome = remoteHomeResult.stdout.trim() || `/home/${sshUser}`
    const remoteCwd = resolveRemotePath(config.projectPath, remoteHome)

    logProcessing(`Connection established. Running deployment commands in ${remoteCwd}...`)

    const profileBootstrap = [
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
      'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"; fi',
      'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
      'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile"; fi',
      'if [ -f "$HOME/.zshrc" ]; then . "$HOME/.zshrc"; fi'
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

      if (printStdout && result.stdout && result.stdout.trim()) {
        console.log(result.stdout.trim())
      }

      if (result.stderr && result.stderr.trim()) {
        if (result.code === 0) {
          logWarning(result.stderr.trim())
        } else {
          logError(result.stderr.trim())
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
          `Detected ${changedFiles.length} changed file(s):\n${preview}${
            changedFiles.length > 20 ? '\n - ...' : ''
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
  } catch (error) {
    throw new Error(`Deployment failed: ${error.message}`)
  } finally {
    ssh.dispose()
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
    .filter(({ app }) => app.serverName === server.serverName)

  if (matches.length === 0) {
    logProcessing(`No applications configured for ${server.serverName}. Let's create one.`)
    const appDetails = await promptAppDetails(currentDir)
    const appConfig = {
      serverName: server.serverName,
      ...appDetails
    }
    projectConfig.apps.push(appConfig)
    await saveProjectConfig(currentDir, projectConfig)
    logSuccess('Saved deployment configuration to .zephyr/config.json')
    return appConfig
  }

  const choices = matches.map(({ app, index }) => ({
    name: `${app.projectPath} (${app.branch})`,
    value: index
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
      serverName: server.serverName,
      ...appDetails
    }
    projectConfig.apps.push(appConfig)
    await saveProjectConfig(currentDir, projectConfig)
    logSuccess('Appended deployment configuration to .zephyr/config.json')
    return appConfig
  }

  const chosen = projectConfig.apps[selection]
  return chosen
}

async function main() {
  const rootDir = process.cwd()

  await ensureGitignoreEntry(rootDir)
  await ensureProjectReleaseScript(rootDir)

  const servers = await loadServers()
  const server = await selectServer(servers)
  const projectConfig = await loadProjectConfig(rootDir)
  const appConfig = await selectApp(projectConfig, server, rootDir)

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

  let lockAcquired = false

  try {
    await acquireProjectLock(rootDir)
    lockAcquired = true
    await runRemoteTasks(deploymentConfig, { rootDir, snapshot: snapshotToUse })
  } finally {
    if (lockAcquired) {
      await releaseProjectLock(rootDir)
    }
  }
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
  main
}
