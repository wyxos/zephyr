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
})
