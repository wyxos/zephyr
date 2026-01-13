export function createLocalCommandRunners({ runCommandBase, runCommandCaptureBase }) {
  if (!runCommandBase || !runCommandCaptureBase) {
    throw new Error('createLocalCommandRunners requires runCommandBase and runCommandCaptureBase')
  }

  const runCommand = async (command, args, { silent = false, cwd } = {}) => {
    const stdio = silent ? 'ignore' : 'inherit'
    return runCommandBase(command, args, { cwd, stdio })
  }

  const runCommandCapture = async (command, args, { cwd } = {}) => {
    const { stdout } = await runCommandCaptureBase(command, args, { cwd })
    return stdout
  }

  return { runCommand, runCommandCapture }
}

