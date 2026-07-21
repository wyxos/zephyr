import {EventEmitter} from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {PassThrough} from 'node:stream'

import {describe, expect, it, vi} from 'vitest'

import {createOpenSshClient} from '#src/runtime/open-ssh-client.mjs'

function createSpawnMock(responses = []) {
    const calls = []
    const spawnImpl = vi.fn((command, args, options) => {
        calls.push({command, args, options})
        const response = responses.shift() ?? {}
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()

        queueMicrotask(() => {
            if (response.error) {
                child.emit('error', response.error)
                return
            }

            if (response.stdout) {
                child.stdout.write(response.stdout)
            }

            if (response.stderr) {
                child.stderr.write(response.stderr)
            }

            child.stdout.end()
            child.stderr.end()
            child.emit('close', response.code ?? 0)
        })

        return child
    })

    return {spawnImpl, calls}
}

describe('runtime/open-ssh-client', () => {
    it('executes commands through a configured OpenSSH host alias', async () => {
        const {spawnImpl, calls} = createSpawnMock([
            {},
            {stdout: 'ok\n'}
        ])
        const ssh = createOpenSshClient({spawnImpl})

        await ssh.connect({
            sshAlias: 'law-dev',
            username: 'runcloud',
            privateKeyPath: '/Users/example/.ssh/deploy_key'
        })
        const result = await ssh.execCommand('php artisan about', {
            cwd: "/home/runcloud/webapps/client's-app"
        })

        expect(result).toEqual({code: 0, stdout: 'ok\n', stderr: ''})
        expect(calls).toHaveLength(2)
        expect(calls[0]).toMatchObject({
            command: 'ssh',
            args: [
                '-T',
                '-o',
                'BatchMode=yes',
                '-o',
                'IdentitiesOnly=yes',
                '-l',
                'runcloud',
                '-i',
                '/Users/example/.ssh/deploy_key',
                'law-dev',
                'true'
            ]
        })
        expect(calls[1].args.at(-1)).toBe(
            "cd -- '/home/runcloud/webapps/client'\\''s-app' && php artisan about"
        )
    })

    it('returns remote non-zero command results without rejecting', async () => {
        const {spawnImpl} = createSpawnMock([
            {},
            {code: 17, stderr: 'remote failure\n'}
        ])
        const ssh = createOpenSshClient({spawnImpl})

        await ssh.connect({
            sshAlias: 'law-dev',
            username: 'runcloud',
            privateKeyPath: '/Users/example/.ssh/deploy_key'
        })

        await expect(ssh.execCommand('false')).resolves.toEqual({
            code: 17,
            stdout: '',
            stderr: 'remote failure\n'
        })
    })

    it('downloads files through scp using the same OpenSSH alias', async () => {
        const payload = Buffer.from([0, 1, 2, 255])
        const {spawnImpl, calls} = createSpawnMock([
            {},
            {}
        ])
        const ssh = createOpenSshClient({spawnImpl})
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zephyr-open-ssh-'))
        const localPath = path.join(tempDir, 'fixture.bin')
        const step = vi.fn()

        try {
            await ssh.connect({
                sshAlias: 'law-dev',
                username: 'runcloud',
                privateKeyPath: '/Users/example/.ssh/deploy_key'
            })
            await fs.writeFile(localPath, payload)
            await ssh.getFile(localPath, "/remote/path/fixture's.bin", null, {step})

            expect(calls[1]).toMatchObject({
                command: 'scp',
                args: expect.arrayContaining([
                    'User=runcloud',
                    "law-dev:/remote/path/fixture's.bin",
                    localPath
                ])
            })
            expect(step).toHaveBeenCalledWith(payload.length, payload.length, payload.length)
        } finally {
            await fs.rm(tempDir, {recursive: true, force: true})
        }
    })

    it('rejects failed connection checks with the alias and OpenSSH error', async () => {
        const {spawnImpl} = createSpawnMock([
            {code: 255, stderr: 'jump host unavailable\n'}
        ])
        const ssh = createOpenSshClient({spawnImpl})

        await expect(ssh.connect({
            sshAlias: 'law-dev',
            username: 'runcloud',
            privateKeyPath: '/Users/example/.ssh/deploy_key'
        })).rejects.toThrow(
            'Failed to connect through OpenSSH alias "law-dev": jump host unavailable'
        )
    })

    it('rejects aliases that could be interpreted as OpenSSH options', async () => {
        const {spawnImpl} = createSpawnMock()
        const ssh = createOpenSshClient({spawnImpl})

        await expect(ssh.connect({
            sshAlias: '-oProxyCommand=bad',
            username: 'runcloud',
            privateKeyPath: '/Users/example/.ssh/deploy_key'
        })).rejects.toThrow('OpenSSH alias must be a non-empty SSH config host')
        expect(spawnImpl).not.toHaveBeenCalled()
    })

    it('stays disconnected when the local OpenSSH process cannot start', async () => {
        const {spawnImpl} = createSpawnMock([
            {error: Object.assign(new Error('spawn ssh ENOENT'), {code: 'ENOENT'})}
        ])
        const ssh = createOpenSshClient({spawnImpl})

        await expect(ssh.connect({
            sshAlias: 'law-dev',
            username: 'runcloud',
            privateKeyPath: '/Users/example/.ssh/deploy_key'
        })).rejects.toThrow('Unable to start ssh: spawn ssh ENOENT')
        await expect(ssh.execCommand('true')).rejects.toThrow('OpenSSH client is not connected.')
    })
})
