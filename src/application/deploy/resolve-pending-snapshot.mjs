import {clearPendingTasksSnapshot, loadPendingTasksSnapshot} from '../../deploy/snapshots.mjs'
import {ZephyrError} from '../../runtime/errors.mjs'

export async function resolvePendingSnapshot(rootDir, deploymentConfig, {
    runPrompt,
    logProcessing,
    logWarning,
    executionMode = {}
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

    if (executionMode?.interactive === false) {
        if (!executionMode.resumePending && !executionMode.discardPending) {
            throw new ZephyrError(
                'Zephyr found a pending deployment snapshot, but non-interactive mode requires either --resume-pending or --discard-pending.',
                {code: 'ZEPHYR_PENDING_SNAPSHOT_ACTION_REQUIRED'}
            )
        }

        if (executionMode.resumePending) {
            logProcessing?.('Resuming deployment using saved task snapshot...')
            return existingSnapshot
        }

        await clearPendingTasksSnapshot(rootDir)
        logWarning?.('Discarded pending deployment snapshot.')
        return null
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
