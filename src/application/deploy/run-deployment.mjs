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
import {buildRemoteDeploymentPlan, resolveRemoteDeploymentState} from './build-remote-deployment-plan.mjs'
import {connectToRemoteDeploymentTarget} from './connect-to-remote-deployment-target.mjs'
import {
    createAbnormalExitGuard,
    maybeRecoverFrontendArtifact,
    maybeRecoverLaravelMaintenanceMode
} from './deployment-recovery.mjs'
import {executeRemoteDeploymentPlan} from './execute-remote-deployment-plan.mjs'
import {prepareLocalFrontendArtifact, uploadFrontendArtifact} from './frontend-artifact.mjs'
import {prepareLocalDeployment} from './prepare-local-deployment.mjs'
import {verifyLaravelSetup} from './verify-laravel-setup.mjs'

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

export {
    createAbnormalExitGuard,
    maybeRecoverFrontendArtifact,
    maybeRecoverLaravelMaintenanceMode
} from './deployment-recovery.mjs'

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

    const sshUser = config.sshUser || os.userInfo().username

    if (executionMode?.setup === true) {
        await verifyLaravelSetup({
            config,
            rootDir,
            createSshClient,
            sshUser,
            logProcessing,
            logSuccess
        })
        return
    }

    await cleanupOldLogs(rootDir)

    const privateKeyPath = await resolveSshKeyPath(config.sshKey)
    const privateKey = await fs.readFile(privateKeyPath, 'utf8')
    let ssh = null
    let remoteCwd = null
    let executeRemote = null
    let remotePlan = null
    let remoteState = null
    let frontendArtifact = null
    const executionState = {
        enteredMaintenanceMode: false,
        exitedMaintenanceMode: false,
        frontendArtifactActivated: false,
        frontendArtifactFinalized: false
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
                        privateKeyPath,
                        remoteCwd,
                        logProcessing,
                        message: `Reconnecting to ${config.sshAlias || config.serverIp} as ${sshUser} for abnormal-exit recovery...`
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

                await maybeRecoverFrontendArtifact({
                    remotePlan,
                    executionState,
                    executeRemote: recoveryExecutor,
                    logProcessing,
                    logWarning
                })

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
            privateKeyPath,
            logProcessing,
            message: `Connecting to ${config.sshAlias || config.serverIp} as ${sshUser} to inspect remote deployment state...`
        }))

        remoteState = await resolveRemoteDeploymentState({
            snapshot,
            executionMode,
            persistPresetOptions: presetState?.saveOptions,
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
            interactive: executionMode?.interactive !== false,
            runPrompt,
            runCommand,
            runCommandCapture: context.runCommandCapture,
            logProcessing,
            logSuccess,
            logWarning
        })

        const frontendBuildStrategy = snapshot?.frontendBuildStrategy ??
            executionMode?.frontendBuildStrategy ??
            'remote'

        if (remoteState?.remoteIsLaravel && frontendBuildStrategy === 'local-artifact') {
            frontendArtifact = await prepareLocalFrontendArtifact({
                rootDir,
                runCommand,
                runCommandCapture: context.runCommandCapture,
                logProcessing,
                logSuccess
            })
        }

        ;({ssh} = await connectToRemoteDeploymentTarget({
            config,
            createSshClient,
            sshUser,
            privateKey,
            privateKeyPath,
            remoteCwd,
            logProcessing,
            message: `Reconnecting to ${config.sshAlias || config.serverIp} as ${sshUser}...`
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
            logWarning,
            frontendArtifact
        })

        if (remotePlan.usesFrontendArtifact) {
            await uploadFrontendArtifact({
                artifact: frontendArtifact,
                ssh,
                remoteCwd,
                executeRemote,
                logProcessing,
                logSuccess
            })
        }

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

        await maybeRecoverFrontendArtifact({
            remotePlan,
            executionState,
            executeRemote,
            logProcessing,
            logWarning
        })

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

        if (frontendArtifact) {
            try {
                await frontendArtifact.cleanupLocal()
            } catch (error) {
                logWarning?.(`Failed to clean the local frontend artifact: ${error.message}`)
            }
        }

        await cleanupDeploymentResources({
            rootDir,
            ssh,
            remoteCwd,
            lockAcquired,
            logWarning
        })
    }
}
