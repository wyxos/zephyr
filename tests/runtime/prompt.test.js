import {describe, expect, it, vi} from 'vitest'

import {createRunPrompt} from '#src/runtime/prompt.mjs'

describe('runtime/prompt', () => {
    it('emits a prompt_required event and throws in non-interactive mode', async () => {
        const inquirer = {prompt: vi.fn()}
        const emitEvent = vi.fn()
        const runPrompt = createRunPrompt({
            inquirer,
            interactive: false,
            emitEvent,
            workflow: 'deploy'
        })

        await expect(runPrompt([
            {
                type: 'confirm',
                name: 'resumePendingTasks',
                message: 'Resume the pending deployment?'
            }
        ])).rejects.toMatchObject({
            code: 'ZEPHYR_PROMPT_REQUIRED'
        })

        expect(inquirer.prompt).not.toHaveBeenCalled()
        expect(emitEvent).toHaveBeenCalledWith('prompt_required', expect.objectContaining({
            code: 'ZEPHYR_PROMPT_REQUIRED',
            message: 'Resume the pending deployment?',
            data: {
                workflow: 'deploy',
                questions: [
                    {
                        name: 'resumePendingTasks',
                        type: 'confirm',
                        message: 'Resume the pending deployment?'
                    }
                ]
            }
        }))
    })

    it('delegates to inquirer when interactive mode is enabled', async () => {
        const inquirer = {
            prompt: vi.fn().mockResolvedValue({presetName: 'production'})
        }
        const runPrompt = createRunPrompt({
            inquirer,
            interactive: true
        })

        await expect(runPrompt([
            {
                type: 'input',
                name: 'presetName',
                message: 'Preset name'
            }
        ])).resolves.toEqual({presetName: 'production'})

        expect(inquirer.prompt).toHaveBeenCalledTimes(1)
    })
})
