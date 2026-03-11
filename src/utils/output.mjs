import process from 'node:process'

export const LOG_PREFIXES = Object.freeze({
    processing: '→',
    success: '✔',
    warning: '⚠',
    error: '✖'
})

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

export function formatLogMessage(message = '', prefix = '') {
    const text = message == null ? '' : String(message)

    if (!prefix || text.length === 0) {
        return text
    }

    const leadingNewlines = text.match(/^\n+/)?.[0] ?? ''
    const body = text.slice(leadingNewlines.length)

    if (body.length === 0) {
        return `${leadingNewlines}${prefix}`
    }

    return `${leadingNewlines}${prefix} ${body}`
}

export function createChalkLogger(chalk, {
    prefixes = LOG_PREFIXES
} = {}) {
    return {
        logProcessing: (message = '') => writeStdoutLine(chalk.yellow(formatLogMessage(message, prefixes.processing))),
        logSuccess: (message = '') => writeStdoutLine(chalk.green(formatLogMessage(message, prefixes.success))),
        logWarning: (message = '') => writeStderrLine(chalk.yellow(formatLogMessage(message, prefixes.warning))),
        logError: (message = '') => writeStderrLine(chalk.red(formatLogMessage(message, prefixes.error)))
    }
}
