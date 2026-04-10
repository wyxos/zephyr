export const DEFAULT_PRESET_OPTIONS = Object.freeze({
  maintenanceMode: null,
  skipGitHooks: false,
  skipTests: false,
  skipLint: false,
  skipVersioning: false,
  autoCommit: false
})

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeMaintenanceMode(value) {
  return typeof value === 'boolean' ? value : null
}

export function normalizePresetOptions(options = {}) {
  return {
    maintenanceMode: normalizeMaintenanceMode(options?.maintenanceMode),
    skipGitHooks: normalizeBoolean(options?.skipGitHooks),
    skipTests: normalizeBoolean(options?.skipTests),
    skipLint: normalizeBoolean(options?.skipLint),
    skipVersioning: normalizeBoolean(options?.skipVersioning),
    autoCommit: normalizeBoolean(options?.autoCommit)
  }
}

export function mergeDeployOptions(executionMode = {}, presetOptions = {}) {
  const normalizedPresetOptions = normalizePresetOptions(presetOptions)

  return {
    maintenanceMode: executionMode.explicitMaintenanceMode === true
      ? executionMode.maintenanceMode
      : normalizedPresetOptions.maintenanceMode,
    skipGitHooks: executionMode.explicitSkipGitHooks === true
      ? executionMode.skipGitHooks === true
      : normalizedPresetOptions.skipGitHooks,
    skipTests: executionMode.explicitSkipTests === true
      ? executionMode.skipTests === true
      : normalizedPresetOptions.skipTests,
    skipLint: executionMode.explicitSkipLint === true
      ? executionMode.skipLint === true
      : normalizedPresetOptions.skipLint,
    skipVersioning: executionMode.explicitSkipVersioning === true
      ? executionMode.skipVersioning === true
      : normalizedPresetOptions.skipVersioning,
    autoCommit: executionMode.explicitAutoCommit === true
      ? executionMode.autoCommit === true
      : normalizedPresetOptions.autoCommit
  }
}

export function buildPresetOptionsFromExecutionMode(executionMode = {}, existingOptions = {}) {
  const normalizedOptions = normalizePresetOptions(existingOptions)

  if (executionMode.explicitMaintenanceMode === true) {
    normalizedOptions.maintenanceMode = executionMode.maintenanceMode
  }

  if (executionMode.explicitSkipGitHooks === true) {
    normalizedOptions.skipGitHooks = executionMode.skipGitHooks === true
  }

  if (executionMode.explicitSkipTests === true) {
    normalizedOptions.skipTests = executionMode.skipTests === true
  }

  if (executionMode.explicitSkipLint === true) {
    normalizedOptions.skipLint = executionMode.skipLint === true
  }

  if (executionMode.explicitSkipVersioning === true) {
    normalizedOptions.skipVersioning = executionMode.skipVersioning === true
  }

  if (executionMode.explicitAutoCommit === true) {
    normalizedOptions.autoCommit = executionMode.autoCommit === true
  }

  return normalizedOptions
}

export function presetOptionsEqual(left = {}, right = {}) {
  const normalizedLeft = normalizePresetOptions(left)
  const normalizedRight = normalizePresetOptions(right)

  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight)
}
