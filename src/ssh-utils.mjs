import fs from 'node:fs/promises'
import os from 'node:os'
import chalk from 'chalk'
import process from 'node:process'
import { createChalkLogger } from './utils/output.mjs'
import { resolveRemotePath } from './utils/remote-path.mjs'
import { resolveSshKeyPath } from './ssh/keys.mjs'
import { createRemoteExecutor } from './deploy/remote-exec.mjs'
import { createSshClientFactory } from './runtime/ssh-client.mjs'
import { NodeSSH } from 'node-ssh'

const { logProcessing, logSuccess, logWarning, logError } = createChalkLogger(chalk)

const createSshClient = createSshClientFactory({ NodeSSH })

// writeToLogFile will be passed as an optional parameter to avoid circular dependency

/**
 * Connect to server via SSH
 * @param {Object} config - Server configuration with sshUser, sshKey, serverIp, projectPath
 * @param {string} rootDir - Local root directory for logging
 * @returns {Promise<{ssh: NodeSSH, remoteCwd: string, remoteHome: string}>}
 */
export async function connectToServer(config, _rootDir) {
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

/**
 * Execute a remote command with logging
 * @param {NodeSSH} ssh - SSH client instance
 * @param {string} label - Human-readable label for the command
 * @param {string} command - Command to execute
 * @param {Object} options - Options: { cwd, allowFailure, printStdout, bootstrapEnv, rootDir, writeToLogFile, env }
 * @returns {Promise<Object>} Command result
 */
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
  const writeToLogFileFn = writeToLogFile ?? (async () => { })

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

/**
 * Read file content from remote server
 * @param {NodeSSH} ssh - SSH client instance
 * @param {string} filePath - Path to file on remote server
 * @param {string} remoteCwd - Remote working directory
 * @returns {Promise<string>} File content
 */
export async function readRemoteFile(ssh, filePath, remoteCwd) {
  const escapedPath = filePath.replace(/'/g, "'\\''")
  const command = `cat '${escapedPath}'`

  const result = await ssh.execCommand(command, { cwd: remoteCwd })

  if (result.code !== 0) {
    throw new Error(`Failed to read remote file ${filePath}: ${result.stderr}`)
  }

  return result.stdout
}

/**
 * Download file from remote server via SFTP with progress
 * 
 * Note: Currently uses single-stream download (most reliable).
 * Multi-streaming is technically possible with ssh2-sftp-client's fastGet,
 * but it's unreliable on many servers and can cause data corruption.
 * Single-stream ensures data integrity at the cost of potentially slower speeds.
 * 
 * @param {NodeSSH} ssh - SSH client instance
 * @param {string} remotePath - Path to file on remote server
 * @param {string} localPath - Local path to save file
 * @param {string} remoteCwd - Remote working directory (for relative paths)
 * @returns {Promise<void>}
 */
export async function downloadRemoteFile(ssh, remotePath, localPath, remoteCwd) {
  // Resolve absolute path if relative
  const absoluteRemotePath = remotePath.startsWith('/')
    ? remotePath
    : `${remoteCwd}/${remotePath}`

  logProcessing(`Downloading ${absoluteRemotePath} to ${localPath}...`)

  let transferred = 0
  const startTime = Date.now()

  // Single-stream download (most reliable for data integrity)
  await ssh.getFile(localPath, absoluteRemotePath, null, {
    step: (totalTransferred, chunk, total) => {
      transferred = totalTransferred
      const percent = total > 0 ? Math.round((transferred / total) * 100) : 0
      const elapsed = (Date.now() - startTime) / 1000
      const speed = elapsed > 0 ? (transferred / elapsed / 1024 / 1024).toFixed(2) : 0
      const sizeMB = (transferred / 1024 / 1024).toFixed(2)
      const totalMB = total > 0 ? (total / 1024 / 1024).toFixed(2) : '?'

      // Update progress on same line
      process.stdout.write(`\r  Progress: ${percent}% (${sizeMB}MB / ${totalMB}MB) - ${speed} MB/s`)
    }
  })

  // Clear progress line and show completion
  process.stdout.write('\r' + ' '.repeat(80) + '\r')
  logSuccess(`Downloaded ${absoluteRemotePath} to ${localPath}`)
}

/**
 * Delete file from remote server
 * @param {NodeSSH} ssh - SSH client instance
 * @param {string} remotePath - Path to file on remote server
 * @param {string} remoteCwd - Remote working directory (for relative paths)
 * @returns {Promise<void>}
 */
export async function deleteRemoteFile(ssh, remotePath, remoteCwd) {
  // Resolve absolute path if relative
  const absoluteRemotePath = remotePath.startsWith('/')
    ? remotePath
    : `${remoteCwd}/${remotePath}`

  const escapedPath = absoluteRemotePath.replace(/'/g, "'\\''")
  const command = `rm -f '${escapedPath}'`

  logProcessing(`Deleting remote file: ${absoluteRemotePath}...`)

  const result = await ssh.execCommand(command, { cwd: remoteCwd })

  if (result.code !== 0 && result.code !== 1) {
    // Exit code 1 is OK for rm -f (file doesn't exist)
    logWarning(`Failed to delete remote file ${absoluteRemotePath}: ${result.stderr}`)
  } else {
    logSuccess(`Deleted remote file: ${absoluteRemotePath}`)
  }
}

