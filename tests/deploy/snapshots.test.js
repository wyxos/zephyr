import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
    clearPendingTasksSnapshot,
    loadPendingTasksSnapshot,
    savePendingTasksSnapshot
} from '#src/deploy/snapshots.mjs'

describe('deploy/snapshots', () => {
    let rootDir

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'zephyr-snapshots-'))
    })

    afterEach(async () => {
        await rm(rootDir, {recursive: true, force: true})
    })

    it('saves and loads the pending task snapshot', async () => {
        const snapshot = {
            serverName: 'production',
            branch: 'main',
            changedFiles: ['composer.json'],
            taskLabels: ['Install Composer dependencies']
        }

        await savePendingTasksSnapshot(rootDir, snapshot)

        await expect(loadPendingTasksSnapshot(rootDir)).resolves.toEqual(snapshot)

        const raw = await readFile(join(rootDir, '.zephyr', 'pending-tasks.json'), 'utf8')
        expect(raw.endsWith('\n')).toBe(true)
    })

    it('returns null when no snapshot exists and clears missing snapshots idempotently', async () => {
        await expect(loadPendingTasksSnapshot(rootDir)).resolves.toBeNull()
        await expect(clearPendingTasksSnapshot(rootDir)).resolves.toBeUndefined()
    })

    it('throws when the snapshot file contains invalid JSON', async () => {
        await mkdir(join(rootDir, '.zephyr'), {recursive: true})
        await writeFile(join(rootDir, '.zephyr', 'pending-tasks.json'), '{invalid json\n')

        await expect(loadPendingTasksSnapshot(rootDir)).rejects.toThrow()
    })

    it('removes the saved snapshot from disk', async () => {
        await savePendingTasksSnapshot(rootDir, {
            serverName: 'production',
            branch: 'main'
        })

        await clearPendingTasksSnapshot(rootDir)

        await expect(loadPendingTasksSnapshot(rootDir)).resolves.toBeNull()
    })
})
