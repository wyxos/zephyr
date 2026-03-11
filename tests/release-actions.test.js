import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const {
    mockEnsureCleanWorkingTree,
    mockEnsureReleaseBranchReady,
    mockRunReleaseCommand,
    mockValidateReleaseDependencies
} = vi.hoisted(() => ({
    mockEnsureCleanWorkingTree: vi.fn(),
    mockEnsureReleaseBranchReady: vi.fn(),
    mockRunReleaseCommand: vi.fn(),
    mockValidateReleaseDependencies: vi.fn()
}))

vi.mock('../src/release/shared.mjs', () => ({
    ensureCleanWorkingTree: mockEnsureCleanWorkingTree,
    ensureReleaseBranchReady: mockEnsureReleaseBranchReady,
    runReleaseCommand: mockRunReleaseCommand,
    validateReleaseDependencies: mockValidateReleaseDependencies
}))

import {releaseNodePackage} from '../src/application/release/release-node-package.mjs'
import {releasePackagistPackage} from '../src/application/release/release-packagist-package.mjs'

describe('release application actions', () => {
    let rootDir
    let originalStdoutWrite
    let originalStderrWrite

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'zephyr-release-'))
        originalStdoutWrite = process.stdout.write
        originalStderrWrite = process.stderr.write
        process.stdout.write = vi.fn()
        process.stderr.write = vi.fn()

        mockEnsureCleanWorkingTree.mockReset()
        mockEnsureReleaseBranchReady.mockReset()
        mockRunReleaseCommand.mockReset()
        mockValidateReleaseDependencies.mockReset()

        mockEnsureCleanWorkingTree.mockResolvedValue(undefined)
        mockEnsureReleaseBranchReady.mockResolvedValue({branch: 'main', upstreamRef: 'origin/main'})
        mockValidateReleaseDependencies.mockResolvedValue(undefined)
    })

    afterEach(async () => {
        process.stdout.write = originalStdoutWrite
        process.stderr.write = originalStderrWrite
        await rm(rootDir, {recursive: true, force: true})
    })

    it('runs the node release workflow through the extracted action module', async () => {
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            name: '@wyxos/zephyr-test',
            version: '1.0.0'
        }, null, 2) + '\n')

        const commandLog = []

        mockRunReleaseCommand.mockImplementation(async (command, args, options = {}) => {
            commandLog.push({command, args, options})

            if (command === 'git' && args[0] === 'status') {
                return {stdout: '', stderr: ''}
            }

            if (command === 'npm' && args[0] === 'version') {
                const packagePath = join(options.cwd, 'package.json')
                const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
                pkg.version = '1.0.1'
                await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n')
                return {stdout: 'v1.0.1', stderr: ''}
            }

            if (options.capture) {
                return {stdout: '', stderr: ''}
            }

            return undefined
        })

        const logStep = vi.fn()
        const logSuccess = vi.fn()
        const logWarning = vi.fn()

        await releaseNodePackage({
            releaseType: 'patch',
            skipTests: true,
            skipLint: true,
            skipBuild: true,
            skipDeploy: true,
            rootDir,
            logStep,
            logSuccess,
            logWarning
        })

        expect(mockValidateReleaseDependencies).toHaveBeenCalledWith(rootDir, {logSuccess})
        expect(mockEnsureCleanWorkingTree).toHaveBeenCalledWith(rootDir, {runCommand: mockRunReleaseCommand})
        expect(mockEnsureReleaseBranchReady).toHaveBeenCalledWith(expect.objectContaining({
            rootDir,
            branchMethod: 'show-current',
            logStep,
            logWarning
        }))

        expect(commandLog.map(({command, args}) => [command, ...args])).toEqual([
            ['git', 'status', '--porcelain'],
            ['npm', 'version', 'patch'],
            ['git', 'commit', '--amend', '-m', 'chore: release 1.0.1'],
            ['git', 'push', '--follow-tags']
        ])

        expect(logSuccess).toHaveBeenCalledWith('Version updated to 1.0.1.')
        expect(logSuccess).toHaveBeenCalledWith('Git push completed.')
        expect(logSuccess).toHaveBeenCalledWith('Release workflow completed for @wyxos/zephyr-test@1.0.1.')
    })

    it('runs the Packagist release workflow through the extracted action module', async () => {
        await writeFile(join(rootDir, 'composer.json'), JSON.stringify({
            name: 'wyxos/test-package',
            version: '1.0.0'
        }, null, 2) + '\n')

        const commandLog = []

        mockRunReleaseCommand.mockImplementation(async (command, args, options = {}) => {
            commandLog.push({command, args, options})
            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        const logStep = vi.fn()
        const logSuccess = vi.fn()
        const logWarning = vi.fn()

        await releasePackagistPackage({
            releaseType: 'patch',
            skipTests: true,
            skipLint: true,
            rootDir,
            logStep,
            logSuccess,
            logWarning
        })

        const composer = JSON.parse(await readFile(join(rootDir, 'composer.json'), 'utf8'))

        expect(composer.version).toBe('1.0.1')
        expect(mockValidateReleaseDependencies).toHaveBeenCalledWith(rootDir, {logSuccess})
        expect(mockEnsureCleanWorkingTree).toHaveBeenCalledWith(rootDir, {runCommand: mockRunReleaseCommand})
        expect(mockEnsureReleaseBranchReady).toHaveBeenCalledWith(expect.objectContaining({
            rootDir,
            branchMethod: 'show-current',
            logStep,
            logWarning
        }))

        expect(commandLog.map(({command, args}) => [command, ...args])).toEqual([
            ['git', 'add', 'composer.json'],
            ['git', 'commit', '-m', 'chore: release 1.0.1'],
            ['git', 'tag', 'v1.0.1'],
            ['git', 'push'],
            ['git', 'push', 'origin', '--tags']
        ])

        expect(logSuccess).toHaveBeenCalledWith('Version updated to 1.0.1.')
        expect(logSuccess).toHaveBeenCalledWith('Git push completed.')
        expect(logSuccess).toHaveBeenCalledWith('Release workflow completed for wyxos/test-package@1.0.1.')
    })

    it('handles lib artifacts and GitHub Pages deployment in the node release action', async () => {
        await mkdir(join(rootDir, 'dist'), {recursive: true})
        await mkdir(join(rootDir, 'lib'), {recursive: true})
        await writeFile(join(rootDir, 'dist', 'index.html'), '<h1>docs</h1>\n')
        await writeFile(join(rootDir, 'lib', 'index.js'), 'export const version = "1.0.0"\n')
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            name: '@wyxos/docs-demo',
            version: '1.0.0',
            homepage: 'https://docs.example.com/project',
            scripts: {
                lint: 'eslint .',
                'test:run': 'vitest run',
                'build:lib': 'tsup',
                build: 'vite build'
            }
        }, null, 2) + '\n')

        const worktreeDir = join(rootDir, '.gh-pages')
        await mkdir(join(worktreeDir, '.git'), {recursive: true})
        await writeFile(join(worktreeDir, 'stale.txt'), 'old\n')

        const commandLog = []

        mockRunReleaseCommand.mockImplementation(async (command, args, options = {}) => {
            commandLog.push({command, args, options})

            if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
                if (commandLog.filter(({command: currentCommand, args: currentArgs}) => currentCommand === 'git' && currentArgs[0] === 'status').length === 1) {
                    return {stdout: ' M lib/index.js', stderr: ''}
                }

                return {stdout: ' M lib/index.js', stderr: ''}
            }

            if (command === 'npm' && args[0] === 'version') {
                const packagePath = join(options.cwd, 'package.json')
                const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
                pkg.version = '1.0.1'
                await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n')
                return {stdout: 'v1.0.1', stderr: ''}
            }

            if (options.capture) {
                return {stdout: '', stderr: ''}
            }

            return undefined
        })

        await releaseNodePackage({
            releaseType: 'patch',
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(await readFile(join(worktreeDir, 'index.html'), 'utf8')).toBe('<h1>docs</h1>\n')
        expect(await readFile(join(worktreeDir, 'CNAME'), 'utf8')).toBe('docs.example.com')
        await expect(readFile(join(worktreeDir, 'stale.txt'), 'utf8')).rejects.toThrow()

        expect(commandLog).toEqual(expect.arrayContaining([
            {command: 'npm', args: ['run', 'lint'], options: {cwd: rootDir}},
            {command: 'npm', args: ['run', 'test:run', '--', '--reporter=dot'], options: {cwd: rootDir}},
            {command: 'npm', args: ['run', 'build:lib'], options: {cwd: rootDir}},
            {command: 'git', args: ['add', 'lib/'], options: {capture: true, cwd: rootDir}},
            {command: 'git', args: ['commit', '-m', 'chore: build lib artifacts'], options: {capture: true, cwd: rootDir}},
            {command: 'git', args: ['stash', 'push', '-u', '-m', 'temp: lib build artifacts', 'lib/'], options: {capture: true, cwd: rootDir}},
            {command: 'git', args: ['stash', 'pop'], options: {capture: true, cwd: rootDir}},
            {command: 'git', args: ['commit', '--amend', '--no-edit'], options: {capture: true, cwd: rootDir}},
            {command: 'npm', args: ['run', 'build'], options: {cwd: rootDir}},
            {command: 'git', args: ['push', '--follow-tags'], options: {capture: true, cwd: rootDir}},
            {command: 'git', args: ['worktree', 'remove', worktreeDir, '-f'], options: {capture: true, cwd: rootDir}},
            {command: 'git', args: ['worktree', 'add', worktreeDir, 'gh-pages'], options: {capture: true, cwd: rootDir}},
            {command: 'git', args: ['-C', worktreeDir, 'push', '-f', 'origin', 'gh-pages'], options: {capture: true}}
        ]))

        expect(commandLog.some(({command, args}) => command === 'git' && args[0] === '-C' && args[2] === 'commit' && /^deploy: demo /.test(args[4]))).toBe(true)
    })

    it('runs Pint and artisan tests in the Packagist release action when available', async () => {
        await mkdir(join(rootDir, 'vendor', 'bin'), {recursive: true})
        await writeFile(join(rootDir, 'vendor', 'bin', 'pint'), '#!/usr/bin/env php\n')
        await writeFile(join(rootDir, 'artisan'), '#!/usr/bin/env php\n')
        await writeFile(join(rootDir, 'composer.json'), JSON.stringify({
            name: 'wyxos/laravel-package',
            version: '1.0.0',
            scripts: {
                test: '@phpunit'
            }
        }, null, 2) + '\n')

        const commandLog = []

        mockRunReleaseCommand.mockImplementation(async (command, args, options = {}) => {
            commandLog.push({command, args, options})
            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        await releasePackagistPackage({
            releaseType: 'patch',
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(commandLog).toEqual(expect.arrayContaining([
            {command: 'php', args: ['vendor/bin/pint'], options: {capture: true, cwd: rootDir}},
            {command: 'php', args: ['artisan', 'test', '--compact'], options: {capture: true, cwd: rootDir}},
            {command: 'git', args: ['add', 'composer.json'], options: {cwd: rootDir}},
            {command: 'git', args: ['commit', '-m', 'chore: release 1.0.1'], options: {cwd: rootDir}},
            {command: 'git', args: ['tag', 'v1.0.1'], options: {cwd: rootDir}}
        ]))

        expect(commandLog.some(({command, args}) => command === 'composer' && args[0] === 'test')).toBe(false)
    })
})
