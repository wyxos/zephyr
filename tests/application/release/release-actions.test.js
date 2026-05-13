import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const {
    mockEnsureCleanWorkingTree,
    mockEnsureReleaseBranchReady,
    mockResolveReleaseType,
    mockRunReleaseCommand,
    mockValidateReleaseDependencies
} = vi.hoisted(() => ({
    mockEnsureCleanWorkingTree: vi.fn(),
    mockEnsureReleaseBranchReady: vi.fn(),
    mockResolveReleaseType: vi.fn(),
    mockRunReleaseCommand: vi.fn(),
    mockValidateReleaseDependencies: vi.fn()
}))

vi.mock('#src/release/shared.mjs', () => ({
    ensureCleanWorkingTree: mockEnsureCleanWorkingTree,
    ensureReleaseBranchReady: mockEnsureReleaseBranchReady,
    runReleaseCommand: mockRunReleaseCommand,
    validateReleaseDependencies: mockValidateReleaseDependencies
}))

vi.mock('#src/release/release-type.mjs', () => ({
    resolveReleaseType: mockResolveReleaseType
}))

import {releaseNodePackage} from '#src/application/release/release-node-package.mjs'
import {releasePackagistPackage} from '#src/application/release/release-packagist-package.mjs'

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
        mockResolveReleaseType.mockReset()
        mockRunReleaseCommand.mockReset()
        mockValidateReleaseDependencies.mockReset()

        mockEnsureCleanWorkingTree.mockResolvedValue(undefined)
        mockEnsureReleaseBranchReady.mockResolvedValue({branch: 'main', upstreamRef: 'origin/main'})
        mockResolveReleaseType.mockImplementation(async ({releaseType}) => releaseType ?? 'patch')
        mockValidateReleaseDependencies.mockResolvedValue(undefined)
    })

    afterEach(async () => {
        process.stdout.write = originalStdoutWrite
        process.stderr.write = originalStderrWrite
        await rm(rootDir, {recursive: true, force: true})
    })

    async function createGitHubWorkflowFile() {
        await mkdir(join(rootDir, '.github', 'workflows'), {recursive: true})
        await writeFile(join(rootDir, '.github', 'workflows', 'publish.yml'), 'name: Publish Package\n')
    }

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

        expect(mockValidateReleaseDependencies).toHaveBeenCalledWith(rootDir, expect.objectContaining({
            logSuccess,
            interactive: true
        }))
        expect(mockEnsureCleanWorkingTree).toHaveBeenCalledWith(rootDir, expect.objectContaining({
            runCommand: expect.any(Function),
            interactive: true,
            skipGitHooks: false
        }))
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
            ['git', 'tag', '-fa', 'v1.0.1', '-m', 'v1.0.1'],
            ['git', 'push', '--follow-tags']
        ])

        expect(logSuccess).toHaveBeenCalledWith('Version updated to 1.0.1.')
        expect(logSuccess).toHaveBeenCalledWith('Git push completed.')
        expect(logSuccess).toHaveBeenCalledWith('Release workflow completed for @wyxos/zephyr-test@1.0.1.')
    })

    it('waits for GitHub Actions after the node release push when workflows exist', async () => {
        await createGitHubWorkflowFile()
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

            if (command === 'gh' && args[0] === '--version') {
                return {stdout: 'gh version 2.0.0', stderr: ''}
            }

            if (command === 'git' && args[0] === 'rev-parse') {
                return {stdout: 'abc123', stderr: ''}
            }

            if (command === 'gh' && args[0] === 'run' && args[1] === 'list') {
                return {
                    stdout: JSON.stringify([
                        {
                            databaseId: 900,
                            workflowName: 'Publish Package',
                            createdAt: new Date(Date.now() + 1000).toISOString(),
                            url: 'https://github.test/runs/900'
                        }
                    ]),
                    stderr: ''
                }
            }

            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        const logStep = vi.fn()
        const logSuccess = vi.fn()

        await releaseNodePackage({
            releaseType: 'patch',
            skipTests: true,
            skipLint: true,
            skipBuild: true,
            skipDeploy: true,
            rootDir,
            logStep,
            logSuccess,
            logWarning: vi.fn()
        })

        expect(commandLog.map(({command, args}) => [command, ...args])).toEqual([
            ['git', 'status', '--porcelain'],
            ['npm', 'version', 'patch'],
            ['git', 'commit', '--amend', '-m', 'chore: release 1.0.1'],
            ['git', 'tag', '-fa', 'v1.0.1', '-m', 'v1.0.1'],
            ['git', 'push', '--follow-tags'],
            ['gh', '--version'],
            ['git', 'rev-parse', 'HEAD'],
            ['gh', 'run', 'list', '--commit', 'abc123', '--event', 'push', '--json', 'databaseId,status,conclusion,workflowName,createdAt,url', '--limit', '20'],
            ['gh', 'run', 'watch', '900', '--exit-status', '--compact']
        ])
        expect(logStep).toHaveBeenCalledWith('Watching GitHub Actions workflow Publish Package #900...')
        expect(logSuccess).toHaveBeenCalledWith('GitHub Actions workflow Publish Package #900 completed successfully.')
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
        expect(mockValidateReleaseDependencies).toHaveBeenCalledWith(rootDir, expect.objectContaining({
            logSuccess,
            interactive: true
        }))
        expect(mockEnsureCleanWorkingTree).toHaveBeenCalledWith(rootDir, expect.objectContaining({
            runCommand: expect.any(Function),
            interactive: true,
            skipGitHooks: false
        }))
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

    it('waits for GitHub Actions after the Packagist release push when workflows exist', async () => {
        await createGitHubWorkflowFile()
        await writeFile(join(rootDir, 'composer.json'), JSON.stringify({
            name: 'wyxos/test-package',
            version: '1.0.0'
        }, null, 2) + '\n')

        const commandLog = []

        mockRunReleaseCommand.mockImplementation(async (command, args, options = {}) => {
            commandLog.push({command, args, options})

            if (command === 'gh' && args[0] === '--version') {
                return {stdout: 'gh version 2.0.0', stderr: ''}
            }

            if (command === 'git' && args[0] === 'rev-parse') {
                return {stdout: 'abc123', stderr: ''}
            }

            if (command === 'gh' && args[0] === 'run' && args[1] === 'list') {
                return {
                    stdout: JSON.stringify([
                        {
                            databaseId: 901,
                            workflowName: 'Packagist Sync',
                            createdAt: new Date(Date.now() + 1000).toISOString(),
                            url: 'https://github.test/runs/901'
                        }
                    ]),
                    stderr: ''
                }
            }

            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        const logSuccess = vi.fn()

        await releasePackagistPackage({
            releaseType: 'patch',
            skipTests: true,
            skipLint: true,
            rootDir,
            logStep: vi.fn(),
            logSuccess,
            logWarning: vi.fn()
        })

        const commands = commandLog.map(({command, args}) => [command, ...args])
        expect(commands).toEqual([
            ['git', 'add', 'composer.json'],
            ['git', 'commit', '-m', 'chore: release 1.0.1'],
            ['git', 'tag', 'v1.0.1'],
            ['git', 'push'],
            ['git', 'push', 'origin', '--tags'],
            ['gh', '--version'],
            ['git', 'rev-parse', 'HEAD'],
            ['gh', 'run', 'list', '--commit', 'abc123', '--event', 'push', '--json', 'databaseId,status,conclusion,workflowName,createdAt,url', '--limit', '20'],
            ['gh', 'run', 'watch', '901', '--exit-status', '--compact']
        ])
        expect(logSuccess).toHaveBeenCalledWith('GitHub Actions workflow Packagist Sync #901 completed successfully.')
    })

    it('resolves the release type when none was provided', async () => {
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            name: '@wyxos/zephyr-test',
            version: '1.0.0'
        }, null, 2) + '\n')

        mockResolveReleaseType.mockResolvedValue('minor')

        const commandLog = []

        mockRunReleaseCommand.mockImplementation(async (command, args, options = {}) => {
            commandLog.push({command, args, options})

            if (command === 'git' && args[0] === 'status') {
                return {stdout: '', stderr: ''}
            }

            if (command === 'npm' && args[0] === 'version') {
                const packagePath = join(options.cwd, 'package.json')
                const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
                pkg.version = '1.1.0'
                await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n')
                return {stdout: 'v1.1.0', stderr: ''}
            }

            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        await releaseNodePackage({
            releaseType: null,
            skipTests: true,
            skipLint: true,
            skipBuild: true,
            skipDeploy: true,
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            runPrompt: vi.fn()
        })

        expect(mockResolveReleaseType).toHaveBeenCalledWith(expect.objectContaining({
            releaseType: null,
            currentVersion: '1.0.0',
            packageName: '@wyxos/zephyr-test'
        }))
        expect(commandLog.map(({command, args}) => [command, ...args])).toContainEqual(['npm', 'version', 'minor'])
    })

    it('can release the current package version without mutating package.json', async () => {
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

            if (command === 'git' && args[0] === 'tag' && args[1] === '-l') {
                return {stdout: '', stderr: ''}
            }

            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        const logWarning = vi.fn()

        await releaseNodePackage({
            skipVersioning: true,
            skipTests: true,
            skipLint: true,
            skipBuild: true,
            skipDeploy: true,
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning
        })

        expect(mockResolveReleaseType).not.toHaveBeenCalled()
        expect(commandLog.map(({command, args}) => [command, ...args])).toEqual([
            ['git', 'tag', '-l', 'v1.0.0'],
            ['git', 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0'],
            ['git', 'push', '--follow-tags']
        ])
        expect(logWarning).toHaveBeenCalledWith(
            'Skipping package.json version update because --skip-versioning flag was provided. Releasing current version 1.0.0.'
        )
    })

    it('fails node skip-versioning when the target release tag already exists', async () => {
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            name: '@wyxos/zephyr-test',
            version: '1.0.0'
        }, null, 2) + '\n')

        mockRunReleaseCommand.mockImplementation(async (command, args, options = {}) => {
            if (command === 'git' && args[0] === 'status') {
                return {stdout: '', stderr: ''}
            }

            if (command === 'git' && args[0] === 'tag' && args[1] === '-l') {
                return {stdout: 'v1.0.0\n', stderr: ''}
            }

            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        await expect(releaseNodePackage({
            skipVersioning: true,
            skipTests: true,
            skipLint: true,
            skipBuild: true,
            skipDeploy: true,
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })).rejects.toThrow(
            'Release tag v1.0.0 already exists. Remove the existing tag or update package.json before using --skip-versioning.'
        )
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
            {command: 'git', args: ['tag', '-fa', 'v1.0.1', '-m', 'v1.0.1'], options: {capture: true, cwd: rootDir}},
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
            expect.objectContaining({
                command: 'php',
                args: [expect.stringMatching(/vendor[\\/]+bin[\\/]+pint/)],
                options: expect.objectContaining({capture: true, cwd: rootDir})
            }),
            expect.objectContaining({
                command: 'php',
                args: ['artisan', 'test', '--compact'],
                options: expect.objectContaining({capture: true, cwd: rootDir})
            }),
            expect.objectContaining({
                command: 'git',
                args: ['add', 'composer.json'],
                options: expect.objectContaining({cwd: rootDir})
            }),
            expect.objectContaining({
                command: 'git',
                args: ['commit', '-m', 'chore: release 1.0.1'],
                options: expect.objectContaining({cwd: rootDir})
            }),
            expect.objectContaining({
                command: 'git',
                args: ['tag', 'v1.0.1'],
                options: expect.objectContaining({cwd: rootDir})
            })
        ]))

        expect(commandLog.some(({command, args}) => command === 'composer' && args[0] === 'test')).toBe(false)
    })

    it('can release the current composer version without mutating composer.json', async () => {
        await writeFile(join(rootDir, 'composer.json'), JSON.stringify({
            name: 'wyxos/test-package',
            version: '1.0.0'
        }, null, 2) + '\n')

        const commandLog = []

        mockRunReleaseCommand.mockImplementation(async (command, args, options = {}) => {
            commandLog.push({command, args, options})

            if (command === 'git' && args[0] === 'tag' && args[1] === '-l') {
                return {stdout: '', stderr: ''}
            }

            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        const logWarning = vi.fn()

        await releasePackagistPackage({
            skipVersioning: true,
            skipTests: true,
            skipLint: true,
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning
        })

        expect(mockResolveReleaseType).not.toHaveBeenCalled()
        expect(commandLog.map(({command, args}) => [command, ...args])).toEqual([
            ['git', 'tag', '-l', 'v1.0.0'],
            ['git', 'tag', 'v1.0.0'],
            ['git', 'push'],
            ['git', 'push', 'origin', '--tags']
        ])
        expect(logWarning).toHaveBeenCalledWith(
            'Skipping composer.json version update because --skip-versioning flag was provided. Releasing current version 1.0.0.'
        )
    })

    it('fails packagist skip-versioning when composer.json uses an invalid version', async () => {
        await writeFile(join(rootDir, 'composer.json'), JSON.stringify({
            name: 'wyxos/test-package',
            version: 'banana'
        }, null, 2) + '\n')

        await expect(releasePackagistPackage({
            skipVersioning: true,
            skipTests: true,
            skipLint: true,
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })).rejects.toThrow('Invalid current version "banana" in composer.json. Must be a valid semver.')
    })

    it('passes non-interactive dependency validation through the node release workflow', async () => {
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            name: '@wyxos/zephyr-test',
            version: '1.0.0'
        }, null, 2) + '\n')

        mockRunReleaseCommand.mockResolvedValue({stdout: '', stderr: ''})

        await releaseNodePackage({
            releaseType: 'patch',
            skipTests: true,
            skipLint: true,
            skipBuild: true,
            skipDeploy: true,
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            runPrompt: vi.fn(),
            interactive: false
        })

        expect(mockValidateReleaseDependencies).toHaveBeenCalledWith(rootDir, expect.objectContaining({
            interactive: false
        }))
    })

    it('can bypass git hooks in the node release workflow', async () => {
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

            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        await releaseNodePackage({
            releaseType: 'patch',
            skipGitHooks: true,
            skipTests: true,
            skipLint: true,
            skipBuild: true,
            skipDeploy: true,
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(commandLog.map(({command, args}) => [command, ...args])).toEqual([
            ['git', 'status', '--porcelain'],
            ['npm', 'version', 'patch', '--no-commit-hooks'],
            ['git', 'commit', '--no-verify', '--amend', '-m', 'chore: release 1.0.1'],
            ['git', 'tag', '-fa', 'v1.0.1', '-m', 'v1.0.1'],
            ['git', 'push', '--no-verify', '--follow-tags']
        ])
    })

    it('can bypass git hooks in the Packagist release workflow', async () => {
        await writeFile(join(rootDir, 'composer.json'), JSON.stringify({
            name: 'wyxos/test-package',
            version: '1.0.0'
        }, null, 2) + '\n')

        const commandLog = []

        mockRunReleaseCommand.mockImplementation(async (command, args, options = {}) => {
            commandLog.push({command, args, options})
            return options.capture ? {stdout: '', stderr: ''} : undefined
        })

        await releasePackagistPackage({
            releaseType: 'patch',
            skipGitHooks: true,
            skipTests: true,
            skipLint: true,
            rootDir,
            logStep: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(commandLog.map(({command, args}) => [command, ...args])).toEqual([
            ['git', 'add', 'composer.json'],
            ['git', 'commit', '--no-verify', '-m', 'chore: release 1.0.1'],
            ['git', 'tag', 'v1.0.1'],
            ['git', 'push', '--no-verify'],
            ['git', 'push', '--no-verify', 'origin', '--tags']
        ])
    })
})
