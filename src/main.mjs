import fs from 'node:fs/promises'
import {createRequire} from 'node:module'
import path from 'node:path'
import process from 'node:process'

import {validateCliOptions} from './cli/options.mjs'
import {releaseNode} from './release-node.mjs'
import {releasePackagist} from './release-packagist.mjs'
import {validateLocalDependencies} from './dependency-scanner.mjs'
import * as bootstrap from './project/bootstrap.mjs'
import {getErrorCode, ZephyrError} from './runtime/errors.mjs'
import {PROJECT_CONFIG_DIR} from './utils/paths.mjs'
import {writeStderrLine} from './utils/output.mjs'
import {mergeDeployOptions} from './config/preset-options.mjs'
import {createAppContext} from './runtime/app-context.mjs'
import {createConfigurationService} from './application/configuration/service.mjs'
import {selectDeploymentTarget} from './application/configuration/select-deployment-target.mjs'
import {resolvePendingSnapshot} from './application/deploy/resolve-pending-snapshot.mjs'
import {runDeployment} from './application/deploy/run-deployment.mjs'
import {SKIP_GIT_HOOKS_WARNING} from './utils/git-hooks.mjs'
import {notifyWorkflowResult} from './utils/notifications.mjs'

const RELEASE_SCRIPT_NAME = 'release'
const RELEASE_SCRIPT_COMMAND = 'npx @wyxos/zephyr@latest'
const require = createRequire(import.meta.url)
const {version: ZEPHYR_VERSION} = require('../package.json')

function normalizeMainOptions(firstArg = null, secondArg = null) {
    if (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)) {
        return {
            workflowType: firstArg.workflowType ?? firstArg.type ?? null,
            versionArg: firstArg.versionArg ?? null,
            nonInteractive: firstArg.nonInteractive === true,
            json: firstArg.json === true,
            presetName: firstArg.presetName ?? null,
            resumePending: firstArg.resumePending === true,
            discardPending: firstArg.discardPending === true,
            maintenanceMode: firstArg.maintenanceMode ?? null,
            autoCommit: firstArg.autoCommit === true,
            skipVersioning: firstArg.skipVersioning === true,
            skipGitHooks: firstArg.skipGitHooks === true,
            skipChecks: firstArg.skipChecks === true,
            skipTests: firstArg.skipTests === true || firstArg.skipChecks === true,
            skipLint: firstArg.skipLint === true || firstArg.skipChecks === true,
            skipBuild: firstArg.skipBuild === true,
            skipDeploy: firstArg.skipDeploy === true,
            explicitMaintenanceMode: firstArg.explicitMaintenanceMode === true || 'maintenanceMode' in firstArg,
            explicitAutoCommit: firstArg.explicitAutoCommit === true || 'autoCommit' in firstArg,
            explicitSkipVersioning: firstArg.explicitSkipVersioning === true || 'skipVersioning' in firstArg,
            explicitSkipGitHooks: firstArg.explicitSkipGitHooks === true || 'skipGitHooks' in firstArg,
            explicitSkipChecks: firstArg.explicitSkipChecks === true || 'skipChecks' in firstArg,
            explicitSkipTests: firstArg.explicitSkipTests === true || 'skipTests' in firstArg || 'skipChecks' in firstArg,
            explicitSkipLint: firstArg.explicitSkipLint === true || 'skipLint' in firstArg || 'skipChecks' in firstArg,
            context: firstArg.context ?? null
        }
    }

    return {
        workflowType: firstArg ?? null,
        versionArg: secondArg ?? null,
        nonInteractive: false,
        json: false,
        presetName: null,
        resumePending: false,
        discardPending: false,
        maintenanceMode: null,
        autoCommit: false,
        skipVersioning: false,
        skipGitHooks: false,
        skipChecks: false,
        skipTests: false,
        skipLint: false,
        skipBuild: false,
        skipDeploy: false,
        explicitMaintenanceMode: false,
        explicitAutoCommit: false,
        explicitSkipVersioning: false,
        explicitSkipGitHooks: false,
        explicitSkipChecks: false,
        explicitSkipTests: false,
        explicitSkipLint: false,
        context: null
    }
}

function resolveWorkflowName(workflowType = null) {
    if (workflowType === 'node' || workflowType === 'vue') {
        return `release-${workflowType}`
    }

    if (workflowType === 'packagist') {
        return 'release-packagist'
    }

    return 'deploy'
}

