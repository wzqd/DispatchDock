import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, pages } from './app-server.mjs';
import { validThreadId } from '../lib/paths.mjs';
import { desktop } from './desktop.mjs';
import { turnOutput } from './codex-events.mjs';
import { latestThread, lockThread, overlappingDispatch } from '../lib/threads.mjs';

const execute = promisify(execFile);
const preparation = '这是 DispatchDock 的派发对话，之后的任务会排进这里。这一轮只回复：已就绪';
const waiting = '执行：已排进对话队列，等前面的任务结束';
const locations = { desktop: '执行：交给 Codex 桌面版，进展在桌面版里实时显示', background: '执行：在后台运行，桌面版里不实时显示' };
const activeWriter = error => /active writer/i.test(error.message);
const missing = error => /(?:not found|no rollout found|does not exist|archived|no session found)/i.test(error.message);

function threadSettings({ model, effort, tier, sandbox }) {
  return { approvalPolicy: 'never', ...(model != null && { model }), ...(effort != null && { config: { model_reasoning_effort: effort } }),
    ...(tier != null && { serviceTier: tier }), ...(sandbox != null && { sandbox }) };
}

async function ownedTurn(server, threadId, prompt, write) {
  const output = turnOutput(write);
  const early = [];
  let turnId, finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const listener = (method, params) => {
    if (params?.threadId !== threadId) return;
    if (!turnId) { early.push([method, params]); return; }
    if ((params.turnId ?? params.turn?.id) !== turnId) return;
    output.notify(method, params);
    if (method === 'turn/completed') finish(params.turn);
  };
  server.listeners.add(listener);
  try {
    const result = await server.call('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
    turnId = result.turn.id;
    output.start();
    for (const args of early) listener(...args);
    const turn = await Promise.race([completed, server.failed]);
    if (turn instanceof Error) throw turn;
    output.finish(turn);
    return turn;
  } finally { server.listeners.delete(listener); }
}

async function queuedTurn(server, context, threadId, platform, probe, poll, timeout, observe) {
  const { prompt, env, root, launcher, announce, write } = context;
  const history = { threadId, sortDirection: 'desc' };
  const since = Date.now();
  const before = await server.call('thread/turns/list', { ...history, limit: 1 });
  const boundary = before.data[0]?.id;
  // 部分版本只能读到轮次，队列明细是可选的补充标识。
  let queueReadable = true;
  async function readQueue() {
    if (!queueReadable) return [];
    try { return await Array.fromAsync(pages(server, 'thread/queue/list', { threadId })); }
    catch (error) {
      queueReadable = false;
      observe?.({ event: 'queue-list-unavailable', reason: error.message });
      return [];
    }
  }
  const olderClients = new Set((await readQueue()).map(q => q.clientUserMessageId).filter(Boolean));
  // 空闲对话一旦 resume 就会消费待办。先探测并释放写入权，再把本次消息排进桌面队列。
  const occupied = await probe();
  const { stdout, stderr } = await execute(launcher.executable, [...launcher.args, 'queue', '--thread', threadId, '--message', prompt],
    { cwd: root, env, windowsHide: true, shell: false, timeout: 30000 });
  const receipt = /Queued message (\S+) for thread /i.exec(stdout + '\n' + stderr)?.[1];
  const queued = await readQueue();
  const index = queued.findIndex(q => q.id === receipt);
  const clientId = queued[index]?.clientUserMessageId;
  observe?.({ event: 'queue', receipt, clientId, index });
  const executing = t => t?.status === 'inProgress' || t?.status === 'interrupted' && t.completedAt == null;
  let ahead = index > 0 || executing(before.data[0]);
  if (ahead) announce(waiting);
  if (!occupied) await platform.open(threadId, env);
  observe?.({ event: 'handoff', occupied, opened: !occupied });
  let deadline = Date.now() + timeout, target, interruption;
  const output = turnOutput(write);
  for (;;) {
    let newer = false, found;
    const unbound = [];
    for await (const turn of pages(server, 'thread/turns/list', { ...history, itemsView: target ? 'notLoaded' : 'full' })) {
      if (turn.id === boundary) break;
      if (!target) {
        const users = turn.items.filter(i => i.type === 'userMessage');
        const identified = users.find(i => receipt && (i.id === receipt || i.clientId === receipt) || clientId && i.clientId === clientId);
        if (identified) {
          target = turn.id; output.start();
          observe?.({ event: 'matched', turnId: target, clientId: identified.clientId, by: 'id' });
        } else if (users.some(i => (!clientId || !i.clientId) && !olderClients.has(i.clientId) &&
          i.content?.filter(c => c.type === 'text').map(c => c.text).join('') === prompt)) {
          unbound.push({ turn, newer });
        }
      }
      if (turn.id === target) { found = turn; break; }
      newer = true;
    }
    if (!target && unbound.length && !(await readQueue()).some(q => receipt && q.id === receipt)) {
      if (unbound.length > 1 || overlappingDispatch(join(context.home, 'runs.jsonl'), context.id, threadId, context.title, since))
        throw Error('Codex 历史未提供可区分同文派发的消息标识，无法确定本次任务的轮次');
      ({ turn: found, newer } = unbound[0]);
      target = found.id; output.start(); observe?.({ event: 'matched', turnId: target, by: 'text' });
    }
    if (found) {
      // 外部历史在运行中也会显示 interrupted，completedAt 仍为空。等后继轮次或复读到稳定的结束时间。
      const ended = found.status === 'interrupted' && Number.isFinite(found.completedAt);
      if (!ended) interruption = undefined;
      else if (interruption?.at !== found.completedAt) interruption = { at: found.completedAt, seen: Date.now() };
      const confirmed = interruption && Date.now() - interruption.seen >= 2 * poll;
      const terminal = ['completed', 'failed'].includes(found.status) || found.status === 'interrupted' && (newer || !!confirmed);
      const entries = await Array.fromAsync(pages(server, 'thread/items/list', { threadId, turnId: target, sortDirection: 'asc' }));
      const lastMessage = entries.findLastIndex(e => e.item.type === 'agentMessage');
      for (const [index, entry] of entries.entries())
        output.snapshot(entry, terminal || entry.item.type === 'agentMessage' && index < lastMessage);
      if (observe) {
        const items = entries.map(e => ({ type: e.item.type, id: e.item.id, startedAtMs: e.startedAtMs, completedAtMs: e.completedAtMs }));
        observe({ event: 'poll', turnId: target, status: found.status, startedAt: found.startedAt, completedAt: found.completedAt, terminal, items });
      }
      if (terminal) { output.finish(found); return found; }
    } else if (Date.now() >= deadline) {
      // 已由桌面版接管且前面还有任务时，排队时间不计作桌面启动超时。
      const [head] = await readQueue();
      const latest = await server.call('thread/turns/list', { ...history, limit: 1 });
      const queuedBehindAnother = head && receipt && head.id !== receipt;
      if (!occupied || !queuedBehindAnother && !executing(latest.data[0]))
        throw Error('Codex 桌面版 60 秒内没有开始执行。任务还在这个对话的队列里，下次在桌面版打开它时会执行');
      if (!ahead) { announce(waiting); ahead = true; }
      deadline = Date.now() + timeout;
    }
    await delay(poll);
  }
}

export async function executeCodex(context, { platform = desktop, poll = 1000, timeout = 60000, observe } = {}) {
  const { home, root, role, id, opts, settings, env, detection, announce, thread, write, spawned } = context;
  if (!detection.installed) throw Error(detection.error ?? '找不到 Codex CLI');
  const git = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { env, encoding: 'utf8', windowsHide: true, shell: false });
  if (git.error) throw git.error;
  if (git.stdout.trim() !== 'true') {
    write({ type: 'error', message: 'Not inside a trusted directory and --skip-git-repo-check was not specified.' });
    throw Error('当前目录不是 git 仓库，Codex 拒绝运行。在项目目录里先运行 git init，或换到已有的 git 仓库再派发。');
  }
  const launcher = detection.launcher;
  const openServer = (primary = true) => connect({ root, env, launcher, spawned: pid => spawned(pid, primary), onError: message => write({ type: 'error', message }) });
  let threadId = opts.thread ?? (!opts.newThread && latestThread(join(home, 'runs.jsonl'), root, role));
  let mode = opts.thread ? 'specified' : threadId ? 'resume' : 'new';
  let runner = !opts.background && await platform.installed(env) ? 'desktop' : 'background';
  let replaced, release, server, published = false;
  function publish() {
    thread({ threadId, mode, runner });
    if (published) return;
    published = true;
    write({ type: 'thread.started', thread_id: threadId });
    announce(replaced ? `对话：上次的对话 ${replaced} 已不存在，已新开 ${threadId}` :
      `对话：${{ new: '新开', specified: '接着指定的对话', resume: '接着上次的对话' }[mode]} ${threadId}`);
    announce(locations[runner]);
  }
  try {
    server = await openServer();
    if (threadId) {
      let exists = validThreadId(threadId);
      if (exists) {
        try {
          await server.call('thread/read', { threadId });
          if (mode === 'resume') {
            const archived = await server.call('thread/list', { archived: true, includedThreadIds: [threadId], limit: 1,
              sourceKinds: ['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'] });
            exists = !archived.data.some(t => t.id === threadId);
          }
        } catch (e) { if (!missing(e)) throw e; exists = false; }
      }
      if (!exists) {
        if (mode === 'specified') throw Error(`找不到指定的对话 ${threadId}`);
        replaced = threadId; threadId = null; mode = 'new';
      }
    }
    if (!threadId) {
      const result = await server.call('thread/start', { cwd: root, ...threadSettings(settings) });
      threadId = result.thread.id;
      if (!validThreadId(threadId)) throw Error('Codex 对话 ID 无效');
      if (runner === 'background') release = await lockThread(home, threadId, id);
      await server.call('thread/name/set', { threadId, name: `派发：${basename(root)}${role ? `（${role}）` : ''}` });
      publish();
      if (runner === 'desktop') {
        const prepared = await ownedTurn(server, threadId, preparation, () => {});
        if (prepared.status !== 'completed') throw Error(prepared.error?.message ?? 'Codex 对话准备失败');
        await server.close(); server = await openServer();
      }
    } else {
      publish();
      if (runner === 'background') {
        release = await lockThread(home, threadId, id, () => announce(waiting));
        try { await server.call('thread/resume', { threadId, cwd: root, ...threadSettings(settings), excludeTurns: true }); }
        catch (e) {
          if (!activeWriter(e)) throw e;
          release(); release = null;
          runner = 'desktop'; publish();
          announce('执行：这个对话在 Codex 桌面版里开着，改为交给桌面版');
        }
      }
    }
    if (runner === 'background') {
      const turn = await ownedTurn(server, threadId, context.prompt, write);
      return { code: turn.status === 'completed' ? 0 : 1 };
    }
    if (mode !== 'new' && context.explicitSettings) announce('执行：接着旧对话时，本次指定的模型、强度、档位、沙箱不生效，按这个对话原来的设置执行');
    const probe = async () => {
      const writer = await openServer(false);
      try { await writer.call('thread/resume', { threadId, excludeTurns: true }); return false; }
      catch (e) { if (activeWriter(e)) return true; throw e; }
      finally { await writer.close(); }
    };
    const turn = await queuedTurn(server, { ...context, launcher }, threadId, platform, probe, poll, timeout, observe);
    return { code: turn.status === 'completed' ? 0 : 1, signal: turn.status === 'interrupted' ? 'stopped-in-codex' : undefined };
  } finally {
    try { await server?.close(); } finally { release?.(); }
  }
}
