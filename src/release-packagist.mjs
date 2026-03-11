import process from 'node:process'
import chalk from 'chalk'
import {createChalkLogger} from './utils/output.mjs'
import {
    parseReleaseArgs,
} from './release/shared.mjs'
import {releasePackagistPackage} from './application/release/release-packagist-package.mjs'

const {logProcessing: logStep, logSuccess, logWarning} = createChalkLogger(chalk)

export async function releasePackagist() {
    const {releaseType, skipTests, skipLint} = parseReleaseArgs({
        booleanFlags: ['--skip-tests', '--skip-lint']
    })
    const rootDir = process.cwd()
    await releasePackagistPackage({
        releaseType,
        skipTests,
        skipLint,
        rootDir,
        logStep,
        logSuccess,
        logWarning
    })
}
