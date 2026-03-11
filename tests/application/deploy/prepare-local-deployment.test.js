import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const {
    mockCommandExists,
    mockCommitLintingChanges,
    mockEnsureLocalRepositoryState,
    mockGetPhpVersionRequirement,
    mockHasPrePushHook,
    mockHasUncommittedChanges,
    mockIsLocalLaravelProject,
    mockRunLinting
} = vi.hoisted(() => ({
    mockCommandExists: vi.fn(),
    mockCommitLintingChanges: vi.fn(),
    mockEnsureLocalRepositoryState: vi.fn(),
    mockGetPhpVersionRequirement: vi.fn(),
    mockHasPrePushHook: vi.fn(),
    mockHasUncommittedChanges: vi.fn(),
    mockIsLocalLaravelProject: vi.fn(),
    mockRunLinting: vi.fn()
}))

vi.mock('../../../src/deploy/local-repo.mjs', () => ({
    ensureLocalRepositoryState: mockEnsureLocalRepositoryState,
    hasUncommittedChanges: mockHasUncommittedChanges
}))

vi.mock('../../../src/deploy/preflight.mjs', () => ({
    commitLintingChanges: mockCommitLintingChanges,
    hasPrePushHook: mockHasPrePushHook,
    isLocalLaravelProject: mockIsLocalLaravelProject,
    runLinting: mockRunLinting
}))

vi.mock('../../../src/infrastructure/php/version.mjs', () => ({
    getPhpVersionRequirement: mockGetPhpVersionRequirement
}))

vi.mock('../../../src/utils/command.mjs', () => ({
    commandExists: mockCommandExists
}))

import {prepareLocalDeployment} from '../../../src/application/deploy/prepare-local-deployment.mjs'

describe('application/deploy/prepare-local-deployment', () => {
    let rootDir

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'zephyr-local-deploy-'))

        mockCommandExists.mockReset()
        mockCommitLintingChanges.mockReset()
        mockEnsureLocalRepositoryState.mockReset()
        mockGetPhpVersionRequirement.mockReset()
        mockHasPrePushHook.mockReset()
        mockHasUncommittedChanges.mockReset()
        mockIsLocalLaravelProject.mockReset()
        mockRunLinting.mockReset()

        mockCommandExists.mockImplementation((command) => command === 'npm' || command === 'php')
        mockCommitLintingChanges.mockResolvedValue(undefined)
        mockEnsureLocalRepositoryState.mockResolvedValue(undefined)
        mockGetPhpVersionRequirement.mockResolvedValue('8.4.0')
        mockHasPrePushHook.mockResolvedValue(false)
        mockHasUncommittedChanges.mockResolvedValue(false)
        mockIsLocalLaravelProject.mockResolvedValue(true)
        mockRunLinting.mockResolvedValue(false)
    })

    afterEach(async () => {
        await rm(rootDir, {recursive: true, force: true})
    })

    it('bumps version and runs local checks when deploying a Laravel app without a pre-push hook', async () => {
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            name: '@wyxos/demo-app',
            version: '1.0.0'
        }, null, 2) + '\n')

        mockRunLinting.mockResolvedValue(true)
        mockHasUncommittedChanges.mockResolvedValue(true)

        const runCommand = vi.fn(async (command, args, options = {}) => {
            if (command === 'git' && args[0] === 'check-ignore') {
                throw new Error('not ignored')
            }

            if (command === 'npm' && args[0] === 'version') {
                const packagePath = join(options.cwd, 'package.json')
                const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
                pkg.version = '1.0.1'
                await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n')
            }
        })

        const logProcessing = vi.fn()
        const logSuccess = vi.fn()
        const logWarning = vi.fn()

        const result = await prepareLocalDeployment({
            branch: 'main'
        }, {
            rootDir,
            runPrompt: vi.fn(),
            runCommand,
            runCommandCapture: vi.fn(),
            logProcessing,
            logSuccess,
            logWarning
        })

        expect(result).toEqual({
            requiredPhpVersion: '8.4.0',
            isLaravel: true,
            hasHook: false
        })
        expect(mockEnsureLocalRepositoryState).toHaveBeenCalledWith('main', rootDir, expect.objectContaining({
            runCommand,
            logProcessing,
            logSuccess,
            logWarning
        }))
        expect(mockRunLinting).toHaveBeenCalledWith(rootDir, expect.objectContaining({
            runCommand,
            logProcessing,
            logSuccess,
            logWarning,
            commandExists: mockCommandExists
        }))
        expect(mockCommitLintingChanges).toHaveBeenCalled()
        expect(runCommand).toHaveBeenCalledWith('npm', ['version', 'patch', '--no-git-tag-version', '--force'], {cwd: rootDir})
        expect(runCommand).toHaveBeenCalledWith('git', ['add', 'package.json'], {cwd: rootDir})
        expect(runCommand).toHaveBeenCalledWith(
            'git',
            ['commit', '-m', 'chore: bump version to 1.0.1', '--', 'package.json'],
            {cwd: rootDir}
        )
        expect(runCommand).toHaveBeenCalledWith('php', ['artisan', 'test', '--compact'], {cwd: rootDir})
        expect(logSuccess).toHaveBeenCalledWith('Version updated to 1.0.1.')
        expect(logSuccess).toHaveBeenCalledWith('Local tests passed.')
    })

    it('skips version, lint, and local tests when resuming with a pre-push hook present', async () => {
        mockHasPrePushHook.mockResolvedValue(true)

        const runCommand = vi.fn()
        const logProcessing = vi.fn()

        const result = await prepareLocalDeployment({
            branch: 'main'
        }, {
            snapshot: {changedFiles: ['composer.json']},
            rootDir,
            runPrompt: vi.fn(),
            runCommand,
            runCommandCapture: vi.fn(),
            logProcessing,
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(result).toEqual({
            requiredPhpVersion: '8.4.0',
            isLaravel: true,
            hasHook: true
        })
        expect(runCommand).not.toHaveBeenCalled()
        expect(mockRunLinting).not.toHaveBeenCalled()
        expect(mockCommitLintingChanges).not.toHaveBeenCalled()
        expect(logProcessing).toHaveBeenCalledWith('Pre-push git hook detected. Skipping local linting and test execution.')
    })
})
