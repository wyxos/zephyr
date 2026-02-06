import { describe, it, expect } from 'vitest'
import { planLaravelDeploymentTasks } from '../src/utils/task-planner.mjs'

describe('task-planner', () => {
  it('always includes git pull for the branch', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: []
    })

    expect(steps[0]).toMatchObject({
      label: 'Pull latest changes for main',
      command: 'git pull origin main'
    })
  })

  it('schedules npm install when package.json changes (Laravel)', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['package.json']
    })

    expect(steps.some((s) => s.command === 'npm install')).toBe(true)
  })

  it('schedules npm run build when frontend changes occur (Laravel)', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['resources/js/app.js']
    })

    expect(steps.some((s) => s.command === 'npm run build')).toBe(true)
  })

  it('schedules npm run build when npm install is scheduled (Laravel)', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['package-lock.json']
    })

    expect(steps.some((s) => s.command === 'npm install')).toBe(true)
    expect(steps.some((s) => s.command === 'npm run build')).toBe(true)
  })

  it('schedules queue restart choice based on horizonConfigured', () => {
    const horizonSteps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['app/Jobs/Foo.php'],
      horizonConfigured: true
    })

    expect(horizonSteps.some((s) => s.command.includes('artisan horizon:terminate'))).toBe(true)

    const queueSteps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['app/Jobs/Foo.php'],
      horizonConfigured: false
    })

    expect(queueSteps.some((s) => s.command.includes('artisan queue:restart'))).toBe(true)
  })

  it('uses custom PHP command when provided', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['app/Jobs/Foo.php'],
      phpCommand: 'php8.4'
    })

    expect(steps.some((s) => s.command.startsWith('php8.4 artisan'))).toBe(true)
  })

  it('uses php8.4 for composer when phpCommand is php8.4', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['composer.json'],
      phpCommand: 'php8.4'
    })

    const composerStep = steps.find((s) => s.label === 'Install Composer dependencies')
    expect(composerStep).toBeDefined()
    expect(composerStep.command).toContain('php8.4')
  })

  it('does not schedule Laravel maintenance tasks for non-Laravel projects', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: false,
      changedFiles: ['composer.json', 'package.json', 'database/migrations/2025_01_01_000000_test.php']
    })

    // Should still pull
    expect(steps).toHaveLength(1)
    expect(steps[0].command).toBe('git pull origin main')
  })
})
