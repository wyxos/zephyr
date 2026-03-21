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
import {createAppContext} from './runtime/app-context.mjs'
import {createConfigurationService} from './application/configuration/service.mjs'
import {selectDeploymentTarget} from './application/configuration/select-deployment-target.mjs'
import {resolvePendingSnapshot} from './application/deploy/resolve-pending-snapshot.mjs'
import {runDeployment} from './application/deploy/run-deployment.mjs'
import {SKIP_GIT_HOOKS_WARNING} from './utils/git-hooks.mjs'

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
            skipGitHooks: firstArg.skipGitHooks === true,
            skipTests: firstArg.skipTests === true,
            skipLint: firstArg.skipLint === true,
            skipBuild: firstArg.skipBuild === true,
            skipDeploy: firstArg.skipDeploy === true,
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
        skipGitHooks: false,
        skipTests: false,
        skipLint: false,
        skipBuild: false,
        skipDeploy: false,
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

    const executionMode = {
        interactive: !options.nonInteractive,
        json: options.json === true && options.nonInteractive === true,
        workflow: resolveWorkflowName(options.workflowType),
        presetName: options.presetName,
        maintenanceMode: options.maintenanceMode,
        skipGitHooks: options.skipGitHooks === true,
        resumePending: options.resumePending,
        discardPending: options.discardPending
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
    const currentExecutionMode = appContext.executionMode ?? executionMode
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
                    skipGitHooks: currentExecutionMode.skipGitHooks === true,
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
            return
        }

        if (options.workflowType === 'packagist') {
            await releasePackagist({
                releaseType: options.versionArg,
                skipGitHooks: options.skipGitHooks,
                skipTests: options.skipTests,
                skipLint: options.skipLint,
                context: appContext
            })
            emitEvent?.('run_completed', {
                message: 'Zephyr workflow completed successfully.',
                data: {
                    version: ZEPHYR_VERSION,
                    workflow: currentExecutionMode.workflow
                }
            })
            return
        }

        const rootDir = process.cwd()

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

        const {deploymentConfig} = await selectDeploymentTarget(rootDir, {
            configurationService,
            runPrompt,
            logProcessing,
            logSuccess,
            logWarning,
            emitEvent,
            executionMode: currentExecutionMode
        })

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
            context: appContext
        })

        emitEvent?.('run_completed', {
            message: 'Zephyr workflow completed successfully.',
            data: {
                version: ZEPHYR_VERSION,
                workflow: currentExecutionMode.workflow
            }
        })
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
        }

        throw error
    }
}

export {main, runRemoteTasks}
