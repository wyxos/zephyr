import {beforeEach, describe, expect, it, vi} from 'vitest'

const mockLoadPendingTasksSnapshot = vi.fn()
const mockClearPendingTasksSnapshot = vi.fn()

vi.mock('#src/deploy/snapshots.mjs', () => ({
    loadPendingTasksSnapshot: mockLoadPendingTasksSnapshot,
    clearPendingTasksSnapshot: mockClearPendingTasksSnapshot
}))

describe('resolvePendingSnapshot', () => {
    beforeEach(() => {
        vi.resetModules()
        mockLoadPendingTasksSnapshot.mockReset()
        mockClearPendingTasksSnapshot.mockReset()
    })

    it('returns the existing snapshot when the user chooses to resume', async () => {
        const snapshot = {
            serverName: 'production',
            branch: 'main',
            taskLabels: ['Pull latest changes for main']
        }
        mockLoadPendingTasksSnapshot.mockResolvedValue(snapshot)

        const runPrompt = vi.fn().mockResolvedValue({resumePendingTasks: true})
        const logProcessing = vi.fn()

        const {resolvePendingSnapshot} = await import('#src/application/deploy/resolve-pending-snapshot.mjs')

        const result = await resolvePendingSnapshot('/workspace/project', {
            serverName: 'production',
            branch: 'main'
        }, {
            runPrompt,
            logProcessing,
            logWarning: vi.fn()
        })

        expect(result).toBe(snapshot)
        expect(mockClearPendingTasksSnapshot).not.toHaveBeenCalled()
        expect(logProcessing).toHaveBeenCalledWith('Resuming deployment using saved task snapshot...')
        expect(runPrompt).toHaveBeenCalledWith([
            expect.objectContaining({
                default: true,
                message: expect.stringContaining('Tasks: Pull latest changes for main')
            })
        ])
    })

    it('clears the existing snapshot when the user declines to resume', async () => {
        mockLoadPendingTasksSnapshot.mockResolvedValue({
            serverName: 'production',
            branch: 'main',
            taskLabels: ['Pull latest changes for main']
        })

        const runPrompt = vi.fn().mockResolvedValue({resumePendingTasks: false})
        const logWarning = vi.fn()

        const {resolvePendingSnapshot} = await import('#src/application/deploy/resolve-pending-snapshot.mjs')

        const result = await resolvePendingSnapshot('/workspace/project', {
            serverName: 'production',
            branch: 'main'
        }, {
            runPrompt,
            logProcessing: vi.fn(),
            logWarning
        })

        expect(result).toBeNull()
        expect(mockClearPendingTasksSnapshot).toHaveBeenCalledWith('/workspace/project')
        expect(logWarning).toHaveBeenCalledWith('Discarded pending deployment snapshot.')
    })

    it('returns null without prompting when no snapshot exists', async () => {
        mockLoadPendingTasksSnapshot.mockResolvedValue(null)

        const runPrompt = vi.fn()

        const {resolvePendingSnapshot} = await import('#src/application/deploy/resolve-pending-snapshot.mjs')

        const result = await resolvePendingSnapshot('/workspace/project', {
            serverName: 'production',
            branch: 'main'
        }, {
            runPrompt,
            logProcessing: vi.fn(),
            logWarning: vi.fn()
        })

        expect(result).toBeNull()
        expect(runPrompt).not.toHaveBeenCalled()
        expect(mockClearPendingTasksSnapshot).not.toHaveBeenCalled()
    })

    it('defaults the resume prompt to false when the saved snapshot does not match the selected target', async () => {
        mockLoadPendingTasksSnapshot.mockResolvedValue({
            serverName: 'staging',
            branch: 'develop',
            taskLabels: ['Pull latest changes for develop']
        })

        const runPrompt = vi.fn().mockResolvedValue({resumePendingTasks: false})

        const {resolvePendingSnapshot} = await import('#src/application/deploy/resolve-pending-snapshot.mjs')

        await resolvePendingSnapshot('/workspace/project', {
            serverName: 'production',
            branch: 'main'
        }, {
            runPrompt,
            logProcessing: vi.fn(),
            logWarning: vi.fn()
        })

        expect(runPrompt).toHaveBeenCalledWith([
            expect.objectContaining({
                default: false,
                message: expect.stringContaining('Server: staging')
            })
        ])
    })
})
