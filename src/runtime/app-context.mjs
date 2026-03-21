import process from 'node:process'
import chalk from 'chalk'
import inquirer from 'inquirer'
import {NodeSSH} from 'node-ssh'

import {createChalkLogger, createJsonEventEmitter, createJsonLogger} from '../utils/output.mjs'
import {runCommand as runCommandBase, runCommandCapture as runCommandCaptureBase} from '../utils/command.mjs'
import {createLocalCommandRunners} from './local-command.mjs'
import {createRunPrompt} from './prompt.mjs'
import {createSshClientFactory} from './ssh-client.mjs'

export function createAppContext({
                                     chalkInstance = chalk,
                                     inquirerInstance = inquirer,
                                     NodeSSHClass = NodeSSH,
                                     processInstance = process,
                                     runCommandImpl = runCommandBase,
                                     runCommandCaptureImpl = runCommandCaptureBase,
                                     executionMode = {}
                                 } = {}) {
    const normalizedExecutionMode = {
        interactive: executionMode.interactive !== false,
        json: executionMode.json === true,
        workflow: executionMode.workflow ?? 'deploy',
        presetName: executionMode.presetName ?? null,
        maintenanceMode: executionMode.maintenanceMode ?? null,
        skipGitHooks: executionMode.skipGitHooks === true,
        resumePending: executionMode.resumePending === true,
        discardPending: executionMode.discardPending === true
    }
    const emitEvent = normalizedExecutionMode.json
        ? createJsonEventEmitter({workflow: normalizedExecutionMode.workflow})
        : null
    const {logProcessing, logSuccess, logWarning, logError} = normalizedExecutionMode.json
        ? createJsonLogger({emitEvent})
        : createChalkLogger(chalkInstance)
    const runPrompt = createRunPrompt({
        inquirer: inquirerInstance,
        interactive: normalizedExecutionMode.interactive,
        emitEvent,
        workflow: normalizedExecutionMode.workflow
    })
    const hasInteractiveTerminal = Boolean(processInstance?.stdin?.isTTY && processInstance?.stdout?.isTTY)
    const createSshClient = createSshClientFactory({NodeSSH: NodeSSHClass})
    const {runCommand, runCommandCapture} = createLocalCommandRunners({
        runCommandBase: runCommandImpl,
        runCommandCaptureBase: runCommandCaptureImpl
    })

    const runCommandWithMode = (command, args, options = {}) => runCommand(command, args, {
        ...options,
        forwardStdoutToStderr: normalizedExecutionMode.json
    })

    return {
        logProcessing,
        logSuccess,
        logWarning,
        logError,
        runPrompt,
        createSshClient,
        runCommand: runCommandWithMode,
        runCommandCapture,
        emitEvent,
        hasInteractiveTerminal,
        executionMode: normalizedExecutionMode
    }
}
