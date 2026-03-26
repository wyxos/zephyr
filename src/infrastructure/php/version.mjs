import fs from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'

function normalizeComposerConstraint(constraint) {
  if (typeof constraint !== 'string') {
    return null
  }

  return constraint
    .replace(/\s*\|{1,2}\s*/g, ' || ')
    .replace(/,/g, ' ')
    .replace(/\s+@[\w.-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function getHighestVersion(versions = []) {
  return versions
    .filter((version) => semver.valid(version))
    .reduce((highest, version) => (!highest || semver.gt(version, highest) ? version : highest), null)
}

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

  const normalizedConstraint = normalizeComposerConstraint(phpRequirement)
  if (normalizedConstraint) {
    const minimumVersion = semver.minVersion(normalizedConstraint)
    if (minimumVersion) {
      return minimumVersion.version
    }
  }

  const versionMatches = [...phpRequirement.matchAll(/(\d+)\.(\d+)(?:\.(\d+))?/g)]
  if (versionMatches.length === 0) {
    return null
  }

  const versions = versionMatches
    .map(([, major, minor, patch = '0']) => semver.coerce(`${major}.${minor}.${patch}`)?.version ?? null)
    .filter(Boolean)

  return versions.length > 0 ? versions.sort(semver.compare)[0] : null
}

export function parseComposerLockPhpVersionRequirement(lock) {
  const versions = []
  const platformPhpVersion = parsePhpVersionRequirement({require: {php: lock?.platform?.php}})
  if (platformPhpVersion) {
    versions.push(platformPhpVersion)
  }

  const packages = Array.isArray(lock?.packages) ? lock.packages : []
  for (const pkg of packages) {
    const packagePhpVersion = parsePhpVersionRequirement({require: {php: pkg?.require?.php}})
    if (packagePhpVersion) {
      versions.push(packagePhpVersion)
    }
  }

  return getHighestVersion(versions)
}

/**
 * Extracts the effective minimum PHP version requirement from composer.json and composer.lock.
 * The lock file wins when runtime dependencies need a higher version than the root package declares.
 * @param {string} rootDir - Project root directory
 * @returns {Promise<string|null>} - PHP version requirement (e.g., "8.4.0") or null
 */
export async function getPhpVersionRequirement(rootDir) {
  const versions = []

  try {
    const composerPath = path.join(rootDir, 'composer.json')
    const raw = await fs.readFile(composerPath, 'utf8')
    const composer = JSON.parse(raw)
    const composerPhpVersion = parsePhpVersionRequirement(composer)
    if (composerPhpVersion) {
      versions.push(composerPhpVersion)
    }
  } catch {
    // Ignore and continue to composer.lock if present.
  }

  try {
    const lockPath = path.join(rootDir, 'composer.lock')
    const raw = await fs.readFile(lockPath, 'utf8')
    const lock = JSON.parse(raw)
    const lockPhpVersion = parseComposerLockPhpVersionRequirement(lock)
    if (lockPhpVersion) {
      versions.push(lockPhpVersion)
    }
  } catch {
    // Ignore when composer.lock is absent or unreadable.
  }

  return getHighestVersion(versions)
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

  let defaultPhpVersion = null

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
    defaultPhpVersion = actualVersion
  } catch {
    // Ignore
  }

  const defaultVersionHint = defaultPhpVersion
    ? ` The default php command reports ${defaultPhpVersion}.`
    : ''

  throw new Error(`No PHP binary satisfying ${requiredVersion} was found on the remote server.${defaultVersionHint}`)
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
