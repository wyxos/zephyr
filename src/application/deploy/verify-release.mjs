import http from 'node:http'
import https from 'node:https'
import {ZephyrError} from '../../runtime/errors.mjs'

export async function checkReleaseUrl(url, {timeoutMs = 15000, request = null} = {}) {
  const target = new URL(url)
  const send = request ?? (target.protocol === 'https:' ? https.request : http.request)
  await new Promise((resolve, reject) => {
    const req = send(target, {method: 'GET', headers: {'User-Agent': 'Zephyr-release-health'}}, response => {
      response.resume()
      if (response.statusCode >= 200 && response.statusCode < 300) resolve()
      else reject(new Error(`Health URL returned HTTP ${response.statusCode}`))
    })
    // One bounded request deadline; no retries or polling. Socket inactivity alone cannot bound a trickling response.
    const deadline = setTimeout(() => req.destroy(new Error('Health request timed out')), timeoutMs)
    req.once('error', reject)
    req.once('close', () => clearTimeout(deadline))
    req.end()
  })
}

export async function verifyDeploymentRelease({release = {}, executeRemote, remotePlan, logSuccess, checkUrl = checkReleaseUrl}) {
  if (release.expectedCommit) {
    await executeRemote('Verify deployed commit', `test "$(git rev-parse HEAD)" = ${release.expectedCommit}`)
  }
  if (release.deployment && remotePlan.remoteIsLaravel) {
    await executeRemote('Verify maintenance is disabled', 'test ! -f storage/framework/down')
  }
  if (release.deployment?.healthUrl) {
    try {
      await checkUrl(release.deployment.healthUrl, {timeoutMs: release.deployment.healthTimeoutMs ?? 15000})
    } catch (cause) {
      throw new ZephyrError(`Release health check failed: ${cause.message}`, {code: 'ZEPHYR_RELEASE_HEALTH_FAILED', cause})
    }
    logSuccess?.('Release HTTP health check passed.')
  }
}
