import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {updateConsumerDependency} from '#src/application/consumer/update-consumer-dependency.mjs'

const tempDirs = []

async function createConsumerPackage(packageJson) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zephyr-consumer-'))
    tempDirs.push(rootDir)
    await fs.writeFile(path.join(rootDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
    return rootDir
}

function createCommandMocks({initialStatus = '', trackedFiles = [], changedStatus = ''} = {}) {
    const runCommand = vi.fn().mockResolvedValue({stdout: '', stderr: ''})
    const runCommandCapture = vi.fn(async (command, args) => {
        if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain' && args.length === 2) {
            return {stdout: initialStatus, stderr: ''}
        }

        if (command === 'git' && args[0] === 'ls-files') {
            const filePath = args.at(-1)
            if (trackedFiles.includes(filePath)) {
                return {stdout: filePath, stderr: ''}
            }

            throw new Error('not tracked')
        }

        if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain' && args[2] === '--') {
            return {stdout: changedStatus, stderr: ''}
        }

        return {stdout: '', stderr: ''}
    })

    return {runCommand, runCommandCapture}
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, {recursive: true, force: true})))
})

describe('application/consumer/update-consumer-dependency', () => {
    it('updates package.json and commits only the manifest when no npm lockfile is tracked', async () => {
        const rootDir = await createConsumerPackage({
            dependencies: {
                '@wyxos/vibe': '^3.1.22'
            }
        })
        const {runCommand, runCommandCapture} = createCommandMocks({
            changedStatus: ' M package.json\n'
        })
        const logWarning = vi.fn()

        const result = await updateConsumerDependency({
            rootDir,
            packageName: '@wyxos/vibe',
            version: '3.1.23',
            runCommand,
            runCommandCapture,
            logWarning
        })
        const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'))

        expect(packageJson.dependencies['@wyxos/vibe']).toBe('^3.1.23')
        expect(runCommand).not.toHaveBeenCalledWith('npm', expect.any(Array), expect.any(Object))
        expect(runCommand).toHaveBeenCalledWith('git', ['add', '--', 'package.json'], {cwd: rootDir})
        expect(runCommand).toHaveBeenCalledWith('git', [
            'commit',
            '-m',
            'chore: update @wyxos/vibe to 3.1.23',
            '--',
            'package.json'
        ], {cwd: rootDir})
        expect(logWarning).toHaveBeenCalledWith('No tracked npm lock file found in consumer repo; committing manifest update only.')
        expect(result).toEqual({
            committed: true,
            files: ['package.json'],
            message: 'chore: update @wyxos/vibe to 3.1.23'
        })
    })

    it('refreshes tracked npm lockfiles before committing the consumer update', async () => {
        const rootDir = await createConsumerPackage({
            dependencies: {
                '@wyxos/vibe': '^3.1.22'
            }
        })
        await fs.writeFile(path.join(rootDir, 'package-lock.json'), '{}\n', 'utf8')
        const {runCommand, runCommandCapture} = createCommandMocks({
            trackedFiles: ['package-lock.json'],
            changedStatus: ' M package.json\n M package-lock.json\n'
        })

        const result = await updateConsumerDependency({
            rootDir,
            packageName: '@wyxos/vibe',
            version: '3.1.23',
            runCommand,
            runCommandCapture,
            skipGitHooks: true
        })

        expect(runCommand).toHaveBeenCalledWith('npm', ['install', '--package-lock-only', '--ignore-scripts'], {cwd: rootDir})
        expect(runCommand).toHaveBeenCalledWith('git', ['add', '--', 'package.json', 'package-lock.json'], {cwd: rootDir})
        expect(runCommand).toHaveBeenCalledWith('git', [
            'commit',
            '--no-verify',
            '-m',
            'chore: update @wyxos/vibe to 3.1.23',
            '--',
            'package.json',
            'package-lock.json'
        ], {cwd: rootDir})
        expect(result.files).toEqual(['package.json', 'package-lock.json'])
    })

    it('fails before editing when the consumer repository is dirty', async () => {
        const rootDir = await createConsumerPackage({
            dependencies: {
                '@wyxos/vibe': '^3.1.22'
            }
        })
        const {runCommand, runCommandCapture} = createCommandMocks({
            initialStatus: ' M src/app.js\n'
        })

        await expect(updateConsumerDependency({
            rootDir,
            packageName: '@wyxos/vibe',
            version: '3.1.23',
            runCommand,
            runCommandCapture
        })).rejects.toThrow('Consumer repository has uncommitted changes.')

        const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'))
        expect(packageJson.dependencies['@wyxos/vibe']).toBe('^3.1.22')
        expect(runCommand).not.toHaveBeenCalled()
    })
})
