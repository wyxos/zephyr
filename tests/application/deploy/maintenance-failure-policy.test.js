import {describe, expect, it, vi} from 'vitest'
import {maybeRecoverLaravelMaintenanceMode} from '#src/application/deploy/deployment-recovery.mjs'

describe('explicit failure maintenance policy',()=>{
 const plan={remoteIsLaravel:true,maintenanceModeEnabled:true,keepMaintenanceOnFailure:true,phpCommand:'php8.4'}
 it('keeps a confirmed failed release closed without prompting or running up',async()=>{
  const executeRemote=vi.fn(),runPrompt=vi.fn()
  await maybeRecoverLaravelMaintenanceMode({remotePlan:plan,executionState:{enteredMaintenanceMode:true,exitedMaintenanceMode:false},executeRemote,runPrompt,executionMode:{interactive:false}})
  expect(executeRemote).not.toHaveBeenCalled();expect(runPrompt).not.toHaveBeenCalled()
 })
 it('preserves the policy when signal recovery is forced',async()=>{
  const executeRemote=vi.fn()
  await maybeRecoverLaravelMaintenanceMode({remotePlan:plan,executionState:{enteredMaintenanceMode:true,exitedMaintenanceMode:false},executeRemote,forceAutoRecovery:true,reason:'SIGINT'})
  expect(executeRemote).not.toHaveBeenCalled()
 })
 it('restores maintenance when a final health check fails after up',async()=>{
  const executeRemote=vi.fn(),executionState={enteredMaintenanceMode:true,exitedMaintenanceMode:true}
  await maybeRecoverLaravelMaintenanceMode({remotePlan:plan,executionState,executeRemote})
  expect(executeRemote).toHaveBeenCalledWith('Keep failed release in maintenance mode','php8.4 artisan down')
  expect(executionState.exitedMaintenanceMode).toBe(false)
 })
 it('keeps the previous default recovery for old presets',async()=>{
  const executeRemote=vi.fn()
  await maybeRecoverLaravelMaintenanceMode({remotePlan:{...plan,keepMaintenanceOnFailure:false},executionState:{enteredMaintenanceMode:true,exitedMaintenanceMode:false},executeRemote,executionMode:{interactive:false}})
  expect(executeRemote).toHaveBeenCalledWith('Disable Laravel maintenance mode','php8.4 artisan up')
 })
})
