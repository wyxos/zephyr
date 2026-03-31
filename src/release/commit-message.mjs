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
const MAX_DIFF_EXCERPT_LINES = 60
const MAX_DIFF_EXCERPT_CHARS = 4000
const STATUS_LABELS = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type-changed',
  U: 'conflicted'
}
const TOPIC_STOP_WORDS = new Set([
  'src',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'app',
  'lib',
  'dist',
  'packages',
  'package',
  'application',
  'shared',
  'index',
  'main',
  'local',
  'repo',
  'prepare',
  'commit',
  'message',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'php',
  'json',
  'yaml',
  'yml',
  'md',
  'toml',
  'lock'
])

function buildTargetedFallbackCommitMessage(statusEntries = []) {
  const paths = statusEntries.map((entry) => entry.path.toLowerCase())
  const touchesDeployPrep = paths.some((pathValue) => pathValue.includes('prepare-local-deployment'))
  const touchesLocalRepo = paths.some((pathValue) => pathValue.includes('local-repo'))
  const touchesCommitMessage = paths.some((pathValue) => pathValue.includes('commit-message'))
  const touchesReleaseFlow = paths.some((pathValue) => pathValue.includes('/release/') || pathValue.includes('release-'))

  if (touchesDeployPrep && touchesLocalRepo) {
    return 'fix: prompt for dirty deploy changes before version bump'
  }

  if (touchesCommitMessage && touchesReleaseFlow) {
    return 'fix: tighten release commit suggestions'
  }

  return null
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

function tokenizePath(pathValue = '') {
  return pathValue
    .split(/[\\/]/)
    .flatMap((segment) => segment.split(/[^a-zA-Z0-9]+/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !TOPIC_STOP_WORDS.has(token))
}

function inferCommitTypeFromEntries(statusEntries = []) {
  const paths = statusEntries.map((entry) => entry.path.toLowerCase())

  if (paths.every((pathValue) => pathValue.endsWith('.md') || pathValue.includes('/docs/') || pathValue.startsWith('docs/'))) {
    return 'docs'
  }

  if (paths.every((pathValue) => /\.test\.[^.]+$/.test(pathValue) || pathValue.includes('/tests/'))) {
    return 'test'
  }

  if (paths.some((pathValue) => pathValue.includes('.github/workflows/') || pathValue.includes('/ci/'))) {
    return 'ci'
  }

  return 'chore'
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

export function buildFallbackCommitMessage(statusEntries = []) {
  const targetedFallback = buildTargetedFallbackCommitMessage(statusEntries)
  if (targetedFallback) {
    return targetedFallback
  }

  const tokenCounts = new Map()

  for (const entry of statusEntries) {
    for (const token of tokenizePath(entry.path)) {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1)
    }
  }

  const orderedTokens = Array.from(tokenCounts.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1]
      }

      return left[0].localeCompare(right[0])
    })
    .map(([token]) => token)

  const primaryTopic = orderedTokens[0] ?? 'release'
  const commitType = inferCommitTypeFromEntries(statusEntries)

  if (commitType === 'docs') {
    return `docs: update ${primaryTopic} documentation`
  }

  if (commitType === 'test') {
    return `test: expand ${primaryTopic} coverage`
  }

  if (commitType === 'ci') {
    return `ci: update ${primaryTopic} pipeline`
  }

  return `chore: update ${primaryTopic} handling`
}

async function collectDiffNumstat(rootDir, {runCommand} = {}) {
  try {
    const {stdout} = await runCommand('git', ['diff', '--numstat', 'HEAD', '--'], {
      capture: true,
      cwd: rootDir
    })

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((map, line) => {
        const [addedRaw, deletedRaw, filePath] = line.split('\t')
        if (!filePath) {
          return map
        }

        const added = Number.parseInt(addedRaw, 10)
        const deleted = Number.parseInt(deletedRaw, 10)
        map.set(filePath, {
          added: Number.isFinite(added) ? added : 0,
          deleted: Number.isFinite(deleted) ? deleted : 0
        })
        return map
      }, new Map())
  } catch {
    return new Map()
  }
}

function shouldIncludeDiffExcerptLine(line = '') {
  if (line.startsWith('diff --git ')) {
    return true
  }

  if (line.startsWith('@@')) {
    return true
  }

  return (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')
}

function trimDiffExcerpt(diffText = '') {
  const selectedLines = []
  let totalChars = 0

  for (const rawLine of diffText.split(/\r?\n/)) {
    const line = rawLine.trimEnd()

    if (!shouldIncludeDiffExcerptLine(line)) {
      continue
    }

    const truncatedLine = line.length > 180 ? `${line.slice(0, 177)}...` : line
    const nextTotal = totalChars + truncatedLine.length + 1

    if (selectedLines.length >= MAX_DIFF_EXCERPT_LINES || nextTotal > MAX_DIFF_EXCERPT_CHARS) {
      break
    }

    selectedLines.push(truncatedLine)
    totalChars = nextTotal
  }

  return selectedLines.join('\n')
}

async function collectDiffExcerpt(rootDir, {runCommand} = {}) {
  try {
    const {stdout} = await runCommand('git', ['diff', '--unified=0', '--no-color', 'HEAD', '--'], {
      capture: true,
      cwd: rootDir
    })

    return trimDiffExcerpt(stdout)
  } catch {
    return ''
  }
}

async function buildCommitMessageContext(rootDir, {
  runCommand,
  statusEntries = []
} = {}) {
  const changeCountsByPath = await collectDiffNumstat(rootDir, {runCommand})
  const summary = statusEntries.map((entry) => `- ${summarizeWorkingTreeEntry(entry, {changeCountsByPath})}`).join('\n')
  const diffExcerpt = await collectDiffExcerpt(rootDir, {runCommand})

  return {
    summary,
    diffExcerpt
  }
}

export async function suggestCommitMessage(rootDir = process.cwd(), {
  runCommand,
  commandExistsImpl = commandExists,
  logStep,
  logWarning,
  statusEntries = []
} = {}) {
  if (!commandExistsImpl('codex')) {
    return null
  }

  let tempDir = null

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), 'zephyr-release-commit-'))
    const outputPath = path.join(tempDir, 'codex-last-message.txt')
    const commitContext = await buildCommitMessageContext(rootDir, {
      runCommand,
      statusEntries
    })

    logStep?.('Generating a suggested commit message with Codex...')

    const promptSections = [
      'Write exactly one short conventional commit message for these pending changes.',
      'Use the exact format "<type>: <subject>" with no scope, no exclamation mark, and no extra text.',
      'Choose the most appropriate type from: fix, feat, chore, docs, refactor, test, style, perf, build, ci, revert.',
      'Base the subject on the actual behavior, safeguard, bug fix, feature, or API change shown below.',
      'Avoid generic nouns like "workflow", "process", "flow", "changes", or "updates" unless the diff truly changes CI or docs.',
      'Do not describe the commit itself, staging, or "pending changes"; describe the underlying code or product change.',
      'Pending change summary:',
      commitContext.summary || '- changed files present'
    ]

    if (commitContext.diffExcerpt) {
      promptSections.push('Diff excerpt:', commitContext.diffExcerpt)
    }

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
      promptSections.join('\n\n')
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
