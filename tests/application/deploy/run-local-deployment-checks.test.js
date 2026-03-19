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

    it('runs manual checks when a pre-push hook is present and hook skipping is enabled', async () => {
        const logWarning = vi.fn()
        const runCommand = vi.fn()
        const runCommandCapture = vi.fn().mockResolvedValue('test\nqueue:work\n')

        await runLocalDeploymentChecks({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: true,
            skipGitHooks: true,
            runCommand,
            runCommandCapture,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning
        })

        expect(logWarning).toHaveBeenCalledWith(
            'Pre-push git hook detected. Zephyr will run its built-in release checks manually because --skip-git-hooks is enabled, and the hook will be bypassed during git push.'
        )
        expect(mockRunLinting).toHaveBeenCalledWith('/repo/demo', expect.objectContaining({
            runCommand,
            logProcessing: expect.any(Function),
            logSuccess: expect.any(Function),
            logWarning,
            commandExists: mockCommandExists,
            lintCommand: expect.objectContaining({
                type: 'npm',
                command: 'npm',
                args: ['run', 'lint']
            })
        }))
        expect(mockCommitLintingChanges).not.toHaveBeenCalled()
        expect(runCommand).toHaveBeenCalledWith('php', ['artisan', 'test', '--compact'], {cwd: '/repo/demo'})
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
            getGitStatus: expect.any(Function),
            skipGitHooks: false
        }))
        expect(runCommand).toHaveBeenCalledWith('php', ['artisan', 'test', '--compact'], {cwd: '/repo/demo'})
        expect(logSuccess).toHaveBeenCalledWith('Local tests passed.')
    })

    it('skips linting when no supported lint command exists', async () => {
        mockResolveSupportedLintCommand.mockRejectedValue(
            Object.assign(
                new Error('Release cannot run because no supported lint command was found.'),
                {code: 'ZEPHYR_LINT_COMMAND_NOT_FOUND'}
            )
        )

        const runCommand = vi.fn()
        const runCommandCapture = vi.fn().mockResolvedValue('test\nqueue:work\n')
        const logWarning = vi.fn()

        await runLocalDeploymentChecks({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: false,
            runCommand,
            runCommandCapture,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning
        })

        expect(logWarning).toHaveBeenCalledWith('No supported lint command was found. Skipping linting checks.')
        expect(mockRunLinting).not.toHaveBeenCalled()
        expect(mockCommitLintingChanges).not.toHaveBeenCalled()
        expect(runCommand).toHaveBeenCalledWith('php', ['artisan', 'test', '--compact'], {cwd: '/repo/demo'})
    })

    it('returns early for hook-managed releases even when lint support is unavailable', async () => {
        mockResolveSupportedLintCommand.mockRejectedValue(
            Object.assign(
                new Error('Release cannot run because no supported lint command was found.'),
                {code: 'ZEPHYR_LINT_COMMAND_NOT_FOUND'}
            )
        )

        const logProcessing = vi.fn()

        await runLocalDeploymentChecks({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: true,
            runCommand: vi.fn(),
            runCommandCapture: vi.fn().mockResolvedValue('test\nqueue:work\n'),
            logProcessing,
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(mockRunLinting).not.toHaveBeenCalled()
        expect(mockCommitLintingChanges).not.toHaveBeenCalled()
        expect(logProcessing).toHaveBeenCalledWith(
            'Pre-push git hook detected. Built-in release checks are supported, but Zephyr will skip executing them here. If Zephyr pushes local commits during this release, the hook will run during git push.'
        )
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

    it('treats missing lint support as optional and still resolves Laravel tests', async () => {
        mockResolveSupportedLintCommand.mockRejectedValue(
            Object.assign(
                new Error('Release cannot run because no supported lint command was found.'),
                {code: 'ZEPHYR_LINT_COMMAND_NOT_FOUND'}
            )
        )

        await expect(resolveLocalDeploymentCheckSupport({
            rootDir: '/repo/demo',
            isLaravel: true,
            runCommandCapture: vi.fn().mockResolvedValue('test\nqueue:work\n')
        })).resolves.toEqual({
            lintCommand: null,
            testCommand: {
                command: 'php',
                args: ['artisan', 'test', '--compact']
            }
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
