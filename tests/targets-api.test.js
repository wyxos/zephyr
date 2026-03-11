import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    mockCreateAppContext,
    mockCreateConfigurationService,
    mockSelectDeploymentTargetImpl
} = vi.hoisted(() => ({
    mockCreateAppContext: vi.fn(),
    mockCreateConfigurationService: vi.fn(),
    mockSelectDeploymentTargetImpl: vi.fn()
}))

vi.mock('../src/runtime/app-context.mjs', () => ({
    createAppContext: mockCreateAppContext
}))

vi.mock('../src/application/configuration/service.mjs', () => ({
    createConfigurationService: mockCreateConfigurationService
}))

vi.mock('../src/application/configuration/select-deployment-target.mjs', () => ({
    selectDeploymentTarget: mockSelectDeploymentTargetImpl
}))

describe('targets public API', () => {
    const appContext = {
        logSuccess: vi.fn(),
        logWarning: vi.fn(),
        logProcessing: vi.fn(),
        runPrompt: vi.fn()
    }
    const configurationService = {name: 'configuration-service'}

    beforeEach(() => {
        vi.resetModules()
        mockCreateAppContext.mockReset()
        mockCreateConfigurationService.mockReset()
        mockSelectDeploymentTargetImpl.mockReset()

        appContext.logSuccess.mockReset()
        appContext.logWarning.mockReset()
        appContext.logProcessing.mockReset()
        appContext.runPrompt.mockReset()

        mockCreateAppContext.mockReturnValue(appContext)
        mockCreateConfigurationService.mockReturnValue(configurationService)
    })

    it('binds app context and configuration service into the public target selector', async () => {
        const selection = {
            deploymentConfig: {serverName: 'production'},
            projectConfig: {apps: [], presets: []}
        }

        mockSelectDeploymentTargetImpl.mockResolvedValue(selection)

        const {selectDeploymentTarget} = await import('../src/targets/index.mjs')
        const result = await selectDeploymentTarget({rootDir: '/workspace/project'})

        expect(result).toBe(selection)
        expect(mockCreateConfigurationService).toHaveBeenCalledWith(appContext)
        expect(mockSelectDeploymentTargetImpl).toHaveBeenCalledWith('/workspace/project', {
            configurationService,
            runPrompt: appContext.runPrompt,
            logProcessing: appContext.logProcessing,
            logSuccess: appContext.logSuccess,
            logWarning: appContext.logWarning
        })
    })
})
