import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
    appContext,
    configurationService,
    mockAccess,
    mockCreateConfigurationService,
    mockEnsureGitignoreEntry,
    mockEnsureProjectReleaseScript,
    mockReleaseNode,
    mockReleasePackagist,
    mockResolvePendingSnapshot,
    mockRunDeployment,
    mockSelectDeploymentTarget,
    mockValidateLocalDependencies,
    mockWriteStderrLine
} = vi.hoisted(() => ({
    appContext: {
        logProcessing: vi.fn(),
        logSuccess: vi.fn(),
        logWarning: vi.fn(),
        logError: vi.fn(),
        runPrompt: vi.fn(),
        runCommand: vi.fn(),
        runCommandCapture: vi.fn(),
        createSshClient: vi.fn(),
        emitEvent: vi.fn(),
        hasInteractiveTerminal: true,
        executionMode: {
            interactive: true,
            json: false,
            workflow: 'deploy',
            presetName: null,
            maintenanceMode: null,
            skipGitHooks: false,
            resumePending: false,
            discardPending: false
        }
    },
    configurationService: {
        selectServer: vi.fn(),
        selectApp: vi.fn(),
        selectPreset: vi.fn(),
        ensureSshDetails: vi.fn()
    },
    mockAccess: vi.fn(),
    mockCreateConfigurationService: vi.fn(),
    mockEnsureGitignoreEntry: vi.fn(),
    mockEnsureProjectReleaseScript: vi.fn(),
    mockReleaseNode: vi.fn(),
    mockReleasePackagist: vi.fn(),
    mockResolvePendingSnapshot: vi.fn(),
    mockRunDeployment: vi.fn(),
    mockSelectDeploymentTarget: vi.fn(),
    mockValidateLocalDependencies: vi.fn(),
    mockWriteStderrLine: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
    default: {
        access: mockAccess
    },
    access: mockAccess
}))

vi.mock('#src/release-node.mjs', () => ({
    releaseNode: mockReleaseNode
}))

vi.mock('#src/release-packagist.mjs', () => ({
    releasePackagist: mockReleasePackagist
}))

vi.mock('#src/dependency-scanner.mjs', () => ({
    validateLocalDependencies: mockValidateLocalDependencies
}))

vi.mock('#src/project/bootstrap.mjs', () => ({
    ensureGitignoreEntry: mockEnsureGitignoreEntry,
    ensureProjectReleaseScript: mockEnsureProjectReleaseScript
}))

vi.mock('#src/utils/output.mjs', () => ({
    writeStderrLine: mockWriteStderrLine
}))

vi.mock('#src/runtime/app-context.mjs', () => ({
    createAppContext: () => appContext
}))

vi.mock('#src/application/configuration/service.mjs', () => ({
    createConfigurationService: mockCreateConfigurationService
}))

vi.mock('#src/application/configuration/select-deployment-target.mjs', () => ({
    selectDeploymentTarget: mockSelectDeploymentTarget
}))

vi.mock('#src/application/deploy/resolve-pending-snapshot.mjs', () => ({
    resolvePendingSnapshot: mockResolvePendingSnapshot
}))

vi.mock('#src/application/deploy/run-deployment.mjs', () => ({
    runDeployment: mockRunDeployment
}))

