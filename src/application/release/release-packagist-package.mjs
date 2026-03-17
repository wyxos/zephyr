import {join} from 'node:path'
import {readFile, writeFile} from 'node:fs/promises'
import fs from 'node:fs'
import process from 'node:process'
import semver from 'semver'

import {writeStderr} from '../../utils/output.mjs'
import {
    ensureCleanWorkingTree,
    ensureReleaseBranchReady,
    runReleaseCommand,
    validateReleaseDependencies
} from '../../release/shared.mjs'

async function readComposer(rootDir = process.cwd()) {
    const composerPath = join(rootDir, 'composer.json')
    const raw = await readFile(composerPath, 'utf8')
    return JSON.parse(raw)
}

async function writeComposer(rootDir, composer, composerPath = null) {
    const pathToUse = composerPath || join(rootDir, 'composer.json')
    const content = JSON.stringify(composer, null, 2) + '\n'
    await writeFile(pathToUse, content, 'utf8')
}

function hasComposerScript(composer, scriptName) {
    return composer?.scripts?.[scriptName] !== undefined
}

async function hasLaravelPint(rootDir = process.cwd()) {
    const pintPath = join(rootDir, 'vendor', 'bin', 'pint')
    try {
        await fs.promises.access(pintPath)
        const stats = await fs.promises.stat(pintPath)
        return stats.isFile()
    } catch {
        return false
    }
}

async function hasArtisan(rootDir = process.cwd()) {
    const artisanPath = join(rootDir, 'artisan')
    try {
        await fs.promises.access(artisanPath)
        const stats = await fs.promises.stat(artisanPath)
        return stats.isFile()
    } catch {
        return false
    }
}

async function runLint(skipLint, rootDir = process.cwd(), {
    logStep,
    logSuccess,
    logWarning,
    runCommand = runReleaseCommand,
    progressWriter = process.stdout
} = {}) {
    if (skipLint) {
        logWarning?.('Skipping lint because --skip-lint flag was provided.')
        return
    }

    const hasPint = await hasLaravelPint(rootDir)
    if (!hasPint) {
        logStep?.('Skipping lint (Laravel Pint not found).')
        return
    }

    logStep?.('Running Laravel Pint...')
    const pintPath = process.platform === 'win32' ? 'vendor\\bin\\pint' : 'vendor/bin/pint'

    let dotInterval = null
    try {
        progressWriter.write('  ')
        dotInterval = setInterval(() => {
            progressWriter.write('.')
        }, 200)

        await runCommand('php', [pintPath], {capture: true, cwd: rootDir})

        if (dotInterval) {
            clearInterval(dotInterval)
            dotInterval = null
        }
        progressWriter.write('\n')
        logSuccess?.('Lint passed.')
    } catch (error) {
        if (dotInterval) {
            clearInterval(dotInterval)
            dotInterval = null
        }
        progressWriter.write('\n')
        if (error.stdout) {
            writeStderr(error.stdout)
        }
        if (error.stderr) {
            writeStderr(error.stderr)
        }
        throw error
    }
}

async function runTests(skipTests, composer, rootDir = process.cwd(), {
    logStep,
    logSuccess,
    logWarning,
    runCommand = runReleaseCommand,
    progressWriter = process.stdout
} = {}) {
    if (skipTests) {
        logWarning?.('Skipping tests because --skip-tests flag was provided.')
        return
    }

    const hasArtisanFile = await hasArtisan(rootDir)
    const hasTestScript = hasComposerScript(composer, 'test')

    if (!hasArtisanFile && !hasTestScript) {
        logStep?.('Skipping tests (no artisan file or test script found).')
        return
    }

    logStep?.('Running test suite...')

    let dotInterval = null
    try {
        progressWriter.write('  ')
        dotInterval = setInterval(() => {
            progressWriter.write('.')
        }, 200)

        if (hasArtisanFile) {
            await runCommand('php', ['artisan', 'test', '--compact'], {capture: true, cwd: rootDir})
        } else if (hasTestScript) {
            await runCommand('composer', ['test'], {capture: true, cwd: rootDir})
        }

        if (dotInterval) {
            clearInterval(dotInterval)
            dotInterval = null
        }
        progressWriter.write('\n')
        logSuccess?.('Tests passed.')
    } catch (error) {
        if (dotInterval) {
            clearInterval(dotInterval)
            dotInterval = null
        }
        progressWriter.write('\n')
        if (error.stdout) {
            writeStderr(error.stdout)
        }
        if (error.stderr) {
            writeStderr(error.stderr)
        }
        throw error
    }
}

