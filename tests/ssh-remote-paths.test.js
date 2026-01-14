import { describe, it, expect, vi } from 'vitest'

describe('ssh remote path normalization', () => {
  it('readRemoteFile normalizes backslashes in filePath and cwd', async () => {
    const execCommand = vi.fn().mockResolvedValue({ code: 0, stdout: 'OK', stderr: '' })
    const ssh = { execCommand }

    const { readRemoteFile } = await import('../src/ssh/ssh.mjs')

    const out = await readRemoteFile(ssh, '\\home\\wyxos\\webapps\\atlas\\.env', '\\home\\wyxos\\webapps\\atlas')

    expect(out).toBe('OK')
    expect(execCommand).toHaveBeenCalledWith(
      "cat '/home/wyxos/webapps/atlas/.env'",
      { cwd: '/home/wyxos/webapps/atlas' }
    )
  }, 15000)

  it('deleteRemoteFile normalizes backslashes and uses rm -f', async () => {
    const execCommand = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const ssh = { execCommand }

    const { deleteRemoteFile } = await import('../src/ssh/ssh.mjs')

    await deleteRemoteFile(ssh, '\\home\\wyxos\\webapps\\atlas\\dump.sql', '\\home\\wyxos\\webapps\\atlas')

    expect(execCommand).toHaveBeenCalledWith(
      "rm -f '/home/wyxos/webapps/atlas/dump.sql'",
      { cwd: '/home/wyxos/webapps/atlas' }
    )
  }, 15000)

  it('downloadRemoteFile normalizes backslashes before calling getFile', async () => {
    const getFile = vi.fn().mockResolvedValue(undefined)
    const ssh = { getFile }

    const { downloadRemoteFile } = await import('../src/ssh/ssh.mjs')

    const originalWrite = process.stdout.write
    process.stdout.write = vi.fn()
    try {
      await downloadRemoteFile(
        ssh,
        'storage\\app\\temporary\\dump.sql',
        'C:\\temp\\dump.sql',
        '\\home\\wyxos\\webapps\\atlas'
      )
    } finally {
      process.stdout.write = originalWrite
    }

    // getFile(local, remote, sftp, options)
    expect(getFile).toHaveBeenCalled()
    const [_localPath, remotePath] = getFile.mock.calls[0]
    expect(remotePath).toBe('/home/wyxos/webapps/atlas/storage/app/temporary/dump.sql')
  }, 15000)
})

