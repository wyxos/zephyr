import {beforeEach, describe, expect, it, vi} from 'vitest'
import {writeFile} from 'node:fs/promises'

const {mockCommandExists} = vi.hoisted(() => ({
    mockCommandExists: vi.fn()
}))

vi.mock('#src/utils/command.mjs', () => ({
    commandExists: mockCommandExists
}))

import {resolveReleaseType} from '#src/release/release-type.mjs'

describe('release type resolver', () => {
    beforeEach(() => {
        mockCommandExists.mockReset()
        mockCommandExists.mockReturnValue(false)
    })

    it('returns the explicit release type without prompting', async () => {
        await expect(resolveReleaseType({
            releaseType: 'patch',
            currentVersion: '1.0.0',
            packageName: '@wyxos/zephyr',
            runPrompt: vi.fn(),
            runCommand: vi.fn()
        })).resolves.toBe('patch')
    })

    it('prompts with a Codex-backed recommendation when no release type is specified', async () => {
        mockCommandExists.mockReturnValue(true)
        const runCommand = vi.fn(async (command, args) => {
            if (command === 'git' && args[0] === 'describe') {
                return {stdout: 'v1.2.3', stderr: ''}
            }

            if (command === 'git' && args[0] === 'log') {
                return {stdout: 'abc123 feat: add workflow notifications', stderr: ''}
            }

            if (command === 'git' && args[0] === 'diff') {
                return {stdout: ' src/main.mjs | 12 ++++++++++--', stderr: ''}
            }

            if (command === 'codex') {
                const outputPath = args[args.indexOf('--output-last-message') + 1]
                await writeFile(outputPath, 'minor\n')
                return {stdout: '', stderr: ''}
            }

            return {stdout: '', stderr: ''}
        })
        const runPrompt = vi.fn().mockResolvedValue({selectedReleaseType: 'minor'})

        const result = await resolveReleaseType({
            currentVersion: '1.2.3',
            packageName: '@wyxos/zephyr',
            rootDir: '/workspace/demo',
            interactive: true,
            runPrompt,
            runCommand,
            logStep: vi.fn(),
            logWarning: vi.fn()
        })

        expect(result).toBe('minor')
        expect(runPrompt).toHaveBeenCalledTimes(1)
        expect(runPrompt.mock.calls[0][0][0].message).toContain('Recommended release bump for @wyxos/zephyr@1.2.3')
        expect(runPrompt.mock.calls[0][0][0].choices[0]).toEqual({
            name: 'minor (recommended)',
            value: 'minor'
        })
    })

    it('falls back to heuristics in non-interactive mode when Codex is unavailable', async () => {
        const runCommand = vi.fn(async (command, args) => {
            if (command === 'git' && args[0] === 'describe') {
                return {stdout: 'v1.2.3', stderr: ''}
            }

            if (command === 'git' && args[0] === 'log') {
                return {stdout: 'abc123 feat: add workflow notifications\n', stderr: ''}
            }

            if (command === 'git' && args[0] === 'diff') {
                return {stdout: '', stderr: ''}
            }

            return {stdout: '', stderr: ''}
        })
        const logStep = vi.fn()

        const result = await resolveReleaseType({
            currentVersion: '1.2.3',
            packageName: '@wyxos/zephyr',
            rootDir: '/workspace/demo',
            interactive: false,
            runCommand,
            logStep,
            logWarning: vi.fn()
        })

        expect(result).toBe('minor')
        expect(logStep).toHaveBeenCalledWith('No release type specified. Using suggested minor bump based on changes since v1.2.3.')
    })

    it('uses prerelease heuristics when the current version is already prerelease', async () => {
        const runCommand = vi.fn(async (command, args) => {
            if (command === 'git' && args[0] === 'describe') {
                return {stdout: 'v1.2.3-beta.1', stderr: ''}
            }

            if (command === 'git' && args[0] === 'log') {
                return {stdout: 'abc123 feat: add workflow notifications\n', stderr: ''}
            }

            if (command === 'git' && args[0] === 'diff') {
                return {stdout: '', stderr: ''}
            }

            return {stdout: '', stderr: ''}
        })

        await expect(resolveReleaseType({
            currentVersion: '1.2.3-beta.1',
            packageName: '@wyxos/zephyr',
            rootDir: '/workspace/demo',
            interactive: false,
            runCommand,
            logStep: vi.fn(),
            logWarning: vi.fn()
        })).resolves.toBe('preminor')
    })
})
