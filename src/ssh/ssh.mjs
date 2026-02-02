import fs from 'node:fs/promises'
import os from 'node:os'
import chalk from 'chalk'
import process from 'node:process'
import { NodeSSH } from 'node-ssh'
import { createChalkLogger } from '../utils/output.mjs'
import { resolveRemotePath } from '../utils/remote-path.mjs'
import { resolveSshKeyPath } from './keys.mjs'
import { createRemoteExecutor } from '../deploy/remote-exec.mjs'
import { createSshClientFactory } from '../runtime/ssh-client.mjs'

const { logProcessing, logSuccess, logWarning, logError } = createChalkLogger(chalk)

const createSshClient = createSshClientFactory({ NodeSSH })

function normalizeRemotePath(value) {
  if (value == null) return value
  return String(value).replace(/\\/g, '/')
}

export async function connectToServer(config) {
  const ssh = createSshClient()
  const sshUser = config.sshUser || os.userInfo().username
  const privateKeyPath = await resolveSshKeyPath(config.sshKey)
  const privateKey = await fs.readFile(privateKeyPath, 'utf8')

  logProcessing(`\nConnecting to ${config.serverIp} as ${sshUser}...`)

  await ssh.connect({
    host: config.serverIp,
    username: sshUser,
    privateKey
  })

  const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
  const remoteHome = remoteHomeResult.stdout.trim() || `/home/${sshUser}`
  const remoteCwd = resolveRemotePath(config.projectPath, remoteHome)

  logSuccess(`Connected to ${config.serverIp}. Working directory: ${remoteCwd}`)

  return { ssh, remoteCwd, remoteHome }
}

export async function executeRemoteCommand(ssh, label, command, options = {}) {
  const {
    cwd,
    allowFailure = false,
    bootstrapEnv = true,
    rootDir = null,
    writeToLogFile = null,
    env = {}
    // printStdout: legacy option, intentionally ignored (we log to file)
  } = options

  const rootDirForLogging = rootDir ?? process.cwd()
  const writeToLogFileFn = writeToLogFile ?? (async () => {})

  const executeRemote = createRemoteExecutor({
    ssh,
    rootDir: rootDirForLogging,
    remoteCwd: cwd,
    writeToLogFile: writeToLogFileFn,
    logProcessing,
    logSuccess,
    logError
  })

  return await executeRemote(label, command, { cwd, allowFailure, bootstrapEnv, env })
}

export async function readRemoteFile(ssh, filePath, remoteCwd) {
  const normalizedPath = normalizeRemotePath(filePath)
  const escapedPath = normalizedPath.replace(/'/g, "'\\''")
  const command = `cat '${escapedPath}'`

  const result = await ssh.execCommand(command, { cwd: normalizeRemotePath(remoteCwd) })

  if (result.code !== 0) {
    throw new Error(`Failed to read remote file ${filePath}: ${result.stderr}`)
  }

  return result.stdout
}

export async function downloadRemoteFile(ssh, remotePath, localPath, remoteCwd) {
  const normalizedRemotePath = normalizeRemotePath(remotePath)
  const normalizedCwd = normalizeRemotePath(remoteCwd)
  const absoluteRemotePath = normalizedRemotePath.startsWith('/')
    ? normalizedRemotePath
    : `${normalizedCwd}/${normalizedRemotePath}`

  logProcessing(`Downloading ${absoluteRemotePath} to ${localPath}...`)

  let transferred = 0
  const startTime = Date.now()

  await ssh.getFile(localPath, absoluteRemotePath, null, {
    step: (totalTransferred, _chunk, total) => {
      transferred = totalTransferred
      const percent = total > 0 ? Math.round((transferred / total) * 100) : 0
      const elapsed = (Date.now() - startTime) / 1000
      const speed = elapsed > 0 ? (transferred / elapsed / 1024 / 1024).toFixed(2) : 0
      const sizeMB = (transferred / 1024 / 1024).toFixed(2)
      const totalMB = total > 0 ? (total / 1024 / 1024).toFixed(2) : '?'

      process.stdout.write(`\r  Progress: ${percent}% (${sizeMB}MB / ${totalMB}MB) - ${speed} MB/s`)
    }
  })

  process.stdout.write('\r' + ' '.repeat(80) + '\r')
  logSuccess(`Downloaded ${absoluteRemotePath} to ${localPath}`)
}

export async function deleteRemoteFile(ssh, remotePath, remoteCwd) {
  const normalizedRemotePath = normalizeRemotePath(remotePath)
  const normalizedCwd = normalizeRemotePath(remoteCwd)
  const absoluteRemotePath = normalizedRemotePath.startsWith('/')
    ? normalizedRemotePath
    : `${normalizedCwd}/${normalizedRemotePath}`

  const escapedPath = absoluteRemotePath.replace(/'/g, "'\\''")
  const command = `rm -f '${escapedPath}'`

  const inTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'
  if (!inTest) {
    logProcessing(`Deleting remote file: ${absoluteRemotePath}...`)
  }

  const result = await ssh.execCommand(command, { cwd: normalizedCwd })

  if (result.code !== 0 && result.code !== 1) {
    if (!inTest) {
      logWarning(`Failed to delete remote file ${absoluteRemotePath}: ${result.stderr}`)
    }
  } else if (!inTest) {
    logSuccess(`Deleted remote file: ${absoluteRemotePath}`)
  }
}

