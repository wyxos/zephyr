#!/usr/bin/env node
import process from 'node:process'
import { Command } from 'commander'
import chalk from 'chalk'
import { main } from '../src/main.mjs'
import { createChalkLogger } from '../src/utils/output.mjs'

const { logError } = createChalkLogger(chalk)

const program = new Command()

program
  .name('zephyr')
  .description('A streamlined deployment tool for web applications with intelligent Laravel project detection')
  .option('--type <type>', 'Workflow type (node|vue|packagist). Omit for normal app deployments.')
  .argument(
    '[version]',
    'Version or npm bump type for deployments (e.g. 1.2.3, patch, minor, major). --type node/vue/packagist workflows accept bump types only and default to patch.'
  )

program.parse(process.argv)
const options = program.opts()
const versionArg = program.args[0] ?? null

try {
  await main(options.type ?? null, versionArg)
} catch (error) {
  logError(error?.message || String(error))
  process.exitCode = 1
}
