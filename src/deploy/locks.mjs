import fs from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'

import { PROJECT_LOCK_FILE, ensureDirectory, getLockFilePath, getProjectConfigDir } from '../utils/paths.mjs'

function createLockPayload() {
  return {
    user: os.userInfo().username,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString()
  }
}

export async function acquireLocalLock(rootDir) {
  const lockPath = getLockFilePath(rootDir)
  const configDir = getProjectConfigDir(rootDir)
  await ensureDirectory(configDir)

  const payload = createLockPayload()
  const payloadJson = JSON.stringify(payload, null, 2)
  await fs.writeFile(lockPath, payloadJson, 'utf8')

  return payload
}

export async function releaseLocalLock(rootDir, { logWarning } = {}) {
  const lockPath = getLockFilePath(rootDir)
  try {
    await fs.unlink(lockPath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logWarning?.(`Failed to remove local lock file: ${error.message}`)
    }
  }
}

export async function readLocalLock(rootDir) {
  const lockPath = getLockFilePath(rootDir)
  try {
    const content = await fs.readFile(lockPath, 'utf8')
    return JSON.parse(content)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function readRemoteLock(ssh, remoteCwd) {
  const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
  const escapedLockPath = lockPath.replace(/'/g, "'\\''")
  const checkCommand = `mkdir -p .zephyr && if [ -f '${escapedLockPath}' ]; then cat '${escapedLockPath}'; else echo "LOCK_NOT_FOUND"; fi`

  const checkResult = await ssh.execCommand(checkCommand, { cwd: remoteCwd })

  if (checkResult.stdout && checkResult.stdout.trim() !== 'LOCK_NOT_FOUND' && checkResult.stdout.trim() !== '') {
    try {
      return JSON.parse(checkResult.stdout.trim())
    } catch (_error) {
      return { raw: checkResult.stdout.trim() }
    }
  }

  return null
}

export async function compareLocksAndPrompt(rootDir, ssh, remoteCwd, { runPrompt, logWarning } = {}) {
  const localLock = await readLocalLock(rootDir)
  const remoteLock = await readRemoteLock(ssh, remoteCwd)

  if (!localLock || !remoteLock) {
    return false
  }

  const localKey = `${localLock.user}@${localLock.hostname}:${localLock.pid}:${localLock.startedAt}`
  const remoteKey = `${remoteLock.user}@${remoteLock.hostname}:${remoteLock.pid}:${remoteLock.startedAt}`

  if (localKey === remoteKey) {
    const startedBy = remoteLock.user ? `${remoteLock.user}@${remoteLock.hostname ?? 'unknown'}` : 'unknown user'
    const startedAt = remoteLock.startedAt ? ` at ${remoteLock.startedAt}` : ''
    const { shouldRemove } = await runPrompt([
      {
        type: 'confirm',
        name: 'shouldRemove',
        message: `Stale lock detected on server (started by ${startedBy}${startedAt}). This appears to be from a failed deployment. Remove it?`,
        default: true
      }
    ])

    if (shouldRemove) {
      const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
      const escapedLockPath = lockPath.replace(/'/g, "'\\''")
      const removeCommand = `rm -f '${escapedLockPath}'`
      await ssh.execCommand(removeCommand, { cwd: remoteCwd })
      await releaseLocalLock(rootDir, { logWarning })
      return true
    }
  }

  return false
}

export async function acquireRemoteLock(ssh, remoteCwd, rootDir, { runPrompt, logWarning } = {}) {
  const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
  const escapedLockPath = lockPath.replace(/'/g, "'\\''")
  const checkCommand = `mkdir -p .zephyr && if [ -f '${escapedLockPath}' ]; then cat '${escapedLockPath}'; else echo "LOCK_NOT_FOUND"; fi`

  const checkResult = await ssh.execCommand(checkCommand, { cwd: remoteCwd })

  if (checkResult.stdout && checkResult.stdout.trim() !== 'LOCK_NOT_FOUND' && checkResult.stdout.trim() !== '') {
    const localLock = await readLocalLock(rootDir)
    if (localLock) {
      const removed = await compareLocksAndPrompt(rootDir, ssh, remoteCwd, { runPrompt, logWarning })
      if (!removed) {
        let details = {}
        try {
          details = JSON.parse(checkResult.stdout.trim())
        } catch (_error) {
          details = { raw: checkResult.stdout.trim() }
        }

        const startedBy = details.user ? `${details.user}@${details.hostname ?? 'unknown'}` : 'unknown user'
        const startedAt = details.startedAt ? ` at ${details.startedAt}` : ''
        throw new Error(
          `Another deployment is currently in progress on the server (started by ${startedBy}${startedAt}). Remove ${remoteCwd}/${lockPath} if you are sure it is stale.`
        )
      }
    } else {
      let details = {}
      try {
        details = JSON.parse(checkResult.stdout.trim())
      } catch (_error) {
        details = { raw: checkResult.stdout.trim() }
      }

      const startedBy = details.user ? `${details.user}@${details.hostname ?? 'unknown'}` : 'unknown user'
      const startedAt = details.startedAt ? ` at ${details.startedAt}` : ''
      throw new Error(
        `Another deployment is currently in progress on the server (started by ${startedBy}${startedAt}). Remove ${remoteCwd}/${lockPath} if you are sure it is stale.`
      )
    }
  }

  const payload = createLockPayload()
  const payloadJson = JSON.stringify(payload, null, 2)
  const payloadBase64 = Buffer.from(payloadJson).toString('base64')
  const createCommand = `mkdir -p .zephyr && echo '${payloadBase64}' | base64 --decode > '${escapedLockPath}'`

  const createResult = await ssh.execCommand(createCommand, { cwd: remoteCwd })
  if (createResult.code !== 0) {
    throw new Error(`Failed to create lock file on server: ${createResult.stderr}`)
  }

  await acquireLocalLock(rootDir)
  return lockPath
}

export async function releaseRemoteLock(ssh, remoteCwd, { logWarning } = {}) {
  const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
  const escapedLockPath = lockPath.replace(/'/g, "'\\''")
  const removeCommand = `rm -f '${escapedLockPath}'`

  const result = await ssh.execCommand(removeCommand, { cwd: remoteCwd })
  if (result.code !== 0 && result.code !== 1) {
    logWarning?.(`Failed to remove lock file: ${result.stderr}`)
  }
}

