import {describe, expect, it} from 'vitest'
import {normalizeDeploymentOptions} from '#src/config/deployment-options.mjs'
import {normalizeDeploymentTasks} from '#src/application/deploy/release-task-options.mjs'
import {planLaravelDeploymentTasks} from '#src/application/deploy/plan-laravel-deployment-tasks.mjs'

const plan=(overrides={})=>planLaravelDeploymentTasks({branch:'main',isLaravel:true,changedFiles:[],...overrides})

describe('optional Laravel storage and Reverb lifecycle tasks',()=>{
 it('leaves both flags off and legacy same-commit steps unchanged',()=>{
  expect(normalizeDeploymentOptions({})).toEqual({})
  expect(normalizeDeploymentTasks({})).toMatchObject({linkStorage:false,restartReverb:false,keepMaintenanceOnFailure:false})
  expect(plan()).toEqual([{label:'Pull latest changes for main',command:'git pull origin main'}])
 })
 it.each(['linkStorage','restartReverb','keepMaintenanceOnFailure'])('round-trips an explicit %s preference',flag=>{
  for(const enabled of [false,true]){
   expect(normalizeDeploymentOptions({[flag]:enabled})).toEqual({[flag]:enabled})
   expect(normalizeDeploymentTasks({[flag]:enabled})[flag]).toBe(enabled)
  }
 })
 it.each([
  {linkStorage:'true'},{linkStorage:1},{linkStorage:null},
  {restartReverb:'false'},{restartReverb:0},{restartReverb:null},
  {keepMaintenanceOnFailure:'true'},{keepMaintenanceOnFailure:1},{keepMaintenanceOnFailure:null}
 ])('rejects invalid lifecycle flag types: %j',options=>{
  expect(()=>normalizeDeploymentOptions(options)).toThrow()
  expect(()=>normalizeDeploymentTasks(options)).toThrow()
 })
 it('runs explicit actions even without tracked file changes',()=>{
  const steps=plan({phpCommand:'php8.4',deployment:{linkStorage:true,restartReverb:true}})
  expect(steps).toEqual([
   {label:'Pull latest changes for main',command:'git pull origin main'},
   {label:'Link Laravel public storage',command:'php8.4 artisan storage:link'},
   {label:'Restart Laravel Reverb',command:'php8.4 artisan reverb:restart'}
  ])
 })
 it('links after migrations and restarts Reverb after queue/SSR before maintenance ends',()=>{
  const steps=plan({
   phpCommand:'php8.4',maintenanceMode:true,changedFiles:['database/migrations/release.php'],
   deployment:{linkStorage:true,restartReverb:true,optimizeCaches:true,restartSsr:true,
    healthChecks:[{label:'Check app',command:'true'}]}
  })
  const index=label=>steps.findIndex(step=>step.label===label)
  expect(index('Link Laravel public storage')).toBeGreaterThan(index('Run database migrations'))
  expect(index('Clear Laravel caches')).toBeGreaterThan(index('Link Laravel public storage'))
  expect(index('Restart Laravel Reverb')).toBeGreaterThan(index('Restart queue workers'))
  expect(index('Restart Laravel Reverb')).toBeGreaterThan(index('Restart Inertia SSR renderer'))
  expect(index('Disable Laravel maintenance mode')).toBeGreaterThan(index('Restart Laravel Reverb'))
  expect(index('Check app')).toBeGreaterThan(index('Disable Laravel maintenance mode'))
 })
 it('does not execute these Laravel commands for non-Laravel targets',()=>{
  const steps=plan({isLaravel:false,deployment:{linkStorage:true,restartReverb:true}})
  expect(steps).toEqual([{label:'Pull latest changes for main',command:'git pull origin main'}])
 })
})
