import { makeId } from './ids.mjs';
import { nowIso } from './utils.mjs';

export const COMMAND_TYPES = [
  'task.create',
  'task.resume',
  'task.cancel',
  'task.instruction',
  'task.retry',
  'subtask.remind',
  'approval.apply'
];

export const COMMAND_STATUSES = ['queued', 'claimed', 'waiting_agent', 'succeeded', 'failed', 'cancelled'];

const DEFAULT_LEASE_MS = 5 * 60_000;

/**
 * Persistent command inbox (runtime/commands/*.json). Every console write
 * that needs durable, at-most-once processing lands here first; the host
 * Agent tick claims commands and either executes deterministic parts
 * directly or hands reasoning work back to the host Agent loop.
 *
 * State machine (transitions are monotonic):
 *
 *   queued -> claimed -> succeeded|failed|cancelled
 *                     \-> waiting_agent(delivered) -> acked -> executing
 *                                                  \-> cancelled
 *
 * - `delivered`: tick output the assignment; the lease still applies, so a
 *   crashed host gets the assignment redelivered (back to queued).
 * - `acked`: the host confirmed ownership via ack-command. Acked commands
 *   are NOT redelivered automatically (that could double-apply work) — a
 *   restarted host picks them up through the `resume` listing.
 * - `executing`: the host announced real work via begin-command. Cancellation
 *   no longer revokes it; the host re-checks the persisted task status and
 *   reports the outcome with complete-command.
 * - Task cancellation revokes queued/claimed/delivered/acked commands whose
 *   parent task matches; executing ones stay with the host. `complete`/
 *   `failed` on a cancelled command is a no-op.
 *
 * Lock protocol: EVERY transition re-reads the record and validates the
 * transition while holding the `command:<id>` record lock. Scanning paths
 * (claim/recover/cancel) hold the `commands` collection lock first and then
 * take each record's lock one by one (collection before record, never the
 * reverse), so a racing single-record writer — ack, begin, complete — can
 * never be overwritten by a stale snapshot. Cancellation additionally
 * matches on the stable `parent_task_id`, which covers commands whose
 * aggregate is an approval/item rather than the task itself.
 */
export class CommandService {
  constructor(store) {
    this.store = store;
  }

