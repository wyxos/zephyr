import fs from 'node:fs/promises'
import path from 'node:path'

import semver from 'semver'

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

function parseVersionBumpCommit(line) {
    const [hash, shortHash, subject] = line.split('\0')
    const match = /^chore: bump version to (\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/i.exec(subject ?? '')

    if (!match) {
        return null
    }

    return {hash, shortHash, version: match[1]}
}

async function readVersionBumpCommits(rootDir, {runCommand} = {}) {
    if (typeof runCommand !== 'function') {
        return []
    }

    try {
        const {stdout = ''} = await runCommand('git', ['log', '--format=%H%x00%h%x00%s', '-1000'], {
            capture: true,
            cwd: rootDir
        })

        return stdout
            .split('\n')
            .map(parseVersionBumpCommit)
            .filter(Boolean)
    } catch {
        return []
    }
}

function selectVersionSuggestionReference(currentVersion, versionBumps) {
    const current = semver.parse(currentVersion)

    if (!current) {
        return versionBumps[0] ?? null
    }

    let earliestKnownCurrentMinor = null
    const currentMinorBoundary = versionBumps.find((versionBump) => {
        const parsed = semver.parse(versionBump.version)
        const isCurrentMinor = parsed
            && parsed.major === current.major
            && parsed.minor === current.minor
            && parsed.prerelease.length === 0

        if (isCurrentMinor) {
            earliestKnownCurrentMinor = versionBump
        }

        return isCurrentMinor && parsed.patch === 0
    })

    return currentMinorBoundary ?? earliestKnownCurrentMinor ?? versionBumps[0] ?? null
}

function formatVersionReferenceLabel(reference, currentVersion) {
    if (!reference) {
        return null
    }

    const current = semver.parse(currentVersion)
    const parsed = semver.parse(reference.version)
    const isCurrentMinor = current
        && parsed
        && parsed.major === current.major
        && parsed.minor === current.minor
        && parsed.prerelease.length === 0
    const prefix = isCurrentMinor
        ? parsed.patch === 0 ? 'current app minor baseline' : 'earliest known app minor baseline'
        : 'last app version bump'

    return `${prefix} ${reference.shortHash} (${reference.version})`
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

    const versionBumps = await readVersionBumpCommits(rootDir, {runCommand})
    const versionReference = selectVersionSuggestionReference(pkg.version, versionBumps)

    return await resolveReleaseType({
        currentVersion: pkg.version,
        packageName: pkg.name ?? 'this app',
        rootDir,
        interactive,
        runPrompt,
        runCommand,
        logStep: logProcessing,
        logWarning,
        latestTag: versionReference?.hash ?? null,
        referenceLabel: formatVersionReferenceLabel(versionReference, pkg.version)
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
