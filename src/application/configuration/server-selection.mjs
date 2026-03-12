import inquirer from 'inquirer'

import {generateId} from '../../utils/id.mjs'
import {saveServers} from '../../config/servers.mjs'

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
            message: 'Enter a server name',
            default: defaults.serverName
        },
        {
            type: 'input',
            name: 'serverIp',
            message: 'Enter the server IP address',
            default: defaults.serverIp
        }
    ])

    return {
        id: createId(),
        serverName: answers.serverName.trim() || defaults.serverName,
        serverIp: answers.serverIp.trim() || defaults.serverIp
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
        logProcessing?.('No servers are configured yet. Creating one now.')
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
            name: '➕ Create a new server',
            value: 'create'
        }
    )

    const {selection} = await runPrompt([
        {
            type: 'list',
            name: 'selection',
            message: 'Select a server',
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
