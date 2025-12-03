#!/usr/bin/env node
import { main } from '../src/index.mjs'

// Parse --type flag from command line arguments
const args = process.argv.slice(2)
const typeFlag = args.find(arg => arg.startsWith('--type='))
const releaseType = typeFlag ? typeFlag.split('=')[1] : null

// Pass the type to main function
main(releaseType).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