async function bumpVersion(releaseType, rootDir = process.cwd(), {
    logStep,
    logSuccess,
    runCommand = runReleaseCommand
} = {}) {
    logStep?.('Bumping composer version...')

    const composer = await readComposer(rootDir)
    const currentVersion = composer.version || '0.0.0'

    if (!semver.valid(currentVersion)) {
        throw new Error(`Invalid current version "${currentVersion}" in composer.json. Must be a valid semver.`)
    }

    const newVersion = semver.inc(currentVersion, releaseType)
    if (!newVersion) {
        throw new Error(`Failed to calculate next ${releaseType} version from ${currentVersion}`)
    }

    composer.version = newVersion
    await writeComposer(rootDir, composer)

    logStep?.('Staging composer.json...')
    await runCommand('git', ['add', 'composer.json'], {cwd: rootDir})

    const commitMessage = `chore: release ${newVersion}`
    logStep?.('Committing version bump...')
    await runCommand('git', ['commit', '-m', commitMessage], {cwd: rootDir})

    logStep?.('Creating git tag...')
    await runCommand('git', ['tag', `v${newVersion}`], {cwd: rootDir})

    logSuccess?.(`Version updated to ${newVersion}.`)
    return {...composer, version: newVersion}
}

async function pushChanges(rootDir = process.cwd(), {
    logStep,
    logSuccess,
    runCommand = runReleaseCommand
} = {}) {
    logStep?.('Pushing commits to origin...')
    await runCommand('git', ['push'], {cwd: rootDir})

    logStep?.('Pushing tags to origin...')
    await runCommand('git', ['push', 'origin', '--tags'], {cwd: rootDir})

    logSuccess?.('Git push completed.')
}

export async function releasePackagistPackage({
                                                  releaseType,
                                                  skipTests = false,
                                                  skipLint = false,
                                                  rootDir = process.cwd(),
                                                  logStep,
                                                  logSuccess,
                                                  logWarning,
                                                  runPrompt,
                                                  runCommandImpl,
                                                  runCommandCaptureImpl,
                                                  interactive = true,
                                                  progressWriter = process.stdout
                                              } = {}) {
    const runCommand = (command, args, options = {}) => runReleaseCommand(command, args, {
        ...options,
        runCommandImpl,
        runCommandCaptureImpl
    })

    logStep?.('Reading composer metadata...')
    const composer = await readComposer(rootDir)

    if (!composer.version) {
        throw new Error('composer.json does not have a version field. Add "version": "0.0.0" to composer.json.')
    }

    logStep?.('Validating dependencies...')
    await validateReleaseDependencies(rootDir, {
        prompt: runPrompt,
        logSuccess,
        interactive
    })

    logStep?.('Checking working tree status...')
    await ensureCleanWorkingTree(rootDir, {runCommand})
    await ensureReleaseBranchReady({rootDir, branchMethod: 'show-current', logStep, logWarning})

    await runLint(skipLint, rootDir, {logStep, logSuccess, logWarning, runCommand, progressWriter})
    await runTests(skipTests, composer, rootDir, {logStep, logSuccess, logWarning, runCommand, progressWriter})

    const updatedComposer = await bumpVersion(releaseType, rootDir, {logStep, logSuccess, runCommand})
    await pushChanges(rootDir, {logStep, logSuccess, runCommand})

    logSuccess?.(`Release workflow completed for ${composer.name}@${updatedComposer.version}.`)
    logStep?.('Note: Packagist will automatically detect the new git tag and update the package.')
}
