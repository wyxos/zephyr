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

const RUNCLOUD_PACKAGES = '/RunCloud/Packages'

function satisfiesVersion(actualVersionStr, requiredVersion) {
  const normalized = semver.coerce(actualVersionStr)
  const required = semver.coerce(requiredVersion)
  return normalized && required && semver.gte(normalized, required)
}

async function tryPhpPath(ssh, remoteCwd, pathOrCommand) {
  const versionCheck = await ssh.execCommand(`${pathOrCommand} -r "echo PHP_VERSION;"`, { cwd: remoteCwd })
  return versionCheck.code === 0 ? versionCheck.stdout.trim() : null
}

/**
 * Discovers PHP binaries under RunCloud Packages (e.g. /RunCloud/Packages/php84rc/bin/php).
 * Lists the directory and tries each php*rc/bin/php, returning the path that satisfies the version.
 */
async function findRunCloudPhp(ssh, remoteCwd, requiredVersion) {
  const listResult = await ssh.execCommand(`ls -1 ${RUNCLOUD_PACKAGES} 2>/dev/null || true`, { cwd: remoteCwd })
  if (listResult.code !== 0 || !listResult.stdout.trim()) {
    return null
  }
  const entries = listResult.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  // e.g. php74rc, php80rc, php84rc
  const phpDirs = entries.filter((name) => /^php\d+rc$/.test(name))
  const majorMinor = semver.major(requiredVersion) + '.' + semver.minor(requiredVersion)
  const targetSuffix = `php${majorMinor.replace('.', '')}rc` // php84rc for 8.4

  // Prefer exact match (php84rc for 8.4), then try any that might satisfy
  const toTry = phpDirs.filter((d) => d === targetSuffix).concat(phpDirs.filter((d) => d !== targetSuffix))

  for (const dir of toTry) {
    const binPath = `${RUNCLOUD_PACKAGES}/${dir}/bin/php`
    const actualVersion = await tryPhpPath(ssh, remoteCwd, binPath)
    if (actualVersion && satisfiesVersion(actualVersion, requiredVersion)) {
      return binPath
    }
  }
  return null
}

/**
 * Resolves a command (e.g. php84) via login shell so aliases are expanded; returns the path if it runs and satisfies version.
 */
async function resolveViaLoginShell(ssh, remoteCwd, commandName, requiredVersion) {
  const whichResult = await ssh.execCommand(`bash -lc 'command -v ${commandName}' 2>/dev/null || true`, { cwd: remoteCwd })
  if (whichResult.code !== 0 || !whichResult.stdout.trim()) {
    return null
  }
  const pathOrCommand = whichResult.stdout.trim()
  const actualVersion = await tryPhpPath(ssh, remoteCwd, pathOrCommand)
  if (actualVersion && satisfiesVersion(actualVersion, requiredVersion)) {
    return pathOrCommand
  }
  return null
}

/**
 * Finds the appropriate PHP binary command for a given version.
 * Tries RunCloud paths, login-shell alias resolution, then common names (php8.4, php84), then default php.
 * @param {object} ssh - SSH client instance
 * @param {string} remoteCwd - Remote working directory
 * @param {string} requiredVersion - Required PHP version (e.g., "8.4.0")
 * @returns {Promise<string>} - PHP command or path (e.g., "php8.4", "/RunCloud/Packages/php84rc/bin/php", or "php")
 */
export async function findPhpBinary(ssh, remoteCwd, requiredVersion) {
  if (!requiredVersion) {
    return 'php'
  }

  const majorMinor = semver.major(requiredVersion) + '.' + semver.minor(requiredVersion)
  const versionedPhp = `php${majorMinor.replace('.', '')}` // e.g., "php84"

  // 1. RunCloud: discover /RunCloud/Packages/php*rc/bin/php
  try {
    const runcloudPath = await findRunCloudPhp(ssh, remoteCwd, requiredVersion)
    if (runcloudPath) {
      return runcloudPath
    }
  } catch {
    // Ignore
  }

  // 2. Resolve alias via login shell (e.g. php84 -> real path)
  try {
    const resolved = await resolveViaLoginShell(ssh, remoteCwd, versionedPhp, requiredVersion)
    if (resolved) {
      return resolved
    }
    const resolvedDot = await resolveViaLoginShell(ssh, remoteCwd, `php${majorMinor}`, requiredVersion)
    if (resolvedDot) {
      return resolvedDot
    }
  } catch {
    // Ignore
  }

  // 3. Try common names in current PATH (non-login shell)
  const candidates = [`php${majorMinor}`, versionedPhp]
  for (const candidate of candidates) {
    try {
      const result = await ssh.execCommand(`command -v ${candidate}`, { cwd: remoteCwd })
      if (result.code === 0 && result.stdout.trim()) {
        const actualVersion = await tryPhpPath(ssh, remoteCwd, candidate)
        if (actualVersion && satisfiesVersion(actualVersion, requiredVersion)) {
          return candidate
        }
      }
    } catch {
      // Continue
    }
  }

  // 4. Default php
  try {
    const actualVersion = await tryPhpPath(ssh, remoteCwd, 'php')
    if (actualVersion && satisfiesVersion(actualVersion, requiredVersion)) {
      return 'php'
    }
  } catch {
    // Ignore
  }

  return 'php'
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
