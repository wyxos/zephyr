import fs from 'node:fs/promises'
import path from 'node:path'

import {commandExists} from '../../utils/command.mjs'
import {gitCommitArgs} from '../../utils/git-hooks.mjs'
import {resolveReleaseType} from '../../release/release-type.mjs'

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

async function readLatestVersionBumpCommit(rootDir, {runCommand} = {}) {
    if (typeof runCommand !== 'function') {
        return null
    }

    try {
        const {stdout = ''} = await runCommand('git', ['log', '--format=%H%x00%h%x00%s', '-50'], {
            capture: true,
            cwd: rootDir
        })

        for (const line of stdout.split('\n')) {
            const [hash, shortHash, subject] = line.split('\0')
            if (/^chore: bump version to \d+\.\d+\.\d+(?:[-+].*)?$/i.test(subject ?? '')) {
                return {hash, shortHash}
            }
        }
    } catch {
        return null
    }

    return null
}

async function resolveDeploymentVersionValue(rootDir, {
    versionArg = null,
    pkg,
    interactive = false,
    runPrompt,
    runCommand,
    logProcessing,
    logWarning
} = {}) {
    if (versionArg && String(versionArg).trim().length > 0) {
        return String(versionArg).trim()
    }

    const latestVersionBump = await readLatestVersionBumpCommit(rootDir, {runCommand})

    return await resolveReleaseType({
        currentVersion: pkg.version,
        packageName: pkg.name ?? 'this app',
        rootDir,
        interactive,
        runPrompt,
        runCommand,
        logStep: logProcessing,
        logWarning,
        latestTag: latestVersionBump?.hash ?? null,
        referenceLabel: latestVersionBump ? `last app version bump ${latestVersionBump.shortHash}` : null
    })
}

export async function bumpLocalPackageVersion(rootDir, {
    versionArg = null,
    interactive = false,
    runPrompt,
    skipGitHooks = false,
    runCommand,
    logProcessing,
    logSuccess,
    logWarning
} = {}) {
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

    const releaseValue = await resolveDeploymentVersionValue(rootDir, {
        versionArg,
        pkg,
        interactive,
        runPrompt,
        runCommand,
        logProcessing,
        logWarning
    })

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

    await runCommand('git', gitCommitArgs(['-m', `chore: bump version to ${nextVersion}`, '--', ...filesToStage], {
        skipGitHooks
    }), {
        cwd: rootDir
    })
    logSuccess?.(`Version updated to ${nextVersion}.`)

    return updatedPkg
}
