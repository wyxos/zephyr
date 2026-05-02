const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_INTERVAL_MS = 10 * 1000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function npmPackageMetadataUrl(packageName) {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
}

export async function waitForNpmPackageVersion({
  packageName,
  version,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = globalThis.fetch,
  delayImpl = sleep,
  nowImpl = Date.now,
  logProcessing,
  logSuccess,
  logWarning
} = {}) {
  if (!packageName) {
    throw new Error('Package name is required before waiting for npm publication.')
  }

  if (!version) {
    throw new Error('Package version is required before waiting for npm publication.')
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available, so Zephyr cannot verify npm publication.')
  }

  const deadline = nowImpl() + timeoutMs
  const url = npmPackageMetadataUrl(packageName)
  let attempts = 0
  let lastError = null

  logProcessing?.(`Waiting for ${packageName}@${version} to be visible on npm...`)

  while (nowImpl() <= deadline) {
    attempts += 1

    try {
      const response = await fetchImpl(url)

      if (response.ok) {
        const metadata = await response.json()
        if (metadata?.versions?.[version]) {
          logSuccess?.(`${packageName}@${version} is visible on npm.`)
          return {packageName, version, attempts}
        }
      } else {
        lastError = new Error(`npm registry responded with ${response.status}`)
      }
    } catch (error) {
      lastError = error
      logWarning?.(`npm visibility check failed: ${error.message}`)
    }

    if (nowImpl() + intervalMs > deadline) {
      break
    }

    await delayImpl(intervalMs)
  }

  const suffix = lastError ? ` Last error: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${packageName}@${version} to be visible on npm.${suffix}`)
}
