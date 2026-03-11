import path from 'node:path'
import inquirer from 'inquirer'

import {
    ensureSshDetails as ensureSshDetailsBase,
    promptSshDetails as promptSshDetailsBase
} from '../../ssh/keys.mjs'
import {generateId} from '../../utils/id.mjs'
import {saveServers} from '../../config/servers.mjs'
import {saveProjectConfig} from '../../config/project.mjs'

export function defaultProjectPath(currentDir) {
    return `~/webapps/${path.basename(currentDir)}`
}

export async function listGitBranches({
                                          currentDir,
                                          runCommandCapture,
                                          logWarning
                                      } = {}) {
    try {
        const output = await runCommandCapture(
            'git',
            ['branch', '--format', '%(refname:short)'],
            {cwd: currentDir}
        )

        const branches = output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)

        return branches.length ? branches : ['master']
    } catch (_error) {
        logWarning?.('Unable to read git branches; defaulting to master.')
        return ['master']
    }
}

export async function promptServerDetails({
                                              existingServers = [],
                                              runPrompt,
                                              createId = generateId
                                          } = {}) {
    const defaults = {
        serverName: existingServers.length === 0 ? 'home' : `server-${existingServers.length + 1}`,
        serverIp: '1.1.1.1'
    }

    const answers = await runPrompt([
        {
            type: 'input',
            name: 'serverName',
            message: 'Server name',
            default: defaults.serverName
        },
        {
            type: 'input',
            name: 'serverIp',
            message: 'Server IP address',
            default: defaults.serverIp
        }
    ])

    return {
        id: createId(),
        serverName: answers.serverName.trim() || defaults.serverName,
        serverIp: answers.serverIp.trim() || defaults.serverIp
    }
}

export async function promptAppDetails({
                                           currentDir,
                                           existing = {},
                                           runPrompt,
                                           listGitBranches,
                                           resolveDefaultProjectPath = defaultProjectPath,
                                           promptSshDetails
                                       } = {}) {
    const branches = await listGitBranches(currentDir)
    const defaultBranch = existing.branch || (branches.includes('master') ? 'master' : branches[0])
    const defaults = {
        projectPath: existing.projectPath || resolveDefaultProjectPath(currentDir),
        branch: defaultBranch
    }

    const answers = await runPrompt([
        {
            type: 'input',
            name: 'projectPath',
            message: 'Remote project path',
            default: defaults.projectPath
        },
        {
            type: 'list',
            name: 'branchSelection',
            message: 'Branch to deploy',
            choices: [
                ...branches.map((branch) => ({name: branch, value: branch})),
                new inquirer.Separator(),
                {name: 'Enter custom branch…', value: '__custom'}
            ],
            default: defaults.branch
        }
    ])

    let branch = answers.branchSelection

    if (branch === '__custom') {
        const {customBranch} = await runPrompt([
            {
                type: 'input',
                name: 'customBranch',
                message: 'Custom branch name',
                default: defaults.branch
            }
        ])

        branch = customBranch.trim() || defaults.branch
    }

    const sshDetails = await promptSshDetails(currentDir, existing)

    return {
        projectPath: answers.projectPath.trim() || defaults.projectPath,
        branch,
        ...sshDetails
    }
}

export async function selectServer({
                                       servers,
                                       runPrompt,
                                       logProcessing,
                                       logSuccess,
                                       persistServers = saveServers,
                                       promptServerDetails
                                   } = {}) {
    if (servers.length === 0) {
        logProcessing?.("No servers configured. Let's create one.")
        const server = await promptServerDetails()
        servers.push(server)
        await persistServers(servers)
        logSuccess?.('Saved server configuration to ~/.config/zephyr/servers.json')
        return server
    }

    const choices = servers.map((server, index) => ({
        name: `${server.serverName} (${server.serverIp})`,
        value: index
    }))

    choices.push(
        new inquirer.Separator(),
        {
            name: '➕ Register a new server',
            value: 'create'
        }
    )

    const {selection} = await runPrompt([
        {
            type: 'list',
            name: 'selection',
            message: 'Select server or register new',
            choices,
            default: 0
        }
    ])

    if (selection === 'create') {
        const server = await promptServerDetails(servers)
        servers.push(server)
        await persistServers(servers)
        logSuccess?.('Appended server configuration to ~/.config/zephyr/servers.json')
        return server
    }

    return servers[selection]
}

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

