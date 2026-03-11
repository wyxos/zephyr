import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'

import * as localRepo from '../../deploy/local-repo.mjs'
import * as preflight from '../../deploy/preflight.mjs'
import {
    acquireRemoteLock,
    compareLocksAndPrompt,
    releaseLocalLock,
    releaseRemoteLock
} from '../../deploy/locks.mjs'
import {
    clearPendingTasksSnapshot,
    savePendingTasksSnapshot
} from '../../deploy/snapshots.mjs'
import {createRemoteExecutor} from '../../deploy/remote-exec.mjs'
import {resolveSshKeyPath} from '../../ssh/keys.mjs'
import {commandExists} from '../../utils/command.mjs'
import {cleanupOldLogs, closeLogFile, getLogFilePath, writeToLogFile} from '../../utils/log-file.mjs'
import {PENDING_TASKS_FILE} from '../../utils/paths.mjs'
import {getPhpVersionRequirement, findPhpBinary} from '../../utils/php-version.mjs'
import {resolveRemotePath} from '../../utils/remote-path.mjs'
import {planLaravelDeploymentTasks} from '../../utils/task-planner.mjs'

async function getGitStatus(rootDir, {runCommandCapture} = {}) {
    return await localRepo.getGitStatus(rootDir, {runCommandCapture})
}

async function hasUncommittedChanges(rootDir, {runCommandCapture} = {}) {
    return await localRepo.hasUncommittedChanges(rootDir, {
        getGitStatus: (dir) => getGitStatus(dir, {runCommandCapture})
    })
}

async function ensureLocalRepositoryState(targetBranch, rootDir, {
    runPrompt,
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess,
    logWarning
} = {}) {
    return await localRepo.ensureLocalRepositoryState(targetBranch, rootDir, {
        runPrompt,
        runCommand,
        runCommandCapture,
        logProcessing,
        logSuccess,
        logWarning
    })
}

async function readPackageJson(rootDir) {
    const packageJsonPath = path.join(rootDir, 'package.json')
    const raw = await fs.readFile(packageJsonPath, 'utf8')
    return JSON.parse(raw)
}

async function isGitIgnored(rootDir, filePath, {runCommand} = {}) {
    try {
        await runCommand('git', ['check-ignore', '-q', filePath], {cwd: rootDir})
        return true
    } catch {
        return false
    }
}

async function bumpLaravelPackageVersion(rootDir, {
    isLaravel,
    versionArg,
    runCommand,
    logProcessing,
    logSuccess,
    logWarning
} = {}) {
    if (!isLaravel) {
        return null
    }

    if (!commandExists('npm')) {
        logWarning?.('npm is not available in PATH. Skipping npm version bump.')
        return null
    }

    let pkg
    try {
        pkg = await readPackageJson(rootDir)
    } catch {
        return null
    }

    if (!pkg?.version) {
        return null
    }

    const releaseValue = (versionArg && String(versionArg).trim().length > 0)
        ? String(versionArg).trim()
        : 'patch'

    logProcessing?.(`Bumping npm package version (${releaseValue})...`)
    await runCommand('npm', ['version', releaseValue, '--no-git-tag-version', '--force'], {cwd: rootDir})

    const updatedPkg = await readPackageJson(rootDir)
    const nextVersion = updatedPkg?.version ?? pkg.version
    const didVersionChange = nextVersion !== pkg.version

    const filesToStage = ['package.json']
    const packageLockPath = path.join(rootDir, 'package-lock.json')
    try {
        await fs.access(packageLockPath)
        const ignored = await isGitIgnored(rootDir, 'package-lock.json', {runCommand})
        if (!ignored) {
            filesToStage.push('package-lock.json')
        }
    } catch {
        // package-lock.json does not exist
    }

    await runCommand('git', ['add', ...filesToStage], {cwd: rootDir})

    if (!didVersionChange) {
        logWarning?.('Version did not change after npm version. Skipping version commit.')
        return updatedPkg
    }

    await runCommand('git', ['commit', '-m', `chore: bump version to ${nextVersion}`, '--', ...filesToStage], {
        cwd: rootDir
    })
    logSuccess?.(`Version updated to ${nextVersion}.`)

    return updatedPkg
}

