function splitLines(text = '') {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function normalizeCapturedOutput(commandOutput = {}) {
  if (typeof commandOutput === 'string') {
    return {stdout: commandOutput, stderr: ''}
  }

  return {
    stdout: commandOutput?.stdout ?? '',
    stderr: commandOutput?.stderr ?? ''
  }
}

export function collectCodexDiagnosticLines(commandOutput = {}) {
  const {stdout, stderr} = normalizeCapturedOutput(commandOutput)
  const stderrLines = splitLines(stderr)
  const stdoutDiagnosticLines = splitLines(stdout)
    .filter((line) => /\b(error|warn|warning|failed|failure|rejected|declined)\b/i.test(line))

  return [...stderrLines, ...stdoutDiagnosticLines]
}

export function logCapturedCodexDiagnostics(commandOutput = {}, {
  label = 'advisor',
  logWarning
} = {}) {
  const diagnosticCount = collectCodexDiagnosticLines(commandOutput).length

  if (diagnosticCount === 0) {
    return
  }

  const noun = diagnosticCount === 1 ? 'line' : 'lines'
  logWarning?.(
    `Codex ${label} emitted ${diagnosticCount} diagnostic ${noun}; ` +
    'captured and hidden because the advisor returned a usable result.'
  )
}

export function describeCodexAdvisorFailure(error, {
  label = 'advisor'
} = {}) {
  const diagnosticCount = collectCodexDiagnosticLines(error).length
  const exitCode = error?.exitCode
  const exitText = exitCode == null ? 'failed' : `exited with code ${exitCode}`

  if (diagnosticCount > 0) {
    const noun = diagnosticCount === 1 ? 'line' : 'lines'
    return `Codex ${label} ${exitText}; captured ${diagnosticCount} diagnostic ${noun}.`
  }

  if (error?.code === 'ENOENT') {
    return `Codex ${label} failed because the codex command was not found.`
  }

  return `Codex ${label} ${exitText}.`
}
