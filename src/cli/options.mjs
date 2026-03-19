import process from 'node:process'

import {Command} from 'commander'

import {InvalidCliOptionsError} from '../runtime/errors.mjs'

const WORKFLOW_TYPES = new Set(['node', 'vue', 'packagist'])
function normalizeMaintenanceMode(value) {
    if (value == null) {
        return null
    }

    if (value === 'on') {
        return true
    }

    if (value === 'off') {
        return false
    }

    throw new InvalidCliOptionsError('Invalid value for --maintenance. Use "on" or "off".')
}

export function parseCliOptions(args = process.argv.slice(2)) {
    const program = new Command()

    program
        .allowExcessArguments(false)
        .allowUnknownOption(false)
        .exitOverride()
        .option('--type <type>', 'Workflow type (node|vue|packagist). Omit for normal app deployments.')
        .option('--non-interactive', 'Fail instead of prompting when Zephyr needs user input.')
        .option('--json', 'Emit NDJSON events to stdout. Requires --non-interactive.')
        .option('--preset <name>', 'Preset name to use for non-interactive app deployments.')
        .option('--resume-pending', 'Resume a saved pending deployment snapshot without prompting.')
        .option('--discard-pending', 'Discard a saved pending deployment snapshot without prompting.')
        .option('--maintenance <mode>', 'Laravel maintenance mode policy for app deployments (on|off).')
        .option('--skip-git-hooks', 'Bypass local git hooks for any commits and pushes Zephyr performs.')
        .option('--skip-tests', 'Skip test execution in package release workflows.')
        .option('--skip-lint', 'Skip lint execution in package release workflows.')
        .option('--skip-build', 'Skip build execution in node/vue release workflows.')
        .option('--skip-deploy', 'Skip GitHub Pages deployment in node/vue release workflows.')
        .argument(
            '[version]',
            'Version or npm bump type for deployments (e.g. 1.2.3, patch, minor, major).'
        )

    try {
        program.parse(args, {from: 'user'})
    } catch (error) {
        throw new InvalidCliOptionsError(error.message)
    }

    const options = program.opts()
    const workflowType = options.type ?? null

    if (workflowType && !WORKFLOW_TYPES.has(workflowType)) {
        throw new InvalidCliOptionsError('Invalid value for --type. Use one of: node, vue, packagist.')
    }

    return {
        workflowType,
        versionArg: program.args[0] ?? null,
        nonInteractive: Boolean(options.nonInteractive),
        json: Boolean(options.json),
        presetName: options.preset ?? null,
        resumePending: Boolean(options.resumePending),
        discardPending: Boolean(options.discardPending),
        maintenanceMode: normalizeMaintenanceMode(options.maintenance),
        skipGitHooks: Boolean(options.skipGitHooks),
        skipTests: Boolean(options.skipTests),
        skipLint: Boolean(options.skipLint),
        skipBuild: Boolean(options.skipBuild),
        skipDeploy: Boolean(options.skipDeploy)
    }
}

export function validateCliOptions(options = {}) {
    const {
        workflowType = null,
        nonInteractive = false,
        json = false,
        presetName = null,
        resumePending = false,
        discardPending = false,
        maintenanceMode = null,
        skipTests = false,
        skipLint = false,
        skipBuild = false,
        skipDeploy = false
    } = options

    if (json && !nonInteractive) {
        throw new InvalidCliOptionsError('--json requires --non-interactive.')
    }

    if (resumePending && discardPending) {
        throw new InvalidCliOptionsError('Use either --resume-pending or --discard-pending, not both.')
    }

    const isPackageRelease = workflowType === 'node' || workflowType === 'vue' || workflowType === 'packagist'

    if (isPackageRelease) {
        if (presetName) {
            throw new InvalidCliOptionsError('--preset is only valid for app deployments.')
        }

        if (resumePending || discardPending) {
            throw new InvalidCliOptionsError('--resume-pending and --discard-pending are only valid for app deployments.')
        }

        if (maintenanceMode !== null) {
            throw new InvalidCliOptionsError('--maintenance is only valid for app deployments.')
        }
    } else {
        if (skipTests || skipLint || skipBuild || skipDeploy) {
            throw new InvalidCliOptionsError('Release-only skip flags are not valid for app deployments.')
        }

        if (nonInteractive && !presetName) {
            throw new InvalidCliOptionsError('--non-interactive app deployments require --preset <name>.')
        }
    }
}
