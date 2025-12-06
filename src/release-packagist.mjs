import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import semver from 'semver'

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

function runCommand(command, args, { cwd = process.cwd(), capture = false, useShell = false } = {}) {
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    }

    if (useShell || (IS_WINDOWS && (command === 'php' || command === 'composer'))) {
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

async function readComposer(rootDir = process.cwd()) {
  const composerPath = join(rootDir, 'composer.json')
  const raw = await readFile(composerPath, 'utf8')
  return JSON.parse(raw)
}

async function writeComposer(rootDir, composer, composerPath = null) {
  const pathToUse = composerPath || join(rootDir, 'composer.json')
  const content = JSON.stringify(composer, null, 2) + '\n'
  await writeFile(pathToUse, content, 'utf8')
}

function hasComposerScript(composer, scriptName) {
  return composer?.scripts?.[scriptName] !== undefined
}

async function hasLaravelPint(rootDir = process.cwd()) {
  const pintPath = join(rootDir, 'vendor', 'bin', 'pint')
  try {
    await fs.promises.access(pintPath)
    const stats = await fs.promises.stat(pintPath)
    return stats.isFile()
  } catch {
    return false
  }
}

async function hasArtisan(rootDir = process.cwd()) {
  const artisanPath = join(rootDir, 'artisan')
  try {
    await fs.promises.access(artisanPath)
    const stats = await fs.promises.stat(artisanPath)
    return stats.isFile()
  } catch {
    return false
  }
}

async function ensureCleanWorkingTree(rootDir = process.cwd()) {
  const { stdout } = await runCommand('git', ['status', '--porcelain'], { capture: true, cwd: rootDir })

  if (stdout.length > 0) {
    throw new Error('Working tree has uncommitted changes. Commit or stash them before releasing.')
  }
}

async function getCurrentBranch(rootDir = process.cwd()) {
  const { stdout } = await runCommand('git', ['branch', '--show-current'], { capture: true, cwd: rootDir })
  return stdout || null
}

async function getUpstreamRef(rootDir = process.cwd()) {
  try {
    const { stdout } = await runCommand('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      capture: true,
      cwd: rootDir
    })

    return stdout || null
  } catch {
    return null
  }
}

