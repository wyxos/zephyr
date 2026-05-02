import process from 'node:process'

import {Command} from 'commander'

import {InvalidCliOptionsError} from '../runtime/errors.mjs'

const WORKFLOW_TYPES = new Set(['node', 'vue', 'packagist'])

function hasFlag(args = [], flag) {
    return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
}

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
        .option('--then-deploy <path>', 'After a node/vue package release, update and deploy a local consumer app repo.')
        .option('--consumer-package <name>', 'Package name to update in the --then-deploy consumer. Defaults to the released package name.')
        .option('--consumer-preset <name>', 'Preset name to use for the --then-deploy consumer app deployment.')
        .option('--consumer-maintenance <mode>', 'Laravel maintenance mode policy for the --then-deploy consumer app deployment (on|off).')
        .option('--json', 'Emit NDJSON events to stdout. Requires --non-interactive.')
        .option('--setup', 'Configure an app deployment target and verify SSH connectivity without deploying.')
        .option('--preset <name>', 'Preset name to use for non-interactive app deployments.')
        .option('--resume-pending', 'Resume a saved pending deployment snapshot without prompting.')
        .option('--discard-pending', 'Discard a saved pending deployment snapshot without prompting.')
        .option('--maintenance <mode>', 'Laravel maintenance mode policy for app deployments (on|off).')
        .option('--auto-commit', 'Automatically commit dirty changes with a Codex-generated message.')
        .option('--skip-versioning', 'Skip updating package/composer version files before continuing.')
        .option('--skip-git-hooks', 'Bypass local git hooks for any commits and pushes Zephyr performs.')
        .option('--skip-checks', 'Skip Zephyr local lint and test execution.')
        .option('--skip-tests', 'Skip Zephyr local test execution in package release and app deployment workflows.')
        .option('--skip-lint', 'Skip Zephyr local lint execution in package release and app deployment workflows.')
        .option('--skip-build', 'Skip build execution in node/vue release workflows.')
        .option('--skip-deploy', 'Skip GitHub Pages deployment in node/vue release workflows.')
        .option('--consumer-skip-checks', 'Skip Zephyr local lint and test execution in the --then-deploy consumer deployment.')
        .option('--consumer-skip-tests', 'Skip Zephyr local test execution in the --then-deploy consumer deployment.')
        .option('--consumer-skip-lint', 'Skip Zephyr local lint execution in the --then-deploy consumer deployment.')
        .option('--consumer-skip-versioning', 'Skip local version bumping in the --then-deploy consumer deployment.')
        .option('--consumer-skip-git-hooks', 'Bypass local git hooks for commits and pushes in the --then-deploy consumer repo.')
        .option('--consumer-auto-commit', 'Automatically commit dirty deploy changes in the --then-deploy consumer repo.')
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
    const explicitSkipChecks = hasFlag(args, '--skip-checks')
    const explicitConsumerSkipChecks = hasFlag(args, '--consumer-skip-checks')

    if (workflowType && !WORKFLOW_TYPES.has(workflowType)) {
        throw new InvalidCliOptionsError('Invalid value for --type. Use one of: node, vue, packagist.')
    }

    return {
        workflowType,
        versionArg: program.args[0] ?? null,
        nonInteractive: Boolean(options.nonInteractive),
        thenDeploy: options.thenDeploy ?? null,
        json: Boolean(options.json),
        setup: Boolean(options.setup),
        presetName: options.preset ?? null,
        resumePending: Boolean(options.resumePending),
        discardPending: Boolean(options.discardPending),
        maintenanceMode: normalizeMaintenanceMode(options.maintenance),
        autoCommit: Boolean(options.autoCommit),
        skipVersioning: Boolean(options.skipVersioning),
        skipGitHooks: Boolean(options.skipGitHooks),
        skipChecks: Boolean(options.skipChecks),
        skipTests: Boolean(options.skipTests || options.skipChecks),
        skipLint: Boolean(options.skipLint || options.skipChecks),
        skipBuild: Boolean(options.skipBuild),
        skipDeploy: Boolean(options.skipDeploy),
        consumerPackage: options.consumerPackage ?? null,
        consumerPresetName: options.consumerPreset ?? null,
        consumerMaintenanceMode: normalizeMaintenanceMode(options.consumerMaintenance),
        consumerSkipChecks: Boolean(options.consumerSkipChecks),
        consumerSkipTests: Boolean(options.consumerSkipTests || options.consumerSkipChecks),
        consumerSkipLint: Boolean(options.consumerSkipLint || options.consumerSkipChecks),
        consumerSkipVersioning: Boolean(options.consumerSkipVersioning),
        consumerSkipGitHooks: Boolean(options.consumerSkipGitHooks),
        consumerAutoCommit: Boolean(options.consumerAutoCommit),
        explicitMaintenanceMode: hasFlag(args, '--maintenance'),
        explicitAutoCommit: hasFlag(args, '--auto-commit'),
        explicitSkipVersioning: hasFlag(args, '--skip-versioning'),
        explicitSkipGitHooks: hasFlag(args, '--skip-git-hooks'),
        explicitSkipChecks,
        explicitSkipTests: hasFlag(args, '--skip-tests') || explicitSkipChecks,
        explicitSkipLint: hasFlag(args, '--skip-lint') || explicitSkipChecks,
        explicitConsumerMaintenanceMode: hasFlag(args, '--consumer-maintenance'),
        explicitConsumerSkipChecks,
        explicitConsumerSkipTests: hasFlag(args, '--consumer-skip-tests') || explicitConsumerSkipChecks,
        explicitConsumerSkipLint: hasFlag(args, '--consumer-skip-lint') || explicitConsumerSkipChecks,
        explicitConsumerSkipVersioning: hasFlag(args, '--consumer-skip-versioning'),
        explicitConsumerSkipGitHooks: hasFlag(args, '--consumer-skip-git-hooks'),
        explicitConsumerAutoCommit: hasFlag(args, '--consumer-auto-commit')
    }
}

