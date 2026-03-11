import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
    mockReadFile,
    mockReaddir,
    setupRuntimeTestEnv,
    teardownRuntimeTestEnv
} from '../helpers/runtime-test-env.mjs'

describe('ssh/keys', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('detects private key files from contents', async () => {
        mockReadFile.mockResolvedValueOnce('-----BEGIN OPENSSH PRIVATE KEY-----')

        const {isPrivateKeyFile} = await import('../../src/ssh/keys.mjs')

        await expect(isPrivateKeyFile('/home/local/.ssh/id_rsa')).resolves.toBe(true)

        mockReadFile.mockResolvedValueOnce('not-a-key')
        await expect(isPrivateKeyFile('/home/local/.ssh/config')).resolves.toBe(false)
    })

    it('lists only valid SSH private keys', async () => {
        mockReaddir.mockResolvedValue([
            {name: 'id_rsa', isFile: () => true},
            {name: 'id_rsa.pub', isFile: () => true},
            {name: '.DS_Store', isFile: () => true},
            {name: 'config', isFile: () => true},
            {name: 'deploy_key', isFile: () => true}
        ])

        mockReadFile.mockImplementation(async (filePath) => {
            if (filePath.endsWith('id_rsa')) {
                return '-----BEGIN RSA PRIVATE KEY-----'
            }

            if (filePath.endsWith('deploy_key')) {
                return '-----BEGIN OPENSSH PRIVATE KEY-----'
            }

            return 'invalid'
        })

        const path = await import('node:path')
        const {listSshKeys} = await import('../../src/ssh/keys.mjs')

        const result = await listSshKeys()

        expect(result).toEqual({
            sshDir: path.default.join('/home/local', '.ssh'),
            keys: ['id_rsa', 'deploy_key']
        })
    })
})
