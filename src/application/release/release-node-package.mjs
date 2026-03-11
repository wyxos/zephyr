import {join} from 'node:path'
import {readFile} from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {writeStderr} from '../../utils/output.mjs'
import {
    ensureCleanWorkingTree,
    ensureReleaseBranchReady,
    runReleaseCommand as runCommand,
    validateReleaseDependencies
} from '../../release/shared.mjs'

async function readPackage(rootDir = process.cwd()) {
    const packagePath = join(rootDir, 'package.json')
    const raw = await readFile(packagePath, 'utf8')
    return JSON.parse(raw)
}

function hasScript(pkg, scriptName) {
    return pkg?.scripts?.[scriptName] !== undefined
}

async function runLint(skipLint, pkg, rootDir = process.cwd(), {logStep, logSuccess, logWarning} = {}) {
    if (skipLint) {
        logWarning?.('Skipping lint because --skip-lint flag was provided.')
        return
    }

    if (!hasScript(pkg, 'lint')) {
        logStep?.('Skipping lint (no lint script found in package.json).')
        return
    }

    logStep?.('Running lint...')

    try {
        await runCommand('npm', ['run', 'lint'], {cwd: rootDir})
        logSuccess?.('Lint passed.')
    } catch (error) {
        if (error.stdout) {
            writeStderr(error.stdout)
        }
        if (error.stderr) {
            writeStderr(error.stderr)
        }
        throw error
    }
}

async function runTests(skipTests, pkg, rootDir = process.cwd(), {logStep, logSuccess, logWarning} = {}) {
    if (skipTests) {
        logWarning?.('Skipping tests because --skip-tests flag was provided.')
        return
    }

    if (!hasScript(pkg, 'test:run') && !hasScript(pkg, 'test')) {
        logStep?.('Skipping tests (no test or test:run script found in package.json).')
        return
    }

    logStep?.('Running test suite...')

    try {
        const testRunScript = pkg?.scripts?.['test:run'] ?? ''
        const testScript = pkg?.scripts?.test ?? ''
        const usesNodeTest = (script) => /\bnode\b.*\s--test\b/.test(script)

        if (hasScript(pkg, 'test:run')) {
            if (usesNodeTest(testRunScript)) {
                await runCommand('npm', ['run', 'test:run'], {cwd: rootDir})
            } else {
                await runCommand('npm', ['run', 'test:run', '--', '--reporter=dot'], {cwd: rootDir})
            }
        } else if (usesNodeTest(testScript)) {
            await runCommand('npm', ['test'], {cwd: rootDir})
        } else {
            await runCommand('npm', ['test', '--', '--run', '--reporter=dot'], {cwd: rootDir})
        }

        logSuccess?.('Tests passed.')
    } catch (error) {
        if (error.stdout) {
            writeStderr(error.stdout)
        }
        if (error.stderr) {
            writeStderr(error.stderr)
        }
        throw error
    }
}

async function runBuild(skipBuild, pkg, rootDir = process.cwd(), {logStep, logSuccess, logWarning} = {}) {
    if (skipBuild) {
        logWarning?.('Skipping build because --skip-build flag was provided.')
        return
    }

    if (!hasScript(pkg, 'build')) {
        logStep?.('Skipping build (no build script found in package.json).')
        return
    }

    logStep?.('Building project...')

    try {
        await runCommand('npm', ['run', 'build'], {cwd: rootDir})
        logSuccess?.('Build completed.')
    } catch (error) {
        if (error.stdout) {
            writeStderr(error.stdout)
        }
        if (error.stderr) {
            writeStderr(error.stderr)
        }
        throw error
    }
}

