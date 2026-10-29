import {describe, expect, it, vi} from 'vitest'
import {prepareDeploymentRelease} from '#src/application/deploy/prepare-release.mjs'
import {verifyDeploymentRelease, checkReleaseUrl} from '#src/application/deploy/verify-release.mjs'
import {normalizePresetOptions, mergeDeployOptions} from '#src/config/preset-options.mjs'
import {EventEmitter} from 'node:events'

const sha = 'a'.repeat(40)

describe('release controls', () => {
  it('leaves legacy presets unchanged without GitHub or commit queries', async () => {
    const context = {runCommandCapture: vi.fn()}
    expect(await prepareDeploymentRelease({config: {branch:'main'}, rootDir:'.', context})).toEqual({})
    expect(context.runCommandCapture).not.toHaveBeenCalled()
    expect(normalizePresetOptions({})).not.toHaveProperty('ci')
    expect(normalizePresetOptions({})).not.toHaveProperty('deployment')
  })

  it('preserves explicit CI and deployment settings through preset merging', () => {
    const options = {ci:{enabled:true,requiredWorkflows:['tests']},deployment:{packageManager:'pnpm',restartSsr:true,healthUrl:'https://example.test/'}}
    const merged = mergeDeployOptions({},options)
    expect(merged.ci).toMatchObject(options.ci)
    expect(merged.deployment).toEqual(options.deployment)
    expect(normalizePresetOptions(merged)).toMatchObject(options)
    expect(mergeDeployOptions({}, {ci:false})).toHaveProperty('ci',false)
  })

  it.each([{deployment:[]},{deployment:{packageManager:'yarn'}},{deployment:{restartSsr:'false'}},{deployment:{unknown:true}},{ci:{enabled:true}},{ci:true},{deployment:{healthUrl:'https://user:pass@example.test'}}])('rejects invalid opted-in settings before release', options => {
    expect(()=>normalizePresetOptions(options)).toThrow()
  })

  it('pins releases with deployment settings without requiring GitHub', async () => {
    const runCommandCapture = vi.fn().mockResolvedValue(sha)
    const result = await prepareDeploymentRelease({config:{branch:'main'},executionMode:{deployment:{packageManager:'pnpm'}},rootDir:'.',context:{runCommandCapture}})
    expect(result).toEqual({expectedCommit:sha,deployment:{packageManager:'pnpm'},ci:false})
    expect(runCommandCapture).toHaveBeenCalledTimes(1)
  })

  it('refuses resuming a snapshot for a different local commit before reading CI', async () => {
    const context = {runCommandCapture:vi.fn().mockResolvedValue('b'.repeat(40))}
    await expect(prepareDeploymentRelease({config:{branch:'main'},snapshot:{expectedCommit:sha,ci:{enabled:true,requiredWorkflows:['tests']}},rootDir:'.',context})).rejects.toMatchObject({code:'ZEPHYR_RELEASE_COMMIT_CHANGED'})
    expect(context.runCommandCapture).toHaveBeenCalledTimes(1)
  })

  it('reuses saved CI and deployment settings when resuming', async () => {
    const runCommandCapture=vi.fn(async command=>command==='git'?sha:'[]')
    const result=await prepareDeploymentRelease({config:{branch:'main'},snapshot:{expectedCommit:sha,ci:false,deployment:{packageManager:'pnpm'}},executionMode:{deployment:{packageManager:'npm'}},rootDir:'.',context:{runCommandCapture}})
    expect(result.deployment.packageManager).toBe('pnpm')
  })

  it('keeps explicit disabled snapshot options when the preset later changes', async () => {
    const runCommandCapture = vi.fn().mockResolvedValue(sha)
    const result = await prepareDeploymentRelease({config:{branch:'main'},snapshot:{expectedCommit:sha,deployment:null,ci:false},executionMode:{deployment:{packageManager:'pnpm'},ci:{enabled:true,requiredWorkflows:['tests']}},rootDir:'.',context:{runCommandCapture}})
    expect(result).toEqual({expectedCommit:sha,deployment:null,ci:false})
    expect(runCommandCapture).toHaveBeenCalledTimes(1)
  })

  it('checks exact remote commit before maintenance and HTTP health', async () => {
    const executeRemote=vi.fn(), checkUrl=vi.fn()
    await verifyDeploymentRelease({release:{expectedCommit:sha,deployment:{healthUrl:'https://example.test/'}},remotePlan:{remoteIsLaravel:true},executeRemote,checkUrl})
    expect(executeRemote.mock.calls[0][1]).toContain(sha)
    expect(executeRemote.mock.calls[1][0]).toContain('maintenance')
    expect(checkUrl).toHaveBeenCalledWith('https://example.test/',{timeoutMs:15000})
  })

  it('does not report success or continue when remote commit verification fails', async () => {
    const checkUrl=vi.fn(),logSuccess=vi.fn()
    await expect(verifyDeploymentRelease({release:{expectedCommit:sha,deployment:{healthUrl:'https://example.test/'}},remotePlan:{remoteIsLaravel:true},executeRemote:vi.fn().mockRejectedValue(Error('wrong SHA')),checkUrl,logSuccess})).rejects.toThrow('wrong SHA')
    expect(checkUrl).not.toHaveBeenCalled()
    expect(logSuccess).not.toHaveBeenCalled()
  })

  it('turns a failed HTTP check into a release failure', async () => {
    await expect(verifyDeploymentRelease({release:{deployment:{healthUrl:'https://example.test/'}},remotePlan:{remoteIsLaravel:true},executeRemote:vi.fn(),checkUrl:vi.fn().mockRejectedValue(Error('HTTP 503'))})).rejects.toMatchObject({code:'ZEPHYR_RELEASE_HEALTH_FAILED'})
  })

  it.each([200,204,302,500])('makes one HTTP health request and requires 2xx (%s)', async statusCode => {
    const request=vi.fn((_url,_options,callback)=>{
      const req=new EventEmitter()
      req.end=()=>{callback({statusCode,resume:vi.fn()});req.emit('close')}
      return req
    })
    const result=checkReleaseUrl('https://example.test/',{request})
    if(statusCode<300)await expect(result).resolves.toBeUndefined()
    else await expect(result).rejects.toThrow(`HTTP ${statusCode}`)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
