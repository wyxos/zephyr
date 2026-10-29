function quoteShell(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

export function normalizeDeploymentTasks(deployment = {}) {
  if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)) {
    throw new Error('Deployment task options must be an object.')
  }
  const packageManager = deployment.packageManager ?? 'npm'
  if (!['npm', 'pnpm'].includes(packageManager)) {
    throw new Error('Deployment packageManager must be npm or pnpm.')
  }
  for (const field of ['publishShiftAssets', 'optimizeCaches', 'restartSsr']) {
    if (deployment[field] !== undefined && typeof deployment[field] !== 'boolean') {
      throw new Error(`Deployment ${field} must be a boolean.`)
    }
  }
  const healthChecks = deployment.healthChecks ?? []
  if (!Array.isArray(healthChecks) || healthChecks.some(check =>
    !check || typeof check.label !== 'string' || !check.label.trim() ||
    typeof check.command !== 'string' || !check.command.trim())) {
    throw new Error('Deployment healthChecks must contain a label and command for each check.')
  }
  return {
    packageManager,
    publishShiftAssets: deployment.publishShiftAssets === true,
    optimizeCaches: deployment.optimizeCaches === true,
    restartSsr: deployment.restartSsr === true,
    healthChecks: healthChecks.map(({label, command}) => ({label, command}))
  }
}

export function createReleasePullCommand(branch, expectedCommit = null) {
  if (expectedCommit === null) {
    return `git pull origin ${branch}`
  }
  if (typeof expectedCommit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(expectedCommit)) {
    throw new Error('Expected release commit must be a full hexadecimal Git commit hash.')
  }
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || /[\\\s]/.test(branch)) {
    throw new Error('Release branch is invalid.')
  }
  const quotedBranch = quoteShell(branch)
  return `test "$(git symbolic-ref --quiet --short HEAD)" = ${quotedBranch} && zephyr_status=$(git status --porcelain) && test -z "$zephyr_status" && git fetch origin ${quotedBranch} && test "$(git rev-parse FETCH_HEAD)" = ${expectedCommit} && git merge --ff-only ${expectedCommit} && test "$(git rev-parse HEAD)" = ${expectedCommit} || { echo "Remote branch or clean checkout does not match the verified release commit ${expectedCommit}; inspect before retrying." >&2; exit 1; }`
}
