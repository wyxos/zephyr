import * as preflight from '../../deploy/preflight.mjs'
import {getPhpVersionRequirement} from '../../infrastructure/php/version.mjs'

export async function resolveLocalDeploymentContext(rootDir) {
    let requiredPhpVersion = null

    try {
        requiredPhpVersion = await getPhpVersionRequirement(rootDir)
    } catch {
        // composer.json might not exist or be unreadable
    }

    const isLaravel = await preflight.isLocalLaravelProject(rootDir)
    const hasHook = await preflight.hasPrePushHook(rootDir)

    return {requiredPhpVersion, isLaravel, hasHook}
}
