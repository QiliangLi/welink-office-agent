import crypto from 'node:crypto';
import { conflictError } from '../middleware/error-handler.mjs';

/**
 * Unified persistent idempotency layer (docs §4.4). Every POST goes through
 * it with the owner, the route pattern and the client's Idempotency-Key as
 * the unique constraint; the record persists the normalized body fingerprint
 * plus the first response, so replays return the original result and key
 * reuse with different input is rejected.
 *
 * Placeholder lifecycle (crash-safe, review R-04):
 * - `reserved`: begin() placed the placeholder but the handler has NOT
 *   started — no side effects can exist yet. The lease is short; an expired
 *   reservation is safely taken over by the next identical request.
 * - `running`: the handler is executing — side effects are possible. If the
 *   process dies here the outcome is unknown: replays get a typed 409
 *   (IDEMPOTENCY_CONFLICT, details.phase="unknown_outcome") telling the
 *   client to check the affected aggregate instead of blindly re-executing.
 *   Such records are never auto-deleted; recovery runs through the command
 *   inbox / aggregate status.
 *
 * A per-key file lock makes check-place-run atomic for concurrent duplicate
 * requests: losers wait briefly for the winner's result instead of
 * executing twice.
 */

const RESERVED_LEASE_MS = 60_000;
const RUNNING_LEASE_MS = 5 * 60_000;
const WAIT_TIMEOUT_MS = 10_000;
const WAIT_INTERVAL_MS = 100;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => key !== '__idempotencyKey').sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function newAttemptId() {
  return `ATT-${crypto.randomBytes(8).toString('hex')}`;
}

export class IdempotencyService {
  constructor(store, { owner = null } = {}) {
    this.store = store;
    this.owner = owner ?? 'local';
  }

  /** Unique constraint: owner + route pattern + client key. */
  recordKey(route, key) {
    return crypto.createHash('sha256')
      .update(`${this.owner}::${route}::${key}`)
      .digest('hex')
      .slice(0, 40);
  }

  /** Same key must come with the same target and body to be a replay. */
  fingerprint(pathname, body) {
    return crypto.createHash('sha256')
      .update(`${pathname}::${stableStringify(body ?? {})}`)
      .digest('hex');
  }

  /**
   * Begin or replay. Returns { replay: { statusCode, response } } when the
   * first result already exists, or { key, attemptId } after reserving a
   * placeholder; the caller must invoke markRunning() before executing the
   * handler and complete()/fail() afterwards.
   */
  async begin({ route, key, pathname, body }) {
    const recordKey = this.recordKey(route, key);
    const fingerprint = this.fingerprint(pathname, body);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    for (;;) {
      const existing = await this.store.readIdempotency(recordKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw conflictError('IDEMPOTENCY_CONFLICT', '相同的幂等键已被用于不同的请求，请勿重试并记录 requestId。');
        }
        if (existing.status === 'completed') {
          return { replay: { statusCode: existing.status_code, response: existing.response } };
        }
        if (existing.status === 'running') {
          // The handler of the first request may still be running: wait for
          // it to complete like any other in-flight duplicate. Only an
          // EXPIRED running lease (process died mid-handler) means the
          // outcome is truly unknown — never blind-retry that.
          const leaseUntil = Date.parse(existing.lease_until ?? 0);
          const expired = Number.isNaN(leaseUntil) || leaseUntil <= Date.now();
          if (expired) {
            throw conflictError('IDEMPOTENCY_CONFLICT',
              '上一次相同请求的结果未知，请先查询相关任务或命令状态，不要直接重试。',
              { phase: 'unknown_outcome', attemptId: existing.attempt_id });
          }
          if (Date.now() >= deadline) {
            throw conflictError('IDEMPOTENCY_CONFLICT',
              '上一次相同请求的结果未知，请先查询相关任务或命令状态，不要直接重试。',
              { phase: 'unknown_outcome', attemptId: existing.attempt_id });
          }
          await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
          continue;
        }
        // reserved: expired reservations can be taken over safely (the
        // handler never started); live ones mean another request is racing.
        const leaseUntil = Date.parse(existing.lease_until ?? 0);
        const expired = Number.isNaN(leaseUntil) || leaseUntil <= Date.now();
        if (!expired) {
          if (Date.now() >= deadline) {
            throw conflictError('IDEMPOTENCY_CONFLICT', '相同请求仍在处理中，请稍后查询结果。');
          }
          await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
          continue;
        }
      }

      // Reserve (or take over an expired reservation) under the per-key
      // lock so two concurrent duplicates cannot both pass the check.
      const attemptId = newAttemptId();
      const claimed = await this.store.locks.withLocks([`idempotency:${recordKey}`], async () => {
        const recheck = await this.store.readIdempotency(recordKey);
        if (recheck) {
          if (recheck.status !== 'reserved') return false;
          const leaseUntil = Date.parse(recheck.lease_until ?? 0);
          if (!Number.isNaN(leaseUntil) && leaseUntil > Date.now()) return false;
        }
        await this.store.writeIdempotency({
          key: recordKey,
          fingerprint,
          route,
          status: 'reserved',
          attempt_id: attemptId,
          lease_until: new Date(Date.now() + RESERVED_LEASE_MS).toISOString(),
          created_at: recheck?.created_at ?? new Date().toISOString()
        });
        return true;
      });
      if (claimed) return { key: recordKey, attemptId };
      // Lost the race: loop and follow the winner's record.
    }
  }

  /**
   * The request that owns the reservation announces handler execution.
   * If the placeholder changed hands meanwhile, the caller must abort.
   */
  async markRunning(recordKey, attemptId) {
    return this.store.locks.withLocks([`idempotency:${recordKey}`], async () => {
      const record = await this.store.readIdempotency(recordKey);
      if (!record || record.status !== 'reserved' || record.attempt_id !== attemptId) {
        throw conflictError('IDEMPOTENCY_CONFLICT', '幂等占位已被其他请求接管，请勿重试。');
      }
      await this.store.writeIdempotency({
        ...record,
        status: 'running',
        lease_until: new Date(Date.now() + RUNNING_LEASE_MS).toISOString()
      });
    });
  }

  async complete(recordKey, statusCode, response) {
    const existing = await this.store.readIdempotency(recordKey);
    if (!existing) return;
    await this.store.writeIdempotency({
      ...existing,
      status: 'completed',
      status_code: statusCode,
      response: response ?? null,
      completed_at: new Date().toISOString()
    });
  }

  /**
   * Handler failed: drop the placeholder so the client may safely retry.
   * Only our own reservation is removed — never someone else's record.
   */
  async fail(recordKey, attemptId = null) {
    return this.store.locks.withLocks([`idempotency:${recordKey}`], async () => {
      const existing = await this.store.readIdempotency(recordKey);
      if (!existing) return;
      if (attemptId && existing.attempt_id !== attemptId) return;
      await this.store.clearIdempotency(recordKey);
    });
  }
}
