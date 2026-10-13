import {resolveReleaseType} from './release/release-type.mjs'
import {runCommand, runCommandCapture} from './utils/command.mjs'

/** Recommend a bump without changing version files, committing, tagging, or publishing. */
export async function recommendReleaseType(options = {}) {
  return resolveReleaseType({
    ...options,
    runCommand: options.runCommand ?? runCommand,
    runCommandCapture: options.runCommandCapture ?? (options.runCommand ? undefined : runCommandCapture),
    includeWorkingTree: true,
    interactive: false
  })
}
