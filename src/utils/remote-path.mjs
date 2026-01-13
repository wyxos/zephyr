export function resolveRemotePath(projectPath, remoteHome) {
  if (!projectPath) {
    return projectPath
  }

  const sanitizedHome = remoteHome.replace(/\/+$/, '')

  if (projectPath === '~') {
    return sanitizedHome
  }

  if (projectPath.startsWith('~/')) {
    const remainder = projectPath.slice(2)
    return remainder ? `${sanitizedHome}/${remainder}` : sanitizedHome
  }

  if (projectPath.startsWith('/')) {
    return projectPath
  }

  return `${sanitizedHome}/${projectPath}`
}

