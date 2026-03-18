export const SKIP_GIT_HOOKS_WARNING =
    'WARNING: --skip-git-hooks is enabled. Zephyr will bypass local git hooks for any commits and pushes it performs during this run.'

export function gitCommitArgs(args = [], {skipGitHooks = false} = {}) {
    return skipGitHooks
        ? ['commit', '--no-verify', ...args]
        : ['commit', ...args]
}

export function gitPushArgs(args = [], {skipGitHooks = false} = {}) {
    return skipGitHooks
        ? ['push', '--no-verify', ...args]
        : ['push', ...args]
}

export function npmVersionArgs(releaseType, {
    skipGitHooks = false,
    extraArgs = []
} = {}) {
    return [
        'version',
        releaseType,
        ...(skipGitHooks ? ['--no-commit-hooks'] : []),
        ...extraArgs
    ]
}
