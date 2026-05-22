import fs from 'node:fs/promises'

import {ZephyrError} from '../runtime/errors.mjs'
import {
  normalizePresetOptions,
  presetOptionsEqual
} from './preset-options.mjs'
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

  const appLookup = new Map()
  apps.forEach((app) => {
    if (app.id && app.serverName && app.projectPath) {
      const key = `${app.serverName}:${app.projectPath}`
      appLookup.set(key, app)
    }
  })

  let needsMigration = false
  const migrated = presets.flatMap((preset) => {
    if (!preset || typeof preset !== 'object') {
      needsMigration = true
      return []
    }

    const updated = {
      name: typeof preset.name === 'string' ? preset.name : '',
      appId: typeof preset.appId === 'string' ? preset.appId : null,
      branch: typeof preset.branch === 'string' ? preset.branch : null,
      options: normalizePresetOptions(preset.options)
    }

    if (!presetOptionsEqual(updated.options, preset.options)) {
      needsMigration = true
    }

    if (preset.key) {
      needsMigration = true
      const [serverName = null, projectPath = null, legacyBranch = null] = String(preset.key).split(':')
      const app = serverName && projectPath
        ? appLookup.get(`${serverName}:${projectPath}`)
        : null

      if (app?.id) {
        updated.appId = app.id
      }

      if (!updated.branch && legacyBranch) {
        updated.branch = legacyBranch
      }
    }

    if (!updated.name) {
      needsMigration = true
      return []
    }

    if (!preset.appId || preset.key || preset.branch !== updated.branch) {
      needsMigration = true
    }

    return [updated]
  })

  return { presets: migrated, needsMigration }
}

export function migrateGroups(groups) {
  if (!Array.isArray(groups)) {
    return { groups: [], needsMigration: false }
  }

  let needsMigration = false
  const migrated = groups.flatMap((group) => {
    if (!group || typeof group !== 'object') {
      needsMigration = true
      return []
    }

    const name = typeof group.name === 'string' ? group.name.trim() : ''
    const rawPresets = Array.isArray(group.presets)
      ? group.presets
      : Array.isArray(group.presetNames)
        ? group.presetNames
        : []
    const presets = rawPresets
      .map((presetName) => typeof presetName === 'string' ? presetName.trim() : '')
      .filter((presetName) => presetName.length > 0)

    if (!name || presets.length === 0) {
      needsMigration = true
      return []
    }

    if (name !== group.name || !Array.isArray(group.presets) || presets.length !== rawPresets.length) {
      needsMigration = true
    }

    return [{ name, presets }]
  })

  return { groups: migrated, needsMigration }
}

export async function loadProjectConfig(rootDir, servers = [], {
  logSuccess,
  logWarning,
  strict = false,
  allowMigration = true
} = {}) {
  const configPath = getProjectConfigPath(rootDir)

  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const data = JSON.parse(raw)
    const apps = Array.isArray(data?.apps) ? data.apps : []
    const presets = Array.isArray(data?.presets) ? data.presets : []
    const groups = Array.isArray(data?.groups) ? data.groups : []

    const { apps: migratedApps, needsMigration: appsNeedMigration } = migrateApps(apps, servers)
    const { presets: migratedPresets, needsMigration: presetsNeedMigration } = migratePresets(presets, migratedApps)
    const { groups: migratedGroups, needsMigration: groupsNeedMigration } = migrateGroups(groups)

    if (appsNeedMigration || presetsNeedMigration || groupsNeedMigration) {
      if (!allowMigration) {
        throw new ZephyrError(
          'Zephyr cannot run non-interactively because .zephyr/config.json needs migration. Rerun interactively once to update the config.',
          {code: 'ZEPHYR_PROJECT_CONFIG_MIGRATION_REQUIRED'}
        )
      }

      await saveProjectConfig(rootDir, {
        apps: migratedApps,
        presets: migratedPresets,
        groups: migratedGroups
      })
      logSuccess?.('Migrated project configuration to use unique IDs.')
    }

    return { apps: migratedApps, presets: migratedPresets, groups: migratedGroups }
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (strict) {
        throw new ZephyrError(
          'Zephyr cannot run non-interactively because .zephyr/config.json does not exist. Run an interactive deployment first to create it.',
          {code: 'ZEPHYR_PROJECT_CONFIG_MISSING'}
        )
      }

      return { apps: [], presets: [], groups: [] }
    }

    if (error instanceof ZephyrError) {
      throw error
    }

    if (strict) {
      throw new ZephyrError(
        'Zephyr cannot run non-interactively because .zephyr/config.json could not be read.',
        {code: 'ZEPHYR_PROJECT_CONFIG_INVALID', cause: error}
      )
    }

    logWarning?.('Failed to read .zephyr/config.json, starting with an empty list of apps.')
    return { apps: [], presets: [], groups: [] }
  }
}

export async function saveProjectConfig(rootDir, config) {
  const configDir = getProjectConfigDir(rootDir)
  await ensureDirectory(configDir)
  const payloadData = {
    apps: config.apps ?? [],
    presets: config.presets ?? []
  }

  if (Array.isArray(config.groups) && config.groups.length > 0) {
    payloadData.groups = config.groups
  }

  const payload = JSON.stringify(
    payloadData,
    null,
    2
  )

  await fs.writeFile(getProjectConfigPath(rootDir), `${payload}\n`)
}

export function removePreset(config, preset) {
  if (!config || !Array.isArray(config.presets)) {
    return null
  }

  const presetIndex = config.presets.indexOf(preset)
  if (presetIndex < 0) {
    return null
  }

  const [removed] = config.presets.splice(presetIndex, 1)
  return removed ?? null
}
