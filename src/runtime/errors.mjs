export class ZephyrError extends Error {
    constructor(message, {
        code = 'ZEPHYR_FAILURE',
        data = {},
        cause
    } = {}) {
        super(message, cause ? {cause} : undefined)
        this.name = this.constructor.name
        this.code = code
        this.data = data
    }
}

export class PromptRequiredError extends ZephyrError {
    constructor(message, {
        data = {},
        cause
    } = {}) {
        super(message, {
            code: 'ZEPHYR_PROMPT_REQUIRED',
            data,
            cause
        })
    }
}

export class InvalidCliOptionsError extends ZephyrError {
    constructor(message, {
        data = {},
        cause
    } = {}) {
        super(message, {
            code: 'ZEPHYR_INVALID_OPTIONS',
            data,
            cause
        })
    }
}

export function getErrorCode(error) {
    if (error && typeof error === 'object' && typeof error.code === 'string' && error.code.length > 0) {
        return error.code
    }

    return 'ZEPHYR_FAILURE'
}

export function getSafeErrorData(error) {
    const source = error?.data ?? {}
    const data = {}
    for (const key of ['stepLabel', 'exitCode', 'reason', 'runId', 'url', 'conclusion']) {
        if (typeof source[key] === 'string' || typeof source[key] === 'number' || source[key] === null) data[key] = source[key]
    }
    if (typeof source.workflow === 'string') data.requiredWorkflow = source.workflow
    if (Array.isArray(source.pending)) data.pending = source.pending.map(item => {
        const pending = {}
        for (const key of ['workflow', 'reason', 'runId', 'url']) {
            if (typeof item?.[key] === 'string' || typeof item?.[key] === 'number') pending[key] = item[key]
        }
        return pending
    })
    return data
}
