import {describe, it, expect} from 'vitest'

describe('public API', () => {
    it('exports the runtime helpers Flux relies on from the root package', async () => {
        const api = await import('@wyxos/zephyr')

        expect(typeof api.logSuccess).toBe('function')
        expect(typeof api.logWarning).toBe('function')
        expect(typeof api.logError).toBe('function')
        expect(typeof api.logProcessing).toBe('function')

        expect(typeof api.runCommand).toBe('function')
        expect(typeof api.runCommandCapture).toBe('function')
        expect(typeof api.writeToLogFile).toBe('function')

        expect(api.loadServers).toBeUndefined()
        expect(api.loadProjectConfig).toBeUndefined()
        expect(api.selectPreset).toBeUndefined()
        expect(api.selectServer).toBeUndefined()
        expect(api.selectApp).toBeUndefined()
    }, 15000)

    it('exports deployment target helpers from the targets subpath', async () => {
        const api = await import('@wyxos/zephyr/targets')

        expect(typeof api.selectDeploymentTarget).toBe('function')
        expect(api.loadDeploymentContext).toBeUndefined()
    }, 15000)
})
