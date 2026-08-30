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

/**
 * Exclusive inter-process file locks backed by runtime/.locks/.
 *
 * Lock protocol (docs/frontend-backend-integration.md §5.5):
 * 1. create the lock file with flag "wx" so only one contender wins;
 * 2. persist pid, acquired time and lease deadline inside the lock file;
 * 3. callers re-read the latest snapshot after acquiring;
 * 4. callers check expectedRevision before writing;
 * 5. snapshot writes use temp file + rename;
 * 6. release removes the lock file.
 *
 * A lock whose lease expired is considered abandoned by a crashed process
 * and may be taken over. Never hold a lock across long-running external
 * calls (welink-cli): the lease can expire while the work is still running.
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
      const handle = await this.tryCreate(filePath, leaseMs);
      if (handle) {
        this.held.set(name, { filePath, leaseMs, leasedAt: Date.now() });
        return name;
      }
      const stolen = await this.takeOverIfExpired(filePath);
      if (stolen) {
        this.held.set(name, { filePath, leaseMs, leasedAt: Date.now() });
        return name;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Lock acquire timeout: ${name}`);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  async tryCreate(filePath, leaseMs) {
    try {
      const handle = await fs.open(filePath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          acquired_at: new Date().toISOString(),
          lease_until: new Date(Date.now() + leaseMs).toISOString()
        }), 'utf8');
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  }

  async takeOverIfExpired(filePath) {
    let info;
    try {
      const text = await fs.readFile(filePath, 'utf8');
      info = JSON.parse(text);
    } catch {
      // The holder may have released between EEXIST and read; retry creation.
      return false;
    }
    if (info?.pid === process.pid) return false;
    const leaseUntil = info?.lease_until ? Date.parse(info.lease_until) : 0;
    if (Number.isNaN(leaseUntil) || leaseUntil > Date.now() - STALE_HEARTBEAT_GRACE_MS) return false;
    try {
      await fs.rm(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async release(name) {
    const entry = this.held.get(name);
    if (!entry) return;
    this.held.delete(name);
    try {
      await fs.rm(entry.filePath, { force: true });
    } catch {
      // Best effort: an expired takeover may already have removed the file.
    }
  }

  /**
   * Acquire locks in the given key order, run the callback, then release in
   * reverse order. All callers must request the same canonical order to
   * avoid deadlock: task, approval, item, command (plus slot:* before task).
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
