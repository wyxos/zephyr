import {ZephyrError} from '../../runtime/errors.mjs'
import {normalizeDeploymentOptions} from '../../config/deployment-options.mjs'
import {normalizeDeploymentCiPolicy, waitForDeploymentCi} from './github-ci-gate.mjs'

export async function prepareDeploymentRelease({config, snapshot, executionMode = {}, rootDir, context, signal}) {
  const deployment = normalizeDeploymentOptions(Object.prototype.hasOwnProperty.call(snapshot ?? {}, 'deployment') ? snapshot.deployment : executionMode.deployment)
  const ci = normalizeDeploymentCiPolicy(Object.prototype.hasOwnProperty.call(snapshot ?? {}, 'ci') ? snapshot.ci : executionMode.ci)
  if (!deployment && !ci && !snapshot?.expectedCommit) return {}
  const output = await context.runCommandCapture('git', ['rev-parse', 'HEAD'], {cwd: rootDir, ...(signal ? {signal} : {})})
  const expectedCommit = String(output?.stdout ?? output).trim()
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(expectedCommit)) {
    throw new ZephyrError('Cannot resolve the exact release commit.', {code: 'ZEPHYR_RELEASE_COMMIT_INVALID'})
  }
  if (snapshot?.expectedCommit && snapshot.expectedCommit !== expectedCommit) {
    throw new ZephyrError(`Pending release belongs to ${snapshot.expectedCommit}, but local HEAD is ${expectedCommit}. Inspect the pending release before resuming.`, {code: 'ZEPHYR_RELEASE_COMMIT_CHANGED'})
  }
  await waitForDeploymentCi({rootDir, headSha: expectedCommit, branch: config.branch, policy: ci, signal,
    runCommandCapture: context.runCommandCapture, interactive: executionMode.interactive !== false,
    runPrompt: context.runPrompt, logProcessing: context.logProcessing, logWarning: context.logWarning,
    logSuccess: context.logSuccess})
  return {expectedCommit, deployment, ci: ci ?? false}
}
