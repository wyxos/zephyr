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
            changedFiles: ['app/Jobs/ProcessOrder.php'],
            taskLabels: ['Pull latest changes for main', 'Restart Horizon workers']
        }
        const logSuccess = vi.fn()

        const result = await buildRemoteDeploymentPlan({
            config: {branch: 'main', serverName: 'production', projectPath: '~/webapps/demo'},
            snapshot,
            requiredPhpVersion: '8.4.0',
            ssh,
            remoteCwd: '/home/runcloud/webapps/demo',
            executeRemote,
            logProcessing: vi.fn(),
            logSuccess,
            logWarning: vi.fn()
        })

        expect(executeRemote).not.toHaveBeenCalled()
        expect(mockFindPhpBinary).toHaveBeenCalledWith(ssh, '/home/runcloud/webapps/demo', '8.4.0')
        expect(mockPlanLaravelDeploymentTasks).toHaveBeenCalledWith({
            branch: 'main',
            isLaravel: true,
            changedFiles: ['app/Jobs/ProcessOrder.php'],
            horizonConfigured: true,
            phpCommand: 'php8.4'
        })
        expect(result.pendingSnapshot).toBe(snapshot)
        expect(result.usefulSteps).toBe(true)
        expect(logSuccess).toHaveBeenCalledWith('Laravel project detected.')
    })

    it('fetches the upstream diff and builds a new pending snapshot when needed', async () => {
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

                return {stdout: '', code: 0}
            })
        }

        const executeRemote = vi.fn(async (label) => {
            if (label === 'Inspect pending changes') {
                return {stdout: 'composer.json\nresources/js/app.js\n'}
            }

            return {stdout: ''}
        })

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
            logWarning: vi.fn()
        })

        expect(executeRemote).toHaveBeenNthCalledWith(1, 'Fetch latest changes for main', 'git fetch origin main')
        expect(executeRemote).toHaveBeenNthCalledWith(
            2,
            'Inspect pending changes',
            'git diff --name-only HEAD..origin/main',
            {printStdout: false}
        )
        expect(mockPlanLaravelDeploymentTasks).toHaveBeenCalledWith({
            branch: 'main',
            isLaravel: true,
            changedFiles: ['composer.json', 'resources/js/app.js'],
            horizonConfigured: false,
            phpCommand: 'php'
        })
        expect(result.pendingSnapshot).toEqual(expect.objectContaining({
            serverName: 'production',
            branch: 'main',
            projectPath: '~/webapps/demo',
            sshUser: 'forge',
            changedFiles: ['composer.json', 'resources/js/app.js'],
            taskLabels: ['Pull latest changes for main', 'Compile frontend assets']
        }))
        expect(typeof result.pendingSnapshot.createdAt).toBe('string')
    })
})
