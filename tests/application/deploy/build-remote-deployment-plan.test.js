import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    mockFindPhpBinary,
    mockPlanLaravelDeploymentTasks
} = vi.hoisted(() => ({
    mockFindPhpBinary: vi.fn(),
    mockPlanLaravelDeploymentTasks: vi.fn()
}))

vi.mock('#src/infrastructure/php/version.mjs', () => ({
    findPhpBinary: mockFindPhpBinary
}))

vi.mock('#src/application/deploy/plan-laravel-deployment-tasks.mjs', () => ({
    planLaravelDeploymentTasks: mockPlanLaravelDeploymentTasks
}))

import {buildRemoteDeploymentPlan} from '#src/application/deploy/build-remote-deployment-plan.mjs'

describe('application/deploy/build-remote-deployment-plan', () => {
    beforeEach(() => {
        mockFindPhpBinary.mockReset()
        mockPlanLaravelDeploymentTasks.mockReset()
    })

    it('uses the saved snapshot and resolved PHP binary when rebuilding a Laravel plan', async () => {
        mockFindPhpBinary.mockResolvedValue('php8.4')
        mockPlanLaravelDeploymentTasks.mockReturnValue([
            {label: 'Pull latest changes for main', command: 'git pull origin main'},
            {label: 'Restart Horizon workers', command: 'php8.4 artisan horizon:terminate'}
        ])

        const ssh = {
            execCommand: vi.fn(async (command) => {
                if (command.includes('grep -q "laravel/framework"')) {
                    return {stdout: 'yes', code: 0}
                }

                if (command.includes('config/horizon.php')) {
                    return {stdout: 'yes', code: 0}
                }

                return {stdout: '', code: 0}
            })
        }

        const executeRemote = vi.fn()
        const snapshot = {
            maintenanceModeEnabled: true,
            maintenanceModeUsesPrerender: true,
            maintenanceModeRenderView: 'errors::503',
            changedFiles: ['app/Jobs/ProcessOrder.php'],
            taskLabels: ['Pull latest changes for main', 'Restart Horizon workers']
        }
        const logSuccess = vi.fn()
        const runPrompt = vi.fn()

        const result = await buildRemoteDeploymentPlan({
            config: {branch: 'main', serverName: 'production', projectPath: '~/webapps/demo'},
            snapshot,
            requiredPhpVersion: '8.4.0',
            ssh,
            remoteCwd: '/home/runcloud/webapps/demo',
            executeRemote,
            logProcessing: vi.fn(),
            logSuccess,
            runPrompt,
            logWarning: vi.fn()
        })

        expect(executeRemote).not.toHaveBeenCalled()
        expect(mockFindPhpBinary).toHaveBeenCalledWith(ssh, '/home/runcloud/webapps/demo', '8.4.0')
        expect(mockPlanLaravelDeploymentTasks).toHaveBeenCalledWith({
            branch: 'main',
            isLaravel: true,
            changedFiles: ['app/Jobs/ProcessOrder.php'],
            horizonConfigured: true,
            phpCommand: 'php8.4',
            maintenanceMode: true,
            maintenanceDownCommand: 'php8.4 artisan down --render="errors::503"',
            maintenanceUpCommand: 'php8.4 artisan up'
        })
        expect(result.pendingSnapshot).toBe(snapshot)
        expect(result.maintenanceModeUsesPrerender).toBe(true)
        expect(result.maintenanceModeRenderView).toBe('errors::503')
        expect(result.usefulSteps).toBe(true)
        expect(logSuccess).toHaveBeenCalledWith('Laravel project detected.')
        expect(runPrompt).not.toHaveBeenCalled()
    })

    it('fails before planning when no remote PHP binary satisfies the detected requirement', async () => {
        mockFindPhpBinary.mockRejectedValue(new Error('No PHP binary satisfying 8.4.0 was found on the remote server. The default php command reports 8.3.29.'))

        const ssh = {
            execCommand: vi.fn(async (command) => {
                if (command.includes('grep -q "laravel/framework"')) {
                    return {stdout: 'yes', code: 0}
                }

                if (command.includes('config/horizon.php')) {
                    return {stdout: 'no', code: 0}
                }

                return {stdout: '', code: 0}
            })
        }

        const executeRemote = vi.fn(async (label) => {
            if (label === 'Inspect pending changes') {
                return {stdout: 'composer.json\n', code: 0}
            }

            return {stdout: '', stderr: '', code: 0}
        })

        await expect(buildRemoteDeploymentPlan({
            config: {
                branch: 'main',
                serverName: 'production',
                projectPath: '~/webapps/demo',
                sshUser: 'forge'
            },
            requiredPhpVersion: '8.4.0',
            ssh,
            remoteCwd: '/home/runcloud/webapps/demo',
            executeRemote,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })).rejects.toThrow(
            'No PHP binary satisfying 8.4.0 was found on the remote server. The default php command reports 8.3.29.'
        )
    })

    it('uses an explicit interactive maintenance-mode choice without prompting', async () => {
        mockPlanLaravelDeploymentTasks.mockReturnValue([
            {label: 'Pull latest changes for main', command: 'git pull origin main'},
            {label: 'Compile frontend assets', command: 'npm run build'}
        ])

        const ssh = {
            execCommand: vi.fn(async (command) => {
                if (command.includes('grep -q "laravel/framework"')) {
                    return {stdout: 'yes', code: 0}
                }

                if (command.includes('config/horizon.php')) {
                    return {stdout: 'no', code: 0}
                }

                return {stdout: '', code: 0}
            })
        }

        const executeRemote = vi.fn(async (label) => {
            if (label === 'Inspect pending changes') {
                return {stdout: 'composer.json\nresources/js/app.js\n', code: 0}
            }

            return {stdout: '', stderr: '', code: 0}
        })
        const runPrompt = vi.fn()

        const result = await buildRemoteDeploymentPlan({
            config: {
                branch: 'main',
                serverName: 'production',
                projectPath: '~/webapps/demo',
                sshUser: 'forge'
            },
            ssh,
            remoteCwd: '/home/runcloud/webapps/demo',
            executeRemote,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            runPrompt,
            logWarning: vi.fn(),
            executionMode: {
                interactive: true,
                maintenanceMode: false
            }
        })

        expect(runPrompt).not.toHaveBeenCalled()
        expect(mockPlanLaravelDeploymentTasks).toHaveBeenCalledWith({
            branch: 'main',
            isLaravel: true,
            changedFiles: ['composer.json', 'resources/js/app.js'],
            horizonConfigured: false,
            phpCommand: 'php',
            maintenanceMode: false,
            maintenanceDownCommand: null,
            maintenanceUpCommand: 'php artisan up'
        })
        expect(result.maintenanceModeEnabled).toBe(false)
        expect(result.pendingSnapshot).toEqual(expect.objectContaining({
            maintenanceModeEnabled: false,
            maintenanceModeUsesPrerender: false,
            maintenanceModeRenderView: null
        }))
    })

    it('uses prerendered maintenance mode when the remote Laravel app supports it', async () => {
        mockFindPhpBinary.mockResolvedValue('php')
        mockPlanLaravelDeploymentTasks.mockReturnValue([
            {label: 'Pull latest changes for main', command: 'git pull origin main'},
            {label: 'Compile frontend assets', command: 'npm run build'}
        ])

        const ssh = {
            execCommand: vi.fn(async (command) => {
                if (command.includes('grep -q "laravel/framework"')) {
                    return {stdout: 'yes', code: 0}
                }

                if (command.includes('config/horizon.php')) {
                    return {stdout: 'no', code: 0}
                }

                if (command.includes('resources/views/errors/503.blade.php')) {
                    return {stdout: 'yes', code: 0}
                }

                return {stdout: '', code: 0}
            })
        }

        const executeRemote = vi.fn(async (label) => {
            if (label === 'Inspect pending changes') {
                return {stdout: 'composer.json\nresources/js/app.js\n', code: 0}
            }

            if (label === 'Inspect Laravel maintenance mode capabilities') {
                return {stdout: '      --render[=RENDER]  Pre-render the maintenance mode view', stderr: '', code: 0}
            }

            return {stdout: '', stderr: '', code: 0}
        })
        const runPrompt = vi.fn().mockResolvedValue({enableMaintenanceMode: true})

        const result = await buildRemoteDeploymentPlan({
            config: {
                branch: 'main',
                serverName: 'production',
                projectPath: '~/webapps/demo',
                sshUser: 'forge'
            },
            requiredPhpVersion: null,
            ssh,
            remoteCwd: '/home/runcloud/webapps/demo',
            executeRemote,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            runPrompt,
            logWarning: vi.fn()
        })

        expect(executeRemote).toHaveBeenNthCalledWith(1, 'Fetch latest changes for main', 'git fetch origin main')
        expect(executeRemote).toHaveBeenNthCalledWith(
            2,
            'Inspect pending changes',
            'git diff --name-only HEAD..origin/main',
            {printStdout: false}
        )
        expect(executeRemote).toHaveBeenNthCalledWith(
            3,
            'Inspect Laravel maintenance mode capabilities',
            'php artisan down --help',
            {printStdout: false, allowFailure: true}
        )
        expect(mockPlanLaravelDeploymentTasks).toHaveBeenCalledWith({
            branch: 'main',
            isLaravel: true,
            changedFiles: ['composer.json', 'resources/js/app.js'],
            horizonConfigured: false,
            phpCommand: 'php',
            maintenanceMode: true,
            maintenanceDownCommand: 'php artisan down --render="errors::503"',
            maintenanceUpCommand: 'php artisan up'
        })
        expect(runPrompt).toHaveBeenCalledTimes(1)
        expect(result.pendingSnapshot).toEqual(expect.objectContaining({
            serverName: 'production',
            branch: 'main',
            projectPath: '~/webapps/demo',
            sshUser: 'forge',
            maintenanceModeEnabled: true,
            maintenanceModeUsesPrerender: true,
            maintenanceModeRenderView: 'errors::503',
            changedFiles: ['composer.json', 'resources/js/app.js'],
            taskLabels: ['Pull latest changes for main', 'Compile frontend assets']
        }))
        expect(typeof result.pendingSnapshot.createdAt).toBe('string')
    })

    it('falls back to standard maintenance mode when the prerendered view is missing', async () => {
        mockFindPhpBinary.mockResolvedValue('php')
        mockPlanLaravelDeploymentTasks.mockReturnValue([
            {label: 'Pull latest changes for main', command: 'git pull origin main'},
            {label: 'Install Composer dependencies', command: 'php composer install'}
        ])

        const logWarning = vi.fn()
        const ssh = {
            execCommand: vi.fn(async (command) => {
                if (command.includes('grep -q "laravel/framework"')) {
                    return {stdout: 'yes', code: 0}
                }

                if (command.includes('config/horizon.php')) {
                    return {stdout: 'no', code: 0}
                }

                if (command.includes('resources/views/errors/503.blade.php')) {
                    return {stdout: 'no', code: 0}
                }

                return {stdout: '', code: 0}
            })
        }

        const executeRemote = vi.fn(async (label) => {
            if (label === 'Inspect pending changes') {
                return {stdout: 'composer.json\n', code: 0}
            }

            if (label === 'Inspect Laravel maintenance mode capabilities') {
                return {stdout: '      --render[=RENDER]  Pre-render the maintenance mode view', stderr: '', code: 0}
            }

            return {stdout: '', stderr: '', code: 0}
        })
        const runPrompt = vi.fn().mockResolvedValue({enableMaintenanceMode: true})

        const result = await buildRemoteDeploymentPlan({
            config: {
                branch: 'main',
                serverName: 'production',
                projectPath: '~/webapps/demo',
                sshUser: 'forge'
            },
            requiredPhpVersion: null,
            ssh,
            remoteCwd: '/home/runcloud/webapps/demo',
            executeRemote,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            runPrompt,
            logWarning
        })

        expect(mockPlanLaravelDeploymentTasks).toHaveBeenCalledWith({
            branch: 'main',
            isLaravel: true,
            changedFiles: ['composer.json'],
            horizonConfigured: false,
            phpCommand: 'php',
            maintenanceMode: true,
            maintenanceDownCommand: 'php artisan down',
            maintenanceUpCommand: 'php artisan up'
        })
        expect(result.maintenanceModeUsesPrerender).toBe(false)
        expect(result.maintenanceModeRenderView).toBeNull()
        expect(logWarning).toHaveBeenCalledWith(
            'Laravel supports prerendered maintenance mode, but resources/views/errors/503.blade.php is missing; using standard maintenance mode.'
        )
    })

    it('fails early when the deploy user cannot write to Laravel cache directories', async () => {
        mockFindPhpBinary.mockResolvedValue('php')
        mockPlanLaravelDeploymentTasks.mockReturnValue([
            {label: 'Pull latest changes for main', command: 'git pull origin main'},
            {label: 'Clear Laravel caches', command: 'php artisan cache:clear && php artisan config:clear && php artisan view:clear'}
        ])

        const ssh = {
            execCommand: vi.fn(async (command) => {
                if (command.includes('grep -q "laravel/framework"')) {
                    return {stdout: 'yes', code: 0}
                }

                if (command.includes('config/horizon.php')) {
                    return {stdout: 'no', code: 0}
                }

                if (command.includes('bootstrap/cache')) {
                    return {stdout: 'no|forge|www-data|755', code: 0}
                }

                if (command.includes('storage/framework/cache')) {
                    return {stdout: 'yes|forge|www-data|775', code: 0}
                }

                if (command.includes('storage/framework/views')) {
                    return {stdout: 'yes|forge|www-data|775', code: 0}
                }

                if (command.includes('storage/framework/sessions')) {
                    return {stdout: 'yes|forge|www-data|775', code: 0}
                }

                return {stdout: '', code: 0}
            })
        }

        const executeRemote = vi.fn(async (label) => {
            if (label === 'Inspect pending changes') {
                return {stdout: 'app/Console/Kernel.php\n', code: 0}
            }

            return {stdout: '', stderr: '', code: 0}
        })

        await expect(buildRemoteDeploymentPlan({
            config: {
                branch: 'main',
                serverName: 'production',
                projectPath: '~/webapps/demo',
                sshUser: 'forge'
            },
            ssh,
            remoteCwd: '/home/forge/webapps/demo',
            executeRemote,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn()
        })).rejects.toThrow(
            'Laravel cache-related deployment tasks cannot run because the SSH deploy user cannot write to required directories:\n' +
            ' - bootstrap/cache (owner forge:www-data, mode 755)'
        )
    })

    it('warns when Laravel cache directories are writable but not group-writable', async () => {
        mockFindPhpBinary.mockResolvedValue('php')
        mockPlanLaravelDeploymentTasks.mockReturnValue([
            {label: 'Pull latest changes for main', command: 'git pull origin main'},
            {label: 'Clear Laravel caches', command: 'php artisan cache:clear && php artisan config:clear && php artisan view:clear'}
        ])

        const logProcessing = vi.fn()
        const logWarning = vi.fn()
        const ssh = {
            execCommand: vi.fn(async (command) => {
                if (command.includes('grep -q "laravel/framework"')) {
                    return {stdout: 'yes', code: 0}
                }

                if (command.includes('config/horizon.php')) {
                    return {stdout: 'no', code: 0}
                }

                if (command.includes('bootstrap/cache')) {
                    return {stdout: 'yes|forge|www-data|755', code: 0}
                }

                if (command.includes('storage/framework/cache')) {
                    return {stdout: 'yes|forge|www-data|775', code: 0}
                }

                if (command.includes('storage/framework/views')) {
                    return {stdout: 'yes|forge|www-data|775', code: 0}
                }

                if (command.includes('storage/framework/sessions')) {
                    return {stdout: 'yes|forge|www-data|775', code: 0}
                }

                return {stdout: '', code: 0}
            })
        }

        const executeRemote = vi.fn(async (label) => {
            if (label === 'Inspect pending changes') {
                return {stdout: 'app/Console/Kernel.php\n', code: 0}
            }

            return {stdout: '', stderr: '', code: 0}
        })

        await buildRemoteDeploymentPlan({
            config: {
                branch: 'main',
                serverName: 'production',
                projectPath: '~/webapps/demo',
                sshUser: 'forge'
            },
            ssh,
            remoteCwd: '/home/forge/webapps/demo',
            executeRemote,
            logProcessing,
            logSuccess: vi.fn(),
            logWarning
        })

        expect(logProcessing).toHaveBeenCalledWith('Checking Laravel writable directories for deploy user forge...')
        expect(logWarning).toHaveBeenCalledWith(
            'bootstrap/cache is writable by the deploy user (forge:www-data, mode 755), but it is not group-writable. Web-created cache files may cause later permission drift.'
        )
    })

    it('requires an explicit maintenance-mode flag for non-interactive Laravel deploys', async () => {
        mockFindPhpBinary.mockResolvedValue('php')

        const ssh = {
            execCommand: vi.fn(async (command) => {
                if (command.includes('grep -q "laravel/framework"')) {
                    return {stdout: 'yes', code: 0}
                }

                if (command.includes('config/horizon.php')) {
                    return {stdout: 'no', code: 0}
                }

                return {stdout: '', code: 0}
            })
        }

        const executeRemote = vi.fn(async (label) => {
            if (label === 'Inspect pending changes') {
                return {stdout: 'composer.json\n', code: 0}
            }

            return {stdout: '', stderr: '', code: 0}
        })

        await expect(buildRemoteDeploymentPlan({
            config: {
                branch: 'main',
                serverName: 'production',
                projectPath: '~/webapps/demo',
                sshUser: 'forge'
            },
            ssh,
            remoteCwd: '/home/forge/webapps/demo',
            executeRemote,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            runPrompt: vi.fn(),
            executionMode: {
                interactive: false,
                maintenanceMode: null
            }
        })).rejects.toMatchObject({
            code: 'ZEPHYR_MAINTENANCE_FLAG_REQUIRED'
        })
    })
})
