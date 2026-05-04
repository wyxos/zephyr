import fs from 'node:fs/promises'
import path from 'node:path'

import {
  formatWorkingTreePreview,
  parseWorkingTreeEntries,
  suggestReleaseCommitMessage as suggestCommitMessageImpl
} from '../../release/commit-message.mjs'
import {gitCommitArgs, gitPushArgs} from '../../utils/git-hooks.mjs'

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
]
const TRACKED_NPM_LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json']

async function readPackageJson(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json')
  const raw = await fs.readFile(packageJsonPath, 'utf8')
  return JSON.parse(raw)
}

async function writePackageJson(rootDir, pkg) {
  const packageJsonPath = path.join(rootDir, 'package.json')
  await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

function findDependencyField(pkg, packageName) {
  return DEPENDENCY_FIELDS.find((field) => Object.hasOwn(pkg?.[field] ?? {}, packageName)) ?? null
}

function formatDependencyVersion(currentValue, version) {
  if (typeof currentValue !== 'string' || currentValue.length === 0) {
    return `^${version}`
  }

  if (currentValue.startsWith('~')) {
    return `~${version}`
  }

  if (currentValue.startsWith('^')) {
    return `^${version}`
  }

  if (/^\d/.test(currentValue)) {
    return version
  }

  return `^${version}`
}

export async function assertCleanConsumerRepo(rootDir, {runCommandCapture} = {}) {
  const status = await runCommandCapture('git', ['status', '--porcelain'], {cwd: rootDir})
  const normalizedStatus = typeof status === 'string' ? status : status?.stdout ?? ''

  if (normalizedStatus.trim().length > 0) {
    throw new Error('Consumer repository has uncommitted changes. Commit, stash, or clean them before running a package-to-consumer release.')
  }
}

function normalizeCommandOutput(output) {
  return typeof output === 'string' ? output : output?.stdout ?? ''
}

function createCaptureAwareRunCommand({runCommand, runCommandCapture}) {
  return async (command, args, {capture = false, cwd} = {}) => {
    if (capture) {
      const captured = await runCommandCapture(command, args, {cwd})

      if (typeof captured === 'string') {
        return {stdout: captured.trim(), stderr: ''}
      }

      const stdout = captured?.stdout ?? ''
      const stderr = captured?.stderr ?? ''
      return {stdout: stdout.trim(), stderr: stderr.trim()}
    }

    await runCommand(command, args, {cwd})
    return undefined
  }
}

export async function ensureConsumerRepoReady(rootDir, {
  runCommand,
  runCommandCapture,
  runPrompt,
  logProcessing,
  logSuccess,
  logWarning,
  autoCommit = false,
  skipGitHooks = false,
  suggestCommitMessage = suggestCommitMessageImpl
} = {}) {
  if (typeof runCommandCapture !== 'function') {
    throw new Error('Consumer repository checks require a command capture runner.')
  }

  const status = normalizeCommandOutput(await runCommandCapture('git', ['status', '--porcelain'], {cwd: rootDir}))
  const statusEntries = parseWorkingTreeEntries(status)

  if (statusEntries.length === 0) {
    return {committed: false, pushed: false}
  }

  if (!autoCommit && typeof runPrompt !== 'function') {
    throw new Error('Consumer repository has uncommitted changes. Commit, stash, or clean them before running a package-to-consumer release.')
  }

  if (typeof runCommand !== 'function') {
    throw new Error('Consumer repository auto-commit requires a command runner.')
  }

  const captureAwareRunCommand = createCaptureAwareRunCommand({runCommand, runCommandCapture})
  const suggestedCommitMessage = await suggestCommitMessage(rootDir, {
    runCommand: captureAwareRunCommand,
    logStep: logProcessing,
    logWarning,
    statusEntries
  })
  let message = suggestedCommitMessage?.trim() ?? ''

  if (autoCommit) {
    if (!message) {
      throw new Error('Consumer auto-commit failed because Codex could not determine a usable commit message.')
    }

    logProcessing?.(`Consumer auto-commit enabled. Using Codex-generated commit message "${message}".`)
  } else {
    const {commitMessage} = await runPrompt([
      {
        type: 'input',
        name: 'commitMessage',
        message:
          'Pending changes detected in the consumer repository:\n\n' +
          `${formatWorkingTreePreview(statusEntries)}\n\n` +
          'Enter a commit message to stage, commit, and push all current consumer changes before continuing.\n' +
          'Leave blank to cancel.',
        default: message
      }
    ])

    if (!commitMessage || commitMessage.trim().length === 0) {
      throw new Error('Consumer release cancelled: pending changes were not committed.')
    }

    message = commitMessage.trim()
  }

  logProcessing?.('Staging all pending consumer changes before dependency update...')
  await runCommand('git', ['add', '-A'], {cwd: rootDir})

  logProcessing?.('Committing pending consumer changes before dependency update...')
  await runCommand('git', gitCommitArgs(['-m', message], {skipGitHooks}), {cwd: rootDir})

  logProcessing?.('Pushing pending consumer changes before dependency update...')
  await runCommand('git', gitPushArgs([], {skipGitHooks}), {cwd: rootDir})

  const finalStatus = normalizeCommandOutput(await runCommandCapture('git', ['status', '--porcelain'], {cwd: rootDir}))
  if (parseWorkingTreeEntries(finalStatus).length > 0) {
    throw new Error('Consumer repository still has uncommitted changes after auto-commit. Aborting package-to-consumer release.')
  }

  logSuccess?.(`Committed and pushed consumer changes with "${message}".`)
  return {committed: true, pushed: true, message}
}

async function isTracked(rootDir, filePath, {runCommandCapture} = {}) {
  try {
    await runCommandCapture('git', ['ls-files', '--error-unmatch', filePath], {cwd: rootDir})
    return true
  } catch {
    return false
  }
}

async function getChangedFiles(rootDir, files, {runCommandCapture} = {}) {
  const status = await runCommandCapture('git', ['status', '--porcelain', '--', ...files], {cwd: rootDir})
  const normalizedStatus = typeof status === 'string' ? status : status?.stdout ?? ''
  return normalizedStatus
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function trackedNpmLockFiles(rootDir, {runCommandCapture} = {}) {
  const tracked = []

  for (const filePath of TRACKED_NPM_LOCK_FILES) {
    if (await isTracked(rootDir, filePath, {runCommandCapture})) {
      tracked.push(filePath)
    }
  }

  return tracked
}

export async function updateConsumerDependency({
  rootDir,
  packageName,
  version,
  runCommand,
  runCommandCapture,
  runPrompt,
  logProcessing,
  logSuccess,
  logWarning,
  autoCommit = false,
  skipGitHooks = false,
  suggestCommitMessage = suggestCommitMessageImpl
} = {}) {
  if (!rootDir) {
    throw new Error('Consumer root directory is required.')
  }

  if (!packageName) {
    throw new Error('Consumer package name is required.')
  }

  if (!version) {
    throw new Error('Consumer package version is required.')
  }

  if (typeof runCommand !== 'function' || typeof runCommandCapture !== 'function') {
    throw new Error('Consumer dependency updates require command runners.')
  }

  await ensureConsumerRepoReady(rootDir, {
    runCommand,
    runCommandCapture,
    runPrompt,
    logProcessing,
    logSuccess,
    logWarning,
    autoCommit,
    skipGitHooks,
    suggestCommitMessage
  })

  const pkg = await readPackageJson(rootDir)
  const dependencyField = findDependencyField(pkg, packageName)

  if (!dependencyField) {
    throw new Error(`Consumer package.json does not depend on ${packageName}. Add it before running --then-deploy.`)
  }

  const currentValue = pkg[dependencyField][packageName]
  const nextValue = formatDependencyVersion(currentValue, version)
  const lockFiles = await trackedNpmLockFiles(rootDir, {runCommandCapture})

  if (currentValue !== nextValue) {
    logProcessing?.(`Updating ${packageName} in consumer package.json from ${currentValue} to ${nextValue}...`)
    pkg[dependencyField][packageName] = nextValue
    await writePackageJson(rootDir, pkg)
  } else {
    logProcessing?.(`Consumer package.json already references ${packageName}@${nextValue}.`)
  }

  if (lockFiles.length > 0) {
    logProcessing?.(`Refreshing tracked npm lock file${lockFiles.length === 1 ? '' : 's'}: ${lockFiles.join(', ')}...`)
    await runCommand('npm', ['install', '--package-lock-only', '--ignore-scripts'], {cwd: rootDir})
  } else {
    logWarning?.('No tracked npm lock file found in consumer repo; committing manifest update only.')
  }

  const filesToCommit = ['package.json', ...lockFiles]
  const changedFiles = await getChangedFiles(rootDir, filesToCommit, {runCommandCapture})

  if (changedFiles.length === 0) {
    logSuccess?.(`Consumer already uses ${packageName}@${version}.`)
    return {committed: false, files: []}
  }

  const commitMessage = `chore: update ${packageName} to ${version}`

  await runCommand('git', ['add', '--', ...filesToCommit], {cwd: rootDir})
  await runCommand('git', gitCommitArgs(['-m', commitMessage, '--', ...filesToCommit], {skipGitHooks}), {cwd: rootDir})

  logSuccess?.(`Committed consumer dependency update with "${commitMessage}".`)

  return {committed: true, files: filesToCommit, message: commitMessage}
}
