import {PassThrough} from 'node:stream'
import inquirerModule from 'inquirer'
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
    it('does not open an interactive UI for an already-aborted prompt', async () => {
        const controller = new AbortController()
        controller.abort()
        const inquirer = {prompt: vi.fn()}
        await expect(createRunPrompt({inquirer})([], {signal: controller.signal})).rejects.toMatchObject({code: 'ZEPHYR_PROMPT_CANCELLED'})
        expect(inquirer.prompt).not.toHaveBeenCalled()
    })

    it('closes the owned UI and removes its abort handler when cancelled', async () => {
        const controller = new AbortController()
        const close = vi.fn()
        const prompt = Object.assign(new Promise(() => {}), {ui: {close}})
        const inquirer = {prompt: vi.fn().mockReturnValue(prompt)}
        const add = vi.spyOn(controller.signal, 'addEventListener')
        const remove = vi.spyOn(controller.signal, 'removeEventListener')
        const pending = createRunPrompt({inquirer})([], {signal: controller.signal})
        const rejected = expect(pending).rejects.toMatchObject({code: 'ZEPHYR_PROMPT_CANCELLED'})
        controller.abort()
        await rejected
        expect(close).toHaveBeenCalledTimes(1)
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    })

    it('removes the abort handler after a normal answer and does not close a completed UI later', async () => {
        const controller = new AbortController()
        const close = vi.fn()
        const prompt = Object.assign(Promise.resolve({ciAccessAction: 'retry'}), {ui: {close}})
        const add = vi.spyOn(controller.signal, 'addEventListener')
        const remove = vi.spyOn(controller.signal, 'removeEventListener')
        await expect(createRunPrompt({inquirer: {prompt: vi.fn().mockReturnValue(prompt)}})([], {signal: controller.signal})).resolves.toEqual({ciAccessAction: 'retry'})
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
        controller.abort()
        expect(close).not.toHaveBeenCalled()
    })

    it('removes the abort handler when Inquirer fails', async () => {
        const controller = new AbortController()
        const remove = vi.spyOn(controller.signal, 'removeEventListener')
        const inquirer = {prompt: vi.fn().mockRejectedValue(new Error('prompt failed'))}
        await expect(createRunPrompt({inquirer})([], {signal: controller.signal})).rejects.toThrow('prompt failed')
        expect(remove).toHaveBeenCalledTimes(1)
    })

    it('closes the actual Inquirer readline interface on cancellation', async () => {
        const input = new PassThrough()
        const output = new PassThrough()
        const controller = new AbortController()
        let prompt
        const module = inquirerModule.createPromptModule({input, output})
        const inquirer = {prompt: questions => { prompt = module(questions); return prompt }}
        try {
            const pending = createRunPrompt({inquirer})([{type: 'list', name: 'ciAccessAction', message: 'Retry?', choices: ['Retry', 'Cancel']}], {signal: controller.signal})
            const rejected = expect(pending).rejects.toMatchObject({code: 'ZEPHYR_PROMPT_CANCELLED'})
            controller.abort()
            await rejected
            expect(prompt.ui.rl.closed).toBe(true)
        } finally {
            input.destroy()
            output.destroy()
        }
    })

})
