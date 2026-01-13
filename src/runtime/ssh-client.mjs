export function createSshClientFactory({ NodeSSH }) {
  if (!NodeSSH) {
    throw new Error('createSshClientFactory requires NodeSSH')
  }

  return function createSshClient() {
    if (typeof globalThis !== 'undefined' && globalThis.__zephyrSSHFactory) {
      return globalThis.__zephyrSSHFactory()
    }

    return new NodeSSH()
  }
}

