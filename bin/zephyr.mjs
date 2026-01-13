#!/usr/bin/env node
import process from 'node:process'
import { logError, main } from '../src/main.mjs'

// Parse --type flag from command line arguments
const args = process.argv.slice(2)
const typeFlag = args.find(arg => arg.startsWith('--type='))
const releaseType = typeFlag ? typeFlag.split('=')[1] : null

try {
  await main(releaseType)
} catch (error) {
  logError(error?.message || String(error))
  process.exitCode = 1
}