async function runLibBuild(skipBuild, pkg, rootDir = process.cwd(), {logStep, logSuccess, logWarning} = {}) {
    if (skipBuild) {
        logWarning?.('Skipping library build because --skip-build flag was provided.')
        return false
    }

    if (!hasScript(pkg, 'build:lib')) {
        logStep?.('Skipping library build (no build:lib script found in package.json).')
        return false
    }

    logStep?.('Building library...')

    try {
        await runCommand('npm', ['run', 'build:lib'], {cwd: rootDir})
        logSuccess?.('Library built.')
    } catch (error) {
        if (error.stdout) {
            writeStderr(error.stdout)
        }
        if (error.stderr) {
            writeStderr(error.stderr)
        }
        throw error
    }

    const {stdout: statusAfterBuild} = await runCommand('git', ['status', '--porcelain'], {capture: true, cwd: rootDir})
    const hasLibChanges = statusAfterBuild.split('\n').some((line) => {
        const trimmed = line.trim()
        return trimmed.includes('lib/') && (trimmed.startsWith('M') || trimmed.startsWith('??') || trimmed.startsWith('A') || trimmed.startsWith('D'))
    })

    if (hasLibChanges) {
        logStep?.('Committing lib build artifacts...')
        await runCommand('git', ['add', 'lib/'], {capture: true, cwd: rootDir})
        await runCommand('git', ['commit', '-m', 'chore: build lib artifacts'], {capture: true, cwd: rootDir})
        logSuccess?.('Lib build artifacts committed.')
    }

    return hasLibChanges
}

async function bumpVersion(releaseType, rootDir = process.cwd(), {logStep, logSuccess} = {}) {
    logStep?.('Bumping package version...')

    const {stdout: statusBefore} = await runCommand('git', ['status', '--porcelain'], {capture: true, cwd: rootDir})
    const hasLibChanges = statusBefore.split('\n').some((line) => {
        const trimmed = line.trim()
        return trimmed.includes('lib/') && (trimmed.startsWith('M') || trimmed.startsWith('??') || trimmed.startsWith('A') || trimmed.startsWith('D'))
    })

    if (hasLibChanges) {
        logStep?.('Stashing lib build artifacts...')
        await runCommand('git', ['stash', 'push', '-u', '-m', 'temp: lib build artifacts', 'lib/'], {capture: true, cwd: rootDir})
    }

    try {
        await runCommand('npm', ['version', releaseType], {capture: true, cwd: rootDir})
    } finally {
        if (hasLibChanges) {
            logStep?.('Restoring lib build artifacts...')
            await runCommand('git', ['stash', 'pop'], {capture: true, cwd: rootDir})
            await runCommand('git', ['add', 'lib/'], {capture: true, cwd: rootDir})
            const {stdout: statusAfter} = await runCommand('git', ['status', '--porcelain'], {capture: true, cwd: rootDir})
            if (statusAfter.includes('lib/')) {
                await runCommand('git', ['commit', '--amend', '--no-edit'], {capture: true, cwd: rootDir})
            }
        }
    }

    const pkg = await readPackage(rootDir)
    const commitMessage = `chore: release ${pkg.version}`
    await runCommand('git', ['commit', '--amend', '-m', commitMessage], {capture: true, cwd: rootDir})

    logSuccess?.(`Version updated to ${pkg.version}.`)
    return pkg
}

async function pushChanges(rootDir = process.cwd(), {logStep, logSuccess} = {}) {
    logStep?.('Pushing commits and tags to origin...')
    try {
        await runCommand('git', ['push', '--follow-tags'], {capture: true, cwd: rootDir})
        logSuccess?.('Git push completed.')
    } catch (error) {
        if (error.stdout) {
            writeStderr(error.stdout)
        }
        if (error.stderr) {
            writeStderr(error.stderr)
        }
        throw error
    }
}

function extractDomainFromHomepage(homepage) {
    if (!homepage) return null
    try {
        const url = new URL(homepage)
        return url.hostname
    } catch {
        const match = homepage.match(/(?:https?:\/\/)?([^/]+)/)
        return match ? match[1] : null
    }
}

