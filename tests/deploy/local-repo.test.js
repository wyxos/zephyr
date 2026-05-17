import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
    mockPrompt,
    mockSpawn,
    queueSpawnResponse,
    setupRuntimeTestEnv,
    teardownRuntimeTestEnv
} from '#tests/helpers/runtime-test-env.mjs'

describe('deploy/local-repo', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('preserves leading spaces in porcelain output so unstaged changes stay unstaged', async () => {
        queueSpawnResponse({stdout: ' M file.php\n'})

        const {getGitStatus} = await import('#src/deploy/local-repo.mjs')
        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommandCapture} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        const status = await getGitStatus(process.cwd(), {runCommandCapture})

        expect(status).toBe(' M file.php')
    })

    it('captures command output when capture mode is requested', async () => {
        queueSpawnResponse({stdout: 'visible output\n', stderr: 'ERROR hidden diagnostic\n'})

        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommand} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        const result = await runCommand('codex', ['exec'], {
            capture: true,
            cwd: process.cwd()
        })

        expect(result).toEqual({stdout: 'visible output', stderr: 'ERROR hidden diagnostic'})
        expect(mockSpawn.mock.calls[0][2].stdio).toEqual(['ignore', 'pipe', 'pipe'])
    })

    it('switches to the target branch when clean', async () => {
        queueSpawnResponse({stdout: 'develop\n'})
        queueSpawnResponse({stdout: ''})

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')
        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommand, runCommandCapture} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await ensureLocalRepositoryState('main', process.cwd(), {
            runPrompt: mockPrompt,
            runCommand,
            runCommandCapture,
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            logWarning: () => {
            },
            readUpstreamSyncState: async () => ({
                upstreamRef: 'origin/develop',
                remoteName: 'origin',
                upstreamBranch: 'develop',
                remoteExists: true,
                aheadCount: 0,
                behindCount: 0
            })
        })

        expect(
            mockSpawn.mock.calls.some(
                ([command, args]) => command === 'git' && args.includes('checkout') && args.includes('main')
            )
        ).toBe(true)
    })

    it('throws when attempting to switch branches with uncommitted changes', async () => {
        queueSpawnResponse({stdout: 'develop\n'})
        queueSpawnResponse({stdout: ' M file.txt\n'})

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')
        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommand, runCommandCapture} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await expect(async () => {
            await ensureLocalRepositoryState('main', process.cwd(), {
                runPrompt: mockPrompt,
                runCommand,
                runCommandCapture,
                logProcessing: () => {
                },
                logSuccess: () => {
                },
                logWarning: () => {
                },
                readUpstreamSyncState: async () => ({
                    upstreamRef: 'origin/develop',
                    remoteName: 'origin',
                    upstreamBranch: 'develop',
                    remoteExists: true,
                    aheadCount: 0,
                    behindCount: 0
                })
            })
        }).rejects.toThrow(/uncommitted changes/)
    })

    it('prompts to commit unstaged changes on the target branch', async () => {
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: ' M file.php\n'})
        queueSpawnResponse({stdout: ' M file.php\n'})
        queueSpawnResponse({})
        queueSpawnResponse({})
        queueSpawnResponse({})
        queueSpawnResponse({stdout: ''})

        mockPrompt
            .mockResolvedValueOnce({commitMessage: 'fix: align deployment dirty tree handling'})

        const ensureCommittedChangesPushed = async () => ({pushed: false, upstreamRef: 'origin/main'})
        const suggestCommitMessage = vi.fn().mockResolvedValue('fix: align deployment dirty tree handling')

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')
        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommand, runCommandCapture} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await ensureLocalRepositoryState('main', process.cwd(), {
            runPrompt: mockPrompt,
            runCommand,
            runCommandCapture,
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            logWarning: () => {
            },
            readUpstreamSyncState: async () => ({
                upstreamRef: 'origin/main',
                remoteName: 'origin',
                upstreamBranch: 'main',
                remoteExists: true,
                aheadCount: 0,
                behindCount: 0
            }),
            ensureCommittedChangesPushed,
            suggestCommitMessage
        })

        expect(mockPrompt).toHaveBeenCalledTimes(1)
        expect(mockPrompt.mock.calls[0][0][0].message).toContain('modified: file.php')
        expect(
            mockSpawn.mock.calls.some(
                ([command, args]) => command === 'git' && args[0] === 'add' && args[1] === '-A'
            )
        ).toBe(true)
        expect(
            mockSpawn.mock.calls.some(
                ([command, args]) => command === 'git' && args[0] === 'commit' && args.includes('fix: align deployment dirty tree handling')
            )
        ).toBe(true)

        const commitCall = mockSpawn.mock.calls.find(
            ([command, args]) => command === 'git' && args[0] === 'commit'
        )
        const pushCall = mockSpawn.mock.calls.find(
            ([command, args]) => command === 'git' && args[0] === 'push'
        )
        expect(commitCall?.[2]).toMatchObject({stdio: ['ignore', 'pipe', 'pipe']})
        expect(pushCall?.[2]).toMatchObject({stdio: ['ignore', 'pipe', 'pipe']})
    })

    it('commits and pushes staged changes on the target branch', async () => {
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: 'M  file.php\n'})
        queueSpawnResponse({stdout: 'M  file.php\n'})
        queueSpawnResponse({})
        queueSpawnResponse({})
        queueSpawnResponse({})

        mockPrompt
            .mockResolvedValueOnce({commitMessage: 'Prepare deployment'})
        const suggestCommitMessage = vi.fn().mockResolvedValue('fix: stage pending deployment changes')

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')
        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommand, runCommandCapture} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await ensureLocalRepositoryState('main', process.cwd(), {
            runPrompt: mockPrompt,
            runCommand,
            runCommandCapture,
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            logWarning: () => {
            },
            readUpstreamSyncState: async () => ({
                upstreamRef: 'origin/main',
                remoteName: 'origin',
                upstreamBranch: 'main',
                remoteExists: true,
                aheadCount: 0,
                behindCount: 0
            }),
            suggestCommitMessage
        })

        expect(mockPrompt).toHaveBeenCalledTimes(1)
        expect(
            mockSpawn.mock.calls.some(
                ([command, args]) => command === 'git' && args[0] === 'push' && args.includes('main')
            )
        ).toBe(true)
    })

    it('bypasses git hooks for automatic commit and push when requested', async () => {
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: 'M  file.php\n'})
        queueSpawnResponse({stdout: 'M  file.php\n'})
        queueSpawnResponse({})
        queueSpawnResponse({})
        queueSpawnResponse({})

        mockPrompt
            .mockResolvedValueOnce({commitMessage: 'Prepare deployment'})
        const suggestCommitMessage = vi.fn().mockResolvedValue('fix: stage pending deployment changes')

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')
        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommand, runCommandCapture} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await ensureLocalRepositoryState('main', process.cwd(), {
            runPrompt: mockPrompt,
            runCommand,
            runCommandCapture,
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            logWarning: () => {
            },
            skipGitHooks: true,
            readUpstreamSyncState: async () => ({
                upstreamRef: 'origin/main',
                remoteName: 'origin',
                upstreamBranch: 'main',
                remoteExists: true,
                aheadCount: 0,
                behindCount: 0
            }),
            suggestCommitMessage
        })

        expect(
            mockSpawn.mock.calls.some(
                ([command, args]) => command === 'git' && args[0] === 'commit' && args[1] === '--no-verify'
            )
        ).toBe(true)
        expect(
            mockSpawn.mock.calls.some(
                ([command, args]) => command === 'git' && args[0] === 'push' && args[1] === '--no-verify' && args.includes('main')
            )
        ).toBe(true)
    })

    it('can auto-commit dirty deploy changes without prompting for a message', async () => {
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: ' M file.php\n'})
        queueSpawnResponse({stdout: ' M file.php\n'})
        queueSpawnResponse({})
        queueSpawnResponse({})
        queueSpawnResponse({})
        queueSpawnResponse({stdout: ''})

        const suggestCommitMessage = vi.fn().mockResolvedValue('fix: align deployment dirty tree handling')

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')
        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommand, runCommandCapture} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await ensureLocalRepositoryState('main', process.cwd(), {
            runPrompt: mockPrompt,
            runCommand,
            runCommandCapture,
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            logWarning: () => {
            },
            autoCommit: true,
            readUpstreamSyncState: async () => ({
                upstreamRef: 'origin/main',
                remoteName: 'origin',
                upstreamBranch: 'main',
                remoteExists: true,
                aheadCount: 0,
                behindCount: 0
            }),
            suggestCommitMessage
        })

        expect(mockPrompt).not.toHaveBeenCalled()
        expect(
            mockSpawn.mock.calls.some(
                ([command, args]) => command === 'git' && args[0] === 'commit' && args.includes('fix: align deployment dirty tree handling')
            )
        ).toBe(true)
    })

    it('fails auto-commit mode when Codex cannot determine a usable message', async () => {
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: ' M file.php\n'})
        queueSpawnResponse({stdout: ' M file.php\n'})

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')
        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommand, runCommandCapture} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await expect(ensureLocalRepositoryState('main', process.cwd(), {
            runPrompt: mockPrompt,
            runCommand,
            runCommandCapture,
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            logWarning: () => {
            },
            autoCommit: true,
            readUpstreamSyncState: async () => ({
                upstreamRef: 'origin/main',
                remoteName: 'origin',
                upstreamBranch: 'main',
                remoteExists: true,
                aheadCount: 0,
                behindCount: 0
            }),
            suggestCommitMessage: vi.fn().mockResolvedValue(null)
        })).rejects.toThrow('Deployment auto-commit failed because Codex could not determine a usable commit message.')
    })

    it('cancels deployment commit flow when the message is left blank', async () => {
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: ' M file.php\n'})
        queueSpawnResponse({stdout: ' M file.php\n'})

        mockPrompt.mockResolvedValueOnce({commitMessage: '  '})

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')
        const {createLocalCommandRunners} = await import('#src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('#src/utils/command.mjs')
        const {runCommand, runCommandCapture} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await expect(ensureLocalRepositoryState('main', process.cwd(), {
            runPrompt: mockPrompt,
            runCommand,
            runCommandCapture,
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            logWarning: () => {
            },
            readUpstreamSyncState: async () => ({
                upstreamRef: 'origin/main',
                remoteName: 'origin',
                upstreamBranch: 'main',
                remoteExists: true,
                aheadCount: 0,
                behindCount: 0
            }),
            suggestCommitMessage: vi.fn().mockResolvedValue(null)
        })).rejects.toThrow('Deployment cancelled: pending changes were not committed.')
    })

    it('announces the pre-push hook before pushing committed changes', async () => {
        const {ensureCommittedChangesPushed} = await import('#src/deploy/local-repo.mjs')
        const logProcessing = vi.fn()
        const logSuccess = vi.fn()

        const result = await ensureCommittedChangesPushed('main', '/repo/demo', {
            runCommand: vi.fn(),
            runCommandCapture: vi.fn().mockResolvedValue(''),
            logProcessing,
            logSuccess,
            logWarning: vi.fn(),
            readUpstreamSyncState: vi.fn().mockResolvedValue({
                upstreamRef: 'origin/main',
                remoteName: 'origin',
                upstreamBranch: 'main',
                remoteExists: true,
                aheadCount: 1,
                behindCount: 0
            }),
            hasPrePushHook: vi.fn().mockResolvedValue(true)
        })

        expect(result).toEqual({pushed: true, upstreamRef: 'origin/main'})
        expect(logProcessing).toHaveBeenCalledWith('Pre-push git hook detected. Running hook during git push...')
        expect(logSuccess).toHaveBeenCalledWith('Pushed committed changes to origin/main.')
    })

    it('warns loudly and bypasses the pre-push hook when requested', async () => {
        const {ensureCommittedChangesPushed} = await import('#src/deploy/local-repo.mjs')
        const logProcessing = vi.fn()
        const logSuccess = vi.fn()
        const logWarning = vi.fn()
        const runCommandCapture = vi.fn().mockResolvedValue('')

        const result = await ensureCommittedChangesPushed('main', '/repo/demo', {
            runCommand: vi.fn(),
            runCommandCapture,
            logProcessing,
            logSuccess,
            logWarning,
            skipGitHooks: true,
            readUpstreamSyncState: vi.fn().mockResolvedValue({
                upstreamRef: 'origin/main',
                remoteName: 'origin',
                upstreamBranch: 'main',
                remoteExists: true,
                aheadCount: 1,
                behindCount: 0
            }),
            hasPrePushHook: vi.fn().mockResolvedValue(true)
        })

        expect(result).toEqual({pushed: true, upstreamRef: 'origin/main'})
        expect(logProcessing).toHaveBeenCalledWith('Found 1 commit not yet pushed to origin/main. Pushing before deployment...')
        expect(logWarning).toHaveBeenCalledWith(
            'Pre-push git hook detected, but Zephyr will bypass it because --skip-git-hooks was provided.'
        )
        expect(runCommandCapture).toHaveBeenCalledWith(
            'git',
            ['push', '--no-verify', 'origin', 'main:main'],
            {cwd: '/repo/demo'}
        )
        expect(logSuccess).toHaveBeenCalledWith('Pushed committed changes to origin/main.')
    })

    it('surfaces hook output when the pre-push hook fails during automatic push', async () => {
        const {ensureCommittedChangesPushed} = await import('#src/deploy/local-repo.mjs')
        const pushError = new Error('git push failed')
        pushError.stdout = 'hook stdout'
        pushError.stderr = 'hook stderr'

        await expect(ensureCommittedChangesPushed('main', '/repo/demo', {
            runCommand: vi.fn(),
            runCommandCapture: vi.fn().mockRejectedValue(pushError),
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            readUpstreamSyncState: vi.fn().mockResolvedValue({
                upstreamRef: 'origin/main',
                remoteName: 'origin',
                upstreamBranch: 'main',
                remoteExists: true,
                aheadCount: 1,
                behindCount: 0
            }),
            hasPrePushHook: vi.fn().mockResolvedValue(true)
        })).rejects.toThrow('Git push failed while the pre-push hook was running.\nhook stdout\nhook stderr')
    })
})
