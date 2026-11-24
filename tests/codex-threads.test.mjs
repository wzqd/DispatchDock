import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { turnOutput } from '../skills/codex-dispatch/adapters/codex-events.mjs';
import { mapLine } from '../skills/codex-dispatch/adapters/codex.mjs';
import { formatProgress } from '../skills/codex-dispatch/lib/progress.mjs';
import { validThreadId } from '../skills/codex-dispatch/lib/paths.mjs';
import { parseArgs } from '../skills/codex-dispatch/lib/options.mjs';

const read = file => readFileSync(file, 'utf8');
const lines = file => existsSync(file) ? read(file).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
const moduleUrl = file => JSON.stringify(new URL('../skills/codex-dispatch/' + file, import.meta.url).href);
function fixture(t, { git = true, desktop = true } = {}) {
  const base = mkdtempSync(join(tmpdir(),'dispatchdock-threads-')), root = join(base,'示例仓库'), home = join(base,'home');
  mkdirSync(root); mkdirSync(home);
  if (git) assert.equal(spawnSync('git',['init','--quiet', root]).status,0);
  const agent = join(base,'fake.cjs'), entry = join(base,'codex-task.mjs');
  copyFileSync(new URL('./fixtures/app-server.txt',import.meta.url),agent);
  const env = { ...process.env, CODEX_DISPATCH_HOME:home, CODEX_DISPATCH_TEST_AGENT:agent, CODEX_NO_WATCH:'1', CODEX_HOME:join(base,'codex') };
  for (const k of ['CODEX_DRY_RUN','CODEX_MODEL','CODEX_EFFORT','CODEX_TIER','CODEX_SANDBOX']) delete env[k];
  writeFileSync(join(home,'config.json'),'{"v":1}');
  writeFileSync(entry,`import {run} from ${moduleUrl('lib/run.mjs')};import {codex} from ${moduleUrl('adapters/codex.mjs')};
import {writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';
const platform={installed:async()=>${desktop},open:async id=>{writeFileSync(join(import.meta.dirname,'opened-'+id),'1');}};
const observe=e=>appendFileSync(join(import.meta.dirname,'observation.jsonl'),JSON.stringify({...e,task:process.argv[2]})+'\\n');
process.exitCode=await run({adapter:{...codex,execute:ctx=>codex.execute(ctx,{platform,poll:15,timeout:300,observe})},scriptPath:import.meta.filename});`);
  const launch = (args, cwd=root) => new Promise((done,reject) => {
    const child=spawn(process.execPath,[entry,...args],{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:15000});
    let output=''; for(const stream of [child.stdout,child.stderr]) { stream.setEncoding('utf8'); stream.on('data',s=>output+=s); }
    child.once('error',reject); child.once('close',code=>done({code,output}));
  });
  const rows=()=>lines(join(home,'runs.jsonl')), calls=()=>lines(join(base,'calls.jsonl')), observations=()=>lines(join(base,'observation.jsonl'));
  const configure=value=>writeFileSync(join(base,'agent.json'),JSON.stringify(value));
  const dispatch=async (name,args=[],code=0,cwd=root)=>{
    const result=await launch([name,'--name',name,...args],cwd);
    assert.equal(result.code,code,result.output);
    const start=rows().find(r=>r.event==='start'&&r.name===name);
    const events=rows().filter(r=>r.id===start.id);
    return { start, thread:events.filter(r=>r.event==='thread').at(-1), events, output:result.output, progress:read(start.progress), report:existsSync(start.report)&&read(start.report), raw:lines(start.raw) };
  };
  t.after(()=>{assert.equal(dirname(base),resolve(tmpdir()));rmSync(base,{recursive:true,force:true,maxRetries:8,retryDelay:80});});
  return {base,root,home,launch,dispatch,configure,calls,rows,observations};
}

