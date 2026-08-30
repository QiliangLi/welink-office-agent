import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../scripts/lib/store.mjs';
import { EventStreamService } from '../server/services/event-stream-service.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'welink-sse-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.initialize();
  return store;
}

function fakeRes() {
  const chunks = [];
  let ended = false;
  return {
    chunks,
    get ended() { return ended; },
    writeHead() {},
    write(chunk) { chunks.push(chunk.toString('utf8')); return true; },
    end() { ended = true; },
    on() {},
    text() { return chunks.join(''); }
  };
}

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const idLine = lines.find((line) => line.startsWith('id: '));
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const dataLine = lines.find((line) => line.startsWith('data: '));
    return {
      id: idLine ? idLine.slice(4) : null,
      event: eventLine ? eventLine.slice(7) : null,
      data: dataLine ? JSON.parse(dataLine.slice(6)) : null
    };
  });
}

test('per-record ids: a mid-batch disconnect never replays the whole batch', async (t) => {
  const store = await fixture(t);
  const stream = new EventStreamService(store, { pollMs: 60_000 });
  await stream.start();
  try {
    for (let index = 0; index < 3; index += 1) {
      await store.logEvent('task_updated', { task_id: `TASK-${index}` });
    }

    const res = fakeRes();
    await stream.addClient(res);
    await stream.tail();
    let messages = parseSse(res.text()).filter((entry) => entry.event !== 'hello');
    assert.equal(messages.length, 3);
    assert.deepEqual(messages.map((entry) => entry.data.taskId), ['TASK-0', 'TASK-1', 'TASK-2']);
    assert.notEqual(messages[0].id, messages[1].id, 'ids advance per record');
    assert.notEqual(messages[1].id, messages[2].id, 'ids advance per record');

    // Reconnect from the FIRST record's cursor: only the remaining records
    // are re-delivered, not the whole batch.
    const first = stream.decodeCursor(messages[0].id);
    const res2 = fakeRes();
    await stream.addClient(res2, stream.encodeCursor(first));
    await stream.tail();
    messages = parseSse(res2.text()).filter((entry) => entry.event !== 'hello');
    assert.deepEqual(messages.map((entry) => entry.data.taskId), ['TASK-1', 'TASK-2']);

    // New events reach an open connection with advancing ids.
    await store.logEvent('task_updated', { task_id: 'TASK-3' });
    await stream.tail();
    messages = parseSse(res.text()).filter((entry) => entry.event !== 'hello');
    assert.equal(messages.length, 4);
    assert.equal(messages[3].data.taskId, 'TASK-3');
  } finally {
    stream.stop();
  }
});

test('garbage or oversized cursors trigger snapshot.required', async (t) => {
  const store = await fixture(t);
  const stream = new EventStreamService(store, { pollMs: 60_000 });
  await stream.start();
  try {
    await store.logEvent('task_updated', { task_id: 'TASK-A' });

    for (const cursor of ['not-a-cursor', 'e30']) {
      const res = fakeRes();
      await stream.addClient(res, cursor);
      const messages = parseSse(res.text());
      assert.equal(messages[0].event, 'snapshot.required', `cursor "${cursor}" forces a snapshot`);
      assert.ok(res.ended, 'connection closes after snapshot.required');
    }

    // Cursor pointing past the file size (log truncation) also forces reload.
    const res = fakeRes();
    const farCursor = stream.encodeCursor({ e: 999_999, m: 999_999 });
    await stream.addClient(res, farCursor);
    const messages = parseSse(res.text());
    assert.equal(messages[0].event, 'snapshot.required', 'truncated log forces a snapshot');
    assert.ok(res.ended);
  } finally {
    stream.stop();
  }
});

test('decodeCursor rejects malformed payloads', async (t) => {
  const store = await fixture(t);
  const stream = new EventStreamService(store);
  try {
    assert.equal(stream.decodeCursor(null), null);
    assert.equal(stream.decodeCursor('aGVsbG8='), null, 'valid base64 but not an offset pair');
    const encoded = stream.encodeCursor({ e: 12, m: 34 });
    assert.deepEqual(stream.decodeCursor(encoded), { e: 12, m: 34 });
  } finally {
    stream.stop();
  }
});
