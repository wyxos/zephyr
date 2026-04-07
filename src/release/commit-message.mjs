import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'

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

export async function suggestCommitMessage(rootDir = process.cwd(), {
  runCommand,
  commandExistsImpl = commandExists,
  logStep,
  logWarning
} = {}) {
  if (!commandExistsImpl('codex')) {
    return null
  }

  let tempDir = null

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), 'zephyr-release-commit-'))
    const outputPath = path.join(tempDir, 'codex-last-message.txt')

    logStep?.('Generating a suggested commit message with Codex...')

    await runCommand('codex', [
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
        'Inspect the current repository and pending git changes yourself before answering.',
        'Run whatever read-only commands you need, such as git status, git diff, git diff --cached, and reading relevant files.',
        'Then write exactly one conventional commit message for the current pending changes.',
        'Use the exact format "<type>: <subject>".',
        'Do not use scopes like "fix(scope): ...".',
        'Keep it to one line if possible.',
        'Choose the most appropriate type from: fix, feat, chore, docs, refactor, test, style, perf, build, ci, revert.',
        'Base the subject on the underlying code or product change, not on staging, committing, pending changes, or generic workflow/process wording.',
        'Reply with only the commit message and no extra text.'
      ].join('\n\n')
    ], {
      capture: true,
      cwd: rootDir
    })

    const rawMessage = await readFile(outputPath, 'utf8')
    return sanitizeSuggestedCommitMessage(rawMessage)
  } catch (error) {
    logWarning?.(`Codex could not suggest a commit message: ${error.message}`)
    return null
  } finally {
    if (tempDir) {
      await rm(tempDir, {recursive: true, force: true}).catch(() => {})
    }
  }
}

export {suggestCommitMessage as suggestReleaseCommitMessage}
