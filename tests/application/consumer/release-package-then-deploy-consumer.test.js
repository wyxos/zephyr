import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {afterEach, describe, expect, it, vi} from 'vitest'

const {
    mockCreateConfigurationService
} = vi.hoisted(() => ({
    mockCreateConfigurationService: vi.fn()
}))

vi.mock('#src/application/configuration/service.mjs', () => ({
    createConfigurationService: mockCreateConfigurationService
}))

import {releasePackageThenDeployConsumer} from '#src/application/consumer/release-package-then-deploy-consumer.mjs'

const tempDirs = []

async function createConsumerRoot() {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zephyr-consumer-deploy-'))
    tempDirs.push(rootDir)
    await fs.writeFile(path.join(rootDir, 'package.json'), `${JSON.stringify({
        scripts: {
            release: 'zephyr'
        },
        dependencies: {
            '@wyxos/vibe': '^3.1.22'
        }
    }, null, 2)}\n`, 'utf8')
    return rootDir
}

afterEach(async () => {
    mockCreateConfigurationService.mockReset()
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, {recursive: true, force: true})))
})

describe('application/consumer/release-package-then-deploy-consumer', () => {
    it('waits for npm visibility, updates the local consumer repo, then deploys it with preset options', async () => {
        const consumerRootDir = await createConsumerRoot()
        const producerRootDir = path.dirname(consumerRootDir)
        const relativeConsumerRootDir = path.basename(consumerRootDir)
        const context = {
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            runPrompt: vi.fn(),
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            emitEvent: vi.fn(),
            executionMode: null
        }
        const createAppContextImpl = vi.fn(() => context)
        const waitForNpmPackageVersionImpl = vi.fn().mockResolvedValue({packageName: '@wyxos/vibe', version: '3.1.23'})
        const updateConsumerDependencyImpl = vi.fn().mockResolvedValue({committed: true})
        const assertCleanConsumerRepoImpl = vi.fn().mockResolvedValue(undefined)
        const validateLocalDependenciesImpl = vi.fn().mockResolvedValue(undefined)
        const deploymentConfig = {
            serverIp: '203.0.113.10',
            projectPath: '~/webapps/atlas',
            branch: 'main'
        }
        const applyExecutionMode = vi.fn().mockResolvedValue(undefined)
        const presetState = {
            name: 'wyxos-release',
            options: {
                maintenanceMode: true,
                skipGitHooks: false,
                skipTests: true,
                skipLint: true,
                skipVersioning: false,
                autoCommit: false
            },
            applyExecutionMode
        }
        const selectDeploymentTargetImpl = vi.fn().mockResolvedValue({deploymentConfig, presetState})
        const snapshot = {changedFiles: ['package.json']}
        const resolvePendingSnapshotImpl = vi.fn().mockResolvedValue(snapshot)
        const runDeploymentImpl = vi.fn().mockResolvedValue(undefined)
        const bootstrapImpl = {
            ensureGitignoreEntry: vi.fn().mockResolvedValue(undefined),
            ensureProjectReleaseScript: vi.fn().mockResolvedValue(false)
        }
        const configurationService = {selectServer: vi.fn()}
        mockCreateConfigurationService.mockReturnValue(configurationService)

        await releasePackageThenDeployConsumer({
            producerRootDir,
            consumerRootDir: relativeConsumerRootDir,
            releasedPackage: {name: '@wyxos/vibe', version: '3.1.23'},
            presetName: 'wyxos-release',
            maintenanceMode: false,
            skipVersioning: true,
            skipGitHooks: true,
            autoCommit: true,
            explicitMaintenanceMode: true,
            explicitSkipVersioning: true,
            explicitSkipGitHooks: true,
            explicitAutoCommit: true,
            createAppContextImpl,
            waitForNpmPackageVersionImpl,
            updateConsumerDependencyImpl,
            assertCleanConsumerRepoImpl,
            validateLocalDependenciesImpl,
            selectDeploymentTargetImpl,
            resolvePendingSnapshotImpl,
            runDeploymentImpl,
            bootstrapImpl
        })

        expect(createAppContextImpl).toHaveBeenCalledWith({
            executionMode: expect.objectContaining({
                interactive: false,
                workflow: 'deploy',
                presetName: 'wyxos-release',
                maintenanceMode: false,
                skipVersioning: true,
                skipGitHooks: true,
                autoCommit: true
            })
        })
        expect(mockCreateConfigurationService).toHaveBeenCalledWith(context)
        expect(assertCleanConsumerRepoImpl).toHaveBeenCalledWith(consumerRootDir, {
            runCommandCapture: context.runCommandCapture
        })
        expect(bootstrapImpl.ensureGitignoreEntry).toHaveBeenCalledWith(consumerRootDir, expect.objectContaining({
            skipGitHooks: true
        }))
        expect(validateLocalDependenciesImpl).toHaveBeenCalledWith(consumerRootDir, context.runPrompt, context.logSuccess, {
            interactive: false,
            skipGitHooks: true
        })
        expect(selectDeploymentTargetImpl).toHaveBeenCalledWith(consumerRootDir, expect.objectContaining({
            configurationService,
            executionMode: expect.objectContaining({
                presetName: 'wyxos-release',
                maintenanceMode: false,
                skipVersioning: true,
                skipGitHooks: true,
                autoCommit: true
            }),
            promptPresetOptions: true
        }))
        expect(applyExecutionMode).toHaveBeenCalledWith(expect.objectContaining({
            presetName: 'wyxos-release',
            maintenanceMode: false,
            skipTests: true,
            skipLint: true,
            skipChecks: true,
            skipVersioning: true,
            skipGitHooks: true,
            autoCommit: true
        }))
        expect(waitForNpmPackageVersionImpl).toHaveBeenCalledWith(expect.objectContaining({
            packageName: '@wyxos/vibe',
            version: '3.1.23'
        }))
        expect(updateConsumerDependencyImpl).toHaveBeenCalledWith(expect.objectContaining({
            rootDir: consumerRootDir,
            packageName: '@wyxos/vibe',
            version: '3.1.23',
            skipGitHooks: true
        }))
        expect(resolvePendingSnapshotImpl).toHaveBeenCalledWith(consumerRootDir, deploymentConfig, expect.objectContaining({
            executionMode: expect.objectContaining({
                skipChecks: true
            })
        }))
        expect(runDeploymentImpl).toHaveBeenCalledWith(deploymentConfig, {
            rootDir: consumerRootDir,
            snapshot,
            context,
            presetState
        })
        expect(assertCleanConsumerRepoImpl.mock.invocationCallOrder[0]).toBeLessThan(bootstrapImpl.ensureGitignoreEntry.mock.invocationCallOrder[0])
        expect(waitForNpmPackageVersionImpl.mock.invocationCallOrder[0]).toBeLessThan(updateConsumerDependencyImpl.mock.invocationCallOrder[0])
        expect(updateConsumerDependencyImpl.mock.invocationCallOrder[0]).toBeLessThan(runDeploymentImpl.mock.invocationCallOrder[0])
    })

    it('fails before bootstrapping the consumer when the consumer repo is already dirty', async () => {
        const consumerRootDir = await createConsumerRoot()
        const context = {
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            runPrompt: vi.fn(),
            runCommand: vi.fn(),
            runCommandCapture: vi.fn(),
            emitEvent: vi.fn(),
            executionMode: null
        }
        const bootstrapImpl = {
            ensureGitignoreEntry: vi.fn(),
            ensureProjectReleaseScript: vi.fn()
        }
        const assertCleanConsumerRepoImpl = vi.fn().mockRejectedValue(new Error('Consumer repository has uncommitted changes.'))
        mockCreateConfigurationService.mockReturnValue({})

        await expect(releasePackageThenDeployConsumer({
            producerRootDir: path.dirname(consumerRootDir),
            consumerRootDir: path.basename(consumerRootDir),
            releasedPackage: {name: '@wyxos/vibe', version: '3.1.23'},
            presetName: 'wyxos-release',
            createAppContextImpl: vi.fn(() => context),
            assertCleanConsumerRepoImpl,
            bootstrapImpl
        })).rejects.toThrow('Consumer repository has uncommitted changes.')

        expect(assertCleanConsumerRepoImpl).toHaveBeenCalledWith(consumerRootDir, {
            runCommandCapture: context.runCommandCapture
        })
        expect(bootstrapImpl.ensureGitignoreEntry).not.toHaveBeenCalled()
        expect(bootstrapImpl.ensureProjectReleaseScript).not.toHaveBeenCalled()
    })
})
