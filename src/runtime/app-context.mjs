import chalk from 'chalk'
import inquirer from 'inquirer'
import {NodeSSH} from 'node-ssh'

import {createChalkLogger} from '../utils/output.mjs'
import {runCommand as runCommandBase, runCommandCapture as runCommandCaptureBase} from '../utils/command.mjs'
import {createLocalCommandRunners} from './local-command.mjs'
import {createRunPrompt} from './prompt.mjs'
import {createSshClientFactory} from './ssh-client.mjs'

export function createAppContext({
                                     chalkInstance = chalk,
                                     inquirerInstance = inquirer,
                                     NodeSSHClass = NodeSSH,
                                     runCommandImpl = runCommandBase,
                                     runCommandCaptureImpl = runCommandCaptureBase
                                 } = {}) {
    const {logProcessing, logSuccess, logWarning, logError} = createChalkLogger(chalkInstance)
    const runPrompt = createRunPrompt({inquirer: inquirerInstance})
    const createSshClient = createSshClientFactory({NodeSSH: NodeSSHClass})
    const {runCommand, runCommandCapture} = createLocalCommandRunners({
        runCommandBase: runCommandImpl,
        runCommandCaptureBase: runCommandCaptureImpl
    })

    return {
        logProcessing,
        logSuccess,
        logWarning,
        logError,
        runPrompt,
        createSshClient,
        runCommand,
        runCommandCapture
    }
}
