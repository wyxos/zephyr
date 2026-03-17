import process from 'node:process'
import {createAppContext} from './runtime/app-context.mjs'
import {parseReleaseArgs} from './release/shared.mjs'
import {releaseNodePackage} from './application/release/release-node-package.mjs'

export async function releaseNode(options = {}) {
    const parsed = options.releaseType
        ? options
        : parseReleaseArgs({
            booleanFlags: ['--skip-tests', '--skip-lint', '--skip-build', '--skip-deploy']
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