export async function selectPreset({
                                       projectConfig,
                                       servers,
                                       runPrompt
                                   } = {}) {
    const presets = projectConfig.presets ?? []
    const apps = projectConfig.apps ?? []

    if (presets.length === 0) {
        return null
    }

    const choices = presets.map((preset, index) => {
        let displayName = preset.name

        if (preset.appId) {
            const app = apps.find((entry) => entry.id === preset.appId)
            if (app) {
                const server = servers.find((entry) => entry.id === app.serverId || entry.serverName === app.serverName)
                const serverName = server?.serverName || 'unknown'
                const branch = preset.branch || app.branch || 'unknown'
                displayName = `${preset.name} (${serverName} → ${app.projectPath} [${branch}])`
            }
        } else if (preset.key) {
            const keyParts = preset.key.split(':')
            const serverName = keyParts[0]
            const projectPath = keyParts[1]
            const branch = preset.branch || (keyParts.length === 3 ? keyParts[2] : 'unknown')
            displayName = `${preset.name} (${serverName} → ${projectPath} [${branch}])`
        }

        return {
            name: displayName,
            value: index
        }
    })

    choices.push(
        new inquirer.Separator(),
        {
            name: '➕ Create new preset',
            value: 'create'
        }
    )

    const {selection} = await runPrompt([
        {
            type: 'list',
            name: 'selection',
            message: 'Select preset or create new',
            choices,
            default: 0
        }
    ])

    return selection === 'create' ? 'create' : presets[selection]
}

function assertConfigurationDeps({
                                     runPrompt,
                                     runCommandCapture,
                                     logProcessing,
                                     logSuccess,
                                     logWarning
                                 } = {}) {
    if (!runPrompt || !runCommandCapture || !logProcessing || !logSuccess || !logWarning) {
        throw new Error('createConfigurationService requires prompt, command, and logger dependencies.')
    }
}

export function createConfigurationService(deps = {}) {
    assertConfigurationDeps(deps)

    const {
        runPrompt,
        runCommandCapture,
        logProcessing,
        logSuccess,
        logWarning
    } = deps

    const listBranches = (currentDir) => listGitBranches({
        currentDir,
        runCommandCapture,
        logWarning
    })

    const promptSshDetails = (currentDir, existing = {}) => promptSshDetailsBase(currentDir, existing, {
        runPrompt
    })

    const promptServerDetailsBound = (existingServers = []) => promptServerDetails({
        existingServers,
        runPrompt
    })

    const promptAppDetailsBound = (currentDir, existing = {}) => promptAppDetails({
        currentDir,
        existing,
        runPrompt,
        listGitBranches: listBranches,
        resolveDefaultProjectPath: defaultProjectPath,
        promptSshDetails
    })

    return {
        ensureSshDetails(config, currentDir) {
            return ensureSshDetailsBase(config, currentDir, {runPrompt, logProcessing})
        },

        selectServer(servers) {
            return selectServer({
                servers,
                runPrompt,
                logProcessing,
                logSuccess,
                persistServers: saveServers,
                promptServerDetails: promptServerDetailsBound
            })
        },

        selectApp(projectConfig, server, currentDir) {
            return selectApp({
                projectConfig,
                server,
                currentDir,
                runPrompt,
                logWarning,
                logProcessing,
                logSuccess,
                persistProjectConfig: saveProjectConfig,
                createId: generateId,
                promptAppDetails: promptAppDetailsBound
            })
        },

        selectPreset(projectConfig, servers) {
            return selectPreset({
                projectConfig,
                servers,
                runPrompt
            })
        }
    }
}
