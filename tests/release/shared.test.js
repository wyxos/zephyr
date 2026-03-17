import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    mockValidateLocalDependencies,
    mockRunCommand,
    mockRunCommandCapture
} = vi.hoisted(() => ({
    mockValidateLocalDependencies: vi.fn(),
    mockRunCommand: vi.fn(),
    mockRunCommandCapture: vi.fn()
}))

vi.mock('#src/dependency-scanner.mjs', () => ({
    validateLocalDependencies: mockValidateLocalDependencies
}))

vi.mock('#src/utils/command.mjs', () => ({
    runCommand: mockRunCommand,
    runCommandCapture: mockRunCommandCapture
}))

import {
    ensureCleanWorkingTree,
    ensureReleaseBranchReady,
    parseReleaseArgs,
    runReleaseCommand,
    validateReleaseDependencies
} from '#src/release/shared.mjs'

describe('release shared helpers', () => {
    beforeEach(() => {
        mockValidateLocalDependencies.mockReset()
        mockRunCommand.mockReset()
        mockRunCommandCapture.mockReset()
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
        })).toEqual({releaseType: 'patch'})
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

    it('throws when the working tree is dirty', async () => {
        await expect(ensureCleanWorkingTree('/workspace/demo', {
            runCommand: vi.fn().mockResolvedValue({stdout: ' M src/index.mjs'})
        })).rejects.toThrow('Working tree has uncommitted changes. Commit or stash them before releasing.')
    })

    it('validates release dependencies with the provided prompt and logger', async () => {
        const prompt = vi.fn()
        const logSuccess = vi.fn()

        await validateReleaseDependencies('/workspace/demo', {prompt, logSuccess})

        expect(mockValidateLocalDependencies).toHaveBeenCalledWith('/workspace/demo', prompt, logSuccess, {
            interactive: true
        })
    })

    it('passes non-interactive dependency validation through to the dependency scanner', async () => {
        await validateReleaseDependencies('/workspace/demo', {
            prompt: vi.fn(),
            logSuccess: vi.fn(),
            interactive: false
        })

        expect(mockValidateLocalDependencies).toHaveBeenCalledWith('/workspace/demo', expect.any(Function), expect.any(Function), {
            interactive: false
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
