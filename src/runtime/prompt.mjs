import {PromptRequiredError} from './errors.mjs'

function buildPromptMessage(questions = []) {
  const messages = questions
    .map((question) => question?.message)
    .filter((message) => typeof message === 'string' && message.trim().length > 0)

  return messages[0] ?? 'Zephyr requires interactive input to continue.'
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

  return async function runPrompt(questions) {
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
      return globalThis.__zephyrPrompt(questions)
    }

    return inquirer.prompt(questions)
  }
}
