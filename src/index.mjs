import chalk from 'chalk'
import inquirer from 'inquirer'
import { NodeSSH } from 'node-ssh'

import { createChalkLogger } from './utils/output.mjs'
import { runCommand as runCommandBase, runCommandCapture as runCommandCaptureBase } from './utils/command.mjs'
import { createLocalCommandRunners } from './runtime/local-command.mjs'
import { createRunPrompt } from './runtime/prompt.mjs'
import { createSshClientFactory } from './runtime/ssh-client.mjs'
import { generateId } from './utils/id.mjs'

import { loadServers as loadServersImpl, saveServers } from './config/servers.mjs'
import { loadProjectConfig as loadProjectConfigImpl, saveProjectConfig } from './config/project.mjs'
import * as configFlow from './utils/config-flow.mjs'
import * as sshKeys from './ssh/keys.mjs'
import { writeToLogFile } from './utils/log-file.mjs'

export { main, runRemoteTasks } from './main.mjs'
export { connectToServer, executeRemoteCommand, readRemoteFile, downloadRemoteFile, deleteRemoteFile } from './ssh/index.mjs'

const { logProcessing, logSuccess, logWarning, logError } = createChalkLogger(chalk)
const runPrompt = createRunPrompt({ inquirer })
const { runCommand, runCommandCapture } = createLocalCommandRunners({
  runCommandBase,
  runCommandCaptureBase
})

// Keep this aligned with main's test injection behavior
const createSshClient = createSshClientFactory({ NodeSSH })

export { logProcessing, logSuccess, logWarning, logError, runCommand, runCommandCapture, writeToLogFile, createSshClient }

export async function loadServers() {
  return await loadServersImpl({ logSuccess, logWarning })
}

export async function loadProjectConfig(rootDir, servers) {
  return await loadProjectConfigImpl(rootDir, servers, { logSuccess, logWarning })
}

export function defaultProjectPath(currentDir) {
  return configFlow.defaultProjectPath(currentDir)
}

export async function listGitBranches(currentDir) {
  return await configFlow.listGitBranches(currentDir, { runCommandCapture, logWarning })
}

export async function promptSshDetails(currentDir, existing = {}) {
  return await sshKeys.promptSshDetails(currentDir, existing, { runPrompt })
}

export async function promptServerDetails(existingServers = []) {
  return await configFlow.promptServerDetails(existingServers, { runPrompt, generateId })
}

export async function selectServer(servers) {
  return await configFlow.selectServer(servers, {
    runPrompt,
    logProcessing,
    logSuccess,
    saveServers,
    promptServerDetails
  })
}

export async function promptAppDetails(currentDir, existing = {}) {
  return await configFlow.promptAppDetails(currentDir, existing, {
    runPrompt,
    listGitBranches,
    defaultProjectPath,
    promptSshDetails
  })
}

export async function selectApp(projectConfig, server, currentDir) {
  return await configFlow.selectApp(projectConfig, server, currentDir, {
    runPrompt,
    logWarning,
    logProcessing,
    logSuccess,
    saveProjectConfig,
    generateId,
    promptAppDetails
  })
}

export async function selectPreset(projectConfig, servers) {
  return await configFlow.selectPreset(projectConfig, servers, { runPrompt })
}

