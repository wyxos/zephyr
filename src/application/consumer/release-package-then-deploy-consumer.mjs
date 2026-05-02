import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {validateLocalDependencies} from '../../dependency-scanner.mjs'
import * as bootstrap from '../../project/bootstrap.mjs'
import {createAppContext} from '../../runtime/app-context.mjs'
import {mergeDeployOptions} from '../../config/preset-options.mjs'
import {createConfigurationService} from '../configuration/service.mjs'
import {selectDeploymentTarget} from '../configuration/select-deployment-target.mjs'
import {resolvePendingSnapshot} from '../deploy/resolve-pending-snapshot.mjs'
import {runDeployment} from '../deploy/run-deployment.mjs'
import {waitForNpmPackageVersion} from './npm-publish-wait.mjs'
import {
  assertCleanConsumerRepo,
  updateConsumerDependency
} from './update-consumer-dependency.mjs'

function resolveConsumerRootDir(producerRootDir, consumerRootDir) {
  if (!consumerRootDir) {
    throw new Error('--then-deploy requires a consumer repository path.')
  }

  return path.isAbsolute(consumerRootDir)
    ? path.resolve(consumerRootDir)
    : path.resolve(producerRootDir, consumerRootDir)
}

async function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false)
}

function createConsumerExecutionMode({
  presetName,
  maintenanceMode,
  skipChecks = false,
  skipTests = false,
  skipLint = false,
  skipVersioning = false,
  skipGitHooks = false,
  autoCommit = false,
  json = false,
  explicitMaintenanceMode = false,
  explicitSkipChecks = false,
  explicitSkipTests = false,
  explicitSkipLint = false,
  explicitSkipVersioning = false,
  explicitSkipGitHooks = false,
  explicitAutoCommit = false
} = {}) {
  return {
    interactive: false,
    json: json === true,
    workflow: 'deploy',
    setup: false,
    presetName,
    maintenanceMode,
    skipChecks: skipChecks === true,
    skipTests: skipTests === true || skipChecks === true,
    skipLint: skipLint === true || skipChecks === true,
    skipVersioning: skipVersioning === true,
    skipGitHooks: skipGitHooks === true,
    autoCommit: autoCommit === true,
    resumePending: false,
    discardPending: false,
    explicitMaintenanceMode: explicitMaintenanceMode === true,
    explicitSkipChecks: explicitSkipChecks === true,
    explicitSkipTests: explicitSkipTests === true || explicitSkipChecks === true,
    explicitSkipLint: explicitSkipLint === true || explicitSkipChecks === true,
    explicitSkipVersioning: explicitSkipVersioning === true,
    explicitSkipGitHooks: explicitSkipGitHooks === true,
    explicitAutoCommit: explicitAutoCommit === true
  }
}

function resolvePackageDetails({releasedPackage, packageName, version}) {
  const resolvedPackageName = packageName ?? releasedPackage?.name
  const resolvedVersion = version ?? releasedPackage?.version

  if (!resolvedPackageName) {
    throw new Error('Unable to determine the package name to update in the consumer app. Pass --consumer-package <name>.')
  }

  if (!resolvedVersion) {
    throw new Error('Unable to determine the released package version for the consumer app update.')
  }

  return {packageName: resolvedPackageName, version: resolvedVersion}
}

