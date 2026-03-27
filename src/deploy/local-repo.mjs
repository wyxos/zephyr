import { getCurrentBranch as getCurrentBranchImpl, getUpstreamRef as getUpstreamRefImpl } from '../utils/git.mjs'
import {hasPrePushHook} from './preflight.mjs'
import {gitCommitArgs, gitPushArgs} from '../utils/git-hooks.mjs'
import {
  buildFallbackCommitMessage,
  formatWorkingTreePreview,
  parseWorkingTreeEntries,
  suggestCommitMessage as suggestCommitMessageImpl
} from '../release/commit-message.mjs'

const DIRTY_DEPLOYMENT_MESSAGE = 'Local repository has uncommitted changes. Commit or stash them before deployment.'
const DIRTY_DEPLOYMENT_CANCELLED_MESSAGE = 'Deployment cancelled: pending changes were not committed.'

export async function getCurrentBranch(rootDir) {
  const branch = await getCurrentBranchImpl(rootDir)
  return branch ?? ''
}

export async function getGitStatus(rootDir, { runCommandCapture } = {}) {
  const output = await runCommandCapture('git', ['status', '--porcelain'], { cwd: rootDir })
  return output.trimEnd()
}

export function hasStagedChanges(statusOutput) {
  if (!statusOutput || statusOutput.length === 0) {
    return false
  }

  const lines = statusOutput.split('\n').filter((line) => line.trim().length > 0)

  return lines.some((line) => {
    const firstChar = line[0]
    return firstChar && firstChar !== ' ' && firstChar !== '?'
  })
}

export async function hasUncommittedChanges(rootDir, { getGitStatus: getGitStatusFn } = {}) {
  const status = await getGitStatusFn(rootDir)
  return status.length > 0
}

export async function getUpstreamRef(rootDir) {
  return await getUpstreamRefImpl(rootDir)
}

function parseUpstreamRef(upstreamRef) {
  const [remoteName, ...upstreamParts] = upstreamRef.split('/')
  const upstreamBranch = upstreamParts.join('/')

  return { remoteName, upstreamBranch }
}

async function fetchRemote(remoteName, rootDir, { runCommand, logWarning } = {}) {
  try {
    await runCommand('git', ['fetch', remoteName], { cwd: rootDir, silent: true })
  } catch (error) {
    logWarning?.(`Unable to fetch from ${remoteName} before comparing branch state: ${error.message}`)
  }
}

