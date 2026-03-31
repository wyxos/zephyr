import {beforeEach, describe, expect, it, vi} from 'vitest'
import {writeFile} from 'node:fs/promises'

const {
    mockCommandExists,
    mockValidateLocalDependencies,
    mockRunCommand,
    mockRunCommandCapture
} = vi.hoisted(() => ({
    mockCommandExists: vi.fn(),
    mockValidateLocalDependencies: vi.fn(),
    mockRunCommand: vi.fn(),
    mockRunCommandCapture: vi.fn()
}))

vi.mock('#src/dependency-scanner.mjs', () => ({
    validateLocalDependencies: mockValidateLocalDependencies
}))

vi.mock('#src/utils/command.mjs', () => ({
    commandExists: mockCommandExists,
    runCommand: mockRunCommand,
    runCommandCapture: mockRunCommandCapture
}))

import {
    ensureCleanWorkingTree,
    ensureReleaseBranchReady,
    parseReleaseArgs,
    runReleaseCommand,
    suggestReleaseCommitMessage,
    validateReleaseDependencies
} from '#src/release/shared.mjs'
import {buildFallbackCommitMessage, sanitizeSuggestedCommitMessage} from '#src/release/commit-message.mjs'

describe('release shared helpers', () => {
    beforeEach(() => {
        mockCommandExists.mockReset()
        mockValidateLocalDependencies.mockReset()
        mockRunCommand.mockReset()
        mockRunCommandCapture.mockReset()
        mockCommandExists.mockReturnValue(false)
    })

    it('parses supported boolean flags into camel-cased properties', () => {
        const args = parseReleaseArgs({
            args: ['minor', '--skip-tests', '--skip-build'],
            booleanFlags: ['--skip-tests', '--skip-build', '--skip-deploy']
        })

        expect(args).toEqual({
            releaseType: 'minor',
            skipTests: true,
            skipBuild: true,
            skipDeploy: false
        })
    })

    it('ignores both equals and spaced --type forms before reading the release bump', () => {
        expect(parseReleaseArgs({
            args: ['--type=node', 'minor']
        })).toEqual({releaseType: 'minor'})

        expect(parseReleaseArgs({
            args: ['--type', 'node', 'minor']
        })).toEqual({releaseType: 'minor'})

        expect(parseReleaseArgs({
            args: ['--type', 'packagist']
        })).toEqual({releaseType: null})
    })

    it('throws for invalid release types', () => {
        expect(() => parseReleaseArgs({args: ['banana']})).toThrow(/Invalid release type/)
    })

    it('runs release commands in capture mode and trims the output', async () => {
        mockRunCommandCapture.mockResolvedValue({
            stdout: ' 1.2.3 \n',
            stderr: ' warning \n'
        })

        const result = await runReleaseCommand('npm', ['version', '--json'], {
            cwd: '/workspace/demo',
            capture: true
        })

        expect(result).toEqual({stdout: '1.2.3', stderr: 'warning'})
        expect(mockRunCommandCapture).toHaveBeenCalledWith('npm', ['version', '--json'], {
            cwd: '/workspace/demo'
        })
        expect(mockRunCommand).not.toHaveBeenCalled()
    })

    it('accepts plain stdout strings from app-context capture runners', async () => {
        mockRunCommandCapture.mockResolvedValue(' 1.2.3 \n')

        const result = await runReleaseCommand('git', ['status', '--porcelain'], {
            cwd: '/workspace/demo',
            capture: true
        })

        expect(result).toEqual({stdout: '1.2.3', stderr: ''})
    })

    it('throws when the working tree is dirty in non-interactive mode', async () => {
        await expect(ensureCleanWorkingTree('/workspace/demo', {
            runCommand: vi.fn().mockResolvedValue({stdout: ' M src/index.mjs'}),
            interactive: false
        })).rejects.toThrow('Working tree has uncommitted changes. Commit or stash them before releasing.')
    })

    it('commits pending changes after confirmation when the working tree is dirty', async () => {
        const runCommand = vi.fn(async (command, args) => {
            if (command === 'git' && args[0] === 'status') {
                const invocationCount = runCommand.mock.calls.filter(([currentCommand, currentArgs]) => currentCommand === 'git' && currentArgs[0] === 'status').length
                return invocationCount === 1
                    ? {stdout: ' M src/index.mjs\n?? tests/new.test.js', stderr: ''}
                    : {stdout: '', stderr: ''}
            }

            return {stdout: '', stderr: ''}
        })
        const runPrompt = vi.fn()
            .mockResolvedValueOnce({shouldCommitPendingChanges: true})
            .mockResolvedValueOnce({commitMessage: 'fix: align release commit flow'})
        const suggestCommitMessage = vi.fn().mockResolvedValue('fix: align release commit flow')
        const logStep = vi.fn()
        const logSuccess = vi.fn()

        await ensureCleanWorkingTree('/workspace/demo', {
            runCommand,
            runPrompt,
            logStep,
            logSuccess,
            suggestCommitMessage
        })

        expect(suggestCommitMessage).toHaveBeenCalledWith('/workspace/demo', expect.objectContaining({
            runCommand,
            logStep
        }))
        expect(runPrompt).toHaveBeenNthCalledWith(1, [
            expect.objectContaining({
                type: 'confirm',
                name: 'shouldCommitPendingChanges'
            })
        ])
        expect(runPrompt.mock.calls[0][0][0].message).toContain('modified: src/index.mjs')
        expect(runPrompt.mock.calls[0][0][0].message).toContain('untracked: tests/new.test.js')
        expect(runPrompt).toHaveBeenNthCalledWith(2, [
            expect.objectContaining({
                type: 'input',
                name: 'commitMessage',
                default: 'fix: align release commit flow'
            })
        ])
        expect(runCommand).toHaveBeenNthCalledWith(2, 'git', ['add', '-A'], {
            capture: true,
            cwd: '/workspace/demo'
        })
        expect(runCommand).toHaveBeenNthCalledWith(3, 'git', ['commit', '-m', 'fix: align release commit flow'], {
            capture: true,
            cwd: '/workspace/demo'
        })
        expect(logSuccess).toHaveBeenCalledWith('Committed pending changes with "fix: align release commit flow".')
    })

    it('uses a more descriptive fallback message when no Codex suggestion is available', async () => {
        const runCommand = vi.fn(async (command, args) => {
            if (command === 'git' && args[0] === 'status') {
                const invocationCount = runCommand.mock.calls.filter(([currentCommand, currentArgs]) => currentCommand === 'git' && currentArgs[0] === 'status').length
                return invocationCount === 1
                    ? {stdout: ' M src/release/shared.mjs\n M tests/release/shared.test.js', stderr: ''}
                    : {stdout: '', stderr: ''}
            }

            return {stdout: '', stderr: ''}
        })
        const runPrompt = vi.fn()
            .mockResolvedValueOnce({shouldCommitPendingChanges: true})
            .mockResolvedValueOnce({commitMessage: 'chore: update release handling'})

        await ensureCleanWorkingTree('/workspace/demo', {
            runCommand,
            runPrompt,
            suggestCommitMessage: vi.fn().mockResolvedValue(null)
        })

        expect(runPrompt).toHaveBeenNthCalledWith(2, [
            expect.objectContaining({
                default: 'chore: update release handling'
            })
        ])
    })

    it('builds a deploy-specific fallback message for deploy guard changes', () => {
        expect(buildFallbackCommitMessage([
            {indexStatus: ' ', worktreeStatus: 'M', path: 'src/application/deploy/prepare-local-deployment.mjs', previousPath: null},
            {indexStatus: ' ', worktreeStatus: 'M', path: 'src/deploy/local-repo.mjs', previousPath: null},
            {indexStatus: ' ', worktreeStatus: 'M', path: 'src/release/commit-message.mjs', previousPath: null}
        ])).toBe('fix: prompt for dirty deploy changes before version bump')
    })

    it('rejects meta commit subjects about committing pending changes', () => {
        expect(sanitizeSuggestedCommitMessage('feat: commit pending changes before deployment')).toBeNull()
        expect(sanitizeSuggestedCommitMessage('fix: allow committing pending changes before release')).toBeNull()
        expect(sanitizeSuggestedCommitMessage('chore: improve release workflow')).toBeNull()
    })

    it('asks Codex for a suggested conventional commit message when available', async () => {
        mockCommandExists.mockReturnValue(true)
        const runCommand = vi.fn(async (command, args) => {
            if (command === 'git' && args[0] === 'diff' && args.includes('--unified=0')) {
                return {
                    stdout: [
                        'diff --git a/src/release/shared.mjs b/src/release/shared.mjs',
                        '@@ -180 +180 @@',
                        '-                default: \'chore: improve release workflow\'',
                        '+                default: \'chore: update release handling\''
                    ].join('\n'),
                    stderr: ''
                }
            }

            const outputPath = args[args.indexOf('--output-last-message') + 1]
            await writeFile(outputPath, 'fix: prompt for dirty deploy changes before version bump\n')
            return {stdout: '', stderr: ''}
        })
        const logStep = vi.fn()
        const logWarning = vi.fn()

        const result = await suggestReleaseCommitMessage('/workspace/demo', {
            runCommand,
            commandExistsImpl: mockCommandExists,
            logStep,
            logWarning,
            statusEntries: [
                {indexStatus: ' ', worktreeStatus: 'M', path: 'src/release/shared.mjs', previousPath: null},
                {indexStatus: '?', worktreeStatus: '?', path: 'tests/release/shared.test.js', previousPath: null}
            ]
        })

        expect(result).toBe('fix: prompt for dirty deploy changes before version bump')
        expect(runCommand).toHaveBeenCalledWith('codex', expect.arrayContaining([
            'exec',
            '--model',
            'gpt-5.4-mini',
            '--output-last-message',
            expect.any(String)
        ]), {
            capture: true,
            cwd: '/workspace/demo'
        })
        const codexCall = runCommand.mock.calls.find(([command]) => command === 'codex')
        expect(codexCall?.[1].at(-1)).toContain('modified: src/release/shared.mjs')
        expect(codexCall?.[1].at(-1)).toContain('untracked: tests/release/shared.test.js')
        expect(codexCall?.[1].at(-1)).toContain('Diff excerpt:')
        expect(codexCall?.[1].at(-1)).toContain('+                default: \'chore: update release handling\'')
        expect(codexCall?.[1].at(-1)).toContain('Avoid generic nouns like "workflow"')
        expect(codexCall?.[1].at(-1)).toContain('Do not describe the commit itself')
        expect(logStep).toHaveBeenCalledWith('Generating a suggested commit message with Codex...')
        expect(logWarning).not.toHaveBeenCalled()
    })

    it('validates release dependencies with the provided prompt and logger', async () => {
        const prompt = vi.fn()
        const logSuccess = vi.fn()

        await validateReleaseDependencies('/workspace/demo', {prompt, logSuccess})

        expect(mockValidateLocalDependencies).toHaveBeenCalledWith('/workspace/demo', prompt, logSuccess, {
            interactive: true,
            skipGitHooks: false
        })
    })

    it('passes non-interactive dependency validation through to the dependency scanner', async () => {
        await validateReleaseDependencies('/workspace/demo', {
            prompt: vi.fn(),
            logSuccess: vi.fn(),
            interactive: false,
            skipGitHooks: true
        })

        expect(mockValidateLocalDependencies).toHaveBeenCalledWith('/workspace/demo', expect.any(Function), expect.any(Function), {
            interactive: false,
            skipGitHooks: true
        })
    })

    it('resolves the current branch and verifies upstream state', async () => {
        const getCurrentBranchImpl = vi.fn().mockResolvedValue('main')
        const getUpstreamRefImpl = vi.fn().mockResolvedValue('origin/main')
        const ensureUpToDateWithUpstreamImpl = vi.fn().mockResolvedValue(undefined)
        const logStep = vi.fn()
        const logWarning = vi.fn()

        const result = await ensureReleaseBranchReady({
            rootDir: '/workspace/demo',
            branchMethod: 'show-current',
            getCurrentBranchImpl,
            getUpstreamRefImpl,
            ensureUpToDateWithUpstreamImpl,
            logStep,
            logWarning
        })

        expect(result).toEqual({branch: 'main', upstreamRef: 'origin/main'})
        expect(getCurrentBranchImpl).toHaveBeenCalledWith('/workspace/demo', {method: 'show-current'})
        expect(getUpstreamRefImpl).toHaveBeenCalledWith('/workspace/demo')
        expect(ensureUpToDateWithUpstreamImpl).toHaveBeenCalledWith({
            branch: 'main',
            upstreamRef: 'origin/main',
            rootDir: '/workspace/demo',
            logStep,
            logWarning
        })
        expect(logStep).toHaveBeenCalledWith('Current branch: main')
    })
})
