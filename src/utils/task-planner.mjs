export function planLaravelDeploymentTasks({
  branch,
  isLaravel,
  changedFiles,
  horizonConfigured = false,
  phpCommand = 'php'
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
    // Composer is a PHP script, so we need to run it with the correct PHP version
    // Deployments should be lockfile-based and reproducible.
    // `composer update --no-dev` still resolves require-dev and can fail on production PHP versions.
    // Prefer `composer install --no-dev` and fail loudly if composer.lock is missing.
    steps.push({
      label: 'Install Composer dependencies',
      command: `if [ ! -f composer.lock ]; then echo "composer.lock is missing; commit composer.lock for reproducible deploys." >&2; exit 1; fi; if [ -f composer.phar ]; then ${phpCommand} composer.phar install --no-dev --no-interaction --prefer-dist --optimize-autoloader; elif command -v composer >/dev/null 2>&1; then ${phpCommand} $(command -v composer) install --no-dev --no-interaction --prefer-dist --optimize-autoloader; else ${phpCommand} composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader; fi`
    })
  }

  if (shouldRunMigrations) {
    steps.push({
      label: 'Run database migrations',
      command: `${phpCommand} artisan migrate --force`
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
      command: `${phpCommand} artisan cache:clear && ${phpCommand} artisan config:clear && ${phpCommand} artisan view:clear`
    })
  }

  if (shouldRestartQueues) {
    steps.push({
      label: horizonConfigured ? 'Restart Horizon workers' : 'Restart queue workers',
      command: horizonConfigured ? `${phpCommand} artisan horizon:terminate` : `${phpCommand} artisan queue:restart`
    })
  }

  return steps
}
