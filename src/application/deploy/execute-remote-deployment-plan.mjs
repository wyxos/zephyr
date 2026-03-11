import {clearPendingTasksSnapshot, savePendingTasksSnapshot} from '../../deploy/snapshots.mjs'
import {PENDING_TASKS_FILE} from '../../utils/paths.mjs'

async function persistPendingSnapshot(rootDir, pendingSnapshot, executeRemote) {
    await savePendingTasksSnapshot(rootDir, pendingSnapshot)

    const payload = Buffer.from(JSON.stringify(pendingSnapshot)).toString('base64')
    await executeRemote(
        'Record pending deployment tasks',
        `mkdir -p .zephyr && echo '${payload}' | base64 --decode > .zephyr/${PENDING_TASKS_FILE}`,
        {printStdout: false}
    )
}

function logScheduledTasks(steps, {logProcessing} = {}) {
    if (steps.length === 1) {
        logProcessing?.('No additional maintenance tasks scheduled beyond git pull.')
        return
    }

    const extraTasks = steps
        .slice(1)
        .map((step) => step.label)
        .join(', ')

    logProcessing?.(`Additional tasks scheduled: ${extraTasks}`)
}

export async function executeRemoteDeploymentPlan({
                                                      rootDir,
                                                      executeRemote,
                                                      steps,
                                                      usefulSteps,
                                                      pendingSnapshot = null,
                                                      logProcessing
                                                  } = {}) {
    if (usefulSteps && pendingSnapshot) {
        await persistPendingSnapshot(rootDir, pendingSnapshot, executeRemote)
    }

    logScheduledTasks(steps, {logProcessing})

    let completed = false

    try {
        for (const step of steps) {
            await executeRemote(step.label, step.command)
        }

        completed = true
    } finally {
        if (usefulSteps && completed) {
            await executeRemote(
                'Clear pending deployment snapshot',
                `rm -f .zephyr/${PENDING_TASKS_FILE}`,
                {printStdout: false, allowFailure: true}
            )
            await clearPendingTasksSnapshot(rootDir)
        }
    }
}
