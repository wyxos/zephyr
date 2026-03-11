import {
    ensureSshDetails as ensureSshDetailsBase,
    promptSshDetails as promptSshDetailsBase
} from '../../ssh/keys.mjs'
import {saveProjectConfig} from '../../config/project.mjs'
import {saveServers} from '../../config/servers.mjs'
import {generateId} from '../../utils/id.mjs'
import {defaultProjectPath, listGitBranches, promptAppDetails} from './app-details.mjs'
import {selectApp} from './app-selection.mjs'
import {selectPreset} from './preset-selection.mjs'
import {promptServerDetails, selectServer} from './server-selection.mjs'

export {
    defaultProjectPath,
    listGitBranches,
    promptAppDetails,
    promptServerDetails,
    selectServer,
    selectApp,
    selectPreset
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
