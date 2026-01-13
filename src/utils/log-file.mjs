import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDirectory, getProjectConfigDir } from './paths.mjs'

let logFilePath = null

export async function getLogFilePath(rootDir) {
  if (logFilePath) {
    return logFilePath
  }

  const configDir = getProjectConfigDir(rootDir)
  await ensureDirectory(configDir)

  const now = new Date()
  const dateStr = now.toISOString().replace(/:/g, '-').replace(/\..+/, '')
  logFilePath = path.join(configDir, `${dateStr}.log`)

  return logFilePath
}

export async function writeToLogFile(rootDir, message) {
  const logPath = await getLogFilePath(rootDir)
  const timestamp = new Date().toISOString()
  await fs.appendFile(logPath, `${timestamp} - ${message}\n`)
}

export async function closeLogFile() {
  logFilePath = null
}

export async function cleanupOldLogs(rootDir) {
  const configDir = getProjectConfigDir(rootDir)

  try {
    const files = await fs.readdir(configDir)
    const logFiles = files
      .filter((file) => file.endsWith('.log'))
      .map((file) => ({
        name: file,
        path: path.join(configDir, file)
      }))

    if (logFiles.length <= 3) {
      return
    }

    const filesWithStats = await Promise.all(
      logFiles.map(async (file) => {
        const stats = await fs.stat(file.path)
        return {
          ...file,
          mtime: stats.mtime
        }
      })
    )

    filesWithStats.sort((a, b) => b.mtime - a.mtime)

    const filesToDelete = filesWithStats.slice(3)

    for (const file of filesToDelete) {
      try {
        await fs.unlink(file.path)
      } catch (_error) {
        // Ignore errors when deleting old logs
      }
    }
  } catch (error) {
    // Ignore errors during log cleanup
    if (error.code !== 'ENOENT') {
      // Only log if it's not a "directory doesn't exist" error
    }
  }
}

