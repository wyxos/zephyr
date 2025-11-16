#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PACKAGE_PATH = join(ROOT, 'package.json')

const STEP_PREFIX = '→'
const OK_PREFIX = '✔'
const WARN_PREFIX = '⚠'

const IS_WINDOWS = process.platform === 'win32'

function logStep(message) {
  console.log(`${STEP_PREFIX} ${message}`)
}

function logSuccess(message) {
  console.log(`${OK_PREFIX} ${message}`)
}

function logWarning(message) {
  console.warn(`${WARN_PREFIX} ${message}`)
}

function runCommand(command, args, { cwd = ROOT, capture = false, useShell = false } = {}) {
  return new Promise((resolve, reject) => {
    // On Windows, npm-related commands need shell: true to resolve npx.cmd
    // Git commands work fine without shell, so we only use it when explicitly requested
    const spawnOptions = {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    }
    
    if (useShell || (IS_WINDOWS && (command === 'npm' || command === 'npx'))) {
      spawnOptions.shell = true
    }

    const child = spawn(command, args, spawnOptions)
    let stdout = ''
    let stderr = ''

    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })

      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
    }

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(capture ? { stdout: stdout.trim(), stderr: stderr.trim() } : undefined)
      } else {
        const error = new Error(`Command failed (${code}): ${command} ${args.join(' ')}`)
        if (capture) {
          error.stdout = stdout
          error.stderr = stderr
        }
        error.exitCode = code
        reject(error)
      }
    })
  })
}

async function readPackage() {
  const raw = await readFile(PACKAGE_PATH, 'utf8')
  return JSON.parse(raw)
}

async function ensureCleanWorkingTree() {
  const { stdout } = await runCommand('git', ['status', '--porcelain'], { capture: true })

  if (stdout.length > 0) {
    throw new Error('Working tree has uncommitted changes. Commit or stash them before releasing.')
  }
}

async function getCurrentBranch() {
  const { stdout } = await runCommand('git', ['branch', '--show-current'], { capture: true })
  return stdout || null
}

async function getUpstreamRef() {
  try {
    const { stdout } = await runCommand('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      capture: true
    })

    return stdout || null
  } catch {
    return null
  }
}

async function ensureUpToDateWithUpstream(branch, upstreamRef) {
  if (!upstreamRef) {
    logWarning(`Branch ${branch} has no upstream configured; skipping ahead/behind checks.`)
    return
  }

  const [remoteName, ...branchParts] = upstreamRef.split('/')
  const remoteBranch = branchParts.join('/')

  if (remoteName && remoteBranch) {
    logStep(`Fetching latest updates from ${remoteName}/${remoteBranch}...`)
    try {
      await runCommand('git', ['fetch', remoteName, remoteBranch])
    } catch (error) {
      throw new Error(`Failed to fetch ${upstreamRef}: ${error.message}`)
    }
  }

  const aheadResult = await runCommand('git', ['rev-list', '--count', `${upstreamRef}..HEAD`], {
    capture: true
  })
  const behindResult = await runCommand('git', ['rev-list', '--count', `HEAD..${upstreamRef}`], {
    capture: true
  })

  const ahead = Number.parseInt(aheadResult.stdout || '0', 10)
  const behind = Number.parseInt(behindResult.stdout || '0', 10)

  if (Number.isFinite(behind) && behind > 0) {
    if (remoteName && remoteBranch) {
      logStep(`Fast-forwarding ${branch} with ${upstreamRef}...`)

      try {
        await runCommand('git', ['pull', '--ff-only', remoteName, remoteBranch])
      } catch (error) {
        throw new Error(
          `Unable to fast-forward ${branch} with ${upstreamRef}. Resolve conflicts manually, then rerun the release.\n${error.message}`
        )
      }

      return ensureUpToDateWithUpstream(branch, upstreamRef)
    }

    throw new Error(
      `Branch ${branch} is behind ${upstreamRef} by ${behind} commit${behind === 1 ? '' : 's'}. Pull or rebase first.`
    )
  }

  if (Number.isFinite(ahead) && ahead > 0) {
    logWarning(`Branch ${branch} is ahead of ${upstreamRef} by ${ahead} commit${ahead === 1 ? '' : 's'}.`)
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  const positionals = args.filter((arg) => !arg.startsWith('--'))
  const flags = new Set(args.filter((arg) => arg.startsWith('--')))

  const releaseType = positionals[0] ?? 'patch'
  const skipTests = flags.has('--skip-tests')

  const allowedTypes = new Set([
    'major',
    'minor',
    'patch',
    'premajor',
    'preminor',
    'prepatch',
    'prerelease'
  ])

  if (!allowedTypes.has(releaseType)) {
    throw new Error(
      `Invalid release type "${releaseType}". Use one of: ${Array.from(allowedTypes).join(', ')}.`
    )
  }

  return { releaseType, skipTests }
}

async function runTests(skipTests) {
  if (skipTests) {
    logWarning('Skipping tests because --skip-tests flag was provided.')
    return
  }

  logStep('Running test suite (vitest run)...')
  await runCommand('npx', ['vitest', 'run'])
  logSuccess('Tests passed.')
}

async function ensureNpmAuth() {
  logStep('Confirming npm authentication...')
  await runCommand('npm', ['whoami'])
}

async function bumpVersion(releaseType) {
  logStep(`Bumping package version with "npm version ${releaseType}"...`)
  // npm version will update package.json and create a commit with default message
  await runCommand('npm', ['version', releaseType])
  
  const pkg = await readPackage()
  const commitMessage = `chore: release ${pkg.version}`
  
  // Amend the commit message to use our custom format
  await runCommand('git', ['commit', '--amend', '-m', commitMessage])
  
  logSuccess(`Version updated to ${pkg.version}.`)
  return pkg
}

async function pushChanges() {
  logStep('Pushing commits and tags to origin...')
  await runCommand('git', ['push', '--follow-tags'])
  logSuccess('Git push completed.')
}

async function publishPackage(pkg) {
  const publishArgs = ['publish']

  if (pkg.name.startsWith('@')) {
    publishArgs.push('--access', 'public')
  }

  logStep(`Publishing ${pkg.name}@${pkg.version} to npm...`)
  await runCommand('npm', publishArgs)
  logSuccess('npm publish completed.')
}

async function main() {
  const { releaseType, skipTests } = parseArgs()

  logStep('Reading package metadata...')
  const pkg = await readPackage()

  logStep('Checking working tree status...')
  await ensureCleanWorkingTree()

  const branch = await getCurrentBranch()
  if (!branch) {
    throw new Error('Unable to determine current branch.')
  }

  logStep(`Current branch: ${branch}`)
  const upstreamRef = await getUpstreamRef()
  await ensureUpToDateWithUpstream(branch, upstreamRef)

  await runTests(skipTests)
  await ensureNpmAuth()

  const updatedPkg = await bumpVersion(releaseType)
  await pushChanges()
  await publishPackage(updatedPkg)

  logSuccess(`Release workflow completed for ${updatedPkg.name}@${updatedPkg.version}.`)
}

main().catch((error) => {
  console.error('\nRelease failed:')
  console.error(error.message)
  process.exit(1)
})
