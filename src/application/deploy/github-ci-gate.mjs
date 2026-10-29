import {ZephyrError} from '../../runtime/errors.mjs'
import {runCommandCapture as captureCommand} from '../../utils/command.mjs'

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_RUNS = 1000
const RUN_FIELDS = 'databaseId,workflowDatabaseId,workflowName,headSha,headBranch,event,status,conclusion,url,createdAt,attempt'

function fail(message, reason, data = {}, cause) {
  return new ZephyrError(message, {code: 'ZEPHYR_CI_GATE_FAILED', data: {reason, ...data}, cause})
}

export function normalizeDeploymentCiPolicy(policy) {
  if (policy == null || policy === false || policy?.enabled === false) return null
  if (typeof policy !== 'object' || Array.isArray(policy) || policy.enabled !== true) {
    throw fail('CI policy must explicitly enable the gate and name required workflows.', 'invalid-policy')
  }
  const names = policy.requiredWorkflows
  if (!Array.isArray(names) || names.length === 0 || names.length > 20 || names.some(name => typeof name !== 'string' || !name.trim())) {
    throw fail('Enabled CI gate requires between 1 and 20 non-empty requiredWorkflows names.', 'invalid-policy')
  }
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 24 * 60 * 60_000) {
    throw fail('CI timeoutMs must be a positive integer no greater than 24 hours.', 'invalid-policy')
  }
  return {enabled: true, requiredWorkflows: [...new Set(names.map(name => name.trim()))], timeoutMs}
}

function commandOutput(result) {
  return typeof result === 'string' ? result.trim() : String(result?.stdout ?? '').trim()
}

async function repositoryFromRemote(remote, {runCommandCapture, rootDir, signal}) {
  const scp = remote.match(/^(?:[^@\s]+@)?([^:/\s]+):([^\s]+)$/)
  let host
  let repository
  let usesSsh = false
  if (scp && !remote.includes('://')) {
    usesSsh = true
    host = scp[1]
    repository = scp[2]
  } else {
    let url
    try { url = new URL(remote) } catch { throw fail('Cannot resolve the origin repository for the CI gate.', 'invalid-origin') }
    if (!['https:', 'ssh:'].includes(url.protocol)) throw fail('CI gate requires a GitHub HTTPS or SSH origin.', 'invalid-origin')
    usesSsh = url.protocol === 'ssh:'
    host = url.hostname
    repository = url.pathname.replace(/^\//, '')
  }
  repository = repository.replace(/\.git$/, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw fail('Cannot resolve the origin repository for the CI gate.', 'invalid-origin')
  }
  if (usesSsh && host.toLowerCase() !== 'github.com') {
    try {
      const output = commandOutput(await runCommandCapture('ssh', ['-G', host], {cwd: rootDir, signal}))
      // SSH aliases select keys locally; only HostName determines the GitHub API host.
      // Never log the expanded config, which can include private paths and proxy commands.
      const hostNames = output.split(/\r?\n/).map(line => line.match(/^hostname\s+(\S+)\s*$/i)?.[1]).filter(Boolean)
      if (hostNames.length !== 1 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(hostNames[0])) {
        throw new Error('SSH did not return one valid HostName')
      }
      host = hostNames[0]
    } catch (cause) {
      throw fail(`Cannot resolve SSH origin host "${host}" using ssh -G. Check the local SSH alias configuration before retrying.`, 'invalid-origin', {}, cause)
    }
  }
  return `${host.toLowerCase()}/${repository}`
}

export function evaluateDeploymentCiSnapshot(runs, {headSha, branch, policy}) {
  if (!Array.isArray(runs)) throw fail('GitHub returned an invalid workflow-run response.', 'invalid-response')
  if (runs.length >= MAX_RUNS) throw fail('CI run discovery reached its safety limit; narrow or inspect this release manually.', 'discovery-limit')
  const exactRuns = runs.filter(run => run && run.headSha === headSha && run.headBranch === branch && run.event === 'push')
  const selected = []
  const pending = []
  for (const workflow of policy.requiredWorkflows) {
    const matches = exactRuns.filter(run => run.workflowName === workflow)
    if (new Set(matches.map(run => run.workflowDatabaseId).filter(Boolean)).size > 1) {
      throw fail(`Required workflow name "${workflow}" is ambiguous; use unique workflow names.`, 'ambiguous-workflow', {workflow})
    }
    matches.sort((left, right) => Number(right.databaseId) - Number(left.databaseId) || Number(right.attempt ?? 1) - Number(left.attempt ?? 1))
    const run = matches[0]
    if (!run) {
      pending.push({workflow, reason: 'missing'})
      continue
    }
    if (!Number.isSafeInteger(run.databaseId) || run.databaseId <= 0) throw fail('GitHub returned a workflow without a valid run ID.', 'invalid-response', {workflow})
    selected.push(run)
    if (run.status !== 'completed') {
      pending.push({workflow, reason: 'pending', runId: run.databaseId, url: run.url})
    } else if (run.conclusion !== 'success') {
      throw fail(`Required CI workflow "${workflow}" did not succeed (${run.conclusion || 'unknown'}).${run.url ? ` ${run.url}` : ''}`, 'workflow-failed', {workflow, runId: run.databaseId, conclusion: run.conclusion, url: run.url})
    }
  }
  return {status: pending.length ? 'pending' : 'passed', headSha, branch, runs: selected, pending}
}

async function awaitWithinDeadline(callback, {timeoutMs, signal}) {
  const controller = new AbortController()
  let timer
  let abortListener
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback(controller.signal)),
      new Promise((_, reject) => {
        abortListener = () => {
          controller.abort()
          reject(fail('CI wait cancelled; deployment has not started.', 'cancelled'))
        }
        if (signal?.aborted) return abortListener()
        signal?.addEventListener('abort', abortListener, {once: true})
        // A single total deadline also bounds provider access and interactive recovery.
        timer = setTimeout(() => {
          controller.abort()
          reject(fail('CI wait timed out before all required workflows succeeded. Check missing workflow names or inspect GitHub; deployment has not started.', 'timeout'))
        }, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortListener)
    controller.abort()
  }
}

function waitForNextCheck(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer
    const abort = () => {
      clearTimeout(timer)
      reject(fail('CI wait cancelled; deployment has not started.', 'cancelled'))
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, {once: true})
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
  })
}

