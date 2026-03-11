import {writeStdoutLine} from '../../utils/output.mjs'
import {loadServers} from '../../config/servers.mjs'
import {loadProjectConfig, removePreset, saveProjectConfig} from '../../config/project.mjs'

export async function selectDeploymentTarget(rootDir, {
    actions,
    runPrompt,
    logProcessing,
    logSuccess,
    logWarning
} = {}) {
    const servers = await loadServers({logSuccess, logWarning})
    const projectConfig = await loadProjectConfig(rootDir, servers, {logSuccess, logWarning})

    let server = null
    let appConfig = null
    let isCreatingNewPreset = false

    const preset = await actions.selectPreset(projectConfig, servers)

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

    if (preset === 'create') {
        isCreatingNewPreset = true
        server = await actions.selectServer(servers)
        appConfig = await actions.selectApp(projectConfig, server, rootDir)
    } else if (preset) {
        if (preset.appId) {
            appConfig = projectConfig.apps?.find((app) => app.id === preset.appId)

            if (!appConfig) {
                logWarning?.('Preset references app configuration that no longer exists. Creating new configuration.')
                await removeInvalidPreset()
                server = await actions.selectServer(servers)
                appConfig = await actions.selectApp(projectConfig, server, rootDir)
            } else {
                server = servers.find((entry) => entry.id === appConfig.serverId || entry.serverName === appConfig.serverName)

                if (!server) {
                    logWarning?.('Preset references server that no longer exists. Creating new configuration.')
                    await removeInvalidPreset()
                    server = await actions.selectServer(servers)
                    appConfig = await actions.selectApp(projectConfig, server, rootDir)
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
                logWarning?.(`Preset references server "${serverName}" which no longer exists. Creating new configuration.`)
                await removeInvalidPreset()
                server = await actions.selectServer(servers)
                appConfig = await actions.selectApp(projectConfig, server, rootDir)
            } else {
                appConfig = projectConfig.apps?.find(
                    (app) => (app.serverId === server.id || app.serverName === serverName) && app.projectPath === projectPath
                )

                if (!appConfig) {
                    logWarning?.('Preset references app configuration that no longer exists. Creating new configuration.')
                    await removeInvalidPreset()
                    appConfig = await actions.selectApp(projectConfig, server, rootDir)
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
            logWarning?.('Preset format is invalid. Creating new configuration.')
            await removeInvalidPreset()
            server = await actions.selectServer(servers)
            appConfig = await actions.selectApp(projectConfig, server, rootDir)
        }
    } else {
        server = await actions.selectServer(servers)
        appConfig = await actions.selectApp(projectConfig, server, rootDir)
    }

    const updated = await actions.ensureSshDetails(appConfig, rootDir)

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

    logProcessing?.('\nSelected deployment target:')
    writeStdoutLine(JSON.stringify(deploymentConfig, null, 2))

    if (isCreatingNewPreset || !preset) {
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
