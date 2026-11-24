import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { reverseRows, repoKey, findTerminal } from './wait.mjs';
import { pidAlive, processCreated } from './process.mjs';
import { validThreadId } from './paths.mjs';

export function latestThread(file, root, role) {
  const pending = new Map(), key = repoKey(root);
  let best = null, order = 0;
  for (const row of reverseRows(file)) {
    if (row.event === 'thread' && validThreadId(row.threadId) && !pending.has(row.id))
      pending.set(row.id, { threadId: row.threadId, order: ++order });
    if (row.event !== 'start' || !pending.has(row.id)) continue;
    const candidate = pending.get(row.id);
    if ((!best || candidate.order < best.order) && (row.role ?? null) === role && typeof row.repo === 'string' && repoKey(row.repo) === key) best = candidate;
    pending.delete(row.id);
    if (best && ![...pending.values()].some(p => p.order < best.order)) break;
  }
  return best?.threadId;
}

// 旧历史有时没有客户端消息 ID。只有没有同标题的重叠派发时才允许按全文匹配。
export function overlappingDispatch(file, id, threadId, title, since) {
  const threads = new Set(), finished = new Set();
  for (const row of reverseRows(file)) {
    if (row.id === id) continue;
    if (['end','interrupted'].includes(row.event) && row.at < since) finished.add(row.id);
    if (finished.has(row.id)) continue;
    if (row.event === 'thread' && row.threadId === threadId) threads.add(row.id);
    if (row.event === 'start' && threads.has(row.id) && row.title === title) return true;
  }
  return false;
}

export function taskThread(file, id) {
  for (const row of reverseRows(file)) {
    if (row.id !== id) continue;
    if (row.event === 'thread') return row;
    if (row.event === 'start') break;
  }
}

// thread 行的追加顺序就是后台到达顺序。等待者退出或转交桌面后不再占队。
async function waitForPredecessors(home, threadId, id, announce) {
  const file = join(home, 'runs.jsonl'), seen = new Set(), pending = new Set(), starts = [];
  let beforeUs = false;
  for (const row of reverseRows(file)) {
    if (row.id === id && row.event === 'thread') { beforeUs = true; continue; }
    if (row.event === 'end' || row.event === 'interrupted') seen.add(row.id);
    if (row.event === 'thread' && !seen.has(row.id)) {
      seen.add(row.id);
      if (beforeUs && row.threadId === threadId && row.runner === 'background') pending.add(row.id);
    }
    if (row.event === 'start' && pending.delete(row.id) && pidAlive(row.pid)) starts.push(row);
  }
  for (const start of starts.reverse()) {
    let nextIdentityCheck = Date.now() + 1000;
    while (pidAlive(start.pid) && !findTerminal(file, start.id) && taskThread(file, start.id)?.runner === 'background') {
      if (Date.now() >= nextIdentityCheck) {
        const created = await processCreated(start.pid);
        if (created !== null && created > start.started) break;
        nextIdentityCheck = Date.now() + 10000;
      }
      announce();
      await delay(100);
    }
  }
}

export async function lockThread(home, threadId, id, waiting) {
  if (!validThreadId(threadId)) throw Error('Codex 对话 ID 无效');
  const notify = () => { waiting?.(); waiting = null; };
  if (waiting) await waitForPredecessors(home, threadId, id, notify);
  const dir = join(home, 'threads');
  mkdirSync(dir, { recursive: true });
  // 先写完整身份，再独占发布。即使在发布中被停止也不会留下空锁。
  const temp = join(dir, randomUUID() + '.tmp');
  const owner = { id, pid: process.pid, at: Date.now() };
  writeFileSync(temp, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  function read(file) {
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function acquire(file) {
    let nextIdentityCheck = Date.now() + 1000;
    for (;;) {
      try { linkSync(temp, file); return () => unlinkSync(file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const old = read(file);
      if (!old) continue;
      let alive = pidAlive(old.pid);
      // 长时间等待时再核对创建时间，以免 PID 被无关进程复用后永久占锁。
      if (alive && Date.now() >= nextIdentityCheck) {
        nextIdentityCheck = Date.now() + 10000;
        const created = await processCreated(old.pid);
        if (created !== null && created > old.at) alive = false;
      }
      if (!alive) {
        // 两个等待者同时发现死锁时，串行核对旧身份，避免删掉刚接手者的锁。
        const release = await acquire(file + '.reap');
        try {
          const current = read(file);
          if (current && current.pid === old.pid && current.id === old.id && current.at === old.at) unlinkSync(file);
        } finally { release(); }
      } else {
        notify();
        await delay(100);
      }
    }
  }
  try { return await acquire(join(dir, threadId + '.lock')); } finally { unlinkSync(temp); }
}
