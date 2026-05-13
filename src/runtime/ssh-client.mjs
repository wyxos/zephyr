const connectionErrorHandlerSymbol = Symbol('zephyrSshConnectionErrorHandler')
const connectWrapperSymbol = Symbol('zephyrSshConnectWrapper')

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error ?? 'Unknown SSH connection error')
}

export function attachSshConnectionErrorHandler(ssh, { logWarning } = {}) {
  const connection = ssh?.connection

  if (!connection || typeof connection.on !== 'function') {
    return false
  }

  if (connection[connectionErrorHandlerSymbol]) {
    return false
  }

  let hasLogged = false
  const handler = (error) => {
    if (hasLogged) {
      return
    }

    hasLogged = true
    logWarning?.(`SSH connection emitted a background error after connect: ${getErrorMessage(error)}`)
  }

  connection.on('error', handler)
  connection[connectionErrorHandlerSymbol] = handler

  return true
}

function wrapSshConnect(ssh, { logWarning } = {}) {
  if (!ssh || typeof ssh.connect !== 'function' || ssh[connectWrapperSymbol]) {
    return ssh
  }

  const originalConnect = ssh.connect

  ssh.connect = async function connectWithBackgroundErrorHandler(...args) {
    const result = await originalConnect.apply(this, args)
    attachSshConnectionErrorHandler(this, { logWarning })

    return result
  }
  ssh[connectWrapperSymbol] = true

  return ssh
}

export function createSshClientFactory({ NodeSSH, logWarning }) {
  if (!NodeSSH) {
    throw new Error('createSshClientFactory requires NodeSSH')
  }

  return function createSshClient() {
    if (typeof globalThis !== 'undefined' && globalThis.__zephyrSSHFactory) {
      return wrapSshConnect(globalThis.__zephyrSSHFactory(), { logWarning })
    }

    return wrapSshConnect(new NodeSSH(), { logWarning })
  }
}
