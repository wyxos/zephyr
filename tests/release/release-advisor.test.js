import {afterEach, expect, it, vi} from 'vitest'
import {readFile, writeFile} from 'node:fs/promises'

const {exists} = vi.hoisted(() => ({exists: vi.fn()}))
vi.mock('#src/utils/command.mjs', () => ({commandExists: exists, runCommand: vi.fn(), runCommandCapture: vi.fn()}))
import {recommendReleaseType} from '#src/release-advisor.mjs'

afterEach(() => vi.clearAllMocks())

it('exports the existing adviser through the public package API', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  expect(pkg.exports['./release-advisor']).toBe('./src/release-advisor.mjs')
})

it('asks Codex for a read-only recommendation including pending SDK changes', async () => {
  exists.mockReturnValue(true)
  const capture = vi.fn(async (_command, args) => {
    if (args[0] === 'log') return 'abc feat: add external role controls'
    if (args[0] === 'status') return '?? src/NewIntegration.php'
    if (args[0] === 'diff') return ' routes/shift.php | 3 +++'
    throw new Error('Unexpected Git inspection')
  })
  const run = vi.fn(async (command, args, options) => {
    expect(command).toBe('codex')
    expect(args).toContain('read-only')
    expect(args).not.toContain('gpt-5.4-mini')
    expect(args.at(-1)).toContain('Include pending tracked and untracked changes')
    expect(args.at(-1)).toContain('src/NewIntegration.php')
    expect(options.cwd).toBe('/sdk')
    await writeFile(args[args.indexOf('--output-last-message') + 1], 'minor')
    return {stdout: '', stderr: ''}
  })
  await expect(recommendReleaseType({rootDir: '/sdk', currentVersion: '1.1.100', latestTag: 'v1.1.100', runCommand: run, runCommandCapture: capture})).resolves.toBe('minor')
  expect(capture).toHaveBeenCalledWith('git', ['diff', '--stat', 'v1.1.100', '--'], {cwd: '/sdk'})
  expect(run).toHaveBeenCalledOnce()
})

it('retains Zephyr heuristic fallback when Codex is unavailable', async () => {
  exists.mockReturnValue(false)
  const capture = vi.fn(async (_command, args) => args[0] === 'log' ? 'abc feat: add email import' : '')
  const run = vi.fn()
  await expect(recommendReleaseType({rootDir: '/sdk', currentVersion: '1.1.100', latestTag: 'v1.1.100', runCommand: run, runCommandCapture: capture})).resolves.toBe('minor')
  expect(run).not.toHaveBeenCalled()
})
