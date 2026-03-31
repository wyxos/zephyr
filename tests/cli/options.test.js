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
            json: true,
            presetName: 'production',
            resumePending: true,
            discardPending: false,
            maintenanceMode: true,
            skipGitHooks: false,
            skipChecks: false,
            skipTests: true,
            skipLint: true,
            skipBuild: false,
            skipDeploy: false
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

    it('rejects conflicting pending snapshot flags', () => {
        const options = parseCliOptions(['--resume-pending', '--discard-pending'])

        expect(() => validateCliOptions(options)).toThrow('Use either --resume-pending or --discard-pending, not both.')
    })
})
