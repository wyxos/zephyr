import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createChalkLogger, formatLogMessage} from '../../src/utils/output.mjs'

describe('output helpers', () => {
    let originalStdoutWrite
    let originalStderrWrite

    beforeEach(() => {
        originalStdoutWrite = process.stdout.write
        originalStderrWrite = process.stderr.write
        process.stdout.write = vi.fn()
        process.stderr.write = vi.fn()
    })

    afterEach(() => {
        process.stdout.write = originalStdoutWrite
        process.stderr.write = originalStderrWrite
    })

    it('formats prefixed messages while preserving leading newlines', () => {
        expect(formatLogMessage('Working...', '→')).toBe('→ Working...')
        expect(formatLogMessage('\nDone.', '✔')).toBe('\n✔ Done.')
        expect(formatLogMessage('\n\nFailed.', '✖')).toBe('\n\n✖ Failed.')
    })

    it('writes consistent prefixed messages through the shared chalk logger', () => {
        const identity = (message) => message
        const {logProcessing, logSuccess, logWarning, logError} = createChalkLogger({
            yellow: identity,
            green: identity,
            red: identity
        })

        logProcessing('Validating dependencies...')
        logSuccess('\nRelease completed.')
        logWarning('Skipping lint.')
        logError('\nRelease failed.')

        expect(process.stdout.write).toHaveBeenNthCalledWith(1, '→ Validating dependencies...\n')
        expect(process.stdout.write).toHaveBeenNthCalledWith(2, '\n✔ Release completed.\n')
        expect(process.stderr.write).toHaveBeenNthCalledWith(1, '⚠ Skipping lint.\n')
        expect(process.stderr.write).toHaveBeenNthCalledWith(2, '\n✖ Release failed.\n')
    })
})
