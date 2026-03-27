import path from 'node:path'
import process from 'node:process'

import {commandExists, runCommand as runCommandBase} from './command.mjs'

const MAX_NOTIFICATION_MESSAGE_LENGTH = 180

function escapeAppleScriptString(value = '') {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

function humanizeWorkflow(workflow = 'deploy') {
  if (workflow === 'release-node') {
    return 'Node Release'
  }

  if (workflow === 'release-packagist') {
    return 'Packagist Release'
  }

  return 'Deploy'
}

function truncateNotificationMessage(message = '') {
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim()

  if (normalized.length <= MAX_NOTIFICATION_MESSAGE_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, MAX_NOTIFICATION_MESSAGE_LENGTH - 1).trimEnd()}…`
}

function buildNotificationPayload({
  status = 'success',
  workflow = 'deploy',
  presetName = null,
  rootDir = process.cwd(),
  message = ''
} = {}) {
  const isSuccess = status === 'success'
  const repoName = path.basename(rootDir || process.cwd()) || 'project'
  const title = isSuccess ? '🟢 Zephyr Passed' : '🔴 Zephyr Failed'
  const subtitleParts = [humanizeWorkflow(workflow), repoName]

  if (presetName) {
    subtitleParts.push(presetName)
  }

  return {
    title,
    subtitle: subtitleParts.join(' • '),
    message: isSuccess
      ? 'Workflow completed successfully.'
      : truncateNotificationMessage(message || 'Workflow failed.'),
    soundName: isSuccess ? 'Glass' : 'Basso'
  }
}

export async function notifyWorkflowResult({
  status = 'success',
  workflow = 'deploy',
  presetName = null,
  rootDir = process.cwd(),
  message = ''
} = {}, {
  processRef = process,
  commandExistsImpl = commandExists,
  runCommand = runCommandBase
} = {}) {
  if (processRef.platform !== 'darwin' || !commandExistsImpl('osascript')) {
    return false
  }

  const payload = buildNotificationPayload({
    status,
    workflow,
    presetName,
    rootDir,
    message
  })

  const script = [
    `display notification "${escapeAppleScriptString(payload.message)}"`,
    `with title "${escapeAppleScriptString(payload.title)}"`,
    `subtitle "${escapeAppleScriptString(payload.subtitle)}"`,
    `sound name "${escapeAppleScriptString(payload.soundName)}"`
  ].join(' ')

  try {
    await runCommand('osascript', ['-e', script], {
      cwd: rootDir,
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}
