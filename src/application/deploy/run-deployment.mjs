import fs from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'

import {
    acquireRemoteLock,
    compareLocksAndPrompt,
    releaseLocalLock,
    releaseRemoteLock
} from '../../deploy/locks.mjs'
import {createRemoteExecutor} from '../../deploy/remote-exec.mjs'
import {resolveSshKeyPath} from '../../ssh/keys.mjs'
import {cleanupOldLogs, closeLogFile, getLogFilePath, writeToLogFile} from '../../utils/log-file.mjs'
import {resolveRemotePath} from '../../utils/remote-path.mjs'
import {buildRemoteDeploymentPlan, resolveRemoteDeploymentState} from './build-remote-deployment-plan.mjs'
import {executeRemoteDeploymentPlan} from './execute-remote-deployment-plan.mjs'
import {prepareLocalDeployment} from './prepare-local-deployment.mjs'

async function resolveRemoteHome(ssh, sshUser) {
    const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
    return remoteHomeResult.stdout.trim() || `/home/${sshUser}`
}

async function connectToRemoteDeploymentTarget({
                                                   config,
                                                   createSshClient,
                                                   sshUser,
                                                   privateKey,
                                                   remoteCwd = null,
                                                   logProcessing,
                                                   message
                                               } = {}) {
    const ssh = createSshClient()

    logProcessing?.(`\n${message ?? `Connecting to ${config.serverIp} as ${sshUser}...`}`)

    await ssh.connect({
        host: config.serverIp,
        username: sshUser,
        privateKey
    })

    if (remoteCwd) {
        return {ssh, remoteCwd}
    }

    const remoteHome = await resolveRemoteHome(ssh, sshUser)

    return {
        ssh,
        remoteCwd: resolveRemotePath(config.projectPath, remoteHome)
    }
}

async function maybeRecoverLaravelMaintenanceMode({
    remotePlan,
    executionState,
    executeRemote,
    runPrompt,
    logProcessing,
    logWarning,
    executionMode = {},
    forceAutoRecovery = false,
    reason = null
} = {}) {
    if (!remotePlan?.remoteIsLaravel || !remotePlan?.maintenanceModeEnabled) {
        return
    }

    if (!executionState?.enteredMaintenanceMode || executionState.exitedMaintenanceMode) {
        return
    }

    if (typeof executeRemote !== 'function') {
        logWarning?.('Deployment failed while Laravel maintenance mode may still be enabled.')
        return
    }

    try {
        if (forceAutoRecovery || executionMode?.interactive === false) {
            const reasonSuffix = typeof reason === 'string' && reason.length > 0
                ? ` because of ${reason}`
                : ''
            logProcessing?.(`Deployment interrupted${reasonSuffix} after Laravel maintenance mode was enabled. Running \`artisan up\` automatically...`)
            await executeRemote(
                'Disable Laravel maintenance mode',
                remotePlan.maintenanceUpCommand ?? `${remotePlan.phpCommand} artisan up`
            )
            executionState.exitedMaintenanceMode = true
            return
        }

        if (typeof runPrompt !== 'function') {
            logWarning?.('Deployment failed while Laravel maintenance mode may still be enabled.')
            return
        }

        const answers = await runPrompt([
            {
                type: 'confirm',
                name: 'disableMaintenanceMode',
                message: 'Deployment failed after Laravel maintenance mode was enabled. Run `artisan up` now?',
                default: true
            }
        ])
        const disableMaintenanceMode = answers?.disableMaintenanceMode === true

        if (!disableMaintenanceMode) {
            logWarning?.('Laravel maintenance mode remains enabled because recovery was not confirmed.')
            return
        }

        await executeRemote(
            'Disable Laravel maintenance mode',
            remotePlan.maintenanceUpCommand ?? `${remotePlan.phpCommand} artisan up`
        )
        executionState.exitedMaintenanceMode = true
    } catch (error) {
        logWarning?.(`Failed to disable Laravel maintenance mode after deployment error: ${error.message}`)
    }
}

function signalToExitCode(signal) {
    const signalNumbers = {
        SIGHUP: 1,
        SIGINT: 2,
        SIGTERM: 15
    }

    if (!signalNumbers[signal]) {
        return null
    }

    return 128 + signalNumbers[signal]
}

