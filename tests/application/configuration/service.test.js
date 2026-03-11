import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest'

import {
    mockMkdir,
    mockPrompt,
    mockReaddir,
    mockWriteFile,
    queueSpawnResponse,
    setupRuntimeTestEnv,
    teardownRuntimeTestEnv
} from '../../helpers/runtime-test-env.mjs'

describe('application/configuration/service', () => {
    beforeEach(() => {
        setupRuntimeTestEnv()
    })

    afterEach(() => {
        teardownRuntimeTestEnv()
    })

    it('requires prompt, command, and logger dependencies for the configuration service', async () => {
        const {createConfigurationService} = await import('../../../src/application/configuration/service.mjs')

        expect(() => createConfigurationService({})).toThrow(
            'createConfigurationService requires prompt, command, and logger dependencies.'
        )
    })

    it('registers a new server when none exist', async () => {
        mockPrompt.mockResolvedValueOnce({serverName: 'production', serverIp: '203.0.113.10'})

        const {selectServer, promptServerDetails} = await import('../../../src/application/configuration/service.mjs')
        const {saveServers} = await import('../../../src/config/servers.mjs')
        const {generateId} = await import('../../../src/utils/id.mjs')

        const servers = []
        const server = await selectServer({
            servers,
            runPrompt: mockPrompt,
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            persistServers: saveServers,
            promptServerDetails: (existingServers = []) =>
                promptServerDetails({existingServers, runPrompt: mockPrompt, createId: generateId})
        })

        expect(server).toMatchObject({serverName: 'production', serverIp: '203.0.113.10'})
        expect(server.id).toBeDefined()
        expect(typeof server.id).toBe('string')
        expect(servers).toHaveLength(1)
        expect(mockMkdir).toHaveBeenCalledWith(expect.stringMatching(/[\\/]\.config[\\/]zephyr/), {recursive: true})
        const [writePath, payload] = mockWriteFile.mock.calls.at(-1)
        expect(writePath).toContain('servers.json')
        expect(payload).toContain('production')
    })

    it('creates a new application configuration when none exist for a server', async () => {
        queueSpawnResponse({stdout: 'main\n'})
        mockPrompt
            .mockResolvedValueOnce({projectPath: '~/webapps/demo', branchSelection: 'main'})
            .mockResolvedValueOnce({sshUser: 'forge', sshKeySelection: '/home/local/.ssh/id_rsa'})
        mockReaddir.mockResolvedValue([])

        const {selectApp, promptAppDetails, listGitBranches, defaultProjectPath} = await import('../../../src/application/configuration/service.mjs')
        const {saveProjectConfig} = await import('../../../src/config/project.mjs')
        const {generateId} = await import('../../../src/utils/id.mjs')
        const {promptSshDetails} = await import('../../../src/ssh/keys.mjs')
        const {runCommandCapture: runCommandCaptureBase} = await import('../../../src/utils/command.mjs')

        const projectConfig = {apps: []}
        const server = {serverName: 'production', serverIp: '203.0.113.10'}

        const runCommandCapture = async (command, args, options) => (await runCommandCaptureBase(command, args, options)).stdout

        const app = await selectApp({
            projectConfig,
            server,
            currentDir: process.cwd(),
            runPrompt: mockPrompt,
            logWarning: () => {
            },
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            persistProjectConfig: saveProjectConfig,
            createId: generateId,
            promptAppDetails: (currentDir, existing = {}) =>
                promptAppDetails({
                    currentDir,
                    existing,
                    runPrompt: mockPrompt,
                    listGitBranches: (dir) => listGitBranches({currentDir: dir, runCommandCapture, logWarning: () => {}}),
                    resolveDefaultProjectPath: defaultProjectPath,
                    promptSshDetails: (dir, existingSsh = {}) => promptSshDetails(dir, existingSsh, {runPrompt: mockPrompt})
                })
        })

        expect(app).toMatchObject({
            serverName: 'production',
            projectPath: '~/webapps/demo',
            branch: 'main',
            sshUser: 'forge',
            sshKey: '/home/local/.ssh/id_rsa'
        })
        expect(projectConfig.apps).toHaveLength(1)
        expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('.zephyr'), {recursive: true})
        const [writePath, payload] = mockWriteFile.mock.calls.at(-1)
        expect(writePath.replace(/\\/g, '/')).toContain('.zephyr/config.json')
        expect(payload).toContain('~/webapps/demo')
    })

    it('shows existing applications when apps exist for a server', async () => {
        mockPrompt.mockResolvedValueOnce({selection: 0})

        const {selectApp} = await import('../../../src/application/configuration/service.mjs')
        const {saveProjectConfig} = await import('../../../src/config/project.mjs')
        const {generateId} = await import('../../../src/utils/id.mjs')

        const projectConfig = {
            apps: [
                {
                    serverName: 'production',
                    projectPath: '~/webapps/app1',
                    branch: 'main',
                    sshUser: 'deploy',
                    sshKey: '~/.ssh/id_rsa'
                },
                {
                    serverName: 'production',
                    projectPath: '~/webapps/app2',
                    branch: 'develop',
                    sshUser: 'deploy',
                    sshKey: '~/.ssh/id_rsa'
                },
                {
                    serverName: 'staging',
                    projectPath: '~/webapps/app3',
                    branch: 'main',
                    sshUser: 'deploy',
                    sshKey: '~/.ssh/id_rsa'
                }
            ]
        }
        const server = {serverName: 'production', serverIp: '203.0.113.10'}

        const app = await selectApp({
            projectConfig,
            server,
            currentDir: process.cwd(),
            runPrompt: mockPrompt,
            logWarning: () => {
            },
            logProcessing: () => {
            },
            logSuccess: () => {
            },
            persistProjectConfig: saveProjectConfig,
            createId: generateId,
            promptAppDetails: vi.fn()
        })

        expect(app).toMatchObject({
            serverName: 'production',
            projectPath: '~/webapps/app1',
            branch: 'main'
        })
        expect(mockPrompt).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    message: 'Select application for production',
                    choices: expect.arrayContaining([
                        expect.objectContaining({name: '~/webapps/app1 (main)'}),
                        expect.objectContaining({name: '~/webapps/app2 (develop)'})
                    ])
                })
            ])
        )
    })
})
