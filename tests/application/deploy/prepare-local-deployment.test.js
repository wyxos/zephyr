import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    mockBumpLocalPackageVersion,
    mockEnsureLocalRepositoryState,
    mockResolveLocalDeploymentCheckSupport,
    mockResolveLocalDeploymentContext,
    mockRunLocalDeploymentChecks
} = vi.hoisted(() => ({
    mockBumpLocalPackageVersion: vi.fn(),
    mockEnsureLocalRepositoryState: vi.fn(),
    mockResolveLocalDeploymentCheckSupport: vi.fn(),
    mockResolveLocalDeploymentContext: vi.fn(),
    mockRunLocalDeploymentChecks: vi.fn()
}))

vi.mock('#src/deploy/local-repo.mjs', () => ({
    ensureLocalRepositoryState: mockEnsureLocalRepositoryState
}))

vi.mock('#src/application/deploy/bump-local-package-version.mjs', () => ({
    bumpLocalPackageVersion: mockBumpLocalPackageVersion
}))

vi.mock('#src/application/deploy/resolve-local-deployment-context.mjs', () => ({
    resolveLocalDeploymentContext: mockResolveLocalDeploymentContext
}))

vi.mock('#src/application/deploy/run-local-deployment-checks.mjs', () => ({
    resolveLocalDeploymentCheckSupport: mockResolveLocalDeploymentCheckSupport,
    runLocalDeploymentChecks: mockRunLocalDeploymentChecks
}))

import {prepareLocalDeployment} from '#src/application/deploy/prepare-local-deployment.mjs'

describe('application/deploy/prepare-local-deployment', () => {
    beforeEach(() => {
        mockBumpLocalPackageVersion.mockReset()
        mockEnsureLocalRepositoryState.mockReset()
        mockResolveLocalDeploymentCheckSupport.mockReset()
        mockResolveLocalDeploymentContext.mockReset()
        mockRunLocalDeploymentChecks.mockReset()

        mockBumpLocalPackageVersion.mockResolvedValue(undefined)
        mockEnsureLocalRepositoryState.mockResolvedValue(undefined)
        mockResolveLocalDeploymentCheckSupport.mockResolvedValue({
            lintCommand: {
                type: 'npm',
                command: 'npm',
                args: ['run', 'lint'],
                label: 'npm lint'
            },
            testCommand: {
                command: 'php',
                args: ['artisan', 'test', '--compact']
            }
        })
        mockResolveLocalDeploymentContext.mockResolvedValue({
            requiredPhpVersion: '8.4.0',
            isLaravel: true,
            hasHook: false
        })
        mockRunLocalDeploymentChecks.mockResolvedValue(undefined)
    })

    it('bumps version and delegates local checks for fresh Laravel deployments', async () => {
        const runCommand = vi.fn()
        const runCommandCapture = vi.fn()
        const runPrompt = vi.fn()
        const logProcessing = vi.fn()
        const logSuccess = vi.fn()
        const logWarning = vi.fn()

        const result = await prepareLocalDeployment({
            branch: 'main'
        }, {
            rootDir: '/repo/demo',
            runPrompt,
            runCommand,
            runCommandCapture,
            logProcessing,
            logSuccess,
            logWarning
        })

        expect(result).toEqual({
            requiredPhpVersion: '8.4.0',
            isLaravel: true,
            hasHook: false
        })
        expect(mockResolveLocalDeploymentContext).toHaveBeenCalledWith('/repo/demo')
        expect(mockResolveLocalDeploymentCheckSupport).toHaveBeenCalledWith({
            rootDir: '/repo/demo',
            isLaravel: true,
            runCommandCapture
        })
        expect(mockBumpLocalPackageVersion).toHaveBeenCalledWith('/repo/demo', {
            versionArg: null,
            skipGitHooks: false,
            runCommand,
            logProcessing,
            logSuccess,
            logWarning
        })
        expect(mockEnsureLocalRepositoryState).toHaveBeenCalledWith('main', '/repo/demo', expect.objectContaining({
            runPrompt,
            runCommand,
            runCommandCapture,
            logProcessing,
            logSuccess,
            logWarning
        }))
        expect(mockRunLocalDeploymentChecks).toHaveBeenCalledWith(expect.objectContaining({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: false,
            skipGitHooks: false,
            runCommand,
            runCommandCapture,
            logProcessing,
            logSuccess,
            logWarning,
            lintCommand: expect.objectContaining({
                type: 'npm',
                command: 'npm',
                args: ['run', 'lint']
            }),
            testCommand: expect.objectContaining({
                command: 'php',
                args: ['artisan', 'test', '--compact']
            })
        }))
    })

    it('skips version bump when resuming from a snapshot', async () => {
        const runCommand = vi.fn()
        const runCommandCapture = vi.fn()

        const result = await prepareLocalDeployment({
            branch: 'main'
        }, {
            snapshot: {changedFiles: ['composer.json']},
            rootDir: '/repo/demo',
            runPrompt: vi.fn(),
            runCommand,
            runCommandCapture,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(result).toEqual({
            requiredPhpVersion: '8.4.0',
            isLaravel: true,
            hasHook: false
        })
        expect(mockBumpLocalPackageVersion).not.toHaveBeenCalled()
        expect(mockResolveLocalDeploymentCheckSupport).toHaveBeenCalled()
        expect(mockRunLocalDeploymentChecks).toHaveBeenCalledWith(expect.objectContaining({
            rootDir: '/repo/demo',
            isLaravel: true,
            hasHook: false,
            runCommand,
            runCommandCapture
        }))
    })

    it('skips version bump for non-Laravel projects', async () => {
        mockResolveLocalDeploymentContext.mockResolvedValue({
            requiredPhpVersion: null,
            isLaravel: false,
            hasHook: false
        })

        const result = await prepareLocalDeployment({
            branch: 'main'
        }, {
            rootDir: '/repo/demo',
            runPrompt: vi.fn(),
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(result).toEqual({
            requiredPhpVersion: null,
            isLaravel: false,
            hasHook: false
        })
        expect(mockBumpLocalPackageVersion).not.toHaveBeenCalled()
        expect(mockRunLocalDeploymentChecks).toHaveBeenCalledWith(expect.objectContaining({
            isLaravel: false
        }))
    })

    it('continues when lint support is unavailable', async () => {
        mockResolveLocalDeploymentCheckSupport.mockResolvedValue({
            lintCommand: null,
            testCommand: {
                command: 'php',
                args: ['artisan', 'test', '--compact']
            }
        })

        const result = await prepareLocalDeployment({
            branch: 'main'
        }, {
            rootDir: '/repo/demo',
            runPrompt: vi.fn(),
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })

        expect(result).toEqual({
            requiredPhpVersion: '8.4.0',
            isLaravel: true,
            hasHook: false
        })
        expect(mockBumpLocalPackageVersion).toHaveBeenCalled()
        expect(mockEnsureLocalRepositoryState).toHaveBeenCalled()
        expect(mockRunLocalDeploymentChecks).toHaveBeenCalledWith(expect.objectContaining({
            lintCommand: null,
            testCommand: expect.objectContaining({
                command: 'php',
                args: ['artisan', 'test', '--compact']
            })
        }))
    })
})