export function validateCliOptions(options = {}) {
    const {
        workflowType = null,
        nonInteractive = false,
        json = false,
        setup = false,
        thenDeploy = null,
        presetName = null,
        resumePending = false,
        discardPending = false,
        maintenanceMode = null,
        autoCommit = false,
        skipVersioning = false,
        skipChecks = false,
        skipTests = false,
        skipLint = false,
        skipBuild = false,
        skipDeploy = false,
        versionArg = null,
        consumerPackage = null,
        consumerPresetName = null,
        consumerMaintenanceMode = null,
        consumerSkipChecks = false,
        consumerSkipTests = false,
        consumerSkipLint = false,
        consumerSkipVersioning = false,
        consumerSkipGitHooks = false,
        consumerAutoCommit = false
    } = options

    if (json && !nonInteractive) {
        throw new InvalidCliOptionsError('--json requires --non-interactive.')
    }

    if (resumePending && discardPending) {
        throw new InvalidCliOptionsError('Use either --resume-pending or --discard-pending, not both.')
    }

    const isPackageRelease = workflowType === 'node' || workflowType === 'vue' || workflowType === 'packagist'
    const isNodePackageRelease = workflowType === 'node' || workflowType === 'vue'
    const hasConsumerOptions = Boolean(
        thenDeploy ||
        consumerPackage ||
        consumerPresetName ||
        consumerMaintenanceMode !== null ||
        consumerSkipChecks ||
        consumerSkipTests ||
        consumerSkipLint ||
        consumerSkipVersioning ||
        consumerSkipGitHooks ||
        consumerAutoCommit
    )

    if (hasConsumerOptions && !thenDeploy) {
        throw new InvalidCliOptionsError('--consumer-* options require --then-deploy <path>.')
    }

    if (thenDeploy && !isNodePackageRelease) {
        throw new InvalidCliOptionsError('--then-deploy is only valid for node/vue package release workflows.')
    }

    if (thenDeploy && !consumerPresetName) {
        throw new InvalidCliOptionsError('--then-deploy requires --consumer-preset <name>.')
    }

    if (isPackageRelease) {
        if (setup) {
            throw new InvalidCliOptionsError('--setup is only valid for app deployments.')
        }

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
        if (skipBuild || skipDeploy) {
            throw new InvalidCliOptionsError('--skip-build and --skip-deploy are only valid for node/vue release workflows.')
        }

        if (setup) {
            if (versionArg) {
                throw new InvalidCliOptionsError('--setup cannot be used with a version or bump argument.')
            }

            if (resumePending || discardPending) {
                throw new InvalidCliOptionsError('--setup cannot be used with pending deployment snapshot flags.')
            }

            if (maintenanceMode !== null) {
                throw new InvalidCliOptionsError('--setup cannot be used with --maintenance.')
            }

            if (autoCommit) {
                throw new InvalidCliOptionsError('--setup cannot be used with --auto-commit.')
            }

            if (skipVersioning || skipChecks || skipTests || skipLint) {
                throw new InvalidCliOptionsError('--setup cannot be used with deployment skip flags.')
            }
        }

        if (nonInteractive && !presetName) {
            throw new InvalidCliOptionsError('--non-interactive app deployments require --preset <name>.')
        }
    }

    if (skipVersioning && versionArg) {
        throw new InvalidCliOptionsError('--skip-versioning cannot be used together with an explicit version or bump argument.')
    }
}
