import {PromptRequiredError, ZephyrError} from './errors.mjs'

function buildPromptMessage(questions = []) {
  const messages = questions
    .map((question) => question?.message)
    .filter((message) => typeof message === 'string' && message.trim().length > 0)

  return messages[0] ?? 'Zephyr requires interactive input to continue.'
}

function cancelledPrompt(cause) {
  return new ZephyrError('Interactive prompt cancelled.', {code: 'ZEPHYR_PROMPT_CANCELLED', cause})
}

function awaitPrompt(prompt, signal) {
  if (!signal) return prompt
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      if (settled) return
      settled = true
      cleanup()
      let closeError
      try {
        // Inquirer 9 exposes the active readline UI on the promise. Closing it releases the terminal.
        prompt?.ui?.close?.()
      } catch (error) { closeError = error }
      reject(cancelledPrompt(closeError))
    }
    signal.addEventListener('abort', abort, {once: true})
    Promise.resolve(prompt).then(answer => {
      if (settled) return
      settled = true
      cleanup()
      resolve(answer)
    }, error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    // Prompt construction can synchronously abort its owner before this listener is attached.
    if (signal.aborted) abort()
  })
}

export function createRunPrompt({
  inquirer,
  interactive = true,
  emitEvent,
  workflow = 'deploy'
}) {
  if (!inquirer) {
    throw new Error('createRunPrompt requires inquirer')
  }

  return async function runPrompt(questions, {signal} = {}) {
    if (signal?.aborted) throw cancelledPrompt()
    if (!interactive) {
      const message = buildPromptMessage(questions)
      const error = new PromptRequiredError(message, {
        data: {
          workflow,
          questions: Array.isArray(questions)
            ? questions.map((question) => ({
              name: question?.name ?? null,
              type: question?.type ?? null,
              message: question?.message ?? null
            }))
            : []
        }
      })

      emitEvent?.('prompt_required', {
        message,
        code: error.code,
        data: error.data
      })

      throw error
    }

    if (typeof globalThis !== 'undefined' && globalThis.__zephyrPrompt) {
      return awaitPrompt(globalThis.__zephyrPrompt(questions, ...(signal ? [{signal}] : [])), signal)
    }

    return awaitPrompt(inquirer.prompt(questions), signal)
  }
}
