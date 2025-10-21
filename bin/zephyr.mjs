#!/usr/bin/env node
import { main } from '../src/index.mjs'

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
