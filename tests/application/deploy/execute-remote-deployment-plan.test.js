import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    mockClearPendingTasksSnapshot,
    mockSavePendingTasksSnapshot
} = vi.hoisted(() => ({
    mockClearPendingTasksSnapshot: vi.fn(),
    mockSavePendingTasksSnapshot: vi.fn()
}))

vi.mock('../../../src/deploy/snapshots.mjs', () => ({
    clearPendingTasksSnapshot: mockClearPendingTasksSnapshot,
    savePendingTasksSnapshot: mockSavePendingTasksSnapshot
}))

import {executeRemoteDeploymentPlan} from '../../../src/application/deploy/execute-remote-deployment-plan.mjs'

describe('application/deploy/execute-remote-deployment-plan', () => {
    beforeEach(() => {
        mockClearPendingTasksSnapshot.mockReset()
        mockSavePendingTasksSnapshot.mockReset()
        mockClearPendingTasksSnapshot.mockResolvedValue(undefined)
        mockSavePendingTasksSnapshot.mockResolvedValue(undefined)
    })

    it('persists and clears pending snapshots around a useful remote plan', async () => {
        const executeRemote = vi.fn(async () => ({stdout: ''}))
        const pendingSnapshot = {
            serverName: 'production',
            branch: 'main',
            projectPath: '~/webapps/demo',
            changedFiles: ['composer.json'],
            taskLabels: ['Pull latest changes for main', 'Install Composer dependencies']
        }

        await executeRemoteDeploymentPlan({
            rootDir: '/workspace/demo',
            executeRemote,
            steps: [
                {label: 'Pull latest changes for main', command: 'git pull origin main'},
                {label: 'Install Composer dependencies', command: 'composer install'}
            ],
            usefulSteps: true,
            pendingSnapshot,
            logProcessing: vi.fn()
        })

        expect(mockSavePendingTasksSnapshot).toHaveBeenCalledWith('/workspace/demo', pendingSnapshot)
        expect(executeRemote.mock.calls[0][0]).toBe('Record pending deployment tasks')
        expect(executeRemote.mock.calls[1]).toEqual(['Pull latest changes for main', 'git pull origin main'])
        expect(executeRemote.mock.calls[2]).toEqual(['Install Composer dependencies', 'composer install'])
        expect(executeRemote.mock.calls[3]).toEqual([
            'Clear pending deployment snapshot',
            'rm -f .zephyr/pending-tasks.json',
            {printStdout: false, allowFailure: true}
        ])
        expect(mockClearPendingTasksSnapshot).toHaveBeenCalledWith('/workspace/demo')
    })

    it('runs a simple plan without snapshot persistence when no extra maintenance tasks exist', async () => {
        const executeRemote = vi.fn(async () => ({stdout: ''}))

        await executeRemoteDeploymentPlan({
            rootDir: '/workspace/demo',
            executeRemote,
            steps: [
                {label: 'Pull latest changes for main', command: 'git pull origin main'}
            ],
            usefulSteps: false,
            pendingSnapshot: null,
            logProcessing: vi.fn()
        })

        expect(mockSavePendingTasksSnapshot).not.toHaveBeenCalled()
        expect(mockClearPendingTasksSnapshot).not.toHaveBeenCalled()
        expect(executeRemote).toHaveBeenCalledTimes(1)
        expect(executeRemote).toHaveBeenCalledWith('Pull latest changes for main', 'git pull origin main')
    })
})
