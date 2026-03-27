import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {execFile as execFileCallback} from 'node:child_process'
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'

const execFile = promisify(execFileCallback)

async function run(command, args, {cwd} = {}) {
    const result = await execFile(command, args, {cwd})
    return {
        stdout: result.stdout?.trim() ?? '',
        stderr: result.stderr?.trim() ?? ''
    }
}

async function git(args, cwd) {
    return await run('git', args, {cwd})
}

async function runCommand(command, args, {cwd} = {}) {
    await execFile(command, args, {cwd})
}

async function runCommandCapture(command, args, {cwd} = {}) {
    const {stdout} = await run(command, args, {cwd})
    return stdout
}

async function configureRepo(repoDir) {
    await git(['config', 'user.name', 'Zephyr Test'], repoDir)
    await git(['config', 'user.email', 'zephyr@example.test'], repoDir)
}

async function commitFile(repoDir, fileName, content, message) {
    await writeFile(join(repoDir, fileName), content)
    await git(['add', fileName], repoDir)
    await git(['commit', '-m', message], repoDir)
}

async function cloneRepo(remoteDir, cloneDir) {
    await git(['clone', remoteDir, cloneDir], undefined)
    await configureRepo(cloneDir)
    await git(['checkout', 'main'], cloneDir)
}

async function createTrackedRemoteScenario(rootDir) {
    const remoteDir = join(rootDir, 'remote.git')
    const seedDir = join(rootDir, 'seed')
    const localDir = join(rootDir, 'local')
    const peerDir = join(rootDir, 'peer')

    await mkdir(seedDir, {recursive: true})
    await git(['init', '--bare', remoteDir], rootDir)
    await git(['init', '-b', 'main'], seedDir)
    await configureRepo(seedDir)
    await commitFile(seedDir, 'README.md', '# zephyr\n', 'Initial commit')
    await git(['remote', 'add', 'origin', remoteDir], seedDir)
    await git(['push', '-u', 'origin', 'main'], seedDir)
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remoteDir)

    await cloneRepo(remoteDir, localDir)
    await cloneRepo(remoteDir, peerDir)

    return {remoteDir, localDir, peerDir}
}

