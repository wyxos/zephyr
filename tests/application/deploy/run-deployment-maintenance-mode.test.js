import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
    mockAccess,
    mockConnect,
    mockDispose,
    mockExecCommand,
    mockPrompt,
    mockReadFile,
    mockReaddir,
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

describe('application/deploy/run-deployment maintenance mode recovery', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
        mockPrepareLocalDeployment.mockReset()
        mockPrepareLocalDeployment.mockResolvedValue({
            requiredPhpVersion: null,
            isLaravel: true,
            hasHook: false
        })
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('prompts to disable maintenance mode when a Laravel deployment fails after prerendered maintenance is enabled', async () => {
        mockReadFile.mockResolvedValueOnce('-----BEGIN RSA PRIVATE KEY-----')
        mockAccess.mockResolvedValue(undefined)
        mockReaddir.mockResolvedValueOnce([])

        mockConnect.mockResolvedValue()
        mockDispose.mockResolvedValue()
        mockPrompt
            .mockResolvedValueOnce({enableMaintenanceMode: true})
            .mockResolvedValueOnce({disableMaintenanceMode: true})

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

            if (command.includes('artisan down --help')) {
                return {
                    ...response,
                    stdout: '      --render[=RENDER]  Pre-render the maintenance mode view'
                }
            }

            if (command.includes('resources/views/errors/503.blade.php')) {
                return {...response, stdout: 'yes'}
            }

            if (command.includes('composer install')) {
                return {...response, stderr: 'composer failed', code: 1}
            }

            return response
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
            context: createAppContext()
        })).rejects.toThrow('Deployment failed: Command failed:')

        const executedCommands = mockExecCommand.mock.calls.map(([command]) => command)
        expect(
            executedCommands.findIndex((command) => command.includes('artisan down --render="errors::503"'))
        ).toBeGreaterThan(-1)
        expect(executedCommands.findIndex((command) => command.includes('composer install'))).toBeGreaterThan(-1)
        expect(executedCommands.findIndex((command) => command.includes('artisan up'))).toBeGreaterThan(
            executedCommands.findIndex((command) => command.includes('composer install'))
        )
        expect(mockPrompt).toHaveBeenCalledTimes(2)
    })

    it('automatically disables maintenance mode in non-interactive JSON mode after a failed deploy', async () => {
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

            if (command.includes('artisan down --help')) {
                return {
                    ...response,
                    stdout: '      --render[=RENDER]  Pre-render the maintenance mode view'
                }
            }

            if (command.includes('resources/views/errors/503.blade.php')) {
                return {...response, stdout: 'yes'}
            }

            if (command.includes('composer install')) {
                return {
                    ...response,
                    stderr: 'composer failed',
                    code: 1
                }
            }

            return response
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
                    maintenanceMode: true
                }
            })
        })).rejects.toThrow('Deployment failed: Command failed:')

        const executedCommands = mockExecCommand.mock.calls.map(([command]) => command)
        expect(
            executedCommands.findIndex((command) => command.includes('artisan down --render="errors::503"'))
        ).toBeGreaterThan(-1)
        expect(executedCommands.findIndex((command) => command.includes('artisan up'))).toBeGreaterThan(
            executedCommands.findIndex((command) => command.includes('composer install'))
        )
        expect(mockPrompt).not.toHaveBeenCalled()
        expect(process.stdout.write).toHaveBeenCalledWith(
            expect.stringContaining('"message":"Deployment failed after Laravel maintenance mode was enabled. Running `artisan up` automatically..."')
        )
    })
})
