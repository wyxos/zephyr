import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'
import semver from 'semver'

const IS_WINDOWS = process.platform === 'win32'

async function getCurrentVersion() {
  try {
    // Try to get version from package.json
    // When running via npx, the package.json is in the installed package directory
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json'
    )
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    return packageJson.version
  } catch (_error) {
    // If we can't read package.json, return null
    return null
  }
}

async function getLatestVersion() {
  try {
    const response = await fetch('https://registry.npmjs.org/@wyxos/zephyr/latest')
    if (!response.ok) {
      return null
    }
    const data = await response.json()
    return data.version || null
  } catch (_error) {
    return null
  }
}

function isNewerVersionAvailable(current, latest) {
  if (!current || !latest) {
    return false
  }

  // Use semver to properly compare versions
  try {
    return semver.gt(latest, current)
  } catch (_error) {
    // If semver comparison fails, fall back to simple string comparison
    return latest !== current
  }
}

async function reExecuteWithLatest(args) {
  // Re-execute with npx @wyxos/zephyr@latest
  const command = IS_WINDOWS ? 'npx.cmd' : 'npx'
  const npxArgs = ['@wyxos/zephyr@latest', ...args]

  return new Promise((resolve, reject) => {
    const child = spawn(command, npxArgs, {
      stdio: 'inherit',
      shell: IS_WINDOWS
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Command exited with code ${code}`))
      }
    })
  })
}

export async function checkAndUpdateVersion(promptFn, args) {
  try {
    // Skip check if already running @latest (detected via environment or process)
    // When npx runs @latest, the version should already be latest
    const isRunningLatest = process.env.npm_config_user_config?.includes('@latest') ||
                           process.argv.some(arg => arg.includes('@latest'))

    if (isRunningLatest) {
      return false
    }

    const currentVersion = await getCurrentVersion()
    if (!currentVersion) {
      // Can't determine current version, skip check
      return false
    }

    const latestVersion = await getLatestVersion()
    if (!latestVersion) {
      // Can't fetch latest version, skip check
      return false
    }

    if (!isNewerVersionAvailable(currentVersion, latestVersion)) {
      // Already on latest or newer
      return false
    }

    // Newer version available, prompt user
    const { shouldUpdate } = await promptFn([
      {
        type: 'confirm',
        name: 'shouldUpdate',
        message: `A new version of @wyxos/zephyr is available (${latestVersion}). You are currently on ${currentVersion}. Update and continue?`,
        default: true
      }
    ])

    if (!shouldUpdate) {
      return false
    }

    // User confirmed, re-execute with latest version
    await reExecuteWithLatest(args)
    return true // Indicates we've re-executed, so the current process should exit
  } catch (_error) {
    // If version check fails, just continue with current version
    // Don't block the user from using the tool
    return false
  }
}
