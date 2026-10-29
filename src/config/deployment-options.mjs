import {ZephyrError} from '../runtime/errors.mjs'

export function normalizeDeploymentOptions(value) {
  if (value == null) return null
  const fail = message => { throw new ZephyrError(message, {code: 'ZEPHYR_DEPLOYMENT_CONFIG_INVALID'}) }
  if (typeof value !== 'object' || Array.isArray(value)) fail('deployment must be an object.')
  const allowed = ['packageManager', 'publishShiftAssets', 'optimizeCaches', 'restartSsr', 'linkStorage', 'restartReverb', 'keepMaintenanceOnFailure', 'healthChecks', 'healthUrl', 'healthTimeoutMs']
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown deployment option: ${key}`)
  const result = {...value}
  if (value.packageManager !== undefined && !['npm', 'pnpm'].includes(value.packageManager)) fail('packageManager must be npm or pnpm.')
  for (const key of ['publishShiftAssets', 'optimizeCaches', 'restartSsr', 'linkStorage', 'restartReverb', 'keepMaintenanceOnFailure']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${key} must be a boolean.`)
  }
  if (value.healthChecks !== undefined) {
    if (!Array.isArray(value.healthChecks) || value.healthChecks.length > 20) fail('healthChecks must be an array of at most 20 commands.')
    result.healthChecks = value.healthChecks.map(check => {
      if (!check || typeof check.label !== 'string' || !check.label.trim() || typeof check.command !== 'string' || !check.command.trim()) fail('Every health check requires a label and command.')
      return {label: check.label.trim(), command: check.command}
    })
  }
  if (value.healthUrl !== undefined) {
    let url
    try { url = new URL(value.healthUrl) } catch { fail('healthUrl must be an HTTP or HTTPS URL.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('healthUrl must be HTTP(S) without credentials or fragment.')
    result.healthUrl = url.href
  }
  if (value.healthTimeoutMs !== undefined && (!Number.isInteger(value.healthTimeoutMs) || value.healthTimeoutMs < 1 || value.healthTimeoutMs > 120000)) fail('healthTimeoutMs must be between 1 and 120000.')
  return result
}