async function watchDeploymentCi({state, readSnapshot, signal, waitForNextCheck: wait, logProcessing}) {
  let current = state
  let previousMessage
  while (current.status === 'pending') {
    const message = current.pending.map(item => `${item.workflow} (${item.reason}${item.url ? `: ${item.url}` : ''})`).join(', ')
    if (message !== previousMessage) logProcessing?.(`Waiting for required CI: ${message}`)
    previousMessage = message
    // Explicitly authorized release-only GitHub status watching: GitHub has no direct local completion stream.
    // This bounded watcher exists only during an enabled release gate; ordinary application polling is unchanged.
    await wait(5000, signal)
    current = await readSnapshot()
  }
}

export async function waitForDeploymentCi({
  rootDir,
  headSha,
  branch,
  policy,
  runCommandCapture = captureCommand,
  awaitCompletion,
  waitForNextCheck: wait = waitForNextCheck,
  interactive = false,
  runPrompt,
  signal,
  logProcessing,
  logWarning,
  logSuccess
} = {}) {
  const normalized = normalizeDeploymentCiPolicy(policy)
  if (!normalized) return {status: 'skipped', reason: 'disabled', runs: []}
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headSha ?? '') || typeof branch !== 'string' || !branch || !rootDir) {
    throw fail('CI gate requires the full release commit, branch and local repository path.', 'invalid-context')
  }
  if (signal?.aborted) throw fail('CI wait cancelled; deployment has not started.', 'cancelled')
  return awaitWithinDeadline(async waitSignal => {
    let repository
    const readSnapshot = async () => {
      while (true) {
        if (waitSignal.aborted) throw fail('CI wait cancelled; deployment has not started.', 'cancelled')
        try {
          repository ??= await repositoryFromRemote(commandOutput(await runCommandCapture('git', ['remote', 'get-url', 'origin'], {cwd: rootDir, signal: waitSignal})), {runCommandCapture, rootDir, signal: waitSignal})
          const output = commandOutput(await runCommandCapture('gh', ['run', 'list', '--repo', repository, '--commit', headSha, '--branch', branch, '--event', 'push', '--limit', String(MAX_RUNS), '--json', RUN_FIELDS], {cwd: rootDir, signal: waitSignal}))
          return evaluateDeploymentCiSnapshot(JSON.parse(output), {headSha, branch, policy: normalized})
        } catch (error) {
          if (error instanceof ZephyrError) throw error
          if (waitSignal.aborted) throw fail('CI wait cancelled; deployment has not started.', 'cancelled')
          const missingGh = error.code === 'ENOENT' || /command not found.*gh/i.test(error.message ?? '')
          const message = missingGh
            ? 'GitHub CLI (gh) is missing. Install it and ensure gh is in PATH, then run gh auth login with access to this repository.'
            : 'GitHub CI could not be verified. Run gh auth status, sign in with gh auth login if needed, and check repository/Actions read access.'
          if (!interactive || typeof runPrompt !== 'function') {
            throw fail(`${message} Deployment has not started.`, missingGh ? 'gh-unavailable' : 'unavailable', {}, error)
          }
          logWarning?.(message)
          const answer = await runPrompt([{type: 'list', name: 'ciAccessAction', message: `${message} Fix access, then retry or cancel this release.`, choices: [{name: 'Retry', value: 'retry'}, {name: 'Cancel release', value: 'cancel'}], default: 'cancel'}])
          if (answer?.ciAccessAction !== 'retry') throw fail('CI access was not restored; release cancelled before deployment.', 'cancelled')
        }
      }
    }
    logProcessing?.(`Verify required CI workflows for ${headSha} on ${branch}`)
    let state = await readSnapshot()
    if (state.status === 'pending') {
      const complete = awaitCompletion ?? watchDeploymentCi
      await complete({rootDir, repository, headSha, branch, policy: normalized, state, readSnapshot, signal: waitSignal, waitForNextCheck: wait, logProcessing})
      // A completion notification is only a wake-up signal. GitHub remains the source of truth.
      state = await readSnapshot()
      if (state.status !== 'passed') throw fail('CI completion could not be confirmed for every required workflow; deployment has not started.', 'incomplete', {pending: state.pending})
    }
    logSuccess?.(`Required CI passed for ${headSha}`)
    return state
  }, {timeoutMs: normalized.timeoutMs, signal})
}
