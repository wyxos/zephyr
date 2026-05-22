import {loadProjectConfig} from '../../config/project.mjs'
import {loadServers} from '../../config/servers.mjs'
import {ZephyrError} from '../../runtime/errors.mjs'

export function findDeploymentGroupByName(projectConfig, groupName) {
    const groups = projectConfig?.groups ?? []
    return groups.find((group) => group?.name === groupName) ?? null
}

export function resolveDeploymentGroupPresetNames(projectConfig, groupName) {
    const group = findDeploymentGroupByName(projectConfig, groupName)

    if (!group) {
        throw new ZephyrError(
            `Zephyr cannot run deployment group "${groupName}" because it was not found in .zephyr/config.json.`,
            {code: 'ZEPHYR_DEPLOYMENT_GROUP_NOT_FOUND'}
        )
    }

    const presetNames = Array.isArray(group.presets)
        ? group.presets.filter((presetName) => typeof presetName === 'string' && presetName.trim().length > 0)
        : []

    if (presetNames.length === 0) {
        throw new ZephyrError(
            `Zephyr cannot run deployment group "${groupName}" because it has no presets.`,
            {code: 'ZEPHYR_DEPLOYMENT_GROUP_INVALID'}
        )
    }

    const configuredPresetNames = new Set((projectConfig?.presets ?? []).map((preset) => preset?.name).filter(Boolean))
    const missingPresetName = presetNames.find((presetName) => !configuredPresetNames.has(presetName))

    if (missingPresetName) {
        throw new ZephyrError(
            `Zephyr cannot run deployment group "${groupName}" because preset "${missingPresetName}" was not found in .zephyr/config.json.`,
            {code: 'ZEPHYR_DEPLOYMENT_GROUP_INVALID'}
        )
    }

    return presetNames
}

export async function resolveDeploymentGroup(rootDir, {
    groupName,
    logSuccess,
    logWarning,
    strict = true,
    allowMigration = false
} = {}) {
    const servers = await loadServers({
        logSuccess,
        logWarning,
        strict,
        allowMigration
    })
    const projectConfig = await loadProjectConfig(rootDir, servers, {
        logSuccess,
        logWarning,
        strict,
        allowMigration
    })

    return {
        name: groupName,
        presetNames: resolveDeploymentGroupPresetNames(projectConfig, groupName)
    }
}
