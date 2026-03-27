import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'
import semver from 'semver'

import {commandExists} from '../utils/command.mjs'

export const RELEASE_TYPES = [
  'major',
  'minor',
  'patch',
  'premajor',
  'preminor',
  'prepatch',
  'prerelease'
]
const STABLE_RELEASE_TYPES = ['major', 'minor', 'patch']

function sanitizeSuggestedReleaseType(message, allowedTypes = RELEASE_TYPES) {
  if (typeof message !== 'string') {
    return null
  }

  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/^release type:\s*/i, '')
    .split(/\s+/)[0]
    ?.replace(/[^a-z]/g, '')

  if (!normalized || !allowedTypes.includes(normalized)) {
    return null
  }

  return normalized
}

function inferReleaseTypeHeuristically({
  currentVersion = '0.0.0',
  commitLog = '',
  diffStat = ''
} = {}) {
  const combined = `${commitLog}\n${diffStat}`
  const hasBreakingChange = /breaking change|breaking changes|^[a-z]+(?:\(.+\))?!:/im.test(combined)
  const hasFeatureChange = /\bfeat(?:\(.+\))?:/im.test(commitLog) || /\bfeature\b/i.test(combined)
  const hasPrereleaseVersion = Array.isArray(semver.parse(currentVersion)?.prerelease)
    && semver.parse(currentVersion)?.prerelease?.length > 0

  if (hasPrereleaseVersion) {
    if (hasBreakingChange) {
      return 'premajor'
    }

    if (hasFeatureChange) {
      return 'preminor'
    }

    return 'prerelease'
  }

  if (hasBreakingChange) {
    return 'major'
  }

  if (hasFeatureChange) {
    return 'minor'
  }

  return 'patch'
}

function resolveSuggestedReleaseTypeOptions(currentVersion = '0.0.0') {
  const parsedVersion = semver.parse(currentVersion)

  if (Array.isArray(parsedVersion?.prerelease) && parsedVersion.prerelease.length > 0) {
    return RELEASE_TYPES
  }

  return STABLE_RELEASE_TYPES
}

function buildChoiceOrder(suggestedReleaseType) {
  return [
    suggestedReleaseType,
    ...RELEASE_TYPES.filter((type) => type !== suggestedReleaseType)
  ]
}

async function readLatestReleaseTag(rootDir, {runCommand} = {}) {
  try {
    const {stdout} = await runCommand('git', ['describe', '--tags', '--abbrev=0'], {
      capture: true,
      cwd: rootDir
    })

    return stdout.trim() || null
  } catch {
    return null
  }
}

async function readCommitLog(rootDir, {runCommand, latestTag} = {}) {
  const args = latestTag
    ? ['log', '--format=%h %s', `${latestTag}..HEAD`]
    : ['log', '--format=%h %s', '-20']

  try {
    const {stdout} = await runCommand('git', args, {
      capture: true,
      cwd: rootDir
    })

    return stdout.trim()
  } catch {
    return ''
  }
}

async function readDiffStat(rootDir, {runCommand, latestTag} = {}) {
  const args = latestTag
    ? ['diff', '--stat', `${latestTag}..HEAD`, '--']
    : ['diff', '--stat', 'HEAD~20..HEAD', '--']

  try {
    const {stdout} = await runCommand('git', args, {
      capture: true,
      cwd: rootDir
    })

    return stdout.trim()
  } catch {
    return ''
  }
}

async function buildReleaseSuggestionContext(rootDir, {
  runCommand,
  currentVersion,
  packageName
} = {}) {
  const latestTag = await readLatestReleaseTag(rootDir, {runCommand})
  const commitLog = await readCommitLog(rootDir, {runCommand, latestTag})
  const diffStat = await readDiffStat(rootDir, {runCommand, latestTag})

  return {
    currentVersion,
    packageName,
    latestTag,
    commitLog,
    diffStat
  }
}

async function suggestReleaseType(rootDir = process.cwd(), {
  runCommand,
  currentVersion,
  packageName,
  commandExistsImpl = commandExists,
  logStep,
  logWarning
} = {}) {
  const context = await buildReleaseSuggestionContext(rootDir, {
    runCommand,
    currentVersion,
    packageName
  })
  const allowedSuggestedReleaseTypes = resolveSuggestedReleaseTypeOptions(currentVersion)
  const heuristicReleaseType = inferReleaseTypeHeuristically(context)

  if (!commandExistsImpl('codex')) {
    return {
      ...context,
      releaseType: heuristicReleaseType,
      source: 'heuristic'
    }
  }

  let tempDir = null

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), 'zephyr-release-type-'))
    const outputPath = path.join(tempDir, 'codex-last-message.txt')

    logStep?.('Evaluating the recommended version bump with Codex...')

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
        'Choose exactly one semver release type for the next release.',
        `Reply with exactly one of: ${allowedSuggestedReleaseTypes.join(', ')}.`,
        'Base the choice on the actual code and workflow changes since the last release tag.',
        'Prefer stable release types unless the current version already has a prerelease identifier.',
        `Package: ${packageName || 'unknown package'}`,
        `Current version: ${currentVersion || 'unknown'}`,
        `Latest release tag: ${context.latestTag || 'none found'}`,
        'Commits since the last release:',
        context.commitLog || '- no commits found',
        'Diff summary since the last release:',
        context.diffStat || '- no diff summary available'
      ].join('\n\n')
    ], {
      capture: true,
      cwd: rootDir
    })

    const rawSuggestion = await readFile(outputPath, 'utf8')
    const releaseType = sanitizeSuggestedReleaseType(rawSuggestion, allowedSuggestedReleaseTypes)

    if (!releaseType) {
      return {
        ...context,
        releaseType: heuristicReleaseType,
        source: 'heuristic'
      }
    }

    return {
      ...context,
      releaseType,
      source: 'codex'
    }
  } catch (error) {
    logWarning?.(`Codex could not suggest a release type: ${error.message}`)

    return {
      ...context,
      releaseType: heuristicReleaseType,
      source: 'heuristic'
    }
  } finally {
    if (tempDir) {
      await rm(tempDir, {recursive: true, force: true}).catch(() => {})
    }
  }
}

export async function resolveReleaseType({
  releaseType = null,
  currentVersion = '0.0.0',
  packageName = '',
  rootDir = process.cwd(),
  interactive = true,
  runPrompt,
  runCommand,
  logStep,
  logWarning
} = {}) {
  if (releaseType) {
    return releaseType
  }

  const suggested = await suggestReleaseType(rootDir, {
    runCommand,
    currentVersion,
    packageName,
    logStep,
    logWarning
  })
  const rangeLabel = suggested.latestTag
    ? `based on changes since ${suggested.latestTag}`
    : 'based on recent changes'

  if (!interactive || typeof runPrompt !== 'function') {
    logStep?.(`No release type specified. Using suggested ${suggested.releaseType} bump ${rangeLabel}.`)
    return suggested.releaseType
  }

  const {selectedReleaseType} = await runPrompt([
    {
      type: 'list',
      name: 'selectedReleaseType',
      message:
        `Recommended release bump for ${packageName || 'this package'}@${currentVersion} ` +
        `${rangeLabel}. Choose the version bump to use:`,
      choices: buildChoiceOrder(suggested.releaseType).map((type) => ({
        name: type === suggested.releaseType ? `${type} (recommended)` : type,
        value: type
      })),
      default: suggested.releaseType
    }
  ])

  return selectedReleaseType
}
