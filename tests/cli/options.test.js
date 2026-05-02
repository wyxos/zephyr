import {describe, expect, it} from 'vitest'

import {parseCliOptions, validateCliOptions} from '#src/cli/options.mjs'

describe('cli/options', () => {
    it('parses supported non-interactive deploy flags', () => {
        const options = parseCliOptions([
            '--non-interactive',
            '--json',
            '--preset',
            'production',
            '--resume-pending',
            '--maintenance',
            'on',
            '--skip-tests',
            '--skip-lint',
            '1.2.3'
        ])

        expect(options).toEqual({
            workflowType: null,
            versionArg: '1.2.3',
            nonInteractive: true,
            thenDeploy: null,
            json: true,
            setup: false,
            presetName: 'production',
            resumePending: true,
            discardPending: false,
            maintenanceMode: true,
            autoCommit: false,
            skipVersioning: false,
            skipGitHooks: false,
            skipChecks: false,
            skipTests: true,
            skipLint: true,
            skipBuild: false,
            skipDeploy: false,
            consumerPackage: null,
            consumerPresetName: null,
            consumerMaintenanceMode: null,
            consumerSkipChecks: false,
            consumerSkipTests: false,
            consumerSkipLint: false,
            consumerSkipVersioning: false,
            consumerSkipGitHooks: false,
            consumerAutoCommit: false,
            explicitMaintenanceMode: true,
            explicitAutoCommit: false,
            explicitSkipVersioning: false,
            explicitSkipGitHooks: false,
            explicitSkipChecks: false,
            explicitSkipTests: true,
            explicitSkipLint: true,
            explicitConsumerMaintenanceMode: false,
            explicitConsumerSkipChecks: false,
            explicitConsumerSkipTests: false,
            explicitConsumerSkipLint: false,
            explicitConsumerSkipVersioning: false,
            explicitConsumerSkipGitHooks: false,
            explicitConsumerAutoCommit: false
        })
    })

    it('rejects --json without --non-interactive', () => {
        const options = parseCliOptions(['--json'])

        expect(() => validateCliOptions(options)).toThrow('--json requires --non-interactive.')
    })

    it('rejects preset flags on package release workflows', () => {
        const options = parseCliOptions(['--type=node', '--preset', 'production'])

        expect(() => validateCliOptions(options)).toThrow('--preset is only valid for app deployments.')
    })

    it('parses setup mode for app deployments', () => {
        const options = parseCliOptions(['--setup'])

        expect(options.setup).toBe(true)
        expect(() => validateCliOptions(options)).not.toThrow()
    })

    it('rejects setup mode on package release workflows', () => {
        const options = parseCliOptions(['--type=node', '--setup'])

        expect(() => validateCliOptions(options)).toThrow('--setup is only valid for app deployments.')
    })

    it('rejects setup mode with deploy-only flags', () => {
        expect(() => validateCliOptions(parseCliOptions(['--setup', 'minor']))).toThrow(
            '--setup cannot be used with a version or bump argument.'
        )
        expect(() => validateCliOptions(parseCliOptions(['--setup', '--maintenance', 'off']))).toThrow(
            '--setup cannot be used with --maintenance.'
        )
        expect(() => validateCliOptions(parseCliOptions(['--setup', '--skip-checks']))).toThrow(
            '--setup cannot be used with deployment skip flags.'
        )
    })

    it('rejects non-interactive app deploys without a preset', () => {
        const options = parseCliOptions(['--non-interactive'])

        expect(() => validateCliOptions(options)).toThrow('--non-interactive app deployments require --preset <name>.')
    })

    it('normalizes maintenance off to false', () => {
        const options = parseCliOptions(['--maintenance', 'off'])

        expect(options.maintenanceMode).toBe(false)
    })

    it('parses skip-git-hooks for release and deploy workflows', () => {
        expect(parseCliOptions(['--skip-git-hooks']).skipGitHooks).toBe(true)
        expect(parseCliOptions(['--type=node', '--skip-git-hooks']).skipGitHooks).toBe(true)
    })

    it('parses auto-commit and skip-versioning flags', () => {
        const options = parseCliOptions(['--auto-commit', '--skip-versioning'])

        expect(options.autoCommit).toBe(true)
        expect(options.skipVersioning).toBe(true)
        expect(options.explicitAutoCommit).toBe(true)
        expect(options.explicitSkipVersioning).toBe(true)
    })

    it('allows skip-tests and skip-lint on app deployments', () => {
        const options = parseCliOptions(['--skip-tests', '--skip-lint'])

        expect(() => validateCliOptions(options)).not.toThrow()
    })

    it('treats skip-checks as shorthand for skip-lint and skip-tests', () => {
        const options = parseCliOptions(['--skip-checks'])

        expect(options.skipChecks).toBe(true)
        expect(options.skipLint).toBe(true)
        expect(options.skipTests).toBe(true)
        expect(() => validateCliOptions(options)).not.toThrow()
    })

    it('rejects node/vue-only skip flags on app deployments', () => {
        const options = parseCliOptions(['--skip-build'])

        expect(() => validateCliOptions(options)).toThrow('--skip-build and --skip-deploy are only valid for node/vue release workflows.')
    })

    it('allows auto-commit on package release workflows', () => {
        const options = parseCliOptions(['--type=node', '--auto-commit'])

        expect(options.autoCommit).toBe(true)
        expect(options.explicitAutoCommit).toBe(true)
        expect(() => validateCliOptions(options)).not.toThrow()
    })

    it('parses package-to-consumer release and deploy flags', () => {
        const options = parseCliOptions([
            '--type=node',
            '--then-deploy',
            '../php/atlas',
            '--consumer-preset',
            'wyxos-release',
            '--consumer-package',
            '@wyxos/vibe',
            '--consumer-maintenance',
            'off',
            '--consumer-skip-checks',
            '--consumer-skip-versioning',
            '--consumer-skip-git-hooks',
            '--consumer-auto-commit'
        ])

        expect(options).toEqual(expect.objectContaining({
            workflowType: 'node',
            thenDeploy: '../php/atlas',
            consumerPresetName: 'wyxos-release',
            consumerPackage: '@wyxos/vibe',
            consumerMaintenanceMode: false,
            consumerSkipChecks: true,
            consumerSkipTests: true,
            consumerSkipLint: true,
            consumerSkipVersioning: true,
            consumerSkipGitHooks: true,
            consumerAutoCommit: true,
            explicitConsumerMaintenanceMode: true,
            explicitConsumerSkipChecks: true,
            explicitConsumerSkipTests: true,
            explicitConsumerSkipLint: true,
            explicitConsumerSkipVersioning: true,
            explicitConsumerSkipGitHooks: true,
            explicitConsumerAutoCommit: true
        }))
        expect(() => validateCliOptions(options)).not.toThrow()
    })

    it('rejects package-to-consumer release and deploy flags without a consumer preset', () => {
        const options = parseCliOptions(['--type=node', '--then-deploy', '../php/atlas'])

        expect(() => validateCliOptions(options)).toThrow('--then-deploy requires --consumer-preset <name>.')
    })

    it('rejects package-to-consumer deploys outside node and vue package releases', () => {
        expect(() => validateCliOptions(parseCliOptions([
            '--type=packagist',
            '--then-deploy',
            '../php/atlas',
            '--consumer-preset',
            'wyxos-release'
        ]))).toThrow('--then-deploy is only valid for node/vue package release workflows.')

        expect(() => validateCliOptions(parseCliOptions([
            '--then-deploy',
            '../php/atlas',
            '--consumer-preset',
            'wyxos-release'
        ]))).toThrow('--then-deploy is only valid for node/vue package release workflows.')
    })

    it('rejects consumer options without then-deploy', () => {
        const options = parseCliOptions(['--type=node', '--consumer-preset', 'wyxos-release'])

        expect(() => validateCliOptions(options)).toThrow('--consumer-* options require --then-deploy <path>.')
    })

    it('rejects skip-versioning when a bump argument is also provided', () => {
        const options = parseCliOptions(['--skip-versioning', 'minor'])

        expect(() => validateCliOptions(options)).toThrow(
            '--skip-versioning cannot be used together with an explicit version or bump argument.'
        )
    })

    it('rejects conflicting pending snapshot flags', () => {
        const options = parseCliOptions(['--resume-pending', '--discard-pending'])

        expect(() => validateCliOptions(options)).toThrow('Use either --resume-pending or --discard-pending, not both.')
    })
})
