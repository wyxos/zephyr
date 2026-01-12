import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'
import chalk from 'chalk'

const IS_WINDOWS = process.platform === 'win32'

function isLocalPathOutsideRepo(depPath, rootDir) {
  if (!depPath || typeof depPath !== 'string') {
    return false
  }

  // Remove file: prefix if present
  let cleanPath = depPath
  if (depPath.startsWith('file:')) {
    cleanPath = depPath.slice(5)
  }

  // Resolve the path relative to the root directory
  const resolvedPath = path.resolve(rootDir, cleanPath)
  const resolvedRoot = path.resolve(rootDir)

  // Normalize paths to handle different separators
  const normalizedResolved = path.normalize(resolvedPath)
  const normalizedRoot = path.normalize(resolvedRoot)

  // If paths are equal, it's not outside
  if (normalizedResolved === normalizedRoot) {
    return false
  }

  // Check if resolved path is outside the repository root
  // Use path.relative to check if the path goes outside
  const relative = path.relative(normalizedRoot, normalizedResolved)
  
  // If relative path starts with .., it's outside the repo
  // Also check if the resolved path doesn't start with the root + separator (for absolute paths)
  return relative.startsWith('..') || !normalizedResolved.startsWith(normalizedRoot + path.sep)
}

async function scanPackageJsonDependencies(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json')
  const localDeps = []

  try {
    const raw = await readFile(packageJsonPath, 'utf8')
    const pkg = JSON.parse(raw)

    const checkDeps = (deps, field) => {
      if (!deps || typeof deps !== 'object') {
        return
      }

      for (const [packageName, version] of Object.entries(deps)) {
        if (typeof version === 'string' && version.startsWith('file:')) {
          if (isLocalPathOutsideRepo(version, rootDir)) {
            localDeps.push({
              packageName,
              path: version,
              field
            })
          }
        }
      }
    }

    checkDeps(pkg.dependencies, 'dependencies')
    checkDeps(pkg.devDependencies, 'devDependencies')

    return localDeps
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function scanComposerJsonDependencies(rootDir) {
  const composerJsonPath = path.join(rootDir, 'composer.json')
  const localDeps = []

  try {
    const raw = await readFile(composerJsonPath, 'utf8')
    const composer = JSON.parse(raw)

    // Check repositories field for local path repositories
    if (composer.repositories && Array.isArray(composer.repositories)) {
      for (const repo of composer.repositories) {
        if (repo.type === 'path' && repo.url) {
          if (isLocalPathOutsideRepo(repo.url, rootDir)) {
            // Try to find which package uses this repository
            // Check require and require-dev for packages that might use this repo
            const repoPath = path.basename(repo.url.replace(/\/$/, ''))
            const possiblePackages = []

            const checkRequire = (requireObj, field) => {
              if (!requireObj || typeof requireObj !== 'object') {
                return
              }
              for (const [packageName] of Object.entries(requireObj)) {
                // If package name matches the repo path or contains it, it's likely using this repo
                if (packageName.includes(repoPath) || repoPath.includes(packageName.split('/').pop())) {
                  possiblePackages.push({ packageName, field })
                }
              }
            }

            checkRequire(composer.require, 'require')
            checkRequire(composer['require-dev'], 'require-dev')

            if (possiblePackages.length > 0) {
              for (const { packageName, field } of possiblePackages) {
                localDeps.push({
                  packageName,
                  path: repo.url,
                  field
                })
              }
            } else {
              // If we can't determine which package, still report the repository
              localDeps.push({
                packageName: repo.url,
                path: repo.url,
                field: 'repositories'
              })
            }
          }
        }
      }
    }

    return localDeps
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function fetchLatestNpmVersion(packageName) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`)
    if (!response.ok) {
      return null
    }
    const data = await response.json()
    return data.version || null
  } catch (_error) {
    return null
  }
}

async function fetchLatestPackagistVersion(packageName) {
  try {
    // Packagist API v2 format
    const response = await fetch(`https://repo.packagist.org/p2/${packageName}.json`)
    if (!response.ok) {
      return null
    }
    const data = await response.json()
    if (data.packages && data.packages[packageName] && data.packages[packageName].length > 0) {
      // Get the latest version (first in array is usually latest)
      const latest = data.packages[packageName][0]
      return latest.version || null
    }
    return null
  } catch (_error) {
    return null
  }
}

async function updatePackageJsonDependency(rootDir, packageName, newVersion, field) {
  const packageJsonPath = path.join(rootDir, 'package.json')
  const raw = await readFile(packageJsonPath, 'utf8')
  const pkg = JSON.parse(raw)

  if (!pkg[field]) {
    pkg[field] = {}
  }

  pkg[field][packageName] = `^${newVersion}`

  const updatedContent = JSON.stringify(pkg, null, 2) + '\n'
  await writeFile(packageJsonPath, updatedContent, 'utf8')
}

async function updateComposerJsonDependency(rootDir, packageName, newVersion, field) {
  const composerJsonPath = path.join(rootDir, 'composer.json')
  const raw = await readFile(composerJsonPath, 'utf8')
  const composer = JSON.parse(raw)

  if (field === 'repositories') {
    // Remove the local repository entry
    if (composer.repositories && Array.isArray(composer.repositories)) {
      composer.repositories = composer.repositories.filter(
        (repo) => !(repo.type === 'path' && repo.url === packageName)
      )
    }
    // Update the dependency version in require or require-dev
    // We need to find which field contains this package
    if (composer.require && composer.require[packageName]) {
      composer.require[packageName] = `^${newVersion}`
    } else if (composer['require-dev'] && composer['require-dev'][packageName]) {
      composer['require-dev'][packageName] = `^${newVersion}`
    }
  } else {
    if (!composer[field]) {
      composer[field] = {}
    }
    composer[field][packageName] = `^${newVersion}`
  }

  const updatedContent = JSON.stringify(composer, null, 2) + '\n'
  await writeFile(composerJsonPath, updatedContent, 'utf8')
}

async function runCommand(command, args, { cwd = process.cwd(), capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const resolvedCommand = IS_WINDOWS && (command === 'npm' || command === 'npx' || command === 'pnpm' || command === 'yarn')
      ? `${command}.cmd`
      : command

    const spawnOptions = {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      cwd
    }

    const child = spawn(resolvedCommand, args, spawnOptions)
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
        const error = new Error(`Command failed (${code}): ${resolvedCommand} ${args.join(' ')}`)
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

async function getGitStatus(rootDir) {
  try {
    const result = await runCommand('git', ['status', '--porcelain'], { capture: true, cwd: rootDir })
    return result.stdout || ''
  } catch (_error) {
    return ''
  }
}

function hasStagedChanges(statusOutput) {
  if (!statusOutput || statusOutput.length === 0) {
    return false
  }

  const lines = statusOutput.split('\n').filter((line) => line.trim().length > 0)

  return lines.some((line) => {
    const firstChar = line[0]
    return firstChar && firstChar !== ' ' && firstChar !== '?'
  })
}

async function commitDependencyUpdates(rootDir, updatedFiles, promptFn, logFn) {
  try {
    // Check if we're in a git repository
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { capture: true, cwd: rootDir })
  } catch {
    // Not a git repository, skip commit
    return false
  }

  const statusBefore = await getGitStatus(rootDir)

  // Avoid accidentally committing unrelated staged changes
  if (hasStagedChanges(statusBefore)) {
    if (logFn) {
      logFn('Staged changes detected. Skipping auto-commit of dependency updates.')
    }
    return false
  }

  const fileList = updatedFiles.map((f) => path.basename(f)).join(', ')

  const { shouldCommit } = await promptFn([
    {
      type: 'confirm',
      name: 'shouldCommit',
      message: `Commit dependency updates now? (${fileList})`,
      default: true
    }
  ])

  if (!shouldCommit) {
    return false
  }

  // Stage the updated files
  for (const file of updatedFiles) {
    try {
      await runCommand('git', ['add', file], { cwd: rootDir })
    } catch {
      // File might not exist or not be tracked, continue
    }
  }

  const newStatus = await getGitStatus(rootDir)
  if (!hasStagedChanges(newStatus)) {
    return false
  }

  // Build commit message
  const commitMessage = `chore: update local file dependencies to online versions (${fileList})`

  if (logFn) {
    logFn('Committing dependency updates...')
  }

  await runCommand('git', ['commit', '-m', commitMessage], { cwd: rootDir })

  if (logFn) {
    logFn('Dependency updates committed.')
  }

  return true
}

async function validateLocalDependencies(rootDir, promptFn, logFn = null) {
  const packageDeps = await scanPackageJsonDependencies(rootDir)
  const composerDeps = await scanComposerJsonDependencies(rootDir)

  const allDeps = [...packageDeps, ...composerDeps]

  if (allDeps.length === 0) {
    return
  }

  // Fetch latest versions for all dependencies
  const depsWithVersions = await Promise.all(
    allDeps.map(async (dep) => {
      let latestVersion = null
      if (dep.field === 'dependencies' || dep.field === 'devDependencies') {
        latestVersion = await fetchLatestNpmVersion(dep.packageName)
      } else if (dep.field === 'require' || dep.field === 'require-dev') {
        latestVersion = await fetchLatestPackagistVersion(dep.packageName)
      } else if (dep.field === 'repositories') {
        // For repositories, try to extract package name and fetch from Packagist
        // The packageName might be the path, so we need to handle this differently
        // For now, we'll show the path but can't fetch version
      }

      return {
        ...dep,
        latestVersion
      }
    })
  )

  // Build warning messages with colored output (danger color for package name and version)
  const messages = depsWithVersions.map((dep) => {
    const packageNameColored = chalk.red(dep.packageName)
    const pathColored = chalk.dim(dep.path)
    const versionInfo = dep.latestVersion
      ? ` Latest version available: ${chalk.red(dep.latestVersion)}.`
      : ' Latest version could not be determined.'
    return `Dependency ${packageNameColored} is pointing to a local path outside the repository: ${pathColored}.${versionInfo}`
  })

  // Build the prompt message with colored count (danger color)
  const countColored = chalk.red(allDeps.length)
  const countText = allDeps.length === 1 ? 'dependency' : 'dependencies'
  const promptMessage = `Found ${countColored} local file ${countText} pointing outside the repository:\n\n${messages.join('\n\n')}\n\nUpdate to latest version?`

  // Prompt user
  const { shouldUpdate } = await promptFn([
    {
      type: 'confirm',
      name: 'shouldUpdate',
      message: promptMessage,
      default: true
    }
  ])

  if (!shouldUpdate) {
    throw new Error('Release cancelled: local file dependencies must be updated before release.')
  }

  // Track which files were updated
  const updatedFiles = new Set()

  // Update dependencies
  for (const dep of depsWithVersions) {
    if (!dep.latestVersion) {
      continue
    }

    if (dep.field === 'dependencies' || dep.field === 'devDependencies') {
      await updatePackageJsonDependency(rootDir, dep.packageName, dep.latestVersion, dep.field)
      updatedFiles.add('package.json')
    } else if (dep.field === 'require' || dep.field === 'require-dev') {
      await updateComposerJsonDependency(rootDir, dep.packageName, dep.latestVersion, dep.field)
      updatedFiles.add('composer.json')
    } else if (dep.field === 'repositories') {
      // For repositories, we need to remove the repository entry
      // But we still need to update the dependency version
      // This is more complex, so for now we'll just update if we can find the package
      const composerJsonPath = path.join(rootDir, 'composer.json')
      const raw = await readFile(composerJsonPath, 'utf8')
      const composer = JSON.parse(raw)

      // Try to find which package uses this repository
      let packageToUpdate = null
      let fieldToUpdate = null

      if (composer.require) {
        for (const [pkgName] of Object.entries(composer.require)) {
          if (pkgName.includes(dep.packageName.split('/').pop()) || dep.packageName.includes(pkgName.split('/').pop())) {
            packageToUpdate = pkgName
            fieldToUpdate = 'require'
            break
          }
        }
      }

      if (!packageToUpdate && composer['require-dev']) {
        for (const [pkgName] of Object.entries(composer['require-dev'])) {
          if (pkgName.includes(dep.packageName.split('/').pop()) || dep.packageName.includes(pkgName.split('/').pop())) {
            packageToUpdate = pkgName
            fieldToUpdate = 'require-dev'
            break
          }
        }
      }

      if (packageToUpdate && fieldToUpdate) {
        await updateComposerJsonDependency(rootDir, packageToUpdate, dep.latestVersion, fieldToUpdate)
        // Also remove the repository entry
        const updatedRaw = await readFile(composerJsonPath, 'utf8')
        const updatedComposer = JSON.parse(updatedRaw)
        if (updatedComposer.repositories && Array.isArray(updatedComposer.repositories)) {
          updatedComposer.repositories = updatedComposer.repositories.filter(
            (repo) => !(repo.type === 'path' && repo.url === dep.path)
          )
          const updatedContent = JSON.stringify(updatedComposer, null, 2) + '\n'
          await writeFile(composerJsonPath, updatedContent, 'utf8')
        }
        updatedFiles.add('composer.json')
      }
    }
  }

  // Commit the changes if any files were updated
  if (updatedFiles.size > 0) {
    await commitDependencyUpdates(rootDir, Array.from(updatedFiles), promptFn, logFn)
  }
}

export {
  scanPackageJsonDependencies,
  scanComposerJsonDependencies,
  fetchLatestNpmVersion,
  fetchLatestPackagistVersion,
  updatePackageJsonDependency,
  updateComposerJsonDependency,
  isLocalPathOutsideRepo,
  validateLocalDependencies
}
