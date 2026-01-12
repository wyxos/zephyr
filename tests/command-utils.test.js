import { describe, it, expect } from 'vitest'
import { resolveCommandForPlatform } from '../src/utils/command.mjs'

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
})

