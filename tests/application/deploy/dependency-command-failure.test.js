import {describe, expect, it} from 'vitest'
import {spawnSync} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {planLaravelDeploymentTasks} from '#src/application/deploy/plan-laravel-deployment-tasks.mjs'

const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash'
const commandFor = (label, changedFiles, deployment) => planLaravelDeploymentTasks({
  branch: 'main', isLaravel: true, changedFiles, phpCommand: 'fake_php', deployment
}).find(step => step.label === label).command

// No dependency installer or network command runs: shell functions simulate failure.
const fakeGit = 'git() { if [ "$1" = diff ]; then printf "FINAL_DIFF_RAN"; fi; return 0; }; '
const run = (command, fakes) => spawnSync(bash, ['-c', fakeGit + fakes + command], {
  cwd: os.tmpdir(), encoding: 'utf8'
})

describe('dependency command failure propagation', () => {
  it.each(['validate', 'install'])('stops the Composer chain when %s fails', failingCommand => {
    const command = commandFor('Install Composer dependencies', ['composer.lock'])
    const fakes = `fake_php() { for arg in "$@"; do if [ "$arg" = ${failingCommand} ]; then return 42; fi; done; return 0; }; `
    const result = run(command, fakes)
    expect(result.status).toBe(42)
    expect(result.stdout).not.toContain('FINAL_DIFF_RAN')
  })

  it('does not hide a failed npm ci behind a successful lockfile diff', () => {
    const command = commandFor('Install Node dependencies', ['package-lock.json'])
    const result = run(command, 'npm() { return 43; }; ')
    expect(result.status).toBe(43)
    expect(result.stdout).not.toContain('FINAL_DIFF_RAN')
  })

  it('does not hide a failed frozen pnpm install behind a successful lockfile diff', () => {
    const command = commandFor('Install Node dependencies', ['pnpm-lock.yaml'], {packageManager: 'pnpm'})
    const result = run(command, 'corepack() { return 44; }; ')
    expect(result.status).toBe(44)
    expect(result.stdout).not.toContain('FINAL_DIFF_RAN')
  })

  it('keeps successful Composer and npm chains successful', () => {
    const composer = run(commandFor('Install Composer dependencies', ['composer.lock']), 'fake_php() { return 0; }; ')
    const npm = run(commandFor('Install Node dependencies', ['package-lock.json']), 'npm() { return 0; }; ')
    expect(composer.status).toBe(0)
    expect(composer.stdout).toContain('FINAL_DIFF_RAN')
    expect(npm.status).toBe(0)
    expect(npm.stdout).toContain('FINAL_DIFF_RAN')
  })
})
