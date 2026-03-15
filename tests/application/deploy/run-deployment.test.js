import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

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
} from '#tests/helpers/runtime-test-env.mjs'

const {
    mockPrepareLocalDeployment
} = vi.hoisted(() => ({
    mockPrepareLocalDeployment: vi.fn()
}))

vi.mock('#src/application/deploy/prepare-local-deployment.mjs', () => ({
    prepareLocalDeployment: mockPrepareLocalDeployment
}))

describe('application/deploy/run-deployment', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
        mockPrepareLocalDeployment.mockReset()
        mockPrepareLocalDeployment.mockResolvedValue({
            requiredPhpVersion: '8.4.0',
            isLaravel: true,
            hasHook: false
        })
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('schedules Laravel tasks based on diff', async () => {
        mockReadFile.mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----')
        mockAccess.mockImplementation(async (filePath) => {
            return undefined
        })
        mockReaddir.mockResolvedValueOnce([])

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

        const {runDeployment} = await import('#src/application/deploy/run-deployment.mjs')
        const {createAppContext} = await import('#src/runtime/app-context.mjs')

        await runDeployment({
            serverIp: '127.0.0.1',
            projectPath: '~/app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }, {
            context: createAppContext()
        })

        expect(mockPrepareLocalDeployment).toHaveBeenCalledWith(expect.objectContaining({
            branch: 'main'
        }), expect.objectContaining({
            rootDir: process.cwd()
        }))

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
    })

    it('skips Laravel tests when pre-push hook exists', async () => {
        mockPrepareLocalDeployment.mockResolvedValue({
            requiredPhpVersion: '8.4.0',
            isLaravel: true,
            hasHook: true
        })
        mockReadFile.mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----')
        mockAccess.mockResolvedValue(undefined)
        mockReaddir.mockResolvedValueOnce([])

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

        const {runDeployment} = await import('#src/application/deploy/run-deployment.mjs')
        const {createAppContext} = await import('#src/runtime/app-context.mjs')

        await runDeployment({
            serverIp: '127.0.0.1',
            projectPath: '~/app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }, {
            context: createAppContext()
        })

        expect(mockPrepareLocalDeployment).toHaveBeenCalled()
    })

    it('skips Laravel tasks when framework is not detected remotely', async () => {
        mockReadFile.mockResolvedValue('-----BEGIN RSA PRIVATE KEY-----')
        mockReaddir.mockResolvedValueOnce([])

        mockConnect.mockResolvedValue()
        mockDispose.mockResolvedValue()
        mockExecCommand
            .mockResolvedValueOnce({stdout: '/home/runcloud', stderr: '', code: 0})
            .mockResolvedValueOnce({stdout: 'LOCK_NOT_FOUND', stderr: '', code: 0})
            .mockResolvedValueOnce({stdout: 'no', stderr: '', code: 0})
            .mockResolvedValue({stdout: '', stderr: '', code: 0})

        const {runDeployment} = await import('#src/application/deploy/run-deployment.mjs')
        const {createAppContext} = await import('#src/runtime/app-context.mjs')

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
