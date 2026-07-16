import { describe, it, expect } from 'vitest'
import { planLaravelDeploymentTasks } from '#src/application/deploy/plan-laravel-deployment-tasks.mjs'

describe('application/deploy/plan-laravel-deployment-tasks', () => {
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

  it('uses npm ci for tracked lockfile installs and preserves an intentional no-lock policy', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['package.json']
    })

    const npmStep = steps.find((step) => step.label === 'Install Node dependencies')

    expect(npmStep.command).toContain('git ls-files --error-unmatch package-lock.json')
    expect(npmStep.command).toContain('npm ci --no-audit --no-fund')
    expect(npmStep.command).toContain('git diff --exit-code -- package-lock.json npm-shrinkwrap.json')
    expect(npmStep.command).toContain('npm install --no-package-lock --no-audit --no-fund')
  })

  it('schedules npm run build when frontend changes occur (Laravel)', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['resources/js/app.js']
    })

    expect(steps.some((s) => s.command === 'npm run build')).toBe(true)
  })

  it('schedules npm run build when frontend asset files change (Laravel)', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['resources/images/logo.svg', 'resources/images/hero.webp']
    })

    expect(steps.some((s) => s.command === 'npm run build')).toBe(true)
  })

  it('schedules npm run build when npm dependency installation is scheduled (Laravel)', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['package-lock.json']
    })

    expect(steps.some((s) => s.label === 'Install Node dependencies')).toBe(true)
    expect(steps.some((s) => s.command === 'npm run build')).toBe(true)
  })

  it('schedules dependency installation and a build when npm-shrinkwrap.json changes', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['npm-shrinkwrap.json']
    })

    expect(steps.some((step) => step.label === 'Install Node dependencies')).toBe(true)
    expect(steps.some((step) => step.command === 'npm run build')).toBe(true)
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
    expect(composerStep.command).toContain('git ls-files --error-unmatch composer.lock')
    expect(composerStep.command).toContain('validate --no-check-publish --strict --no-interaction')
    expect(composerStep.command).toContain('install --no-dev --no-interaction --no-progress --prefer-dist --optimize-autoloader')
    expect(composerStep.command).toContain('git diff --exit-code -- composer.lock')
  })

  it('does not schedule Laravel maintenance tasks for non-Laravel projects', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: false,
      changedFiles: ['composer.json', 'package.json', 'database/migrations/2025_01_01_000000_test.php']
    })

    expect(steps).toHaveLength(1)
    expect(steps[0].command).toBe('git pull origin main')
  })

  it('uses provided maintenance mode commands when enabled', () => {
    const steps = planLaravelDeploymentTasks({
      branch: 'main',
      isLaravel: true,
      changedFiles: ['composer.json'],
      phpCommand: 'php8.4',
      maintenanceMode: true,
      maintenanceDownCommand: 'php8.4 artisan down --render="errors::503"',
      maintenanceUpCommand: 'php8.4 artisan up'
    })

    expect(steps[0]).toMatchObject({
      label: 'Enable Laravel maintenance mode',
      command: 'php8.4 artisan down --render="errors::503"',
      kind: 'maintenance-down'
    })
    expect(steps[1]).toMatchObject({
      label: 'Pull latest changes for main',
      command: 'git pull origin main'
    })
    expect(steps.at(-1)).toMatchObject({
      label: 'Disable Laravel maintenance mode',
      command: 'php8.4 artisan up',
      kind: 'maintenance-up'
    })
  })
})
