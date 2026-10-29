import process from 'node:process'
import {describe, expect, it, vi} from 'vitest'
import {createRunPrompt} from '#src/runtime/prompt.mjs'
import {evaluateDeploymentCiSnapshot, normalizeDeploymentCiPolicy, waitForDeploymentCi} from '#src/application/deploy/github-ci-gate.mjs'

const headSha = 'a'.repeat(40)
const policy = {enabled: true, requiredWorkflows: ['tests']}
const context = {rootDir: '/project', headSha, branch: 'main', policy}
const run = (overrides = {}) => ({databaseId: 10, workflowDatabaseId: 20, workflowName: 'tests', headSha, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success', url: 'https://github.com/owner/repo/actions/runs/10', ...overrides})
function captureSnapshots(...snapshots) {
  const snapshot = vi.fn()
  snapshots.forEach(value => snapshot.mockResolvedValueOnce(JSON.stringify(value)))
  const capture = vi.fn(async (command, args) => {
    if (command === 'git') return 'git@github.com:owner/repo.git'
    if (command === 'gh' && args[0] === 'run') return snapshot()
    throw new Error('Unexpected command')
  })
  return {capture, snapshot}
}

function evaluate(runs) {
  return evaluateDeploymentCiSnapshot(runs, context)
}

describe('optional app deployment CI policy', () => {
  it.each([undefined, null, false, {enabled: false}, {enabled: false, requiredWorkflows: 'invalid'}])('does nothing when disabled: %j', async configured => {
    const runCommandCapture = vi.fn()
    await expect(waitForDeploymentCi({policy: configured, runCommandCapture})).resolves.toEqual({status: 'skipped', reason: 'disabled', runs: []})
    expect(runCommandCapture).not.toHaveBeenCalled()
  })

  it.each([true, {}, {enabled: true}, {enabled: true, requiredWorkflows: []}, {enabled: true, requiredWorkflows: ['']}, {...policy, timeoutMs: 0}, {...policy, timeoutMs: '1000'}])('rejects incomplete or malformed enabled policy: %j', configured => {
    expect(() => normalizeDeploymentCiPolicy(configured)).toThrow()
  })

  it('normalizes names and timeout without changing the supplied policy', () => {
    const source = {enabled: true, requiredWorkflows: [' tests ', 'tests', 'lint']}
    expect(normalizeDeploymentCiPolicy(source)).toEqual({...policy, requiredWorkflows: ['tests', 'lint'], timeoutMs: 900000})
    expect(source.requiredWorkflows).toEqual([' tests ', 'tests', 'lint'])
  })

  it('fails before provider access if the release context is incomplete', async () => {
    const runCommandCapture = vi.fn()
    await expect(waitForDeploymentCi({...context, headSha: 'abc123', runCommandCapture})).rejects.toMatchObject({data: {reason: 'invalid-context'}})
    expect(runCommandCapture).not.toHaveBeenCalled()
  })
})

describe('exact commit CI evaluation', () => {
  it('requires successful runs for every named workflow', () => {
    expect(evaluateDeploymentCiSnapshot([run(), run({databaseId: 11, workflowName: 'lint', workflowDatabaseId: 21})], {...context, policy: {...policy, requiredWorkflows: ['tests', 'lint']}})).toMatchObject({status: 'passed', pending: []})
    expect(evaluateDeploymentCiSnapshot([run()], {...context, policy: {...policy, requiredWorkflows: ['tests', 'lint']}})).toMatchObject({status: 'pending', pending: [{workflow: 'lint', reason: 'missing'}]})
  })

  it.each([{headSha: 'b'.repeat(40)}, {headBranch: 'release'}, {event: 'pull_request'}, {workflowName: 'unrelated'}])('does not accept an unrelated successful run: %j', override => {
    expect(evaluate([run(override)])).toMatchObject({status: 'pending', runs: [], pending: [{workflow: 'tests', reason: 'missing'}]})
  })

  it.each(['failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required', null])('fails closed on a non-success terminal outcome: %s', conclusion => {
    expect(() => evaluate([run({conclusion})])).toThrow(/did not succeed/)
    try { evaluate([run({conclusion})]) } catch (error) {
      expect(error).toMatchObject({code: 'ZEPHYR_CI_GATE_FAILED', data: {reason: 'workflow-failed', conclusion, runId: 10}})
    }
  })

  it('does not let an older success hide a newer failure or pending rerun', () => {
    expect(() => evaluate([run(), run({databaseId: 11, conclusion: 'failure'})])).toThrow(/did not succeed/)
    expect(evaluate([run(), run({databaseId: 11, status: 'in_progress', conclusion: ''})])).toMatchObject({status: 'pending'})
    expect(evaluate([run({attempt: 1}), run({attempt: 2, status: 'queued', conclusion: ''})])).toMatchObject({status: 'pending'})
  })

  it('rejects ambiguous workflow names and truncated discovery', () => {
    expect(() => evaluate([run(), run({databaseId: 11, workflowDatabaseId: 22})])).toThrow(/ambiguous/)
    expect(() => evaluate(Array.from({length: 1000}, () => run()))).toThrow(/safety limit/)
  })

  it('rejects malformed responses or provider run identities', () => {
    expect(() => evaluate({runs: []})).toThrow(/invalid/)
    expect(() => evaluate([run({databaseId: '10'})])).toThrow(/valid run ID/)
  })
})

describe('CI gate orchestration', () => {
  it('returns an already-passed snapshot without installing a completion wait', async () => {
    const {capture} = captureSnapshots([run()])
    const awaitCompletion = vi.fn()
    const logSuccess = vi.fn()
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture, awaitCompletion, logSuccess})).resolves.toMatchObject({status: 'passed', headSha})
    expect(awaitCompletion).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith('gh', expect.arrayContaining(['--repo', 'github.com/owner/repo', '--commit', headSha, '--branch', 'main', '--event', 'push']), {cwd: '/project', signal: expect.any(AbortSignal)})
    expect(logSuccess).toHaveBeenCalledOnce()
  })

  it.each(['https://github.com/owner/repo.git', 'ssh://git@github.com/owner/repo.git'])('resolves a repository from its verified origin: %s', remote => {
    const capture = vi.fn(async command => command === 'git' ? remote : JSON.stringify([run()]))
    return expect(waitForDeploymentCi({...context, runCommandCapture: capture})).resolves.toMatchObject({status: 'passed'})
  })

  it('resolves a Mac SSH origin alias without exposing expanded SSH configuration', async () => {
    const capture = vi.fn(async (command) => {
      if (command === 'git') return 'git@wyxos.github.com:owner/repo.git'
      if (command === 'ssh') return 'user git\nhostname github.com\nidentityfile /private/key-path\nproxycommand private-config-value\n'
      return JSON.stringify([run()])
    })
    const logProcessing = vi.fn()
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture, logProcessing})).resolves.toMatchObject({status: 'passed'})
    expect(capture).toHaveBeenCalledWith('ssh', ['-G', 'wyxos.github.com'], {cwd: '/project', signal: expect.any(AbortSignal)})
    expect(capture).toHaveBeenCalledWith('gh', expect.arrayContaining(['--repo', 'github.com/owner/repo']), expect.any(Object))
    expect(JSON.stringify(logProcessing.mock.calls)).not.toMatch(/private|identityfile|proxycommand/)
  })

  it('does not resolve canonical GitHub origins with an extra SSH command', async () => {
    const {capture} = captureSnapshots([run()])
    await waitForDeploymentCi({...context, runCommandCapture: capture})
    expect(capture.mock.calls.map(call => call[0])).toEqual(['git', 'gh'])
  })

  it('keeps the origin repository pinned when GH_REPO points elsewhere', async () => {
    const previous = process.env.GH_REPO
    process.env.GH_REPO = 'attacker/other-repository'
    try {
      const {capture} = captureSnapshots([run()])
      await waitForDeploymentCi({...context, runCommandCapture: capture})
      expect(capture).toHaveBeenCalledWith('gh', expect.arrayContaining(['--repo', 'github.com/owner/repo']), expect.any(Object))
    } finally {
      if (previous === undefined) delete process.env.GH_REPO
      else process.env.GH_REPO = previous
    }
  })

  it.each(['hostname bad/host', 'user git', 'hostname github.com\nhostname another.example', 'hostname -option'])('fails closed if an SSH alias has no single valid canonical hostname: %s', config => {
    const capture = vi.fn(async command => {
      if (command === 'git') return 'git@wyxos.github.com:owner/repo.git'
      if (command === 'ssh') return config
      throw new Error('GitHub must not be called')
    })
    return expect(waitForDeploymentCi({...context, runCommandCapture: capture})).rejects.toMatchObject({data: {reason: 'invalid-origin'}, message: expect.stringContaining('ssh -G')})
  })

  it('clearly rejects an unavailable SSH alias resolver before accessing GitHub', async () => {
    const capture = vi.fn(async command => {
      if (command === 'git') return 'git@wyxos.github.com:owner/repo.git'
      if (command === 'ssh') throw new Error('ssh unavailable')
      throw new Error('GitHub must not be called')
    })
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture})).rejects.toMatchObject({data: {reason: 'invalid-origin'}, message: expect.stringContaining('local SSH alias configuration')})
  })

  it('fails closed when authentication or GitHub access is unavailable', async () => {
    const runCommandCapture = vi.fn().mockRejectedValue(new Error('authentication required'))
    await expect(waitForDeploymentCi({...context, runCommandCapture})).rejects.toMatchObject({data: {reason: 'unavailable'}})
  })

  it('fails closed on malformed GitHub output', async () => {
    const runCommandCapture = vi.fn(async command => command === 'git' ? 'git@github.com:owner/repo.git' : 'not json')
    await expect(waitForDeploymentCi({...context, runCommandCapture})).rejects.toMatchObject({data: {reason: 'unavailable'}})
  })

  it('watches missing and pending workflows only during the enabled release, then confirms a fresh success', async () => {
    const {capture, snapshot} = captureSnapshots([], [run({status: 'in_progress'})], [run()], [run()])
    const waitForNextCheck = vi.fn().mockResolvedValue()
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture, waitForNextCheck})).resolves.toMatchObject({status: 'passed'})
    expect(waitForNextCheck).toHaveBeenCalledTimes(2)
    expect(snapshot).toHaveBeenCalledTimes(4)
  })

  it('stops watching immediately when a required workflow fails', async () => {
    const {capture, snapshot} = captureSnapshots([], [run({conclusion: 'cancelled'})])
    const waitForNextCheck = vi.fn().mockResolvedValue()
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture, waitForNextCheck})).rejects.toMatchObject({data: {reason: 'workflow-failed'}})
    expect(waitForNextCheck).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledTimes(2)
  })

  it('explains a missing gh CLI in non-interactive mode and never skips the enabled gate', async () => {
    const capture = vi.fn(async command => {
      if (command === 'git') return 'git@github.com:owner/repo.git'
      throw Object.assign(new Error('Command not found: gh'), {code: 'ENOENT'})
    })
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture})).rejects.toMatchObject({message: expect.stringContaining('Install it'), data: {reason: 'gh-unavailable'}})
  })

  it('pauses on missing gh until the operator chooses Retry, then rechecks once', async () => {
    let attempts = 0
    const capture = vi.fn(async command => {
      if (command === 'git') return 'git@github.com:owner/repo.git'
      if (++attempts === 1) throw Object.assign(new Error('Command not found: gh'), {code: 'ENOENT'})
      return JSON.stringify([run()])
    })
    const runPrompt = vi.fn().mockResolvedValue({ciAccessAction: 'retry'})
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture, interactive: true, runPrompt})).resolves.toMatchObject({status: 'passed'})
    expect(runPrompt).toHaveBeenCalledOnce()
    expect(attempts).toBe(2)
  })

  it('allows an operator to cancel when GitHub access is unavailable', async () => {
    const runCommandCapture = vi.fn().mockRejectedValue(new Error('authentication required'))
    const runPrompt = vi.fn().mockResolvedValue({ciAccessAction: 'cancel'})
    await expect(waitForDeploymentCi({...context, runCommandCapture, interactive: true, runPrompt})).rejects.toMatchObject({data: {reason: 'cancelled'}})
    expect(runCommandCapture).toHaveBeenCalledTimes(1)
  })

  it('rechecks GitHub after the injected completion event rather than trusting the event payload', async () => {
    const {capture, snapshot} = captureSnapshots([run({status: 'in_progress'})], [run({conclusion: 'failure'})])
    const awaitCompletion = vi.fn().mockResolvedValue({status: 'passed'})
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture, awaitCompletion})).rejects.toMatchObject({data: {reason: 'workflow-failed'}})
    expect(snapshot).toHaveBeenCalledTimes(2)
  })

  it('allows a completion source to observe snapshots and confirms success with a fresh read', async () => {
    const {capture, snapshot} = captureSnapshots([], [run({status: 'in_progress'})], [run()])
    let waitSignal
    const awaitCompletion = vi.fn(async ({readSnapshot, signal, repository}) => {
      waitSignal = signal
      expect(repository).toBe('github.com/owner/repo')
      expect(await readSnapshot()).toMatchObject({status: 'pending'})
    })
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture, awaitCompletion})).resolves.toMatchObject({status: 'passed'})
    expect(snapshot).toHaveBeenCalledTimes(3)
    expect(waitSignal.aborted).toBe(true)
  })

  it('rejects an event that arrives before all required CI is complete', async () => {
    const {capture} = captureSnapshots([], [run({status: 'queued'})])
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture, awaitCompletion: vi.fn().mockResolvedValue()})).rejects.toMatchObject({data: {reason: 'incomplete'}})
  })

  it('bounds the completion wait and signals its cancellation on timeout', async () => {
    vi.useFakeTimers()
    try {
      const {capture} = captureSnapshots([run({status: 'in_progress'})])
      let waitSignal
      const result = waitForDeploymentCi({...context, policy: {...policy, timeoutMs: 100}, runCommandCapture: capture, awaitCompletion: ({signal}) => {
        waitSignal = signal
        return new Promise(() => {})
      }})
      const assertion = expect(result).rejects.toMatchObject({data: {reason: 'timeout'}})
      await vi.advanceTimersByTimeAsync(100)
      await assertion
      expect(waitSignal.aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('times out missing workflows without repeated discovery before the next scheduled check', async () => {
    vi.useFakeTimers()
    try {
      const {capture, snapshot} = captureSnapshots([])
      const result = waitForDeploymentCi({...context, policy: {...policy, timeoutMs: 100}, runCommandCapture: capture})
      const assertion = expect(result).rejects.toMatchObject({data: {reason: 'timeout'}})
      await vi.advanceTimersByTimeAsync(100)
      await assertion
      expect(snapshot).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('closes the real prompt abstraction when the CI deadline expires during access recovery', async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn()
      const pendingPrompt = Object.assign(new Promise(() => {}), {ui: {close}})
      const inquirer = {prompt: vi.fn().mockReturnValue(pendingPrompt)}
      const runPrompt = createRunPrompt({inquirer})
      const runCommandCapture = vi.fn(async command => {
        if (command === 'git') return 'git@github.com:owner/repo.git'
        throw Object.assign(new Error('Command not found: gh'), {code: 'ENOENT'})
      })
      const result = waitForDeploymentCi({...context, policy: {...policy, timeoutMs: 100}, interactive: true, runPrompt, runCommandCapture})
      const assertion = expect(result).rejects.toMatchObject({data: {reason: 'timeout'}})
      await vi.advanceTimersByTimeAsync(100)
      await assertion
      expect(inquirer.prompt).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('bounds a hung initial provider request, before any watcher starts', async () => {
    vi.useFakeTimers()
    try {
      const runCommandCapture = vi.fn(() => new Promise(() => {}))
      const result = waitForDeploymentCi({...context, policy: {...policy, timeoutMs: 100}, runCommandCapture})
      const assertion = expect(result).rejects.toMatchObject({data: {reason: 'timeout'}})
      await vi.advanceTimersByTimeAsync(100)
      await assertion
      expect(runCommandCapture.mock.calls[0][2].signal.aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('cancels the watcher without another provider request', async () => {
    const {capture, snapshot} = captureSnapshots([run({status: 'in_progress'})])
    const controller = new AbortController()
    const waitForNextCheck = vi.fn(async () => {
      controller.abort()
      return new Promise(() => {})
    })
    await expect(waitForDeploymentCi({...context, runCommandCapture: capture, waitForNextCheck, signal: controller.signal})).rejects.toMatchObject({data: {reason: 'cancelled'}})
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it('does not access GitHub after an already-cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    const runCommandCapture = vi.fn()
    await expect(waitForDeploymentCi({...context, signal: controller.signal, runCommandCapture})).rejects.toMatchObject({data: {reason: 'cancelled'}})
    expect(runCommandCapture).not.toHaveBeenCalled()
  })
})
