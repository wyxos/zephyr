import {beforeEach, describe, expect, it, vi} from 'vitest'
const m=vi.hoisted(()=>({connect:vi.fn(),remoteState:vi.fn(),prepare:vi.fn(),release:vi.fn(),plan:vi.fn(),execute:vi.fn(),lock:vi.fn(),unlock:vi.fn(),localUnlock:vi.fn(),recover:vi.fn(),recoverAssets:vi.fn(),compare:vi.fn(),verify:vi.fn(),dispose:vi.fn(),guard:vi.fn()}))
vi.mock('node:fs/promises',()=>({default:{readFile:vi.fn().mockResolvedValue('fixture-key')}}))
vi.mock('#src/ssh/keys.mjs',()=>({resolveSshKeyPath:vi.fn().mockResolvedValue('/fixture/key')}))
vi.mock('#src/utils/log-file.mjs',()=>({cleanupOldLogs:vi.fn(),closeLogFile:vi.fn(),getLogFilePath:vi.fn().mockResolvedValue('/fixture/log'),writeToLogFile:vi.fn()}))
vi.mock('#src/deploy/locks.mjs',()=>({acquireRemoteLock:m.lock,releaseLocalLock:m.localUnlock,releaseRemoteLock:m.unlock,compareLocksAndPrompt:m.compare}))
vi.mock('#src/application/deploy/connect-to-remote-deployment-target.mjs',()=>({connectToRemoteDeploymentTarget:m.connect}))
vi.mock('#src/application/deploy/build-remote-deployment-plan.mjs',()=>({resolveRemoteDeploymentState:m.remoteState,buildRemoteDeploymentPlan:m.plan}))
vi.mock('#src/application/deploy/prepare-local-deployment.mjs',()=>({prepareLocalDeployment:m.prepare}))
vi.mock('#src/application/deploy/prepare-release.mjs',()=>({prepareDeploymentRelease:m.release}))
vi.mock('#src/application/deploy/verify-release.mjs',()=>({verifyDeploymentRelease:m.verify}))
vi.mock('#src/deploy/remote-exec.mjs',()=>({createRemoteExecutor:()=>m.execute}))
vi.mock('#src/application/deploy/deployment-recovery.mjs',()=>({createAbnormalExitGuard:options=>{m.guard(options);return {unregister:vi.fn()}},maybeRecoverFrontendArtifact:m.recoverAssets,maybeRecoverLaravelMaintenanceMode:m.recover}))
vi.mock('#src/deploy/snapshots.mjs',()=>({savePendingTasksSnapshot:vi.fn(),clearPendingTasksSnapshot:vi.fn()}))
import {runDeployment} from '#src/application/deploy/run-deployment.mjs'
const config={branch:'main',sshKey:'/fixture/key',sshUser:'fixture'}
const context=()=>({executionMode:{interactive:false},createSshClient:vi.fn(),logProcessing:vi.fn(),logSuccess:vi.fn(),logWarning:vi.fn(),logError:vi.fn(),runCommandCapture:vi.fn()})

beforeEach(()=>{
 for(const mock of Object.values(m))mock.mockReset()
 m.connect.mockResolvedValue({ssh:{dispose:m.dispose},remoteCwd:'/fixture/app'})
 m.remoteState.mockResolvedValue({remoteIsLaravel:true,maintenanceModeEnabled:true})
 m.prepare.mockResolvedValue({})
 m.release.mockResolvedValue({expectedCommit:'a'.repeat(40)})
 m.plan.mockResolvedValue({steps:[{label:'Build',command:'build'}],usefulSteps:false,remoteIsLaravel:true})
 m.execute.mockResolvedValue({code:0})
})

