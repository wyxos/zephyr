import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'

function getErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message
    }

    return String(error ?? 'Unknown OpenSSH error')
}

function quoteShellArgument(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function validateSshAlias(sshAlias) {
    const normalizedAlias = typeof sshAlias === 'string' ? sshAlias.trim() : ''

    if (!normalizedAlias || normalizedAlias.startsWith('-') || /\s/.test(normalizedAlias)) {
        throw new Error('OpenSSH alias must be a non-empty SSH config host without whitespace or a leading dash.')
    }

    return normalizedAlias
}

function createOpenSshArgs({sshAlias, username, privateKeyPath}, remoteCommand) {
    const args = [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-l',
        username,
        '-i',
        privateKeyPath,
        sshAlias
    ]

    if (remoteCommand) {
        args.push(remoteCommand)
    }

    return args
}

function createScpArgs({sshAlias, username, privateKeyPath}, remotePath, localPath) {
    return [
        '-q',
        '-o',
        'BatchMode=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        `User=${username}`,
        '-i',
        privateKeyPath,
        `${sshAlias}:${remotePath}`,
        localPath
    ]
}

function runOpenSshProcess(command, args, {spawnImpl = spawn, binaryStdout = false} = {}) {
    return new Promise((resolve, reject) => {
        const stdoutChunks = []
        const stderrChunks = []
        let settled = false

        const child = spawnImpl(command, args, {
            stdio: ['ignore', 'pipe', 'pipe']
        })

        child.stdout?.on('data', (chunk) => {
            stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        child.stderr?.on('data', (chunk) => {
            stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })

        child.on('error', (error) => {
            if (settled) {
                return
            }

            settled = true
            reject(new Error(`Unable to start ${command}: ${getErrorMessage(error)}`, {cause: error}))
        })
        child.on('close', (code) => {
            if (settled) {
                return
            }

            settled = true
            const stdoutBuffer = Buffer.concat(stdoutChunks)
            const stderr = Buffer.concat(stderrChunks).toString('utf8')

            resolve({
                code: typeof code === 'number' ? code : 1,
                stdout: binaryStdout ? stdoutBuffer : stdoutBuffer.toString('utf8'),
                stderr
            })
        })
    })
}

export function createOpenSshClient({spawnImpl = spawn} = {}) {
    let connectionOptions = null

    function assertConnected() {
        if (!connectionOptions) {
            throw new Error('OpenSSH client is not connected.')
        }
    }

    async function runRemoteCommand(command, {binaryStdout = false} = {}) {
        assertConnected()

        return await runOpenSshProcess(
            'ssh',
            createOpenSshArgs(connectionOptions, command),
            {spawnImpl, binaryStdout}
        )
    }

    return {
        async connect({sshAlias, username, privateKeyPath}) {
            const normalizedAlias = validateSshAlias(sshAlias)

            if (!username || !privateKeyPath) {
                throw new Error('OpenSSH alias connections require an SSH user and private key path.')
            }

            connectionOptions = {
                sshAlias: normalizedAlias,
                username,
                privateKeyPath
            }

            let result
            try {
                result = await runRemoteCommand('true')
            } catch (error) {
                connectionOptions = null
                throw error
            }

            if (result.code !== 0) {
                connectionOptions = null
                const detail = result.stderr.trim()
                const suffix = detail ? `: ${detail}` : ''
                throw new Error(`Failed to connect through OpenSSH alias "${normalizedAlias}"${suffix}`)
            }

            return this
        },

        async execCommand(command, {cwd} = {}) {
            const remoteCommand = cwd
                ? `cd -- ${quoteShellArgument(cwd)} && ${command}`
                : command

            return await runRemoteCommand(remoteCommand)
        },

        async getFile(localPath, remotePath, _sftp = null, transferOptions = {}) {
            assertConnected()
            const result = await runOpenSshProcess(
                'scp',
                createScpArgs(connectionOptions, remotePath, localPath),
                {spawnImpl}
            )

            if (result.code !== 0) {
                throw new Error(`Failed to download remote file ${remotePath}: ${result.stderr.trim()}`)
            }

            const fileStats = await fs.stat(localPath)
            transferOptions?.step?.(fileStats.size, fileStats.size, fileStats.size)
        },

        dispose() {
            connectionOptions = null
        }
    }
}
