import {findPhpBinary} from '../../infrastructure/php/version.mjs'
import {planLaravelDeploymentTasks} from './plan-laravel-deployment-tasks.mjs'

async function detectRemoteLaravelProject(ssh, remoteCwd) {
    const laravelCheck = await ssh.execCommand(
        'if [ -f artisan ] && [ -f composer.json ] && grep -q "laravel/framework" composer.json; then echo "yes"; else echo "no"; fi',
        {cwd: remoteCwd}
    )

    return laravelCheck.stdout.trim() === 'yes'
}

async function collectChangedFiles({
                                       config,
                                       snapshot,
                                       remoteIsLaravel,
                                       executeRemote,
                                       logProcessing
                                   } = {}) {
    if (snapshot?.changedFiles) {
        logProcessing?.('Resuming deployment with saved task snapshot.')
        return snapshot.changedFiles
    }

    if (!remoteIsLaravel) {
        return []
    }

    await executeRemote(`Fetch latest changes for ${config.branch}`, `git fetch origin ${config.branch}`)

    const diffResult = await executeRemote(
        'Inspect pending changes',
        `git diff --name-only HEAD..origin/${config.branch}`,
        {printStdout: false}
    )

    const changedFiles = diffResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    if (changedFiles.length > 0) {
        const preview = changedFiles
            .slice(0, 20)
            .map((file) => ` - ${file}`)
            .join('\n')

        logProcessing?.(
            `Detected ${changedFiles.length} changed file(s):\n${preview}${changedFiles.length > 20 ? '\n - ...' : ''}`
        )
    } else {
        logProcessing?.('No upstream file changes detected.')
    }

    return changedFiles
}

async function detectHorizonConfiguration({
                                              ssh,
                                              remoteCwd,
                                              remoteIsLaravel,
                                              changedFiles
                                          } = {}) {
    const hasPhpChanges = remoteIsLaravel && changedFiles.some((file) => file.endsWith('.php'))

    if (!hasPhpChanges) {
        return false
    }

    const horizonCheck = await ssh.execCommand(
        'if [ -f config/horizon.php ]; then echo "yes"; else echo "no"; fi',
        {cwd: remoteCwd}
    )

    return horizonCheck.stdout.trim() === 'yes'
}

async function resolvePhpCommand({
                                     requiredPhpVersion,
                                     ssh,
                                     remoteCwd,
                                     logProcessing,
                                     logWarning
                                 } = {}) {
    if (!requiredPhpVersion) {
        return 'php'
    }

    try {
        const phpCommand = await findPhpBinary(ssh, remoteCwd, requiredPhpVersion)
        if (phpCommand !== 'php') {
            logProcessing?.(`Detected PHP requirement: ${requiredPhpVersion}, using ${phpCommand}`)
        }

        return phpCommand
    } catch (error) {
        logWarning?.(`Could not find PHP binary for version ${requiredPhpVersion}: ${error.message}`)
        return 'php'
    }
}

export async function buildRemoteDeploymentPlan({
                                                    config,
                                                    snapshot = null,
                                                    requiredPhpVersion = null,
                                                    ssh,
                                                    remoteCwd,
                                                    executeRemote,
                                                    logProcessing,
                                                    logSuccess,
                                                    logWarning
                                                } = {}) {
    const remoteIsLaravel = await detectRemoteLaravelProject(ssh, remoteCwd)

    if (remoteIsLaravel) {
        logSuccess?.('Laravel project detected.')
    } else {
        logWarning?.('Laravel project not detected; skipping Laravel-specific maintenance tasks.')
    }

    const changedFiles = await collectChangedFiles({
        config,
        snapshot,
        remoteIsLaravel,
        executeRemote,
        logProcessing
    })

    const horizonConfigured = await detectHorizonConfiguration({
        ssh,
        remoteCwd,
        remoteIsLaravel,
        changedFiles
    })

    const phpCommand = await resolvePhpCommand({
        requiredPhpVersion,
        ssh,
        remoteCwd,
        logProcessing,
        logWarning
    })

    const steps = planLaravelDeploymentTasks({
        branch: config.branch,
        isLaravel: remoteIsLaravel,
        changedFiles,
        horizonConfigured,
        phpCommand
    })

    const usefulSteps = steps.length > 1
    const pendingSnapshot = !usefulSteps
        ? null
        : snapshot ?? {
        serverName: config.serverName,
        branch: config.branch,
        projectPath: config.projectPath,
        sshUser: config.sshUser,
        createdAt: new Date().toISOString(),
        changedFiles,
        taskLabels: steps.map((step) => step.label)
    }

    return {
        remoteIsLaravel,
        changedFiles,
        horizonConfigured,
        phpCommand,
        steps,
        usefulSteps,
        pendingSnapshot
    }
}
