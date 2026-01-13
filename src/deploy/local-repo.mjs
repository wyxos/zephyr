import { getCurrentBranch as getCurrentBranchImpl, getUpstreamRef as getUpstreamRefImpl } from '../utils/git.mjs'

export async function getCurrentBranch(rootDir) {
  const branch = await getCurrentBranchImpl(rootDir)
  return branch ?? ''
}

export async function getGitStatus(rootDir, { runCommandCapture } = {}) {
  const output = await runCommandCapture('git', ['status', '--porcelain'], { cwd: rootDir })
  return output.trim()
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

export async function ensureCommittedChangesPushed(targetBranch, rootDir, {
  runCommand,
  runCommandCapture,
  logProcessing,
  logSuccess,
  logWarning,
  getUpstreamRef: getUpstreamRefFn = getUpstreamRef
} = {}) {
  const upstreamRef = await getUpstreamRefFn(rootDir)

  if (!upstreamRef) {
    logWarning?.(`Branch ${targetBranch} does not track a remote upstream; skipping automatic push of committed changes.`)
    return { pushed: false, upstreamRef: null }
  }

  const [remoteName, ...upstreamParts] = upstreamRef.split('/')
  const upstreamBranch = upstreamParts.join('/')

  if (!remoteName || !upstreamBranch) {
    logWarning?.(`Unable to determine remote destination for ${targetBranch}. Skipping automatic push.`)
    return { pushed: false, upstreamRef }
  }

  try {
    await runCommand('git', ['fetch', remoteName], { cwd: rootDir, silent: true })
  } catch (error) {
    logWarning?.(`Unable to fetch from ${remoteName} before push: ${error.message}`)
  }

  let remoteExists = true

  try {
    await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${upstreamRef}`], {
      cwd: rootDir,
      silent: true
    })
  } catch {
    remoteExists = false
  }

  let aheadCount = 0
  let behindCount = 0

  if (remoteExists) {
    const aheadOutput = await runCommandCapture('git', ['rev-list', '--count', `${upstreamRef}..HEAD`], { cwd: rootDir })
    aheadCount = parseInt(aheadOutput.trim() || '0', 10)

    const behindOutput = await runCommandCapture('git', ['rev-list', '--count', `HEAD..${upstreamRef}`], { cwd: rootDir })
    behindCount = parseInt(behindOutput.trim() || '0', 10)
  } else {
    aheadCount = 1
  }

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

  await runCommandCapture('git', ['push', remoteName, `${targetBranch}:${upstreamBranch}`], { cwd: rootDir })
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
  getCurrentBranch: getCurrentBranchFn = getCurrentBranch,
  getGitStatus: getGitStatusFn = (dir) => getGitStatus(dir, { runCommandCapture }),
  ensureCommittedChangesPushed: ensureCommittedChangesPushedFn = (branch, dir) =>
    ensureCommittedChangesPushed(branch, dir, {
      runCommand,
      runCommandCapture,
      logProcessing,
      logSuccess,
      logWarning
    })
} = {}) {
  if (!targetBranch) {
    throw new Error('Deployment branch is not defined in the release configuration.')
  }

  const currentBranch = await getCurrentBranchFn(rootDir)

  if (!currentBranch) {
    throw new Error('Unable to determine the current git branch. Ensure this is a git repository.')
  }

  const initialStatus = await getGitStatusFn(rootDir)
  const hasPendingChanges = initialStatus.length > 0

  const statusReport = await runCommandCapture('git', ['status', '--short', '--branch'], { cwd: rootDir })
  const lines = statusReport.split(/\r?\n/)
  const branchLine = lines[0] || ''
  const aheadMatch = branchLine.match(/ahead (\d+)/)
  const behindMatch = branchLine.match(/behind (\d+)/)
  const aheadCount = aheadMatch ? parseInt(aheadMatch[1], 10) : 0
  const behindCount = behindMatch ? parseInt(behindMatch[1], 10) : 0

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

  if (currentBranch !== targetBranch) {
    if (hasPendingChanges) {
      throw new Error(
        `Local repository has uncommitted changes on ${currentBranch}. Commit or stash them before switching to ${targetBranch}.`
      )
    }

    logProcessing?.(`Switching local repository from ${currentBranch} to ${targetBranch}...`)
    await runCommand('git', ['checkout', targetBranch], { cwd: rootDir })
    logSuccess?.(`Checked out ${targetBranch} locally.`)
  }

  const statusAfterCheckout = currentBranch === targetBranch ? initialStatus : await getGitStatusFn(rootDir)

  if (statusAfterCheckout.length === 0) {
    await ensureCommittedChangesPushedFn(targetBranch, rootDir)
    logProcessing?.('Local repository is clean. Proceeding with deployment.')
    return
  }

  if (!hasStagedChanges(statusAfterCheckout)) {
    await ensureCommittedChangesPushedFn(targetBranch, rootDir)
    logProcessing?.('No staged changes detected. Unstaged or untracked files will not affect deployment. Proceeding with deployment.')
    return
  }

  logWarning?.(`Staged changes detected on ${targetBranch}. A commit is required before deployment.`)

  const { commitMessage } = await runPrompt([
    {
      type: 'input',
      name: 'commitMessage',
      message: 'Enter a commit message for pending changes before deployment',
      validate: (value) => (value && value.trim().length > 0 ? true : 'Commit message cannot be empty.')
    }
  ])

  const message = commitMessage.trim()

  logProcessing?.('Committing staged changes before deployment...')
  await runCommand('git', ['commit', '-m', message], { cwd: rootDir })
  await runCommand('git', ['push', 'origin', targetBranch], { cwd: rootDir })
  logSuccess?.(`Committed and pushed changes to origin/${targetBranch}.`)

  const finalStatus = await getGitStatusFn(rootDir)

  if (finalStatus.length > 0) {
    throw new Error('Local repository still has uncommitted changes after commit. Aborting deployment.')
  }

  await ensureCommittedChangesPushedFn(targetBranch, rootDir)
  logProcessing?.('Local repository is clean after committing pending changes.')
}

