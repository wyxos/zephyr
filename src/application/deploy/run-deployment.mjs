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
import {buildRemoteDeploymentPlan} from './build-remote-deployment-plan.mjs'
import {executeRemoteDeploymentPlan} from './execute-remote-deployment-plan.mjs'
import {prepareLocalDeployment} from './prepare-local-deployment.mjs'

async function resolveRemoteHome(ssh, sshUser) {
    const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
    return remoteHomeResult.stdout.trim() || `/home/${sshUser}`
}

export async function runDeployment(config, options = {}) {
    const {
        snapshot = null,
        rootDir = process.cwd(),
        versionArg = null,
        context
    } = options

    const {
        logProcessing,
        logSuccess,
        logWarning,
        logError,
        runPrompt,
        createSshClient,
        runCommand
    } = context

    await cleanupOldLogs(rootDir)

    const {requiredPhpVersion} = await prepareLocalDeployment(config, {
        snapshot,
        rootDir,
        versionArg,
        runPrompt,
        runCommand,
        runCommandCapture: context.runCommandCapture,
        logProcessing,
        logSuccess,
        logWarning
    })

    const ssh = createSshClient()
    const sshUser = config.sshUser || os.userInfo().username
    const privateKeyPath = await resolveSshKeyPath(config.sshKey)
    const privateKey = await fs.readFile(privateKeyPath, 'utf8')
    let remoteCwd = null

    logProcessing(`\nConnecting to ${config.serverIp} as ${sshUser}...`)

    let lockAcquired = false

    try {
        await ssh.connect({
            host: config.serverIp,
            username: sshUser,
            privateKey
        })

        const remoteHome = await resolveRemoteHome(ssh, sshUser)
        remoteCwd = resolveRemotePath(config.projectPath, remoteHome)

        logProcessing('Connection established. Acquiring deployment lock on server...')
        await acquireRemoteLock(ssh, remoteCwd, rootDir, {runPrompt, logWarning})
        lockAcquired = true
        logProcessing(`Lock acquired. Running deployment commands in ${remoteCwd}...`)

        const executeRemote = createRemoteExecutor({
            ssh,
            rootDir,
            remoteCwd,
            writeToLogFile,
            logProcessing,
            logSuccess,
            logError
        })

        const remotePlan = await buildRemoteDeploymentPlan({
            config,
            snapshot,
            rootDir,
            requiredPhpVersion,
            ssh,
            remoteCwd,
            executeRemote,
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
            logProcessing
        })

        logSuccess('\nDeployment commands completed successfully.')

        const logPath = await getLogFilePath(rootDir)
        logSuccess(`\nAll task output has been logged to: ${logPath}`)
    } catch (error) {
        const logPath = await getLogFilePath(rootDir).catch(() => null)
        if (logPath) {
            logError(`\nTask output has been logged to: ${logPath}`)
        }

        if (lockAcquired && ssh && remoteCwd) {
            try {
                await compareLocksAndPrompt(rootDir, ssh, remoteCwd, {runPrompt, logWarning})
            } catch {
                // Ignore lock comparison errors during error handling
            }
        }

        throw new Error(`Deployment failed: ${error.message}`)
    } finally {
        if (lockAcquired && ssh && remoteCwd) {
            try {
                await releaseRemoteLock(ssh, remoteCwd, {logWarning})
                await releaseLocalLock(rootDir, {logWarning})
            } catch (error) {
                logWarning(`Failed to release lock: ${error.message}`)
            }
        }

        await closeLogFile()
        if (ssh) {
            ssh.dispose()
        }
    }
}
