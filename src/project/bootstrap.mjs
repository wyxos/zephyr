import fs from 'node:fs/promises'
import path from 'node:path'

export async function ensureGitignoreEntry(rootDir, {
  projectConfigDir = '.zephyr',
  runCommand,
  logSuccess,
  logWarning
} = {}) {
  const gitignorePath = path.join(rootDir, '.gitignore')
  const targetEntry = `${projectConfigDir}/`
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
    .some((line) => line.trim() === targetEntry)

  if (hasEntry) {
    return
  }

  const updatedContent = existingContent
    ? `${existingContent.replace(/\s*$/, '')}\n${targetEntry}\n`
    : `${targetEntry}\n`

  await fs.writeFile(gitignorePath, updatedContent)
  logSuccess?.('Added .zephyr/ to .gitignore')

  let isGitRepo = false
  try {
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], {
      silent: true,
      cwd: rootDir
    })
    isGitRepo = true
  } catch (_error) {
    logWarning?.('Not a git repository; skipping commit for .gitignore update.')
  }

  if (!isGitRepo) {
    return
  }

  try {
    await runCommand('git', ['add', '.gitignore'], { cwd: rootDir })
    await runCommand('git', ['commit', '-m', 'chore: ignore zephyr config'], { cwd: rootDir })
  } catch (error) {
    if (error.exitCode === 1) {
      logWarning?.('Git commit skipped: nothing to commit or pre-commit hook prevented commit.')
    } else {
      throw error
    }
  }
}

export async function ensureProjectReleaseScript(rootDir, {
  runPrompt,
  runCommand,
  logSuccess,
  logWarning,
  releaseScriptName = 'release',
  releaseScriptCommand = 'npx @wyxos/zephyr@latest'
} = {}) {
  const packageJsonPath = path.join(rootDir, 'package.json')

  let raw
  try {
    raw = await fs.readFile(packageJsonPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }

    throw error
  }

  let packageJson
  try {
    packageJson = JSON.parse(raw)
  } catch (_error) {
    logWarning?.('Unable to parse package.json; skipping release script injection.')
    return false
  }

  const currentCommand = packageJson?.scripts?.[releaseScriptName]

  if (currentCommand && currentCommand.includes('@wyxos/zephyr')) {
    return false
  }

  const { installReleaseScript } = await runPrompt([
    {
      type: 'confirm',
      name: 'installReleaseScript',
      message: 'Add "release" script to package.json that runs "npx @wyxos/zephyr@latest"?',
      default: true
    }
  ])

  if (!installReleaseScript) {
    return false
  }

  if (!packageJson.scripts || typeof packageJson.scripts !== 'object') {
    packageJson.scripts = {}
  }

  packageJson.scripts[releaseScriptName] = releaseScriptCommand

  const updatedPayload = `${JSON.stringify(packageJson, null, 2)}\n`
  await fs.writeFile(packageJsonPath, updatedPayload)
  logSuccess?.('Added release script to package.json.')

  let isGitRepo = false

  try {
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootDir, silent: true })
    isGitRepo = true
  } catch (_error) {
    logWarning?.('Not a git repository; skipping commit for release script addition.')
  }

  if (isGitRepo) {
    try {
      await runCommand('git', ['add', 'package.json'], { cwd: rootDir, silent: true })
      await runCommand('git', ['commit', '-m', 'chore: add zephyr release script'], { cwd: rootDir, silent: true })
      logSuccess?.('Committed package.json release script addition.')
    } catch (error) {
      if (error.exitCode === 1) {
        logWarning?.('Git commit skipped: nothing to commit or pre-commit hook prevented commit.')
      } else {
        throw error
      }
    }
  }

  return true
}

