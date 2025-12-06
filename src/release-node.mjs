import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

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

async function readPackage(rootDir = process.cwd()) {
  const packagePath = join(rootDir, 'package.json')
  const raw = await readFile(packagePath, 'utf8')
  return JSON.parse(raw)
}

function hasScript(pkg, scriptName) {
  return pkg?.scripts?.[scriptName] !== undefined
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
      await runCommand('git', ['fetch', remoteName, remoteBranch], { capture: true, cwd: rootDir })
    } catch (error) {
      if (error.stderr) {
        console.error(error.stderr)
      }
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
        await runCommand('git', ['pull', '--ff-only', remoteName, remoteBranch], { capture: true, cwd: rootDir })
      } catch (error) {
        if (error.stderr) {
          console.error(error.stderr)
        }
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
  const skipBuild = flags.has('--skip-build')
  const skipDeploy = flags.has('--skip-deploy')

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

  return { releaseType, skipTests, skipLint, skipBuild, skipDeploy }
}

async function runLint(skipLint, pkg, rootDir = process.cwd()) {
  if (skipLint) {
    logWarning('Skipping lint because --skip-lint flag was provided.')
    return
  }

  if (!hasScript(pkg, 'lint')) {
    logStep('Skipping lint (no lint script found in package.json).')
    return
  }

  logStep('Running lint...')

  let dotInterval = null
  try {
    // Capture output and show dots as progress
    process.stdout.write('  ')
    dotInterval = setInterval(() => {
      process.stdout.write('.')
    }, 200)

    await runCommand('npm', ['run', 'lint'], { capture: true, cwd: rootDir })

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

async function runTests(skipTests, pkg, rootDir = process.cwd()) {
  if (skipTests) {
    logWarning('Skipping tests because --skip-tests flag was provided.')
    return
  }

  // Check for test:run or test script
  if (!hasScript(pkg, 'test:run') && !hasScript(pkg, 'test')) {
    logStep('Skipping tests (no test or test:run script found in package.json).')
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

    // Prefer test:run if available, otherwise use test with --run flag
    if (hasScript(pkg, 'test:run')) {
      await runCommand('npm', ['run', 'test:run'], { capture: true, cwd: rootDir })
    } else {
      // For test script, try to pass --run flag (works with vitest)
      await runCommand('npm', ['test', '--', '--run'], { capture: true, cwd: rootDir })
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

async function runBuild(skipBuild, pkg, rootDir = process.cwd()) {
  if (skipBuild) {
    logWarning('Skipping build because --skip-build flag was provided.')
    return
  }

  if (!hasScript(pkg, 'build')) {
    logStep('Skipping build (no build script found in package.json).')
    return
  }

  logStep('Building project...')

  let dotInterval = null
  try {
    // Capture output and show dots as progress
    process.stdout.write('  ')
    dotInterval = setInterval(() => {
      process.stdout.write('.')
    }, 200)

    await runCommand('npm', ['run', 'build'], { capture: true, cwd: rootDir })

    if (dotInterval) {
      clearInterval(dotInterval)
      dotInterval = null
    }
    process.stdout.write('\n')
    logSuccess('Build completed.')
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

async function runLibBuild(skipBuild, pkg, rootDir = process.cwd()) {
  if (skipBuild) {
    logWarning('Skipping library build because --skip-build flag was provided.')
    return
  }

  if (!hasScript(pkg, 'build:lib')) {
    logStep('Skipping library build (no build:lib script found in package.json).')
    return false
  }

  logStep('Building library...')

  let dotInterval = null
  try {
    // Capture output and show dots as progress
    process.stdout.write('  ')
    dotInterval = setInterval(() => {
      process.stdout.write('.')
    }, 200)

    await runCommand('npm', ['run', 'build:lib'], { capture: true, cwd: rootDir })

    if (dotInterval) {
      clearInterval(dotInterval)
      dotInterval = null
    }
    process.stdout.write('\n')
    logSuccess('Library built.')
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

  // Check for lib changes and commit them if any
  const { stdout: statusAfterBuild } = await runCommand('git', ['status', '--porcelain'], { capture: true, cwd: rootDir })
  const hasLibChanges = statusAfterBuild.split('\n').some(line => {
    const trimmed = line.trim()
    return trimmed.includes('lib/') && (trimmed.startsWith('M') || trimmed.startsWith('??') || trimmed.startsWith('A') || trimmed.startsWith('D'))
  })

  if (hasLibChanges) {
    logStep('Committing lib build artifacts...')
    await runCommand('git', ['add', 'lib/'], { capture: true, cwd: rootDir })
    await runCommand('git', ['commit', '-m', 'chore: build lib artifacts'], { capture: true, cwd: rootDir })
    logSuccess('Lib build artifacts committed.')
  }

  return hasLibChanges
}

async function ensureNpmAuth(rootDir = process.cwd()) {
  logStep('Confirming npm authentication...')
  try {
    const result = await runCommand('npm', ['whoami'], { capture: true, cwd: rootDir })
    // Only show username if we captured it, otherwise just show success
    if (result?.stdout) {
      // Silently authenticated - we don't need to show the username
    }
    logSuccess('npm authenticated.')
  } catch (error) {
    if (error.stderr) {
      console.error(error.stderr)
    }
    throw error
  }
}

async function bumpVersion(releaseType, rootDir = process.cwd()) {
  logStep(`Bumping package version...`)

  // Lib changes should already be committed by runLibBuild, but check anyway
  const { stdout: statusBefore } = await runCommand('git', ['status', '--porcelain'], { capture: true, cwd: rootDir })
  const hasLibChanges = statusBefore.split('\n').some(line => {
    const trimmed = line.trim()
    return trimmed.includes('lib/') && (trimmed.startsWith('M') || trimmed.startsWith('??') || trimmed.startsWith('A') || trimmed.startsWith('D'))
  })

  if (hasLibChanges) {
    logStep('Stashing lib build artifacts...')
    await runCommand('git', ['stash', 'push', '-u', '-m', 'temp: lib build artifacts', 'lib/'], { capture: true, cwd: rootDir })
  }

  try {
    // npm version will update package.json and create a commit with default message
    const result = await runCommand('npm', ['version', releaseType], { capture: true, cwd: rootDir })
    // Extract version from output (e.g., "v0.2.8" or "0.2.8")
    if (result?.stdout) {
      const versionMatch = result.stdout.match(/v?(\d+\.\d+\.\d+)/)
      if (versionMatch) {
        // Version is shown in the logSuccess message below, no need to show it here
      }
    }
  } finally {
    // Restore lib changes and ensure they're in the commit
    if (hasLibChanges) {
      logStep('Restoring lib build artifacts...')
      await runCommand('git', ['stash', 'pop'], { capture: true, cwd: rootDir })
      await runCommand('git', ['add', 'lib/'], { capture: true, cwd: rootDir })
      const { stdout: statusAfter } = await runCommand('git', ['status', '--porcelain'], { capture: true, cwd: rootDir })
      if (statusAfter.includes('lib/')) {
        await runCommand('git', ['commit', '--amend', '--no-edit'], { capture: true, cwd: rootDir })
      }
    }
  }

  const pkg = await readPackage(rootDir)
  const commitMessage = `chore: release ${pkg.version}`

  // Amend the commit message to use our custom format
  await runCommand('git', ['commit', '--amend', '-m', commitMessage], { capture: true, cwd: rootDir })

  logSuccess(`Version updated to ${pkg.version}.`)
  return pkg
}

async function pushChanges(rootDir = process.cwd()) {
  logStep('Pushing commits and tags to origin...')
  try {
    await runCommand('git', ['push', '--follow-tags'], { capture: true, cwd: rootDir })
    logSuccess('Git push completed.')
  } catch (error) {
    if (error.stdout) {
      console.error(error.stdout)
    }
    if (error.stderr) {
      console.error(error.stderr)
    }
    throw error
  }
}

async function publishPackage(pkg, rootDir = process.cwd()) {
  const publishArgs = ['publish', '--ignore-scripts'] // Skip prepublishOnly since we already built lib

  if (pkg.name.startsWith('@')) {
    // For scoped packages, determine access level from publishConfig
    // Default to 'public' for scoped packages if not specified (free npm accounts require public for scoped packages)
    const access = pkg.publishConfig?.access || 'public'
    publishArgs.push('--access', access)
  }

  logStep(`Publishing ${pkg.name}@${pkg.version} to npm...`)
  try {
    await runCommand('npm', publishArgs, { capture: true, cwd: rootDir })
    logSuccess('npm publish completed.')
  } catch (error) {
    if (error.stdout) {
      console.error(error.stdout)
    }
    if (error.stderr) {
      console.error(error.stderr)
    }
    throw error
  }
}

function extractDomainFromHomepage(homepage) {
  if (!homepage) return null
  try {
    const url = new URL(homepage)
    return url.hostname
  } catch {
    // If it's not a valid URL, try to extract domain from string
    const match = homepage.match(/(?:https?:\/\/)?([^\/]+)/)
    return match ? match[1] : null
  }
}

async function deployGHPages(skipDeploy, pkg, rootDir = process.cwd()) {
  if (skipDeploy) {
    logWarning('Skipping GitHub Pages deployment because --skip-deploy flag was provided.')
    return
  }

  // Check if dist directory exists (indicates build output for deployment)
  const distPath = path.join(rootDir, 'dist')
  let distExists = false
  try {
    const stats = await fs.promises.stat(distPath)
    distExists = stats.isDirectory()
  } catch {
    distExists = false
  }

  if (!distExists) {
    logStep('Skipping GitHub Pages deployment (no dist directory found).')
    return
  }

  logStep('Deploying to GitHub Pages...')

  // Write CNAME file to dist if homepage is set
  const cnamePath = path.join(distPath, 'CNAME')

  if (pkg.homepage) {
    const domain = extractDomainFromHomepage(pkg.homepage)
    if (domain) {
      try {
        await fs.promises.mkdir(distPath, { recursive: true })
        await fs.promises.writeFile(cnamePath, domain)
      } catch (error) {
        logWarning(`Could not write CNAME file: ${error.message}`)
      }
    }
  }

  const worktreeDir = path.resolve(rootDir, '.gh-pages')

  let dotInterval = null
  try {
    // Capture output and show dots as progress
    process.stdout.write('  ')
    dotInterval = setInterval(() => {
      process.stdout.write('.')
    }, 200)

    try {
      await runCommand('git', ['worktree', 'remove', worktreeDir, '-f'], { capture: true, cwd: rootDir })
    } catch { }

    try {
      await runCommand('git', ['worktree', 'add', worktreeDir, 'gh-pages'], { capture: true, cwd: rootDir })
    } catch {
      await runCommand('git', ['worktree', 'add', worktreeDir, '-b', 'gh-pages'], { capture: true, cwd: rootDir })
    }

    await runCommand('git', ['-C', worktreeDir, 'config', 'user.name', 'wyxos'], { capture: true })
    await runCommand('git', ['-C', worktreeDir, 'config', 'user.email', 'github@wyxos.com'], { capture: true })

    // Clear worktree directory
    for (const entry of fs.readdirSync(worktreeDir)) {
      if (entry === '.git') continue
      const target = path.join(worktreeDir, entry)
      fs.rmSync(target, { recursive: true, force: true })
    }

    // Copy dist to worktree
    fs.cpSync(distPath, worktreeDir, { recursive: true })

    await runCommand('git', ['-C', worktreeDir, 'add', '-A'], { capture: true })
    await runCommand('git', ['-C', worktreeDir, 'commit', '-m', `deploy: demo ${new Date().toISOString()}`, '--allow-empty'], { capture: true })
    await runCommand('git', ['-C', worktreeDir, 'push', '-f', 'origin', 'gh-pages'], { capture: true })

    if (dotInterval) {
      clearInterval(dotInterval)
      dotInterval = null
    }
    process.stdout.write('\n')
    logSuccess('GitHub Pages deployment completed.')
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

export async function releaseNode() {
  try {
    const { releaseType, skipTests, skipLint, skipBuild, skipDeploy } = parseArgs()
    const rootDir = process.cwd()

    logStep('Reading package metadata...')
    const pkg = await readPackage(rootDir)

    logStep('Checking working tree status...')
    await ensureCleanWorkingTree(rootDir)

    const branch = await getCurrentBranch(rootDir)
    if (!branch) {
      throw new Error('Unable to determine current branch.')
    }

    logStep(`Current branch: ${branch}`)
    const upstreamRef = await getUpstreamRef(rootDir)
    await ensureUpToDateWithUpstream(branch, upstreamRef, rootDir)

    await runLint(skipLint, pkg, rootDir)
    await runTests(skipTests, pkg, rootDir)
    await runBuild(skipBuild, pkg, rootDir)
    await runLibBuild(skipBuild, pkg, rootDir)
    await ensureNpmAuth(rootDir)

    const updatedPkg = await bumpVersion(releaseType, rootDir)
    await pushChanges(rootDir)
    await publishPackage(updatedPkg, rootDir)
    await deployGHPages(skipDeploy, updatedPkg, rootDir)

    logSuccess(`Release workflow completed for ${updatedPkg.name}@${updatedPkg.version}.`)
  } catch (error) {
    console.error('\nRelease failed:')
    console.error(error.message)
    throw error
  }
}

