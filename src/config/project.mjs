import fs from 'node:fs/promises'

import { ensureDirectory, getProjectConfigDir, getProjectConfigPath } from '../utils/paths.mjs'
import { generateId } from '../utils/id.mjs'

export function migrateApps(apps, servers) {
  if (!Array.isArray(apps)) {
    return { apps: [], needsMigration: false }
  }

  const serverNameToId = new Map()
  servers.forEach((server) => {
    if (server.id && server.serverName) {
      serverNameToId.set(server.serverName, server.id)
    }
  })

  let needsMigration = false
  const migrated = apps.map((app) => {
    const updated = { ...app }

    if (!app.id) {
      needsMigration = true
      updated.id = generateId()
    }

    if (app.serverName && !app.serverId) {
      const serverId = serverNameToId.get(app.serverName)
      if (serverId) {
        needsMigration = true
        updated.serverId = serverId
      }
    }

    return updated
  })

  return { apps: migrated, needsMigration }
}

export function migratePresets(presets, apps) {
  if (!Array.isArray(presets)) {
    return { presets: [], needsMigration: false }
  }

  const keyToAppId = new Map()
  apps.forEach((app) => {
    if (app.id && app.serverName && app.projectPath) {
      const key = `${app.serverName}:${app.projectPath}`
      keyToAppId.set(key, app.id)
    }
  })

  let needsMigration = false
  const migrated = presets.map((preset) => {
    const updated = { ...preset }

    if (preset.key && !preset.appId) {
      const appId = keyToAppId.get(preset.key)
      if (appId) {
        needsMigration = true
        updated.appId = appId
      }
    }

    return updated
  })

  return { presets: migrated, needsMigration }
}

export async function loadProjectConfig(rootDir, servers = [], { logSuccess, logWarning } = {}) {
  const configPath = getProjectConfigPath(rootDir)

  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const data = JSON.parse(raw)
    const apps = Array.isArray(data?.apps) ? data.apps : []
    const presets = Array.isArray(data?.presets) ? data.presets : []

    const { apps: migratedApps, needsMigration: appsNeedMigration } = migrateApps(apps, servers)
    const { presets: migratedPresets, needsMigration: presetsNeedMigration } = migratePresets(presets, migratedApps)

    if (appsNeedMigration || presetsNeedMigration) {
      await saveProjectConfig(rootDir, {
        apps: migratedApps,
        presets: migratedPresets
      })
      logSuccess?.('Migrated project configuration to use unique IDs.')
    }

    return { apps: migratedApps, presets: migratedPresets }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { apps: [], presets: [] }
    }

    logWarning?.('Failed to read .zephyr/config.json, starting with an empty list of apps.')
    return { apps: [], presets: [] }
  }
}

export async function saveProjectConfig(rootDir, config) {
  const configDir = getProjectConfigDir(rootDir)
  await ensureDirectory(configDir)

  const payload = JSON.stringify(
    {
      apps: config.apps ?? [],
      presets: config.presets ?? []
    },
    null,
    2
  )

  await fs.writeFile(getProjectConfigPath(rootDir), `${payload}\n`)
}

