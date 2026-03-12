import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {execFile as execFileCallback} from 'node:child_process'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'

const execFile = promisify(execFileCallback)

const {
    mockWriteStderrLine,
    mockWriteStdoutLine,
    mockRunDeployment,
    mockValidateLocalDependencies
} = vi.hoisted(() => ({
    mockWriteStderrLine: vi.fn(),
    mockWriteStdoutLine: vi.fn(),
    mockRunDeployment: vi.fn(),
    mockValidateLocalDependencies: vi.fn()
}))

vi.mock('#src/application/deploy/run-deployment.mjs', () => ({
    runDeployment: mockRunDeployment
}))

vi.mock('#src/dependency-scanner.mjs', () => ({
    validateLocalDependencies: mockValidateLocalDependencies
}))

vi.mock('#src/runtime/app-context.mjs', () => ({
    createAppContext: () => globalThis.__zephyrSmokeContext
}))

vi.mock('#src/utils/output.mjs', async (importOriginal) => {
    const actual = await importOriginal()

    return {
        ...actual,
        writeStdoutLine: mockWriteStdoutLine,
        writeStderrLine: mockWriteStderrLine
    }
})

async function exec(command, args, {cwd} = {}) {
    const result = await execFile(command, args, {cwd})
    return {
        stdout: result.stdout?.trim() ?? '',
        stderr: result.stderr?.trim() ?? ''
    }
}

async function git(args, cwd) {
    return await exec('git', args, {cwd})
}

async function runCommand(command, args, {cwd} = {}) {
    await execFile(command, args, {cwd})
}

async function runCommandCapture(command, args, {cwd} = {}) {
    const {stdout} = await exec(command, args, {cwd})
    return stdout
}

async function configureRepo(repoDir) {
    await git(['config', 'user.name', 'Zephyr Smoke'], repoDir)
    await git(['config', 'user.email', 'zephyr-smoke@example.test'], repoDir)
}

describe('main smoke', () => {
    const originalCwd = process.cwd()
    const originalHome = process.env.HOME

    let tempRoot
    let homeDir
    let projectDir
    let promptQueue
    let smokeContext

    beforeEach(async () => {
        vi.resetModules()
        mockRunDeployment.mockReset()
        mockValidateLocalDependencies.mockReset()
        mockWriteStderrLine.mockReset()
        mockWriteStdoutLine.mockReset()
        mockRunDeployment.mockResolvedValue(undefined)
        mockValidateLocalDependencies.mockResolvedValue(undefined)

        tempRoot = await mkdtemp(path.join(os.tmpdir(), 'zephyr-main-smoke-'))
        homeDir = path.join(tempRoot, 'home')
        projectDir = path.join(tempRoot, 'project')

        await mkdir(path.join(homeDir, '.ssh'), {recursive: true})
        await writeFile(
            path.join(homeDir, '.ssh', 'id_smoke'),
            '-----BEGIN OPENSSH PRIVATE KEY-----\nsmoke\n-----END OPENSSH PRIVATE KEY-----\n'
        )

        await mkdir(projectDir, {recursive: true})
        await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
            name: '@wyxos/smoke-app',
            version: '1.0.0'
        }, null, 2) + '\n')

        await git(['init', '-b', 'main'], projectDir)
        await configureRepo(projectDir)
        await git(['add', 'package.json'], projectDir)
        await git(['commit', '-m', 'Initial commit'], projectDir)

        process.env.HOME = homeDir
        process.chdir(projectDir)

        promptQueue = [
            {installReleaseScript: true},
            {serverName: 'production', serverIp: '203.0.113.10'},
            {projectPath: '~/webapps/smoke-app', branchSelection: 'main'},
            {sshUser: 'forge', sshKeySelection: path.join(homeDir, '.ssh', 'id_smoke')},
            {presetName: ''}
        ]

        smokeContext = {
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            logError: vi.fn(),
            runPrompt: vi.fn(async (_questions) => {
                if (promptQueue.length === 0) {
                    throw new Error('No prompt response queued for smoke test.')
                }

                return promptQueue.shift()
            }),
            createSshClient: vi.fn(),
            runCommand,
            runCommandCapture
        }

        globalThis.__zephyrSmokeContext = smokeContext
    })

    afterEach(async () => {
        delete globalThis.__zephyrSmokeContext
        process.chdir(originalCwd)

        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }

        await rm(tempRoot, {recursive: true, force: true})
    })

    it('bootstraps a temp project and reaches the deployment action with real configuration flow', async () => {
        const {main} = await import('#src/main.mjs')

        await main()

        const effectiveProjectDir = process.cwd()

        expect(mockValidateLocalDependencies).toHaveBeenCalledWith(
            effectiveProjectDir,
            smokeContext.runPrompt,
            smokeContext.logSuccess
        )
        expect(mockRunDeployment).toHaveBeenCalledWith({
            serverName: 'production',
            serverIp: '203.0.113.10',
            projectPath: '~/webapps/smoke-app',
            branch: 'main',
            sshUser: 'forge',
            sshKey: path.join(homeDir, '.ssh', 'id_smoke')
        }, {
            rootDir: effectiveProjectDir,
            snapshot: null,
            versionArg: null,
            context: smokeContext
        })

        const packageJson = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'))
        const gitignore = await readFile(path.join(projectDir, '.gitignore'), 'utf8')
        const projectConfig = JSON.parse(await readFile(path.join(projectDir, '.zephyr', 'config.json'), 'utf8'))
        const servers = JSON.parse(await readFile(path.join(homeDir, '.config', 'zephyr', 'servers.json'), 'utf8'))
        const {stdout: currentMessage} = await git(['log', '-1', '--pretty=%s'], projectDir)

        expect(packageJson.scripts.release).toBe('npx @wyxos/zephyr@latest')
        expect(gitignore).toContain('.zephyr/')
        expect(projectConfig.apps).toHaveLength(1)
        expect(projectConfig.presets).toEqual([])
        expect(servers).toHaveLength(1)
        expect(currentMessage).toBe('chore: add zephyr release script')
        expect(smokeContext.runPrompt).toHaveBeenCalledTimes(5)
    }, 30000)
})
