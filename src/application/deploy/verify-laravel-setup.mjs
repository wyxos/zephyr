import fs from 'node:fs/promises'

import {isLocalLaravelProject} from '../../deploy/preflight.mjs'
import {ZephyrError} from '../../runtime/errors.mjs'
import {resolveSshKeyPath} from '../../ssh/keys.mjs'

export async function assertLaravelSetupProject(rootDir) {
    const isLaravel = await isLocalLaravelProject(rootDir)

    if (!isLaravel) {
        throw new ZephyrError(
            'Zephyr setup is only supported for Laravel app projects.',
            {code: 'ZEPHYR_SETUP_REQUIRES_LARAVEL'}
        )
    }
}

export async function verifyLaravelSetup({
    config,
    rootDir,
    createSshClient,
    sshUser,
    logProcessing,
    logSuccess
} = {}) {
    await assertLaravelSetupProject(rootDir)

    const privateKeyPath = await resolveSshKeyPath(config.sshKey)
    const privateKey = await fs.readFile(privateKeyPath, 'utf8')
    const ssh = createSshClient()

    try {
        logProcessing?.(`\nConnecting to ${config.serverIp} as ${sshUser} to verify SSH setup...`)
        await ssh.connect({
            host: config.serverIp,
            username: sshUser,
            privateKey
        })
        logSuccess?.('Setup verified. SSH connection succeeded for this Laravel app.')
    } finally {
        ssh.dispose()
    }
}