describe('release pipeline integration',()=>{
 it('does not acquire a remote lock or execute deployment when CI rejects',async()=>{
  m.release.mockRejectedValue(Object.assign(Error('CI failed'),{code:'ZEPHYR_CI_GATE_FAILED'}))
  await expect(runDeployment(config,{rootDir:'.',context:context()})).rejects.toMatchObject({code:'ZEPHYR_CI_GATE_FAILED'})
  expect(m.lock).not.toHaveBeenCalled()
  expect(m.execute).not.toHaveBeenCalled()
  expect(m.plan).not.toHaveBeenCalled()
 })
 it('aborts the CI wait on interruption and never advances to the lock',async()=>{
  let ready
  const gateReady=new Promise(resolve=>{ready=resolve})
  m.release.mockImplementation(({signal})=>new Promise((_resolve,reject)=>{
   signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'ZEPHYR_CI_GATE_FAILED'})),{once:true})
   ready()
  }))
  const running=runDeployment(config,{rootDir:'.',context:context()})
  const result=expect(running).rejects.toMatchObject({code:'ZEPHYR_CI_GATE_FAILED'})
  await gateReady
  await m.guard.mock.calls[0][0].cleanup('SIGINT')
  await result
  expect(m.lock).not.toHaveBeenCalled()
  expect(m.connect).toHaveBeenCalledTimes(1)
  expect(m.recover).not.toHaveBeenCalled()
 })
 it('passes pinned settings to the plan and verifies health before success',async()=>{
  await runDeployment(config,{rootDir:'.',context:context()})
  expect(m.plan).toHaveBeenCalledWith(expect.objectContaining({release:{expectedCommit:'a'.repeat(40)}}))
  expect(m.verify).toHaveBeenCalledOnce()
  expect(m.execute.mock.invocationCallOrder[0]).toBeLessThan(m.verify.mock.invocationCallOrder[0])
  expect(m.unlock).toHaveBeenCalledOnce()
 })
 it('preserves locks and skips automatic recovery when a remote outcome is unknown',async()=>{
  m.execute.mockRejectedValue(Object.assign(Error('connection lost'),{code:'REMOTE_OUTCOME_UNKNOWN',data:{stepLabel:'Build'}}))
  await expect(runDeployment(config,{rootDir:'.',context:context()})).rejects.toMatchObject({code:'REMOTE_OUTCOME_UNKNOWN',data:{stepLabel:'Build'}})
  expect(m.recover).not.toHaveBeenCalled()
  expect(m.recoverAssets).not.toHaveBeenCalled()
  expect(m.compare).not.toHaveBeenCalled()
  expect(m.unlock).not.toHaveBeenCalled()
  expect(m.localUnlock).not.toHaveBeenCalled()
  expect(m.dispose).toHaveBeenCalled()
  expect(m.verify).not.toHaveBeenCalled()
 })
 it('stops cleanup if a recovery command loses its connection',async()=>{
  m.execute.mockRejectedValueOnce(Object.assign(Error('build failed'),{code:'REMOTE_COMMAND_FAILED'})).mockRejectedValueOnce(Object.assign(Error('recovery interrupted'),{code:'REMOTE_OUTCOME_UNKNOWN'}))
  m.recoverAssets.mockImplementation(async({executeRemote})=>{try{await executeRemote('Rollback','rollback')}catch{ /* Existing recovery records its warning. */ }})
  await expect(runDeployment(config,{rootDir:'.',context:context()})).rejects.toThrow('build failed')
  expect(m.recover).not.toHaveBeenCalled()
  expect(m.unlock).not.toHaveBeenCalled()
  expect(m.localUnlock).not.toHaveBeenCalled()
 })
 it('never reports completion when health fails',async()=>{
  const ctx=context()
  m.verify.mockRejectedValue(Object.assign(Error('HTTP 503'),{code:'ZEPHYR_RELEASE_HEALTH_FAILED'}))
  await expect(runDeployment(config,{rootDir:'.',context:ctx})).rejects.toMatchObject({code:'ZEPHYR_RELEASE_HEALTH_FAILED'})
  expect(ctx.logSuccess.mock.calls.flat().join(' ')).not.toContain('Deployment commands completed')
 })
})
