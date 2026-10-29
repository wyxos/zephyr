import {afterEach, describe, expect, it} from 'vitest'
import {spawnSync} from 'node:child_process'
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {planLaravelDeploymentTasks} from '#src/application/deploy/plan-laravel-deployment-tasks.mjs'

const bash=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Git/bin/bash.exe'):'bash'
const shells=[bash,...(spawnSync('zsh',['--version']).status===0?['zsh']:[])]
const roots=[]
afterEach(()=>{
 for(const root of roots.splice(0)){
  const relative=path.relative(os.tmpdir(),root)
  if(!relative.startsWith('zephyr-composer-path-')||relative.includes(path.sep))throw Error('Unsafe cleanup')
  rmSync(root,{recursive:true,force:true})
 }
})
const command=planLaravelDeploymentTasks({branch:'main',isLaravel:true,changedFiles:['composer.lock'],phpCommand:'sh'})
 .find(step=>step.label==='Install Composer dependencies').command
const shellPath=value=>value.replaceAll('\\','/').replace(/^([A-Za-z]):\//,(_,drive)=>`/${drive.toLowerCase()}/`)
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'"

for(const shell of shells){
 describe(`Composer path handling through ${shell}`,()=>{
  const fixture=()=>{
   const root=mkdtempSync(path.join(os.tmpdir(),'zephyr-composer-path-'));roots.push(root)
   const bin=path.join(root,'Application Support','bin');mkdirSync(bin,{recursive:true})
   const composer=path.join(bin,'composer');
   writeFileSync(composer,'#!/bin/sh\nprintf "%s\\n" "$1" >> "$ZEPHYR_COMMAND_RECORD"\nif [ "$1" = "$ZEPHYR_FAIL_PHASE" ]; then exit 46; fi\nexit 0\n')
   chmodSync(composer,0o755)
   const record=path.join(root,'record.txt')
   const script=`export PATH=${quote(shellPath(bin))}:"$PATH"; git() { return 0; }; ${command}`
   const run=fail=>spawnSync(shell,['-c',script],{cwd:root,encoding:'utf8',env:{...process.env,ZEPHYR_COMMAND_RECORD:shellPath(record),ZEPHYR_FAIL_PHASE:fail||''}})
   return {root,record,run}
  }
  it('runs a Composer script at a path containing spaces',()=>{
   const {record,run}=fixture();const result=run()
   expect(result.status,result.stderr).toBe(0)
   expect(readFileSync(record,'utf8').trim().split(/\r?\n/)).toEqual(['validate','install'])
  })
  it.each(['validate','install'])('preserves a spaced-path %s failure',phase=>{
   const {record,run}=fixture();const result=run(phase)
   expect(result.status,result.stderr).toBe(46)
   expect(readFileSync(record,'utf8').trim().split(/\r?\n/)).toEqual(phase==='validate'?['validate']:['validate','install'])
  })
  it('fails clearly if Composer is unavailable',()=>{
   const root=mkdtempSync(path.join(os.tmpdir(),'zephyr-composer-path-'));roots.push(root)
   const result=spawnSync(shell,['-c',`PATH=''; git() { return 0; }; ${command}`],{cwd:root,encoding:'utf8'})
   expect(result.status).toBe(127)
   expect(result.stderr).toContain('Composer is unavailable on the deployment target')
  })
 })
}
