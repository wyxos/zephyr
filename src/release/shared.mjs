import inquirer from 'inquirer'
import process from 'node:process'

import { validateLocalDependencies } from '../dependency-scanner.mjs'
import { runCommand as runCommandBase, runCommandCapture as runCommandCaptureBase } from '../utils/command.mjs'
import {
  ensureUpToDateWithUpstream,
  getCurrentBranch,
  getUpstreamRef
} from '../utils/git.mjs'

const RELEASE_TYPES = new Set([
  'major',
  'minor',
  'patch',
  'premajor',
  'preminor',
  'prepatch',
  'prerelease'
])

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
  const releaseType = positionals[0] ?? 'patch'

  if (!RELEASE_TYPES.has(releaseType)) {
    throw new Error(
      `Invalid release type "${releaseType}". Use one of: ${Array.from(RELEASE_TYPES).join(', ')}.`
    )
  }

  const parsedFlags = Object.fromEntries(
    booleanFlags.map((flag) => [flagToKey(flag), presentFlags.has(flag)])
  )

  return { releaseType, ...parsedFlags }
}

export async function runReleaseCommand(command, args, {
  cwd = process.cwd(),
  capture = false
} = {}) {
  if (capture) {
    const { stdout, stderr } = await runCommandCaptureBase(command, args, { cwd })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  }

  await runCommandBase(command, args, { cwd })
  return undefined
}

export async function ensureCleanWorkingTree(rootDir = process.cwd(), {
  runCommand = runReleaseCommand
} = {}) {
  const { stdout } = await runCommand('git', ['status', '--porcelain'], {
    capture: true,
    cwd: rootDir
  })

  if (stdout.length > 0) {
    throw new Error('Working tree has uncommitted changes. Commit or stash them before releasing.')
  }
}

export async function validateReleaseDependencies(rootDir = process.cwd(), {
  prompt = (questions) => inquirer.prompt(questions),
  logSuccess
} = {}) {
  await validateLocalDependencies(rootDir, prompt, logSuccess)
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
  const branch = await getCurrentBranchImpl(rootDir, { method: branchMethod })

  if (!branch) {
    throw new Error('Unable to determine current branch.')
  }

  logStep?.(`Current branch: ${branch}`)

  const upstreamRef = await getUpstreamRefImpl(rootDir)
  await ensureUpToDateWithUpstreamImpl({ branch, upstreamRef, rootDir, logStep, logWarning })

  return { branch, upstreamRef }
}
