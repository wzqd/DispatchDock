// 仅供验收者主动运行。每次新建临时 git 仓库，保留测试对话和证据。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { run } from '../skills/codex-dispatch/lib/run.mjs';
import { codex } from '../skills/codex-dispatch/adapters/codex.mjs';
import { connect } from '../skills/codex-dispatch/adapters/app-server.mjs';
import { desktop } from '../skills/codex-dispatch/adapters/desktop.mjs';

const self = fileURLToPath(import.meta.url);
const entry = fileURLToPath(new URL('../skills/codex-dispatch/codex-task.mjs', import.meta.url));
const read = file => readFileSync(file, 'utf8');
function rows(file) {
  if (!existsSync(file)) return [];
  const data = read(file);
  return data.slice(0,data.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(JSON.parse);
}
const help = `用法：node tools/verify-real-codex.mjs [--model 模型] [--effort 强度]
请在已登录、可联网的 Windows 或 macOS 上运行。桌面版已运行时跳过冷启动。
验收会几次将桌面版切到前台。第 7 项读取本次轮次记录的审批与沙箱设置并核对写入结果。
每次只派发到本次新建的临时仓库和对话；第 6 项对该测试轮次尝试一次外部停止。保留对话及临时证据。`;
function desktopRunning() {
  const win = process.platform === 'win32';
  const result = spawnSync(win ? 'powershell.exe' : 'pgrep', win ? ['-NoProfile','-NonInteractive','-Command',
    "$ErrorActionPreference='Stop'; $found=@(Get-Process -Name Codex,ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (Test-Path (Join-Path (Split-Path $_.Path) 'resources/app.asar')) -and ($_.ProcessName -eq 'Codex' -or $_.Path -match 'OpenAI\\.Codex') }); Write-Output $found.Count"] : ['-f','/Codex.app/Contents/MacOS/Codex'],
    { encoding:'utf8',windowsHide:true,timeout:8000 });
  if (win) return result.status === 0 && /^\d+$/.test(result.stdout.trim()) ? Number(result.stdout.trim()) > 0 : null;
  return result.status === 1 ? false : result.status === 0 ? true : null;
}
async function verify(args) {
  let model='gpt-6.2-astra', effort='high';
  for(let i=0;i<args.length;i+=2) {
    if (!['--model','--effort'].includes(args[i]) || !args[i+1]) throw Error(help);
    if(args[i]==='--model') model=args[i+1]; else effort=args[i+1];
  }
  console.log(help);
  const base=mkdtempSync(join(tmpdir(),'dispatchdock-011-')), root=join(base,'中文 验收'), home=join(base,'隔离配置');
  mkdirSync(root);mkdirSync(home);
  assert.equal(spawnSync('git',['init','--quiet',root],{windowsHide:true}).status,0);
  const env={...process.env, CODEX_DISPATCH_HOME:home, CODEX_NO_WATCH:'1'};
  for(const k of ['CODEX_DISPATCH_TEST_AGENT','CODEX_DRY_RUN','CODEX_MODEL','CODEX_EFFORT','CODEX_TIER','CODEX_SANDBOX']) delete env[k];
  writeFileSync(join(home,'config.json'),JSON.stringify({v:1,managed:false,watchWindow:'never',agents:{codex:{model,effort,sandbox:'read-only'}}}));
  const detection=codex.detect({env});
  assert.ok(detection.installed,'需要已安装的 Codex CLI');
  const login=spawnSync(detection.launcher.executable,[...detection.launcher.args,'login','status'],{env,windowsHide:true,timeout:10000});
  assert.equal(login.status,0,'Codex 尚未确认登录，真实验收未开始');
  assert.ok(await desktop.installed(env),'需要已关联 codex:// 的桌面版');
  const evidence={base,model,effort,version:detection.version,desktopInitiallyRunning:desktopRunning(),cases:{},tasks:[]};
  const save=()=>writeFileSync(join(base,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log('证据目录：'+base);save();
  const server=await connect({launcher:detection.launcher,env,root});
  async function check(n,fn) {
    try { const detail=await fn(); evidence.cases[n]={result:'通过',...detail}; }
    catch(e) { evidence.cases[n]={result:'待复核',reason:e.message}; }
    save(); console.log(n,evidence.cases[n]);
  }
  function dispatch(name,message,flags=[]) {
    const trace=join(base,name+'.jsonl'), began=Date.now();
    const child=spawn(process.execPath,[self,'--worker',trace,message,'--name',name,...flags],
      {cwd:root,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output='';
    for(const pipe of [child.stdout,child.stderr]) {pipe.setEncoding('utf8');pipe.on('data',s=>{output+=s;});}
    const done=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',code=>{
        try {
          const registry=rows(join(home,'runs.jsonl')), start=registry.find(e=>e.event==='start'&&e.name===name);
          if(!start) throw Error(output || '缺少 start');
          const events=registry.filter(e=>e.id===start.id), thread=events.filter(e=>e.event==='thread').at(-1);
          const raw=rows(start.raw), unified=rows(start.events);
          const task={name,code,thread,started:began,ended:Date.now(),end:events.at(-1),events,
            progress:read(start.progress),report:existsSync(start.report)?read(start.report):null,trace:rows(trace),output,
            kinds:unified.map(e=>e.kind),logHasThread:raw.some(e=>e.type==='thread.started'&&e.thread_id===thread?.threadId)&&raw.every(e=>Number.isFinite(e._at))};
          evidence.tasks.push(task);save();resolve(task);
        } catch(e){reject(e);}
      });
    });
    // 只结束本次启动的验收观察进程，桌面队列和对话保留。
    const timer=setTimeout(()=>child.kill(),240000);
    const finished=done.finally(()=>clearTimeout(timer));
    finished.catch(()=>{});
    return {done:finished,trace};
  }
  function complete(t,answer) {
    assert.equal(t.code,0,t.output);assert.equal(t.end.exit,0);assert.equal(t.report?.trim(),answer);
    assert.ok(t.logHasThread && t.kinds.includes('say') && t.kinds.includes('turn') && t.progress.includes('exit=0'));
  }
  function handoff(t) { return t.trace.find(e=>e.event==='handoff'); }
  function match(t) { return t.trace.find(e=>e.event==='matched'); }
  // 仅读取本次测试对话的 JSONL 历史。按轮次选取设置和审批记录，不导出完整对话上下文。
  async function turnEvidence(task) {
    assert.ok(evidence.tasks.includes(task));
    const threadId=task.thread.threadId, turnId=match(task).turnId;
    const {thread}=await server.call('thread/read',{threadId});
    assert.equal(thread.id,threadId);
    assert.ok(thread.path && basename(thread.path).endsWith(threadId+'.jsonl'));
    const {dataBase64}=await server.call('fs/readFile',{path:thread.path});
    const data=Buffer.from(dataBase64,'base64').toString('utf8');
    const records=data.slice(0,data.lastIndexOf('\n')).split('\n').filter(Boolean).map(JSON.parse);
    const context=records.findLast(r=>r.type==='turn_context' && r.payload.turn_id===turnId)?.payload;
    assert.ok(context,'测试轮次缺少 turn_context');
    let inTurn=false;
    const approvals=[];
    for(const {type,payload} of records) {
      if(type!=='event_msg') continue;
      if(payload.type==='task_started') inTurn=payload.turn_id===turnId;
      if(inTurn && /approval|elicitation/.test(payload.type)) approvals.push(payload.type);
    }
    return {threadId,turnId,model:context.model,effort:context.effort,approval:context.approval_policy,
      approvalsReviewer:context.approvals_reviewer,sandbox:context.sandbox_policy?.type,approvals};
  }
  function say(name,flags=[]) {return dispatch(name,`只回复 ${name}，不要运行命令或改文件。`,flags).done;}
  let first, other;
  try {
    await check(1,async()=>{
      first=await say('OK-A');complete(first,'OK-A');
      assert.equal(first.thread.mode,'new');assert.equal(first.thread.runner,'desktop');assert.ok(handoff(first)?.opened);
      return {threadId:first.thread.threadId,opened:handoff(first).opened,report:first.report,exit:first.code};
    });
    await check(8,async()=>{
      if (evidence.desktopInitiallyRunning !== false) return {result:'跳过',reason:'起跑前桌面版已运行或状态未知，保留现有进程，由设计负责人和用户另验冷启动'};
      assert.ok(handoff(first)?.opened && desktopRunning()===true);complete(first,'OK-A');
      return {coldLaunch:true};
    });
    await check(9,async()=>{
      const {thread}=await server.call('thread/read',{threadId:first.thread.threadId});
      evidence.persisted={model:thread.model,reasoningEffort:thread.reasoningEffort};
      const turn=await turnEvidence(first);
      assert.equal(thread.model,model);assert.equal(thread.reasoningEffort,effort);
      assert.equal(turn.model,model);assert.equal(turn.effort,effort);return {...evidence.persisted,turn};
    });
    await check(2,async()=>{
      const t=await say('OK-B');complete(t,'OK-B');
      assert.equal(t.thread.threadId,first.thread.threadId);assert.equal(t.thread.mode,'resume');assert.equal(handoff(t)?.opened,false);
      return {threadId:t.thread.threadId};
    });
    await check(3,async()=>{
      other=await say('OK-C',['--new-thread']);complete(other,'OK-C');assert.notEqual(other.thread.threadId,first.thread.threadId);assert.equal(other.thread.mode,'new');
      return {threadId:other.thread.threadId};
    });
    await check(4,async()=>{
      const bg=await say('OK-D',['--background','--new-thread']);complete(bg,'OK-D');assert.equal(bg.thread.runner,'background');
      const t=await say('OK-E',['--background','--thread',first.thread.threadId]);complete(t,'OK-E');
      assert.deepEqual(t.events.filter(e=>e.event==='thread').map(e=>e.runner),['background','desktop']);
      return {background:bg.thread.threadId,desktop:t.thread.threadId};
    });
    await check(5,async()=>{
      const threadId=first.thread.threadId, flags=['--thread',threadId];
      const waitCommand=process.platform==='win32'?'Start-Sleep -Seconds 8':'sleep 8';
      const a=dispatch('队首',`在当前终端执行 ${waitCommand}，等待命令结束后只回复 OK-F。`,flags);
      const deadline=Date.now()+60000;
      while(!rows(a.trace).some(e=>e.event==='queue') && Date.now()<deadline) await delay(100);
      const b=dispatch('队尾','只回复 OK-G，不运行命令。',flags);
      const [ta,tb]=await Promise.all([a.done,b.done]);complete(ta,'OK-F');complete(tb,'OK-G');
      const turnIds=[match(ta).turnId,match(tb).turnId];assert.notEqual(...turnIds);
      const history=await server.call('thread/turns/list',{threadId,limit:20,sortDirection:'desc'});
      const [one,two]=turnIds.map(id=>history.data.find(t=>t.id===id));
      assert.ok(Number.isFinite(one?.completedAt)&&Number.isFinite(two?.startedAt)&&one.completedAt<=two.startedAt,'两轮时间不完整或有重叠');
      return {turnIds,endedFirst:one.completedAt,startedNext:two.startedAt};
    });
    await check(6,async()=>{
      // 标记由临时仓库里的命令写入，独立证明发中断时确有命令在运行。
      const marker=join(root,'interrupt-started.txt');
      const markerCommand=process.platform==='win32'
        ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'interrupt-started.txt'),[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()); Start-Sleep -Seconds 30"
        : 'node -e \'require("fs").writeFileSync("interrupt-started.txt",String(Date.now()));setTimeout(()=>{},30000)\'';
      const test=dispatch('外部中断',`在当前临时仓库的终端原样执行一次以下命令，无需查找程序或提升权限。等待命令结束，只回复 OK-H。\n${markerCommand}`,
        ['--new-thread','--sandbox','workspace-write']);
      let matched;
      const deadline=Date.now()+120000;
      while(Date.now()<deadline) {
        matched=rows(test.trace).find(e=>e.event==='matched');
        if(matched && existsSync(marker))break;
        if(evidence.tasks.some(t=>t.name==='外部中断'))break;
        await delay(100);
      }
      const markerAt=existsSync(marker)?Number(read(marker)):0;
      if(matched && Date.now()-markerAt>=0 && Date.now()-markerAt<28000) {
        const records=rows(join(home,'runs.jsonl'));
        const task=records.find(e=>e.event==='start'&&e.name==='外部中断');
        const thread=records.find(e=>e.event==='thread'&&e.id===task?.id&&e.mode==='new'&&e.runner==='desktop');
        assert.ok(thread,'只允许中断本次新建的测试对话');
        const params={threadId:thread.threadId,turnId:matched.turnId};
        try { await server.call('turn/interrupt',params); evidence.interrupt={...params,accepted:true}; }
        catch(e){evidence.interrupt={...params,accepted:false,reason:e.message};}
        evidence.interrupt.markerAt=markerAt;save();
      }
      const t=await test.done;
      assert.ok(evidence.interrupt,'没有同时观察到本次轮次与正在运行的测试命令，未发送中断');
      if(t.end.signal==='stopped-in-codex') {assert.equal(evidence.interrupt.accepted,true);return {stopped:true,...evidence.interrupt};}
      complete(t,'OK-H');return {stopped:false,...evidence.interrupt};
    });
    await check(7,async()=>{
      const name='sandbox-marker.txt';
      const command=process.platform==='win32' ? "Set-Content -LiteralPath './sandbox-marker.txt' -Value OK -ErrorAction Stop" : 'echo OK > ./sandbox-marker.txt';
      const t=await dispatch('沙箱审批',`只在当前临时仓库的终端原样运行一次 ${command}。如被拒绝直接报告原因，不请求提升权限，不重试。`,['--thread',first.thread.threadId]).done;
      const turn=await turnEvidence(t);
      evidence.sandboxProbe={configured:'read-only',approvalPolicy:'on-request',approvalsReviewer:'auto_review',turn,
        markerExists:existsSync(join(root,name)),attemptObserved:t.kinds.includes('cmd'),report:t.report};
      assert.ok(evidence.sandboxProbe.attemptObserved,'未观察到执行命令');
      assert.equal(t.code,0);assert.equal(turn.sandbox,'read-only');assert.equal(turn.approval,'on-request');assert.equal(turn.approvalsReviewer,'auto_review');
      assert.deepEqual(turn.approvals,[]);assert.equal(evidence.sandboxProbe.markerExists,false);
      return evidence.sandboxProbe;
    });
    await check(10,async()=>{
      const samples=evidence.tasks.flatMap(t=>t.trace.filter(e=>e.event==='poll'));
      const transient=samples.filter(e=>e.status==='interrupted'&&e.completedAt==null&&!e.terminal);
      const final=samples.filter(e=>e.terminal);
      // 独立地重读已经退出的观察器所报告的轮次，检出较晚从 interrupted 变 completed 的情况。
      const reread=[];
      for(const task of evidence.tasks) {
        const last=task.trace.filter(e=>e.event==='poll'&&e.terminal).at(-1);
        if(!last)continue;
        const history=await server.call('thread/turns/list',{threadId:task.thread.threadId,limit:50});
        const turn=history.data.find(t=>t.id===last.turnId);
        reread.push({turnId:last.turnId,reported:last.status,later:turn?.status,completedAt:turn?.completedAt});
      }
      evidence.reread=reread;
      const firstVisible=new Map();
      for(const poll of samples) for(const item of poll.items) {
        const key=poll.turnId+'/'+item.id;
        if(!firstVisible.has(key)) firstVisible.set(key,{type:item.type,firstSeenAt:poll.at,atTerminal:poll.terminal,
          delayFromStartMs:Number.isFinite(item.startedAtMs)?poll.at-item.startedAtMs:null});
      }
      evidence.firstVisible=[...firstVisible.values()];
      evidence.timing={polls:samples.length,transient:transient.length,final:final.length,
        samples:samples.map(e=>({at:e.at,turnId:e.turnId,status:e.status,completedAt:e.completedAt,itemTypes:e.items.map(i=>i.type)}))};
      assert.ok(reread.length && reread.every(r=>r.reported===r.later),'观察器退出后同一轮状态发生了变化');
      assert.ok(final.length);assert.ok(transient.some(e=>final.some(f=>f.turnId===e.turnId&&f.status==='completed')),'没有采到 interrupted 转 completed 的同轮样本');
      return {transient:transient.length,terminal:final.length};
    });
  } finally {await server.close();save();}
  console.log('对话 ID：'+[...new Set(evidence.tasks.map(t=>t.thread?.threadId).filter(Boolean))].join('、'));
  console.log('证据：'+join(base,'evidence.json'));
  if(Object.values(evidence.cases).some(c=>c.result==='待复核'))process.exitCode=1;
}

if(process.argv[2]==='--help') console.log(help);
else if(process.argv[2]==='--worker') {
  const [, , , trace,...args]=process.argv;
  const observe=e=>appendFileSync(trace,JSON.stringify({at:Date.now(),...e})+'\n');
  process.exitCode=await run({adapter:{...codex,execute:ctx=>codex.execute(ctx,{observe})},scriptPath:entry,args});
} else await verify(process.argv.slice(2));
