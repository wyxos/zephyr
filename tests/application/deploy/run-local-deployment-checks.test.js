import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    mockCommandExists,
    mockCommitLintingChanges,
    mockGetGitStatus,
    mockHasUncommittedChanges,
    mockRunLinting
} = vi.hoisted(() => ({
    mockCommandExists: vi.fn(),
    mockCommitLintingChanges: vi.fn(),
    mockGetGitStatus: vi.fn(),
    mockHasUncommittedChanges: vi.fn(),
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
    runLinting: mockRunLinting
}))

import {runLocalDeploymentChecks} from '#src/application/deploy/run-local-deployment-checks.mjs'

describe('application/deploy/run-local-deployment-checks', () => {
    beforeEach(() => {
        mockCommandExists.mockReset()
        mockCommitLintingChanges.mockReset()
        mockGetGitStatus.mockReset()
        mockHasUncommittedChanges.mockReset()
        mockRunLinting.mockReset()

        mockCommandExists.mockImplementation((command) => command === 'php')
        mockCommitLintingChanges.mockResolvedValue(undefined)
        mockGetGitStatus.mockResolvedValue(' M package.json')
        mockHasUncommittedChanges.mockResolvedValue(false)
        mockRunLinting.mockResolvedValue(false)
    })

    it('skips linting and tests when a pre-push hook is present', async () => {
        const logProcessing = vi.fn()

        await runLocalDeploymentChecks({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: true,
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            logProcessing,
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(mockRunLinting).not.toHaveBeenCalled()
        expect(mockCommitLintingChanges).not.toHaveBeenCalled()
        expect(logProcessing).toHaveBeenCalledWith('Pre-push git hook detected. Skipping local linting and test execution.')
    })

    it('commits lint changes and runs local Laravel tests when needed', async () => {
        mockRunLinting.mockResolvedValue(true)
        mockHasUncommittedChanges.mockResolvedValue(true)

        const runCommand = vi.fn()
        const runCommandCapture = vi.fn()
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
            commandExists: mockCommandExists
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

    it('warns and skips Laravel tests when PHP is unavailable locally', async () => {
        mockCommandExists.mockReturnValue(false)

        const logWarning = vi.fn()

        await runLocalDeploymentChecks({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: false,
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning
        })

        expect(logWarning).toHaveBeenCalledWith(
            'PHP is not available in PATH. Skipping local Laravel tests.\n' +
            '  To run tests locally, ensure PHP is installed and added to your PATH.\n' +
            '  On Windows with Laravel Herd, you may need to add Herd\'s PHP to your system PATH.'
        )
    })
})
