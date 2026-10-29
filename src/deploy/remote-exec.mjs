import {StringDecoder} from 'node:string_decoder'

import {ZephyrError} from '../runtime/errors.mjs'

function escapeForDoubleQuotes(value) {
  return value.replace(/(["\\$`])/g, '\\$1')
}

function escapeForSingleQuotes(value) {
  return value.replace(/'/g, "'\\''")
}

function createProfileBootstrap() {
  return [
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"; fi',
    'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile"; fi',
    'if [ -f "$HOME/.zshrc" ]; then . "$HOME/.zshrc"; fi',
    'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi',
    'if [ -s "$HOME/.config/nvm/nvm.sh" ]; then . "$HOME/.config/nvm/nvm.sh"; fi',
    'if [ -s "/usr/local/opt/nvm/nvm.sh" ]; then . "/usr/local/opt/nvm/nvm.sh"; fi',
    'if command -v npm >/dev/null 2>&1; then :',
    'elif [ -d "$HOME/.nvm/versions/node" ]; then NODE_VERSION=$(ls -1 "$HOME/.nvm/versions/node" | tail -1) && export PATH="$HOME/.nvm/versions/node/$NODE_VERSION/bin:$PATH"',
    'elif [ -d "/usr/local/lib/node_modules/npm/bin" ]; then export PATH="/usr/local/lib/node_modules/npm/bin:$PATH"',
    'elif [ -d "/opt/homebrew/bin" ] && [ -f "/opt/homebrew/bin/npm" ]; then export PATH="/opt/homebrew/bin:$PATH"',
    'elif [ -d "/usr/local/bin" ] && [ -f "/usr/local/bin/npm" ]; then export PATH="/usr/local/bin:$PATH"',
    'elif [ -d "$HOME/.local/bin" ] && [ -f "$HOME/.local/bin/npm" ]; then export PATH="$HOME/.local/bin:$PATH"',
    'fi'
  ].join('; ')
}

export function createRemoteExecutor({ ssh, rootDir, remoteCwd, writeToLogFile, logProcessing, logSuccess, logError, logOutput }) {
  const profileBootstrap = createProfileBootstrap()

  return async function executeRemote(label, command, options = {}) {
    const {
      cwd = remoteCwd,
      allowFailure = false,
      bootstrapEnv = true,
      env = {},
      printStdout = true
    } = options

    logProcessing?.(`\n${label}`)

    let wrappedCommand = command
    let execOptions = { cwd }

    let envExports = ''
    if (env && Object.keys(env).length > 0) {
      envExports = Object.entries(env)
        .map(([key, value]) => `${key}='${escapeForSingleQuotes(String(value))}'`)
        .join(' ') + ' '
    }

    if (bootstrapEnv && cwd) {
      const cwdForShell = escapeForDoubleQuotes(cwd)
      wrappedCommand = `${profileBootstrap}; cd "${cwdForShell}" && ${envExports}${command}`
      execOptions = {}
    } else if (envExports) {
      wrappedCommand = `${envExports}${command}`
    }

    const decoders = {stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8')}
    const streamed = {stdout: false, stderr: false}
    let logWrites = Promise.resolve()
    let logFailure = null
    let acceptingOutput = true
    function output(stream, text) {
      if (!text) return
      try {
        if (stream !== 'stdout' || printStdout) {
          if (logOutput) {
            logOutput({label, stream, chunk: text})
          } else {
            logProcessing?.(`[${label}] ${stream}: ${text}`)
          }
        }
      } catch (error) {
        logFailure ??= error
      }
      logWrites = logWrites.then(() => writeToLogFile(rootDir, `[${label}] ${stream.toUpperCase()}:\n${text}`))
        .catch(error => { logFailure ??= error })
    }
    function onChunk(stream, chunk) {
      if (!acceptingOutput) return
      streamed[stream] = true
      output(stream, decoders[stream].write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    }
    execOptions.onStdout = chunk => onChunk('stdout', chunk)
    execOptions.onStderr = chunk => onChunk('stderr', chunk)

    let result
    let transportFailure
    try {
      result = await ssh.execCommand(wrappedCommand, execOptions)
    } catch (error) {
      transportFailure = error
    }
    acceptingOutput = false
    for (const stream of ['stdout', 'stderr']) {
      output(stream, decoders[stream].end())
      if (!streamed[stream] && result?.[stream]) output(stream, result[stream])
    }
    await logWrites
    if (transportFailure || result?.outcomeUnknown || !Number.isInteger(result?.code)) {
      throw new ZephyrError(`Remote outcome unknown for "${label}". Inspect the server before retrying; the command may still be running.`, {
        code: 'REMOTE_OUTCOME_UNKNOWN', data: {stepLabel: label, exitCode: result?.code ?? null}, cause: transportFailure
      })
    }
    if (logFailure) throw logFailure

    if (result.code !== 0) {
      logError?.(`Remote step "${label}" failed with exit code ${result.code}.`)
    }

    if (result.code !== 0 && !allowFailure) {
      const stderr = result.stderr?.trim() ?? ''
      const hint = /command not found|is not recognized/.test(stderr)
        ? ' Ensure the remote environment loads required tools for non-interactive shells (e.g. export PATH in profile scripts).'
        : ''
      throw new ZephyrError(`Command failed: ${command} (exit code ${result.code}).${hint}`, {
        code: 'REMOTE_COMMAND_FAILED', data: {stepLabel: label, exitCode: result.code}
      })
    }

    if (result.code === 0) logSuccess?.(label)
    return result
  }
}
