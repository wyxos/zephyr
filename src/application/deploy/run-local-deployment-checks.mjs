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

function supportsArtisanTestCommand(listOutput = '') {
    return /(?:^|\n)\s*test(?:\s|$)/m.test(listOutput)
}

async function resolveSupportedLaravelTestCommand(rootDir, {runCommandCapture} = {}) {
    if (!commandExists('php')) {
        throw new Error(
            'Release cannot run because PHP is not available in PATH.\n' +
            'Zephyr requires `php artisan test --compact` for Laravel projects before deployment.'
        )
    }

    let artisanCommands
    try {
        artisanCommands = await runCommandCapture('php', ['artisan', 'list'], {cwd: rootDir})
    } catch (error) {
        throw new Error(
            'Release cannot run because Zephyr could not verify support for `php artisan test`.\n' +
            `Ensure the project can run \`php artisan list\` locally before deployment.\n${error.message}`
        )
    }

    if (!supportsArtisanTestCommand(artisanCommands)) {
        throw new Error(
            'Release cannot run because this Laravel project does not support `php artisan test`.\n' +
            'Zephyr requires Laravel\'s built-in test command before deployment. PHPUnit-only test setups are not supported.'
        )
    }

    return {
        command: 'php',
        args: ['artisan', 'test', '--compact']
    }
}

export async function resolveLocalDeploymentCheckSupport({
    rootDir,
    isLaravel,
    runCommandCapture
} = {}) {
    const lintCommand = await preflight.resolveSupportedLintCommand(rootDir, {commandExists})
    const testCommand = isLaravel
        ? await resolveSupportedLaravelTestCommand(rootDir, {runCommandCapture})
        : null

    return {
        lintCommand,
        testCommand
    }
}

async function runLocalLaravelTests(rootDir, {runCommand, logProcessing, logSuccess, testCommand} = {}) {
    logProcessing?.('Running Laravel tests locally...')

    try {
        await runCommand(testCommand.command, testCommand.args, {cwd: rootDir})
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
    logWarning,
    lintCommand = undefined,
    testCommand = undefined
} = {}) {
    const support = lintCommand !== undefined || testCommand !== undefined
        ? {lintCommand, testCommand}
        : await resolveLocalDeploymentCheckSupport({
            rootDir,
            isLaravel,
            runCommandCapture
        })

    if (hasHook) {
        logProcessing?.(
            'Pre-push git hook detected. Built-in release checks are supported, but Zephyr will skip executing them here. If Zephyr pushes local commits during this release, the hook will run during git push.'
        )
        return
    }

    const lintRan = await preflight.runLinting(rootDir, {
        runCommand,
        logProcessing,
        logSuccess,
        logWarning,
        commandExists,
        lintCommand: support.lintCommand
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
        await runLocalLaravelTests(rootDir, {
            runCommand,
            logProcessing,
            logSuccess,
            testCommand: support.testCommand
        })
    }
}
