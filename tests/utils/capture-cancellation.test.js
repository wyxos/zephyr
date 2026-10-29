import {describe, expect, it, vi} from 'vitest'
import {runCommandCapture} from '#src/utils/command.mjs'
import {createLocalCommandRunners} from '#src/runtime/local-command.mjs'

describe('captured provider command cancellation',()=>{
 it('forwards the CI deadline signal through the local runtime',async()=>{
  const controller=new AbortController()
  const capture=vi.fn().mockResolvedValue({stdout:'result'})
  const runners=createLocalCommandRunners({runCommandBase:vi.fn(),runCommandCaptureBase:capture})
  await expect(runners.runCommandCapture('gh',['run','list'],{cwd:'.',signal:controller.signal})).resolves.toBe('result')
  expect(capture).toHaveBeenCalledWith('gh',['run','list'],{cwd:'.',signal:controller.signal})
 })
 it('cancels an actual child process when its provider request is aborted',async()=>{
  const controller=new AbortController()
  controller.abort()
  await expect(runCommandCapture(process.execPath,['-e','process.stdin.resume()'],{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
 })
})