export function createAbnormalExitGuard({
    processRef = process,
    cleanup = async () => {},
    terminate = null,
    logWarning
} = {}) {
    const listeners = new Map()
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
    let active = true
    let cleanupPromise = null

    const terminateProcess = typeof terminate === 'function'
        ? terminate
        : async (signal) => {
            const exitCode = signalToExitCode(signal)

            if (typeof exitCode === 'number') {
                processRef.exitCode = exitCode
            }

            if (typeof processRef.kill === 'function' && typeof processRef.pid === 'number') {
                processRef.kill(processRef.pid, signal)
            }
        }

    const unregister = () => {
        if (!active) {
            return
        }

        active = false

        for (const [signal, handler] of listeners.entries()) {
            if (typeof processRef.off === 'function') {
                processRef.off(signal, handler)
                continue
            }

            if (typeof processRef.removeListener === 'function') {
                processRef.removeListener(signal, handler)
            }
        }

        listeners.clear()
    }

    const run = async (signal) => {
        if (!active) {
            return cleanupPromise
        }

        if (cleanupPromise) {
            return cleanupPromise
        }

        unregister()
        cleanupPromise = (async () => {
            try {
                await cleanup(signal)
            } catch (error) {
                logWarning?.(`Best-effort deploy recovery after ${signal} failed: ${error.message}`)
            } finally {
                await terminateProcess(signal)
            }
        })()

        return cleanupPromise
    }

    for (const signal of signals) {
        const handler = () => {
            void run(signal)
        }

        listeners.set(signal, handler)
        processRef.once(signal, handler)
    }

    return {
        unregister,
        run
    }
}

async function cleanupDeploymentResources({
    rootDir,
    ssh,
    remoteCwd,
    lockAcquired,
    logWarning
} = {}) {
    if (lockAcquired && ssh && remoteCwd) {
        try {
            await releaseRemoteLock(ssh, remoteCwd, {logWarning})
            await releaseLocalLock(rootDir, {logWarning})
        } catch (error) {
            logWarning?.(`Failed to release lock: ${error.message}`)
        }
    }

    await closeLogFile()

    if (ssh) {
        ssh.dispose()
    }
}

export {maybeRecoverLaravelMaintenanceMode}

