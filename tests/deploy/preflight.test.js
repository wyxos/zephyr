import {describe, expect, it, vi} from 'vitest'

import {commitLintingChanges, hasStagedChanges} from '#src/deploy/preflight.mjs'

describe('deploy/preflight', () => {
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
})
