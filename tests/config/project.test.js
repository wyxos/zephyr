import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
    mockReadFile,
    mockWriteFile,
    setupRuntimeTestEnv,
    teardownRuntimeTestEnv
} from '#tests/helpers/runtime-test-env.mjs'

describe('config/project', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('migrates legacy presets into the canonical preset format', async () => {
        mockReadFile.mockResolvedValueOnce(
            JSON.stringify({
                apps: [
                    {
                        id: 'app-1',
                        serverName: 'prod-server',
                        projectPath: '~/webapps/app',
                        branch: 'main'
                    }
                ],
                presets: [
                    {
                        name: 'production',
                        key: 'prod-server:~/webapps/app',
                        branch: 'main'
                    }
                ]
            })
        )

        const {loadProjectConfig} = await import('#src/config/project.mjs')
        const config = await loadProjectConfig(process.cwd())

        expect(config.presets).toHaveLength(1)
        expect(config.presets[0].name).toBe('production')
        expect(config.presets[0].appId).toBe('app-1')
        expect(config.presets[0].branch).toBe('main')
        expect(config.presets[0].options).toEqual({
            maintenanceMode: null,
            skipGitHooks: false,
            skipTests: false,
            skipLint: false,
            skipVersioning: false,
            autoCommit: false
        })
    })

    it('saves presets to project config with canonical options', async () => {
        mockReadFile.mockResolvedValueOnce(
            JSON.stringify({
                apps: [],
                presets: []
            })
        )

        const {loadProjectConfig, saveProjectConfig} = await import('#src/config/project.mjs')
        const config = await loadProjectConfig(process.cwd())
        config.presets.push({
            name: 'staging',
            appId: 'app-1',
            branch: 'develop',
            options: {
                maintenanceMode: true,
                skipGitHooks: true,
                skipTests: false,
                skipLint: true,
                skipVersioning: false,
                autoCommit: true
            }
        })

        await saveProjectConfig(process.cwd(), config)

        const [writePath, payload] = mockWriteFile.mock.calls.at(-1)
        expect(writePath.replace(/\\/g, '/')).toContain('.zephyr/config.json')
        const saved = JSON.parse(payload)
        expect(saved.presets).toHaveLength(1)
        expect(saved.presets[0].name).toBe('staging')
        expect(saved.presets[0].appId).toBe('app-1')
        expect(saved.presets[0].branch).toBe('develop')
        expect(saved.presets[0].options).toEqual({
            maintenanceMode: true,
            skipGitHooks: true,
            skipTests: false,
            skipLint: true,
            skipVersioning: false,
            autoCommit: true
        })
    })

    it('removes a preset from project config when requested', async () => {
        const {removePreset} = await import('#src/config/project.mjs')

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

    it('fails in strict mode when the project config file is missing', async () => {
        const missingError = new Error('ENOENT')
        missingError.code = 'ENOENT'
        mockReadFile.mockRejectedValueOnce(missingError)

        const {loadProjectConfig} = await import('#src/config/project.mjs')

        await expect(loadProjectConfig(process.cwd(), [], {
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            strict: true,
            allowMigration: false
        })).rejects.toMatchObject({
            code: 'ZEPHYR_PROJECT_CONFIG_MISSING'
        })
    })
})
