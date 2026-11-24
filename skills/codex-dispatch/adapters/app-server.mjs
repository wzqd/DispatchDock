import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function refusal(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': return { decision: 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval': return { decision: { denied: { rejection: '非交互派发拒绝审批' } } };
    case 'item/permissions/requestApproval': return { permissions: {}, scope: 'turn' };
    case 'mcpServer/elicitation/request': return { action: 'decline', content: null, _meta: null };
  }
}

// 每个实例只持有自己的子进程；关闭后才允许另一个写入者接手。
export async function connect({ launcher, root, env, spawned, onError = () => {} }) {
  const child = spawn(launcher.executable, [...launcher.args, 'app-server'], {
    cwd: root, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const retired = spawned?.(child.pid);
  let next = 0, failure, stderr = '';
  const pending = new Map(), listeners = new Set();
  const closed = new Promise(resolve => child.once('close', resolve));
  closed.then(() => retired?.());
  const failed = new Promise(resolve => {
    const fail = error => {
      failure ??= error;
      for (const p of pending.values()) p.reject(failure);
      pending.clear();
      resolve(failure);
    };
    child.once('error', fail);
    child.stdin.on('error', fail);
    closed.then(code => fail(Error(stderr.trim() || `Codex app-server 已退出（${code}）`)));
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', s => { stderr = (stderr + s).slice(-4096); });
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const call = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Codex 请求超时：${method}`)); }, 30000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(e) { clearTimeout(timer); reject(e); } });
    send({ id, method, params });
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && m.method) {
      const result = refusal(m.method);
      send(result ? { id: m.id, result } : { id: m.id, error: { code: -32601, message: '非交互派发不处理这个请求' } });
      onError(`已拒绝 Codex 请求：${m.method}`);
    } else if (m.id != null) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(Error(m.error.message)); else p?.resolve(m.result);
    } else {
      for (const listener of listeners) listener(m.method, m.params);
    }
  });
  async function close() {
    child.stdin.end();
    await closed;
  }
  try {
    await call('initialize', { clientInfo: { name: 'dispatchdock', title: 'DispatchDock', version: '0.1.11' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    return { call, close, listeners, failed };
  } catch (error) { await close(); throw error; }
}

export async function* pages(server, method, params) {
  let cursor;
  do {
    const page = await server.call(method, { ...params, limit: 50, ...(cursor ? { cursor } : {}) });
    yield* page.data;
    cursor = page.nextCursor;
  } while (cursor);
}
