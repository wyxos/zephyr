import {mergeDeployOptions} from '../../config/preset-options.mjs'
import {selectDeploymentTarget} from '../configuration/select-deployment-target.mjs'
import {resolvePendingSnapshot} from './resolve-pending-snapshot.mjs'
import {runDeployment} from './run-deployment.mjs'

async function runRemoteTasks(config, options = {}) {
    return await runDeployment(config, {
        ...options,
        context: options.context
    })
}

function mergePresetExecutionMode(executionMode, presetState) {
    if (!presetState) {
        return executionMode
    }

    const effectiveDeployOptions = mergeDeployOptions(executionMode, presetState.options)

    return {
        ...executionMode,
        presetName: presetState.name,
        ...effectiveDeployOptions,
        skipChecks: executionMode.skipChecks === true ||
            (effectiveDeployOptions.skipTests === true && effectiveDeployOptions.skipLint === true)
    }
}

function reusePreparedBranchExecutionMode(executionMode, deploymentConfig, preparedBranches, logProcessing) {
    if (!preparedBranches?.has(deploymentConfig.branch)) {
        return executionMode
    }

    logProcessing?.(
        `Reusing completed local preparation for branch ${deploymentConfig.branch}; skipping local checks and versioning for this target.`
    )

    return {
        ...executionMode,
        skipChecks: true,
        skipTests: true,
        skipLint: true,
        skipVersioning: true
    }
}

export async function runPresetDeployment({
    rootDir,
    configurationService,
    appContext,
    runPrompt,
    logProcessing,
    logSuccess,
    logWarning,
    emitEvent,
    baseExecutionMode,
    presetName,
    versionArg,
    preparedBranches = null
} = {}) {
    let targetExecutionMode = {
        ...baseExecutionMode,
        presetName
    }
    appContext.executionMode = targetExecutionMode

    const {deploymentConfig, presetState} = await selectDeploymentTarget(rootDir, {
        configurationService,
        runPrompt,
        logProcessing,
        logSuccess,
        logWarning,
        emitEvent,
        executionMode: targetExecutionMode,
        promptPresetOptions: targetExecutionMode.setup !== true
    })

    targetExecutionMode = mergePresetExecutionMode(targetExecutionMode, presetState)
    appContext.executionMode = targetExecutionMode

    if (presetState) {
        await presetState.applyExecutionMode(targetExecutionMode)
    }

    targetExecutionMode = reusePreparedBranchExecutionMode(
        targetExecutionMode,
        deploymentConfig,
        preparedBranches,
        logProcessing
    )
    appContext.executionMode = targetExecutionMode

    const snapshotToUse = targetExecutionMode.setup
        ? null
        : await resolvePendingSnapshot(rootDir, deploymentConfig, {
            runPrompt,
            logProcessing,
            logWarning,
            executionMode: targetExecutionMode
        })

    const deploymentOptions = {
        rootDir,
        snapshot: snapshotToUse,
        versionArg,
        context: appContext
    }

    if (presetState !== undefined) {
        deploymentOptions.presetState = presetState
    }

    await runRemoteTasks(deploymentConfig, deploymentOptions)

    preparedBranches?.add(deploymentConfig.branch)

    return targetExecutionMode
}
