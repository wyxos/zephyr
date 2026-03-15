import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    mockCommandExists,
    mockCommitLintingChanges,
    mockGetGitStatus,
    mockHasUncommittedChanges,
    mockResolveSupportedLintCommand,
    mockRunLinting
} = vi.hoisted(() => ({
    mockCommandExists: vi.fn(),
    mockCommitLintingChanges: vi.fn(),
    mockGetGitStatus: vi.fn(),
    mockHasUncommittedChanges: vi.fn(),
    mockResolveSupportedLintCommand: vi.fn(),
    mockRunLinting: vi.fn()
}))

vi.mock('#src/utils/command.mjs', () => ({
    commandExists: mockCommandExists
}))

vi.mock('#src/deploy/local-repo.mjs', () => ({
    getGitStatus: mockGetGitStatus,
    hasUncommittedChanges: mockHasUncommittedChanges
}))

vi.mock('#src/deploy/preflight.mjs', () => ({
    commitLintingChanges: mockCommitLintingChanges,
    resolveSupportedLintCommand: mockResolveSupportedLintCommand,
    runLinting: mockRunLinting
}))

import {
    resolveLocalDeploymentCheckSupport,
    runLocalDeploymentChecks
} from '#src/application/deploy/run-local-deployment-checks.mjs'

describe('application/deploy/run-local-deployment-checks', () => {
    beforeEach(() => {
        mockCommandExists.mockReset()
        mockCommitLintingChanges.mockReset()
        mockGetGitStatus.mockReset()
        mockHasUncommittedChanges.mockReset()
        mockResolveSupportedLintCommand.mockReset()
        mockRunLinting.mockReset()

        mockCommandExists.mockImplementation((command) => command === 'php')
        mockCommitLintingChanges.mockResolvedValue(undefined)
        mockGetGitStatus.mockResolvedValue(' M package.json')
        mockHasUncommittedChanges.mockResolvedValue(false)
        mockResolveSupportedLintCommand.mockResolvedValue({
            type: 'npm',
            command: 'npm',
            args: ['run', 'lint'],
            label: 'npm lint'
        })
        mockRunLinting.mockResolvedValue(false)
    })

    it('validates supported checks but skips executing them when a pre-push hook is present', async () => {
        const logProcessing = vi.fn()
        const runCommand = vi.fn()
        const runCommandCapture = vi.fn().mockResolvedValue('test\nqueue:work\n')

        await runLocalDeploymentChecks({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: true,
            runCommand,
            runCommandCapture,
            logProcessing,
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(mockResolveSupportedLintCommand).toHaveBeenCalledWith('/repo/demo', {
            commandExists: mockCommandExists
        })
        expect(runCommandCapture).toHaveBeenCalledWith('php', ['artisan', 'list'], {cwd: '/repo/demo'})
        expect(mockRunLinting).not.toHaveBeenCalled()
        expect(mockCommitLintingChanges).not.toHaveBeenCalled()
        expect(runCommand).not.toHaveBeenCalled()
        expect(logProcessing).toHaveBeenCalledWith(
            'Pre-push git hook detected. Built-in release checks are supported, but Zephyr will skip executing them here. If Zephyr pushes local commits during this release, the hook will run during git push.'
        )
    })

    it('commits lint changes and runs local Laravel tests when needed', async () => {
        mockRunLinting.mockResolvedValue(true)
        mockHasUncommittedChanges.mockResolvedValue(true)

        const runCommand = vi.fn()
        const runCommandCapture = vi.fn().mockResolvedValue('test\nqueue:work\n')
        const logProcessing = vi.fn()
        const logSuccess = vi.fn()
        const logWarning = vi.fn()

        await runLocalDeploymentChecks({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: false,
            runCommand,
            runCommandCapture,
            logProcessing,
            logSuccess,
            logWarning
        })

        expect(mockRunLinting).toHaveBeenCalledWith('/repo/demo', expect.objectContaining({
            runCommand,
            logProcessing,
            logSuccess,
            logWarning,
            commandExists: mockCommandExists,
            lintCommand: expect.objectContaining({
                type: 'npm',
                command: 'npm',
                args: ['run', 'lint']
            })
        }))
        expect(mockHasUncommittedChanges).toHaveBeenCalledWith('/repo/demo', {
            getGitStatus: expect.any(Function)
        })
        expect(mockCommitLintingChanges).toHaveBeenCalledWith('/repo/demo', expect.objectContaining({
            runCommand,
            logProcessing,
            logSuccess,
            getGitStatus: expect.any(Function)
        }))
        expect(runCommand).toHaveBeenCalledWith('php', ['artisan', 'test', '--compact'], {cwd: '/repo/demo'})
        expect(logSuccess).toHaveBeenCalledWith('Local tests passed.')
    })

    it('fails early when no supported lint command exists', async () => {
        mockResolveSupportedLintCommand.mockRejectedValue(
            new Error('Release cannot run because no supported lint command was found.')
        )

        await expect(runLocalDeploymentChecks({
            rootDir: '/repo/demo',
            isLaravel: false,
            hasHook: false,
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })).rejects.toThrow('Release cannot run because no supported lint command was found.')

        expect(mockRunLinting).not.toHaveBeenCalled()
    })

    it('still fails early for unsupported checks even when a pre-push hook is present', async () => {
        mockResolveSupportedLintCommand.mockRejectedValue(
            new Error('Release cannot run because no supported lint command was found.')
        )

        await expect(runLocalDeploymentChecks({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: true,
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })).rejects.toThrow('Release cannot run because no supported lint command was found.')

        expect(mockRunLinting).not.toHaveBeenCalled()
        expect(mockCommitLintingChanges).not.toHaveBeenCalled()
    })

    it('fails early when Laravel does not support artisan test', async () => {
        const runCommandCapture = vi.fn().mockResolvedValue('migrate\nqueue:work\n')

        await expect(resolveLocalDeploymentCheckSupport({
            rootDir: '/repo/demo',
            isLaravel: true,
            runCommandCapture
        })).rejects.toThrow(
            'Release cannot run because this Laravel project does not support `php artisan test`.\n' +
            'Zephyr requires Laravel\'s built-in test command before deployment. PHPUnit-only test setups are not supported.'
        )

        expect(mockResolveSupportedLintCommand).toHaveBeenCalledWith('/repo/demo', {
            commandExists: mockCommandExists
        })
    })

    it('fails early when PHP is unavailable locally for Laravel test support', async () => {
        mockCommandExists.mockReturnValue(false)

        await expect(resolveLocalDeploymentCheckSupport({
            rootDir: '/repo/demo',
            isLaravel: true,
            runCommandCapture: vi.fn()
        })).rejects.toThrow(
            'Release cannot run because PHP is not available in PATH.\n' +
            'Zephyr requires `php artisan test --compact` for Laravel projects before deployment.'
        )
    })
})