export async function runDeployment(config, options = {}) {
    const {
        snapshot = null,
        rootDir = process.cwd(),
        versionArg = null,
        context,
        presetState = null
    } = options

    const {
        logProcessing,
        logSuccess,
        logWarning,
        logError,
        runPrompt,
        createSshClient,
        runCommand,
        executionMode
    } = context

    await cleanupOldLogs(rootDir)

    const sshUser = config.sshUser || os.userInfo().username
    const privateKeyPath = await resolveSshKeyPath(config.sshKey)
    const privateKey = await fs.readFile(privateKeyPath, 'utf8')
    let ssh = null
    let remoteCwd = null
    let executeRemote = null
    let remotePlan = null
    let remoteState = null
    const executionState = {
        enteredMaintenanceMode: false,
        exitedMaintenanceMode: false
    }

    let lockAcquired = false
    const abnormalExitGuard = createAbnormalExitGuard({
        logWarning,
        cleanup: async (signal) => {
            let recoverySsh = null
            let recoveryExecutor = executeRemote

            try {
                if (remoteCwd) {
                    ({ssh: recoverySsh} = await connectToRemoteDeploymentTarget({
                        config,
                        createSshClient,
                        sshUser,
                        privateKey,
                        remoteCwd,
                        logProcessing,
                        message: `Reconnecting to ${config.serverIp} as ${sshUser} for abnormal-exit recovery...`
                    }))

                    recoveryExecutor = createRemoteExecutor({
                        ssh: recoverySsh,
                        rootDir,
                        remoteCwd,
                        writeToLogFile,
                        logProcessing,
                        logSuccess,
                        logError
                    })
                }

                await maybeRecoverLaravelMaintenanceMode({
                    remotePlan,
                    executionState,
                    executeRemote: recoveryExecutor,
                    runPrompt,
                    logProcessing,
                    logWarning,
                    executionMode,
                    forceAutoRecovery: true,
                    reason: signal
                })
            } finally {
                await cleanupDeploymentResources({
                    rootDir,
                    ssh: recoverySsh ?? ssh,
                    remoteCwd,
                    lockAcquired,
                    logWarning
                })
                lockAcquired = false

                if (recoverySsh && ssh && recoverySsh !== ssh) {
                    ssh.dispose()
                }

                ssh = null
            }
        }
    })

    try {
        ({ssh, remoteCwd} = await connectToRemoteDeploymentTarget({
            config,
            createSshClient,
            sshUser,
            privateKey,
            logProcessing,
            message: `Connecting to ${config.serverIp} as ${sshUser} to inspect remote deployment state...`
        }))

        remoteState = await resolveRemoteDeploymentState({
            snapshot,
            executionMode,
            ssh,
            remoteCwd,
            runPrompt,
            logSuccess,
            logWarning
        })

        // Reconnect after local checks so long-running validation does not hold a stale SSH session open.
        await ssh.dispose()
        ssh = null

        const {requiredPhpVersion} = await prepareLocalDeployment(config, {
            snapshot,
            rootDir,
            versionArg,
            skipGitHooks: executionMode?.skipGitHooks === true,
            skipTests: executionMode?.skipTests === true,
            skipLint: executionMode?.skipLint === true,
            skipVersioning: executionMode?.skipVersioning === true,
            autoCommit: executionMode?.autoCommit === true,
            runPrompt,
            runCommand,
            runCommandCapture: context.runCommandCapture,
            logProcessing,
            logSuccess,
            logWarning
        })

        ;({ssh} = await connectToRemoteDeploymentTarget({
            config,
            createSshClient,
            sshUser,
            privateKey,
            remoteCwd,
            logProcessing,
            message: `Reconnecting to ${config.serverIp} as ${sshUser}...`
        }))

        logProcessing('Connection established. Acquiring deployment lock on server...')
        await acquireRemoteLock(ssh, remoteCwd, rootDir, {
            runPrompt,
            logProcessing,
            logWarning,
            interactive: executionMode?.interactive !== false
        })
        lockAcquired = true
        logProcessing(`Lock acquired. Running deployment commands in ${remoteCwd}...`)

        executeRemote = createRemoteExecutor({
            ssh,
            rootDir,
            remoteCwd,
            writeToLogFile,
            logProcessing,
            logSuccess,
            logError
        })

        remotePlan = await buildRemoteDeploymentPlan({
            config,
            snapshot,
            rootDir,
            requiredPhpVersion,
            executionMode,
            persistPresetOptions: presetState?.saveOptions,
            remoteIsLaravel: remoteState?.remoteIsLaravel,
            maintenanceModeEnabled: remoteState?.maintenanceModeEnabled,
            ssh,
            remoteCwd,
            executeRemote,
            runPrompt,
            logProcessing,
            logSuccess,
            logWarning
        })

        await executeRemoteDeploymentPlan({
            rootDir,
            executeRemote,
            steps: remotePlan.steps,
            usefulSteps: remotePlan.usefulSteps,
            pendingSnapshot: remotePlan.pendingSnapshot,
            logProcessing,
            executionState
        })

        logSuccess('\nDeployment commands completed successfully.')

        const logPath = await getLogFilePath(rootDir)
        logSuccess(`\nAll task output has been logged to: ${logPath}`)
    } catch (error) {
        const logPath = await getLogFilePath(rootDir).catch(() => null)
        if (logPath) {
            logError(`\nTask output has been logged to: ${logPath}`)
        }

        await maybeRecoverLaravelMaintenanceMode({
            remotePlan,
            executionState,
            executeRemote,
            runPrompt,
            logProcessing,
            logWarning,
            executionMode
        })

        if (lockAcquired && ssh && remoteCwd) {
            try {
                await compareLocksAndPrompt(rootDir, ssh, remoteCwd, {
                    runPrompt,
                    logProcessing,
                    logWarning,
                    interactive: executionMode?.interactive !== false
                })
            } catch {
                // Ignore lock comparison errors during error handling
            }
        }

        throw new Error(`Deployment failed: ${error.message}`)
    } finally {
        abnormalExitGuard.unregister()
        await cleanupDeploymentResources({
            rootDir,
            ssh,
            remoteCwd,
            lockAcquired,
            logWarning
        })
    }
}
