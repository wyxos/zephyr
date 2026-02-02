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

export function createRemoteExecutor({ ssh, rootDir, remoteCwd, writeToLogFile, logProcessing, logSuccess, logError }) {
  const profileBootstrap = createProfileBootstrap()

  return async function executeRemote(label, command, options = {}) {
    const {
      cwd = remoteCwd,
      allowFailure = false,
      bootstrapEnv = true,
      env = {}
      // printStdout: legacy option, intentionally ignored (we log to file)
    } = options

    logProcessing?.(`\n→ ${label}`)

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

    const result = await ssh.execCommand(wrappedCommand, execOptions)

    if (result.stdout && result.stdout.trim()) {
      await writeToLogFile(rootDir, `[${label}] STDOUT:\n${result.stdout.trim()}`)
    }

    if (result.stderr && result.stderr.trim()) {
      await writeToLogFile(rootDir, `[${label}] STDERR:\n${result.stderr.trim()}`)
    }

    if (result.code !== 0) {
      if (result.stdout && result.stdout.trim()) {
        logError?.(`\n[${label}] Output:\n${result.stdout.trim()}`)
      }

      if (result.stderr && result.stderr.trim()) {
        logError?.(`\n[${label}] Error:\n${result.stderr.trim()}`)
      }
    }

    if (result.code !== 0 && !allowFailure) {
      const stderr = result.stderr?.trim() ?? ''
      if (/command not found/.test(stderr) || /is not recognized/.test(stderr)) {
        throw new Error(
          `Command failed: ${command}. Ensure the remote environment loads required tools for non-interactive shells (e.g. export PATH in profile scripts).`
        )
      }

      throw new Error(`Command failed: ${command}`)
    }

    if (result.code === 0) {
      logSuccess?.(`✓ ${label}`)
    }

    return result
  }
}

