import fs from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'

import {ZephyrError} from '../runtime/errors.mjs'
import { PROJECT_LOCK_FILE, ensureDirectory, getLockFilePath, getProjectConfigDir } from '../utils/paths.mjs'

function createLockPayload() {
  return {
    user: os.userInfo().username,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString()
  }
}

function createLockKey(details = {}) {
  return `${details.user}@${details.hostname}:${details.pid}:${details.startedAt}`
}

function waitForDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
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

async function removeRemoteLock(ssh, remoteCwd) {
  const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
  const escapedLockPath = lockPath.replace(/'/g, "'\\''")
  const removeCommand = `rm -f '${escapedLockPath}'`

  await ssh.execCommand(removeCommand, { cwd: remoteCwd })
}

function formatLockHolder(details = {}) {
  const startedBy = details.user ? `${details.user}@${details.hostname ?? 'unknown'}` : 'unknown user'
  const startedAt = details.startedAt ? ` at ${details.startedAt}` : ''

  return { startedBy, startedAt }
}

function buildRemoteLockConflictMessage(lockDetails, { stale = false } = {}) {
  const { startedBy, startedAt } = formatLockHolder(lockDetails)

  return stale
    ? `Stale deployment lock detected on the server (started by ${startedBy}${startedAt}).`
    : `Another deployment is currently in progress on the server (started by ${startedBy}${startedAt}).`
}

async function promptToResolveRemoteLockConflict(rootDir, ssh, remoteCwd, lockDetails, {
  runPrompt,
  logWarning,
  logProcessing,
  interactive = true,
  stale = false,
  wait = waitForDelay
} = {}) {
  const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`

  if (!interactive) {
    if (stale) {
      throw new ZephyrError(
        `Stale deployment lock detected on the server (started by ${formatLockHolder(lockDetails).startedBy}${formatLockHolder(lockDetails).startedAt}). Remove ${remoteCwd}/${lockPath} manually before rerunning with --non-interactive.`,
        {code: 'ZEPHYR_STALE_REMOTE_LOCK'}
      )
    }

    const { startedBy, startedAt } = formatLockHolder(lockDetails)
    throw new Error(
      `Another deployment is currently in progress on the server (started by ${startedBy}${startedAt}). Remove ${remoteCwd}/${lockPath} if you are sure it is stale.`
    )
  }

  if (typeof runPrompt !== 'function') {
    throw new Error('Remote lock conflicts require runPrompt when Zephyr is interactive.')
  }

  let currentLock = lockDetails

  while (currentLock) {
    const { action } = await runPrompt([
      {
        type: 'list',
        name: 'action',
        message: `${buildRemoteLockConflictMessage(currentLock, { stale })} What would you like to do?`,
        choices: [
          {name: 'Delete the lock file and continue', value: 'delete'},
          {name: 'Wait 60 seconds and check again', value: 'wait'}
        ],
        default: 'wait'
      }
    ])

    if (action === 'delete') {
      await removeRemoteLock(ssh, remoteCwd)
      await releaseLocalLock(rootDir, { logWarning })
      return
    }

    logProcessing?.('Waiting 60 seconds before checking the remote deployment lock again...')
    await wait(60_000)

    currentLock = await readRemoteLock(ssh, remoteCwd)
    if (!currentLock) {
      return
    }
  }
}

export async function compareLocksAndPrompt(rootDir, ssh, remoteCwd, {
  runPrompt,
  logWarning,
  logProcessing,
  interactive = true,
  wait = waitForDelay
} = {}) {
  const localLock = await readLocalLock(rootDir)
  const remoteLock = await readRemoteLock(ssh, remoteCwd)

  if (!localLock || !remoteLock) {
    return false
  }

  const localKey = createLockKey(localLock)
  const remoteKey = createLockKey(remoteLock)

  if (localKey === remoteKey) {
    if (!interactive) {
      throw new ZephyrError(
        `Stale deployment lock detected on the server (started by ${formatLockHolder(remoteLock).startedBy}${formatLockHolder(remoteLock).startedAt}). Remove ${remoteCwd}/.zephyr/${PROJECT_LOCK_FILE} manually before rerunning with --non-interactive.`,
        {code: 'ZEPHYR_STALE_REMOTE_LOCK'}
      )
    }

    await promptToResolveRemoteLockConflict(rootDir, ssh, remoteCwd, remoteLock, {
      runPrompt,
      logWarning,
      logProcessing,
      interactive,
      stale: true,
      wait
    })

    return true
  }

  return false
}

export async function acquireRemoteLock(ssh, remoteCwd, rootDir, {
  runPrompt,
  logWarning,
  logProcessing,
  interactive = true,
  wait = waitForDelay
} = {}) {
  const lockPath = `.zephyr/${PROJECT_LOCK_FILE}`
  const escapedLockPath = lockPath.replace(/'/g, "'\\''")
  const remoteLock = await readRemoteLock(ssh, remoteCwd)

  if (remoteLock) {
    const localLock = await readLocalLock(rootDir)
    if (localLock) {
      const localKey = createLockKey(localLock)
      const remoteKey = createLockKey(remoteLock)

      if (localKey === remoteKey) {
        const resolvedStaleLock = await compareLocksAndPrompt(rootDir, ssh, remoteCwd, {
          runPrompt,
          logWarning,
          logProcessing,
          interactive,
          wait
        })

        if (!resolvedStaleLock) {
          const refreshedRemoteLock = await readRemoteLock(ssh, remoteCwd)
          if (refreshedRemoteLock) {
            if (interactive) {
              await promptToResolveRemoteLockConflict(rootDir, ssh, remoteCwd, refreshedRemoteLock, {
                runPrompt,
                logWarning,
                logProcessing,
                interactive,
                wait
              })
            } else {
              const { startedBy, startedAt } = formatLockHolder(refreshedRemoteLock)
              throw new Error(
                `Another deployment is currently in progress on the server (started by ${startedBy}${startedAt}). Remove ${remoteCwd}/${lockPath} if you are sure it is stale.`
              )
            }
          }
        }
      } else if (interactive) {
        await promptToResolveRemoteLockConflict(rootDir, ssh, remoteCwd, remoteLock, {
          runPrompt,
          logWarning,
          logProcessing,
          interactive,
          wait
        })
      } else {
        const { startedBy, startedAt } = formatLockHolder(remoteLock)
        throw new Error(
          `Another deployment is currently in progress on the server (started by ${startedBy}${startedAt}). Remove ${remoteCwd}/${lockPath} if you are sure it is stale.`
        )
      }
    } else {
      await promptToResolveRemoteLockConflict(rootDir, ssh, remoteCwd, remoteLock, {
        runPrompt,
        logWarning,
        logProcessing,
        interactive,
        wait
      })
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
