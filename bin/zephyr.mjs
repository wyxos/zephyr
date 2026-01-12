#!/usr/bin/env node
import { main } from '../src/index.mjs'
import { checkAndUpdateVersion } from '../src/version-checker.mjs'
import inquirer from 'inquirer'

// Parse --type flag from command line arguments
const args = process.argv.slice(2)
const typeFlag = args.find(arg => arg.startsWith('--type='))
const releaseType = typeFlag ? typeFlag.split('=')[1] : null

// Check for updates and re-execute if user confirms
checkAndUpdateVersion((questions) => inquirer.prompt(questions), args)
  .then((reExecuted) => {
    if (reExecuted) {
      // Version was updated and script re-executed, exit this process
      process.exit(0)
    }
    // No update or user declined, continue with normal execution
    return main(releaseType)
  })
  .catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
