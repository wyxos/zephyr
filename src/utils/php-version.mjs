import fs from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'

/**
 * Extracts the minimum PHP version requirement from a composer.json object
 * @param {object} composer - Parsed composer.json object
 * @returns {string|null} - PHP version requirement (e.g., "8.4.0") or null
 */
export function parsePhpVersionRequirement(composer) {
  const phpRequirement = composer?.require?.php || composer?.['require-dev']?.php
  if (!phpRequirement) {
    return null
  }

  // Parse version constraint (e.g., "^8.4", ">=8.4.0", "8.4.*", "~8.4.0")
  // Extract the minimum version needed
  const versionMatch = phpRequirement.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!versionMatch) {
    return null
  }

  const major = versionMatch[1]
  const minor = versionMatch[2]
  const patch = versionMatch[3] || '0'
  
  const versionStr = `${major}.${minor}.${patch}`
  
  // Normalize to semver format
  if (semver.valid(versionStr)) {
    return versionStr
  }
  
  // Try to coerce to valid semver
  const coerced = semver.coerce(versionStr)
  if (coerced) {
    return coerced.version
  }

  return null
}

/**
 * Extracts the minimum PHP version requirement from composer.json file
 * @param {string} rootDir - Project root directory
 * @returns {Promise<string|null>} - PHP version requirement (e.g., "8.4.0") or null
 */
export async function getPhpVersionRequirement(rootDir) {
  try {
    const composerPath = path.join(rootDir, 'composer.json')
    const raw = await fs.readFile(composerPath, 'utf8')
    const composer = JSON.parse(raw)
    return parsePhpVersionRequirement(composer)
  } catch {
    return null
  }
}

/**
 * Finds the appropriate PHP binary command for a given version
 * Tries common patterns: php8.4, php8.3, etc.
 * @param {object} ssh - SSH client instance
 * @param {string} remoteCwd - Remote working directory
 * @param {string} requiredVersion - Required PHP version (e.g., "8.4.0")
 * @returns {Promise<string>} - PHP command prefix (e.g., "php8.4" or "php")
 */
export async function findPhpBinary(ssh, remoteCwd, requiredVersion) {
  if (!requiredVersion) {
    return 'php'
  }

  // Extract major.minor version (e.g., "8.4" from "8.4.0")
  const majorMinor = semver.major(requiredVersion) + '.' + semver.minor(requiredVersion)
  const versionedPhp = `php${majorMinor.replace('.', '')}` // e.g., "php84"

  // Try versioned PHP binary first (e.g., php8.4, php84)
  const candidates = [
    `php${majorMinor}`, // php8.4
    versionedPhp, // php84
    'php' // fallback
  ]

  for (const candidate of candidates) {
    try {
      const result = await ssh.execCommand(`command -v ${candidate}`, { cwd: remoteCwd })
      if (result.code === 0 && result.stdout.trim()) {
        // Verify it's actually the right version
        const versionCheck = await ssh.execCommand(`${candidate} -r "echo PHP_VERSION;"`, { cwd: remoteCwd })
        if (versionCheck.code === 0) {
          const actualVersion = versionCheck.stdout.trim()
          // Normalize version and check if it satisfies the requirement
          const normalizedVersion = semver.coerce(actualVersion)
          if (normalizedVersion && semver.gte(normalizedVersion, semver.coerce(requiredVersion))) {
            return candidate
          }
        }
      }
    } catch {
      // Continue to next candidate
    }
  }

  // Fallback: try to use default php and check version
  try {
    const versionCheck = await ssh.execCommand('php -r "echo PHP_VERSION;"', { cwd: remoteCwd })
    if (versionCheck.code === 0) {
      const actualVersion = versionCheck.stdout.trim()
      const normalizedVersion = semver.coerce(actualVersion)
      if (normalizedVersion && semver.gte(normalizedVersion, semver.coerce(requiredVersion))) {
        return 'php'
      }
    }
  } catch {
    // Ignore
  }

  // If we can't find a suitable version, return the versioned command anyway
  // The error will be clearer when the command fails
  return `php${majorMinor}`
}

/**
 * Gets the PHP command prefix for use in commands
 * @param {object} ssh - SSH client instance
 * @param {string} remoteCwd - Remote working directory
 * @param {string} rootDir - Local project root directory
 * @returns {Promise<string>} - PHP command prefix (e.g., "php8.4" or "php")
 */
export async function getPhpCommandPrefix(ssh, remoteCwd, rootDir) {
  const requiredVersion = await getPhpVersionRequirement(rootDir)
  
  if (!requiredVersion) {
    return 'php'
  }

  return await findPhpBinary(ssh, remoteCwd, requiredVersion)
}
