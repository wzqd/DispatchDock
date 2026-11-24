// 后台通知和桌面历史共用同一个转换器，再交给原有 exec 映射。
function execItem(i) {
  const { id } = i;
  switch (i.type) {
    case 'agentMessage': return { id, type: 'agent_message', text: i.text };
    case 'reasoning': return { id, type: 'reasoning', text: (i.summary?.length ? i.summary : i.content ?? []).join('\n') };
    case 'commandExecution': return { id, type: 'command_execution', command: i.command, aggregated_output: i.aggregatedOutput ?? '', exit_code: i.exitCode ?? null, status: i.status === 'inProgress' ? 'in_progress' : i.status };
    case 'fileChange': return { id, type: 'file_change', changes: i.changes.map(f => ({ kind: f.kind.type, path: f.path })), status: i.status };
    case 'webSearch': return { id, type: 'web_search', query: i.query };
    case 'mcpToolCall': return { id, type: 'mcp_tool_call', server: i.server, tool: i.tool, arguments: i.arguments, result: i.result, error: i.error, status: i.status === 'inProgress' ? 'in_progress' : i.status };
  }
}

export function turnOutput(write) {
  const emitted = new Set();
  let usage, planStarted = false;
  function item(i, done) {
    const value = execItem(i);
    if (!value) return;
    const type = done ? 'item.completed' : 'item.started';
    const key = type + ':' + i.id;
    if (emitted.has(key)) return;
    emitted.add(key);
    write({ type, item: value });
  }
  return {
    start() { write({ type: 'turn.started' }); },
    notify(method, params) {
      if (method === 'item/started' || method === 'item/completed') item(params.item, method === 'item/completed');
      if (method === 'thread/tokenUsage/updated') usage = params.tokenUsage.last;
      if (method === 'turn/plan/updated') {
        write({ type: planStarted ? 'item.updated' : 'item.started', item: { id: 'plan-' + params.turnId, type: 'todo_list', items: params.plan.map(p => ({ text: p.step, completed: p.status === 'completed' })) } });
        planStarted = true;
      }
      if (method === 'error' && !params.willRetry) write({ type: 'error', message: params.error.message });
    },
    snapshot(entry, terminal) {
      const i = entry.item;
      if (['commandExecution', 'webSearch', 'mcpToolCall'].includes(i.type)) {
        item({ ...i, status: 'inProgress', aggregatedOutput: '', exitCode: null }, false);
      }
      // 历史快照里的文本可能还在增长，等条目完成时间或整轮结束再发最终文本。
      if (terminal || entry.completedAtMs != null || i.completedAtMs != null || ['completed','failed','declined'].includes(i.status)) item(i, true);
    },
    finish(turn) {
      if (turn.status === 'completed') write({ type: 'turn.completed', usage: { input_tokens: usage?.inputTokens ?? null, cached_input_tokens: usage?.cachedInputTokens ?? null, output_tokens: usage?.outputTokens ?? null } });
      if (turn.status === 'failed') write({ type: 'turn.failed', error: { message: turn.error?.message ?? 'Codex 执行失败' } });
    },
  };
}
