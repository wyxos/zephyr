import {findPhpBinary} from '../../infrastructure/php/version.mjs'
import {ZephyrError} from '../../runtime/errors.mjs'
import {planLaravelDeploymentTasks} from './plan-laravel-deployment-tasks.mjs'

const PRERENDERED_MAINTENANCE_VIEW = 'errors::503'
const PRERENDERED_MAINTENANCE_FILE = 'resources/views/errors/503.blade.php'
const LARAVEL_WRITABLE_PATHS = [
    'bootstrap/cache',
    'storage/framework/cache',
    'storage/framework/views',
    'storage/framework/sessions'
]

function escapeForSingleQuotes(value) {
    return value.replace(/'/g, "'\\''")
}

function isGroupWritable(mode) {
    if (typeof mode !== 'string' || mode.length < 2) {
        return false
    }

    const groupDigit = mode.at(-2)
    const parsed = Number.parseInt(groupDigit, 8)
    return Number.isInteger(parsed) && (parsed & 2) === 2
}

function shouldInspectLaravelWritablePaths(steps = []) {
    return steps.some((step) => step.label === 'Clear Laravel caches')
}

async function inspectLaravelWritablePath(ssh, remoteCwd, relativePath) {
    const escapedPath = escapeForSingleQuotes(relativePath)
    const command = [
        `if [ ! -e '${escapedPath}' ]; then`,
        '  printf "__MISSING__";',
        'else',
        `  WRITABLE="no"; [ -w '${escapedPath}' ] && WRITABLE="yes";`,
        `  OWNER=$(stat -c '%U' '${escapedPath}' 2>/dev/null || printf '?');`,
        `  GROUP=$(stat -c '%G' '${escapedPath}' 2>/dev/null || printf '?');`,
        `  MODE=$(stat -c '%a' '${escapedPath}' 2>/dev/null || printf '?');`,
        '  printf "%s|%s|%s|%s" "$WRITABLE" "$OWNER" "$GROUP" "$MODE";',
        'fi'
    ].join(' ')

    const result = await ssh.execCommand(command, {cwd: remoteCwd})
    const output = result.stdout.trim()

    if (output === '__MISSING__') {
        return {
            path: relativePath,
            exists: false,
            writable: false,
            owner: null,
            group: null,
            mode: null
        }
    }

    const [writableFlag, owner = '?', group = '?', mode = '?'] = output.split('|')

    return {
        path: relativePath,
        exists: true,
        writable: writableFlag === 'yes',
        owner,
        group,
        mode
    }
}

async function validateLaravelWritablePaths({
                                               ssh,
                                               remoteCwd,
                                               sshUser,
                                               steps,
                                               logProcessing,
                                               logWarning
                                           } = {}) {
    if (!shouldInspectLaravelWritablePaths(steps)) {
        return
    }

    logProcessing?.(`Checking Laravel writable directories for deploy user ${sshUser || 'current SSH user'}...`)

    const inspections = []
    for (const relativePath of LARAVEL_WRITABLE_PATHS) {
        inspections.push(await inspectLaravelWritablePath(ssh, remoteCwd, relativePath))
    }

    const blockedPaths = inspections.filter((inspection) => inspection.exists && !inspection.writable)
    if (blockedPaths.length > 0) {
        const details = blockedPaths
            .map((inspection) => ` - ${inspection.path} (owner ${inspection.owner}:${inspection.group}, mode ${inspection.mode})`)
            .join('\n')

        throw new Error(
            'Laravel cache-related deployment tasks cannot run because the SSH deploy user cannot write to required directories:\n' +
            `${details}\n` +
            'Fix permissions before releasing. Typical fix:\n' +
            'sudo chown -R $USER:www-data bootstrap/cache storage/framework/cache storage/framework/views storage/framework/sessions\n' +
            'sudo chmod -R ug+rwX bootstrap/cache storage/framework/cache storage/framework/views storage/framework/sessions'
        )
    }

    const riskyPaths = inspections.filter((inspection) => inspection.exists && inspection.writable && !isGroupWritable(inspection.mode))
    for (const inspection of riskyPaths) {
        logWarning?.(
            `${inspection.path} is writable by the deploy user (${inspection.owner}:${inspection.group}, mode ${inspection.mode}), ` +
            'but it is not group-writable. Web-created cache files may cause later permission drift.'
        )
    }
}

async function detectRemoteLaravelProject(ssh, remoteCwd) {
    const laravelCheck = await ssh.execCommand(
        'if [ -f artisan ] && [ -f composer.json ] && grep -q "laravel/framework" composer.json; then echo "yes"; else echo "no"; fi',
        {cwd: remoteCwd}
    )

    return laravelCheck.stdout.trim() === 'yes'
}

async function collectChangedFiles({
                                       config,
                                       snapshot,
                                       remoteIsLaravel,
                                       executeRemote,
                                       logProcessing
                                   } = {}) {
    if (snapshot?.changedFiles) {
        logProcessing?.('Resuming deployment with saved task snapshot.')
        return snapshot.changedFiles
    }

    if (!remoteIsLaravel) {
        return []
    }

    await executeRemote(`Fetch latest changes for ${config.branch}`, `git fetch origin ${config.branch}`)

    const diffResult = await executeRemote(
        'Inspect pending changes',
        `git diff --name-only HEAD..origin/${config.branch}`,
        {printStdout: false}
    )

    const changedFiles = diffResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    if (changedFiles.length > 0) {
        const preview = changedFiles
            .slice(0, 20)
            .map((file) => ` - ${file}`)
            .join('\n')

        logProcessing?.(
            `Detected ${changedFiles.length} changed file(s):\n${preview}${changedFiles.length > 20 ? '\n - ...' : ''}`
        )
    } else {
        logProcessing?.('No upstream file changes detected.')
    }

    return changedFiles
}

async function detectHorizonConfiguration({
                                              ssh,
                                              remoteCwd,
                                              remoteIsLaravel,
                                              changedFiles
                                          } = {}) {
    const hasPhpChanges = remoteIsLaravel && changedFiles.some((file) => file.endsWith('.php'))

    if (!hasPhpChanges) {
        return false
    }

    const horizonCheck = await ssh.execCommand(
        'if [ -f config/horizon.php ]; then echo "yes"; else echo "no"; fi',
        {cwd: remoteCwd}
    )

    return horizonCheck.stdout.trim() === 'yes'
}

async function resolvePhpCommand({
                                     requiredPhpVersion,
                                     ssh,
                                     remoteCwd,
                                     logProcessing,
                                     logWarning
                                 } = {}) {
    if (!requiredPhpVersion) {
        return 'php'
    }

    try {
        const phpCommand = await findPhpBinary(ssh, remoteCwd, requiredPhpVersion)
        if (phpCommand !== 'php') {
            logProcessing?.(`Detected PHP requirement: ${requiredPhpVersion}, using ${phpCommand}`)
        }

        return phpCommand
    } catch (error) {
        logWarning?.(`Could not find PHP binary for version ${requiredPhpVersion}: ${error.message}`)
        return 'php'
    }
}

function createMaintenanceModePlan({
                                       enabled,
                                       phpCommand,
                                       usesPrerender = false,
                                       renderView = null
                                   } = {}) {
    const maintenanceUpCommand = `${phpCommand} artisan up`

    if (!enabled) {
        return {
            enabled: false,
            usesPrerender: false,
            renderView: null,
            downCommand: null,
            upCommand: maintenanceUpCommand
        }
    }

    return {
        enabled: true,
        usesPrerender,
        renderView: usesPrerender ? renderView : null,
        downCommand: usesPrerender && renderView
            ? `${phpCommand} artisan down --render="${renderView}"`
            : `${phpCommand} artisan down`,
        upCommand: maintenanceUpCommand
    }
}

async function resolveMaintenanceMode({
                                         snapshot,
                                         remoteIsLaravel,
                                         runPrompt,
                                         executionMode = {}
                                     } = {}) {
    if (!remoteIsLaravel) {
        return false
    }

    if (typeof snapshot?.maintenanceModeEnabled === 'boolean') {
        return snapshot.maintenanceModeEnabled
    }

    if (executionMode?.interactive === false) {
        if (typeof executionMode.maintenanceMode !== 'boolean') {
            throw new ZephyrError(
                'Zephyr cannot run this Laravel deployment non-interactively without an explicit maintenance-mode decision. Pass --maintenance on or --maintenance off.',
                {code: 'ZEPHYR_MAINTENANCE_FLAG_REQUIRED'}
            )
        }

        return executionMode.maintenanceMode
    }

    if (typeof runPrompt !== 'function') {
        return false
    }

    const answers = await runPrompt([
        {
            type: 'confirm',
            name: 'enableMaintenanceMode',
            message: 'Enable Laravel maintenance mode for this deployment? (`artisan down` before deploy, `artisan up` after)',
            default: false
        }
    ])

    return Boolean(answers?.enableMaintenanceMode)
}

async function resolveMaintenanceModePlan({
                                             snapshot,
                                             remoteIsLaravel,
                                             remoteCwd,
                                             maintenanceModeEnabled,
                                             phpCommand,
                                             ssh,
                                             executeRemote,
                                             logProcessing,
                                             logWarning
                                         } = {}) {
    if (!remoteIsLaravel || !maintenanceModeEnabled) {
        return createMaintenanceModePlan({enabled: false, phpCommand})
    }

    if (typeof snapshot?.maintenanceModeUsesPrerender === 'boolean') {
        return createMaintenanceModePlan({
            enabled: true,
            phpCommand,
            usesPrerender: snapshot.maintenanceModeUsesPrerender,
            renderView: snapshot.maintenanceModeRenderView ?? PRERENDERED_MAINTENANCE_VIEW
        })
    }

    const capabilityResult = await executeRemote(
        'Inspect Laravel maintenance mode capabilities',
        `${phpCommand} artisan down --help`,
        {printStdout: false, allowFailure: true}
    )
    const helpOutput = `${capabilityResult.stdout ?? ''}\n${capabilityResult.stderr ?? ''}`
    const supportsPrerender = capabilityResult.code === 0 && /(^|\s)--render(?:\[|[=\s]|$)/m.test(helpOutput)

    if (!supportsPrerender) {
        logProcessing?.('Prerendered Laravel maintenance mode is unavailable on the remote app; using standard maintenance mode.')
        return createMaintenanceModePlan({enabled: true, phpCommand})
    }

    const maintenanceViewCheck = await ssh.execCommand(
        `if [ -f ${PRERENDERED_MAINTENANCE_FILE} ]; then echo "yes"; else echo "no"; fi`,
        {cwd: remoteCwd}
    )

    if (maintenanceViewCheck.stdout.trim() !== 'yes') {
        logWarning?.(
            `Laravel supports prerendered maintenance mode, but ${PRERENDERED_MAINTENANCE_FILE} is missing; using standard maintenance mode.`
        )
        return createMaintenanceModePlan({enabled: true, phpCommand})
    }

    logProcessing?.(`Using prerendered Laravel maintenance response (${PRERENDERED_MAINTENANCE_VIEW}).`)
    return createMaintenanceModePlan({
        enabled: true,
        phpCommand,
        usesPrerender: true,
        renderView: PRERENDERED_MAINTENANCE_VIEW
    })
}

export async function resolveRemoteDeploymentState({
                                                       snapshot,
                                                       executionMode = {},
                                                       ssh,
                                                       remoteCwd,
                                                       runPrompt,
                                                       logSuccess,
                                                       logWarning
                                                   } = {}) {
    const remoteIsLaravel = await detectRemoteLaravelProject(ssh, remoteCwd)

    if (remoteIsLaravel) {
        logSuccess?.('Laravel project detected.')
    } else {
        logWarning?.('Laravel project not detected; skipping Laravel-specific maintenance tasks.')
    }

    const maintenanceModeEnabled = await resolveMaintenanceMode({
        snapshot,
        remoteIsLaravel,
        runPrompt,
        executionMode
    })

    return {
        remoteIsLaravel,
        maintenanceModeEnabled
    }
}

export async function buildRemoteDeploymentPlan({
                                                    config,
                                                    snapshot = null,
                                                    requiredPhpVersion = null,
                                                    executionMode = {},
                                                    remoteIsLaravel = null,
                                                    maintenanceModeEnabled = null,
                                                    ssh,
                                                    remoteCwd,
                                                    executeRemote,
                                                    logProcessing,
                                                    logSuccess,
                                                    logWarning,
                                                    runPrompt
                                                } = {}) {
    const remoteState = typeof remoteIsLaravel === 'boolean' &&
    (remoteIsLaravel === false || typeof maintenanceModeEnabled === 'boolean')
        ? {
            remoteIsLaravel,
            maintenanceModeEnabled: remoteIsLaravel ? maintenanceModeEnabled : false
        }
        : await resolveRemoteDeploymentState({
            snapshot,
            executionMode,
            ssh,
            remoteCwd,
            runPrompt,
            logSuccess,
            logWarning
        })

    const changedFiles = await collectChangedFiles({
        config,
        snapshot,
        remoteIsLaravel: remoteState.remoteIsLaravel,
        executeRemote,
        logProcessing
    })

    const horizonConfigured = await detectHorizonConfiguration({
        ssh,
        remoteCwd,
        remoteIsLaravel: remoteState.remoteIsLaravel,
        changedFiles
    })

    const phpCommand = await resolvePhpCommand({
        requiredPhpVersion,
        ssh,
        remoteCwd,
        logProcessing,
        logWarning
    })

    const maintenanceModePlan = await resolveMaintenanceModePlan({
        snapshot,
        remoteIsLaravel: remoteState.remoteIsLaravel,
        remoteCwd,
        maintenanceModeEnabled: remoteState.maintenanceModeEnabled,
        phpCommand,
        ssh,
        executeRemote,
        logProcessing,
        logWarning
    })

    const steps = planLaravelDeploymentTasks({
        branch: config.branch,
        isLaravel: remoteState.remoteIsLaravel,
        changedFiles,
        horizonConfigured,
        phpCommand,
        maintenanceMode: maintenanceModePlan.enabled,
        maintenanceDownCommand: maintenanceModePlan.downCommand,
        maintenanceUpCommand: maintenanceModePlan.upCommand
    })

    await validateLaravelWritablePaths({
        ssh,
        remoteCwd,
        sshUser: config.sshUser,
        steps,
        logProcessing,
        logWarning
    })

    const usefulSteps = steps.length > 1
    const pendingSnapshot = !usefulSteps
        ? null
        : snapshot ?? {
        serverName: config.serverName,
        branch: config.branch,
        projectPath: config.projectPath,
        sshUser: config.sshUser,
        createdAt: new Date().toISOString(),
        maintenanceModeEnabled: maintenanceModePlan.enabled,
        maintenanceModeUsesPrerender: maintenanceModePlan.usesPrerender,
        maintenanceModeRenderView: maintenanceModePlan.renderView,
        changedFiles,
        taskLabels: steps.map((step) => step.label)
    }

    return {
        remoteIsLaravel: remoteState.remoteIsLaravel,
        changedFiles,
        horizonConfigured,
        phpCommand,
        maintenanceModeEnabled: maintenanceModePlan.enabled,
        maintenanceModeUsesPrerender: maintenanceModePlan.usesPrerender,
        maintenanceModeRenderView: maintenanceModePlan.renderView,
        maintenanceDownCommand: maintenanceModePlan.downCommand,
        maintenanceUpCommand: maintenanceModePlan.upCommand,
        steps,
        usefulSteps,
        pendingSnapshot
    }
}
