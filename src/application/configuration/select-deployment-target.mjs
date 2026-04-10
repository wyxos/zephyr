import {writeStdoutLine} from '../../utils/output.mjs'
import {loadServers} from '../../config/servers.mjs'
import {loadProjectConfig, removePreset, saveProjectConfig} from '../../config/project.mjs'
import {
    buildPresetOptionsFromExecutionMode,
    normalizePresetOptions,
    presetOptionsEqual
} from '../../config/preset-options.mjs'
import {ZephyrError} from '../../runtime/errors.mjs'

function findPresetByName(projectConfig, presetName) {
    const presets = projectConfig?.presets ?? []
    return presets.find((entry) => entry?.name === presetName) ?? null
}

function createPresetState(rootDir, projectConfig, preset, {
    logSuccess
} = {}) {
    if (!preset) {
        return null
    }

    return {
        name: preset.name,
        get options() {
            return normalizePresetOptions(preset.options)
        },
        async saveOptions(nextOptions, {
            message = null
        } = {}) {
            const normalizedOptions = normalizePresetOptions(nextOptions)

            if (presetOptionsEqual(preset.options, normalizedOptions)) {
                return false
            }

            preset.options = normalizedOptions
            await saveProjectConfig(rootDir, projectConfig)

            if (message) {
                logSuccess?.(message)
            }

            return true
        },
        async applyExecutionMode(executionMode = {}) {
            const nextOptions = buildPresetOptionsFromExecutionMode(executionMode, preset.options)
            return await this.saveOptions(nextOptions)
        }
    }
}

async function promptPresetAutoCommit(runPrompt, enabledByDefault = false) {
    const {autoCommitPreference} = await runPrompt([
        {
            type: 'input',
            name: 'autoCommitPreference',
            message: 'Enable auto-commit for dirty changes on this preset? Leave blank for manual commit prompts.',
            default: enabledByDefault ? 'enabled' : ''
        }
    ])

    return typeof autoCommitPreference === 'string' && autoCommitPreference.trim().length > 0
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
            `Zephyr cannot run non-interactively because preset "${preset.name || presetName}" is invalid.`,
            {code: 'ZEPHYR_PRESET_INVALID'}
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
    let activePreset = null
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
        activePreset = preset
        const resolved = resolvePresetNonInteractive(projectConfig, servers, preset, executionMode.presetName)
        server = resolved.server
        appConfig = {
            ...resolved.appConfig,
            branch: resolved.branch
        }
    } else if (preset === 'create') {
        isCreatingNewPreset = true
        server = await configurationService.selectServer(servers)
        appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
    } else if (preset) {
        activePreset = preset
        appConfig = projectConfig.apps?.find((app) => app.id === preset.appId)

        if (!appConfig) {
            logWarning?.('Preset references an application that no longer exists. Creating a new configuration instead.')
            await removeInvalidPreset()
            activePreset = null
            server = await configurationService.selectServer(servers)
            appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
        } else {
            server = servers.find((entry) => entry.id === appConfig.serverId || entry.serverName === appConfig.serverName)

            if (!server) {
                logWarning?.('Preset references a server that no longer exists. Creating a new configuration instead.')
                await removeInvalidPreset()
                activePreset = null
                server = await configurationService.selectServer(servers)
                appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
            } else if (preset.branch && appConfig.branch !== preset.branch) {
                appConfig.branch = preset.branch
                await saveProjectConfig(rootDir, projectConfig)
                logSuccess?.(`Updated branch to ${preset.branch} from preset.`)
            }
        }
    } else {
        server = await configurationService.selectServer(servers)
        appConfig = await configurationService.selectApp(projectConfig, server, rootDir)
    }

    if (nonInteractive && (!appConfig?.sshUser || !appConfig?.sshKey)) {
        throw new ZephyrError(
            `Zephyr cannot run non-interactively because preset "${activePreset?.name || executionMode.presetName}" is missing SSH details.`,
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

    if (!nonInteractive && (isCreatingNewPreset || !activePreset)) {
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
            const appId = appConfig.id

            if (!appId) {
                logWarning?.('Cannot save preset: app configuration missing ID.')
            } else {
                const existingPreset = findPresetByName(projectConfig, trimmedName)
                const autoCommitEnabled = await promptPresetAutoCommit(
                    runPrompt,
                    executionMode.autoCommit === true || existingPreset?.options?.autoCommit === true
                )
                const nextPreset = existingPreset ?? {
                    name: trimmedName,
                    appId,
                    branch: deploymentConfig.branch,
                    options: normalizePresetOptions()
                }

                nextPreset.name = trimmedName
                nextPreset.appId = appId
                nextPreset.branch = deploymentConfig.branch
                nextPreset.options = normalizePresetOptions({
                    ...buildPresetOptionsFromExecutionMode(executionMode, nextPreset.options),
                    autoCommit: autoCommitEnabled
                })

                if (!existingPreset) {
                    projectConfig.presets = [...(projectConfig.presets ?? []), nextPreset]
                }

                await saveProjectConfig(rootDir, projectConfig)
                logSuccess?.(`Saved preset "${trimmedName}" to .zephyr/config.json`)
                activePreset = nextPreset
            }
        }
    }

    return {
        deploymentConfig,
        projectConfig,
        presetState: createPresetState(rootDir, projectConfig, activePreset, {
            logSuccess
        })
    }
}
