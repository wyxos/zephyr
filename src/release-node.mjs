import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { validateLocalDependencies } from './dependency-scanner.mjs'
import { writeStderr, writeStderrLine, writeStdoutLine } from './utils/output.mjs'
import { runCommand as runCommandBase, runCommandCapture as runCommandCaptureBase } from './utils/command.mjs'
import { ensureUpToDateWithUpstream, getCurrentBranch, getUpstreamRef } from './utils/git.mjs'

function logStep(message) {
  writeStdoutLine(chalk.yellow(`→ ${message}`))
}

function logSuccess(message) {
  writeStdoutLine(chalk.green(`✔ ${message}`))
}

function logWarning(message) {
  writeStderrLine(chalk.yellow(`⚠ ${message}`))
}

async function runCommand(command, args, { cwd = process.cwd(), capture = false } = {}) {
  if (capture) {
    const { stdout, stderr } = await runCommandCaptureBase(command, args, { cwd })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  }

  await runCommandBase(command, args, { cwd })
  return undefined
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

// Git helpers imported from src/utils/git.mjs

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

  try {
    await runCommand('npm', ['run', 'lint'], { cwd: rootDir })
    logSuccess('Lint passed.')
  } catch (error) {
    if (error.stdout) {
      writeStderr(error.stdout)
    }
    if (error.stderr) {
      writeStderr(error.stderr)
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

  try {
    const testRunScript = pkg?.scripts?.['test:run'] ?? ''
    const testScript = pkg?.scripts?.test ?? ''
    const usesNodeTest = (script) => /\bnode\b.*\s--test\b/.test(script)

    // Prefer test:run if available, otherwise use test with --run and --reporter flags
    if (hasScript(pkg, 'test:run')) {
      if (usesNodeTest(testRunScript)) {
        await runCommand('npm', ['run', 'test:run'], { cwd: rootDir })
      } else {
        // Pass reporter flag to test:run script
        await runCommand('npm', ['run', 'test:run', '--', '--reporter=dot'], { cwd: rootDir })
      }
    } else {
      if (usesNodeTest(testScript)) {
        await runCommand('npm', ['test'], { cwd: rootDir })
      } else {
        // For test script, pass --run and --reporter flags (works with vitest)
        await runCommand('npm', ['test', '--', '--run', '--reporter=dot'], { cwd: rootDir })
      }
    }

    logSuccess('Tests passed.')
  } catch (error) {
    if (error.stdout) {
      writeStderr(error.stdout)
    }
    if (error.stderr) {
      writeStderr(error.stderr)
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

  try {
    await runCommand('npm', ['run', 'build'], { cwd: rootDir })
    logSuccess('Build completed.')
  } catch (error) {
    if (error.stdout) {
      writeStderr(error.stdout)
    }
    if (error.stderr) {
      writeStderr(error.stderr)
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

  try {
    await runCommand('npm', ['run', 'build:lib'], { cwd: rootDir })
    logSuccess('Library built.')
  } catch (error) {
    if (error.stdout) {
      writeStderr(error.stdout)
    }
    if (error.stderr) {
      writeStderr(error.stderr)
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
      writeStderr(error.stdout)
    }
    if (error.stderr) {
      writeStderr(error.stderr)
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
    const match = homepage.match(/(?:https?:\/\/)?([^/]+)/)
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

  try {
    try {
      await runCommand('git', ['worktree', 'remove', worktreeDir, '-f'], { capture: true, cwd: rootDir })
    } catch (_error) {
      // Ignore if worktree doesn't exist
    }

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

    logSuccess('GitHub Pages deployment completed.')
  } catch (error) {
    if (error.stdout) {
      writeStderr(error.stdout)
    }
    if (error.stderr) {
      writeStderr(error.stderr)
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

    logStep('Validating dependencies...')
    await validateLocalDependencies(rootDir, (questions) => inquirer.prompt(questions), logSuccess)

    logStep('Checking working tree status...')
    await ensureCleanWorkingTree(rootDir)

    const branch = await getCurrentBranch(rootDir, { method: 'show-current' })
    if (!branch) {
      throw new Error('Unable to determine current branch.')
    }

    logStep(`Current branch: ${branch}`)
    const upstreamRef = await getUpstreamRef(rootDir)
    await ensureUpToDateWithUpstream({ branch, upstreamRef, rootDir, logStep, logWarning })

    await runLint(skipLint, pkg, rootDir)
    await runTests(skipTests, pkg, rootDir)
    await runLibBuild(skipBuild, pkg, rootDir)

    const updatedPkg = await bumpVersion(releaseType, rootDir)
    await runBuild(skipBuild, updatedPkg, rootDir)
    await pushChanges(rootDir)
    await deployGHPages(skipDeploy, updatedPkg, rootDir)

    logStep('Publishing will be handled by GitHub Actions via trusted publishing.')

    logSuccess(`Release workflow completed for ${updatedPkg.name}@${updatedPkg.version}.`)
  } catch (error) {
    writeStderrLine('\nRelease failed:')
    writeStderrLine(error.message)
    throw error
  }
}

