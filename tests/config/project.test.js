import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
    mockReadFile,
    mockWriteFile,
    setupRuntimeTestEnv,
    teardownRuntimeTestEnv
} from '../helpers/runtime-test-env.mjs'

describe('config/project', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('loads presets from project config', async () => {
        mockReadFile.mockResolvedValueOnce(
            JSON.stringify({
                apps: [],
                presets: [
                    {
                        name: 'production',
                        key: 'prod-server:~/webapps/app',
                        branch: 'main'
                    }
                ]
            })
        )

        const {loadProjectConfig} = await import('../../src/config/project.mjs')
        const config = await loadProjectConfig(process.cwd())

        expect(config.presets).toHaveLength(1)
        expect(config.presets[0].name).toBe('production')
        expect(config.presets[0].key).toBe('prod-server:~/webapps/app')
        expect(config.presets[0].branch).toBe('main')
    })

    it('saves presets to project config with unique key', async () => {
        mockReadFile.mockResolvedValueOnce(
            JSON.stringify({
                apps: [],
                presets: []
            })
        )

        const {loadProjectConfig, saveProjectConfig} = await import('../../src/config/project.mjs')
        const config = await loadProjectConfig(process.cwd())
        config.presets.push({
            name: 'staging',
            key: 'staging-server:~/webapps/staging',
            branch: 'develop'
        })

        await saveProjectConfig(process.cwd(), config)

        const [writePath, payload] = mockWriteFile.mock.calls.at(-1)
        expect(writePath.replace(/\\/g, '/')).toContain('.zephyr/config.json')
        const saved = JSON.parse(payload)
        expect(saved.presets).toHaveLength(1)
        expect(saved.presets[0].name).toBe('staging')
        expect(saved.presets[0].key).toBe('staging-server:~/webapps/staging')
        expect(saved.presets[0].branch).toBe('develop')
        expect(saved.presets[0].serverName).toBeUndefined()
        expect(saved.presets[0].projectPath).toBeUndefined()
    })

    it('removes a preset from project config when requested', async () => {
        const {removePreset} = await import('../../src/config/project.mjs')

        const presetToRemove = {
            name: 'legacy-invalid',
            serverName: 'old-server',
            projectPath: '~/webapps/old-app'
        }
        const config = {
            apps: [],
            presets: [
                presetToRemove,
                {
                    name: 'valid',
                    appId: 'app-1',
                    branch: 'main'
                }
            ]
        }

        const removed = removePreset(config, presetToRemove)

        expect(removed).toBe(presetToRemove)
        expect(config.presets).toHaveLength(1)
        expect(config.presets[0].name).toBe('valid')
    })
})
