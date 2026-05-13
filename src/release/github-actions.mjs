import {readdir} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {runReleaseCommand} from './shared.mjs'

const DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS = 60_000
const DEFAULT_WORKFLOW_POLL_INTERVAL_MS = 3_000
const RUN_CREATED_AT_TOLERANCE_MS = 5_000

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function describeError(error) {
  const stderr = String(error?.stderr ?? '').trim()
  if (stderr) {
    return stderr
  }

  const message = String(error?.message ?? '').trim()
  if (message) {
    return message
  }

  return String(error ?? 'unknown error')
}

async function hasGitHubWorkflowFiles(rootDir) {
  const workflowDir = path.join(rootDir, '.github', 'workflows')

  try {
    const entries = await readdir(workflowDir, {withFileTypes: true})

    return entries.some((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
  } catch {
    return false
  }
}

function parseWorkflowRuns(stdout) {
  try {
    const parsed = JSON.parse(stdout || '[]')

    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function isRunForCurrentPush(run, pushStartedAt) {
  if (!pushStartedAt || !run?.createdAt) {
    return true
  }

  const runCreatedAt = Date.parse(run.createdAt)
  const startedAt = pushStartedAt instanceof Date
    ? pushStartedAt.getTime()
    : Date.parse(pushStartedAt)

  if (!Number.isFinite(runCreatedAt) || !Number.isFinite(startedAt)) {
    return true
  }

  return runCreatedAt >= startedAt - RUN_CREATED_AT_TOLERANCE_MS
}

function workflowLabel(run) {
  const workflowName = run?.workflowName || run?.name || 'GitHub Actions workflow'
  const databaseId = run?.databaseId ? `#${run.databaseId}` : ''

  return `${workflowName}${databaseId ? ` ${databaseId}` : ''}`
}

async function findCurrentPushRuns(rootDir, {
  runCommand,
  headSha,
  pushStartedAt,
  timeoutMs,
  pollIntervalMs,
  sleepImpl
}) {
  const deadline = Date.now() + timeoutMs
  let shouldPoll = true

  while (shouldPoll) {
    const {stdout} = await runCommand('gh', [
      'run',
      'list',
      '--commit',
      headSha,
      '--event',
      'push',
      '--json',
      'databaseId,status,conclusion,workflowName,createdAt,url',
      '--limit',
      '20'
    ], {
      capture: true,
      cwd: rootDir
    })

    const runs = parseWorkflowRuns(stdout)
      .filter((run) => run?.databaseId)
      .filter((run) => isRunForCurrentPush(run, pushStartedAt))

    if (runs.length > 0) {
      return runs
    }

    shouldPoll = Date.now() < deadline

    if (shouldPoll) {
      await sleepImpl(pollIntervalMs)
    }
  }

  return []
}

export async function waitForGitHubReleaseWorkflows(rootDir = process.cwd(), {
  runCommand = runReleaseCommand,
  logStep,
  logSuccess,
  logWarning,
  pushStartedAt = new Date(),
  timeoutMs = DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_WORKFLOW_POLL_INTERVAL_MS,
  sleepImpl = sleep
} = {}) {
  if (!await hasGitHubWorkflowFiles(rootDir)) {
    return {status: 'skipped', reason: 'no-workflows', runs: []}
  }

  try {
    await runCommand('gh', ['--version'], {capture: true, cwd: rootDir})
  } catch (error) {
    logWarning?.(`GitHub Actions workflow monitoring skipped because GitHub CLI is unavailable: ${describeError(error)}`)
    return {status: 'skipped', reason: 'gh-unavailable', runs: []}
  }

  let headSha
  try {
    const result = await runCommand('git', ['rev-parse', 'HEAD'], {capture: true, cwd: rootDir})
    headSha = result.stdout.trim()
  } catch (error) {
    logWarning?.(`GitHub Actions workflow monitoring skipped because the release commit could not be resolved: ${describeError(error)}`)
    return {status: 'skipped', reason: 'head-unavailable', runs: []}
  }

  if (!headSha) {
    logWarning?.('GitHub Actions workflow monitoring skipped because the release commit could not be resolved.')
    return {status: 'skipped', reason: 'head-unavailable', runs: []}
  }

  logStep?.('Checking for GitHub Actions workflows triggered by the release push...')

  let runs = []
  try {
    runs = await findCurrentPushRuns(rootDir, {
      runCommand,
      headSha,
      pushStartedAt,
      timeoutMs,
      pollIntervalMs,
      sleepImpl
    })
  } catch (error) {
    logWarning?.(`GitHub Actions workflow monitoring skipped because workflow runs could not be listed: ${describeError(error)}`)
    return {status: 'skipped', reason: 'list-failed', runs: []}
  }

  if (runs.length === 0) {
    logWarning?.('GitHub Actions workflow monitoring skipped because no workflow run appeared for the release push.')
    return {status: 'skipped', reason: 'no-runs', runs: []}
  }

  for (const run of runs) {
    const label = workflowLabel(run)
    logStep?.(`Watching GitHub Actions workflow ${label}...`)

    try {
      await runCommand('gh', ['run', 'watch', String(run.databaseId), '--exit-status', '--compact'], {
        cwd: rootDir
      })
    } catch (_error) {
      const suffix = run.url ? ` ${run.url}` : ''
      throw new Error(`GitHub Actions workflow ${label} failed or could not be watched.${suffix}`)
    }

    logSuccess?.(`GitHub Actions workflow ${label} completed successfully.`)
  }

  return {status: 'watched', reason: null, runs}
}
