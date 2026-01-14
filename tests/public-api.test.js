import { describe, it, expect } from 'vitest'

describe('public API', () => {
  it('exports the helpers Flux relies on', async () => {
    const api = await import('../src/index.mjs')

    expect(typeof api.loadServers).toBe('function')
    expect(typeof api.loadProjectConfig).toBe('function')
    expect(typeof api.selectPreset).toBe('function')
    expect(typeof api.selectServer).toBe('function')
    expect(typeof api.selectApp).toBe('function')

    expect(typeof api.logProcessing).toBe('function')
    expect(typeof api.logSuccess).toBe('function')
    expect(typeof api.logWarning).toBe('function')
    expect(typeof api.logError).toBe('function')

    expect(typeof api.runCommand).toBe('function')
    expect(typeof api.runCommandCapture).toBe('function')
    expect(typeof api.writeToLogFile).toBe('function')
  }, 15000)
})

