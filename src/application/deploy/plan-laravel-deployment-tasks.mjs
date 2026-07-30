import {createFrontendArtifactRemotePlan} from './frontend-artifact.mjs'

const FRONTEND_BUILD_EXTENSIONS = [
  '.vue',
  '.css',
  '.scss',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico'
]

export function planLaravelDeploymentTasks({
  branch,
  isLaravel,
  changedFiles,
  horizonConfigured = false,
  phpCommand = 'php',
  maintenanceMode = false,
  maintenanceDownCommand = null,
  maintenanceUpCommand = null,
  frontendBuildStrategy = 'remote',
  frontendArtifact = null
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
        file === 'npm-shrinkwrap.json' ||
        file.endsWith('/package.json') ||
        file.endsWith('/package-lock.json') ||
        file.endsWith('/npm-shrinkwrap.json')
    )

  const hasFrontendChanges =
    isLaravel &&
    safeChangedFiles.some((file) =>
      FRONTEND_BUILD_EXTENSIONS.some((ext) => file.endsWith(ext))
    )

  const shouldRunBuild = isLaravel && (hasFrontendChanges || shouldRunNpmInstall)
  const usesLocalFrontendArtifact = shouldRunBuild && frontendBuildStrategy === 'local-artifact'
  let frontendArtifactPlan = null

  if (usesLocalFrontendArtifact) {
    if (!frontendArtifact) {
      throw new Error('Local-artifact deployment requires a prepared frontend artifact.')
    }

    frontendArtifactPlan = createFrontendArtifactRemotePlan(frontendArtifact)
  }
  const shouldClearCaches = hasPhpChanges
  const shouldRestartQueues = hasPhpChanges

  const steps = []

  if (maintenanceMode && isLaravel) {
    steps.push({
      label: 'Enable Laravel maintenance mode',
      command: maintenanceDownCommand ?? `${phpCommand} artisan down`,
      kind: 'maintenance-down'
    })
  }

  steps.push({
    label: `Pull latest changes for ${branch}`,
    command: `git pull origin ${branch}`
  })

  if (shouldRunComposer) {
    // Composer is a PHP script, so we need to run it with the correct PHP version
    // Deployments should be lockfile-based and reproducible.
    // `composer update --no-dev` still resolves require-dev and can fail on production PHP versions.
    // Prefer `composer install --no-dev` and fail loudly if composer.lock is missing.
    steps.push({
      label: 'Install Composer dependencies',
      command: `if ! git ls-files --error-unmatch composer.lock >/dev/null 2>&1; then echo "composer.lock is not tracked; commit composer.lock for reproducible deploys." >&2; exit 1; fi; if [ -f composer.phar ]; then composer_command="${phpCommand} composer.phar"; elif command -v composer >/dev/null 2>&1; then composer_command="${phpCommand} $(command -v composer)"; else composer_command="${phpCommand} composer"; fi; $composer_command validate --no-check-publish --strict --no-interaction; $composer_command install --no-dev --no-interaction --no-progress --prefer-dist --optimize-autoloader; git diff --exit-code -- composer.lock`
    })
  }

  if (shouldRunMigrations) {
    steps.push({
      label: 'Run database migrations',
      command: `${phpCommand} artisan migrate --force`
    })
  }

  if (shouldRunNpmInstall && !usesLocalFrontendArtifact) {
    steps.push({
      label: 'Install Node dependencies',
      command: 'if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1 || git ls-files --error-unmatch npm-shrinkwrap.json >/dev/null 2>&1; then npm ci --no-audit --no-fund; git diff --exit-code -- package-lock.json npm-shrinkwrap.json; else npm install --no-package-lock --no-audit --no-fund; fi'
    })
  }

  if (usesLocalFrontendArtifact) {
    steps.push({
      label: 'Activate local frontend artifact',
      command: frontendArtifactPlan.activationCommand,
      kind: 'frontend-artifact-activate'
    })
  } else if (shouldRunBuild) {
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

  if (usesLocalFrontendArtifact) {
    steps.push({
      label: 'Finalize local frontend artifact',
      command: frontendArtifactPlan.finalizeCommand,
      kind: 'frontend-artifact-finalize'
    })
  }

  if (maintenanceMode && isLaravel) {
    steps.push({
      label: 'Disable Laravel maintenance mode',
      command: maintenanceUpCommand ?? `${phpCommand} artisan up`,
      kind: 'maintenance-up'
    })
  }

  return steps
}
