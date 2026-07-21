import {EventEmitter} from 'node:events'

import {describe, expect, it, vi} from 'vitest'

import {createSshClientFactory} from '#src/runtime/ssh-client.mjs'

describe('runtime/ssh-client', () => {
    it('uses the OpenSSH transport when a host alias is configured', async () => {
        const spawnImpl = vi.fn((_command, _args, _options) => {
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            child.stderr = new EventEmitter()

            queueMicrotask(() => child.emit('close', 0))

            return child
        })

        class FakeNodeSSH {
            constructor() {
                throw new Error('direct SSH transport should not be created')
            }
        }

        const createSshClient = createSshClientFactory({NodeSSH: FakeNodeSSH, logWarning: vi.fn(), spawnImpl})
        const ssh = createSshClient()

        await ssh.connect({
            host: '203.0.113.10',
            sshAlias: 'law-dev',
            username: 'runcloud',
            privateKeyPath: '/Users/example/.ssh/deploy_key'
        })

        expect(spawnImpl).toHaveBeenCalledWith(
            'ssh',
            expect.arrayContaining(['law-dev', 'true']),
            {stdio: ['ignore', 'pipe', 'pipe']}
        )
    })

    it('handles background ssh2 errors after connect so idle sessions do not crash the process', async () => {
        const connection = new EventEmitter()

        class FakeNodeSSH {
            connection = null

            async connect() {
                this.connection = connection

                return this
            }
        }

        const logWarning = vi.fn()
        const createSshClient = createSshClientFactory({NodeSSH: FakeNodeSSH, logWarning})
        const ssh = createSshClient()

        await ssh.connect({host: '127.0.0.1'})

        expect(connection.listenerCount('error')).toBe(1)
        expect(() => connection.emit('error', new Error('read ETIMEDOUT'))).not.toThrow()
        expect(logWarning).toHaveBeenCalledWith(
            'SSH connection emitted a background error after connect: read ETIMEDOUT'
        )

        connection.emit('error', new Error('second failure'))
        expect(logWarning).toHaveBeenCalledTimes(1)
    })

    it('still lets failed SSH connects reject normally', async () => {
        const connection = new EventEmitter()

        class FakeNodeSSH {
            connection = null

            async connect() {
                this.connection = connection

                throw new Error('auth failed')
            }
        }

        const logWarning = vi.fn()
        const createSshClient = createSshClientFactory({NodeSSH: FakeNodeSSH, logWarning})
        const ssh = createSshClient()

        await expect(ssh.connect({host: '127.0.0.1'})).rejects.toThrow('auth failed')

        expect(connection.listenerCount('error')).toBe(0)
        expect(logWarning).not.toHaveBeenCalled()
    })
})
