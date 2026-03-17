import {writeStdoutLine} from '../../utils/output.mjs'
import {loadServers} from '../../config/servers.mjs'
import {loadProjectConfig, removePreset, saveProjectConfig} from '../../config/project.mjs'
import {ZephyrError} from '../../runtime/errors.mjs'

function findPresetByName(projectConfig, presetName) {
    const presets = projectConfig?.presets ?? []
    return presets.find((entry) => entry?.name === presetName) ?? null
}

function resolvePresetNonInteractive(projectConfig, servers, preset, presetName) {
    if (!preset) {
        throw new ZephyrError(
            `Zephyr cannot run non-interactively because preset "${presetName}" was not found in .zephyr/config.json.`,
            {code: 'ZEPHYR_PRESET_NOT_FOUND'}
        )
    }

    if (!preset.appId) {
        throw new ZephyrError(
            `Zephyr cannot run non-interactively because preset "${preset.name || presetName}" uses a legacy or invalid format. Rerun interactively once to repair .zephyr/config.json.`,
            {code: 'ZEPHYR_PRESET_REPAIR_REQUIRED'}
        )
    }

    const apps = projectConfig?.apps ?? []
    const appConfig = apps.find((app) => app.id === preset.appId)
    if (!appConfig) {
        throw new ZephyrError(
            `Zephyr cannot run non-interactively because preset "${preset.name || presetName}" references an application that no longer exists.`,
            {code: 'ZEPHYR_PRESET_INVALID'}
        )
    }

    const server = servers.find((entry) => entry.id === appConfig.serverId || entry.serverName === appConfig.serverName)
    if (!server) {
        throw new ZephyrError(
            `Zephyr cannot run non-interactively because preset "${preset.name || presetName}" references a server that no longer exists.`,
            {code: 'ZEPHYR_PRESET_INVALID'}
        )
    }

    return {
        server,
        appConfig,
        branch: preset.branch || appConfig.branch
    }
}

