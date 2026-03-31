import inquirer from 'inquirer'
import process from 'node:process'

import {validateLocalDependencies} from '../dependency-scanner.mjs'
import {runCommand as runCommandBase, runCommandCapture as runCommandCaptureBase} from '../utils/command.mjs'
import {gitCommitArgs} from '../utils/git-hooks.mjs'
import {
  ensureUpToDateWithUpstream,
  getCurrentBranch,
  getUpstreamRef
} from '../utils/git.mjs'
import {
  formatWorkingTreePreview,
  parseWorkingTreeEntries,
  parseWorkingTreeStatus,
  suggestReleaseCommitMessage
} from './commit-message.mjs'
import {RELEASE_TYPES as SUPPORTED_RELEASE_TYPES} from './release-type.mjs'

const RELEASE_TYPES = new Set(SUPPORTED_RELEASE_TYPES)
const DIRTY_WORKING_TREE_MESSAGE = 'Working tree has uncommitted changes. Commit or stash them before releasing.'
const DIRTY_WORKING_TREE_CANCELLED_MESSAGE = 'Release cancelled: pending changes were not committed.'

function flagToKey(flag) {
  return flag
    .replace(/^--/, '')
    .replace(/-([a-z])/g, (_match, character) => character.toUpperCase())
}

export function parseReleaseArgs({
  args = process.argv.slice(2),
  booleanFlags = []
} = {}) {
  const filteredArgs = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--type') {
      index += 1
      continue
    }

    if (arg.startsWith('--type=')) {
      continue
    }

    filteredArgs.push(arg)
  }

  const positionals = filteredArgs.filter((arg) => !arg.startsWith('--'))
  const presentFlags = new Set(filteredArgs.filter((arg) => arg.startsWith('--')))
  const releaseType = positionals[0] ?? null

  if (releaseType && !RELEASE_TYPES.has(releaseType)) {
    throw new Error(
      `Invalid release type "${releaseType}". Use one of: ${Array.from(RELEASE_TYPES).join(', ')}.`
    )
  }

  const parsedFlags = Object.fromEntries(
    booleanFlags.map((flag) => [flagToKey(flag), presentFlags.has(flag)])
  )

  return {releaseType, ...parsedFlags}
}

export async function runReleaseCommand(command, args, {
  cwd = process.cwd(),
  capture = false,
  runCommandImpl = runCommandBase,
  runCommandCaptureImpl = runCommandCaptureBase
} = {}) {
  if (capture) {
    const captured = await runCommandCaptureImpl(command, args, {cwd})

    if (typeof captured === 'string') {
      return {stdout: captured.trim(), stderr: ''}
    }

    const stdout = captured?.stdout ?? ''
    const stderr = captured?.stderr ?? ''
    return {stdout: stdout.trim(), stderr: stderr.trim()}
  }

  await runCommandImpl(command, args, {cwd})
  return undefined
}

export async function ensureCleanWorkingTree(rootDir = process.cwd(), {
  runCommand = runReleaseCommand,
  runPrompt,
  logStep,
  logSuccess,
  logWarning,
  interactive = true,
  skipGitHooks = false,
  suggestCommitMessage = suggestReleaseCommitMessage
} = {}) {
  const {stdout} = await runCommand('git', ['status', '--porcelain'], {
    capture: true,
    cwd: rootDir
  })
  const statusEntries = parseWorkingTreeEntries(stdout)

  if (statusEntries.length === 0) {
    return
  }

  if (!interactive || typeof runPrompt !== 'function') {
    throw new Error(DIRTY_WORKING_TREE_MESSAGE)
  }

  const suggestedCommitMessage = await suggestCommitMessage(rootDir, {
    runCommand,
    logStep,
    logWarning,
    statusEntries
  })
  const {commitMessage} = await runPrompt([
    {
      type: 'input',
      name: 'commitMessage',
      message:
        'Pending changes detected before release:\n\n' +
        `${formatWorkingTreePreview(statusEntries)}\n\n` +
        'Enter a commit message to stage and commit all current changes before continuing.\n' +
        'Leave blank to cancel.',
      default: suggestedCommitMessage ?? ''
    }
  ])

  if (!commitMessage || commitMessage.trim().length === 0) {
    throw new Error(DIRTY_WORKING_TREE_CANCELLED_MESSAGE)
  }

  const message = commitMessage.trim()

  logStep?.('Staging all pending changes before release...')
  await runCommand('git', ['add', '-A'], {
    capture: true,
    cwd: rootDir
  })

  logStep?.('Committing pending changes before release...')
  await runCommand('git', gitCommitArgs(['-m', message], {skipGitHooks}), {
    capture: true,
    cwd: rootDir
  })

  const {stdout: finalStatus} = await runCommand('git', ['status', '--porcelain'], {
    capture: true,
    cwd: rootDir
  })

  if (parseWorkingTreeStatus(finalStatus).length > 0) {
    throw new Error('Working tree still has uncommitted changes after the release commit. Commit or stash them before releasing.')
  }

  logSuccess?.(`Committed pending changes with "${message}".`)
}

export async function validateReleaseDependencies(rootDir = process.cwd(), {
  prompt = (questions) => inquirer.prompt(questions),
  logSuccess,
  interactive = true,
  skipGitHooks = false
} = {}) {
  await validateLocalDependencies(rootDir, prompt, logSuccess, {
    interactive,
    skipGitHooks
  })
}

export async function ensureReleaseBranchReady({
  rootDir = process.cwd(),
  branchMethod = 'show-current',
  getCurrentBranchImpl = getCurrentBranch,
  getUpstreamRefImpl = getUpstreamRef,
  ensureUpToDateWithUpstreamImpl = ensureUpToDateWithUpstream,
  logStep,
  logWarning
} = {}) {
  const branch = await getCurrentBranchImpl(rootDir, {method: branchMethod})

  if (!branch) {
    throw new Error('Unable to determine current branch.')
  }

  logStep?.(`Current branch: ${branch}`)

  const upstreamRef = await getUpstreamRefImpl(rootDir)
  await ensureUpToDateWithUpstreamImpl({branch, upstreamRef, rootDir, logStep, logWarning})

  return {branch, upstreamRef}
}

export {suggestReleaseCommitMessage}