async function remoteRefExists(upstreamRef, rootDir, { runCommand } = {}) {
  try {
    await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${upstreamRef}`], {
      cwd: rootDir,
      silent: true
    })
    return true
  } catch {
    return false
  }
}

async function readRelativeCommitCounts(upstreamRef, rootDir, { runCommandCapture } = {}) {
  const aheadOutput = await runCommandCapture('git', ['rev-list', '--count', `${upstreamRef}..HEAD`], { cwd: rootDir })
  const behindOutput = await runCommandCapture('git', ['rev-list', '--count', `HEAD..${upstreamRef}`], { cwd: rootDir })

  return {
    aheadCount: parseInt(aheadOutput.trim() || '0', 10),
    behindCount: parseInt(behindOutput.trim() || '0', 10)
  }
}

async function readUpstreamSyncState(targetBranch, rootDir, {
  runCommand,
  runCommandCapture,
  logWarning,
  getUpstreamRef: getUpstreamRefFn = getUpstreamRef
} = {}) {
  const upstreamRef = await getUpstreamRefFn(rootDir)

  if (!upstreamRef) {
    logWarning?.(`Branch ${targetBranch} does not track a remote upstream; skipping automatic push of committed changes.`)
    return {
      upstreamRef: null,
      remoteName: null,
      upstreamBranch: null,
      remoteExists: false,
      aheadCount: 0,
      behindCount: 0
    }
  }

  const { remoteName, upstreamBranch } = parseUpstreamRef(upstreamRef)

  if (!remoteName || !upstreamBranch) {
    logWarning?.(`Unable to determine remote destination for ${targetBranch}. Skipping automatic push.`)
    return {
      upstreamRef,
      remoteName: null,
      upstreamBranch: null,
      remoteExists: false,
      aheadCount: 0,
      behindCount: 0
    }
  }

  await fetchRemote(remoteName, rootDir, { runCommand, logWarning })

  const exists = await remoteRefExists(upstreamRef, rootDir, { runCommand })

  if (!exists) {
    return {
      upstreamRef,
      remoteName,
      upstreamBranch,
      remoteExists: false,
      aheadCount: 0,
      behindCount: 0
    }
  }

  const { aheadCount, behindCount } = await readRelativeCommitCounts(upstreamRef, rootDir, { runCommandCapture })

  return {
    upstreamRef,
    remoteName,
    upstreamBranch,
    remoteExists: true,
    aheadCount,
    behindCount
  }
}

async function checkoutTargetBranch(targetBranch, currentBranch, rootDir, {
  hasPendingChanges,
  runCommand,
  logProcessing,
  logSuccess
} = {}) {
  if (currentBranch === targetBranch) {
    return
  }

  if (hasPendingChanges) {
    throw new Error(
      `Local repository has uncommitted changes on ${currentBranch}. Commit or stash them before switching to ${targetBranch}.`
    )
  }

  logProcessing?.(`Switching local repository from ${currentBranch} to ${targetBranch}...`)

  try {
    await runCommand('git', ['checkout', targetBranch], { cwd: rootDir })
  } catch (error) {
    throw new Error(
      `Unable to check out ${targetBranch}. Make sure the branch exists locally or fetch it before deploying.\n${error.message}`
    )
  }

  logSuccess?.(`Checked out ${targetBranch} locally.`)
}

async function commitAndPushPendingChanges(targetBranch, rootDir, {
  runPrompt,
  runCommand,
  runCommandCapture,
  getGitStatus,
  logProcessing,
  logSuccess,
  logWarning,
  skipGitHooks = false,
  suggestCommitMessage = suggestCommitMessageImpl
} = {}) {
  const statusEntries = parseWorkingTreeEntries(await getGitStatus(rootDir))

  if (statusEntries.length === 0) {
    return
  }

  if (typeof runPrompt !== 'function') {
    throw new Error(DIRTY_DEPLOYMENT_MESSAGE)
  }

  const captureAwareRunCommand = async (command, args, { capture = false, cwd } = {}) => {
    if (capture) {
      const captured = await runCommandCapture(command, args, { cwd })

      if (typeof captured === 'string') {
        return {stdout: captured.trim(), stderr: ''}
      }

      const stdout = captured?.stdout ?? ''
      const stderr = captured?.stderr ?? ''
      return {stdout: stdout.trim(), stderr: stderr.trim()}
    }

    await runCommand(command, args, { cwd })
    return undefined
  }

  const suggestedCommitMessage = await suggestCommitMessage(rootDir, {
    runCommand: captureAwareRunCommand,
    logStep: logProcessing,
    logWarning,
    statusEntries
  }) ?? buildFallbackCommitMessage(statusEntries)

  const changeLabel = statusEntries.length === 1 ? 'change' : 'changes'
  const {shouldCommitPendingChanges} = await runPrompt([
    {
      type: 'confirm',
      name: 'shouldCommitPendingChanges',
      message:
        `Pending ${changeLabel} detected before deployment:\n\n` +
        `${formatWorkingTreePreview(statusEntries)}\n\n` +
        'Stage and commit all current changes before continuing?',
      default: true
    }
  ])

  if (!shouldCommitPendingChanges) {
    throw new Error(DIRTY_DEPLOYMENT_CANCELLED_MESSAGE)
  }

  const { commitMessage } = await runPrompt([
    {
      type: 'input',
      name: 'commitMessage',
      message: 'Commit message for pending deployment changes',
      default: suggestedCommitMessage,
      validate: (value) => (value && value.trim().length > 0 ? true : 'Commit message cannot be empty.')
    }
  ])

  const message = commitMessage.trim()

  logProcessing?.('Staging all pending changes before deployment...')
  await runCommand('git', ['add', '-A'], { cwd: rootDir })

  logProcessing?.('Committing pending changes before deployment...')
  await runCommand('git', gitCommitArgs(['-m', message], {skipGitHooks}), { cwd: rootDir })

  const prePushHookPresent = await hasPrePushHook(rootDir)
  if (prePushHookPresent) {
    if (skipGitHooks) {
      logWarning?.('Pre-push git hook detected, but Zephyr will bypass it because --skip-git-hooks was provided.')
    } else {
      logProcessing?.('Pre-push git hook detected. Running hook during git push...')
    }
  }

  try {
    await runCommand('git', gitPushArgs(['origin', targetBranch], {skipGitHooks}), { cwd: rootDir })
  } catch (error) {
    if (prePushHookPresent) {
      throw new Error(`Git push failed while the pre-push hook was running. See hook output above.\n${error.message}`)
    }

    throw error
  }

  logSuccess?.(`Committed pending changes with "${message}".`)
  logSuccess?.(`Pushed committed changes to origin/${targetBranch}.`)

  const finalStatus = await getGitStatus(rootDir)

  if (finalStatus.length > 0) {
    throw new Error('Local repository still has uncommitted changes after commit. Aborting deployment.')
  }
}

export async function ensureCommittedChangesPushed(targetBranch, rootDir, {
  runCommand,
  runCommandCapture,
  logProcessing,
  logSuccess,
  logWarning,
  skipGitHooks = false,
  getUpstreamRef: getUpstreamRefFn = getUpstreamRef,
  readUpstreamSyncState: readUpstreamSyncStateFn = (branch, dir) =>
    readUpstreamSyncState(branch, dir, {
      runCommand,
      runCommandCapture,
      logWarning,
      getUpstreamRef: getUpstreamRefFn
    }),
  hasPrePushHook: hasPrePushHookFn = hasPrePushHook
} = {}) {
  const syncState = await readUpstreamSyncStateFn(targetBranch, rootDir)

  const {
    upstreamRef,
    remoteName,
    upstreamBranch,
    remoteExists,
    behindCount
  } = syncState

  if (!upstreamRef) {
    return { pushed: false, upstreamRef: null }
  }

  if (!remoteName || !upstreamBranch) {
    return { pushed: false, upstreamRef }
  }

  const aheadCount = remoteExists ? syncState.aheadCount : 1

  if (Number.isFinite(behindCount) && behindCount > 0) {
    throw new Error(
      `Local branch ${targetBranch} is behind ${upstreamRef} by ${behindCount} commit${behindCount === 1 ? '' : 's'}. Pull or rebase before deployment.`
    )
  }

  if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
    return { pushed: false, upstreamRef }
  }

  const commitLabel = aheadCount === 1 ? 'commit' : 'commits'
  logProcessing?.(`Found ${aheadCount} ${commitLabel} not yet pushed to ${upstreamRef}. Pushing before deployment...`)
  const prePushHookPresent = await hasPrePushHookFn(rootDir)

  if (prePushHookPresent) {
    if (skipGitHooks) {
      logWarning?.('Pre-push git hook detected, but Zephyr will bypass it because --skip-git-hooks was provided.')
    } else {
      logProcessing?.('Pre-push git hook detected. Running hook during git push...')
    }
  }

  try {
    await runCommandCapture('git', gitPushArgs([remoteName, `${targetBranch}:${upstreamBranch}`], {skipGitHooks}), { cwd: rootDir })
  } catch (error) {
    if (prePushHookPresent) {
      const hookOutput = [error.stdout, error.stderr]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .join('\n')

      throw new Error(
        hookOutput
          ? `Git push failed while the pre-push hook was running.\n${hookOutput}`
          : `Git push failed while the pre-push hook was running.\n${error.message}`
      )
    }

    throw error
  }

  logSuccess?.(`Pushed committed changes to ${upstreamRef}.`)

  return { pushed: true, upstreamRef }
}

export async function ensureLocalRepositoryState(targetBranch, rootDir = process.cwd(), {
  runPrompt,
  runCommand,
  runCommandCapture,
  logProcessing,
  logSuccess,
  logWarning,
  skipGitHooks = false,
  suggestCommitMessage: suggestCommitMessageFn = suggestCommitMessageImpl,
  getCurrentBranch: getCurrentBranchFn = getCurrentBranch,
  getGitStatus: getGitStatusFn = (dir) => getGitStatus(dir, { runCommandCapture }),
  readUpstreamSyncState: readUpstreamSyncStateFn = (branch, dir) =>
    readUpstreamSyncState(branch, dir, {
      runCommand,
      runCommandCapture,
      logWarning
    }),
  ensureCommittedChangesPushed: ensureCommittedChangesPushedFn = (branch, dir) =>
    ensureCommittedChangesPushed(branch, dir, {
      runCommand,
      runCommandCapture,
      logProcessing,
      logSuccess,
      logWarning,
      skipGitHooks
    })
} = {}) {
  if (!targetBranch) {
    throw new Error('Deployment branch is not defined in the release configuration.')
  }

  const currentBranch = await getCurrentBranchFn(rootDir)

  if (!currentBranch) {
    throw new Error('Unable to determine the current git branch. Ensure this is a git repository.')
  }

  if (currentBranch === 'HEAD') {
    throw new Error('Local repository is in detached HEAD state. Check out the deployment branch before deploying.')
  }

  const initialStatus = await getGitStatusFn(rootDir)
  const hasPendingChanges = initialStatus.length > 0

  const { aheadCount, behindCount } = await readUpstreamSyncStateFn(currentBranch, rootDir)

  if (aheadCount > 0) {
    logWarning?.(`Local branch ${currentBranch} is ahead of upstream by ${aheadCount} commit${aheadCount === 1 ? '' : 's'}.`)
  }

  if (behindCount > 0) {
    logProcessing?.(`Synchronizing local branch ${currentBranch} with its upstream...`)
    try {
      await runCommand('git', ['pull', '--ff-only'], { cwd: rootDir })
      logSuccess?.('Local branch fast-forwarded with upstream changes.')
    } catch (error) {
      throw new Error(
        `Unable to fast-forward ${currentBranch} with upstream changes. Resolve conflicts manually, then rerun the deployment.\n${error.message}`
      )
    }
  }

  await checkoutTargetBranch(targetBranch, currentBranch, rootDir, {
    hasPendingChanges,
    runCommand,
    logProcessing,
    logSuccess
  })

  const statusAfterCheckout = currentBranch === targetBranch ? initialStatus : await getGitStatusFn(rootDir)

  if (statusAfterCheckout.length === 0) {
    await ensureCommittedChangesPushedFn(targetBranch, rootDir)
    logProcessing?.('Local repository is clean. Proceeding with deployment.')
    return
  }

  logWarning?.(`Pending changes detected on ${targetBranch}. A commit is required before deployment.`)
  await commitAndPushPendingChanges(targetBranch, rootDir, {
    runPrompt,
    runCommand,
    runCommandCapture,
    getGitStatus: getGitStatusFn,
    logProcessing,
    logSuccess,
    logWarning,
    skipGitHooks,
    suggestCommitMessage: suggestCommitMessageFn
  })

  await ensureCommittedChangesPushedFn(targetBranch, rootDir)
  logProcessing?.('Local repository is clean after committing pending changes.')
}
