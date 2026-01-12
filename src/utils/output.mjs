import process from 'node:process'

export function writeStdoutLine(message = '') {
  const text = message == null ? '' : String(message)
  process.stdout.write(`${text}\n`)
}

export function writeStderrLine(message = '') {
  const text = message == null ? '' : String(message)
  process.stderr.write(`${text}\n`)
}

export function writeStderr(message = '') {
  const text = message == null ? '' : String(message)
  process.stderr.write(text)
  if (text && !text.endsWith('\n')) {
    process.stderr.write('\n')
  }
}

export function createChalkLogger(chalk) {
  return {
    logProcessing: (message = '') => writeStdoutLine(chalk.yellow(message)),
    logSuccess: (message = '') => writeStdoutLine(chalk.green(message)),
    logWarning: (message = '') => writeStderrLine(chalk.yellow(message)),
    logError: (message = '') => writeStderrLine(chalk.red(message))
  }
}

