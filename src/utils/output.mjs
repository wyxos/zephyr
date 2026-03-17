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

export function createJsonEventEmitter({
    workflow,
    writeEvent = writeStdoutLine
} = {}) {
    return function emitEvent(event, {
        level,
        message = '',
        data = {},
        code
    } = {}) {
        const payload = {
            event,
            timestamp: new Date().toISOString(),
            workflow,
            message
        }

        if (level) {
            payload.level = level
        }

        if (code) {
            payload.code = code
        }

        payload.data = data ?? {}
        writeEvent(JSON.stringify(payload))
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

export function createJsonLogger({
    emitEvent
} = {}) {
    if (typeof emitEvent !== 'function') {
        throw new Error('createJsonLogger requires emitEvent')
    }

    return {
        logProcessing: (message = '', data = {}) => emitEvent('log', {level: 'processing', message: String(message ?? ''), data}),
        logSuccess: (message = '', data = {}) => emitEvent('log', {level: 'success', message: String(message ?? ''), data}),
        logWarning: (message = '', data = {}) => emitEvent('log', {level: 'warning', message: String(message ?? ''), data}),
        logError: (message = '', data = {}) => emitEvent('log', {level: 'error', message: String(message ?? ''), data})
    }
}
