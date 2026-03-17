import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {validateLocalDependencies} from '#src/dependency-scanner.mjs'

describe('dependency-scanner', () => {
    let rootDir

    afterEach(async () => {
        vi.unstubAllGlobals()

        if (rootDir) {
            await rm(rootDir, {recursive: true, force: true})
            rootDir = null
        }
    })

    it('fails in non-interactive mode when external local file dependencies require confirmation', async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'zephyr-dependency-scanner-'))
        await writeFile(join(rootDir, 'package.json'), JSON.stringify({
            name: 'demo-app',
            version: '1.0.0',
            dependencies: {
                '@wyxos/flux': 'file:../flux'
            }
        }, null, 2))

        const prompt = vi.fn()
        const fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({version: '1.2.3'})
        })
        vi.stubGlobal('fetch', fetch)

        await expect(validateLocalDependencies(rootDir, prompt, null, {
            interactive: false
        })).rejects.toMatchObject({
            code: 'ZEPHYR_DEPENDENCY_UPDATE_REQUIRED'
        })

        expect(fetch).toHaveBeenCalledWith('https://registry.npmjs.org/@wyxos/flux/latest')
        expect(prompt).not.toHaveBeenCalled()
    })
})
