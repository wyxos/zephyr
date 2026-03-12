import {afterEach, beforeEach, describe, expect, it} from 'vitest'

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

    it('commits and pushes pending changes on the target branch', async () => {
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: ' M file.php\n'})
        queueSpawnResponse({})
        queueSpawnResponse({})

        mockPrompt.mockResolvedValueOnce({commitMessage: 'Prepare deployment'})

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
            })
        })

        expect(mockPrompt).toHaveBeenCalledTimes(1)
        expect(
            mockSpawn.mock.calls.some(
                ([command, args]) => command === 'git' && args[0] === 'commit'
            )
        ).toBe(true)
        expect(
            mockSpawn.mock.calls.some(
                ([command, args]) => command === 'git' && args[0] === 'push' && args.includes('main')
            )
        ).toBe(true)
    })
})