function assertInteractiveAppDeploySession({workflowType = null, executionMode = {}, appContext = {}} = {}) {
    const isAppDeploy = workflowType !== 'node' && workflowType !== 'vue' && workflowType !== 'packagist'

    if (!isAppDeploy || executionMode?.interactive === false) {
        return
    }

    if (appContext?.hasInteractiveTerminal !== false) {
        return
    }

    throw new ZephyrError(
        'Zephyr refuses interactive app deployments without a real interactive terminal. Rerun in a TTY, or use --non-interactive --preset <name> --maintenance on|off.',
        {code: 'ZEPHYR_INTERACTIVE_SESSION_REQUIRED'}
    )
}

async function runRemoteTasks(config, options = {}) {
    return await runDeployment(config, {
        ...options,
        context: options.context
    })
}

async function main(optionsOrWorkflowType = null, versionArg = null) {
    const options = normalizeMainOptions(optionsOrWorkflowType, versionArg)
    const rootDir = process.cwd()

    const executionMode = {
        interactive: !options.nonInteractive,
        json: options.json === true && options.nonInteractive === true,
        workflow: resolveWorkflowName(options.workflowType),
        presetName: options.presetName,
        maintenanceMode: options.maintenanceMode,
        autoCommit: options.autoCommit === true,
        skipVersioning: options.skipVersioning === true,
        skipGitHooks: options.skipGitHooks === true,
        skipChecks: options.skipChecks === true,
        skipTests: options.skipTests === true,
        skipLint: options.skipLint === true,
        resumePending: options.resumePending,
        discardPending: options.discardPending,
        explicitMaintenanceMode: options.explicitMaintenanceMode === true,
        explicitAutoCommit: options.explicitAutoCommit === true,
        explicitSkipVersioning: options.explicitSkipVersioning === true,
        explicitSkipGitHooks: options.explicitSkipGitHooks === true,
        explicitSkipChecks: options.explicitSkipChecks === true,
        explicitSkipTests: options.explicitSkipTests === true,
        explicitSkipLint: options.explicitSkipLint === true
    }
    const appContext = options.context ?? createAppContext({executionMode})
    const {
        logProcessing,
        logSuccess,
        logWarning,
        logError,
        runPrompt,
        runCommand,
        emitEvent
    } = appContext
    let currentExecutionMode = {
        ...executionMode,
        ...(appContext.executionMode ?? {})
    }
    appContext.executionMode = currentExecutionMode
    const configurationService = createConfigurationService(appContext)

    try {
        validateCliOptions(options)

        if (currentExecutionMode.json) {
            emitEvent?.('run_started', {
                message: `Zephyr v${ZEPHYR_VERSION} starting`,
                data: {
                    version: ZEPHYR_VERSION,
                    workflow: currentExecutionMode.workflow,
                    nonInteractive: currentExecutionMode.interactive === false,
                    presetName: currentExecutionMode.presetName,
                    maintenanceMode: currentExecutionMode.maintenanceMode,
                    autoCommit: currentExecutionMode.autoCommit === true,
                    skipVersioning: currentExecutionMode.skipVersioning === true,
                    skipGitHooks: currentExecutionMode.skipGitHooks === true,
                    skipChecks: currentExecutionMode.skipChecks === true,
                    skipTests: currentExecutionMode.skipTests === true,
                    skipLint: currentExecutionMode.skipLint === true,
                    resumePending: currentExecutionMode.resumePending,
                    discardPending: currentExecutionMode.discardPending
                }
            })
        } else {
            logProcessing(`Zephyr v${ZEPHYR_VERSION}`)
        }

        if (currentExecutionMode.skipGitHooks) {
            logWarning(SKIP_GIT_HOOKS_WARNING)
        }

        assertInteractiveAppDeploySession({
            workflowType: options.workflowType,
            executionMode: currentExecutionMode,
            appContext
        })

        if (options.workflowType === 'node' || options.workflowType === 'vue') {
            await releaseNode({
                releaseType: options.versionArg,
                skipGitHooks: options.skipGitHooks,
                skipTests: options.skipTests,
                skipLint: options.skipLint,
                skipVersioning: options.skipVersioning,
                skipBuild: options.skipBuild,
                skipDeploy: options.skipDeploy,
                context: appContext
            })
            emitEvent?.('run_completed', {
                message: 'Zephyr workflow completed successfully.',
                data: {
                    version: ZEPHYR_VERSION,
                    workflow: currentExecutionMode.workflow
                }
            })
            if (!currentExecutionMode.json) {
                await notifyWorkflowResult({
                    status: 'success',
                    workflow: currentExecutionMode.workflow,
                    presetName: currentExecutionMode.presetName,
                    rootDir
                })
            }
            return
        }

        if (options.workflowType === 'packagist') {
            await releasePackagist({
                releaseType: options.versionArg,
                skipGitHooks: options.skipGitHooks,
                skipTests: options.skipTests,
                skipLint: options.skipLint,
                skipVersioning: options.skipVersioning,
                context: appContext
            })
            emitEvent?.('run_completed', {
                message: 'Zephyr workflow completed successfully.',
                data: {
                    version: ZEPHYR_VERSION,
                    workflow: currentExecutionMode.workflow
                }
            })
            if (!currentExecutionMode.json) {
                await notifyWorkflowResult({
                    status: 'success',
                    workflow: currentExecutionMode.workflow,
                    presetName: currentExecutionMode.presetName,
                    rootDir
                })
            }
            return
        }

        await bootstrap.ensureGitignoreEntry(rootDir, {
            projectConfigDir: PROJECT_CONFIG_DIR,
            runCommand,
            logSuccess,
            logWarning,
            skipGitHooks: currentExecutionMode.skipGitHooks
        })
        await bootstrap.ensureProjectReleaseScript(rootDir, {
            runPrompt,
            runCommand,
            logSuccess,
            logWarning,
            skipGitHooks: currentExecutionMode.skipGitHooks,
            interactive: currentExecutionMode.interactive,
            releaseScriptName: RELEASE_SCRIPT_NAME,
            releaseScriptCommand: RELEASE_SCRIPT_COMMAND
        })

        const packageJsonPath = path.join(rootDir, 'package.json')
        const composerJsonPath = path.join(rootDir, 'composer.json')
        const hasPackageJson = await fs.access(packageJsonPath).then(() => true).catch(() => false)
        const hasComposerJson = await fs.access(composerJsonPath).then(() => true).catch(() => false)

        if (hasPackageJson || hasComposerJson) {
            logProcessing('Validating dependencies...')
            await validateLocalDependencies(rootDir, runPrompt, logSuccess, {
                interactive: currentExecutionMode.interactive,
                skipGitHooks: currentExecutionMode.skipGitHooks
            })
        }

        const {deploymentConfig, presetState} = await selectDeploymentTarget(rootDir, {
            configurationService,
            runPrompt,
            logProcessing,
            logSuccess,
            logWarning,
            emitEvent,
            executionMode: currentExecutionMode
        })

        if (presetState) {
            const effectiveDeployOptions = mergeDeployOptions(currentExecutionMode, presetState.options)
            currentExecutionMode = {
                ...currentExecutionMode,
                presetName: presetState.name,
                ...effectiveDeployOptions,
                skipChecks: currentExecutionMode.skipChecks === true ||
                    (effectiveDeployOptions.skipTests === true && effectiveDeployOptions.skipLint === true)
            }
            appContext.executionMode = currentExecutionMode
            await presetState.applyExecutionMode(currentExecutionMode)
        }

        const snapshotToUse = await resolvePendingSnapshot(rootDir, deploymentConfig, {
            runPrompt,
            logProcessing,
            logWarning,
            executionMode: currentExecutionMode
        })

        await runRemoteTasks(deploymentConfig, {
            rootDir,
            snapshot: snapshotToUse,
            versionArg: options.versionArg,
            context: appContext,
            presetState
        })

        emitEvent?.('run_completed', {
            message: 'Zephyr workflow completed successfully.',
            data: {
                version: ZEPHYR_VERSION,
                workflow: currentExecutionMode.workflow
            }
        })
        if (!currentExecutionMode.json) {
            await notifyWorkflowResult({
                status: 'success',
                workflow: currentExecutionMode.workflow,
                presetName: currentExecutionMode.presetName,
                rootDir
            })
        }
    } catch (error) {
        const errorCode = getErrorCode(error)
        emitEvent?.('run_failed', {
            message: error.message,
            code: errorCode,
            data: {
                version: ZEPHYR_VERSION,
                workflow: currentExecutionMode.workflow
            }
        })

        if (!currentExecutionMode.json) {
            logError(error.message)
            if (errorCode === 'ZEPHYR_FAILURE' && error.stack) {
                writeStderrLine(error.stack)
            }
            await notifyWorkflowResult({
                status: 'failure',
                workflow: currentExecutionMode.workflow,
                presetName: currentExecutionMode.presetName,
                rootDir,
                message: error.message
            })
        }

        throw error
    }
}

export {main, runRemoteTasks}