async function ensureUpToDateWithUpstream(branch, upstreamRef, rootDir = process.cwd()) {
  if (!upstreamRef) {
    logWarning(`Branch ${branch} has no upstream configured; skipping ahead/behind checks.`)
    return
  }

  const [remoteName, ...branchParts] = upstreamRef.split('/')
  const remoteBranch = branchParts.join('/')

  if (remoteName && remoteBranch) {
    logStep(`Fetching latest updates from ${remoteName}/${remoteBranch}...`)
    try {
      await runCommand('git', ['fetch', remoteName, remoteBranch], { cwd: rootDir })
    } catch (error) {
      throw new Error(`Failed to fetch ${upstreamRef}: ${error.message}`)
    }
  }

  const aheadResult = await runCommand('git', ['rev-list', '--count', `${upstreamRef}..HEAD`], {
    capture: true,
    cwd: rootDir
  })
  const behindResult = await runCommand('git', ['rev-list', '--count', `HEAD..${upstreamRef}`], {
    capture: true,
    cwd: rootDir
  })

  const ahead = Number.parseInt(aheadResult.stdout || '0', 10)
  const behind = Number.parseInt(behindResult.stdout || '0', 10)

  if (Number.isFinite(behind) && behind > 0) {
    if (remoteName && remoteBranch) {
      logStep(`Fast-forwarding ${branch} with ${upstreamRef}...`)

      try {
        await runCommand('git', ['pull', '--ff-only', remoteName, remoteBranch], { cwd: rootDir })
      } catch (error) {
        throw new Error(
          `Unable to fast-forward ${branch} with ${upstreamRef}. Resolve conflicts manually, then rerun the release.\n${error.message}`
        )
      }

      return ensureUpToDateWithUpstream(branch, upstreamRef, rootDir)
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
  // Filter out --type flag as it's handled by zephyr CLI
  const filteredArgs = args.filter((arg) => !arg.startsWith('--type='))
  const positionals = filteredArgs.filter((arg) => !arg.startsWith('--'))
  const flags = new Set(filteredArgs.filter((arg) => arg.startsWith('--')))

  const releaseType = positionals[0] ?? 'patch'
  const skipTests = flags.has('--skip-tests')
  const skipLint = flags.has('--skip-lint')

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

  return { releaseType, skipTests, skipLint }
}

async function runLint(skipLint, rootDir = process.cwd()) {
  if (skipLint) {
    logWarning('Skipping lint because --skip-lint flag was provided.')
    return
  }

  const hasPint = await hasLaravelPint(rootDir)
  if (!hasPint) {
    logStep('Skipping lint (Laravel Pint not found).')
    return
  }

  logStep('Running Laravel Pint...')
  const pintPath = IS_WINDOWS ? 'vendor\\bin\\pint' : 'vendor/bin/pint'
  
  let dotInterval = null
  try {
    // Capture output and show dots as progress
    process.stdout.write('  ')
    dotInterval = setInterval(() => {
      process.stdout.write('.')
    }, 200)

    await runCommand('php', [pintPath], { capture: true, cwd: rootDir })

    if (dotInterval) {
      clearInterval(dotInterval)
      dotInterval = null
    }
    process.stdout.write('\n')
    logSuccess('Lint passed.')
  } catch (error) {
    // Clear dots and show error output
    if (dotInterval) {
      clearInterval(dotInterval)
      dotInterval = null
    }
    process.stdout.write('\n')
    if (error.stdout) {
      console.error(error.stdout)
    }
    if (error.stderr) {
      console.error(error.stderr)
    }
    throw error
  }
}

async function runTests(skipTests, composer, rootDir = process.cwd()) {
  if (skipTests) {
    logWarning('Skipping tests because --skip-tests flag was provided.')
    return
  }

  const hasArtisanFile = await hasArtisan(rootDir)
  const hasTestScript = hasComposerScript(composer, 'test')

  if (!hasArtisanFile && !hasTestScript) {
    logStep('Skipping tests (no artisan file or test script found).')
    return
  }

  logStep('Running test suite...')

  let dotInterval = null
  try {
    // Capture output and show dots as progress
    process.stdout.write('  ')
    dotInterval = setInterval(() => {
      process.stdout.write('.')
    }, 200)

    if (hasArtisanFile) {
      await runCommand('php', ['artisan', 'test'], { capture: true, cwd: rootDir })
    } else if (hasTestScript) {
      await runCommand('composer', ['test'], { capture: true, cwd: rootDir })
    }

    if (dotInterval) {
      clearInterval(dotInterval)
      dotInterval = null
    }
    process.stdout.write('\n')
    logSuccess('Tests passed.')
  } catch (error) {
    // Clear dots and show error output
    if (dotInterval) {
      clearInterval(dotInterval)
      dotInterval = null
    }
    process.stdout.write('\n')
    if (error.stdout) {
      console.error(error.stdout)
    }
    if (error.stderr) {
      console.error(error.stderr)
    }
    throw error
  }
}

async function bumpVersion(releaseType, rootDir = process.cwd()) {
  logStep(`Bumping composer version...`)

  const composer = await readComposer(rootDir)
  const currentVersion = composer.version || '0.0.0'

  if (!semver.valid(currentVersion)) {
    throw new Error(`Invalid current version "${currentVersion}" in composer.json. Must be a valid semver.`)
  }

  const newVersion = semver.inc(currentVersion, releaseType)
  if (!newVersion) {
    throw new Error(`Failed to calculate next ${releaseType} version from ${currentVersion}`)
  }

  composer.version = newVersion
  await writeComposer(rootDir, composer)

  logStep('Staging composer.json...')
  await runCommand('git', ['add', 'composer.json'], { cwd: rootDir })

  const commitMessage = `chore: release ${newVersion}`
  logStep('Committing version bump...')
  await runCommand('git', ['commit', '-m', commitMessage], { cwd: rootDir })

  logStep('Creating git tag...')
  await runCommand('git', ['tag', `v${newVersion}`], { cwd: rootDir })

  logSuccess(`Version updated to ${newVersion}.`)
  return { ...composer, version: newVersion }
}

async function pushChanges(rootDir = process.cwd()) {
  logStep('Pushing commits to origin...')
  await runCommand('git', ['push'], { cwd: rootDir })

  logStep('Pushing tags to origin...')
  await runCommand('git', ['push', 'origin', '--tags'], { cwd: rootDir })

  logSuccess('Git push completed.')
}

export async function releasePackagist() {
  const { releaseType, skipTests, skipLint } = parseArgs()
  const rootDir = process.cwd()

  logStep('Reading composer metadata...')
  const composer = await readComposer(rootDir)

  if (!composer.version) {
    throw new Error('composer.json does not have a version field. Add "version": "0.0.0" to composer.json.')
  }

  logStep('Checking working tree status...')
  await ensureCleanWorkingTree(rootDir)

  const branch = await getCurrentBranch(rootDir)
  if (!branch) {
    throw new Error('Unable to determine current branch.')
  }

  logStep(`Current branch: ${branch}`)
  const upstreamRef = await getUpstreamRef(rootDir)
  await ensureUpToDateWithUpstream(branch, upstreamRef, rootDir)

  await runLint(skipLint, rootDir)
  await runTests(skipTests, composer, rootDir)

  const updatedComposer = await bumpVersion(releaseType, rootDir)
  await pushChanges(rootDir)

  logSuccess(`Release workflow completed for ${composer.name}@${updatedComposer.version}.`)
  logStep('Note: Packagist will automatically detect the new git tag and update the package.')
}

