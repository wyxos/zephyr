import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {ZephyrError} from '../runtime/errors.mjs'
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

export async function loadServers({
  logSuccess,
  logWarning,
  strict = false,
  allowMigration = true
} = {}) {
  try {
    const raw = await fs.readFile(SERVERS_FILE, 'utf8')
    const data = JSON.parse(raw)
    const servers = Array.isArray(data) ? data : []

    const { servers: migrated, needsMigration } = migrateServers(servers)

    if (needsMigration) {
      if (!allowMigration) {
        throw new ZephyrError(
          'Zephyr cannot run non-interactively because ~/.config/zephyr/servers.json needs migration. Rerun interactively once to update the config.',
          {code: 'ZEPHYR_SERVERS_CONFIG_MIGRATION_REQUIRED'}
        )
      }

      await saveServers(migrated)
      logSuccess?.('Migrated servers configuration to use unique IDs.')
    }

    return migrated
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (strict) {
        throw new ZephyrError(
          'Zephyr cannot run non-interactively because ~/.config/zephyr/servers.json does not exist. Run an interactive deployment first to create it.',
          {code: 'ZEPHYR_SERVERS_CONFIG_MISSING'}
        )
      }

      return []
    }

    if (error instanceof ZephyrError) {
      throw error
    }

    if (strict) {
      throw new ZephyrError(
        'Zephyr cannot run non-interactively because ~/.config/zephyr/servers.json could not be read.',
        {code: 'ZEPHYR_SERVERS_CONFIG_INVALID', cause: error}
      )
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