async function deployGHPages(skipDeploy, pkg, rootDir = process.cwd(), {logStep, logSuccess, logWarning} = {}) {
    if (skipDeploy) {
        logWarning?.('Skipping GitHub Pages deployment because --skip-deploy flag was provided.')
        return
    }

    const distPath = path.join(rootDir, 'dist')
    const distExists = await fs.promises
        .stat(distPath)
        .then((stats) => stats.isDirectory())
        .catch(() => false)

    if (!distExists) {
        logStep?.('Skipping GitHub Pages deployment (no dist directory found).')
        return
    }

    logStep?.('Deploying to GitHub Pages...')

    const cnamePath = path.join(distPath, 'CNAME')
    const homepage =
        pkg &&
        typeof pkg === 'object' &&
        'homepage' in pkg &&
        typeof pkg.homepage === 'string'
            ? pkg.homepage
            : null

    if (homepage) {
        const domain = extractDomainFromHomepage(homepage)
        if (domain) {
            try {
                await fs.promises.mkdir(distPath, {recursive: true})
                await fs.promises.writeFile(cnamePath, domain)
            } catch (error) {
                logWarning?.(`Could not write CNAME file: ${error.message}`)
            }
        }
    }

    const worktreeDir = path.resolve(rootDir, '.gh-pages')

    try {
        try {
            await runCommand('git', ['worktree', 'remove', worktreeDir, '-f'], {capture: true, cwd: rootDir})
        } catch (_error) {
            // Ignore if worktree doesn't exist
        }

        try {
            await runCommand('git', ['worktree', 'add', worktreeDir, 'gh-pages'], {capture: true, cwd: rootDir})
        } catch {
            await runCommand('git', ['worktree', 'add', worktreeDir, '-b', 'gh-pages'], {capture: true, cwd: rootDir})
        }

        await runCommand('git', ['-C', worktreeDir, 'config', 'user.name', 'wyxos'], {capture: true})
        await runCommand('git', ['-C', worktreeDir, 'config', 'user.email', 'github@wyxos.com'], {capture: true})

        for (const entry of fs.readdirSync(worktreeDir)) {
            if (entry === '.git') continue
            const target = path.join(worktreeDir, entry)
            fs.rmSync(target, {recursive: true, force: true})
        }

        fs.cpSync(distPath, worktreeDir, {recursive: true})

        await runCommand('git', ['-C', worktreeDir, 'add', '-A'], {capture: true})
        await runCommand('git', ['-C', worktreeDir, 'commit', '-m', `deploy: demo ${new Date().toISOString()}`, '--allow-empty'], {capture: true})
        await runCommand('git', ['-C', worktreeDir, 'push', '-f', 'origin', 'gh-pages'], {capture: true})

        logSuccess?.('GitHub Pages deployment completed.')
    } catch (error) {
        if (error.stdout) {
            writeStderr(error.stdout)
        }
        if (error.stderr) {
            writeStderr(error.stderr)
        }
        throw error
    }
}

export async function releaseNodePackage({
                                             releaseType,
                                             skipTests = false,
                                             skipLint = false,
                                             skipBuild = false,
                                             skipDeploy = false,
                                             rootDir = process.cwd(),
                                             logStep,
                                             logSuccess,
                                             logWarning
                                         } = {}) {
    logStep?.('Reading package metadata...')
    const pkg = await readPackage(rootDir)

    logStep?.('Validating dependencies...')
    await validateReleaseDependencies(rootDir, {logSuccess})

    logStep?.('Checking working tree status...')
    await ensureCleanWorkingTree(rootDir, {runCommand})
    await ensureReleaseBranchReady({rootDir, branchMethod: 'show-current', logStep, logWarning})

    await runLint(skipLint, pkg, rootDir, {logStep, logSuccess, logWarning})
    await runTests(skipTests, pkg, rootDir, {logStep, logSuccess, logWarning})
    await runLibBuild(skipBuild, pkg, rootDir, {logStep, logSuccess, logWarning})

    const updatedPkg = await bumpVersion(releaseType, rootDir, {logStep, logSuccess})
    await runBuild(skipBuild, updatedPkg, rootDir, {logStep, logSuccess, logWarning})
    await pushChanges(rootDir, {logStep, logSuccess})
    await deployGHPages(skipDeploy, updatedPkg, rootDir, {logStep, logSuccess, logWarning})

    logStep?.('Publishing will be handled by GitHub Actions via trusted publishing.')
    logSuccess?.(`Release workflow completed for ${updatedPkg.name}@${updatedPkg.version}.`)
}
