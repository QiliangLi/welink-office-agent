/**
 * SSE fan-out over the JSONL logs (docs §8). Each connection keeps its own
 * byte-offset pair {e, m} into events.jsonl / messages.jsonl, encoded as
 * the SSE id and accepted back via Last-Event-ID, so a reconnecting client
 * resumes exactly where it left off without rewinding anyone else. Event
 * ids advance per record (not per batch), so a mid-batch disconnect never
 * replays or skips notifications. Only complete newline-terminated records
 * are read; fs.watch triggers a tail and a short interval is the fallback.
 * A client whose cursor is unusable or points past the current file (log
 * truncation/rotation) receives `snapshot.required` and reloads everything.
 */
export class EventStreamService {
  constructor(store, { heartbeatMs = 20_000, pollMs = 1_000 } = {}) {
    this.store = store;
    this.heartbeatMs = heartbeatMs;
    this.pollMs = pollMs;
    this.clients = new Set();
    this.offsets = { e: 0, m: 0 };
    this.timer = null;
    this.heartbeatTimer = null;
    this.watcher = null;
  }

  encodeCursor(offsets) {
    return Buffer.from(JSON.stringify(offsets), 'utf8').toString('base64url');
  }

  decodeCursor(id) {
    if (!id) return null;
    try {
      const parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
      if (typeof parsed?.e !== 'number' || typeof parsed?.m !== 'number') return null;
      return { e: parsed.e, m: parsed.m };
    } catch {
      return null;
    }
  }

  async fileSize(name) {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const { size } = await fs.stat(path.join(this.store.paths().logs, name));
      return size;
    } catch {
      return 0;
    }
  }

  async start() {
    this.offsets = { e: await this.fileSize('events.jsonl'), m: await this.fileSize('messages.jsonl') };
    this.timer = setInterval(() => { this.tail().catch(() => {}); }, this.pollMs);
    try {
      const fsWatch = await import('node:fs');
      this.watcher = fsWatch.watch(this.store.paths().logs, () => { this.tail().catch(() => {}); });
    } catch {
      // Polling alone is an acceptable fallback.
    }
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        client.res.write(':heartbeat\n\n');
      }
    }, this.heartbeatMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    for (const client of this.clients) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  async addClient(res, lastEventId = null) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const decoded = this.decodeCursor(lastEventId);
    if (lastEventId && !decoded) {
      // The cursor can no longer be trusted (rotation/loss): force a reload.
      this.write(res, 'snapshot.required', { reason: 'cursor_invalid' }, this.encodeCursor(this.offsets));
      res.end();
      return;
    }

    const offsets = decoded ?? { ...this.offsets };
    // A cursor pointing past the current file means the log was truncated
    // or rotated: the client must reload instead of resuming.
    if ((offsets.e > await this.fileSize('events.jsonl')) || (offsets.m > await this.fileSize('messages.jsonl'))) {
      this.write(res, 'snapshot.required', { reason: 'cursor_invalid' }, this.encodeCursor(this.offsets));
      res.end();
      return;
    }

    const client = { res, offsets };
    this.clients.add(client);
    res.on('close', () => this.clients.delete(client));
    this.write(res, 'hello', { serverTime: new Date().toISOString() }, this.encodeCursor(client.offsets));
    // Deliver anything recorded since the client's cursor before returning,
    // so callers that await see a consistent first flush.
    await this.tailClient(client);
  }

  write(res, event, data, id) {
    try {
      if (id) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Connection already gone; cleanup happens on 'close'.
    }
  }

  async tail() {
    for (const client of [...this.clients]) {
      await this.tailClient(client);
    }
  }

  async tailClient(client) {
    const eventsLog = await this.store.readJsonl('events.jsonl', { startOffset: client.offsets.e });
    eventsLog.entries.forEach((entry, index) => {
      const cursor = this.encodeCursor({ e: eventsLog.entryOffsets[index], m: client.offsets.m });
      for (const mapped of mapRuntimeEvent(entry)) {
        this.write(client.res, mapped.event, mapped.data, cursor);
      }
    });
    if (eventsLog.entries.length > 0) client.offsets.e = eventsLog.offset;

    const messagesLog = await this.store.readJsonl('messages.jsonl', { startOffset: client.offsets.m });
    messagesLog.entries.forEach((entry, index) => {
      const cursor = this.encodeCursor({ e: client.offsets.e, m: messagesLog.entryOffsets[index] });
      this.write(client.res, 'message.received', {
        taskId: entry.task_id ?? null,
        direction: entry.direction ?? null
      }, cursor);
    });
    if (messagesLog.entries.length > 0) client.offsets.m = messagesLog.offset;
  }
}

function mapRuntimeEvent(entry) {
  const taskPayload = () => ({ taskId: entry.task_id ?? null });
  switch (entry.type) {
    case 'task_created':
    case 'task_created_from_console':
      return [{ event: 'task.created', data: taskPayload() }];
    case 'task_completed':
      return [{ event: 'task.completed', data: taskPayload() }];
    case 'task_updated':
    case 'task_paused':
    case 'task_cancelled':
    case 'subtask_created':
    case 'subtask_updated':
    case 'task_instruction_added':
    case 'dynamic_item_detected':
    case 'dynamic_item_classified':
      return [{ event: 'task.updated', data: taskPayload() }];
    case 'contact_slot_wait':
    case 'contact_slot_released':
    case 'contact_slot_acquired':
      return [
        { event: 'task.updated', data: taskPayload() },
        { event: 'task.queue.updated', data: taskPayload() }
      ];
    case 'approval_created':
      return [{ event: 'approval.created', data: { taskId: entry.task_id ?? null, approvalId: entry.approval_id ?? null } }];
    case 'approval_resolved':
      return [{ event: 'approval.resolved', data: { taskId: entry.task_id ?? null, approvalId: entry.approval_id ?? null } }];
    case 'command_created':
    case 'command_updated':
    case 'command_cancelled':
    case 'command_lease_recovered':
    case 'command_acknowledged':
    case 'command_execution_started':
      return [{ event: 'command.updated', data: { commandId: entry.command_id ?? null, taskId: entry.aggregate_id ?? null } }];
    case 'action_started':
    case 'action_finished':
    case 'action_marked_unknown':
      return [{ event: 'action.updated', data: { actionId: entry.action_id ?? null, taskId: entry.task_id ?? null } }];
    case 'message_attributed':
      return [{ event: 'message.attributed', data: { taskId: entry.task_id ?? null, conversationId: entry.conversation_id ?? null } }];
    case 'conversation_opened':
    case 'conversation_closed':
      return [{ event: 'conversation.updated', data: { conversationId: entry.conversation_id ?? null, taskId: entry.task_id ?? null } }];
    default:
      return [];
  }
}
