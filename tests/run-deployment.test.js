import {describe, expect, it, vi} from 'vitest'

import {createAbnormalExitGuard, maybeRecoverLaravelMaintenanceMode} from '#src/application/deploy/run-deployment.mjs'

function createFakeProcess() {
    const listeners = new Map()

    return {
        pid: 4242,
        exitCode: null,
        once: vi.fn((signal, handler) => {
            listeners.set(signal, handler)
        }),
        off: vi.fn((signal, handler) => {
            if (listeners.get(signal) === handler) {
                listeners.delete(signal)
            }
        }),
        kill: vi.fn(),
        emit(signal) {
            listeners.get(signal)?.()
        }
    }
}

describe('runDeployment helpers', () => {
    it('auto-recovers Laravel maintenance mode when forced during abnormal exit handling', async () => {
        const executeRemote = vi.fn().mockResolvedValue(undefined)
        const executionState = {
            enteredMaintenanceMode: true,
            exitedMaintenanceMode: false
        }

        await maybeRecoverLaravelMaintenanceMode({
            remotePlan: {
                remoteIsLaravel: true,
                maintenanceModeEnabled: true,
                maintenanceUpCommand: 'php artisan up'
            },
            executionState,
            executeRemote,
            logProcessing: vi.fn(),
            logWarning: vi.fn(),
            forceAutoRecovery: true,
            reason: 'SIGTERM'
        })

        expect(executeRemote).toHaveBeenCalledWith('Disable Laravel maintenance mode', 'php artisan up')
        expect(executionState.exitedMaintenanceMode).toBe(true)
    })

    it('runs abnormal-exit cleanup once and re-emits the terminating signal', async () => {
        const fakeProcess = createFakeProcess()
        const cleanup = vi.fn().mockResolvedValue(undefined)
        const terminate = vi.fn().mockResolvedValue(undefined)
        const guard = createAbnormalExitGuard({
            processRef: fakeProcess,
            cleanup,
            terminate,
            logWarning: vi.fn()
        })

        expect(fakeProcess.once).toHaveBeenCalledTimes(3)

        await guard.run('SIGTERM')
        await guard.run('SIGTERM')

        expect(cleanup).toHaveBeenCalledTimes(1)
        expect(cleanup).toHaveBeenCalledWith('SIGTERM')
        expect(terminate).toHaveBeenCalledTimes(1)
        expect(terminate).toHaveBeenCalledWith('SIGTERM')
        expect(fakeProcess.off).toHaveBeenCalledTimes(3)
    })
})
