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
            skipTests: false,
            skipLint: false,
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

    it('rejects conflicting pending snapshot flags', () => {
        const options = parseCliOptions(['--resume-pending', '--discard-pending'])

        expect(() => validateCliOptions(options)).toThrow('Use either --resume-pending or --discard-pending, not both.')
    })
})
