import {describe, expect, it, vi} from 'vitest'

import {notifyWorkflowResult} from '#src/utils/notifications.mjs'

describe('utils/notifications', () => {
    it('sends a success notification through osascript on macOS', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined)

        const result = await notifyWorkflowResult({
            status: 'success',
            workflow: 'deploy',
            presetName: 'staging',
            rootDir: '/workspace/demo'
        }, {
            processRef: {platform: 'darwin'},
            commandExistsImpl: vi.fn().mockReturnValue(true),
            runCommand
        })

        expect(result).toBe(true)
        expect(runCommand).toHaveBeenCalledWith('osascript', [
            '-e',
            expect.stringContaining('display notification "Workflow completed successfully."')
        ], {
            cwd: '/workspace/demo',
            stdio: 'ignore'
        })
        expect(runCommand.mock.calls[0][1][1]).toContain('with title "🟢 Zephyr Passed"')
        expect(runCommand.mock.calls[0][1][1]).toContain('subtitle "Deploy • demo • staging"')
        expect(runCommand.mock.calls[0][1][1]).toContain('sound name "Glass"')
    })

    it('sends a failure notification with the error message on macOS', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined)

        const result = await notifyWorkflowResult({
            status: 'failure',
            workflow: 'release-node',
            rootDir: '/workspace/zephyr',
            message: 'The release failed because something exploded.'
        }, {
            processRef: {platform: 'darwin'},
            commandExistsImpl: vi.fn().mockReturnValue(true),
            runCommand
        })

        expect(result).toBe(true)
        expect(runCommand.mock.calls[0][1][1]).toContain('with title "🔴 Zephyr Failed"')
        expect(runCommand.mock.calls[0][1][1]).toContain('subtitle "Node Release • zephyr"')
        expect(runCommand.mock.calls[0][1][1]).toContain('The release failed because something exploded.')
        expect(runCommand.mock.calls[0][1][1]).toContain('sound name "Basso"')
    })

    it('does nothing outside macOS or when osascript is unavailable', async () => {
        const runCommand = vi.fn()

        await expect(notifyWorkflowResult({
            status: 'success',
            rootDir: '/workspace/demo'
        }, {
            processRef: {platform: 'linux'},
            commandExistsImpl: vi.fn().mockReturnValue(true),
            runCommand
        })).resolves.toBe(false)

        await expect(notifyWorkflowResult({
            status: 'success',
            rootDir: '/workspace/demo'
        }, {
            processRef: {platform: 'darwin'},
            commandExistsImpl: vi.fn().mockReturnValue(false),
            runCommand
        })).resolves.toBe(false)

        expect(runCommand).not.toHaveBeenCalled()
    })
})
