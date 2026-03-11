import process from 'node:process'

import {vi} from 'vitest'

export const mockReadFile = vi.fn()
export const mockReaddir = vi.fn()
export const mockAccess = vi.fn()
export const mockWriteFile = vi.fn()
export const mockAppendFile = vi.fn()
export const mockMkdir = vi.fn()
export const mockUnlink = vi.fn()
export const mockStat = vi.fn()
export const mockExecCommand = vi.fn()
export const mockConnect = vi.fn()
export const mockDispose = vi.fn()
export const mockPrompt = vi.fn()
export const mockValidateLocalDependencies = vi.fn().mockResolvedValue(undefined)

vi.mock('node:fs/promises', () => ({
    default: {
        readFile: mockReadFile,
        readdir: mockReaddir,
        access: mockAccess,
        writeFile: mockWriteFile,
        appendFile: mockAppendFile,
        mkdir: mockMkdir,
        unlink: mockUnlink,
        stat: mockStat
    },
    readFile: mockReadFile,
    readdir: mockReaddir,
    access: mockAccess,
    writeFile: mockWriteFile,
    appendFile: mockAppendFile,
    mkdir: mockMkdir,
    unlink: mockUnlink,
    stat: mockStat
}))

export const spawnQueue = []

export function queueSpawnResponse(response = {}) {
    spawnQueue.push(response)
}

export const mockSpawn = vi.fn((_command, _args) => {
    const {stdout = '', stderr = '', exitCode = 0, error} =
        spawnQueue.length > 0 ? spawnQueue.shift() : {}

    const stdoutHandlers = []
    const stderrHandlers = []
    const closeHandlers = []
    const errorHandlers = []

    setImmediate(() => {
        if (error) {
            errorHandlers.forEach((handler) => handler(error))
            return
        }

        if (stdout) {
            const chunk = Buffer.from(stdout)
            stdoutHandlers.forEach((handler) => handler(chunk))
        }

        if (stderr) {
            const chunk = Buffer.from(stderr)
            stderrHandlers.forEach((handler) => handler(chunk))
        }

        closeHandlers.forEach((handler) => handler(exitCode))
    })

    return {
        stdout: {
            on: (event, handler) => {
                if (event === 'data') {
                    stdoutHandlers.push(handler)
                }
            }
        },
        stderr: {
            on: (event, handler) => {
                if (event === 'data') {
                    stderrHandlers.push(handler)
                }
            }
        },
        on: (event, handler) => {
            if (event === 'close') {
                closeHandlers.push(handler)
            }

            if (event === 'error') {
                errorHandlers.push(handler)
            }
        }
    }
})

export const mockSpawnSync = vi.fn(() => ({status: 0}))

vi.mock('node:child_process', () => ({
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
    default: {
        spawn: mockSpawn,
        spawnSync: mockSpawnSync
    }
}))

vi.mock('inquirer', () => {
    class Separator {
    }

    return {
        default: {
            prompt: mockPrompt,
            Separator
        },
        Separator,
        prompt: mockPrompt
    }
})

vi.mock('node-ssh', () => ({
    NodeSSH: vi.fn(() => ({
        connect: mockConnect,
        execCommand: mockExecCommand,
        dispose: mockDispose
    }))
}))

vi.mock('node:os', () => ({
    default: {
        homedir: () => '/home/local',
        userInfo: () => ({username: 'localuser'}),
        hostname: () => 'test-host'
    },
    homedir: () => '/home/local',
    userInfo: () => ({username: 'localuser'}),
    hostname: () => 'test-host'
}))

vi.mock('../../src/dependency-scanner.mjs', () => ({
    validateLocalDependencies: mockValidateLocalDependencies
}))

let originalStdoutWrite
let originalStderrWrite

export function setupRuntimeTestEnv() {
    originalStdoutWrite = process.stdout.write
    originalStderrWrite = process.stderr.write
    process.stdout.write = vi.fn()
    process.stderr.write = vi.fn()

    vi.resetModules()
    spawnQueue.length = 0
    mockSpawn.mockClear()
    mockSpawnSync.mockClear()
    mockReadFile.mockReset()
    mockReaddir.mockReset()
    mockAccess.mockReset()
    mockWriteFile.mockReset()
    mockAppendFile.mockReset()
    mockUnlink.mockReset()
    mockMkdir.mockReset()
    mockStat.mockReset()
    mockExecCommand.mockReset()
    mockConnect.mockReset()
    mockDispose.mockReset()
    mockPrompt.mockReset()
    mockValidateLocalDependencies.mockReset()

    mockMkdir.mockResolvedValue(undefined)
    mockValidateLocalDependencies.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue([])
    mockStat.mockImplementation(async () => ({mtime: new Date()}))

    globalThis.__zephyrSSHFactory = () => ({
        connect: mockConnect,
        execCommand: mockExecCommand,
        dispose: mockDispose
    })
    globalThis.__zephyrPrompt = mockPrompt
}

export function teardownRuntimeTestEnv() {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    delete globalThis.__zephyrSSHFactory
    delete globalThis.__zephyrPrompt
}
