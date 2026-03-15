import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {
    commitLintingChanges,
    hasStagedChanges,
    resolveSupportedLintCommand
} from '#src/deploy/preflight.mjs'

describe('deploy/preflight', () => {
    let rootDir

    afterEach(async () => {
        if (rootDir) {
            await rm(rootDir, {recursive: true, force: true})
            rootDir = null
        }
    })

    it('does not treat unstaged-only porcelain output as staged changes', () => {
        expect(hasStagedChanges(' M tests/Browser/AirConJourneyFlowTest.php')).toBe(false)
        expect(hasStagedChanges('M  tests/Browser/AirConJourneyFlowTest.php')).toBe(true)
    })

    it('stages tracked lint fixes before committing when changes are only unstaged', async () => {
        const getGitStatus = vi.fn()
            .mockResolvedValueOnce(' M tests/Browser/AirConJourneyFlowTest.php')
            .mockResolvedValueOnce('M  tests/Browser/AirConJourneyFlowTest.php')
        const runCommand = vi.fn()
        const logProcessing = vi.fn()
        const logSuccess = vi.fn()

        const committed = await commitLintingChanges('/repo/demo', {
            getGitStatus,
            runCommand,
            logProcessing,
            logSuccess
        })

        expect(committed).toBe(true)
        expect(runCommand).toHaveBeenNthCalledWith(1, 'git', ['add', '-u'], {cwd: '/repo/demo'})
        expect(runCommand).toHaveBeenNthCalledWith(2, 'git', ['commit', '-m', 'style: apply linting fixes'], {
            cwd: '/repo/demo'
        })
        expect(logProcessing).toHaveBeenCalledWith('Committing linting changes...')
        expect(logSuccess).toHaveBeenCalledWith('Linting changes committed.')
    })

    it('prefers package.json lint when available', async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'zephyr-preflight-'))
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            scripts: {
                lint: 'eslint .'
            }
        }, null, 2))

        await expect(resolveSupportedLintCommand(rootDir, {
            commandExists: vi.fn().mockReturnValue(true)
        })).resolves.toEqual({
            type: 'npm',
            command: 'npm',
            args: ['run', 'lint'],
            label: 'npm lint'
        })
    })

    it('supports Laravel Pint when npm lint is absent', async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'zephyr-preflight-'))
        await mkdir(join(rootDir, 'vendor', 'bin'), {recursive: true})
        await writeFile(join(rootDir, 'vendor', 'bin', 'pint'), '')

        await expect(resolveSupportedLintCommand(rootDir, {
            commandExists: vi.fn().mockImplementation((command) => command === 'php')
        })).resolves.toEqual({
            type: 'pint',
            command: 'php',
            args: ['vendor/bin/pint'],
            label: 'Laravel Pint'
        })
    })

    it('fails when no supported lint command is configured', async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'zephyr-preflight-'))

        await expect(resolveSupportedLintCommand(rootDir, {
            commandExists: vi.fn().mockReturnValue(true)
        })).rejects.toThrow(
            'Release cannot run because no supported lint command was found.\n' +
            'Zephyr requires either `npm run lint` or Laravel Pint (`vendor/bin/pint`) before deployment.'
        )
    })
})
