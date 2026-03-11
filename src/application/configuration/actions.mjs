import * as configFlow from '../../utils/config-flow.mjs'
import * as sshKeys from '../../ssh/keys.mjs'
import {generateId} from '../../utils/id.mjs'
import {saveServers} from '../../config/servers.mjs'
import {saveProjectConfig} from '../../config/project.mjs'

export function createConfigurationActions({
                                               runPrompt,
                                               runCommandCapture,
                                               logProcessing,
                                               logSuccess,
                                               logWarning
                                           } = {}) {
    function defaultProjectPath(currentDir) {
        return configFlow.defaultProjectPath(currentDir)
    }

    async function listGitBranches(currentDir) {
        return await configFlow.listGitBranches(currentDir, {runCommandCapture, logWarning})
    }

    async function promptSshDetails(currentDir, existing = {}) {
        return await sshKeys.promptSshDetails(currentDir, existing, {runPrompt})
    }

    async function ensureSshDetails(config, currentDir) {
        return await sshKeys.ensureSshDetails(config, currentDir, {runPrompt, logProcessing})
    }

    async function promptServerDetails(existingServers = []) {
        return await configFlow.promptServerDetails(existingServers, {runPrompt, generateId})
    }

    async function selectServer(servers) {
        return await configFlow.selectServer(servers, {
            runPrompt,
            logProcessing,
            logSuccess,
            saveServers,
            promptServerDetails
        })
    }

    async function promptAppDetails(currentDir, existing = {}) {
        return await configFlow.promptAppDetails(currentDir, existing, {
            runPrompt,
            listGitBranches,
            defaultProjectPath,
            promptSshDetails
        })
    }

    async function selectApp(projectConfig, server, currentDir) {
        return await configFlow.selectApp(projectConfig, server, currentDir, {
            runPrompt,
            logWarning,
            logProcessing,
            logSuccess,
            saveProjectConfig,
            generateId,
            promptAppDetails
        })
    }

    async function selectPreset(projectConfig, servers) {
        return await configFlow.selectPreset(projectConfig, servers, {runPrompt})
    }

    return {
        defaultProjectPath,
        listGitBranches,
        promptSshDetails,
        ensureSshDetails,
        promptServerDetails,
        selectServer,
        promptAppDetails,
        selectApp,
        selectPreset
    }
}