async function runLinting(rootDir, {runCommand, logProcessing, logSuccess, logWarning} = {}) {
    return await preflight.runLinting(rootDir, {runCommand, logProcessing, logSuccess, logWarning, commandExists})
}

async function commitLintingChanges(rootDir, {
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess
} = {}) {
    return await preflight.commitLintingChanges(rootDir, {
        getGitStatus: (dir) => getGitStatus(dir, {runCommandCapture}),
        runCommand,
        logProcessing,
        logSuccess
    })
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
        runCommand,
        runCommandCapture
    } = context

    await cleanupOldLogs(rootDir)

    let requiredPhpVersion = null
    try {
        requiredPhpVersion = await getPhpVersionRequirement(rootDir)
    } catch {
        // composer.json might not exist or be unreadable
    }

    const isLaravel = await preflight.isLocalLaravelProject(rootDir)
    const hasHook = await preflight.hasPrePushHook(rootDir)

    if (!snapshot) {
        await bumpLaravelPackageVersion(rootDir, {
            isLaravel,
            versionArg,
            runCommand,
            logProcessing,
            logSuccess,
            logWarning
        })
    }

    await ensureLocalRepositoryState(config.branch, rootDir, {
        runPrompt,
        runCommand,
        runCommandCapture,
        logProcessing,
        logSuccess,
        logWarning
    })

    if (!hasHook) {
        const lintRan = await runLinting(rootDir, {runCommand, logProcessing, logSuccess, logWarning})

        if (lintRan) {
            const hasChanges = await hasUncommittedChanges(rootDir, {runCommandCapture})
            if (hasChanges) {
                await commitLintingChanges(rootDir, {runCommand, runCommandCapture, logProcessing, logSuccess})
            }
        }

        if (isLaravel) {
            if (!commandExists('php')) {
                logWarning(
                    'PHP is not available in PATH. Skipping local Laravel tests.\n' +
                    '  To run tests locally, ensure PHP is installed and added to your PATH.\n' +
                    '  On Windows with Laravel Herd, you may need to add Herd\'s PHP to your system PATH.'
                )
            } else {
                logProcessing('Running Laravel tests locally...')
                try {
                    await runCommand('php', ['artisan', 'test', '--compact'], {cwd: rootDir})
                    logSuccess('Local tests passed.')
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        throw new Error(
                            'Failed to run Laravel tests: PHP executable not found.\n' +
                            'Make sure PHP is installed and available in your PATH.'
                        )
                    }

                    throw new Error(`Local tests failed. Fix test failures before deploying.\n${error.message}`)
                }
            }
        }
    } else {
        logProcessing('Pre-push git hook detected. Skipping local linting and test execution.')
    }

    const ssh = createSshClient()
    const sshUser = config.sshUser || os.userInfo().username
    const privateKeyPath = await resolveSshKeyPath(config.sshKey)
    const privateKey = await fs.readFile(privateKeyPath, 'utf8')

    logProcessing(`\nConnecting to ${config.serverIp} as ${sshUser}...`)

    let lockAcquired = false

    try {
        await ssh.connect({
            host: config.serverIp,
            username: sshUser,
            privateKey
        })

        const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
        const remoteHome = remoteHomeResult.stdout.trim() || `/home/${sshUser}`
        const remoteCwd = resolveRemotePath(config.projectPath, remoteHome)

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

        const laravelCheck = await ssh.execCommand(
            'if [ -f artisan ] && [ -f composer.json ] && grep -q "laravel/framework" composer.json; then echo "yes"; else echo "no"; fi',
            {cwd: remoteCwd}
        )
        const remoteIsLaravel = laravelCheck.stdout.trim() === 'yes'

        if (remoteIsLaravel) {
            logSuccess('Laravel project detected.')
        } else {
            logWarning('Laravel project not detected; skipping Laravel-specific maintenance tasks.')
        }

        let changedFiles = []

        if (snapshot?.changedFiles) {
            changedFiles = snapshot.changedFiles
            logProcessing('Resuming deployment with saved task snapshot.')
        } else if (remoteIsLaravel) {
            await executeRemote(`Fetch latest changes for ${config.branch}`, `git fetch origin ${config.branch}`)

            const diffResult = await executeRemote(
                'Inspect pending changes',
                `git diff --name-only HEAD..origin/${config.branch}`,
                {printStdout: false}
            )

            changedFiles = diffResult.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)

            if (changedFiles.length > 0) {
                const preview = changedFiles
                    .slice(0, 20)
                    .map((file) => ` - ${file}`)
                    .join('\n')

                logProcessing(
                    `Detected ${changedFiles.length} changed file(s):\n${preview}${changedFiles.length > 20 ? '\n - ...' : ''}`
                )
            } else {
                logProcessing('No upstream file changes detected.')
            }
        }

        const hasPhpChanges = remoteIsLaravel && changedFiles.some((file) => file.endsWith('.php'))

        let horizonConfigured = false
        if (hasPhpChanges) {
            const horizonCheck = await ssh.execCommand(
                'if [ -f config/horizon.php ]; then echo "yes"; else echo "no"; fi',
                {cwd: remoteCwd}
            )
            horizonConfigured = horizonCheck.stdout.trim() === 'yes'
        }

        let phpCommand = 'php'
        if (requiredPhpVersion) {
            try {
                phpCommand = await findPhpBinary(ssh, remoteCwd, requiredPhpVersion)
                if (phpCommand !== 'php') {
                    logProcessing(`Detected PHP requirement: ${requiredPhpVersion}, using ${phpCommand}`)
                }
            } catch (error) {
                logWarning(`Could not find PHP binary for version ${requiredPhpVersion}: ${error.message}`)
            }
        }

        const steps = planLaravelDeploymentTasks({
            branch: config.branch,
            isLaravel: remoteIsLaravel,
            changedFiles,
            horizonConfigured,
            phpCommand
        })

        const usefulSteps = steps.length > 1

        if (usefulSteps) {
            const pendingSnapshot = snapshot ?? {
                serverName: config.serverName,
                branch: config.branch,
                projectPath: config.projectPath,
                sshUser: config.sshUser,
                createdAt: new Date().toISOString(),
                changedFiles,
                taskLabels: steps.map((step) => step.label)
            }

            await savePendingTasksSnapshot(rootDir, pendingSnapshot)

            const payload = Buffer.from(JSON.stringify(pendingSnapshot)).toString('base64')
            await executeRemote(
                'Record pending deployment tasks',
                `mkdir -p .zephyr && echo '${payload}' | base64 --decode > .zephyr/${PENDING_TASKS_FILE}`,
                {printStdout: false}
            )
        }

        if (steps.length === 1) {
            logProcessing('No additional maintenance tasks scheduled beyond git pull.')
        } else {
            const extraTasks = steps
                .slice(1)
                .map((step) => step.label)
                .join(', ')

            logProcessing(`Additional tasks scheduled: ${extraTasks}`)
        }

        let completed = false

        try {
            for (const step of steps) {
                await executeRemote(step.label, step.command)
            }

            completed = true
        } finally {
            if (usefulSteps && completed) {
                await executeRemote(
                    'Clear pending deployment snapshot',
                    `rm -f .zephyr/${PENDING_TASKS_FILE}`,
                    {printStdout: false, allowFailure: true}
                )
                await clearPendingTasksSnapshot(rootDir)
            }
        }

        logSuccess('\nDeployment commands completed successfully.')

        const logPath = await getLogFilePath(rootDir)
        logSuccess(`\nAll task output has been logged to: ${logPath}`)
    } catch (error) {
        const logPath = await getLogFilePath(rootDir).catch(() => null)
        if (logPath) {
            logError(`\nTask output has been logged to: ${logPath}`)
        }

        if (lockAcquired && ssh) {
            try {
                const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
                const remoteHome = remoteHomeResult.stdout.trim() || `/home/${sshUser}`
                const remoteCwd = resolveRemotePath(config.projectPath, remoteHome)
                await compareLocksAndPrompt(rootDir, ssh, remoteCwd, {runPrompt, logWarning})
            } catch {
                // Ignore lock comparison errors during error handling
            }
        }

        throw new Error(`Deployment failed: ${error.message}`)
    } finally {
        if (lockAcquired && ssh) {
            try {
                const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
                const remoteHome = remoteHomeResult.stdout.trim() || `/home/${sshUser}`
                const remoteCwd = resolveRemotePath(config.projectPath, remoteHome)
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
