import fs from 'node:fs/promises'
import path from 'node:path'

export const PROJECT_CONFIG_DIR = '.zephyr'
export const PROJECT_CONFIG_FILE = 'config.json'
export const PROJECT_LOCK_FILE = 'deploy.lock'
export const PENDING_TASKS_FILE = 'pending-tasks.json'

export async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

export function getProjectConfigDir(rootDir) {
  return path.join(rootDir, PROJECT_CONFIG_DIR)
}

export function getProjectConfigPath(rootDir) {
  return path.join(rootDir, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE)
}

export function getPendingTasksPath(rootDir) {
  return path.join(getProjectConfigDir(rootDir), PENDING_TASKS_FILE)
}

export function getLockFilePath(rootDir) {
  return path.join(getProjectConfigDir(rootDir), PROJECT_LOCK_FILE)
}

