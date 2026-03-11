import {writeToLogFile} from './utils/log-file.mjs'
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
    runCommandCapture
} = appContext

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
