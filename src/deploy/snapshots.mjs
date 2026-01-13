import fs from 'node:fs/promises'
import { ensureDirectory, getPendingTasksPath, getProjectConfigDir } from '../utils/paths.mjs'

export async function loadPendingTasksSnapshot(rootDir) {
  const snapshotPath = getPendingTasksPath(rootDir)

  try {
    const raw = await fs.readFile(snapshotPath, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function savePendingTasksSnapshot(rootDir, snapshot) {
  const configDir = getProjectConfigDir(rootDir)
  await ensureDirectory(configDir)
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`
  await fs.writeFile(getPendingTasksPath(rootDir), payload)
}

export async function clearPendingTasksSnapshot(rootDir) {
  try {
    await fs.unlink(getPendingTasksPath(rootDir))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
}

