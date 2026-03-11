import path from 'node:path'
import inquirer from 'inquirer'

export function defaultProjectPath(currentDir) {
    return `~/webapps/${path.basename(currentDir)}`
}

export async function listGitBranches({
                                          currentDir,
                                          runCommandCapture,
                                          logWarning
                                      } = {}) {
    try {
        const output = await runCommandCapture(
            'git',
            ['branch', '--format', '%(refname:short)'],
            {cwd: currentDir}
        )

        const branches = output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)

        return branches.length ? branches : ['master']
    } catch (_error) {
        logWarning?.('Unable to read git branches; defaulting to master.')
        return ['master']
    }
}

export async function promptAppDetails({
                                           currentDir,
                                           existing = {},
                                           runPrompt,
                                           listGitBranches,
                                           resolveDefaultProjectPath = defaultProjectPath,
                                           promptSshDetails
                                       } = {}) {
    const branches = await listGitBranches(currentDir)
    const defaultBranch = existing.branch || (branches.includes('master') ? 'master' : branches[0])
    const defaults = {
        projectPath: existing.projectPath || resolveDefaultProjectPath(currentDir),
        branch: defaultBranch
    }

    const answers = await runPrompt([
        {
            type: 'input',
            name: 'projectPath',
            message: 'Remote project path',
            default: defaults.projectPath
        },
        {
            type: 'list',
            name: 'branchSelection',
            message: 'Branch to deploy',
            choices: [
                ...branches.map((branch) => ({name: branch, value: branch})),
                new inquirer.Separator(),
                {name: 'Enter custom branch…', value: '__custom'}
            ],
            default: defaults.branch
        }
    ])

    let branch = answers.branchSelection

    if (branch === '__custom') {
        const {customBranch} = await runPrompt([
            {
                type: 'input',
                name: 'customBranch',
                message: 'Custom branch name',
                default: defaults.branch
            }
        ])

        branch = customBranch.trim() || defaults.branch
    }

    const sshDetails = await promptSshDetails(currentDir, existing)

    return {
        projectPath: answers.projectPath.trim() || defaults.projectPath,
        branch,
        ...sshDetails
    }
}
