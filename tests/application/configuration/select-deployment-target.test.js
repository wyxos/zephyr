import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoadServers = vi.fn()
const mockLoadProjectConfig = vi.fn()
const mockRemovePreset = vi.fn()
const mockSaveProjectConfig = vi.fn()
const mockWriteStdoutLine = vi.fn()

vi.mock('#src/config/servers.mjs', () => ({
  loadServers: mockLoadServers
}))

vi.mock('#src/config/project.mjs', () => ({
  loadProjectConfig: mockLoadProjectConfig,
  removePreset: mockRemovePreset,
  saveProjectConfig: mockSaveProjectConfig
}))

vi.mock('#src/utils/output.mjs', () => ({
  writeStdoutLine: mockWriteStdoutLine
}))

function createSelectionScenario() {
  const projectConfig = { apps: [], presets: [] }
  const server = { serverName: 'production', serverIp: '203.0.113.10' }
  const appConfig = {
    id: 'app-1',
    projectPath: '~/webapps/demo',
    branch: 'main',
    sshUser: 'forge',
    sshKey: '~/.ssh/id_rsa'
  }

  const configurationService = {
    selectPreset: vi.fn().mockResolvedValue(null),
    selectServer: vi.fn().mockResolvedValue(server),
    selectApp: vi.fn().mockResolvedValue(appConfig),
    ensureSshDetails: vi.fn().mockResolvedValue(false)
  }

  return { projectConfig, server, appConfig, configurationService }
}

describe('selectDeploymentTarget', () => {
  beforeEach(() => {
    vi.resetModules()
    mockLoadServers.mockReset()
    mockLoadProjectConfig.mockReset()
    mockRemovePreset.mockReset()
    mockSaveProjectConfig.mockReset()
    mockWriteStdoutLine.mockReset()
  })

  it('returns a deployment config for a newly selected app without saving a blank preset', async () => {
    const { projectConfig, server, configurationService } = createSelectionScenario()

    mockLoadServers.mockResolvedValue([server])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)

    const runPrompt = vi.fn().mockResolvedValue({ presetName: '' })
    const logProcessing = vi.fn()

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    const result = await selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt,
      logProcessing,
      logSuccess: vi.fn(),
      logWarning: vi.fn()
    })

    expect(result.deploymentConfig).toEqual({
      serverName: 'production',
      serverIp: '203.0.113.10',
      projectPath: '~/webapps/demo',
      branch: 'main',
      sshUser: 'forge',
      sshKey: '~/.ssh/id_rsa'
    })
    expect(mockSaveProjectConfig).not.toHaveBeenCalled()
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(expect.stringContaining('"serverName": "production"'))
    expect(logProcessing).toHaveBeenCalledWith('\nSelected deployment target:')
  })

  it('saves a named preset for the selected app', async () => {
    const { projectConfig, server, configurationService } = createSelectionScenario()

    mockLoadServers.mockResolvedValue([server])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)

    const runPrompt = vi.fn().mockResolvedValue({ presetName: 'Production' })
    const logSuccess = vi.fn()

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    await selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt,
      logProcessing: vi.fn(),
      logSuccess,
      logWarning: vi.fn()
    })

    expect(projectConfig.presets).toEqual([
      {
        name: 'Production',
        appId: 'app-1',
        branch: 'main'
      }
    ])
    expect(mockSaveProjectConfig).toHaveBeenCalledWith('/workspace/project', projectConfig)
    expect(logSuccess).toHaveBeenCalledWith('Saved preset "Production" to .zephyr/config.json')
  })

  it('removes an invalid preset before creating a replacement configuration', async () => {
    const { projectConfig, server, configurationService } = createSelectionScenario()
    const invalidPreset = {
      name: 'Broken preset',
      appId: 'missing-app',
      branch: 'main'
    }

    projectConfig.presets = [invalidPreset]
    configurationService.selectPreset.mockResolvedValue(invalidPreset)
    mockLoadServers.mockResolvedValue([server])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)
    mockRemovePreset.mockImplementation((config, preset) => {
      config.presets = config.presets.filter((entry) => entry !== preset)
      return preset
    })

    const logWarning = vi.fn()

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    await selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt: vi.fn().mockResolvedValue({ presetName: '' }),
      logProcessing: vi.fn(),
      logSuccess: vi.fn(),
      logWarning
    })

    expect(mockRemovePreset).toHaveBeenCalledWith(projectConfig, invalidPreset)
    expect(mockSaveProjectConfig).toHaveBeenCalledWith('/workspace/project', projectConfig)
    expect(configurationService.selectServer).toHaveBeenCalledWith([server])
    expect(configurationService.selectApp).toHaveBeenCalledWith(projectConfig, server, '/workspace/project')
    expect(logWarning).toHaveBeenCalledWith('Preset references app configuration that no longer exists. Creating new configuration.')
    expect(logWarning).toHaveBeenCalledWith('Removed "Broken preset" from .zephyr/config.json because it is invalid.')
  })
})
