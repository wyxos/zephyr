#!/usr/bin/env node
import process from 'node:process'

import {parseCliOptions} from '../src/cli/options.mjs'
import {main} from '../src/main.mjs'
import {writeStderrLine} from '../src/utils/output.mjs'

let options
try {
    options = parseCliOptions()
} catch (error) {
    writeStderrLine(error.message)
    process.exitCode = 1
}

if (options) {
    try {
        await main(options)
    } catch {
        process.exitCode = 1
    }
}
