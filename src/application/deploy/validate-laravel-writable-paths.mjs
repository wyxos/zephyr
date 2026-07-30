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

export async function validateLaravelWritablePaths({
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

    const riskyPaths = inspections.filter((inspection) => (
        inspection.exists && inspection.writable && !isGroupWritable(inspection.mode)
    ))

    for (const inspection of riskyPaths) {
        logWarning?.(
            `${inspection.path} is writable by the deploy user (${inspection.owner}:${inspection.group}, mode ${inspection.mode}), ` +
            'but it is not group-writable. Web-created cache files may cause later permission drift.'
        )
    }
}
