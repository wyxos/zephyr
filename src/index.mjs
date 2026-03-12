import {writeToLogFile} from './utils/log-file.mjs'
import {createAppContext} from './runtime/app-context.mjs'

const appContext = createAppContext()
const {
    logProcessing,
    logSuccess,
    logWarning,
    logError,
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
    writeToLogFile
}
