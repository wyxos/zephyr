import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {describeCodexAdvisorFailure, logCapturedCodexDiagnostics} from '../runtime/codex-diagnostics.mjs'
import {commandExists} from '../utils/command.mjs'

const CONVENTIONAL_COMMIT_PATTERN = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test): .+/i
const GENERIC_SUBJECT_PATTERNS = [
  /^commit pending (release )?changes$/i,
  /^pending (release )?changes$/i,
  /^commit pending changes before .+$/i,
  /^commit pending (release |deployment )?changes before .+$/i,
  /^commit (all )?(current |pending )?changes( before .+)?$/i,
  /^stage and commit (all )?(current |pending )?changes( before .+)?$/i,
  /^(allow|enable|support) committing pending changes( before .+)?$/i,
  /^commit changes$/i,
  /^no pending changes$/i,
  /^update changes$/i,
  /^update files$/i,
  /^update work$/i,
  /^misc(ellaneous)?( updates?)?$/i,
  /^changes$/i,
  /^updates?$/i,
  /^(improve|update|adjust|refine|align|support|enable)\s+.+\s+(workflow|process|flow)$/i
]
const MAX_WORKING_TREE_PREVIEW = 20
const STATUS_LABELS = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type-changed',
  U: 'conflicted'
}

function resolveWorkingTreeEntryLabel(entry) {
  if (entry.indexStatus === '?' && entry.worktreeStatus === '?') {
    return 'untracked'
  }

  if (entry.indexStatus === '!' && entry.worktreeStatus === '!') {
    return 'ignored'
  }

  const relevantStatuses = [entry.indexStatus, entry.worktreeStatus].filter((status) => status && status !== ' ')
  for (const status of relevantStatuses) {
    if (STATUS_LABELS[status]) {
      return STATUS_LABELS[status]
    }
  }

  return 'changed'
}

export function parseWorkingTreeStatus(stdout = '') {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

export function parseWorkingTreeEntries(stdout = '') {
  return parseWorkingTreeStatus(stdout).map((line) => {
    const indexStatus = line.slice(0, 1)
    const worktreeStatus = line.slice(1, 2)
    const rawPath = line.slice(3).trim()
    const isRename = [indexStatus, worktreeStatus].some((status) => status === 'R' || status === 'C')
    const [fromPath, toPath] = isRename && rawPath.includes(' -> ')
      ? rawPath.split(' -> ')
      : [null, null]

    return {
      raw: line,
      indexStatus,
      worktreeStatus,
      path: toPath ?? rawPath,
      previousPath: fromPath
    }
  })
}

export function summarizeWorkingTreeEntry(entry, {
  changeCountsByPath = new Map()
} = {}) {
  const label = resolveWorkingTreeEntryLabel(entry)
  const displayPath = entry.previousPath ? `${entry.previousPath} -> ${entry.path}` : entry.path
  const counts = changeCountsByPath.get(entry.path) ?? null

  if (!counts) {
    return `${label}: ${displayPath}`
  }

  return `${label}: ${displayPath} (+${counts.added} -${counts.deleted})`
}

export function formatWorkingTreePreview(statusEntries = []) {
  const preview = statusEntries
    .slice(0, MAX_WORKING_TREE_PREVIEW)
    .map((entry) => `  ${summarizeWorkingTreeEntry(entry)}`)
    .join('\n')

  if (statusEntries.length <= MAX_WORKING_TREE_PREVIEW) {
    return preview
  }

  const remaining = statusEntries.length - MAX_WORKING_TREE_PREVIEW
  return `${preview}\n  ...and ${remaining} more file${remaining === 1 ? '' : 's'}`
}

export function sanitizeSuggestedCommitMessage(message) {
  if (typeof message !== 'string') {
    return null
  }

  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  if (!firstLine) {
    return null
  }

  const normalized = firstLine
    .replace(/^commit message:\s*/i, '')
    .replace(/^(\w+)\([^)]+\)(!?):/i, '$1:')
    .replace(/^(\w+)!:/i, '$1:')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()

  if (!CONVENTIONAL_COMMIT_PATTERN.test(normalized)) {
    return null
  }

  const [, subject = ''] = normalized.split(/:\s+/, 2)
  const normalizedSubject = subject.trim()

  if (
    normalizedSubject.length < 18 ||
    normalizedSubject.split(/\s+/).length < 3 ||
    GENERIC_SUBJECT_PATTERNS.some((pattern) => pattern.test(normalizedSubject))
  ) {
    return null
  }

  return normalized
}

