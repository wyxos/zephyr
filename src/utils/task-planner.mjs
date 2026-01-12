export function planLaravelDeploymentTasks({
  branch,
  isLaravel,
  changedFiles,
  horizonConfigured = false
}) {
  const safeChangedFiles = Array.isArray(changedFiles) ? changedFiles : []

  const shouldRunComposer =
    isLaravel &&
    safeChangedFiles.some(
      (file) =>
        file === 'composer.json' ||
        file === 'composer.lock' ||
        file.endsWith('/composer.json') ||
        file.endsWith('/composer.lock')
    )

  const shouldRunMigrations =
    isLaravel &&
    safeChangedFiles.some((file) => file.startsWith('database/migrations/') && file.endsWith('.php'))

  const hasPhpChanges = isLaravel && safeChangedFiles.some((file) => file.endsWith('.php'))

  const shouldRunNpmInstall =
    isLaravel &&
    safeChangedFiles.some(
      (file) =>
        file === 'package.json' ||
        file === 'package-lock.json' ||
        file.endsWith('/package.json') ||
        file.endsWith('/package-lock.json')
    )

  const hasFrontendChanges =
    isLaravel &&
    safeChangedFiles.some((file) =>
      ['.vue', '.css', '.scss', '.js', '.ts', '.tsx', '.less'].some((ext) => file.endsWith(ext))
    )

  const shouldRunBuild = isLaravel && (hasFrontendChanges || shouldRunNpmInstall)
  const shouldClearCaches = hasPhpChanges
  const shouldRestartQueues = hasPhpChanges

  const steps = [
    {
      label: `Pull latest changes for ${branch}`,
      command: `git pull origin ${branch}`
    }
  ]

  if (shouldRunComposer) {
    steps.push({
      label: 'Update Composer dependencies',
      command: 'composer update --no-dev --no-interaction --prefer-dist'
    })
  }

  if (shouldRunMigrations) {
    steps.push({
      label: 'Run database migrations',
      command: 'php artisan migrate --force'
    })
  }

  if (shouldRunNpmInstall) {
    steps.push({
      label: 'Install Node dependencies',
      command: 'npm install'
    })
  }

  if (shouldRunBuild) {
    steps.push({
      label: 'Compile frontend assets',
      command: 'npm run build'
    })
  }

  if (shouldClearCaches) {
    steps.push({
      label: 'Clear Laravel caches',
      command: 'php artisan cache:clear && php artisan config:clear && php artisan view:clear'
    })
  }

  if (shouldRestartQueues) {
    steps.push({
      label: horizonConfigured ? 'Restart Horizon workers' : 'Restart queue workers',
      command: horizonConfigured ? 'php artisan horizon:terminate' : 'php artisan queue:restart'
    })
  }

  return steps
}