export async function releasePackageThenDeployConsumer({
  producerRootDir,
  consumerRootDir,
  releasedPackage,
  packageName = null,
  version = null,
  presetName,
  maintenanceMode = null,
  skipChecks = false,
  skipTests = false,
  skipLint = false,
  skipVersioning = false,
  skipGitHooks = false,
  autoCommit = false,
  json = false,
  explicitMaintenanceMode = false,
  explicitSkipChecks = false,
  explicitSkipTests = false,
  explicitSkipLint = false,
  explicitSkipVersioning = false,
  explicitSkipGitHooks = false,
  explicitAutoCommit = false,
  createAppContextImpl = createAppContext,
  waitForNpmPackageVersionImpl = waitForNpmPackageVersion,
  updateConsumerDependencyImpl = updateConsumerDependency,
  assertCleanConsumerRepoImpl = assertCleanConsumerRepo,
  validateLocalDependenciesImpl = validateLocalDependencies,
  selectDeploymentTargetImpl = selectDeploymentTarget,
  resolvePendingSnapshotImpl = resolvePendingSnapshot,
  runDeploymentImpl = runDeployment,
  bootstrapImpl = bootstrap
} = {}) {
  if (!presetName) {
    throw new Error('--then-deploy requires --consumer-preset <name>.')
  }

  const resolvedProducerRootDir = producerRootDir ?? process.cwd()
  const resolvedConsumerRootDir = resolveConsumerRootDir(resolvedProducerRootDir, consumerRootDir)
  const details = resolvePackageDetails({releasedPackage, packageName, version})
  const executionMode = createConsumerExecutionMode({
    presetName,
    maintenanceMode,
    skipChecks,
    skipTests,
    skipLint,
    skipVersioning,
    skipGitHooks,
    autoCommit,
    json,
    explicitMaintenanceMode,
    explicitSkipChecks,
    explicitSkipTests,
    explicitSkipLint,
    explicitSkipVersioning,
    explicitSkipGitHooks,
    explicitAutoCommit
  })
  const context = createAppContextImpl({executionMode})
  const {
    logProcessing,
    logSuccess,
    logWarning,
    runPrompt,
    runCommand,
    runCommandCapture,
    emitEvent
  } = context
  const configurationService = createConfigurationService(context)

  logProcessing?.(`Preparing consumer app at ${resolvedConsumerRootDir}...`)
  await assertCleanConsumerRepoImpl(resolvedConsumerRootDir, {runCommandCapture})

  await bootstrapImpl.ensureGitignoreEntry(resolvedConsumerRootDir, {
    runCommand,
    logSuccess,
    logWarning,
    skipGitHooks: executionMode.skipGitHooks
  })
  await bootstrapImpl.ensureProjectReleaseScript(resolvedConsumerRootDir, {
    runPrompt,
    runCommand,
    logSuccess,
    logWarning,
    skipGitHooks: executionMode.skipGitHooks,
    interactive: executionMode.interactive
  })

  const hasPackageJson = await fileExists(path.join(resolvedConsumerRootDir, 'package.json'))
  const hasComposerJson = await fileExists(path.join(resolvedConsumerRootDir, 'composer.json'))

  if (hasPackageJson || hasComposerJson) {
    logProcessing?.('Validating consumer dependencies...')
    await validateLocalDependenciesImpl(resolvedConsumerRootDir, runPrompt, logSuccess, {
      interactive: executionMode.interactive,
      skipGitHooks: executionMode.skipGitHooks
    })
  }

  const {deploymentConfig, presetState} = await selectDeploymentTargetImpl(resolvedConsumerRootDir, {
    configurationService,
    runPrompt,
    logProcessing,
    logSuccess,
    logWarning,
    emitEvent,
    executionMode,
    promptPresetOptions: true
  })

  if (presetState) {
    const effectiveDeployOptions = mergeDeployOptions(executionMode, presetState.options)
    Object.assign(executionMode, {
      presetName: presetState.name,
      ...effectiveDeployOptions,
      skipChecks: executionMode.skipChecks === true ||
        (effectiveDeployOptions.skipTests === true && effectiveDeployOptions.skipLint === true)
    })
    context.executionMode = executionMode
    await presetState.applyExecutionMode(executionMode)
  }

  await waitForNpmPackageVersionImpl({
    packageName: details.packageName,
    version: details.version,
    logProcessing,
    logSuccess,
    logWarning
  })

  await updateConsumerDependencyImpl({
    rootDir: resolvedConsumerRootDir,
    packageName: details.packageName,
    version: details.version,
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess,
    logWarning,
    skipGitHooks: executionMode.skipGitHooks
  })

  const snapshotToUse = await resolvePendingSnapshotImpl(resolvedConsumerRootDir, deploymentConfig, {
    runPrompt,
    logProcessing,
    logWarning,
    executionMode
  })

  await runDeploymentImpl(deploymentConfig, {
    rootDir: resolvedConsumerRootDir,
    snapshot: snapshotToUse,
    context,
    presetState
  })
}
