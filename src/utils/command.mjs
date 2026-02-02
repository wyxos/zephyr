import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

const DEFAULT_IS_WINDOWS = process.platform === 'win32'

/**
 * Check if a command exists in PATH.
 * @param {string} command - The command to check
 * @returns {boolean} - True if the command exists
 */
export function commandExists(command) {
  const resolvedCommand = resolveCommandForPlatform(command)

  // On Windows, use 'where', on Unix use 'which'
  const checker = DEFAULT_IS_WINDOWS ? 'where' : 'which'

  try {
    const result = spawnSync(checker, [resolvedCommand], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: DEFAULT_IS_WINDOWS
    })
    return result.status === 0
  } catch {
    return false
  }
}

export function resolveCommandForPlatform(command, { isWindows = DEFAULT_IS_WINDOWS } = {}) {
  if (!isWindows) {
    return command
  }

  // On Windows, these are typically shimmed as *.cmd on PATH
  if (command === 'npm' || command === 'npx' || command === 'pnpm' || command === 'yarn') {
    return `${command}.cmd`
  }

  return command
}

/**
 * Check if a command should be run with shell: true on Windows.
 * This is needed for commands that might be .bat or .cmd shims (like php via Herd).
 */
export function shouldUseShellOnWindows(command) {
  if (!DEFAULT_IS_WINDOWS) {
    return false
  }
  // Commands that are commonly provided as batch file shims on Windows
  const shellCommands = ['php', 'composer', 'git']
  return shellCommands.includes(command.toLowerCase())
}

function isWindowsShellShim(command) {
  return DEFAULT_IS_WINDOWS && typeof command === 'string' && /\.(cmd|bat)$/i.test(command)
}

function quoteForCmd(arg) {
  const value = arg == null ? '' : String(arg)
  if (value.length === 0) {
    return '""'
  }
  if (/[ \t"]/g.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return value
}

export async function runCommand(command, args, { cwd = process.cwd(), stdio = 'inherit' } = {}) {
  const resolvedCommand = resolveCommandForPlatform(command)
  const useShell = isWindowsShellShim(resolvedCommand) || shouldUseShellOnWindows(command)

  return new Promise((resolve, reject) => {
    const child = useShell
      ? spawn([resolvedCommand, ...(args ?? []).map(quoteForCmd)].join(' '), { cwd, stdio, shell: true })
      : spawn(resolvedCommand, args, { cwd, stdio })

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        const error = new Error(
          `Command not found: "${resolvedCommand}". ` +
          `Make sure "${command}" is installed and available in your PATH.`
        )
        error.code = 'ENOENT'
        error.originalError = err
        reject(error)
      } else {
        reject(err)
      }
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        const error = new Error(`${resolvedCommand} exited with code ${code}`)
        error.exitCode = code
        reject(error)
      }
    })
  })
}

export async function runCommandCapture(command, args, { cwd = process.cwd() } = {}) {
  const resolvedCommand = resolveCommandForPlatform(command)
  const useShell = isWindowsShellShim(resolvedCommand) || shouldUseShellOnWindows(command)

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const child = useShell
      ? spawn([resolvedCommand, ...(args ?? []).map(quoteForCmd)].join(' '), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
      })
      : spawn(resolvedCommand, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        const error = new Error(
          `Command not found: "${resolvedCommand}". ` +
          `Make sure "${command}" is installed and available in your PATH.`
        )
        error.code = 'ENOENT'
        error.originalError = err
        reject(error)
      } else {
        reject(err)
      }
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const error = new Error(`${resolvedCommand} exited with code ${code}: ${stderr.trim()}`)
        error.exitCode = code
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      }
    })
  })
}

