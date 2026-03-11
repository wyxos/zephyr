import inquirer from 'inquirer'

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