test('对话选择、仓库和角色隔离、命名与默认后台执行',async t=>{
  const f=fixture(t,{desktop:false});
  const first=await f.dispatch('首次',['--effort','max']), id=first.thread.threadId;
  assert.equal(first.thread.mode,'new');assert.equal(first.thread.runner,'background');assert.equal(first.report,'首次');
  assert.equal(f.calls().find(c=>c.method==='thread/name/set').p.name,'派发：示例仓库');
  assert.equal(f.calls().find(c=>c.method==='thread/start').p.config.model_reasoning_effort,'max');
  assert.equal((await f.launch(['--config','effort=ultra'])).code,0);
  assert.equal((await f.dispatch('复用')).thread.threadId,id);
  assert.equal(f.calls().find(c=>c.method==='thread/resume').p.config.model_reasoning_effort,'ultra');
  const next=await f.dispatch('强制新开',['--new-thread']);assert.notEqual(next.thread.threadId,id);
  const specified=await f.dispatch('指定',['--thread',id]);assert.equal(specified.thread.mode,'specified');
  assert.equal(f.calls().filter(c=>c.method==='thread/name/set').length,2);
  writeFileSync(join(f.root,'role.md'),'# 角色：工程');
  const role=await f.dispatch('有角色',['--role','role.md']);assert.notEqual(role.thread.threadId,id);
  assert.equal(f.calls().filter(c=>c.method==='thread/name/set').at(-1).p.name,'派发：示例仓库（工程）');
  const other=join(f.base,'另一个仓库');assert.equal(spawnSync('git',['init','--quiet',other]).status,0);
  assert.notEqual((await f.dispatch('另一个仓库',[],0,other)).thread.threadId,id);
  f.configure({archived:id});
  const archived=await f.dispatch('归档');assert.match(archived.progress,/已不存在，已新开/);assert.notEqual(archived.thread.threadId,id);
  rmSync(join(f.base,'thread-'+archived.thread.threadId));
  assert.match((await f.dispatch('删除后复用')).output,/已不存在，已新开/);
  const absent=await f.dispatch('不存在',['--thread',archived.thread.threadId],1);assert.match(absent.output,/出错：找不到指定的对话/);
  assert.throws(()=>parseArgs(['task','--new-thread','--thread',id]));
  assert.equal(validThreadId('../something'),false);
});

test('桌面准备轮不入日志，首次打开、复用已占用、覆盖提示、后台转交',async t=>{
  const f=fixture(t);
  const first=await f.dispatch('首次',['--effort','ultra']);const id=first.thread.threadId;
  assert.equal(first.thread.runner,'desktop');assert.equal(first.report,'首次');assert.doesNotMatch(first.progress,/已就绪/);
  const replay=first.raw.flatMap(e=>mapLine(JSON.stringify(e),{root:f.root}));
  assert.deepEqual(replay,lines(first.start.events).map(({v,seq,at,...event})=>event));
  assert.equal(first.raw[0].thread_id,id);assert.ok(first.raw.every(e=>Number.isFinite(e._at)));
  assert.ok(f.calls().some(c=>c.method==='turn/start' && c.p.input[0].text==='这是 DispatchDock 的派发对话，之后的任务会排进这里。这一轮只回复：已就绪'));
  assert.equal(f.observations().find(o=>o.event==='handoff').opened,true);
  const methods=f.calls().map(c=>c.method);
  assert.ok(methods.indexOf('thread/resume')>=0 && methods.indexOf('thread/resume')<methods.indexOf('queue'),'探测写入权的连接不可消费本次消息');
  writeFileSync(join(f.home,'config.json'),JSON.stringify({v:1,agents:{codex:{effort:'high'}}}));
  assert.doesNotMatch((await f.dispatch('仅用配置')).progress,/本次指定的模型/);
  const next=await f.dispatch('再次',['--sandbox','read-only']);assert.equal(next.thread.threadId,id);assert.match(next.output,/本次指定的模型/);
  const redirected=await f.dispatch('后台转交',['--background','--thread',id]);
  assert.deepEqual(redirected.events.filter(r=>r.event==='thread').map(r=>r.runner),['background','desktop']);
  assert.match(redirected.progress,/改为交给桌面版/);assert.equal(f.observations().filter(o=>o.opened).length,1);
  assert.equal(redirected.report,'后台转交');
});

