import {loadServers as loadServersImpl} from './config/servers.mjs'
import {loadProjectConfig as loadProjectConfigImpl} from './config/project.mjs'
import {writeToLogFile} from './utils/log-file.mjs'
import {createConfigurationActions} from './application/configuration/actions.mjs'
import {createAppContext} from './runtime/app-context.mjs'

export {main, runRemoteTasks} from './main.mjs'
export {connectToServer, executeRemoteCommand, readRemoteFile, downloadRemoteFile, deleteRemoteFile} from './ssh/index.mjs'

const appContext = createAppContext()
const {logProcessing, logSuccess, logWarning, logError, createSshClient, runCommand, runCommandCapture} = appContext
const configurationActions = createConfigurationActions(appContext)

export {logProcessing, logSuccess, logWarning, logError, runCommand, runCommandCapture, writeToLogFile, createSshClient}

export async function loadServers() {
    return await loadServersImpl({logSuccess, logWarning})
}

export async function loadProjectConfig(rootDir, servers) {
    return await loadProjectConfigImpl(rootDir, servers, {logSuccess, logWarning})
}

export function defaultProjectPath(currentDir) {
    return configurationActions.defaultProjectPath(currentDir)
}

export async function listGitBranches(currentDir) {
    return await configurationActions.listGitBranches(currentDir)
}

export async function promptSshDetails(currentDir, existing = {}) {
    return await configurationActions.promptSshDetails(currentDir, existing)
}

export async function promptServerDetails(existingServers = []) {
    return await configurationActions.promptServerDetails(existingServers)
}

export async function selectServer(servers) {
    return await configurationActions.selectServer(servers)
}

export async function promptAppDetails(currentDir, existing = {}) {
    return await configurationActions.promptAppDetails(currentDir, existing)
}

export async function selectApp(projectConfig, server, currentDir) {
    return await configurationActions.selectApp(projectConfig, server, currentDir)
}

export async function selectPreset(projectConfig, servers) {
    return await configurationActions.selectPreset(projectConfig, servers)
}
