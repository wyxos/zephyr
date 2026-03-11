import inquirer from 'inquirer'

import {generateId} from '../../utils/id.mjs'
import {saveProjectConfig} from '../../config/project.mjs'

export async function selectApp({
                                    projectConfig,
                                    server,
                                    currentDir,
                                    runPrompt,
                                    logWarning,
                                    logProcessing,
                                    logSuccess,
                                    persistProjectConfig = saveProjectConfig,
                                    createId = generateId,
                                    promptAppDetails
                                } = {}) {
    const apps = projectConfig.apps ?? []
    const matches = apps
        .map((app, index) => ({app, index}))
        .filter(({app}) => app.serverId === server.id || app.serverName === server.serverName)

    if (matches.length === 0) {
        if (apps.length > 0) {
            const availableServers = [...new Set(apps.map((app) => app.serverName).filter(Boolean))]
            if (availableServers.length > 0) {
                logWarning?.(
                    `No applications configured for server "${server.serverName}". Available servers: ${availableServers.join(', ')}`
                )
            }
        }

        logProcessing?.(`No applications configured for ${server.serverName}. Let's create one.`)
        const appDetails = await promptAppDetails(currentDir)
        const appConfig = {
            id: createId(),
            serverId: server.id,
            serverName: server.serverName,
            ...appDetails
        }

        projectConfig.apps.push(appConfig)
        await persistProjectConfig(currentDir, projectConfig)
        logSuccess?.('Saved deployment configuration to .zephyr/config.json')
        return appConfig
    }

    const choices = matches.map(({app}, matchIndex) => ({
        name: `${app.projectPath} (${app.branch})`,
        value: matchIndex
    }))

    choices.push(
        new inquirer.Separator(),
        {
            name: '➕ Configure new application for this server',
            value: 'create'
        }
    )

    const {selection} = await runPrompt([
        {
            type: 'list',
            name: 'selection',
            message: `Select application for ${server.serverName}`,
            choices,
            default: 0
        }
    ])

    if (selection === 'create') {
        const appDetails = await promptAppDetails(currentDir)
        const appConfig = {
            id: createId(),
            serverId: server.id,
            serverName: server.serverName,
            ...appDetails
        }

        projectConfig.apps.push(appConfig)
        await persistProjectConfig(currentDir, projectConfig)
        logSuccess?.('Appended deployment configuration to .zephyr/config.json')
        return appConfig
    }

    return matches[selection].app
}
