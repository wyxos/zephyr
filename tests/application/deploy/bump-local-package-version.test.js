import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const {mockCommandExists, mockResolveReleaseType} = vi.hoisted(() => ({
    mockCommandExists: vi.fn(),
    mockResolveReleaseType: vi.fn()
}))

vi.mock('#src/utils/command.mjs', () => ({
    commandExists: mockCommandExists
}))

vi.mock('#src/release/release-type.mjs', () => ({
    resolveReleaseType: mockResolveReleaseType
}))

import {bumpLocalPackageVersion} from '#src/application/deploy/bump-local-package-version.mjs'

describe('application/deploy/bump-local-package-version', () => {
    let rootDir

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'zephyr-bump-version-'))
        mockCommandExists.mockReset()
        mockCommandExists.mockReturnValue(true)
        mockResolveReleaseType.mockReset()
        mockResolveReleaseType.mockResolvedValue('patch')
    })

    afterEach(async () => {
        await rm(rootDir, {recursive: true, force: true})
    })

    it('bumps package.json and commits tracked version files', async () => {
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            name: '@wyxos/demo-app',
            version: '1.0.3'
        }, null, 2) + '\n')
        await writeFile(join(rootDir, 'package-lock.json'), '{\n  "lockfileVersion": 3\n}\n')

        const runCommand = vi.fn(async (command, args, options = {}) => {
            if (command === 'git' && args[0] === 'log') {
                return {stdout: 'patch123000000000000000000000000000000000\0patch12\0chore: bump version to 1.0.3\nbase1230000000000000000000000000000000000\0base123\0chore: bump version to 1.0.1\n'}
            }

            if (command === 'git' && args[0] === 'check-ignore') {
                throw new Error('not ignored')
            }

            if (command === 'npm' && args[0] === 'version') {
                const packagePath = join(options.cwd, 'package.json')
                const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
                pkg.version = '1.0.4'
                await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n')
            }
        })

        const logProcessing = vi.fn()
        const logSuccess = vi.fn()

        const pkg = await bumpLocalPackageVersion(rootDir, {
            runCommand,
            logProcessing,
            logSuccess,
            logWarning: vi.fn()
        })

        expect(pkg.version).toBe('1.0.4')
        expect(mockResolveReleaseType).toHaveBeenCalledWith(expect.objectContaining({
            currentVersion: '1.0.3',
            packageName: '@wyxos/demo-app',
            rootDir,
            interactive: false,
            runCommand,
            latestTag: 'base1230000000000000000000000000000000000',
            referenceLabel: 'earliest known app minor baseline base123 (1.0.1)'
        }))
        expect(runCommand).toHaveBeenCalledWith('npm', ['version', 'patch', '--no-git-tag-version', '--force'], {
            cwd: rootDir
        })
        expect(runCommand).toHaveBeenCalledWith('git', ['add', 'package.json', 'package-lock.json'], {cwd: rootDir})
        expect(runCommand).toHaveBeenCalledWith(
            'git',
            ['commit', '-m', 'chore: bump version to 1.0.4', '--', 'package.json', 'package-lock.json'],
            {cwd: rootDir}
        )
        expect(logProcessing).toHaveBeenCalledWith('Bumping npm package version (patch)...')
        expect(logSuccess).toHaveBeenCalledWith('Version updated to 1.0.4.')
    })

    it('uses explicit version arguments without resolving a recommended release type', async () => {
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            name: '@wyxos/demo-app',
            version: '1.0.0'
        }, null, 2) + '\n')

        const runCommand = vi.fn(async (command, args, options = {}) => {
            if (command === 'git' && args[0] === 'check-ignore') {
                throw new Error('not ignored')
            }

            if (command === 'npm' && args[0] === 'version') {
                const packagePath = join(options.cwd, 'package.json')
                const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
                pkg.version = '1.1.0'
                await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n')
            }
        })

        const pkg = await bumpLocalPackageVersion(rootDir, {
            versionArg: 'minor',
            runCommand,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(pkg.version).toBe('1.1.0')
        expect(mockResolveReleaseType).not.toHaveBeenCalled()
        expect(runCommand).toHaveBeenCalledWith('npm', ['version', 'minor', '--no-git-tag-version', '--force'], {
            cwd: rootDir
        })
    })

    it('returns without touching files when npm is unavailable', async () => {
        mockCommandExists.mockReturnValue(false)

        const logWarning = vi.fn()
        const runCommand = vi.fn()

        const pkg = await bumpLocalPackageVersion(rootDir, {
            runCommand,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning
        })

        expect(pkg).toBeNull()
        expect(runCommand).not.toHaveBeenCalled()
        expect(logWarning).toHaveBeenCalledWith('npm is not available in PATH. Skipping npm version bump.')
    })
})
