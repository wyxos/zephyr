import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
    mockConnect,
    mockDispose,
    mockExecCommand,
    mockReadFile,
    mockReaddir,
    mockAccess,
    mockSpawn,
    mockWriteFile,
    queueSpawnResponse,
    setupRuntimeTestEnv,
    teardownRuntimeTestEnv
} from '../../helpers/runtime-test-env.mjs'

describe('application/deploy/run-deployment', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('schedules Laravel tasks based on diff', async () => {
        mockReadFile
            .mockResolvedValueOnce('{"require":{"laravel/framework":"^10.0"}}')
            .mockResolvedValueOnce('{"require":{"laravel/framework":"^10.0","php":"^8.4"}}')
            .mockResolvedValueOnce('{"scripts":{}}')
            .mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----')
        mockAccess.mockImplementation(async (filePath) => {
            if (filePath.includes('artisan')) {
                return undefined
            }
            if (filePath.includes('pre-push')) {
                throw new Error('ENOENT')
            }
            if (filePath.includes('vendor/bin/pint')) {
                throw new Error('ENOENT')
            }
            return undefined
        })
        mockReaddir.mockResolvedValueOnce([])
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: ''})
        queueSpawnResponse({})

        mockConnect.mockResolvedValue()
        mockDispose.mockResolvedValue()

        mockExecCommand.mockImplementation(async (command) => {
            const response = {stdout: '', stderr: '', code: 0}

            if (command.includes('printf "%s" "$HOME"')) {
                return {...response, stdout: '/home/runcloud'}
            }

            if (command.includes('LOCK_NOT_FOUND') || command.includes('deploy.lock')) {
                if (command.includes('cat')) {
                    return {...response, stdout: 'LOCK_NOT_FOUND'}
                }
                return response
            }

            if (command.includes('grep -q "laravel/framework"')) {
                return {...response, stdout: 'yes'}
            }

            if (command.includes('git diff')) {
                return {
                    ...response,
                    stdout:
                        'composer.json\n' +
                        'package.json\n' +
                        'database/migrations/2025_10_21_000000_create_table.php\n' +
                        'resources/js/app.js\n' +
                        'resources/views/welcome.blade.php\n' +
                        'config/horizon.php\n'
                }
            }

            if (command.includes('config/horizon.php')) {
                return {...response, stdout: 'yes'}
            }

            return response
        })

        const {runDeployment} = await import('../../../src/application/deploy/run-deployment.mjs')
        const {createAppContext} = await import('../../../src/runtime/app-context.mjs')

        await runDeployment({
            serverIp: '127.0.0.1',
            projectPath: '~/app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }, {
            context: createAppContext()
        })

        const executedCommands = mockExecCommand.mock.calls.map(([cmd]) => cmd)
        expect(executedCommands.some((cmd) => cmd.includes('git pull origin main'))).toBe(true)
        expect(executedCommands.some((cmd) => cmd.includes('composer install'))).toBe(true)
        expect(executedCommands.some((cmd) => cmd.includes('php artisan migrate'))).toBe(true)
        expect(executedCommands.some((cmd) => cmd.includes('npm install'))).toBe(true)
        expect(executedCommands.some((cmd) => cmd.includes('npm run build'))).toBe(true)
        expect(executedCommands.some((cmd) => cmd.includes('cache:clear'))).toBe(true)
        expect(executedCommands.some((cmd) => cmd.includes('horizon:terminate'))).toBe(true)

        const lockFileWrites = mockWriteFile.mock.calls.filter(([filePath]) =>
            filePath.includes('deploy.lock')
        )
        expect(lockFileWrites.length).toBeGreaterThan(0)

        const phpTestCalls = mockSpawn.mock.calls.filter(([cmd, args]) => {
            if (typeof cmd === 'string' && cmd.startsWith('php') && cmd.includes('artisan') && cmd.includes('test') && cmd.includes('--compact')) {
                return true
            }

            return cmd === 'php' && Array.isArray(args) && args.includes('artisan') && args.includes('test') && args.includes('--compact')
        })

        expect(phpTestCalls.length).toBeGreaterThan(0)
    })

    it('skips Laravel tests when pre-push hook exists', async () => {
        mockReadFile.mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----')
        mockAccess.mockImplementation(async (filePath) => {
            if (filePath.includes('pre-push')) {
                return undefined
            }

            if (filePath.includes('.ssh') || filePath.includes('id_rsa')) {
                return undefined
            }

            throw new Error('ENOENT')
        })
        mockReaddir.mockResolvedValueOnce([])
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: ''})

        mockConnect.mockResolvedValue()
        mockDispose.mockResolvedValue()
        mockExecCommand.mockImplementation(async (command) => {
            const response = {stdout: '', stderr: '', code: 0}

            if (command.includes('printf "%s" "$HOME"')) {
                return {...response, stdout: '/home/runcloud'}
            }

            if (command.includes('LOCK_NOT_FOUND') || command.includes('deploy.lock')) {
                if (command.includes('cat')) {
                    return {...response, stdout: 'LOCK_NOT_FOUND'}
                }
                return response
            }

            if (command.includes('grep -q "laravel/framework"')) {
                return {...response, stdout: 'yes'}
            }

            if (command.includes('git diff')) {
                return {...response, stdout: 'composer.json\n'}
            }

            return response
        })

        const {runDeployment} = await import('../../../src/application/deploy/run-deployment.mjs')
        const {createAppContext} = await import('../../../src/runtime/app-context.mjs')

        await runDeployment({
            serverIp: '127.0.0.1',
            projectPath: '~/app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }, {
            context: createAppContext()
        })

        const phpTestCalls = mockSpawn.mock.calls.filter(
            ([cmd, args]) => cmd === 'php' && Array.isArray(args) && args.includes('artisan') && args.includes('test')
        )
        expect(phpTestCalls.length).toBe(0)
    })

    it('skips Laravel tasks when framework is not detected remotely', async () => {
        mockReadFile.mockResolvedValue('-----BEGIN RSA PRIVATE KEY-----')
        mockReaddir.mockResolvedValueOnce([])
        queueSpawnResponse({stdout: 'main\n'})
        queueSpawnResponse({stdout: ''})

        mockConnect.mockResolvedValue()
        mockDispose.mockResolvedValue()
        mockExecCommand
            .mockResolvedValueOnce({stdout: '/home/runcloud', stderr: '', code: 0})
            .mockResolvedValueOnce({stdout: 'LOCK_NOT_FOUND', stderr: '', code: 0})
            .mockResolvedValueOnce({stdout: 'no', stderr: '', code: 0})
            .mockResolvedValue({stdout: '', stderr: '', code: 0})

        const {runDeployment} = await import('../../../src/application/deploy/run-deployment.mjs')
        const {createAppContext} = await import('../../../src/runtime/app-context.mjs')

        await runDeployment({
            serverIp: '127.0.0.1',
            projectPath: '~/app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }, {
            context: createAppContext()
        })

        const executedCommands = mockExecCommand.mock.calls.map(([cmd]) => cmd)
        expect(executedCommands.every((cmd) => !cmd.includes('composer install'))).toBe(true)
        expect(executedCommands.some((cmd) => cmd.includes('git pull origin main'))).toBe(true)
    })
})