describe('main entrypoint', () => {
    beforeEach(() => {
        vi.resetModules()

        mockAccess.mockReset()
        mockCreateConfigurationService.mockReset()
        mockEnsureGitignoreEntry.mockReset()
        mockEnsureProjectReleaseScript.mockReset()
        mockReleaseNode.mockReset()
        mockReleasePackagist.mockReset()
        mockResolvePendingSnapshot.mockReset()
        mockRunDeployment.mockReset()
        mockSelectDeploymentTarget.mockReset()
        mockValidateLocalDependencies.mockReset()
        mockWriteStderrLine.mockReset()

        appContext.logProcessing.mockReset()
        appContext.logSuccess.mockReset()
        appContext.logWarning.mockReset()
        appContext.logError.mockReset()
        appContext.runPrompt.mockReset()
        appContext.runCommand.mockReset()
        appContext.runCommandCapture.mockReset()
        appContext.createSshClient.mockReset()
        appContext.emitEvent.mockReset()
        appContext.hasInteractiveTerminal = true
        appContext.executionMode = {
            interactive: true,
            json: false,
            workflow: 'deploy',
            presetName: null,
            maintenanceMode: null,
            skipGitHooks: false,
            resumePending: false,
            discardPending: false
        }

        mockCreateConfigurationService.mockReturnValue(configurationService)
        mockResolvePendingSnapshot.mockResolvedValue(null)
        mockRunDeployment.mockResolvedValue(undefined)
        mockEnsureGitignoreEntry.mockResolvedValue(undefined)
        mockEnsureProjectReleaseScript.mockResolvedValue(false)
        mockValidateLocalDependencies.mockResolvedValue(undefined)
    })

    it('delegates node releases to the node release command', async () => {
        const {main} = await import('#src/main.mjs')

        await main('node')

        expect(appContext.logProcessing).toHaveBeenNthCalledWith(1, expect.stringMatching(/^Zephyr v\d+\.\d+\.\d+/))
        expect(mockReleaseNode).toHaveBeenCalledTimes(1)
        expect(mockReleasePackagist).not.toHaveBeenCalled()
    })

    it('delegates Packagist releases to the Packagist release command', async () => {
        const {main} = await import('#src/main.mjs')

        await main('packagist')

        expect(appContext.logProcessing).toHaveBeenNthCalledWith(1, expect.stringMatching(/^Zephyr v\d+\.\d+\.\d+/))
        expect(mockReleasePackagist).toHaveBeenCalledTimes(1)
        expect(mockReleaseNode).not.toHaveBeenCalled()
    })

    it('bootstraps and runs the deployment workflow through the extracted actions', async () => {
        const deploymentConfig = {
            serverIp: '203.0.113.10',
            branch: 'main',
            projectPath: '~/webapps/demo'
        }
        const snapshot = {changedFiles: ['composer.json']}

        mockAccess.mockImplementation(async (filePath) => {
            if (/[\\/]package\.json$/.test(String(filePath))) {
                return undefined
            }

            throw new Error('ENOENT')
        })
        mockSelectDeploymentTarget.mockResolvedValue({deploymentConfig})
        mockResolvePendingSnapshot.mockResolvedValue(snapshot)

        const {main} = await import('#src/main.mjs')

        await main(null, 'minor')

        expect(appContext.logProcessing).toHaveBeenNthCalledWith(1, expect.stringMatching(/^Zephyr v\d+\.\d+\.\d+/))
        expect(mockCreateConfigurationService).toHaveBeenCalledWith(appContext)
        expect(mockEnsureGitignoreEntry).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({
            runCommand: appContext.runCommand,
            logSuccess: appContext.logSuccess,
            logWarning: appContext.logWarning
        }))
        expect(mockEnsureProjectReleaseScript).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({
            runPrompt: appContext.runPrompt,
            runCommand: appContext.runCommand
        }))
        expect(mockValidateLocalDependencies).toHaveBeenCalledWith(
            process.cwd(),
            appContext.runPrompt,
            appContext.logSuccess,
            {interactive: true, skipGitHooks: false}
        )
        expect(mockSelectDeploymentTarget).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({
            configurationService,
            runPrompt: appContext.runPrompt,
            logProcessing: appContext.logProcessing,
            logSuccess: appContext.logSuccess,
            logWarning: appContext.logWarning
        }))
        expect(mockResolvePendingSnapshot).toHaveBeenCalledWith(process.cwd(), deploymentConfig, expect.objectContaining({
            runPrompt: appContext.runPrompt,
            logProcessing: appContext.logProcessing,
            logWarning: appContext.logWarning
        }))
        expect(mockRunDeployment).toHaveBeenCalledWith(deploymentConfig, {
            rootDir: process.cwd(),
            snapshot,
            versionArg: 'minor',
            context: appContext
        })
    })

    it('emits JSON lifecycle events for a successful non-interactive deployment', async () => {
        const deploymentConfig = {
            serverName: 'production',
            serverIp: '203.0.113.10',
            projectPath: '~/webapps/demo',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '~/.ssh/id_rsa'
        }

        mockAccess.mockImplementation(async () => {
            throw new Error('ENOENT')
        })
        mockSelectDeploymentTarget.mockResolvedValue({deploymentConfig})
        appContext.executionMode = {
            interactive: false,
            json: true,
            workflow: 'deploy',
            presetName: 'production',
            maintenanceMode: false,
            skipGitHooks: false,
            resumePending: false,
            discardPending: false
        }

        const {main} = await import('#src/main.mjs')

        await main({
            nonInteractive: true,
            json: true,
            presetName: 'production',
            maintenanceMode: false,
            context: appContext
        })

        expect(appContext.runPrompt).not.toHaveBeenCalled()
        expect(appContext.emitEvent).toHaveBeenNthCalledWith(1, 'run_started', expect.objectContaining({
            message: expect.stringMatching(/^Zephyr v\d+\.\d+\.\d+ starting$/)
        }))
        expect(appContext.emitEvent).toHaveBeenLastCalledWith('run_completed', expect.objectContaining({
            message: 'Zephyr workflow completed successfully.'
        }))
        expect(appContext.emitEvent.mock.calls.filter(([event]) => event === 'run_completed')).toHaveLength(1)
        expect(appContext.emitEvent.mock.calls.filter(([event]) => event === 'run_failed')).toHaveLength(0)
    })

    it('emits a JSON failure event for invalid options before running a workflow', async () => {
        appContext.executionMode = {
            interactive: false,
            json: true,
            workflow: 'release-packagist',
            presetName: null,
            maintenanceMode: null,
            skipGitHooks: false,
            resumePending: false,
            discardPending: false
        }

        const {main} = await import('#src/main.mjs')
        const result = main({
            workflowType: 'packagist',
            nonInteractive: true,
            json: true,
            presetName: 'production',
            context: appContext
        })
        let failure = null

        try {
            await result
        } catch (error) {
            failure = error
        }

        expect(failure).toMatchObject({
            code: 'ZEPHYR_INVALID_OPTIONS'
        })

        expect(appContext.emitEvent).toHaveBeenCalledTimes(1)
        expect(appContext.emitEvent).toHaveBeenCalledWith('run_failed', expect.objectContaining({
            code: 'ZEPHYR_INVALID_OPTIONS',
            message: '--preset is only valid for app deployments.'
        }))
    })

    it('refuses interactive app deployments without a real interactive terminal', async () => {
        appContext.hasInteractiveTerminal = false

        const {main} = await import('#src/main.mjs')
        let failure = null

        try {
            await main({context: appContext})
        } catch (error) {
            failure = error
        }

        expect(failure).toMatchObject({
            code: 'ZEPHYR_INTERACTIVE_SESSION_REQUIRED'
        })
        expect(mockEnsureGitignoreEntry).not.toHaveBeenCalled()
        expect(mockRunDeployment).not.toHaveBeenCalled()
    })
})
