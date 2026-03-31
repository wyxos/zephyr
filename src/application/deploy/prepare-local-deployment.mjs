import process from 'node:process'

import {ensureCommittedChangesPushed, ensureLocalRepositoryState} from '../../deploy/local-repo.mjs'
import {bumpLocalPackageVersion} from './bump-local-package-version.mjs'
import {resolveLocalDeploymentContext} from './resolve-local-deployment-context.mjs'
import {resolveLocalDeploymentCheckSupport, runLocalDeploymentChecks} from './run-local-deployment-checks.mjs'

export async function prepareLocalDeployment(config, {
    snapshot = null,
    rootDir = process.cwd(),
    versionArg = null,
    skipGitHooks = false,
    skipTests = false,
    skipLint = false,
    runPrompt,
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess,
    logWarning
} = {}) {
    await ensureLocalRepositoryState(config.branch, rootDir, {
        runPrompt,
        runCommand,
        runCommandCapture,
        logProcessing,
        logSuccess,
        logWarning,
        skipGitHooks
    })

    const context = await resolveLocalDeploymentContext(rootDir)
    const checkSupport = await resolveLocalDeploymentCheckSupport({
        rootDir,
        isLaravel: context.isLaravel,
        skipTests,
        skipLint,
        runCommandCapture
    })

    if (!snapshot && context.isLaravel) {
        await runLocalDeploymentChecks({
            rootDir,
            isLaravel: context.isLaravel,
            hasHook: context.hasHook,
            skipGitHooks,
            skipTests,
            skipLint,
            forceRunWhenHookPresent: true,
            runCommand,
            runCommandCapture,
            logProcessing,
            logSuccess,
            logWarning,
            lintCommand: checkSupport.lintCommand,
            testCommand: checkSupport.testCommand
        })

        await bumpLocalPackageVersion(rootDir, {
            versionArg,
            skipGitHooks,
            runCommand,
            logProcessing,
            logSuccess,
            logWarning
        })

        await ensureCommittedChangesPushed(config.branch, rootDir, {
            runCommand,
            runCommandCapture,
            logProcessing,
            logSuccess,
            logWarning,
            skipGitHooks
        })

        return context
    }

    await runLocalDeploymentChecks({
        rootDir,
        isLaravel: context.isLaravel,
        hasHook: context.hasHook,
        skipGitHooks,
        skipTests,
        skipLint,
        runCommand,
        runCommandCapture,
        logProcessing,
        logSuccess,
        logWarning,
        lintCommand: checkSupport.lintCommand,
        testCommand: checkSupport.testCommand
    })

    return context
}
