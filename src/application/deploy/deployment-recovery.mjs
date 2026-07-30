import process from 'node:process'

export async function maybeRecoverLaravelMaintenanceMode({
    remotePlan,
    executionState,
    executeRemote,
    runPrompt,
    logProcessing,
    logWarning,
    executionMode = {},
    forceAutoRecovery = false,
    reason = null
} = {}) {
    if (!remotePlan?.remoteIsLaravel || !remotePlan?.maintenanceModeEnabled) {
        return
    }

    if (!executionState?.enteredMaintenanceMode || executionState.exitedMaintenanceMode) {
        return
    }

    if (typeof executeRemote !== 'function') {
        logWarning?.('Deployment failed while Laravel maintenance mode may still be enabled.')
        return
    }

    try {
        if (forceAutoRecovery || executionMode?.interactive === false) {
            const reasonSuffix = typeof reason === 'string' && reason.length > 0
                ? ` because of ${reason}`
                : ''
            logProcessing?.(`Deployment interrupted${reasonSuffix} after Laravel maintenance mode was enabled. Running \`artisan up\` automatically...`)
            await executeRemote(
                'Disable Laravel maintenance mode',
                remotePlan.maintenanceUpCommand ?? `${remotePlan.phpCommand} artisan up`
            )
            executionState.exitedMaintenanceMode = true
            return
        }

        if (typeof runPrompt !== 'function') {
            logWarning?.('Deployment failed while Laravel maintenance mode may still be enabled.')
            return
        }

        const answers = await runPrompt([
            {
                type: 'confirm',
                name: 'disableMaintenanceMode',
                message: 'Deployment failed after Laravel maintenance mode was enabled. Run `artisan up` now?',
                default: true
            }
        ])

        if (answers?.disableMaintenanceMode !== true) {
            logWarning?.('Laravel maintenance mode remains enabled because recovery was not confirmed.')
            return
        }

        await executeRemote(
            'Disable Laravel maintenance mode',
            remotePlan.maintenanceUpCommand ?? `${remotePlan.phpCommand} artisan up`
        )
        executionState.exitedMaintenanceMode = true
    } catch (error) {
        logWarning?.(`Failed to disable Laravel maintenance mode after deployment error: ${error.message}`)
    }
}

export async function maybeRecoverFrontendArtifact({
    remotePlan,
    executionState,
    executeRemote,
    logProcessing,
    logWarning
} = {}) {
    if (!remotePlan?.usesFrontendArtifact || executionState?.frontendArtifactFinalized) {
        return
    }

    if (typeof executeRemote !== 'function') {
        logWarning?.('Deployment failed while a staged frontend artifact may remain on the server.')
        return
    }

    const wasKnownToBeActivated = executionState?.frontendArtifactActivated === true
    const command = remotePlan.frontendArtifactRollbackCommand

    if (!command) {
        return
    }

    try {
        logProcessing?.(
            wasKnownToBeActivated
                ? 'Deployment failed after frontend activation. Restoring the previous frontend artifact...'
                : 'Recovering the staged frontend artifact after deployment failure...'
        )
        await executeRemote(
            wasKnownToBeActivated ? 'Restore previous frontend artifact' : 'Recover staged frontend artifact',
            command
        )
        executionState.frontendArtifactFinalized = true
    } catch (error) {
        logWarning?.(`Failed to recover the frontend artifact after deployment error: ${error.message}`)
    }
}

function signalToExitCode(signal) {
    const signalNumbers = {
        SIGHUP: 1,
        SIGINT: 2,
        SIGTERM: 15
    }

    if (!signalNumbers[signal]) {
        return null
    }

    return 128 + signalNumbers[signal]
}

export function createAbnormalExitGuard({
    processRef = process,
    cleanup = async () => {},
    terminate = null,
    logWarning
} = {}) {
    const listeners = new Map()
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
    let active = true
    let cleanupPromise = null

    const terminateProcess = typeof terminate === 'function'
        ? terminate
        : async (signal) => {
            const exitCode = signalToExitCode(signal)

            if (typeof exitCode === 'number') {
                processRef.exitCode = exitCode
            }

            if (typeof processRef.kill === 'function' && typeof processRef.pid === 'number') {
                processRef.kill(processRef.pid, signal)
            }
        }

    const unregister = () => {
        if (!active) {
            return
        }

        active = false

        for (const [signal, handler] of listeners.entries()) {
            if (typeof processRef.off === 'function') {
                processRef.off(signal, handler)
                continue
            }

            if (typeof processRef.removeListener === 'function') {
                processRef.removeListener(signal, handler)
            }
        }

        listeners.clear()
    }

    const run = async (signal) => {
        if (!active) {
            return cleanupPromise
        }

        if (cleanupPromise) {
            return cleanupPromise
        }

        unregister()
        cleanupPromise = (async () => {
            try {
                await cleanup(signal)
            } catch (error) {
                logWarning?.(`Best-effort deploy recovery after ${signal} failed: ${error.message}`)
            } finally {
                await terminateProcess(signal)
            }
        })()

        return cleanupPromise
    }

    for (const signal of signals) {
        const handler = () => {
            void run(signal)
        }

        listeners.set(signal, handler)
        processRef.once(signal, handler)
    }

    return {
        unregister,
        run
    }
}
