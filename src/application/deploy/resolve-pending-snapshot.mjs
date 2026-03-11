import {clearPendingTasksSnapshot, loadPendingTasksSnapshot} from '../../deploy/snapshots.mjs'

export async function resolvePendingSnapshot(rootDir, deploymentConfig, {
    runPrompt,
    logProcessing,
    logWarning
} = {}) {
    const existingSnapshot = await loadPendingTasksSnapshot(rootDir)

    if (!existingSnapshot) {
        return null
    }

    const matchesSelection =
        existingSnapshot.serverName === deploymentConfig.serverName &&
        existingSnapshot.branch === deploymentConfig.branch

    const messageLines = [
        'Pending deployment tasks were detected from a previous run.',
        `Server: ${existingSnapshot.serverName}`,
        `Branch: ${existingSnapshot.branch}`
    ]

    if (existingSnapshot.taskLabels && existingSnapshot.taskLabels.length > 0) {
        messageLines.push(`Tasks: ${existingSnapshot.taskLabels.join(', ')}`)
    }

    const {resumePendingTasks} = await runPrompt([
        {
            type: 'confirm',
            name: 'resumePendingTasks',
            message: `${messageLines.join(' | ')}. Resume using this plan?`,
            default: matchesSelection
        }
    ])

    if (resumePendingTasks) {
        logProcessing?.('Resuming deployment using saved task snapshot...')
        return existingSnapshot
    }

    await clearPendingTasksSnapshot(rootDir)
    logWarning?.('Discarded pending deployment snapshot.')
    return null
}
