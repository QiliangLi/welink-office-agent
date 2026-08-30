import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LockManager } from '../scripts/lib/locks.mjs';

async function lockDirFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'welink-locks-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('acquire creates a lock file with an owner token (F-01 regression)', async (t) => {
  const dir = await lockDirFixture(t);
  const manager = new LockManager(dir);

  await manager.acquire('x');
  const file = path.join(dir, 'x.lock');
  const stat = await fs.stat(file);
  assert.ok(stat.isFile(), 'lock file exists on disk while held');
  const info = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(info.token, 'lock file carries an owner token');
  assert.ok(info.lease_until);

  await manager.release('x');
  await assert.rejects(() => fs.stat(file), { code: 'ENOENT' });
});

test('expired takeover re-races creation and the winner holds a real lock file', async (t) => {
  const dir = await lockDirFixture(t);

  // Simulate a crashed holder: stale lock file with an expired lease.
  const stalePath = path.join(dir, 'y.lock');
  await fs.writeFile(stalePath, JSON.stringify({
    pid: 999999,
    token: 'stale-token',
    acquired_at: new Date(Date.now() - 60_000).toISOString(),
    lease_until: new Date(Date.now() - 30_000).toISOString()
  }), 'utf8');

  const manager = new LockManager(dir);
  await manager.acquire('y');

  // The takeover must have created a fresh lock file owned by us.
  const info = JSON.parse(await fs.readFile(stalePath, 'utf8'));
  assert.equal(info.pid, process.pid);
  assert.notEqual(info.token, 'stale-token');
});

test("a taken-over holder's late release must not delete the new owner's lock", async (t) => {
  const dir = await lockDirFixture(t);
  const filePath = path.join(dir, 'z.lock');

  const oldHolder = new LockManager(dir);
  await oldHolder.acquire('z');
  const oldToken = JSON.parse(await fs.readFile(filePath, 'utf8')).token;

  // Rewrite as a foreign crashed holder: expired lease, different pid.
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  raw.lease_until = new Date(Date.now() - 60_000).toISOString();
  raw.pid = 999999;
  await fs.writeFile(filePath, JSON.stringify(raw), 'utf8');

  const newHolder = new LockManager(dir);
  await newHolder.acquire('z');
  const newToken = JSON.parse(await fs.readFile(filePath, 'utf8')).token;
  assert.notEqual(newToken, oldToken, 'takeover wrote a fresh owner token');

  // The old holder finally wakes up and releases with its stale token.
  await oldHolder.release('z');
  const stillThere = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(stillThere.token, newToken, 'new owner lock survives the stale release');

  // The real owner can still release.
  await newHolder.release('z');
  await assert.rejects(() => fs.stat(filePath), { code: 'ENOENT' });
});

test('live holder is not stolen from before the lease expires', async (t) => {
  const dir = await lockDirFixture(t);
  const a = new LockManager(dir);
  const b = new LockManager(dir);

  await a.acquire('w', { leaseMs: 60_000, acquireTimeoutMs: 200 });
  await assert.rejects(() => b.acquire('w', { leaseMs: 60_000, acquireTimeoutMs: 200 }), /Lock acquire timeout/);
  await a.release('w');
  await b.acquire('w', { acquireTimeoutMs: 200 });
  await b.release('w');
});
