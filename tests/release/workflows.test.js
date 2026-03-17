import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    mockCreateAppContext,
    mockReleaseNodePackage,
    mockReleasePackagistPackage
} = vi.hoisted(() => ({
    mockCreateAppContext: vi.fn(),
    mockReleaseNodePackage: vi.fn(),
    mockReleasePackagistPackage: vi.fn()
}))

vi.mock('#src/runtime/app-context.mjs', () => ({
    createAppContext: mockCreateAppContext
}))

vi.mock('#src/application/release/release-node-package.mjs', () => ({
    releaseNodePackage: mockReleaseNodePackage
}))

vi.mock('#src/application/release/release-packagist-package.mjs', () => ({
    releasePackagistPackage: mockReleasePackagistPackage
}))

describe('release workflow entrypoints', () => {
    beforeEach(() => {
        vi.resetModules()
        mockCreateAppContext.mockReset()
        mockReleaseNodePackage.mockReset()
        mockReleasePackagistPackage.mockReset()
    })

    it('passes non-interactive context through the node release workflow', async () => {
        const context = {
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            runPrompt: vi.fn(),
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            executionMode: {
                interactive: false,
                json: true,
                workflow: 'release-node'
            }
        }

        const {releaseNode} = await import('#src/release-node.mjs')

        await releaseNode({
            releaseType: 'minor',
            context
        })

        expect(mockCreateAppContext).not.toHaveBeenCalled()
        expect(mockReleaseNodePackage).toHaveBeenCalledWith(expect.objectContaining({
            releaseType: 'minor',
            interactive: false,
            runCommandImpl: context.runCommand,
            runCommandCaptureImpl: context.runCommandCapture
        }))
    })

    it('routes Packagist progress output to stderr in JSON mode', async () => {
        const context = {
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            runPrompt: vi.fn(),
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            executionMode: {
                interactive: false,
                json: true,
                workflow: 'release-packagist'
            }
        }

        const {releasePackagist} = await import('#src/release-packagist.mjs')

        await releasePackagist({
            releaseType: 'patch',
            context
        })

        expect(mockReleasePackagistPackage).toHaveBeenCalledWith(expect.objectContaining({
            releaseType: 'patch',
            interactive: false,
            progressWriter: process.stderr
        }))
    })
})
