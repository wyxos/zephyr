import { spawn } from 'node:child_process'
import process from 'node:process'

const DEFAULT_IS_WINDOWS = process.platform === 'win32'

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

export async function runCommand(command, args, { cwd = process.cwd(), stdio = 'inherit' } = {}) {
  const resolvedCommand = resolveCommandForPlatform(command)

  return new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, args, { cwd, stdio })

    child.on('error', reject)
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

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const child = spawn(resolvedCommand, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', reject)
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

