import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { resolveHostWorkspace, canonicalWorkspace } from '../lib/workspace.js'
import { Bridge, defaultConfig } from '../lib/bridge.js'
import { AcpClient } from '../lib/acp.js'
import { createProbeHandler } from './fs-probe-handler.mjs'
const fixtures = resolve('D:/lnu-seat/antigravity-bridge/results')
const temp = mkdtempSync(join(fixtures, 'round1-fixture-'))
const root = join(temp,'root'), other = join(temp,'other')
mkdirSync(root); mkdirSync(other)
const config = defaultConfig({ cwd: other, stateFile: join(temp,'state.json'), autoWake: false })
const selected = () => resolveHostWorkspace({ workingDirectory: { get: (session) => session.cwd } }, { session: { cwd: root } }, config)
test('Host selected directory wins, missing and inaccessible roots fail explicitly', () => {
 assert.equal(selected(), realpathSync(root))
 assert.throws(() => resolveHostWorkspace({}, {}, defaultConfig()), { code: 'workspace_unconfigured' })
 assert.throws(() => canonicalWorkspace(join(root,'missing')), { code: 'workspace_unavailable' })
 assert.throws(() => canonicalWorkspace('relative'), { code:'workspace_invalid' })
})
test('config/send binding persists, mismatch sends no prompt, new session uses new project', async () => {
 let count = 0, prompts = 0; const roots = []
 const backend = { ready: async()=>({}), createSession:async({cwd})=>{roots.push(cwd); return {sessionId:`s${++count}`,configOptions:[]}}, resumeSession:async({sessionId})=>({sessionId,configOptions:[]}), promptSession:async()=>{prompts++;return {stopReason:'end_turn',text:'ok'}} }
 const bridge = new Bridge({}, {...config, backend})
 try {
  const initial = await bridge.configSession({agentId:'a',cwd:selected()})
  assert.equal(initial.workspaceRoot, realpathSync(root))
  const {job} = bridge.beginSend({agentId:'a', conversationId:initial.sessionId,workspaceRoot:realpathSync(root)})
  await bridge.dispatch(job,{cwd:root,message:'read relative',requested:{},attachments:[]}); await Promise.resolve()
  assert.equal(job.status,'replied'); assert.equal(bridge.view(job).workspaceRoot,realpathSync(root))
  const {job:bad} = bridge.beginSend({agentId:'a',conversationId:initial.sessionId,workspaceRoot:realpathSync(other)})
  await bridge.dispatch(bad,{cwd:other,message:'bad',requested:{},attachments:[]})
  assert.equal(bad.code,'workspace_mismatch');assert.equal(prompts,1)
  const {job:newJob} = bridge.beginSend({agentId:'a',workspaceRoot:realpathSync(other)})
  await bridge.dispatch(newJob,{cwd:other,message:'new project',requested:{},attachments:[]});await Promise.resolve()
  assert.notEqual(newJob.conversationId,initial.sessionId);assert.deepEqual(roots,[realpathSync(root),realpathSync(other)])
  bridge.dispose()
  const reloaded = new Bridge({}, {...config, backend})
  assert.equal(reloaded.state.workspaces[initial.sessionId],realpathSync(root));reloaded.dispose()
 } finally {bridge.dispose()}
})
test('allow_once chooses only the server one-shot option during an active prompt; decisions observable', () => {
 assert.equal(defaultConfig().permissionPolicy,'reject');assert.equal(defaultConfig({permissionPolicy:'allow_once'}).permissionPolicy,'allow_once')
 assert.throws(()=>defaultConfig({permissionPolicy:'allow_always'}), /permissionPolicy/)
 const events=[], writes=[];const client=new AcpClient({permissionPolicy:'allow_once'})
 client.write=(message)=>writes.push(message)
 const session={activePrompt:{permissions:[],onPermission:(event)=>events.push(event)}}
 client.sessions.set('s',session)
 const request={sessionId:'s',options:[{kind:'allow_always',optionId:'always'},{kind:'allow_once',optionId:'once'},{kind:'reject_once',optionId:'deny'}],toolCall:{toolCallId:'tool',title:'write fixture',kind:'edit'}}
 client.respondPermission(42,request)
 assert.equal(events[0].decision,'approved');assert.equal(events[0].requestId,'42');assert.equal(events[0].policy,'allow_once');assert.equal(events[0].optionId,'once')
 assert.equal(writes[0].result.outcome.optionId,'once')
 session.activePrompt=null;client.respondPermission(43,request);assert.equal(writes[1].result.outcome.optionId,'deny')
})
test('isolated handler validates session/root, junction escape, read-only, size, encoding, range and write integrity', async () => {
 const session={id:'s',cwd:root,activePrompt:{}};const handle=createProbeHandler({maxBytes:32})
 writeFileSync(join(root,'read.txt'),'one\ntwo\nthree');writeFileSync(join(other,'outside.txt'),'outside')
 const call=(method,path,extra={})=>handle(method,{sessionId:'s',path,...extra},session)
 assert.deepEqual(await call('fs/read_text_file',join(root,'read.txt'),{line:2,limit:1}),{content:'two'})
 await assert.rejects(call('fs/read_text_file',join(other,'outside.txt')),{code:'fs_outside_workspace'})
 symlinkSync(other,join(root,'escape'),'junction')
 await assert.rejects(call('fs/write_text_file',join(root,'escape','new.txt'),{content:'bad'}),{code:'fs_outside_workspace'})
 const readonly=createProbeHandler({readOnly:true})
 await assert.rejects(readonly('fs/write_text_file',{sessionId:'s',path:join(root,'read.txt'),content:'bad'},session),{code:'fs_read_only'})
 await assert.rejects(call('fs/write_text_file',join(root,'read.txt'),{content:'x'.repeat(33)}),{code:'fs_too_large'})
 assert.equal(readFileSync(join(root,'read.txt'),'utf8'),'one\ntwo\nthree')
 writeFileSync(join(root,'bad.txt'),Buffer.from([0xff]));await assert.rejects(call('fs/read_text_file',join(root,'bad.txt')),{code:'fs_invalid_utf8'})
 await assert.rejects(call('fs/read_text_file',join(root,'read.txt'),{line:0}),{code:'fs_invalid_range'})
 await assert.rejects(handle('fs/read_text_file',{sessionId:'s',path:join(root,'read.txt')},{...session,activePrompt:null}),{code:'fs_session_unbound'})
 assert.deepEqual(await call('fs/write_text_file',join(root,'new.txt'),{content:'valid'}),{})
 assert.equal(readFileSync(join(root,'new.txt'),'utf8'),'valid')
})
process.on('exit',()=>{ // Exact fixture path created above, always under results.
 rmSync(temp,{recursive:true,force:true})
})
