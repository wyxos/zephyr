import {EventEmitter} from 'node:events'

import {describe, expect, it, vi} from 'vitest'

import {createSshClientFactory} from '#src/runtime/ssh-client.mjs'

describe('runtime/ssh-client', () => {
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
