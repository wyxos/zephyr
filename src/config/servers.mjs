import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ensureDirectory } from '../utils/paths.mjs'
import { generateId } from '../utils/id.mjs'

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.config', 'zephyr')
const SERVERS_FILE = path.join(GLOBAL_CONFIG_DIR, 'servers.json')

export function migrateServers(servers) {
  if (!Array.isArray(servers)) {
    return { servers: [], needsMigration: false }
  }

  let needsMigration = false
  const migrated = servers.map((server) => {
    if (!server.id) {
      needsMigration = true
      return { ...server, id: generateId() }
    }
    return server
  })

  return { servers: migrated, needsMigration }
}

export async function loadServers({ logSuccess, logWarning } = {}) {
  try {
    const raw = await fs.readFile(SERVERS_FILE, 'utf8')
    const data = JSON.parse(raw)
    const servers = Array.isArray(data) ? data : []

    const { servers: migrated, needsMigration } = migrateServers(servers)

    if (needsMigration) {
      await saveServers(migrated)
      logSuccess?.('Migrated servers configuration to use unique IDs.')
    }

    return migrated
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    logWarning?.('Failed to read servers.json, starting with an empty list.')
    return []
  }
}

export async function saveServers(servers) {
  await ensureDirectory(GLOBAL_CONFIG_DIR)
  const payload = JSON.stringify(servers, null, 2)
  await fs.writeFile(SERVERS_FILE, `${payload}\n`)
}

