import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {waitForGitHubReleaseWorkflows} from '#src/release/github-actions.mjs'

describe('release/github-actions', () => {
  let rootDir

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'zephyr-github-actions-'))
  })

  afterEach(async () => {
    await rm(rootDir, {recursive: true, force: true})
  })

  async function createWorkflowFile() {
    await mkdir(join(rootDir, '.github', 'workflows'), {recursive: true})
    await writeFile(join(rootDir, '.github', 'workflows', 'publish.yml'), 'name: Publish\n')
  }

  it('skips monitoring when the repository has no GitHub workflow files', async () => {
    const runCommand = vi.fn()

    await expect(waitForGitHubReleaseWorkflows(rootDir, {
      runCommand
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'no-workflows',
      runs: []
    })

    expect(runCommand).not.toHaveBeenCalled()
  })

  it('warns and skips when GitHub CLI is unavailable', async () => {
    await createWorkflowFile()

    const runCommand = vi.fn(async () => {
      throw new Error('Command not found: "gh"')
    })
    const logWarning = vi.fn()

    await expect(waitForGitHubReleaseWorkflows(rootDir, {
      runCommand,
      logWarning
    })).resolves.toMatchObject({
      status: 'skipped',
      reason: 'gh-unavailable',
      runs: []
    })

    expect(runCommand).toHaveBeenCalledWith('gh', ['--version'], {
      capture: true,
      cwd: rootDir
    })
    expect(logWarning).toHaveBeenCalledWith(
      'GitHub Actions workflow monitoring skipped because GitHub CLI is unavailable: Command not found: "gh"'
    )
  })

  it('watches workflow runs created by the current release push', async () => {
    await createWorkflowFile()

    const runCommand = vi.fn(async (command, args) => {
      if (command === 'gh' && args[0] === '--version') {
        return {stdout: 'gh version 2.0.0', stderr: ''}
      }

      if (command === 'git' && args[0] === 'rev-parse') {
        return {stdout: 'abc123', stderr: ''}
      }

      if (command === 'gh' && args[0] === 'run' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            {
              databaseId: 100,
              workflowName: 'Old Push',
              createdAt: '2026-05-13T10:59:00Z',
              url: 'https://github.test/runs/100'
            },
            {
              databaseId: 200,
              workflowName: 'Publish Package',
              createdAt: '2026-05-13T11:00:02Z',
              url: 'https://github.test/runs/200'
            }
          ]),
          stderr: ''
        }
      }

      return undefined
    })
    const logStep = vi.fn()
    const logSuccess = vi.fn()

    await expect(waitForGitHubReleaseWorkflows(rootDir, {
      runCommand,
      logStep,
      logSuccess,
      pushStartedAt: new Date('2026-05-13T11:00:00Z'),
      timeoutMs: 0
    })).resolves.toMatchObject({
      status: 'watched',
      runs: [
        expect.objectContaining({
          databaseId: 200,
          workflowName: 'Publish Package'
        })
      ]
    })

    expect(runCommand).toHaveBeenCalledWith('gh', [
      'run',
      'watch',
      '200',
      '--exit-status',
      '--compact'
    ], {
      cwd: rootDir
    })
    expect(logStep).toHaveBeenCalledWith('Checking for GitHub Actions workflows triggered by the release push...')
    expect(logStep).toHaveBeenCalledWith('Watching GitHub Actions workflow Publish Package #200...')
    expect(logSuccess).toHaveBeenCalledWith('GitHub Actions workflow Publish Package #200 completed successfully.')
  })

  it('fails when a watched GitHub Actions workflow fails', async () => {
    await createWorkflowFile()

    const runCommand = vi.fn(async (command, args) => {
      if (command === 'gh' && args[0] === '--version') {
        return {stdout: 'gh version 2.0.0', stderr: ''}
      }

      if (command === 'git' && args[0] === 'rev-parse') {
        return {stdout: 'abc123', stderr: ''}
      }

      if (command === 'gh' && args[0] === 'run' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            {
              databaseId: 300,
              workflowName: 'Publish Package',
              createdAt: '2026-05-13T11:00:02Z',
              url: 'https://github.test/runs/300'
            }
          ]),
          stderr: ''
        }
      }

      if (command === 'gh' && args[0] === 'run' && args[1] === 'watch') {
        throw new Error('gh exited with code 1')
      }

      return undefined
    })

    await expect(waitForGitHubReleaseWorkflows(rootDir, {
      runCommand,
      pushStartedAt: new Date('2026-05-13T11:00:00Z'),
      timeoutMs: 0
    })).rejects.toThrow(
      'GitHub Actions workflow Publish Package #300 failed or could not be watched. https://github.test/runs/300'
    )
  })

  it('warns and skips when no workflow run appears for the release push', async () => {
    await createWorkflowFile()

    const runCommand = vi.fn(async (command, args) => {
      if (command === 'gh' && args[0] === '--version') {
        return {stdout: 'gh version 2.0.0', stderr: ''}
      }

      if (command === 'git' && args[0] === 'rev-parse') {
        return {stdout: 'abc123', stderr: ''}
      }

      if (command === 'gh' && args[0] === 'run' && args[1] === 'list') {
        return {stdout: '[]', stderr: ''}
      }

      return undefined
    })
    const logWarning = vi.fn()

    await expect(waitForGitHubReleaseWorkflows(rootDir, {
      runCommand,
      logWarning,
      pushStartedAt: new Date('2026-05-13T11:00:00Z'),
      timeoutMs: 0
    })).resolves.toMatchObject({
      status: 'skipped',
      reason: 'no-runs',
      runs: []
    })

    expect(logWarning).toHaveBeenCalledWith(
      'GitHub Actions workflow monitoring skipped because no workflow run appeared for the release push.'
    )
  })
})
