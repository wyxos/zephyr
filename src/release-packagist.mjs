import process from 'node:process'
import {createAppContext} from './runtime/app-context.mjs'
import {parseReleaseArgs} from './release/shared.mjs'
import {releasePackagistPackage} from './application/release/release-packagist-package.mjs'

function hasExplicitReleaseOptions(options = {}) {
    return [
        'releaseType',
        'skipGitHooks',
        'skipTests',
        'skipLint'
    ].some((key) => key in options)
}

export async function releasePackagist(options = {}) {
    const parsed = hasExplicitReleaseOptions(options)
        ? {
            releaseType: 'releaseType' in options ? (options.releaseType ?? null) : null,
            skipGitHooks: options.skipGitHooks === true,
            skipTests: options.skipTests === true,
            skipLint: options.skipLint === true
        }
        : parseReleaseArgs({
            booleanFlags: ['--skip-git-hooks', '--skip-tests', '--skip-lint']
        })
    const rootDir = options.rootDir ?? process.cwd()
    const context = options.context ?? createAppContext({
        executionMode: {
            interactive: true,
            json: false,
            workflow: 'release-packagist'
        }
    })
    const {logProcessing: logStep, logSuccess, logWarning, runPrompt, runCommand, runCommandCapture, executionMode} = context

    await releasePackagistPackage({
        releaseType: parsed.releaseType,
        skipGitHooks: parsed.skipGitHooks === true || executionMode?.skipGitHooks === true,
        skipTests: parsed.skipTests === true,
        skipLint: parsed.skipLint === true,
        rootDir,
        logStep,
        logSuccess,
        logWarning,
        runPrompt,
        runCommandImpl: runCommand,
        runCommandCaptureImpl: runCommandCapture,
        interactive: executionMode?.interactive !== false,
        progressWriter: executionMode?.json ? process.stderr : process.stdout
    })
}