  async findByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) return null;
    return this.store.locks.withLocks(['commands'], async () => {
      const commands = await this.store.listCommands();
      return commands.find((command) => command.idempotency_key === idempotencyKey) ?? null;
    });
  }

  async create({ type, aggregateType, aggregateId, payload = {}, idempotencyKey = null, requestedBy = null, parentTaskId = null }) {
    if (!COMMAND_TYPES.includes(type)) throw new Error(`Unsupported command type: ${type}`);
    return this.store.locks.withLocks(['commands'], async () => {
      const commands = await this.store.listCommands();

      if (idempotencyKey) {
        const existing = commands.find((command) => command.idempotency_key === idempotencyKey);
        if (existing) {
          const samePayload = JSON.stringify(existing.payload ?? {}) === JSON.stringify(payload);
          if (!samePayload) {
            const error = new Error('Idempotency key reused with a different payload.');
            error.code = 'IDEMPOTENCY_CONFLICT';
            throw error;
          }
          return { command: existing, replayed: true };
        }
      }

      const command = {
        schema_version: 1,
        revision: 1,
        command_id: makeId('CMD'),
        type,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        parent_task_id: parentTaskId,
        idempotency_key: idempotencyKey,
        requested_by_employee_number: requestedBy,
        payload,
        status: 'queued',
        assignment_state: null,
        attempts: 0,
        claimed_by: null,
        claimed_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        completed_at: null,
        error: null
      };
      await this.store.saveCommand(command);
      await this.store.logEvent('command_created', {
        command_id: command.command_id,
        command_type: type,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        parent_task_id: parentTaskId
      });
      return { command, replayed: false };
    });
  }

  /**
   * Claim the next queued command matching the filters. The candidate is
   * re-read and re-validated under its record lock before the write, so a
   * concurrent single-record writer always wins or loses atomically.
   */
  async claimNext({ types = null, aggregateTypes = null, workerId, leaseMs = DEFAULT_LEASE_MS, skipCommandIds = [] } = {}) {
    return this.store.locks.withLocks(['commands'], async () => {
      await this.recoverExpiredLeasesUnsafe();
      const skip = new Set(skipCommandIds);
      const commands = await this.store.listCommands();
      const queued = commands
        .filter((command) => command.status === 'queued')
        .filter((command) => !skip.has(command.command_id))
        .filter((command) => !types || types.includes(command.type))
        .filter((command) => !aggregateTypes || aggregateTypes.includes(command.aggregate_type))
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.command_id.localeCompare(right.command_id));

      for (const candidate of queued) {
        const claimed = await this.store.locks.withLocks([`command:${candidate.command_id}`], async () => {
          const current = await this.store.loadCommand(candidate.command_id);
          if (!current || current.status !== 'queued') return null; // Raced away.
          current.status = 'claimed';
          current.claimed_by = workerId;
          current.claimed_at = nowIso();
          current.attempts += 1;
          current.lease_until = new Date(Date.now() + leaseMs).toISOString();
          await this.store.saveCommand(current);
          await this.store.logEvent('command_updated', { command_id: current.command_id, status: 'claimed' });
          return current;
        });
        if (claimed) return claimed;
      }
      return null;
    });
  }

  /** Give a claimed command back to the queue without executing it. */
  async releaseClaim(commandId) {
    return this.store.mutateCommand(commandId, null, (command) => {
      if (command.status !== 'claimed') return; // Monotonic: never un-cancel/un-complete.
      command.status = 'queued';
      command.claimed_by = null;
      command.claimed_at = null;
      command.lease_until = null;
    });
  }

  /**
   * Deterministic part finished; the host Agent still owes reasoning or an
   * external action. Only a claimed command may become an assignment, and
   * the lease is kept: delivered-but-unacked assignments are redelivered
   * after the lease expires. Returns the record — callers MUST check
   * `record.status === 'waiting_agent'` before treating the assignment as
   * delivered (a cancelled command stays cancelled).
   */
  async markWaitingAgent(commandId, { leaseMs = DEFAULT_LEASE_MS } = {}) {
    return this.store.mutateCommand(commandId, null, (command) => {
      if (command.status !== 'claimed') return;
      command.status = 'waiting_agent';
      command.assignment_state = 'delivered';
      command.lease_until = new Date(Date.now() + leaseMs).toISOString();
    });
  }

  /** Host Agent confirms ownership of the assignment (delivered -> acked). */
  async ackCommand(commandId) {
    return this.store.mutateCommand(commandId, null, (command) => {
      if (command.status !== 'waiting_agent' || command.assignment_state !== 'delivered') {
        const error = new Error(`Command is not a delivered assignment: ${commandId}`);
        error.code = 'INVALID_STATE_TRANSITION';
        throw error;
      }
      command.assignment_state = 'acked';
      command.acked_at = nowIso();
    });
  }

  /**
   * Host announces it is starting the real work (acked -> executing).
   * Executing assignments are exempt from cancellation revocation — the
   * host re-checks the persisted task status and reports the outcome.
   */
  async beginCommand(commandId) {
    return this.store.mutateCommand(commandId, null, (command) => {
      if (command.status !== 'waiting_agent' || !['acked', 'delivered'].includes(command.assignment_state)) {
        const error = new Error(`Command is not an acked assignment: ${commandId}`);
        error.code = 'INVALID_STATE_TRANSITION';
        throw error;
      }
      command.assignment_state = 'executing';
      command.execution_started_at = nowIso();
    });
  }

  async complete(commandId, { status = 'succeeded', error = null } = {}) {
    return this.store.mutateCommand(commandId, null, (command) => {
      // Monotonic: cancellation always wins; nothing resurrects it.
      if (!['claimed', 'waiting_agent'].includes(command.status)) return;
      command.status = status;
      command.error = error;
      command.completed_at = nowIso();
      command.lease_until = null;
      command.claimed_by = null;
    });
  }

  /** Public recovery path (tick start); see claimNext for the locked inner call. */
  async recoverExpiredLeases() {
    return this.store.locks.withLocks(['commands'], () => this.recoverExpiredLeasesUnsafe());
  }

  /**
   * Must run under the `commands` lock. Only CLAIMED and delivered
   * assignments are redeliverable — acked/executing ones belong to the host
   * and are surfaced through the `resume` listing instead. Each candidate
   * is re-read under its record lock and re-validated, so a concurrent
   * ack/begin that lands before the write is never overwritten.
   */
  async recoverExpiredLeasesUnsafe() {
    const commands = await this.store.listCommands();
    const now = Date.now();
    const recovered = [];
    for (const command of commands) {
      const redeliverable = command.status === 'claimed' ||
        (command.status === 'waiting_agent' && command.assignment_state === 'delivered');
      if (!redeliverable || !command.lease_until) continue;
      const leaseUntil = Date.parse(command.lease_until);
      if (!Number.isNaN(leaseUntil) && leaseUntil > now) continue;

      const previousStatus = command.status;
      const recoveredId = await this.store.locks.withLocks([`command:${command.command_id}`], async () => {
        const current = await this.store.loadCommand(command.command_id);
        if (!current) return null;
        const stillRedeliverable = current.status === 'claimed' ||
          (current.status === 'waiting_agent' && current.assignment_state === 'delivered');
        if (!stillRedeliverable) return null; // Raced with ack/begin/cancel.
        const currentLease = Date.parse(current.lease_until ?? 0);
        if (!Number.isNaN(currentLease) && currentLease > Date.now()) return null;
        current.status = 'queued';
        current.assignment_state = null;
        current.claimed_by = null;
        current.claimed_at = null;
        current.lease_until = null;
        await this.store.saveCommand(current);
        await this.store.logEvent('command_lease_recovered', { command_id: current.command_id, previous_status: previousStatus });
        return current.command_id;
      });
      if (recoveredId) recovered.push(recoveredId);
    }
    return recovered;
  }

  /**
   * Cancel every command of a task the host is not already executing.
   * Matching uses the stable `parent_task_id` (set on creation for every
   * command derived from a task, including approval.apply whose aggregate
   * is the approval) with a fallback to direct task aggregates for older
   * records. Queued/claimed are always revoked; waiting_agent assignments
   * are revoked in the delivered AND acked states; executing assignments
   * stay with the host.
   */
  async cancelQueuedForAggregate(aggregateType, aggregateId) {
    return this.store.locks.withLocks(['commands'], async () => {
      const commands = await this.store.listCommands();
      const cancelled = [];
      for (const command of commands) {
        const belongsToTask = command.parent_task_id === aggregateId ||
          (command.aggregate_type === aggregateType && command.aggregate_id === aggregateId);
        if (!belongsToTask) continue;
        const revocable = ['queued', 'claimed'].includes(command.status) ||
          (command.status === 'waiting_agent' && command.assignment_state !== 'executing');
        if (!revocable) continue;
        // Re-read and validate under the record lock so a concurrent
        // single-command writer cannot interleave between check and write.
        const cancelledId = await this.store.locks.withLocks([`command:${command.command_id}`], async () => {
          const current = await this.store.loadCommand(command.command_id);
          if (!current) return null;
          const currentBelongsTo = current.parent_task_id === aggregateId ||
            (current.aggregate_type === aggregateType && current.aggregate_id === aggregateId);
          if (!currentBelongsTo) return null;
          const stillRevocable = ['queued', 'claimed'].includes(current.status) ||
            (current.status === 'waiting_agent' && current.assignment_state !== 'executing');
          if (!stillRevocable) return null;
          current.status = 'cancelled';
          current.assignment_state = null;
          current.completed_at = nowIso();
          current.error = { code: 'AGGREGATE_CANCELLED', message: '任务已取消，命令不再执行。' };
          await this.store.saveCommand(current);
          await this.store.logEvent('command_cancelled', { command_id: current.command_id, aggregate_id: aggregateId });
          return current.command_id;
        });
        if (cancelledId) cancelled.push(cancelledId);
      }
      return cancelled;
    });
  }

  async listActiveForAggregate(aggregateType, aggregateId) {
    const commands = await this.store.listCommands();
    return commands
      .filter((command) => command.aggregate_type === aggregateType && command.aggregate_id === aggregateId)
      .filter((command) => ['queued', 'claimed', 'waiting_agent'].includes(command.status))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }
}
