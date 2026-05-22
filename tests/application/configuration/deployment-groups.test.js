import {beforeEach, describe, expect, it, vi} from 'vitest'

const mockLoadProjectConfig = vi.fn()
const mockLoadServers = vi.fn()

vi.mock('#src/config/project.mjs', () => ({
    loadProjectConfig: mockLoadProjectConfig
}))

vi.mock('#src/config/servers.mjs', () => ({
    loadServers: mockLoadServers
}))

describe('application/configuration/deployment-groups', () => {
    beforeEach(() => {
        vi.resetModules()
        mockLoadProjectConfig.mockReset()
        mockLoadServers.mockReset()
        mockLoadServers.mockResolvedValue([])
    })

    it('resolves a named deployment group to configured preset names', async () => {
        mockLoadProjectConfig.mockResolvedValue({
            presets: [
                {name: 'Development v1'},
                {name: 'Development v2'}
            ],
            groups: [
                {
                    name: 'Development v1-v2',
                    presets: ['Development v1', 'Development v2']
                }
            ]
        })

        const {resolveDeploymentGroup} = await import('#src/application/configuration/deployment-groups.mjs')
        const group = await resolveDeploymentGroup('/workspace/project', {
            groupName: 'Development v1-v2',
            strict: true,
            allowMigration: false
        })

        expect(group).toEqual({
            name: 'Development v1-v2',
            presetNames: ['Development v1', 'Development v2']
        })
        expect(mockLoadServers).toHaveBeenCalledWith(expect.objectContaining({
            strict: true,
            allowMigration: false
        }))
        expect(mockLoadProjectConfig).toHaveBeenCalledWith('/workspace/project', [], expect.objectContaining({
            strict: true,
            allowMigration: false
        }))
    })

    it('fails when a deployment group references a missing preset', async () => {
        mockLoadProjectConfig.mockResolvedValue({
            presets: [{name: 'Development v1'}],
            groups: [
                {
                    name: 'Development v1-v2',
                    presets: ['Development v1', 'Development v2']
                }
            ]
        })

        const {resolveDeploymentGroup} = await import('#src/application/configuration/deployment-groups.mjs')

        await expect(resolveDeploymentGroup('/workspace/project', {
            groupName: 'Development v1-v2'
        })).rejects.toMatchObject({
            code: 'ZEPHYR_DEPLOYMENT_GROUP_INVALID'
        })
    })
})