export async function selectDeploymentTarget(rootDir, {
    configurationService,
    runPrompt,
    logProcessing,
    logSuccess,
    logWarning,
    emitEvent,
    executionMode = {}
} = {}) {
    const nonInteractive = executionMode?.interactive === false
    const servers = await loadServers({
        logSuccess,
        logWarning,
        strict: nonInteractive,
        allowMigration: !nonInteractive
    })
    const projectConfig = await loadProjectConfig(rootDir, servers, {
        logSuccess,
        logWarning,
        strict: nonInteractive,
        allowMigration: !nonInteractive
    })

    let server = null
    let appConfig = null
    let isCreatingNewPreset = false

    const preset = nonInteractive
        ? findPresetByName(projectConfig, executionMode.presetName)
        : await configurationService.selectPreset(projectConfig, servers)

    const removeInvalidPreset = async () => {
        if (!preset || preset === 'create') {
            return
        }

        const removedPreset = removePreset(projectConfig, preset)
        if (!removedPreset) {
            return
        }

        await saveProjectConfig(rootDir, projectConfig)
        const presetLabel = removedPreset.name ? `"${removedPreset.name}"` : 'selected preset'
        logWarning?.(`Removed ${presetLabel} from .zephyr/config.json because it is invalid.`)
        isCreatingNewPreset = true
    }

    if (nonInteractive) {
        const resolved = resolvePresetNonInteractive(projectConfig, servers, preset, executionMode.presetName)
        server = resolved.server
        appConfig = resolved.appConfig
        appConfig = {
            ...appConfig,
            branch: resolved.branch
        }
    } else if (preset === 'create') {
        isCreatingNewPreset = true
        server = await configurationService.selectServer(servers)
        appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
    } else if (preset) {
        if (preset.appId) {
            appConfig = projectConfig.apps?.find((app) => app.id === preset.appId)

            if (!appConfig) {
                logWarning?.('Preset references an application that no longer exists. Creating a new configuration instead.')
                await removeInvalidPreset()
                server = await configurationService.selectServer(servers)
                appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
            } else {
                server = servers.find((entry) => entry.id === appConfig.serverId || entry.serverName === appConfig.serverName)

                if (!server) {
                    logWarning?.('Preset references a server that no longer exists. Creating a new configuration instead.')
                    await removeInvalidPreset()
                    server = await configurationService.selectServer(servers)
                    appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
                } else if (preset.branch && appConfig.branch !== preset.branch) {
                    appConfig.branch = preset.branch
                    await saveProjectConfig(rootDir, projectConfig)
                    logSuccess?.(`Updated branch to ${preset.branch} from preset.`)
                }
            }
        } else if (preset.key) {
            const keyParts = preset.key.split(':')
            const serverName = keyParts[0]
            const projectPath = keyParts[1]
            const presetBranch = preset.branch || (keyParts.length === 3 ? keyParts[2] : null)

            server = servers.find((entry) => entry.serverName === serverName)

            if (!server) {
                logWarning?.(`Preset references server "${serverName}" which no longer exists. Creating a new configuration instead.`)
                await removeInvalidPreset()
                server = await configurationService.selectServer(servers)
                appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
            } else {
                appConfig = projectConfig.apps?.find(
                    (app) => (app.serverId === server.id || app.serverName === serverName) && app.projectPath === projectPath
                )

                if (!appConfig) {
                    logWarning?.('Preset references an application that no longer exists. Creating a new configuration instead.')
                    await removeInvalidPreset()
                    appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
                } else {
                    preset.appId = appConfig.id
                    if (presetBranch && appConfig.branch !== presetBranch) {
                        appConfig.branch = presetBranch
                    }
                    preset.branch = appConfig.branch
                    await saveProjectConfig(rootDir, projectConfig)
                }
            }
        } else {
            logWarning?.('Preset format is invalid. Creating a new configuration instead.')
            await removeInvalidPreset()
            server = await configurationService.selectServer(servers)
            appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
        }
    } else {
        server = await configurationService.selectServer(servers)
        appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
    }

    if (nonInteractive && (!appConfig?.sshUser || !appConfig?.sshKey)) {
        throw new ZephyrError(
            `Zephyr cannot run non-interactively because preset "${preset?.name || executionMode.presetName}" is missing SSH details.`,
            {code: 'ZEPHYR_SSH_DETAILS_REQUIRED'}
        )
    }

    const updated = nonInteractive
        ? false
        : await configurationService.ensureSshDetails(appConfig, rootDir)

    if (updated) {
        await saveProjectConfig(rootDir, projectConfig)
        logSuccess?.('Updated .zephyr/config.json with SSH details.')
    }

    const deploymentConfig = {
        serverName: server.serverName,
        serverIp: server.serverIp,
        projectPath: appConfig.projectPath,
        branch: appConfig.branch,
        sshUser: appConfig.sshUser,
        sshKey: appConfig.sshKey
    }

    if (typeof emitEvent === 'function' && executionMode?.json) {
        emitEvent('log', {
            level: 'processing',
            message: 'Selected deployment target.',
            data: {deploymentConfig}
        })
    } else {
        logProcessing?.('\nSelected deployment target:')
        writeStdoutLine(JSON.stringify(deploymentConfig, null, 2))
    }

    if (!nonInteractive && (isCreatingNewPreset || !preset)) {
        const {presetName} = await runPrompt([
            {
                type: 'input',
                name: 'presetName',
                message: 'Enter a name for this preset (leave blank to skip)',
                default: isCreatingNewPreset ? '' : undefined
            }
        ])

        const trimmedName = presetName?.trim()

        if (trimmedName && trimmedName.length > 0) {
            const presets = projectConfig.presets ?? []
            const appId = appConfig.id

            if (!appId) {
                logWarning?.('Cannot save preset: app configuration missing ID.')
            } else {
                const existingIndex = presets.findIndex((entry) => entry.appId === appId)

                if (existingIndex >= 0) {
                    presets[existingIndex].name = trimmedName
                    presets[existingIndex].branch = deploymentConfig.branch
                } else {
                    presets.push({
                        name: trimmedName,
                        appId,
                        branch: deploymentConfig.branch
                    })
                }

                projectConfig.presets = presets
                await saveProjectConfig(rootDir, projectConfig)
                logSuccess?.(`Saved preset "${trimmedName}" to .zephyr/config.json`)
            }
        }
    }

    return {deploymentConfig, projectConfig}
}
