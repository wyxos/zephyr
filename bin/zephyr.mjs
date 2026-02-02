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
  .option('--type <type>', 'Release type (node|vue|packagist)')

program.parse(process.argv)
const options = program.opts()

try {
  await main(options.type ?? null)
} catch (error) {
  logError(error?.message || String(error))
  process.exitCode = 1
}
