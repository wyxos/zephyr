import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import inquirer from 'inquirer'

export async function isPrivateKeyFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)
  } catch (_error) {
    return false
  }
}

export async function listSshKeys() {
  const sshDir = path.join(os.homedir(), '.ssh')

  try {
    const entries = await fs.readdir(sshDir, { withFileTypes: true })

    const candidates = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        if (!name) return false
        if (name.startsWith('.')) return false
        if (name.endsWith('.pub')) return false
        if (name.startsWith('known_hosts')) return false
        if (name === 'config') return false
        return name.trim().length > 0
      })

    const keys = []

    for (const name of candidates) {
      const filePath = path.join(sshDir, name)
      if (await isPrivateKeyFile(filePath)) {
        keys.push(name)
      }
    }

    return { sshDir, keys }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { sshDir, keys: [] }
    }

    throw error
  }
}

export async function promptSshDetails(currentDir, existing = {}, { runPrompt } = {}) {
  if (!runPrompt) {
    throw new Error('promptSshDetails requires runPrompt')
  }

  const { sshDir, keys: sshKeys } = await listSshKeys()
  const defaultUser = existing.sshUser || os.userInfo().username
  const fallbackKey = path.join(sshDir, 'id_rsa')
  const preselectedKey = existing.sshKey || (sshKeys.length ? path.join(sshDir, sshKeys[0]) : fallbackKey)

  const sshKeyPrompt = sshKeys.length
    ? {
      type: 'list',
      name: 'sshKeySelection',
      message: 'SSH key',
      choices: [
        ...sshKeys.map((key) => ({ name: key, value: path.join(sshDir, key) })),
        new inquirer.Separator(),
        { name: 'Enter custom SSH key path…', value: '__custom' }
      ],
      default: preselectedKey
    }
    : {
      type: 'input',
      name: 'sshKeySelection',
      message: 'SSH key path',
      default: preselectedKey
    }

  const answers = await runPrompt([
    {
      type: 'input',
      name: 'sshUser',
      message: 'SSH user',
      default: defaultUser
    },
    sshKeyPrompt
  ])

  let sshKey = answers.sshKeySelection

  if (sshKey === '__custom') {
    const { customSshKey } = await runPrompt([
      {
        type: 'input',
        name: 'customSshKey',
        message: 'SSH key path',
        default: preselectedKey
      }
    ])

    sshKey = customSshKey.trim() || preselectedKey
  }

  return {
    sshUser: answers.sshUser.trim() || defaultUser,
    sshKey: sshKey.trim() || preselectedKey
  }
}

export async function ensureSshDetails(config, currentDir, { runPrompt, logProcessing } = {}) {
  if (config.sshUser && config.sshKey) {
    return false
  }

  logProcessing?.('SSH details missing. Please provide them now.')
  const details = await promptSshDetails(currentDir, config, { runPrompt })
  Object.assign(config, details)
  return true
}

export function expandHomePath(targetPath) {
  if (!targetPath) {
    return targetPath
  }

  if (targetPath.startsWith('~')) {
    return path.join(os.homedir(), targetPath.slice(1))
  }

  return targetPath
}

export async function resolveSshKeyPath(targetPath) {
  const expanded = expandHomePath(targetPath)

  try {
    await fs.access(expanded)
  } catch (_error) {
    throw new Error(`SSH key not accessible at ${expanded}`)
  }

  return expanded
}

