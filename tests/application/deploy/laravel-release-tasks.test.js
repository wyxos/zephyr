import {describe, expect, it} from 'vitest'
import {planLaravelDeploymentTasks} from '#src/application/deploy/plan-laravel-deployment-tasks.mjs'
import {createReleasePullCommand, normalizeDeploymentTasks} from '#src/application/deploy/release-task-options.mjs'

const commit = 'a'.repeat(40)
const plan = (options = {}) => planLaravelDeploymentTasks({
  branch: 'main', isLaravel: true, changedFiles: [], ...options
})

describe('configured Laravel release tasks', () => {
  it('uses frozen pnpm installation and build when its lockfile changes', () => {
    const steps = plan({changedFiles: ['pnpm-lock.yaml'], deployment: {packageManager: 'pnpm'}})
    expect(steps.map(step => step.label)).toEqual([
      'Pull latest changes for main', 'Install Node dependencies', 'Compile frontend assets'
    ])
    expect(steps[1].command).toContain('git ls-files --error-unmatch pnpm-lock.yaml')
    expect(steps[1].command).toContain('corepack pnpm install --frozen-lockfile && git diff --exit-code -- pnpm-lock.yaml')
    expect(steps[2].command).toBe('corepack pnpm run build')
    expect(steps.some(step => /(^|[ ;])npm /.test(step.command))).toBe(false)
  })

  it('builds pnpm source changes without unnecessarily installing dependencies', () => {
    const steps = plan({changedFiles: ['resources/js/page.vue'], deployment: {packageManager: 'pnpm'}})
    expect(steps.map(step => step.label)).toEqual(['Pull latest changes for main', 'Compile frontend assets'])
    expect(steps[1].command).toBe('corepack pnpm run build')
  })

  it('preserves local-artifact and tracked-assets strategies with pnpm', () => {
    const steps = plan({changedFiles: ['pnpm-lock.yaml', 'resources/js/page.vue'],
      frontendBuildStrategy: 'tracked-assets', deployment: {packageManager: 'pnpm'}})
    expect(steps.map(step => step.label)).toEqual(['Pull latest changes for main'])
  })

  it('runs opted-in lifecycle tasks and health checks in safe order', () => {
    const steps = plan({
      expectedCommit: commit,
      phpCommand: 'php8.4', maintenanceMode: true,
      changedFiles: ['composer.lock', 'pnpm-lock.yaml', 'database/migrations/add.php', 'resources/js/page.vue'],
      deployment: {
        packageManager: 'pnpm', publishShiftAssets: true, optimizeCaches: true, restartSsr: true,
        healthChecks: [{label: 'Check SSR', command: 'php8.4 artisan inertia:check-ssr'}]
      }
    })
    expect(steps.map(step => step.label)).toEqual([
      'Enable Laravel maintenance mode', 'Pull latest changes for main',
      'Install Composer dependencies', 'Publish SHIFT public assets',
      'Clear Laravel configuration before migrations', 'Run database migrations',
      'Install Node dependencies', 'Compile frontend assets', 'Clear Laravel caches',
      'Restart queue workers', 'Restart Inertia SSR renderer', 'Disable Laravel maintenance mode', 'Check SSR'
    ])
    expect(steps.find(step => step.label === 'Publish SHIFT public assets').command).toBe('php8.4 artisan shift:publish --group=public')
    expect(steps.find(step => step.label === 'Clear Laravel caches').command).toBe('php8.4 artisan optimize:clear && php8.4 artisan optimize')
    expect(steps.find(step => step.label === 'Restart Inertia SSR renderer').command).toBe('php8.4 artisan inertia:stop-ssr --graceful')
    expect(steps.at(-1)).toMatchObject({kind: 'health-check', command: 'php8.4 artisan inertia:check-ssr'})
  })

  it('does not omit explicit lifecycle checks on same-commit releases', () => {
    const steps = plan({deployment: {publishShiftAssets: true, optimizeCaches: true, restartSsr: true}})
    expect(steps.some(step => step.label === 'Publish SHIFT public assets')).toBe(true)
    expect(steps.some(step => step.label === 'Clear Laravel configuration before migrations')).toBe(true)
    expect(steps.some(step => step.label === 'Clear Laravel caches')).toBe(true)
    expect(steps.some(step => step.label === 'Restart queue workers')).toBe(true)
    expect(steps.some(step => step.label === 'Restart Inertia SSR renderer')).toBe(true)
  })

  it('does not add Laravel tasks to a non-Laravel release', () => {
    const steps = plan({isLaravel: false, deployment: {publishShiftAssets: true, optimizeCaches: true, restartSsr: true}})
    expect(steps.map(step => step.label)).toEqual(['Pull latest changes for main'])
  })

  it.each([
    {packageManager: 'yarn'}, {packageManager: 'auto'}, {restartSsr: 'yes'},
    {publishShiftAssets: 1}, {optimizeCaches: null}, {healthChecks: 'curl'},
    {healthChecks: [{label: '', command: 'true'}]}, {healthChecks: [{label: 'Check'}]}
  ])('rejects invalid explicit options: %j', deployment => {
    expect(() => normalizeDeploymentTasks(deployment)).toThrow()
  })
})

describe('verified release commit pull', () => {
  it('keeps legacy unpinned pulls unchanged', () => {
    expect(createReleasePullCommand('main')).toBe('git pull origin main')
  })

  it('checks fetched branch and final checkout against the exact approved SHA', () => {
    const command = createReleasePullCommand('main', commit)
    expect(command).toContain('git fetch origin')
    expect(command).toContain(`test "$(git rev-parse FETCH_HEAD)" = ${commit}`)
    expect(command).toContain(`git merge --ff-only ${commit}`)
    expect(command).not.toContain("git pull")
    expect(command).toContain('git symbolic-ref --quiet --short HEAD')
    expect(command).toContain('git status --porcelain')
    expect(command).toContain(`test "$(git rev-parse HEAD)" = ${commit}`)
    expect(command).toContain('inspect before retrying.')
    expect(command).toContain('exit 1')
  })

  it.each(['', 'shortsha', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(40) + '; true'])('rejects invalid commit %s', sha => {
    expect(() => createReleasePullCommand('main', sha)).toThrow('full hexadecimal')
  })

  it.each(['--upload-pack=malicious', 'bad branch', 'bad\\branch'])('rejects an invalid branch %s', branch => {
    expect(() => createReleasePullCommand(branch, commit)).toThrow('branch is invalid')
  })
})
