import {resolveRemotePath} from '../../utils/remote-path.mjs'

async function resolveRemoteHome(ssh, sshUser) {
    const remoteHomeResult = await ssh.execCommand('printf "%s" "$HOME"')
    return remoteHomeResult.stdout.trim() || `/home/${sshUser}`
}

export async function connectToRemoteDeploymentTarget({
                                                          config,
                                                          createSshClient,
                                                          sshUser,
                                                          privateKey,
                                                          privateKeyPath,
                                                          remoteCwd = null,
                                                          logProcessing,
                                                          message
                                                      } = {}) {
    const ssh = createSshClient()
    const sshTarget = config.sshAlias || config.serverIp

    logProcessing?.(`\n${message ?? `Connecting to ${sshTarget} as ${sshUser}...`}`)

    await ssh.connect({
        host: config.serverIp,
        username: sshUser,
        privateKey,
        ...(config.sshAlias ? {sshAlias: config.sshAlias, privateKeyPath} : {})
    })

    if (remoteCwd) {
        return {ssh, remoteCwd}
    }

    const remoteHome = await resolveRemoteHome(ssh, sshUser)

    return {
        ssh,
        remoteCwd: resolveRemotePath(config.projectPath, remoteHome)
    }
}
