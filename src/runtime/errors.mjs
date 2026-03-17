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
