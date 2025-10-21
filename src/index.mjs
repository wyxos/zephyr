import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { NodeSSH } from 'node-ssh'

const RELEASE_FILE = 'release.json'

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

  logProcessing('Local repository is clean after committing pending changes.')
}

async function ensureGitignoreEntry(rootDir) {
  const gitignorePath = path.join(rootDir, '.gitignore')
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
    .some((line) => line.trim() === RELEASE_FILE)

  if (hasEntry) {
    return
  }

  const updatedContent = existingContent
    ? `${existingContent.replace(/\s*$/, '')}\n${RELEASE_FILE}\n`
    : `${RELEASE_FILE}\n`

  await fs.writeFile(gitignorePath, updatedContent)
  logSuccess('Added release.json to .gitignore')

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
    await runCommand('git', ['commit', '-m', 'chore: ignore release config'], { cwd: rootDir })
  } catch (error) {
    if (error.exitCode === 1) {
      logWarning('Git commit skipped: nothing to commit or pre-commit hook prevented commit.')
    } else {
      throw error
    }
  }
}

async function loadReleases(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data : []
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    logWarning('Failed to read release.json, starting with an empty list.')
    return []
  }
}

async function saveReleases(filePath, releases) {
  const payload = JSON.stringify(releases, null, 2)
  await fs.writeFile(filePath, `${payload}\n`)
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

async function runRemoteTasks(config) {
  await ensureLocalRepositoryState(config.branch, process.cwd())

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

    const executeRemote = async (label, command, options = {}) => {
      const { cwd = remoteCwd, allowFailure = false, printStdout = true } = options
      logProcessing(`\n→ ${label}`)
      const result = await ssh.execCommand(command, { cwd })

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

    if (isLaravel) {
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

    if (steps.length === 1) {
      logProcessing('No additional maintenance tasks scheduled beyond git pull.')
    } else {
      const extraTasks = steps
        .slice(1)
        .map((step) => step.label)
        .join(', ')

      logProcessing(`Additional tasks scheduled: ${extraTasks}`)
    }

    for (const step of steps) {
      await executeRemote(step.label, step.command)
    }

    logSuccess('\nDeployment commands completed successfully.')
  } catch (error) {
    throw new Error(`Deployment failed: ${error.message}`)
  } finally {
    ssh.dispose()
  }
}

async function collectServerConfig(currentDir) {
  const branches = await listGitBranches(currentDir)
  const defaultBranch = branches.includes('master') ? 'master' : branches[0]
  const defaults = {
    serverName: 'home',
    serverIp: '1.1.1.1',
    projectPath: defaultProjectPath(currentDir),
    branch: defaultBranch
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
      message: 'Server IP',
      default: defaults.serverIp
    },
    {
      type: 'input',
      name: 'projectPath',
      message: 'Project path',
      default: defaults.projectPath
    },
    {
      type: 'list',
      name: 'branchSelection',
      message: 'Branch',
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
    const { customBranch } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customBranch',
        message: 'Custom branch name',
        default: defaults.branch
      }
    ])

    branch = customBranch.trim() || defaults.branch
  }

  const sshDetails = await promptSshDetails(currentDir)

  return {
    serverName: answers.serverName,
    serverIp: answers.serverIp,
    projectPath: answers.projectPath,
    branch,
    ...sshDetails
  }
}

async function promptSelection(releases) {
  const choices = releases.map((entry, index) => ({
    name: `${entry.serverName} (${entry.serverIp})` || `Server ${index + 1}`,
    value: index
  }))

  choices.push(new inquirer.Separator(), {
    name: '➕ Create new deployment target',
    value: 'create'
  })

  const { selection } = await runPrompt([
    {
      type: 'list',
      name: 'selection',
      message: 'Select server or create new',
      choices,
      default: 0
    }
  ])

  return selection
}

async function main() {
  const rootDir = process.cwd()
  const releasePath = path.join(rootDir, RELEASE_FILE)

  await ensureGitignoreEntry(rootDir)

  const releases = await loadReleases(releasePath)

  if (releases.length === 0) {
    logProcessing("No deployment targets found. Let's create one.")
    const config = await collectServerConfig(rootDir)
    releases.push(config)
    await saveReleases(releasePath, releases)
    logSuccess('Saved deployment configuration to release.json')
    await runRemoteTasks(config)
    return
  }

  const selection = await promptSelection(releases)

  if (selection === 'create') {
    const config = await collectServerConfig(rootDir)
    releases.push(config)
    await saveReleases(releasePath, releases)
    logSuccess('Appended new deployment configuration to release.json')
    await runRemoteTasks(config)
    return
  }

  const chosen = releases[selection]
  const updated = await ensureSshDetails(chosen, rootDir)

  if (updated) {
    await saveReleases(releasePath, releases)
    logSuccess('Updated release.json with SSH details.')
  }
  logProcessing('\nSelected deployment target:')
  console.log(JSON.stringify(chosen, null, 2))

  await runRemoteTasks(chosen)
}

export {
  ensureGitignoreEntry,
  listSshKeys,
  resolveRemotePath,
  isPrivateKeyFile,
  runRemoteTasks,
  collectServerConfig,
  promptSshDetails,
  ensureSshDetails,
  ensureLocalRepositoryState,
  main
}
