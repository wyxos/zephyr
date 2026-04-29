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

            if (command.includes('ls -1 /RunCloud/Packages')) {
                return {...response, stdout: 'php84rc\n'}
            }

            if (command.includes('/RunCloud/Packages/php84rc/bin/php -r "echo PHP_VERSION;"')) {
                return {...response, stdout: '8.4.6'}
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

            if (command.includes('bootstrap/cache')) {
                return {...response, stdout: 'yes|forge|www-data|775'}
            }

            if (command.includes('storage/framework/cache')) {
                return {...response, stdout: 'yes|forge|www-data|775'}
            }

            if (command.includes('storage/framework/views')) {
                return {...response, stdout: 'yes|forge|www-data|775'}
            }

            if (command.includes('storage/framework/sessions')) {
                return {...response, stdout: 'yes|forge|www-data|775'}
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

            if (command.includes('ls -1 /RunCloud/Packages')) {
                return {...response, stdout: 'php84rc\n'}
            }

            if (command.includes('/RunCloud/Packages/php84rc/bin/php -r "echo PHP_VERSION;"')) {
                return {...response, stdout: '8.4.6'}
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

    it('passes deploy skip flags through execution mode into local deployment prep', async () => {
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

            if (command.includes('ls -1 /RunCloud/Packages')) {
                return {...response, stdout: 'php84rc\n'}
            }

            if (command.includes('/RunCloud/Packages/php84rc/bin/php -r "echo PHP_VERSION;"')) {
                return {...response, stdout: '8.4.6'}
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
        const context = createAppContext({
            executionMode: {
                workflow: 'deploy',
                skipLint: true,
                skipTests: true
            }
        })

        await runDeployment({
            serverIp: '127.0.0.1',
            projectPath: '~/app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }, {
            context
        })

        expect(mockPrepareLocalDeployment).toHaveBeenCalledWith(expect.objectContaining({
            branch: 'main'
        }), expect.objectContaining({
            rootDir: process.cwd(),
            skipLint: true,
            skipTests: true
        }))
    })

    it('skips Laravel tasks when framework is not detected remotely', async () => {
        mockReadFile.mockResolvedValue('-----BEGIN RSA PRIVATE KEY-----')
        mockReaddir.mockResolvedValueOnce([])

        mockConnect.mockResolvedValue()
        mockDispose.mockResolvedValue()
        mockExecCommand.mockImplementation(async (command) => {
            const response = {stdout: '', stderr: '', code: 0}

            if (command.includes('printf "%s" "$HOME"')) {
                return {...response, stdout: '/home/runcloud'}
            }

            if (command.includes('ls -1 /RunCloud/Packages')) {
                return {...response, stdout: 'php84rc\n'}
            }

            if (command.includes('/RunCloud/Packages/php84rc/bin/php -r "echo PHP_VERSION;"')) {
                return {...response, stdout: '8.4.6'}
            }

            if (command.includes('LOCK_NOT_FOUND') || command.includes('deploy.lock')) {
                if (command.includes('cat')) {
                    return {...response, stdout: 'LOCK_NOT_FOUND'}
                }

                return response
            }

            if (command.includes('grep -q "laravel/framework"')) {
                return {...response, stdout: 'no'}
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

        const executedCommands = mockExecCommand.mock.calls.map(([cmd]) => cmd)
        expect(executedCommands.every((cmd) => !cmd.includes('composer install'))).toBe(true)
        expect(executedCommands.some((cmd) => cmd.includes('git pull origin main'))).toBe(true)
    })

    it('verifies setup for a Laravel app without running remote commands', async () => {
        mockAccess.mockResolvedValue(undefined)
        mockReadFile.mockImplementation(async (filePath) => {
            if (String(filePath).endsWith('composer.json')) {
                return JSON.stringify({
                    require: {
                        'laravel/framework': '^11.0'
                    }
                })
            }

            return '-----BEGIN RSA PRIVATE KEY-----'
        })
        mockConnect.mockResolvedValue()
        mockDispose.mockResolvedValue()

        const {runDeployment} = await import('#src/application/deploy/run-deployment.mjs')
        const {createAppContext} = await import('#src/runtime/app-context.mjs')

        await runDeployment({
            serverIp: '127.0.0.1',
            projectPath: '~/app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }, {
            context: createAppContext({
                executionMode: {
                    workflow: 'deploy',
                    setup: true
                }
            })
        })

        expect(mockConnect).toHaveBeenCalledWith({
            host: '127.0.0.1',
            username: 'forge',
            privateKey: '-----BEGIN RSA PRIVATE KEY-----'
        })
        expect(mockExecCommand).not.toHaveBeenCalled()
        expect(mockPrepareLocalDeployment).not.toHaveBeenCalled()
        expect(mockWriteFile).not.toHaveBeenCalledWith(expect.stringContaining('deploy.lock'), expect.anything())
    })

    it('fails setup before connecting when the local project is not Laravel', async () => {
        mockAccess.mockImplementation(async (filePath) => {
            if (String(filePath).endsWith('artisan')) {
                throw new Error('ENOENT')
            }

            return undefined
        })

        const {runDeployment} = await import('#src/application/deploy/run-deployment.mjs')
        const {createAppContext} = await import('#src/runtime/app-context.mjs')

        await expect(runDeployment({
            serverIp: '127.0.0.1',
            projectPath: '~/app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }, {
            context: createAppContext({
                executionMode: {
                    workflow: 'deploy',
                    setup: true
                }
            })
        })).rejects.toMatchObject({
            code: 'ZEPHYR_SETUP_REQUIRES_LARAVEL'
        })

        expect(mockConnect).not.toHaveBeenCalled()
        expect(mockExecCommand).not.toHaveBeenCalled()
        expect(mockPrepareLocalDeployment).not.toHaveBeenCalled()
    })

    it('fails before local preparation when a non-interactive Laravel deploy omits maintenance mode', async () => {
        mockReadFile.mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----')
        mockReaddir.mockResolvedValueOnce([])
        mockConnect.mockResolvedValue()
        mockDispose.mockResolvedValue()

        mockExecCommand.mockImplementation(async (command) => {
            if (command.includes('printf "%s" "$HOME"')) {
                return {stdout: '/home/runcloud', stderr: '', code: 0}
            }

            if (command.includes('grep -q "laravel/framework"')) {
                return {stdout: 'yes', stderr: '', code: 0}
            }

            return {stdout: '', stderr: '', code: 0}
        })

        const {runDeployment} = await import('#src/application/deploy/run-deployment.mjs')
        const {createAppContext} = await import('#src/runtime/app-context.mjs')

        await expect(runDeployment({
            serverIp: '127.0.0.1',
            projectPath: '~/app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }, {
            context: createAppContext({
                executionMode: {
                    interactive: false,
                    json: true,
                    workflow: 'deploy',
                    maintenanceMode: null
                }
            })
        })).rejects.toThrow(
            'Deployment failed: Zephyr cannot run this Laravel deployment non-interactively without an explicit maintenance-mode decision. Pass --maintenance on or --maintenance off.'
        )

        expect(mockPrepareLocalDeployment).not.toHaveBeenCalled()
    })
})
