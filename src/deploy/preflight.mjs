import fs from 'node:fs/promises'
import path from 'node:path'

export async function hasPrePushHook(rootDir) {
  const hookPaths = [
    path.join(rootDir, '.git', 'hooks', 'pre-push'),
    path.join(rootDir, '.husky', 'pre-push'),
    path.join(rootDir, '.githooks', 'pre-push')
  ]

  for (const hookPath of hookPaths) {
    try {
      await fs.access(hookPath)
      const stats = await fs.stat(hookPath)
      if (stats.isFile()) {
        return true
      }
    } catch {
      // Hook doesn't exist at this path, continue checking
    }
  }

  return false
}

export async function hasLintScript(rootDir) {
  try {
    const packageJsonPath = path.join(rootDir, 'package.json')
    const raw = await fs.readFile(packageJsonPath, 'utf8')
    const packageJson = JSON.parse(raw)
    return packageJson.scripts && typeof packageJson.scripts.lint === 'string'
  } catch {
    return false
  }
}

export async function hasLaravelPint(rootDir) {
  try {
    const pintPath = path.join(rootDir, 'vendor', 'bin', 'pint')
    await fs.access(pintPath)
    const stats = await fs.stat(pintPath)
    return stats.isFile()
  } catch {
    return false
  }
}

export async function runLinting(rootDir, { runCommand, logProcessing, logSuccess, logWarning, commandExists } = {}) {
  const hasNpmLint = await hasLintScript(rootDir)
  const hasPint = await hasLaravelPint(rootDir)

  if (hasNpmLint) {
    logProcessing?.('Running npm lint...')
    await runCommand('npm', ['run', 'lint'], { cwd: rootDir })
    logSuccess?.('Linting completed.')
    return true
  }

  if (hasPint) {
    // Check if PHP is available before trying to run Pint
    if (commandExists && !commandExists('php')) {
      logWarning?.(
        'PHP is not available in PATH. Skipping Laravel Pint.\n' +
        '  To run Pint locally, ensure PHP is installed and added to your PATH.'
      )
      return false
    }

    logProcessing?.('Running Laravel Pint...')
    await runCommand('php', ['vendor/bin/pint'], { cwd: rootDir })
    logSuccess?.('Linting completed.')
    return true
  }

  return false
}

export function hasStagedChanges(statusOutput) {
  if (!statusOutput || statusOutput.length === 0) {
    return false
  }

  const lines = statusOutput.split('\n').filter((line) => line.trim().length > 0)

  return lines.some((line) => {
    const firstChar = line[0]
    return firstChar && firstChar !== ' ' && firstChar !== '?'
  })
}

export async function commitLintingChanges(rootDir, { getGitStatus, runCommand, logProcessing, logSuccess } = {}) {
  const status = await getGitStatus(rootDir)

  if (!hasStagedChanges(status)) {
    await runCommand('git', ['add', '-u'], { cwd: rootDir })
    const newStatus = await getGitStatus(rootDir)
    if (!hasStagedChanges(newStatus)) {
      return false
    }
  }

  logProcessing?.('Committing linting changes...')
  await runCommand('git', ['commit', '-m', 'style: apply linting fixes'], { cwd: rootDir })
  logSuccess?.('Linting changes committed.')
  return true
}

export async function isLocalLaravelProject(rootDir) {
  try {
    const artisanPath = path.join(rootDir, 'artisan')
    const composerPath = path.join(rootDir, 'composer.json')

    await fs.access(artisanPath)
    const composerContent = await fs.readFile(composerPath, 'utf8')
    const composerJson = JSON.parse(composerContent)

    return (
      composerJson.require &&
      typeof composerJson.require === 'object' &&
      'laravel/framework' in composerJson.require
    )
  } catch {
    return false
  }
}

