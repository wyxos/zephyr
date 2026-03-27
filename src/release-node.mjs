import process from 'node:process'
import {createAppContext} from './runtime/app-context.mjs'
import {parseReleaseArgs} from './release/shared.mjs'
import {releaseNodePackage} from './application/release/release-node-package.mjs'

function hasExplicitReleaseOptions(options = {}) {
    return [
        'releaseType',
        'skipGitHooks',
        'skipTests',
        'skipLint',
        'skipBuild',
        'skipDeploy'
    ].some((key) => key in options)
}

export async function releaseNode(options = {}) {
    const parsed = hasExplicitReleaseOptions(options)
        ? {
            releaseType: 'releaseType' in options ? (options.releaseType ?? null) : null,
            skipGitHooks: options.skipGitHooks === true,
            skipTests: options.skipTests === true,
            skipLint: options.skipLint === true,
            skipBuild: options.skipBuild === true,
            skipDeploy: options.skipDeploy === true
        }
        : parseReleaseArgs({
            booleanFlags: ['--skip-git-hooks', '--skip-tests', '--skip-lint', '--skip-build', '--skip-deploy']
        })
    const rootDir = options.rootDir ?? process.cwd()
    const context = options.context ?? createAppContext({
        executionMode: {
            interactive: true,
            json: false,
            workflow: 'release-node'
        }
    })
    const {logProcessing: logStep, logSuccess, logWarning, runPrompt, runCommand, runCommandCapture, executionMode} = context

    await releaseNodePackage({
        releaseType: parsed.releaseType,
        skipGitHooks: parsed.skipGitHooks === true || executionMode?.skipGitHooks === true,
        skipTests: parsed.skipTests === true,
        skipLint: parsed.skipLint === true,
        skipBuild: parsed.skipBuild === true,
        skipDeploy: parsed.skipDeploy === true,
        rootDir,
        logStep,
        logSuccess,
        logWarning,
        runPrompt,
        runCommandImpl: runCommand,
        runCommandCaptureImpl: runCommandCapture,
        interactive: executionMode?.interactive !== false
    })
}