describe('deploy/local-repo integration', () => {
    let rootDir

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'zephyr-local-repo-'))
    })

    afterEach(async () => {
        await rm(rootDir, {recursive: true, force: true})
    })

    it('throws a clear error when the repository is in detached HEAD state', async () => {
        const repoDir = join(rootDir, 'repo')

        await mkdir(repoDir, {recursive: true})
        await git(['init', '-b', 'main'], repoDir)
        await configureRepo(repoDir)
        await commitFile(repoDir, 'README.md', '# zephyr\n', 'Initial commit')

        const {stdout: commitSha} = await git(['rev-parse', 'HEAD'], repoDir)
        await git(['checkout', commitSha], repoDir)

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')

        await expect(async () => {
            await ensureLocalRepositoryState('main', repoDir, {
                runPrompt: vi.fn(),
                runCommand,
                runCommandCapture,
                logProcessing: vi.fn(),
                logSuccess: vi.fn(),
                logWarning: vi.fn()
            })
        }).rejects.toThrow('Local repository is in detached HEAD state. Check out the deployment branch before deploying.')
    }, 20000)

    it('throws a clear error when the target branch does not exist locally', async () => {
        const repoDir = join(rootDir, 'repo')

        await mkdir(repoDir, {recursive: true})
        await git(['init', '-b', 'develop'], repoDir)
        await configureRepo(repoDir)
        await commitFile(repoDir, 'README.md', '# zephyr\n', 'Initial commit')

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')

        await expect(async () => {
            await ensureLocalRepositoryState('main', repoDir, {
                runPrompt: vi.fn(),
                runCommand,
                runCommandCapture,
                logProcessing: vi.fn(),
                logSuccess: vi.fn(),
                logWarning: vi.fn()
            })
        }).rejects.toThrow(/Unable to check out main/)
    }, 20000)

    it('fast-forwards the current branch when the tracked remote is ahead', async () => {
        const {localDir, peerDir, remoteDir} = await createTrackedRemoteScenario(rootDir)

        await commitFile(peerDir, 'remote.txt', 'remote change\n', 'Remote update')
        await git(['push', 'origin', 'main'], peerDir)

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')
        const logSuccess = vi.fn()

        await ensureLocalRepositoryState('main', localDir, {
            runPrompt: vi.fn(),
            runCommand,
            runCommandCapture,
            logProcessing: vi.fn(),
            logSuccess,
            logWarning: vi.fn()
        })

        const {stdout: localHead} = await git(['rev-parse', 'HEAD'], localDir)
        const {stdout: remoteHead} = await git(['rev-parse', 'refs/heads/main'], remoteDir)

        expect(localHead).toBe(remoteHead)
        expect(logSuccess).toHaveBeenCalledWith('Local branch fast-forwarded with upstream changes.')
    }, 30000)

    it('fails when the local branch has diverged from upstream and cannot fast-forward', async () => {
        const {localDir, peerDir} = await createTrackedRemoteScenario(rootDir)

        await commitFile(localDir, 'local.txt', 'local change\n', 'Local update')
        await commitFile(peerDir, 'remote.txt', 'remote change\n', 'Remote update')
        await git(['push', 'origin', 'main'], peerDir)

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')

        await expect(async () => {
            await ensureLocalRepositoryState('main', localDir, {
                runPrompt: vi.fn(),
                runCommand,
                runCommandCapture,
                logProcessing: vi.fn(),
                logSuccess: vi.fn(),
                logWarning: vi.fn()
            })
        }).rejects.toThrow(/Unable to fast-forward main with upstream changes/)
    }, 30000)

    it('commits and pushes staged tracked changes to the remote branch', async () => {
        const {localDir, remoteDir} = await createTrackedRemoteScenario(rootDir)

        await writeFile(join(localDir, 'README.md'), '# zephyr\nupdated locally\n')
        await git(['add', 'README.md'], localDir)

        const runPrompt = vi.fn()
            .mockResolvedValueOnce({shouldCommitPendingChanges: true})
            .mockResolvedValueOnce({commitMessage: 'Prepare deployment'})
        const logSuccess = vi.fn()
        const suggestCommitMessage = vi.fn().mockResolvedValue('fix: align deployment dirty tree handling')

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')

        await ensureLocalRepositoryState('main', localDir, {
            runPrompt,
            runCommand,
            runCommandCapture,
            logProcessing: vi.fn(),
            logSuccess,
            logWarning: vi.fn(),
            suggestCommitMessage
        })

        const {stdout: localStatus} = await git(['status', '--porcelain'], localDir)
        const {stdout: remoteReadme} = await git(['show', 'main:README.md'], remoteDir)
        const {stdout: remoteMessage} = await git(['log', '-1', '--pretty=%s', 'main'], remoteDir)

        expect(runPrompt).toHaveBeenCalledTimes(2)
        expect(localStatus).toBe('')
        expect(remoteReadme).toContain('updated locally')
        expect(remoteMessage).toBe('Prepare deployment')
        expect(logSuccess).toHaveBeenCalledWith('Committed pending changes with "Prepare deployment".')
        expect(logSuccess).toHaveBeenCalledWith('Pushed committed changes to origin/main.')
    }, 30000)

    it('commits and pushes unstaged tracked changes to the remote branch', async () => {
        const {localDir, remoteDir} = await createTrackedRemoteScenario(rootDir)

        await writeFile(join(localDir, 'README.md'), '# zephyr\nupdated without staging\n')

        const runPrompt = vi.fn()
            .mockResolvedValueOnce({shouldCommitPendingChanges: true})
            .mockResolvedValueOnce({commitMessage: 'Fix deployment guard'})
        const suggestCommitMessage = vi.fn().mockResolvedValue('fix: align deployment dirty tree handling')

        const {ensureLocalRepositoryState} = await import('#src/deploy/local-repo.mjs')

        await ensureLocalRepositoryState('main', localDir, {
            runPrompt,
            runCommand,
            runCommandCapture,
            logProcessing: vi.fn(),
            logSuccess: vi.fn(),
            logWarning: vi.fn(),
            suggestCommitMessage
        })

        const {stdout: localStatus} = await git(['status', '--porcelain'], localDir)
        const {stdout: remoteReadme} = await git(['show', 'main:README.md'], remoteDir)
        const {stdout: remoteMessage} = await git(['log', '-1', '--pretty=%s', 'main'], remoteDir)

        expect(runPrompt).toHaveBeenCalledTimes(2)
        expect(localStatus).toBe('')
        expect(remoteReadme).toContain('updated without staging')
        expect(remoteMessage).toBe('Fix deployment guard')
    }, 30000)
})
