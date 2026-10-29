import {savePendingTasksSnapshot} from '../../deploy/snapshots.mjs'
import {ZephyrError} from '../../runtime/errors.mjs'
import {normalizeDeploymentOptions} from '../../config/deployment-options.mjs'
import {normalizeDeploymentCiPolicy} from './github-ci-gate.mjs'
import {prepareDeploymentRelease} from './prepare-release.mjs'
import {verifyDeploymentRelease} from './verify-release.mjs'
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
    preserveLocks = false,
    logWarning
} = {}) {
    if (!preserveLocks && lockAcquired && ssh && remoteCwd) {
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

    normalizeDeploymentOptions(Object.prototype.hasOwnProperty.call(snapshot ?? {}, 'deployment') ? snapshot.deployment : executionMode?.deployment)
    normalizeDeploymentCiPolicy(Object.prototype.hasOwnProperty.call(snapshot ?? {}, 'ci') ? snapshot.ci : executionMode?.ci)
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
    let preserveLocks = false
    let release = {}
    const releaseController = new AbortController()
    const assertActiveRelease = () => {
        if (releaseController.signal.aborted) throw new ZephyrError('Release cancelled before the next deployment operation.', {code: 'ZEPHYR_RELEASE_CANCELLED'})
    }
    const trackExecutor = executor => async (...args) => {
        if (preserveLocks) throw new ZephyrError('Remote outcome remains unknown; inspect the server before sending more commands.', {code: 'REMOTE_OUTCOME_UNKNOWN'})
        executionState.commandInFlight = true
        try { return await executor(...args) }
        catch (error) {
            if (error.code === 'REMOTE_OUTCOME_UNKNOWN') preserveLocks = true
            throw error
        } finally { executionState.commandInFlight = false }
    }
    const abnormalExitGuard = createAbnormalExitGuard({
        logWarning,
        cleanup: async (signal) => {
            releaseController.abort()
            let recoverySsh = null
            let recoveryExecutor = executeRemote

            try {
                if (preserveLocks || executionState.commandInFlight) {
                    preserveLocks = true
                    logWarning?.('Remote command outcome is unknown after interruption. Pending state and locks are retained; inspect the server before resuming. No recovery commands were sent.')
                    return
                }
                if (!lockAcquired) return
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

                    recoveryExecutor = trackExecutor(createRemoteExecutor({
                        ssh: recoverySsh,
                        rootDir,
                        remoteCwd,
                        writeToLogFile,
                        logProcessing,
                        logSuccess,
                        logError
                    }))
                }

                await maybeRecoverFrontendArtifact({
                    remotePlan,
                    executionState,
                    executeRemote: recoveryExecutor,
                    logProcessing,
                    logWarning
                })

                if (!preserveLocks && remotePlan) await maybeRecoverLaravelMaintenanceMode({
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
                    preserveLocks,
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

        release = await prepareDeploymentRelease({config, snapshot, executionMode, rootDir, context, signal: releaseController.signal})
        assertActiveRelease()

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

        assertActiveRelease()
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

        assertActiveRelease()
        logProcessing('Connection established. Acquiring deployment lock on server...')
        await acquireRemoteLock(ssh, remoteCwd, rootDir, {
            runPrompt,
            logProcessing,
            logWarning,
            interactive: executionMode?.interactive !== false
        })
        lockAcquired = true
        assertActiveRelease()
        logProcessing(`Lock acquired. Running deployment commands in ${remoteCwd}...`)

        const remoteExecutor = createRemoteExecutor({
            ssh,
            rootDir,
            remoteCwd,
            writeToLogFile,
            logProcessing,
            logSuccess,
            logError,
            logOutput: context.emitEvent ? ({label, stream, chunk}) => context.emitEvent('remote_output', {message: chunk, data: {stepLabel: label, stream}}) : undefined
        })

        executeRemote = trackExecutor(remoteExecutor)

        if (release.expectedCommit && !snapshot) await savePendingTasksSnapshot(rootDir, {
            serverName: config.serverName, branch: config.branch, projectPath: config.projectPath,
            sshUser: config.sshUser, createdAt: new Date().toISOString(), ...release,
            maintenanceModeEnabled: remoteState.maintenanceModeEnabled,
            taskLabels: ['Prepare verified deployment plan']
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
            frontendArtifact,
            release
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
            executionState,
            afterExecution: () => verifyDeploymentRelease({release, executeRemote, remotePlan, logSuccess})
        })

        logSuccess('\nDeployment commands completed successfully.')

        const logPath = await getLogFilePath(rootDir)
        logSuccess(`\nAll task output has been logged to: ${logPath}`)
    } catch (error) {
        const logPath = await getLogFilePath(rootDir).catch(() => null)
        if (logPath) {
            logError(`\nTask output has been logged to: ${logPath}`)
        }

        preserveLocks = preserveLocks || error.code === 'REMOTE_OUTCOME_UNKNOWN'
        if (preserveLocks) logWarning?.('Remote command outcome is unknown. Pending state and locks are retained; inspect the server before resuming.')
        if (!preserveLocks && remotePlan) await maybeRecoverFrontendArtifact({
            remotePlan,
            executionState,
            executeRemote,
            logProcessing,
            logWarning
        })

        if (!preserveLocks && remotePlan) await maybeRecoverLaravelMaintenanceMode({
            remotePlan,
            executionState,
            executeRemote,
            runPrompt,
            logProcessing,
            logWarning,
            executionMode
        })

        if (!preserveLocks && lockAcquired && ssh && remoteCwd) {
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

        throw new ZephyrError(`Deployment failed: ${error.message}${preserveLocks ? ' Remote outcome is unknown; inspect pending state before resuming.' : ''}`, {code: preserveLocks ? 'REMOTE_OUTCOME_UNKNOWN' : error.code || 'ZEPHYR_FAILURE', data: error.data, cause: error})
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
            preserveLocks,
            logWarning
        })
    }
}
