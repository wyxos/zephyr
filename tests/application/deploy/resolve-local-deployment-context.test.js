import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    mockGetPhpVersionRequirement,
    mockHasPrePushHook,
    mockIsLocalLaravelProject
} = vi.hoisted(() => ({
    mockGetPhpVersionRequirement: vi.fn(),
    mockHasPrePushHook: vi.fn(),
    mockIsLocalLaravelProject: vi.fn()
}))

vi.mock('#src/infrastructure/php/version.mjs', () => ({
    getPhpVersionRequirement: mockGetPhpVersionRequirement
}))

vi.mock('#src/deploy/preflight.mjs', () => ({
    hasPrePushHook: mockHasPrePushHook,
    isLocalLaravelProject: mockIsLocalLaravelProject
}))

import {resolveLocalDeploymentContext} from '#src/application/deploy/resolve-local-deployment-context.mjs'

describe('application/deploy/resolve-local-deployment-context', () => {
    beforeEach(() => {
        mockGetPhpVersionRequirement.mockReset()
        mockHasPrePushHook.mockReset()
        mockIsLocalLaravelProject.mockReset()

        mockGetPhpVersionRequirement.mockResolvedValue('8.4.0')
        mockHasPrePushHook.mockResolvedValue(false)
        mockIsLocalLaravelProject.mockResolvedValue(true)
    })

    it('returns the detected PHP requirement, Laravel flag, and hook state', async () => {
        await expect(await resolveLocalDeploymentContext('/repo/demo')).toEqual({
            requiredPhpVersion: '8.4.0',
            isLaravel: true,
            hasHook: false
        })
    })

    it('falls back to a null PHP requirement when composer metadata cannot be read', async () => {
        mockGetPhpVersionRequirement.mockRejectedValue(new Error('no composer'))
        mockIsLocalLaravelProject.mockResolvedValue(false)
        mockHasPrePushHook.mockResolvedValue(true)

        await expect(await resolveLocalDeploymentContext('/repo/demo')).toEqual({
            requiredPhpVersion: null,
            isLaravel: false,
            hasHook: true
        })
    })
})
