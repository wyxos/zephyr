import * as localRepo from '../../deploy/local-repo.mjs'
import * as preflight from '../../deploy/preflight.mjs'
import {commandExists, formatCommandError} from '../../utils/command.mjs'

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
    skipTests = false,
    skipLint = false,
    runCommandCapture
} = {}) {
    let lintCommand = null

    if (!skipLint) {
        try {
            lintCommand = await preflight.resolveSupportedLintCommand(rootDir, {commandExists})
        } catch (error) {
            if (error?.code !== 'ZEPHYR_LINT_COMMAND_NOT_FOUND') {
                throw error
            }
        }
    }

    const buildCommand = isLaravel && !skipTests
        ? await preflight.resolveSupportedBuildCommand(rootDir, {commandExists})
        : null

    const testCommand = isLaravel && !skipTests
        ? await resolveSupportedLaravelTestCommand(rootDir, {runCommandCapture})
        : null

    return {
        lintCommand,
        buildCommand,
        testCommand
    }
}

async function runLocalLaravelBuild(rootDir, {runCommand, logProcessing, logSuccess, buildCommand} = {}) {
    try {
        await preflight.runBuild(rootDir, {
            runCommand,
            logProcessing,
            logSuccess,
            commandExists,
            buildCommand
        })
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(
                'Failed to run local frontend build: npm executable not found.\n' +
                'Make sure npm is installed and available in your PATH.'
            )
        }

        throw new Error(`Local frontend build failed. Fix build failures before deploying.\n${formatCommandError(error)}`)
    }
}

async function runLocalLaravelTests(rootDir, {runCommand, logProcessing, logSuccess, testCommand} = {}) {
    logProcessing?.('Running Laravel tests locally...')

    try {
        await runCommand(testCommand.command, testCommand.args, {cwd: rootDir, capture: true})
        logSuccess?.('Local tests passed.')
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(
                'Failed to run Laravel tests: PHP executable not found.\n' +
                'Make sure PHP is installed and available in your PATH.'
            )
        }

        throw new Error(`Local tests failed. Fix test failures before deploying.\n${formatCommandError(error)}`)
    }
}

export async function runLocalDeploymentChecks({
    rootDir,
    isLaravel,
    hasHook,
    skipGitHooks = false,
    skipTests = false,
    skipLint = false,
    forceRunWhenHookPresent = false,
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess,
    logWarning,
    lintCommand = undefined,
    buildCommand = undefined,
    testCommand = undefined
} = {}) {
    const support = lintCommand !== undefined || buildCommand !== undefined || testCommand !== undefined
        ? {lintCommand, buildCommand, testCommand}
        : await resolveLocalDeploymentCheckSupport({
            rootDir,
            isLaravel,
            skipTests,
            skipLint,
            runCommandCapture
        })

    if (hasHook) {
        if (skipGitHooks) {
            logWarning?.(
                'Pre-push git hook detected. Zephyr will run its built-in release checks manually because --skip-git-hooks is enabled, and the hook will be bypassed during git push.'
            )
        } else if (forceRunWhenHookPresent) {
            logProcessing?.(
                'Pre-push git hook detected. Zephyr will run its built-in release checks now before bumping the deployment version. The hook will still run again during git push.'
            )
        } else {
            logProcessing?.(
                'Pre-push git hook detected. Built-in release checks are supported, but Zephyr will skip executing them here. If Zephyr pushes local commits during this release, the hook will run during git push.'
            )
            return
        }
    }

    if (hasHook && !skipGitHooks && (skipLint || skipTests)) {
        logWarning?.(
            'Pre-push git hook detected. --skip-lint/--skip-tests only skip Zephyr\'s built-in checks; your hook may still run its own checks during git push.'
        )
    }

    if (skipLint) {
        logWarning?.('Skipping lint because --skip-lint flag was provided.')
    } else if (support.lintCommand === null) {
        logWarning?.('No supported lint command was found. Skipping linting checks.')
    }

    const lintRan = skipLint || support.lintCommand === null
        ? false
        : await preflight.runLinting(rootDir, {
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
                logSuccess,
                skipGitHooks
            })
        }
    }

    if (isLaravel && skipTests) {
        logWarning?.('Skipping tests because --skip-tests flag was provided.')
    } else if (isLaravel) {
        if (support.buildCommand) {
            await runLocalLaravelBuild(rootDir, {
                runCommand,
                logProcessing,
                logSuccess,
                buildCommand: support.buildCommand
            })
        }

        await runLocalLaravelTests(rootDir, {
            runCommand,
            logProcessing,
            logSuccess,
            testCommand: support.testCommand
        })
    }
}
