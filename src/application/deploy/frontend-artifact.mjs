import {createHash, randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as preflight from '../../deploy/preflight.mjs'
import {commandExists, formatCommandError} from '../../utils/command.mjs'

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`
}

async function hashFile(filePath) {
    const hash = createHash('sha256')

    await new Promise((resolve, reject) => {
        const stream = createReadStream(filePath)
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('error', reject)
        stream.on('end', resolve)
    })

    return hash.digest('hex')
}

function normalizeCapturedOutput(result) {
    return typeof result === 'string'
        ? result.trim()
        : String(result?.stdout ?? '').trim()
}

function createChecksumCommand(remoteArchivePath, checksum) {
    const archive = shellQuote(remoteArchivePath)

    return [
        'if command -v sha256sum >/dev/null 2>&1; then',
        `  actual_checksum=$(sha256sum ${archive} | awk '{print $1}');`,
        'elif command -v shasum >/dev/null 2>&1; then',
        `  actual_checksum=$(shasum -a 256 ${archive} | awk '{print $1}');`,
        'else',
        '  echo "No SHA-256 command is available on the deployment target." >&2;',
        '  exit 1;',
        'fi;',
        `if [ "$actual_checksum" != ${shellQuote(checksum)} ]; then`,
        '  echo "Uploaded frontend artifact checksum does not match the local artifact." >&2;',
        '  exit 1;',
        'fi'
    ].join(' ')
}

export function createFrontendArtifactRemotePlan(artifact) {
    const requiredFields = [
        'checksum',
        'commit',
        'remoteArchivePath',
        'remoteStagingPath',
        'remoteBackupPath',
        'remoteFailedPath',
        'remoteMarkerPath'
    ]

    if (
        !artifact ||
        requiredFields.some((field) => (
            typeof artifact[field] !== 'string' || artifact[field].trim().length === 0
        )) ||
        !/^[0-9a-f]{40}$/i.test(artifact.commit) ||
        !/^[0-9a-f]{64}$/i.test(artifact.checksum)
    ) {
        throw new Error('Invalid frontend artifact metadata.')
    }

    const archive = shellQuote(artifact.remoteArchivePath)
    const staging = shellQuote(artifact.remoteStagingPath)
    const backup = shellQuote(artifact.remoteBackupPath)
    const failed = shellQuote(artifact.remoteFailedPath)
    const marker = shellQuote(artifact.remoteMarkerPath)
    const finalizingMarker = shellQuote(`${artifact.remoteMarkerPath}.finalizing`)
    const commit = shellQuote(artifact.commit)
    const checksumCommand = createChecksumCommand(artifact.remoteArchivePath, artifact.checksum)

    const activationCommand = [
        'set -eu;',
        `if [ "$(git rev-parse HEAD)" != ${commit} ]; then`,
        '  echo "Remote HEAD does not match the frontend artifact commit." >&2;',
        '  exit 1;',
        'fi;',
        `${checksumCommand};`,
        `rm -rf ${staging} ${failed};`,
        `rm -f ${marker} ${finalizingMarker};`,
        `mkdir -p ${staging};`,
        `tar -xzf ${archive} -C ${staging};`,
        `if [ ! -f ${staging}/public/build/manifest.json ]; then`,
        '  echo "Frontend artifact does not contain public/build/manifest.json." >&2;',
        `  rm -rf ${staging};`,
        '  exit 1;',
        'fi;',
        `find ${staging}/public/build -type d -exec chmod 755 {} +;`,
        `find ${staging}/public/build -type f -exec chmod 644 {} +;`,
        `rm -rf ${backup};`,
        'if [ -e public/build ] || [ -L public/build ]; then',
        `  printf "previous" > ${marker};`,
        `  mv public/build ${backup};`,
        'else',
        `  printf "none" > ${marker};`,
        'fi;',
        `if mv ${staging}/public/build public/build; then`,
        `  rm -rf ${staging};`,
        'else',
        `  artifact_previous_state=$(cat ${marker});`,
        `  rm -f ${marker};`,
        '  rm -rf public/build;',
        `  if [ "$artifact_previous_state" = "previous" ] && { [ -e ${backup} ] || [ -L ${backup} ]; }; then`,
        `    mv ${backup} public/build;`,
        '  fi;',
        `  rm -rf ${staging};`,
        '  exit 1;',
        'fi'
    ].join(' ')

    return {
        activationCommand,
        finalizeCommand: [
            `printf "finalizing" > ${finalizingMarker};`,
            `mv ${finalizingMarker} ${marker};`,
            `rm -rf ${backup} ${staging} ${failed};`,
            `rm -f ${archive} ${marker} ${finalizingMarker}`
        ].join(' '),
        rollbackCommand: [
            'set -eu;',
            `rm -rf ${failed};`,
            `if [ -e ${marker} ]; then`,
            `  artifact_previous_state=$(cat ${marker});`,
            `  if [ "$artifact_previous_state" = "previous" ]; then`,
            `    if [ -e ${backup} ] || [ -L ${backup} ]; then`,
            `      if [ -e public/build ] || [ -L public/build ]; then mv public/build ${failed}; fi;`,
            `      mv ${backup} public/build;`,
            `      rm -rf ${failed};`,
            '    fi;',
            `  elif [ "$artifact_previous_state" = "none" ]; then`,
            '    rm -rf public/build;',
            `  elif [ "$artifact_previous_state" = "finalizing" ]; then`,
            `    rm -rf ${backup};`,
            '  else',
            '    echo "Frontend artifact recovery marker is invalid." >&2;',
            '    exit 1;',
            '  fi;',
            'fi;',
            `rm -rf ${staging};`,
            `rm -f ${archive} ${marker} ${finalizingMarker}`
        ].join(' '),
        verifyCommand: checksumCommand
    }
}

export async function prepareLocalFrontendArtifact({
    rootDir,
    runCommand,
    runCommandCapture,
    logProcessing,
    logSuccess
} = {}) {
    const buildCommand = await preflight.resolveSupportedBuildCommand(rootDir, {commandExists})

    if (!buildCommand) {
        throw new Error(
            'Local-artifact deployment requires a supported `npm run build` command.'
        )
    }

    try {
        await preflight.runBuild(rootDir, {
            runCommand,
            logProcessing,
            logSuccess,
            commandExists,
            buildCommand
        })
    } catch (error) {
        throw new Error(
            `Failed to build the local frontend artifact.\n${formatCommandError(error)}`
        )
    }

    const manifestPath = path.join(rootDir, 'public', 'build', 'manifest.json')
    const manifestStats = await fs.stat(manifestPath).catch(() => null)

    if (!manifestStats?.isFile()) {
        throw new Error(
            'Local frontend build did not produce public/build/manifest.json.'
        )
    }

    const commit = normalizeCapturedOutput(
        await runCommandCapture('git', ['rev-parse', 'HEAD'], {cwd: rootDir})
    )

    if (!/^[0-9a-f]{40}$/i.test(commit)) {
        throw new Error('Unable to bind the local frontend artifact to an exact Git commit.')
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zephyr-frontend-'))
    const archivePath = path.join(tempDir, 'public-build.tar.gz')

    try {
        await runCommand('tar', ['-czf', archivePath, '-C', rootDir, 'public/build'], {
            cwd: rootDir,
            capture: true
        })

        const checksum = await hashFile(archivePath)
        const artifactId = `${commit}-${randomUUID()}`
        const remoteBasePath = `.zephyr/artifacts/${artifactId}`

        logSuccess?.(`Prepared frontend artifact for commit ${commit.slice(0, 12)}.`)

        return {
            archivePath,
            checksum,
            commit,
            remoteArchivePath: `${remoteBasePath}.tar.gz`,
            remoteStagingPath: `${remoteBasePath}.staging`,
            remoteBackupPath: `${remoteBasePath}.previous`,
            remoteFailedPath: `${remoteBasePath}.failed`,
            remoteMarkerPath: `${remoteBasePath}.activated`,
            async cleanupLocal() {
                await fs.rm(tempDir, {recursive: true, force: true})
            }
        }
    } catch (error) {
        await fs.rm(tempDir, {recursive: true, force: true})
        throw error
    }
}

export async function uploadFrontendArtifact({
    artifact,
    ssh,
    remoteCwd,
    executeRemote,
    logProcessing,
    logSuccess
} = {}) {
    const remoteArchivePath = `${remoteCwd.replace(/\/+$/, '')}/${artifact.remoteArchivePath}`
    const remotePlan = createFrontendArtifactRemotePlan(artifact)

    await executeRemote(
        'Prepare frontend artifact upload',
        `mkdir -p .zephyr/artifacts && rm -f ${shellQuote(artifact.remoteArchivePath)}`,
        {printStdout: false}
    )

    logProcessing?.('Uploading validated local frontend artifact...')
    await ssh.putFile(artifact.archivePath, remoteArchivePath)
    logSuccess?.('Uploaded local frontend artifact.')

    await executeRemote(
        'Verify uploaded frontend artifact',
        remotePlan.verifyCommand,
        {printStdout: false}
    )
}
