import {readFile} from 'node:fs/promises'

import {describe, it, expect} from 'vitest'

describe('public API', () => {
    it('declares only the intended public package exports', async () => {
        const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

        expect(packageJson.exports).toEqual({
            '.': './src/index.mjs',
            './targets': './src/targets/index.mjs',
            './ssh': './src/ssh/index.mjs'
        })
        expect(packageJson.scripts.lint).toBe('eslint . --fix')
    })

    it('exports the runtime helpers Flux relies on from the root package', async () => {
        const api = await import('@wyxos/zephyr')

        expect(typeof api.logSuccess).toBe('function')
        expect(typeof api.logWarning).toBe('function')
        expect(typeof api.logError).toBe('function')
        expect(typeof api.logProcessing).toBe('function')

        expect(typeof api.runCommand).toBe('function')
        expect(typeof api.runCommandCapture).toBe('function')
        expect(typeof api.writeToLogFile).toBe('function')

        expect(api.createSshClient).toBeUndefined()
        expect(api.main).toBeUndefined()
        expect(api.runRemoteTasks).toBeUndefined()
        expect(api.connectToServer).toBeUndefined()
        expect(api.executeRemoteCommand).toBeUndefined()
        expect(api.readRemoteFile).toBeUndefined()
        expect(api.downloadRemoteFile).toBeUndefined()
        expect(api.deleteRemoteFile).toBeUndefined()
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

    it('exports SSH helpers from the ssh subpath', async () => {
        const api = await import('@wyxos/zephyr/ssh')

        expect(typeof api.connectToServer).toBe('function')
        expect(typeof api.executeRemoteCommand).toBe('function')
        expect(typeof api.readRemoteFile).toBe('function')
        expect(typeof api.downloadRemoteFile).toBe('function')
        expect(typeof api.deleteRemoteFile).toBe('function')
    }, 15000)
})
