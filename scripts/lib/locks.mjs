import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './utils.mjs';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 50;
const STALE_HEARTBEAT_GRACE_MS = 5_000;

function lockFileName(name) {
  return `${name.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.lock`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newOwnerToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Exclusive inter-process file locks backed by runtime/.locks/.
 *
 * Protocol (docs/frontend-backend-integration.md §5.5):
 * 1. create the lock file with flag "wx" so only one contender wins;
 * 2. persist pid, a random owner token, acquired time and lease deadline;
 * 3. callers re-read the latest snapshot after acquiring;
 * 4. callers check expectedRevision before writing;
 * 5. snapshot writes use temp file + rename;
 * 6. release removes the lock file ONLY if the stored owner token still
 *    matches, so a late release from a crashed-and-taken-over holder can
 *    never delete the new holder's lock.
 *
 * Taking over an expired lock means: remove the stale file, then fall
 * through to the normal "wx" creation race. The winner of that race — not
 * the process that happened to delete the stale file — owns the lock, so
 * there is never a window where the critical section runs unprotected.
 *
 * Never hold a lock across long-running external calls (welink-cli): the
 * lease can expire while the work is still running.
 */
export class LockManager {
  constructor(lockDir) {
    this.lockDir = lockDir;
    this.held = new Map();
  }

  lockPath(name) {
    return path.join(this.lockDir, lockFileName(name));
  }

  async acquire(name, { leaseMs = DEFAULT_LEASE_MS, acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS } = {}) {
    await ensureDir(this.lockDir);
    const filePath = this.lockPath(name);
    const deadline = Date.now() + acquireTimeoutMs;

    for (;;) {
      const token = newOwnerToken();
      if (await this.tryCreate(filePath, leaseMs, token)) {
        this.held.set(name, { filePath, token });
        return name;
      }
      await this.takeOverIfExpired(filePath);
      if (Date.now() >= deadline) {
        throw new Error(`Lock acquire timeout: ${name}`);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  async tryCreate(filePath, leaseMs, token) {
    let handle;
    try {
      handle = await fs.open(filePath, 'wx');
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        token,
        acquired_at: new Date().toISOString(),
        lease_until: new Date(Date.now() + leaseMs).toISOString()
      }), 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  }

  /**
   * Remove a lock file whose lease has expired. This does NOT grant the
   * lock — the caller loops back into the "wx" creation race, and whichever
   * process wins that race becomes the owner.
   */
  async takeOverIfExpired(filePath) {
    let info;
    try {
      info = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      // The holder may be mid-write (file exists but content not flushed
      // yet) — never delete a lock we cannot read; retry instead.
      return;
    }
    if (info?.pid === process.pid) {
      // Never steal a lock owned by this process: a same-process re-entrant
      // acquire is a bug we want to surface as an acquire timeout, not
      // silently corrupt.
      return;
    }
    const leaseUntil = info?.lease_until ? Date.parse(info.lease_until) : 0;
    if (Number.isNaN(leaseUntil) || leaseUntil > Date.now() - STALE_HEARTBEAT_GRACE_MS) return;
    try {
      await fs.rm(filePath, { force: true });
    } catch { /* another contender removed it first */ }
  }

  /** Release only if we still own the lock (owner token matches). */
  async release(name) {
    const entry = this.held.get(name);
    if (!entry) return;
    this.held.delete(name);
    let info = null;
    try {
      info = JSON.parse(await fs.readFile(entry.filePath, 'utf8'));
    } catch {
      return; // Already gone or unreadable: nothing to remove.
    }
    if (info?.token !== entry.token) return; // A new owner took over.
    try {
      await fs.rm(entry.filePath, { force: true });
    } catch { /* ignore */ }
  }

  /**
   * Acquire locks in the given key order, run the callback, then release in
   * reverse order. All callers must request the same canonical order to
   * avoid deadlock: slot:<contactKey> before task, then
   * task -> approval -> item -> command -> conversation -> action -> state.
   * State must only ever be the innermost (last-acquired) lock.
   */
  async withLocks(keys, callback, options = {}) {
    const acquired = [];
    try {
      for (const key of keys) {
        await this.acquire(key, options);
        acquired.push(key);
      }
      return await callback();
    } finally {
      for (const key of acquired.reverse()) {
        await this.release(key);
      }
    }
  }
}
