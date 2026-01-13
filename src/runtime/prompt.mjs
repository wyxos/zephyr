export function createRunPrompt({ inquirer }) {
  if (!inquirer) {
    throw new Error('createRunPrompt requires inquirer')
  }

  return async function runPrompt(questions) {
    if (typeof globalThis !== 'undefined' && globalThis.__zephyrPrompt) {
      return globalThis.__zephyrPrompt(questions)
    }

    return inquirer.prompt(questions)
  }
}