test('托管执行者用请求里的覆盖来源提示，兼容旧请求',async t=>{
  const f=fixture(t);
  const thread=(await f.dispatch('新开')).thread.threadId;
  for(const [name,overrides] of [['旧请求',undefined],['默认值',[]],['显式覆盖',['effort']]]) {
    const claim=join(f.home,name+'.claimed.json');
    writeFileSync(claim,JSON.stringify({
      v:1,id:name,name,at:Date.now(),repo:f.root,script:join(f.base,'codex-task.mjs'),node:process.execPath,
      args:{task:name,extra:'',role:null,spec:null,thread,overrides},
      settings:{model:null,effort:'high',tier:null,sandbox:'workspace-write',path:null},
      dispatcher:{host:'unknown',session:null},env:{},
    }));
    const result=await f.launch(['--run-request',claim]);
    assert.equal(result.code,0,result.output);
    const start=f.rows().find(e=>e.id===name && e.event==='start');
    assert.equal(read(start.progress).includes('本次指定的模型'),!!overrides?.length,name);
  }
});

for(const status of ['completed','failed','interrupted']) test('桌面终态 '+status+' 忽略只有用户消息的临时中断',async t=>{
  const f=fixture(t);f.configure({status,duration:350,occupied:true});
  const r=await f.dispatch('结局',[],status==='completed'?0:1);
  assert.ok(f.observations().some(o=>o.status==='interrupted'&&!o.terminal));
  if(status==='interrupted') assert.equal(r.events.at(-1).signal,'stopped-in-codex');
  else assert.equal(r.events.at(-1).exit,status==='completed'?0:1);
  if(status==='failed')assert.match(r.progress,/出错：桌面示例失败/);
});

test('桌面启动超时保留排队消息；准备失败不排队',async t=>{
  const f=fixture(t);f.configure({neverStart:true});
  const timed=await f.dispatch('超时',[],1);assert.match(timed.progress,/60 秒内没有开始执行。任务还在这个对话的队列里/);
  assert.equal(f.calls().filter(c=>c.method==='queue').length,1);
  f.configure({prepFail:true});const prep=await f.dispatch('准备失败',['--new-thread'],1);
  assert.match(prep.progress,/出错：准备失败/);assert.equal(f.calls().filter(c=>c.method==='queue').length,1);
});

test('排入相同对话的两条同文指令用客户端消息 ID 分别找到自己的轮次',async t=>{
  const f=fixture(t),id=(await f.dispatch('开始')).thread.threadId;
  f.configure({duration:350,occupied:true});
  const results=await Promise.all(['记录甲','记录乙'].map(name=>f.launch(['相同指令','--name',name,'--thread',id])));
  for(const result of results)assert.equal(result.code,0,result.output);
  const matches=f.observations().filter(o=>o.event==='matched'&&o.task==='相同指令');
  assert.equal(new Set(matches.map(o=>o.turnId)).size,2);assert.equal(new Set(matches.map(o=>o.clientId)).size,2);
});

test('缺少客户端标识时只匹配入队边界后的完整消息',async t=>{
  const f=fixture(t);
  f.configure({occupied:true,noIds:true,startDelay:0});
  const first=await f.dispatch('开始');
  const args=['--thread',first.thread.threadId];
  for(const name of ['第一次','第二次']) {
    const result=await f.launch(['相同指令','--name',name,...args]);
    assert.equal(result.code,0,result.output);
  }
  const matched=f.observations().filter(o=>o.event==='matched'&&o.task==='相同指令');
  assert.deepEqual(matched.map(o=>o.by),['text','text']);
  assert.equal(new Set(matched.map(o=>o.turnId)).size,2);
});

