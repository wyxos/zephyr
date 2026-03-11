import {loadProjectConfig as loadProjectConfigImpl} from './config/project.mjs'
import {loadServers as loadServersImpl} from './config/servers.mjs'
import {
    defaultProjectPath as defaultProjectPathImpl,
    listGitBranches as listGitBranchesImpl,
    createConfigurationService,
    promptAppDetails as promptAppDetailsImpl,
    promptServerDetails as promptServerDetailsImpl,
    selectPreset as selectPresetImpl,
} from './application/configuration/service.mjs'
import {generateId} from './utils/id.mjs'
import {writeToLogFile} from './utils/log-file.mjs'
import {promptSshDetails as promptSshDetailsImpl} from './ssh/keys.mjs'
import {createAppContext} from './runtime/app-context.mjs'

export {main, runRemoteTasks} from './main.mjs'
export {
    connectToServer,
    executeRemoteCommand,
    readRemoteFile,
    downloadRemoteFile,
    deleteRemoteFile
} from './ssh/index.mjs'

const appContext = createAppContext()
const {
    logProcessing,
    logSuccess,
    logWarning,
    logError,
    createSshClient,
    runCommand,
    runCommandCapture,
    runPrompt
} = appContext
const configurationService = createConfigurationService(appContext)

export {
    logProcessing,
    logSuccess,
    logWarning,
    logError,
    runCommand,
    runCommandCapture,
    writeToLogFile,
    createSshClient
}

export async function loadServers() {
    return await loadServersImpl({logSuccess, logWarning})
}

export async function loadProjectConfig(rootDir, servers) {
    return await loadProjectConfigImpl(rootDir, servers, {logSuccess, logWarning})
}

export function defaultProjectPath(currentDir) {
    return defaultProjectPathImpl(currentDir)
}

export async function listGitBranches(currentDir) {
    return await listGitBranchesImpl({currentDir, runCommandCapture, logWarning})
}

export async function promptSshDetails(currentDir, existing = {}) {
    return await promptSshDetailsImpl(currentDir, existing, {runPrompt})
}

export async function promptServerDetails(existingServers = []) {
    return await promptServerDetailsImpl({existingServers, runPrompt, createId: generateId})
}

export async function selectServer(servers) {
    return await configurationService.selectServer(servers)
}

export async function promptAppDetails(currentDir, existing = {}) {
    return await promptAppDetailsImpl({
        currentDir,
        existing,
        runPrompt,
        listGitBranches,
        resolveDefaultProjectPath: defaultProjectPath,
        promptSshDetails
    })
}

export async function selectApp(projectConfig, server, currentDir) {
    return await configurationService.selectApp(projectConfig, server, currentDir)
}

export async function selectPreset(projectConfig, servers) {
    return await selectPresetImpl({projectConfig, servers, runPrompt})
}
