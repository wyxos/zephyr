import * as localRepo from '../../deploy/local-repo.mjs'
import * as preflight from '../../deploy/preflight.mjs'
import {commandExists} from '../../utils/command.mjs'

async function getGitStatus(rootDir, {runCommandCapture} = {}) {
    return await localRepo.getGitStatus(rootDir, {runCommandCapture})
}

async function hasUncommittedChanges(rootDir, {runCommandCapture} = {}) {
    return await localRepo.hasUncommittedChanges(rootDir, {
        getGitStatus: (dir) => getGitStatus(dir, {runCommandCapture})
    })
}

async function runLocalLaravelTests(rootDir, {runCommand, logProcessing, logSuccess, logWarning} = {}) {
    if (!commandExists('php')) {
        logWarning?.(
            'PHP is not available in PATH. Skipping local Laravel tests.\n' +
            '  To run tests locally, ensure PHP is installed and added to your PATH.\n' +
            '  On Windows with Laravel Herd, you may need to add Herd\'s PHP to your system PATH.'
        )
        return
    }

    logProcessing?.('Running Laravel tests locally...')

    try {
        await runCommand('php', ['artisan', 'test', '--compact'], {cwd: rootDir})
        logSuccess?.('Local tests passed.')
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

export async function runLocalDeploymentChecks({
    rootDir,
    isLaravel,
    hasHook,
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess,
    logWarning
} = {}) {
    if (hasHook) {
        logProcessing?.('Pre-push git hook detected. Skipping local linting and test execution.')
        return
    }

    const lintRan = await preflight.runLinting(rootDir, {
        runCommand,
        logProcessing,
        logSuccess,
        logWarning,
        commandExists
    })

    if (lintRan) {
        const hasChanges = await hasUncommittedChanges(rootDir, {runCommandCapture})
        if (hasChanges) {
            await preflight.commitLintingChanges(rootDir, {
                getGitStatus: (dir) => getGitStatus(dir, {runCommandCapture}),
                runCommand,
                logProcessing,
                logSuccess
            })
        }
    }

    if (isLaravel) {
        await runLocalLaravelTests(rootDir, {runCommand, logProcessing, logSuccess, logWarning})
    }
}