function getStatusPaths(statusEntries = []) {
  return statusEntries
    .map((entry) => entry?.path)
    .filter((entryPath) => typeof entryPath === 'string' && entryPath.length > 0)
}

export function suggestFallbackCommitMessage(statusEntries = []) {
  const paths = getStatusPaths(statusEntries)

  if (paths.length === 0) {
    return null
  }

  const hasTests = paths.some((entryPath) => (
    entryPath.startsWith('tests/')
    || entryPath.includes('.test.')
    || entryPath.includes('.spec.')
  ))
  const hasApplicationCode = paths.some((entryPath) => (
    ['app/', 'bootstrap/', 'config/', 'database/', 'extension/', 'resources/', 'routes/'].some((prefix) => entryPath.startsWith(prefix))
    || entryPath.startsWith('artisan')
    || entryPath.startsWith('vite.config.')
  ))

  if (paths.some((entryPath) => entryPath.includes('FullscreenPreviewRail'))) {
    return 'feat: refine fullscreen preview rail'
  }

  if (paths.some((entryPath) => entryPath.includes('consumer') && entryPath.includes('dependency'))) {
    return 'feat: support dirty consumer release chains'
  }

  if (paths.every((entryPath) => /(^README\.md$|\.md$|^docs\/)/.test(entryPath))) {
    return 'docs: update project documentation'
  }

  if (paths.some((entryPath) => entryPath.startsWith('src/'))) {
    return hasTests
      ? 'fix: update source behavior and tests'
      : 'fix: update source behavior'
  }

  if (paths.some((entryPath) => /(^package\.json$|package-lock\.json$|npm-shrinkwrap\.json$)/.test(entryPath))) {
    return 'chore: update package metadata'
  }

  if (hasApplicationCode) {
    return hasTests
      ? 'fix: update application behavior and tests'
      : 'fix: update application behavior'
  }

  if (hasTests) {
    return 'test: update test coverage'
  }

  return 'chore: update project files'
}


export async function suggestCommitMessage(rootDir = process.cwd(), {
  runCommand,
  commandExistsImpl = commandExists,
  logStep,
  logWarning,
  statusEntries = []
} = {}) {
  const fallbackMessage = () => {
    const message = suggestFallbackCommitMessage(statusEntries)

    if (message) {
      logWarning?.(`Using path-based fallback commit message "${message}".`)
    }

    return message
  }

  if (!commandExistsImpl('codex')) {
    return fallbackMessage()
  }

  let tempDir = null

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), 'zephyr-release-commit-'))
    const outputPath = path.join(tempDir, 'codex-last-message.txt')

    logStep?.('Generating a suggested commit message with Codex...')

    const codexResult = await runCommand('codex', [
      'exec',
      '--ephemeral',
      '--model',
      'gpt-5.4-mini',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--output-last-message',
      outputPath,
      [
        'Inspect the current repository and decide the best conventional commit message for the pending changes.',
        'Use whatever read-only inspection you need.',
        'Reply with exactly one line in the format "<type>: <subject>".',
        'Do not use scopes like "fix(scope): ...".',
        'Do not include extra text.'
      ].join('\n\n')
    ], {
      capture: true,
      cwd: rootDir
    })
    logCapturedCodexDiagnostics(codexResult, {label: 'commit-message advisor', logWarning})

    const rawMessage = await readFile(outputPath, 'utf8')
    const message = sanitizeSuggestedCommitMessage(rawMessage)

    if (message) {
      return message
    }

    logWarning?.('Codex suggested an unusable commit message.')
    return fallbackMessage()
  } catch (error) {
    logWarning?.(`${describeCodexAdvisorFailure(error, {label: 'commit-message advisor'})} Using path-based fallback.`)
    return fallbackMessage()
  } finally {
    if (tempDir) {
      await rm(tempDir, {recursive: true, force: true}).catch(() => {})
    }
  }
}

export {suggestCommitMessage as suggestReleaseCommitMessage}
