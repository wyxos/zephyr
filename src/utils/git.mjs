import process from 'node:process'
import { runCommand, runCommandCapture } from './command.mjs'

export async function getCurrentBranch(rootDir = process.cwd(), { method = 'rev-parse' } = {}) {
  if (method === 'show-current') {
    const { stdout } = await runCommandCapture('git', ['branch', '--show-current'], { cwd: rootDir })
    return stdout.trim() || null
  }

  const { stdout } = await runCommandCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootDir })
  return stdout.trim() || null
}

export async function getUpstreamRef(rootDir = process.cwd()) {
  try {
    const { stdout } = await runCommandCapture(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { cwd: rootDir }
    )

    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function ensureUpToDateWithUpstream({
  branch,
  upstreamRef,
  rootDir = process.cwd(),
  logStep = null,
  logWarning = null
}) {
  if (!upstreamRef) {
    logWarning?.(`Branch ${branch} has no upstream configured; skipping ahead/behind checks.`)
    return
  }

  const [remoteName, ...branchParts] = upstreamRef.split('/')
  const remoteBranch = branchParts.join('/')

  if (remoteName && remoteBranch) {
    logStep?.(`Fetching latest updates from ${remoteName}/${remoteBranch}...`)
    try {
      await runCommand('git', ['fetch', remoteName, remoteBranch], { cwd: rootDir, stdio: 'ignore' })
    } catch (error) {
      throw new Error(`Failed to fetch ${upstreamRef}: ${error.message}`)
    }
  }

  const aheadResult = await runCommandCapture('git', ['rev-list', '--count', `${upstreamRef}..HEAD`], {
    cwd: rootDir
  })
  const behindResult = await runCommandCapture('git', ['rev-list', '--count', `HEAD..${upstreamRef}`], {
    cwd: rootDir
  })

  const ahead = Number.parseInt(aheadResult.stdout || '0', 10)
  const behind = Number.parseInt(behindResult.stdout || '0', 10)

  if (Number.isFinite(behind) && behind > 0) {
    if (remoteName && remoteBranch) {
      logStep?.(`Fast-forwarding ${branch} with ${upstreamRef}...`)

      try {
        await runCommand('git', ['pull', '--ff-only', remoteName, remoteBranch], { cwd: rootDir, stdio: 'ignore' })
      } catch (error) {
        throw new Error(
          `Unable to fast-forward ${branch} with ${upstreamRef}. Resolve conflicts manually, then rerun.\n${error.message}`
        )
      }

      await ensureUpToDateWithUpstream({ branch, upstreamRef, rootDir, logStep, logWarning })
      return
    }

    throw new Error(
      `Branch ${branch} is behind ${upstreamRef} by ${behind} commit${behind === 1 ? '' : 's'}. Pull or rebase first.`
    )
  }

  if (Number.isFinite(ahead) && ahead > 0) {
    logWarning?.(`Branch ${branch} is ahead of ${upstreamRef} by ${ahead} commit${ahead === 1 ? '' : 's'}.`)
  }
}

export async function pushQuiet(rootDir = process.cwd(), args = []) {
  await runCommandCapture('git', ['push', ...args], { cwd: rootDir })
}

