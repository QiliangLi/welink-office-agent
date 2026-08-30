import crypto from 'node:crypto';
import { conflictError } from '../middleware/error-handler.mjs';

/**
 * Unified persistent idempotency layer (docs §4.4, review F-03). Every POST
 * goes through it with the owner, the route pattern and the client's
 * Idempotency-Key as the unique constraint; the record persists the
 * normalized body fingerprint plus the first response, so replays return
 * the original result and key reuse with different input is rejected.
 *
 * Records live in runtime/idempotency/ as one file per hash. A per-key file
 * lock makes check-place-run atomic for concurrent duplicate requests:
 * losers wait briefly for the winner's result instead of executing twice.
 */

const WAIT_TIMEOUT_MS = 10_000;
const WAIT_INTERVAL_MS = 100;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => key !== '__idempotencyKey').sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
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
   * first result already exists, or { key } after reserving an in-progress
   * placeholder for the caller to complete()/fail().
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
        if (Date.now() >= deadline) {
          throw conflictError('IDEMPOTENCY_CONFLICT', '相同请求仍在处理中，请稍后查询结果。');
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
        continue;
      }

      // Reserve under the per-key lock so two concurrent duplicates cannot
      // both pass the check above.
      const claimed = await this.store.locks.withLocks([`idempotency:${recordKey}`], async () => {
        const recheck = await this.store.readIdempotency(recordKey);
        if (recheck) return false;
        await this.store.writeIdempotency({
          key: recordKey,
          fingerprint,
          route,
          status: 'in_progress',
          created_at: new Date().toISOString()
        });
        return true;
      });
      if (claimed) return { key: recordKey };
      // Lost the race: loop and follow the winner's record.
    }
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

  /** Handler failed: drop the placeholder so the client may safely retry. */
  async fail(recordKey) {
    await this.store.clearIdempotency(recordKey);
  }
}
