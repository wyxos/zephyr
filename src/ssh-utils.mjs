import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NodeSSH } from 'node-ssh'
import chalk from 'chalk'

// Import utility functions - these need to be passed in or redefined to avoid circular dependency
// For now, we'll redefine the simple ones and accept others as parameters
const logProcessing = (message = '') => console.log(chalk.yellow(message))
const logSuccess = (message = '') => console.log(chalk.green(message))
const logError = (message = '') => console.error(chalk.red(message))
const logWarning = (message = '') => console.warn(chalk.yellow(message))

function expandHomePath(targetPath) {
  if (!targetPath) {
    return targetPath
  }
  if (targetPath.startsWith('~')) {
    return path.join(os.homedir(), targetPath.slice(1))
  }
  return targetPath
}

async function resolveSshKeyPath(targetPath) {
  const expanded = expandHomePath(targetPath)
  try {
    await fs.access(expanded)
  } catch (_error) {
    throw new Error(`SSH key not accessible at ${expanded}`)
  }
  return expanded
}

function resolveRemotePath(projectPath, remoteHome) {
  if (!projectPath) {
    return projectPath
  }
  const sanitizedHome = remoteHome.replace(/\/+$/, '')
  if (projectPath === '~') {
    return sanitizedHome
  }
  if (projectPath.startsWith('~/')) {
    const remainder = projectPath.slice(2)
    return remainder ? `${sanitizedHome}/${remainder}` : sanitizedHome
  }
  if (projectPath.startsWith('/')) {
    return projectPath
  }
  return `${sanitizedHome}/${projectPath}`
}

const createSshClient = () => {
  if (typeof globalThis !== 'undefined' && globalThis.__zephyrSSHFactory) {
    return globalThis.__zephyrSSHFactory()
  }
  return new NodeSSH()
}

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
  const { cwd, allowFailure = false, bootstrapEnv = true, rootDir = null, writeToLogFile = null, env = {} } = options

  logProcessing(`\n→ ${label}`)

  // Robust environment bootstrap for non-interactive shells
  const profileBootstrap = [
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"; fi',
    'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile"; fi',
    'if [ -f "$HOME/.zshrc" ]; then . "$HOME/.zshrc"; fi',
    'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi',
    'if [ -s "$HOME/.config/nvm/nvm.sh" ]; then . "$HOME/.config/nvm/nvm.sh"; fi',
    'if [ -s "/usr/local/opt/nvm/nvm.sh" ]; then . "/usr/local/opt/nvm/nvm.sh"; fi',
    'if command -v npm >/dev/null 2>&1; then :',
    'elif [ -d "$HOME/.nvm/versions/node" ]; then NODE_VERSION=$(ls -1 "$HOME/.nvm/versions/node" | tail -1) && export PATH="$HOME/.nvm/versions/node/$NODE_VERSION/bin:$PATH"',
    'elif [ -d "/usr/local/lib/node_modules/npm/bin" ]; then export PATH="/usr/local/lib/node_modules/npm/bin:$PATH"',
    'elif [ -d "/opt/homebrew/bin" ] && [ -f "/opt/homebrew/bin/npm" ]; then export PATH="/opt/homebrew/bin:$PATH"',
    'elif [ -d "/usr/local/bin" ] && [ -f "/usr/local/bin/npm" ]; then export PATH="/usr/local/bin:$PATH"',
    'elif [ -d "$HOME/.local/bin" ] && [ -f "$HOME/.local/bin/npm" ]; then export PATH="$HOME/.local/bin:$PATH"',
    'fi'
  ].join('; ')

  const escapeForDoubleQuotes = (value) => value.replace(/(["\\$`])/g, '\\$1')
  const escapeForSingleQuotes = (value) => value.replace(/'/g, "'\\''")

  // Build environment variable exports
  let envExports = ''
  if (Object.keys(env).length > 0) {
    const envPairs = Object.entries(env).map(([key, value]) => {
      const escapedValue = escapeForSingleQuotes(String(value))
      return `${key}='${escapedValue}'`
    })
    envExports = envPairs.join(' ') + ' '
  }

  let wrappedCommand = command
  let execOptions = { cwd }

  if (bootstrapEnv && cwd) {
    const cwdForShell = escapeForDoubleQuotes(cwd)
    wrappedCommand = `${profileBootstrap}; cd "${cwdForShell}" && ${envExports}${command}`
    execOptions = {}
  } else if (Object.keys(env).length > 0) {
    wrappedCommand = `${envExports}${command}`
  }

  const result = await ssh.execCommand(wrappedCommand, execOptions)

  // Log to file if writeToLogFile function provided
  if (writeToLogFile && rootDir) {
    if (result.stdout && result.stdout.trim()) {
      await writeToLogFile(rootDir, `[${label}] STDOUT:\n${result.stdout.trim()}`)
    }
    if (result.stderr && result.stderr.trim()) {
      await writeToLogFile(rootDir, `[${label}] STDERR:\n${result.stderr.trim()}`)
    }
  }

  // Show errors in terminal
  if (result.code !== 0) {
    if (result.stdout && result.stdout.trim()) {
      logError(`\n[${label}] Output:\n${result.stdout.trim()}`)
    }
    if (result.stderr && result.stderr.trim()) {
      logError(`\n[${label}] Error:\n${result.stderr.trim()}`)
    }
  }

  if (result.code !== 0 && !allowFailure) {
    const stderr = result.stderr?.trim() ?? ''
    if (/command not found/.test(stderr) || /is not recognized/.test(stderr)) {
      throw new Error(
        `Command failed: ${command}. Ensure the remote environment loads required tools for non-interactive shells (e.g. export PATH in profile scripts).`
      )
    }
    throw new Error(`Command failed: ${command}`)
  }

  // Show success confirmation
  if (result.code === 0) {
    logSuccess(`✓ ${command}`)
  }

  return result
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

