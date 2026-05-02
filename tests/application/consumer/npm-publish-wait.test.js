import {describe, expect, it, vi} from 'vitest'

import {waitForNpmPackageVersion} from '#src/application/consumer/npm-publish-wait.mjs'

describe('application/consumer/npm-publish-wait', () => {
    it('resolves when the requested package version is visible on npm', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                versions: {
                    '3.1.23': {}
                }
            })
        })
        const logSuccess = vi.fn()

        const result = await waitForNpmPackageVersion({
            packageName: '@wyxos/vibe',
            version: '3.1.23',
            fetchImpl,
            delayImpl: vi.fn(),
            nowImpl: () => 0,
            logSuccess
        })

        expect(result).toEqual({packageName: '@wyxos/vibe', version: '3.1.23', attempts: 1})
        expect(fetchImpl).toHaveBeenCalledWith('https://registry.npmjs.org/%40wyxos%2Fvibe')
        expect(logSuccess).toHaveBeenCalledWith('@wyxos/vibe@3.1.23 is visible on npm.')
    })

    it('throws when the requested version is not visible before the timeout', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({versions: {}})
        })
        const delayImpl = vi.fn()

        await expect(waitForNpmPackageVersion({
            packageName: '@wyxos/vibe',
            version: '3.1.23',
            timeoutMs: 0,
            intervalMs: 10,
            fetchImpl,
            delayImpl,
            nowImpl: () => 0
        })).rejects.toThrow('Timed out waiting for @wyxos/vibe@3.1.23 to be visible on npm.')

        expect(fetchImpl).toHaveBeenCalledTimes(1)
        expect(delayImpl).not.toHaveBeenCalled()
    })
})