test('后台同对话互斥，回收失效锁；桌面任务不能从命令行停止',async t=>{
  const f=fixture(t);const id=(await f.dispatch('后台',['--background'])).thread.threadId;
  const lock=join(f.home,'threads',id+'.lock');
  writeFileSync(lock,JSON.stringify({id:'过期',pid:2147483647,at:0}));f.configure({duration:400});
  const args=['--background','--thread',id];
  const all=await Promise.all(['并发甲','并发乙','并发丙'].map(name=>f.dispatch(name,args)));
  const arrival=f.rows().filter(e=>e.event==='thread' && all.some(r=>r.start.id===e.id)).map(e=>all.find(r=>r.start.id===e.id).start.name);
  const actual=f.calls().filter(c=>c.method==='turn/start').map(c=>c.p.input[0].text.split('\n').at(-1)).filter(s=>s.startsWith('并发'));
  assert.deepEqual(actual,arrival);
  assert.ok(all.some(r=>r.progress.includes('等前面的任务结束')));assert.equal(existsSync(lock),false);
  f.configure({occupied:true,duration:700});
  const task=f.dispatch('外部停止',['--thread',id]);
  for(let i=0;i<120&&!f.observations().some(o=>o.event==='matched');i++) await delay(20);
  const stopped=await f.launch(['--stop','外部停止']);
  assert.equal(stopped.code,1);assert.match(stopped.output,/请在桌面版里停止/);assert.equal((await task).report,'外部停止');
});

for (const runner of ['desktop', 'background']) {
  test(runner + ' 新开对话启用自动审查，续接与发起轮次沿用审批设置', async t => {
    const f = fixture(t);
    const flags = runner === 'background' ? ['--background'] : [];
    const first = await f.dispatch('新开', [...flags, '--sandbox', 'read-only']);
    const next = await f.dispatch('复用', flags);
    assert.equal(first.thread.runner, runner);
    assert.equal(next.thread.threadId, first.thread.threadId);
    assert.equal(next.thread.mode, 'resume');
    const calls = f.calls();
    const starts = calls.filter(c => c.method === 'thread/start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].p.approvalPolicy, 'on-request');
    assert.equal(starts[0].p.approvalsReviewer, 'auto_review');
    assert.equal(starts[0].p.sandbox, 'read-only');
    for (const method of ['thread/resume', 'turn/start']) {
      const requests = calls.filter(c => c.method === method);
      assert.ok(requests.length, method);
      for (const { p } of requests) {
        assert.ok(!Object.hasOwn(p, 'approvalPolicy'), method);
        assert.ok(!Object.hasOwn(p, 'approvalsReviewer'), method);
      }
    }
  });
}

test('非 git 提示及非交互审批拒绝',async t=>{
  const f=fixture(t,{git:false});const r=await f.dispatch('非仓库',['--background'],1);
  assert.match(r.output,/出错：Not inside a trusted directory/);assert.match(r.output,/当前目录不是 git 仓库/);
  assert.equal(spawnSync('git',['init','--quiet',f.root]).status,0);f.configure({approval:true});
  const task=await f.dispatch('审批',['--background']);assert.match(task.progress,/出错：已拒绝 Codex 请求/);
  const errors=lines(task.start.events).filter(e=>e.kind==='error');
  assert.deepEqual(errors.map(e=>e.text),['已拒绝 Codex 请求：item/commandExecution/requestApproval']);
  assert.ok(f.calls().some(c=>c.id===99 && c.result?.decision==='decline'));
});

test('app-server 同类条目转换后与匿名真实 exec 样例产生相同事件和进度',()=>{
  const converted=[],output=turnOutput(e=>converted.push(e));
  const input=lines(new URL('./fixtures/codex-sample.jsonl',import.meta.url)).filter(e=>e.item?.type!=='error');
  const notifications=lines(new URL('./fixtures/codex-thread-sample.jsonl',import.meta.url));
  for(const {method,params} of notifications) {
    if(method==='turn/completed') output.finish(params.turn);
    else output.notify(method,params);
  }
  const map=events=>events.flatMap(e=>mapLine(JSON.stringify(e),{root:process.cwd()}));
  assert.deepEqual(map(converted),map(input));assert.deepEqual(map(converted).flatMap(formatProgress),map(input).flatMap(formatProgress));
});
