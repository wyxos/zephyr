import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createReleasePullCommand} from '#src/application/deploy/release-task-options.mjs'

const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash'
const git = (args, cwd) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
let root, publisher, deployed, sequence
const commit = ({push = true} = {}) => {
  writeFileSync(path.join(publisher, 'release.txt'), String(++sequence))
  git(['add', 'release.txt'], publisher)
  git(['-c', 'user.name=Zephyr test', '-c', 'user.email=1@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', `Release ${sequence}`], publisher)
  if (push) git(['push', 'origin', 'main'], publisher)
  return git(['rev-parse', 'HEAD'], publisher)
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'zephyr-verified-pull-'))
  publisher = path.join(root, 'publisher')
  deployed = path.join(root, 'deployed')
  mkdirSync(publisher)
  git(['init', '--bare', path.join(root, 'origin.git')], root)
  git(['init', '-b', 'main'], publisher)
  git(['remote', 'add', 'origin', path.join(root, 'origin.git')], publisher)
  sequence = 0
  commit()
  git(['clone', '--branch', 'main', path.join(root, 'origin.git'), deployed], root)
})

afterEach(() => {
  const relative = path.relative(os.tmpdir(), root)
  if (!relative.startsWith('zephyr-verified-pull-') || relative.includes(path.sep)) throw Error('Unsafe fixture cleanup')
  rmSync(root, {recursive: true, force: true})
})

describe('verified release pull against an isolated Git remote', () => {
  it('fast-forwards to the exact verified commit', () => {
    const expected = commit()
    execFileSync(bash, ['-c', createReleasePullCommand('main', expected)], {cwd: deployed, stdio: 'pipe'})
    expect(git(['rev-parse', 'HEAD'], deployed)).toBe(expected)
  })

  it('rejects a dirty checkout without changing its commit or edits', () => {
    const before = git(['rev-parse', 'HEAD'], deployed)
    const expected = commit()
    writeFileSync(path.join(deployed, 'release.txt'), 'uncommitted edit')
    expect(() => execFileSync(bash, ['-c', createReleasePullCommand('main', expected)], {cwd: deployed, stdio: 'pipe'})).toThrow()
    expect(git(['rev-parse', 'HEAD'], deployed)).toBe(before)
    expect(git(['diff', '--', 'release.txt'], deployed)).toContain('uncommitted edit')
  })

  it('rejects a different checked-out branch without changing it', () => {
    const before = git(['rev-parse', 'HEAD'], deployed)
    const expected = commit()
    git(['checkout', '-b', 'unrelated-work'], deployed)
    expect(() => execFileSync(bash, ['-c', createReleasePullCommand('main', expected)], {cwd: deployed, stdio: 'pipe'})).toThrow()
    expect(git(['rev-parse', 'HEAD'], deployed)).toBe(before)
    expect(git(['branch', '--show-current'], deployed)).toBe('unrelated-work')
  })

  it('merges only the verified SHA when upstream advances after the one fetch', () => {
    const expected = commit()
    const newer = commit({push: false})
    const publisherPath = publisher.replaceAll('\\', '/')
    const script = `git() { command git "$@"; result=$?; if [ "$1" = fetch ]; then command git -C '${publisherPath}' push origin main >&2 || return 1; fi; return "$result"; }; ` + createReleasePullCommand('main', expected)
    execFileSync(bash, ['-c', script], {cwd: deployed, stdio: 'pipe'})
    expect(git(['rev-parse', 'HEAD'], deployed)).toBe(expected)
    expect(git(['ls-remote', 'origin', 'refs/heads/main'], deployed)).toContain(newer)
  })

  it('rejects an advanced branch without changing the existing checkout', () => {
    const before = git(['rev-parse', 'HEAD'], deployed)
    const expected = commit()
    commit()
    expect(() => execFileSync(bash, ['-c', createReleasePullCommand('main', expected)], {cwd: deployed, stdio: 'pipe'})).toThrow()
    expect(git(['rev-parse', 'HEAD'], deployed)).toBe(before)
  })
})
