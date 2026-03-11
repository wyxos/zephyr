import process from 'node:process'
import chalk from 'chalk'
import {createChalkLogger} from './utils/output.mjs'
import {
    parseReleaseArgs,
} from './release/shared.mjs'
import {releaseNodePackage} from './application/release/release-node-package.mjs'

const {logProcessing: logStep, logSuccess, logWarning} = createChalkLogger(chalk)

export async function releaseNode() {
    const {releaseType, skipTests, skipLint, skipBuild, skipDeploy} = parseReleaseArgs({
        booleanFlags: ['--skip-tests', '--skip-lint', '--skip-build', '--skip-deploy']
    })
    const rootDir = process.cwd()
    await releaseNodePackage({
        releaseType,
        skipTests,
        skipLint,
        skipBuild,
        skipDeploy,
        rootDir,
        logStep,
        logSuccess,
        logWarning
    })
}
