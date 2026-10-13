import { describe, it, expect } from 'vitest'
import { resolveCommandForPlatform } from '#src/utils/command.mjs'

describe('command utils', () => {
  it('resolves npm/npx to .cmd on Windows', () => {
    expect(resolveCommandForPlatform('npm', { isWindows: true })).toBe('npm.cmd')
    expect(resolveCommandForPlatform('npx', { isWindows: true })).toBe('npx.cmd')
    expect(resolveCommandForPlatform('pnpm', { isWindows: true })).toBe('pnpm.cmd')
    expect(resolveCommandForPlatform('yarn', { isWindows: true })).toBe('yarn.cmd')
  })

  it('does not modify commands on non-Windows platforms', () => {
    expect(resolveCommandForPlatform('npm', { isWindows: false })).toBe('npm')
    expect(resolveCommandForPlatform('php', { isWindows: false })).toBe('php')
  })
  it('uses the bundled macOS CLI when Codex is absent from PATH', () => {
    expect(resolveCommandForPlatform('codex', {
      platform: 'darwin', isWindows: false, codexCommand: null,
      pathLookup: () => false, fileExists: path => path.includes('ChatGPT.app')
    })).toBe('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
  })

  it('prefers configured or PATH Codex commands over the app bundle', () => {
    expect(resolveCommandForPlatform('codex', {codexCommand: '/custom/codex'})).toBe('/custom/codex')
    expect(resolveCommandForPlatform('codex', {
      platform: 'darwin', codexCommand: null, pathLookup: () => true, fileExists: () => true
    })).toBe('codex')
  })

})
