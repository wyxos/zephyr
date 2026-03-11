import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {setupRuntimeTestEnv, teardownRuntimeTestEnv} from '../helpers/runtime-test-env.mjs'

describe('utils/remote-path', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('resolves remote paths correctly', async () => {
        const {resolveRemotePath} = await import('../../src/utils/remote-path.mjs')

        expect(resolveRemotePath('~/webapps/app', '/home/runcloud')).toBe('/home/runcloud/webapps/app')
        expect(resolveRemotePath('app', '/home/runcloud')).toBe('/home/runcloud/app')
        expect(resolveRemotePath('/var/www/html', '/home/runcloud')).toBe('/var/www/html')
        expect(resolveRemotePath('~', '/home/runcloud')).toBe('/home/runcloud')
    })
})
