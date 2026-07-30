import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {
    createFrontendArtifactRemotePlan,
    prepareLocalFrontendArtifact,
    uploadFrontendArtifact
} from '#src/application/deploy/frontend-artifact.mjs'
import {maybeRecoverFrontendArtifact} from '#src/application/deploy/run-deployment.mjs'

const execFileAsync = promisify(execFile)
const temporaryDirectories = []

async function makeTempDir(prefix) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    temporaryDirectories.push(directory)
    return directory
}

function createArtifact(overrides = {}) {
    return {
        archivePath: '/tmp/public-build.tar.gz',
        commit: 'a'.repeat(40),
        checksum: 'b'.repeat(64),
        remoteArchivePath: '.zephyr/artifacts/build.tar.gz',
        remoteStagingPath: '.zephyr/artifacts/build.staging',
        remoteBackupPath: '.zephyr/artifacts/build.previous',
        remoteFailedPath: '.zephyr/artifacts/build.failed',
        remoteMarkerPath: '.zephyr/artifacts/build.activated',
        ...overrides
    }
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) =>
            fs.rm(directory, {recursive: true, force: true})
        )
    )
})

describe('application/deploy/frontend-artifact', () => {
    it('rejects incomplete or malformed artifact metadata before building shell commands', () => {
        expect(() => createFrontendArtifactRemotePlan()).toThrow(
            'Invalid frontend artifact metadata.'
        )
        expect(() => createFrontendArtifactRemotePlan({
            checksum: 'not-a-checksum',
            commit: 'not-a-commit',
            remoteArchivePath: '.zephyr/artifacts/archive.tar.gz',
            remoteStagingPath: '.zephyr/artifacts/staging',
            remoteBackupPath: '.zephyr/artifacts/previous',
            remoteFailedPath: '.zephyr/artifacts/failed',
            remoteMarkerPath: '.zephyr/artifacts/activated'
        })).toThrow('Invalid frontend artifact metadata.')
    })

    it('builds and packages public/build from an exact Git commit', async () => {
        const rootDir = await makeTempDir('zephyr-frontend-project-')
        await fs.writeFile(path.join(rootDir, 'package.json'), JSON.stringify({
            scripts: {build: 'vite build'}
        }))

        const runCommand = vi.fn(async (command, args) => {
            if (command === 'npm') {
                const buildDir = path.join(rootDir, 'public', 'build')
                await fs.mkdir(buildDir, {recursive: true})
                await fs.writeFile(path.join(buildDir, 'manifest.json'), '{"app.js":{"file":"app.js"}}')
                await fs.writeFile(path.join(buildDir, 'app.js'), 'console.log("built")')
                return
            }

            await execFileAsync(command, args, {cwd: rootDir})
        })
        const commit = 'c'.repeat(40)
        const artifact = await prepareLocalFrontendArtifact({
            rootDir,
            runCommand,
            runCommandCapture: vi.fn().mockResolvedValue(commit),
            logProcessing: vi.fn(),
            logSuccess: vi.fn()
        })

        expect(artifact.commit).toBe(commit)
        expect(artifact.checksum).toMatch(/^[0-9a-f]{64}$/)
        expect(artifact.remoteArchivePath).toContain(commit)
        await expect(fs.stat(artifact.archivePath)).resolves.toMatchObject({})

        const archivePath = artifact.archivePath
        await artifact.cleanupLocal()
        await expect(fs.access(archivePath)).rejects.toMatchObject({code: 'ENOENT'})
    })

    it('creates checksum-bound activation, rollback, and interruption-safe finalization commands', () => {
        const plan = createFrontendArtifactRemotePlan(createArtifact())

        expect(plan.verifyCommand).toContain('sha256sum')
        expect(plan.verifyCommand).toContain('Uploaded frontend artifact checksum does not match')
        expect(plan.activationCommand).toContain('git rev-parse HEAD')
        expect(plan.activationCommand).toContain('public/build/manifest.json')
        expect(plan.activationCommand).toContain('mv public/build')
        expect(plan.activationCommand.indexOf('printf "previous"')).toBeLessThan(
            plan.activationCommand.indexOf('mv public/build')
        )
        expect(plan.rollbackCommand).toContain("mv '.zephyr/artifacts/build.previous' public/build")
        expect(plan.rollbackCommand).toContain('artifact_previous_state=$(cat')
        expect(plan.rollbackCommand).toContain('"$artifact_previous_state" = "none"')
        expect(plan.finalizeCommand).toContain('rm -rf')
        expect(plan.finalizeCommand).toContain('printf "finalizing"')
        expect(plan.finalizeCommand.indexOf('printf "finalizing"')).toBeLessThan(
            plan.finalizeCommand.indexOf('build.previous')
        )
        expect(plan.finalizeCommand.indexOf('build.previous')).toBeLessThan(
            plan.finalizeCommand.lastIndexOf('build.activated')
        )
    })

    it('restores the old build when interrupted after it is moved but before activation', async () => {
        const rootDir = await makeTempDir('zephyr-recovery-')
        const artifact = createArtifact()
        const plan = createFrontendArtifactRemotePlan(artifact)
        const backupPath = path.join(rootDir, artifact.remoteBackupPath)
        const markerPath = path.join(rootDir, artifact.remoteMarkerPath)

        await fs.mkdir(path.dirname(backupPath), {recursive: true})
        await fs.mkdir(path.join(rootDir, 'public'), {recursive: true})
        await fs.mkdir(backupPath, {recursive: true})
        await fs.writeFile(path.join(backupPath, 'old.js'), 'old build')
        await fs.writeFile(markerPath, 'previous')

        await execFileAsync('sh', ['-c', plan.rollbackCommand], {cwd: rootDir})

        await expect(fs.readFile(path.join(rootDir, 'public/build/old.js'), 'utf8'))
            .resolves.toBe('old build')
        await expect(fs.access(backupPath)).rejects.toMatchObject({code: 'ENOENT'})
        await expect(fs.access(markerPath)).rejects.toMatchObject({code: 'ENOENT'})
    })

    it('keeps the new build when interrupted during finalization cleanup', async () => {
        const rootDir = await makeTempDir('zephyr-finalization-recovery-')
        const artifact = createArtifact()
        const plan = createFrontendArtifactRemotePlan(artifact)
        const backupPath = path.join(rootDir, artifact.remoteBackupPath)
        const markerPath = path.join(rootDir, artifact.remoteMarkerPath)
        const buildPath = path.join(rootDir, 'public/build')

        await fs.mkdir(backupPath, {recursive: true})
        await fs.mkdir(buildPath, {recursive: true})
        await fs.writeFile(path.join(backupPath, 'partial-old.js'), 'partial old build')
        await fs.writeFile(path.join(buildPath, 'new.js'), 'new build')
        await fs.writeFile(markerPath, 'finalizing')

        await execFileAsync('sh', ['-c', plan.rollbackCommand], {cwd: rootDir})

        await expect(fs.readFile(path.join(buildPath, 'new.js'), 'utf8'))
            .resolves.toBe('new build')
        await expect(fs.access(backupPath)).rejects.toMatchObject({code: 'ENOENT'})
        await expect(fs.access(markerPath)).rejects.toMatchObject({code: 'ENOENT'})
    })

    it('uploads and verifies the local artifact before deployment execution', async () => {
        const artifact = createArtifact()
        const ssh = {putFile: vi.fn().mockResolvedValue(undefined)}
        const executeRemote = vi.fn().mockResolvedValue({code: 0})

        await uploadFrontendArtifact({
            artifact,
            ssh,
            remoteCwd: '/home/shift/app',
            executeRemote,
            logProcessing: vi.fn(),
            logSuccess: vi.fn()
        })

        expect(executeRemote.mock.calls[0][0]).toBe('Prepare frontend artifact upload')
        expect(ssh.putFile).toHaveBeenCalledWith(
            artifact.archivePath,
            '/home/shift/app/.zephyr/artifacts/build.tar.gz'
        )
        expect(executeRemote.mock.calls[1][0]).toBe('Verify uploaded frontend artifact')
        expect(executeRemote.mock.invocationCallOrder[0]).toBeLessThan(ssh.putFile.mock.invocationCallOrder[0])
        expect(ssh.putFile.mock.invocationCallOrder[0]).toBeLessThan(executeRemote.mock.invocationCallOrder[1])
    })

    it('runs marker-aware recovery whether or not activation was observed locally', async () => {
        const rollbackRemote = vi.fn().mockResolvedValue({code: 0})
        const rollbackState = {
            frontendArtifactActivated: true,
            frontendArtifactFinalized: false
        }

        await maybeRecoverFrontendArtifact({
            remotePlan: {
                usesFrontendArtifact: true,
                frontendArtifactRollbackCommand: 'rollback'
            },
            executionState: rollbackState,
            executeRemote: rollbackRemote,
            logProcessing: vi.fn(),
            logWarning: vi.fn()
        })

        expect(rollbackRemote).toHaveBeenCalledWith('Restore previous frontend artifact', 'rollback')
        expect(rollbackState.frontendArtifactFinalized).toBe(true)

        const cleanupRemote = vi.fn().mockResolvedValue({code: 0})
        await maybeRecoverFrontendArtifact({
            remotePlan: {
                usesFrontendArtifact: true,
                frontendArtifactRollbackCommand: 'rollback'
            },
            executionState: {
                frontendArtifactActivated: false,
                frontendArtifactFinalized: false
            },
            executeRemote: cleanupRemote,
            logProcessing: vi.fn(),
            logWarning: vi.fn()
        })

        expect(cleanupRemote).toHaveBeenCalledWith('Recover staged frontend artifact', 'rollback')
    })
})
