import {beforeEach, describe, expect, it, vi} from 'vitest'

const mockValidateLocalDependencies = vi.fn().mockResolvedValue(undefined)

vi.mock('#src/dependency-scanner.mjs', () => ({
    validateLocalDependencies: mockValidateLocalDependencies
}))

describe('release-packagist module', () => {
    beforeEach(() => {
        vi.resetModules()
        mockValidateLocalDependencies.mockClear()
    })

    it('loads without syntax errors and exports releasePackagist', async () => {
        const module = await import('#src/release-packagist.mjs')
        expect(typeof module.releasePackagist).toBe('function')
    }, 15000)
})
