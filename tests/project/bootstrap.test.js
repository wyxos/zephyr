import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
    mockPrompt,
    mockReadFile,
    mockWriteFile,
    queueSpawnResponse,
    setupRuntimeTestEnv,
    teardownRuntimeTestEnv
} from '../helpers/runtime-test-env.mjs'

describe('project/bootstrap', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('adds release script to package.json when user agrees', async () => {
        mockReadFile.mockResolvedValueOnce(
            JSON.stringify({
                name: 'demo-app',
                scripts: {
                    test: 'vitest'
                }
            })
        )
        mockPrompt.mockResolvedValueOnce({installReleaseScript: true})
        queueSpawnResponse({}) // git rev-parse
        queueSpawnResponse({}) // git add package.json
        queueSpawnResponse({}) // git commit

        const {ensureProjectReleaseScript} = await import('../../src/project/bootstrap.mjs')
        const {createLocalCommandRunners} = await import('../../src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('../../src/utils/command.mjs')
        const {runCommand} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await ensureProjectReleaseScript('/workspace/project', {
            runPrompt: mockPrompt,
            runCommand,
            logSuccess: () => {
            },
            logWarning: () => {
            }
        })

        expect(mockWriteFile).toHaveBeenCalledWith(
            expect.stringMatching(/[\\/]workspace[\\/]project[\\/]package\.json/),
            expect.stringContaining('"release": "npx @wyxos/zephyr@latest"')
        )
    })

    it('adds .zephyr to .gitignore when the entry is missing', async () => {
        mockReadFile.mockResolvedValueOnce('node_modules/\n')
        queueSpawnResponse({}) // git rev-parse
        queueSpawnResponse({}) // git add .gitignore
        queueSpawnResponse({}) // git commit

        const {ensureGitignoreEntry} = await import('../../src/project/bootstrap.mjs')
        const {createLocalCommandRunners} = await import('../../src/runtime/local-command.mjs')
        const {runCommand: runCommandBase, runCommandCapture: runCommandCaptureBase} = await import('../../src/utils/command.mjs')
        const {runCommand} = createLocalCommandRunners({runCommandBase, runCommandCaptureBase})

        await ensureGitignoreEntry('/workspace/project', {
            runCommand,
            logSuccess: () => {
            },
            logWarning: () => {
            }
        })

        expect(mockWriteFile).toHaveBeenCalledWith(
            '/workspace/project/.gitignore',
            'node_modules/\n.zephyr/\n'
        )
    })
})
