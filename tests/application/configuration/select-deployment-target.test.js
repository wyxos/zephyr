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
        branch: 'main',
        options: {
          maintenanceMode: null,
          skipGitHooks: false,
          skipTests: false,
          skipLint: false,
          skipVersioning: false,
          autoCommit: false
        }
      }
    ])
    expect(mockSaveProjectConfig).toHaveBeenCalledWith('/workspace/project', projectConfig)
    expect(logSuccess).toHaveBeenCalledWith('Saved preset "Production" to .zephyr/config.json')
  })

  it('stores preset auto-commit as enabled when the save prompt is non-blank', async () => {
    const { projectConfig, server, configurationService } = createSelectionScenario()

    mockLoadServers.mockResolvedValue([server])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)

    const runPrompt = vi.fn()
      .mockResolvedValueOnce({ presetName: 'Production' })
      .mockResolvedValueOnce({ autoCommitPreference: 'yes' })

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    await selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt,
      logProcessing: vi.fn(),
      logSuccess: vi.fn(),
      logWarning: vi.fn(),
      executionMode: {
        interactive: true
      }
    })

    expect(projectConfig.presets[0].options.autoCommit).toBe(true)
  })

  it('does not ask for deploy preset options when disabled by the caller', async () => {
    const { projectConfig, server, configurationService } = createSelectionScenario()

    mockLoadServers.mockResolvedValue([server])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)

    const runPrompt = vi.fn().mockResolvedValueOnce({ presetName: 'Production' })

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    await selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt,
      logProcessing: vi.fn(),
      logSuccess: vi.fn(),
      logWarning: vi.fn(),
      promptPresetOptions: false
    })

    expect(runPrompt).toHaveBeenCalledTimes(1)
    expect(projectConfig.presets[0].options.autoCommit).toBe(false)
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
    expect(logWarning).toHaveBeenCalledWith(
      'Preset references an application that no longer exists. Creating a new configuration instead.'
    )
    expect(logWarning).toHaveBeenCalledWith('Removed "Broken preset" from .zephyr/config.json because it is invalid.')
  })

  it('resolves a valid preset by name in non-interactive mode without prompting', async () => {
    const { projectConfig, server, appConfig, configurationService } = createSelectionScenario()
    projectConfig.apps = [{...appConfig, serverId: 'server-1'}]
    projectConfig.presets = [{name: 'Production', appId: 'app-1', branch: 'main'}]

    mockLoadServers.mockResolvedValue([{...server, id: 'server-1'}])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)

    const emitEvent = vi.fn()

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    const result = await selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt: vi.fn(),
      logProcessing: vi.fn(),
      logSuccess: vi.fn(),
      logWarning: vi.fn(),
      emitEvent,
      executionMode: {
        interactive: false,
        json: true,
        presetName: 'Production'
      }
    })

    expect(result.deploymentConfig).toEqual({
      serverName: 'production',
      serverIp: '203.0.113.10',
      projectPath: '~/webapps/demo',
      branch: 'main',
      sshUser: 'forge',
      sshKey: '~/.ssh/id_rsa'
    })
    expect(configurationService.selectPreset).not.toHaveBeenCalled()
    expect(configurationService.selectServer).not.toHaveBeenCalled()
    expect(configurationService.selectApp).not.toHaveBeenCalled()
    expect(emitEvent).toHaveBeenCalledWith('log', expect.objectContaining({
      level: 'processing',
      message: 'Selected deployment target.',
      data: {
        deploymentConfig: expect.objectContaining({
          serverName: 'production',
          branch: 'main'
        })
      }
    }))
  })

  it('merges partial preset option saves into existing options', async () => {
    const { projectConfig, server, appConfig, configurationService } = createSelectionScenario()
    const preset = {
      name: 'Staging',
      appId: 'app-1',
      branch: 'main',
      options: {
        maintenanceMode: null,
        skipGitHooks: true,
        skipTests: false,
        skipLint: false,
        skipVersioning: true,
        autoCommit: false
      }
    }

    projectConfig.apps = [{...appConfig, serverId: 'server-1'}]
    projectConfig.presets = [preset]
    configurationService.selectPreset.mockResolvedValue(preset)
    mockLoadServers.mockResolvedValue([{...server, id: 'server-1'}])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    const result = await selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt: vi.fn(),
      logProcessing: vi.fn(),
      logSuccess: vi.fn(),
      logWarning: vi.fn()
    })

    await result.presetState.saveOptions({
      maintenanceMode: false
    })

    expect(projectConfig.presets[0].options).toEqual({
      maintenanceMode: false,
      skipGitHooks: true,
      skipTests: false,
      skipLint: false,
      skipVersioning: true,
      autoCommit: false
    })
    expect(mockSaveProjectConfig).toHaveBeenLastCalledWith('/workspace/project', projectConfig)
  })

  it('fails when the named preset is missing in non-interactive mode', async () => {
    const { projectConfig, server, configurationService } = createSelectionScenario()

    mockLoadServers.mockResolvedValue([{...server, id: 'server-1'}])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    await expect(selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt: vi.fn(),
      logProcessing: vi.fn(),
      logSuccess: vi.fn(),
      logWarning: vi.fn(),
      executionMode: {
        interactive: false,
        json: false,
        presetName: 'Missing'
      }
    })).rejects.toMatchObject({
      code: 'ZEPHYR_PRESET_NOT_FOUND'
    })
  })

  it('fails when the selected preset is missing SSH details in non-interactive mode', async () => {
    const { projectConfig, server, appConfig, configurationService } = createSelectionScenario()
    projectConfig.apps = [{...appConfig, serverId: 'server-1', sshUser: '', sshKey: ''}]
    projectConfig.presets = [{name: 'Production', appId: 'app-1', branch: 'main'}]

    mockLoadServers.mockResolvedValue([{...server, id: 'server-1'}])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    await expect(selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt: vi.fn(),
      logProcessing: vi.fn(),
      logSuccess: vi.fn(),
      logWarning: vi.fn(),
      executionMode: {
        interactive: false,
        json: false,
        presetName: 'Production'
      }
    })).rejects.toMatchObject({
      code: 'ZEPHYR_SSH_DETAILS_REQUIRED'
    })
  })

  it('fails when a named preset requires interactive repair in non-interactive mode', async () => {
    const { projectConfig, server, configurationService } = createSelectionScenario()
    projectConfig.presets = [{ name: 'Legacy preset', key: 'production:~/webapps/demo' }]

    mockLoadServers.mockResolvedValue([{ ...server, id: 'server-1' }])
    mockLoadProjectConfig.mockResolvedValue(projectConfig)

    const { selectDeploymentTarget } = await import('#src/application/configuration/select-deployment-target.mjs')

    await expect(selectDeploymentTarget('/workspace/project', {
      configurationService,
      runPrompt: vi.fn(),
      logProcessing: vi.fn(),
      logSuccess: vi.fn(),
      logWarning: vi.fn(),
      executionMode: {
        interactive: false,
        json: false,
        presetName: 'Legacy preset'
      }
    })).rejects.toMatchObject({
      code: 'ZEPHYR_PRESET_INVALID'
    })
  })
})
