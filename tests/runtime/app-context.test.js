import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createAppContext} from '#src/runtime/app-context.mjs'

describe('runtime/app-context', () => {
    let originalStdoutWrite
    let originalStderrWrite
    let stdoutWrite
    let stderrWrite

    function createJsonContext({runCommandImpl = vi.fn(), runCommandCaptureImpl = vi.fn()} = {}) {
        const inquirerInstance = /** @type {any} */ ({prompt: vi.fn()})

        return createAppContext({
            inquirerInstance,
            runCommandImpl,
            runCommandCaptureImpl,
            executionMode: {
                interactive: false,
                json: true,
                workflow: 'deploy'
            }
        })
    }

    beforeEach(() => {
        originalStdoutWrite = process.stdout.write
        originalStderrWrite = process.stderr.write
        stdoutWrite = vi.fn()
        stderrWrite = vi.fn()
        process.stdout.write = stdoutWrite
        process.stderr.write = stderrWrite
    })

    afterEach(() => {
        process.stdout.write = originalStdoutWrite
        process.stderr.write = originalStderrWrite
    })

    it('emits NDJSON log events to stdout in JSON mode', () => {
        const context = createJsonContext()

        context.logProcessing('Selected deployment target.', {
            deploymentConfig: {serverName: 'production'}
        })

        expect(stdoutWrite).toHaveBeenCalledTimes(1)
        const payload = JSON.parse(stdoutWrite.mock.calls[0][0].trim())
        expect(payload).toEqual(expect.objectContaining({
            event: 'log',
            workflow: 'deploy',
            level: 'processing',
            message: 'Selected deployment target.',
            data: {
                deploymentConfig: {
                    serverName: 'production'
                }
            }
        }))
    })

    it('routes inherited child process output to stderr in JSON mode', async () => {
        const runCommandImpl = vi.fn().mockResolvedValue(undefined)
        const context = createJsonContext({
            runCommandImpl,
        })

        await context.runCommand('npm', ['run', 'build'], {cwd: '/workspace/project'})

        expect(runCommandImpl).toHaveBeenCalledWith('npm', ['run', 'build'], {
            cwd: '/workspace/project',
            stdio: ['ignore', process.stderr, process.stderr]
        })
    })

    it('treats skip-checks as shorthand for skip-lint and skip-tests in execution mode', () => {
        const context = createAppContext({
            executionMode: {
                skipChecks: true
            }
        })

        expect(context.executionMode).toEqual(expect.objectContaining({
            skipChecks: true,
            skipLint: true,
            skipTests: true
        }))
    })
})
