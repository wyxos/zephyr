import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {releaseNode} from './release-node.mjs'
import {releasePackagist} from './release-packagist.mjs'
import {validateLocalDependencies} from './dependency-scanner.mjs'
import * as bootstrap from './project/bootstrap.mjs'
import {PROJECT_CONFIG_DIR} from './utils/paths.mjs'
import {writeStderrLine} from './utils/output.mjs'
import {createAppContext} from './runtime/app-context.mjs'
import {createConfigurationActions} from './application/configuration/actions.mjs'
import {selectDeploymentTarget} from './application/configuration/select-deployment-target.mjs'
import {resolvePendingSnapshot} from './application/deploy/resolve-pending-snapshot.mjs'
import {runDeployment} from './application/deploy/run-deployment.mjs'

const RELEASE_SCRIPT_NAME = 'release'
const RELEASE_SCRIPT_COMMAND = 'npx @wyxos/zephyr@latest'

const appContext = createAppContext()
const {
    logProcessing,
    logSuccess,
    logWarning,
    logError,
    runPrompt,
    runCommand
} = appContext
const configurationActions = createConfigurationActions(appContext)

async function runRemoteTasks(config, options = {}) {
    return await runDeployment(config, {
        ...options,
        context: options.context ?? appContext
    })
}

async function main(releaseType = null, versionArg = null) {
    if (releaseType === 'node' || releaseType === 'vue') {
        try {
            await releaseNode()
            return
        } catch (error) {
            logError('\nRelease failed:')
            logError(error.message)
            if (error.stack) {
                writeStderrLine(error.stack)
            }
            process.exit(1)
        }
    }

    if (releaseType === 'packagist') {
        try {
            await releasePackagist()
            return
        } catch (error) {
            logError('\nRelease failed:')
            logError(error.message)
            if (error.stack) {
                writeStderrLine(error.stack)
            }
            process.exit(1)
        }
    }

    const rootDir = process.cwd()

    await bootstrap.ensureGitignoreEntry(rootDir, {
        projectConfigDir: PROJECT_CONFIG_DIR,
        runCommand,
        logSuccess,
        logWarning
    })
    await bootstrap.ensureProjectReleaseScript(rootDir, {
        runPrompt,
        runCommand,
        logSuccess,
        logWarning,
        releaseScriptName: RELEASE_SCRIPT_NAME,
        releaseScriptCommand: RELEASE_SCRIPT_COMMAND
    })

    const packageJsonPath = path.join(rootDir, 'package.json')
    const composerJsonPath = path.join(rootDir, 'composer.json')
    const hasPackageJson = await fs.access(packageJsonPath).then(() => true).catch(() => false)
    const hasComposerJson = await fs.access(composerJsonPath).then(() => true).catch(() => false)

    if (hasPackageJson || hasComposerJson) {
        logProcessing('Validating dependencies...')
        await validateLocalDependencies(rootDir, runPrompt, logSuccess)
    }

    const {deploymentConfig} = await selectDeploymentTarget(rootDir, {
        actions: configurationActions,
        runPrompt,
        logProcessing,
        logSuccess,
        logWarning
    })

    const snapshotToUse = await resolvePendingSnapshot(rootDir, deploymentConfig, {
        runPrompt,
        logProcessing,
        logWarning
    })

    await runRemoteTasks(deploymentConfig, {rootDir, snapshot: snapshotToUse, versionArg})
}

export {main, runRemoteTasks}
