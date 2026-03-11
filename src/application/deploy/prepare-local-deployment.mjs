import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import * as localRepo from '../../deploy/local-repo.mjs'
import * as preflight from '../../deploy/preflight.mjs'
import {commandExists} from '../../utils/command.mjs'
import {getPhpVersionRequirement} from '../../utils/php-version.mjs'

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

export async function prepareLocalDeployment(config, {
    snapshot = null,
    rootDir = process.cwd(),
    versionArg = null,
    runPrompt,
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess,
    logWarning
} = {}) {
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

    if (hasHook) {
        logProcessing?.('Pre-push git hook detected. Skipping local linting and test execution.')
        return {requiredPhpVersion, isLaravel, hasHook}
    }

    const lintRan = await runLinting(rootDir, {runCommand, logProcessing, logSuccess, logWarning})

    if (lintRan) {
        const hasChanges = await hasUncommittedChanges(rootDir, {runCommandCapture})
        if (hasChanges) {
            await commitLintingChanges(rootDir, {runCommand, runCommandCapture, logProcessing, logSuccess})
        }
    }

    if (isLaravel) {
        await runLocalLaravelTests(rootDir, {runCommand, logProcessing, logSuccess, logWarning})
    }

    return {requiredPhpVersion, isLaravel, hasHook}
}
