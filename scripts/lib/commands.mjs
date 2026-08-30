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
 * Assignment delivery (waiting_agent): a command handed to the host Agent
 * keeps its lease and is marked `delivered`. The host confirms ownership
 * with ackCommand() (assignment_state='acked', lease cleared). Commands
 * delivered but not acked before their lease expires are returned to
 * queued, so a crashed host gets the assignment redelivered. Acked
 * assignments are never re-queued or cancelled by task cancellation — the
 * host already owns them and must re-check task status before acting.
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

  async create({ type, aggregateType, aggregateId, payload = {}, idempotencyKey = null, requestedBy = null }) {
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
        idempotency_key: idempotencyKey,
        requested_by_employee_number: requestedBy,
        payload,
        status: 'queued',
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
        aggregate_id: aggregateId
      });
      return { command, replayed: false };
    });
  }

  /**
   * Claim the next queued command matching the filters, under one lock so
   * concurrent ticks never claim the same command. Claimed commands carry a
   * lease; expired leases are recovered to queued before scanning.
   * `skipCommandIds` lets a tick leave specific commands queued (e.g. the
   * aggregate task is paused) without spinning on the same entry.
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
      const candidate = queued[0];
      if (!candidate) return null;

      candidate.status = 'claimed';
      candidate.claimed_by = workerId;
      candidate.claimed_at = nowIso();
      candidate.attempts += 1;
      candidate.lease_until = new Date(Date.now() + leaseMs).toISOString();
      await this.store.saveCommand(candidate);
      await this.store.logEvent('command_updated', { command_id: candidate.command_id, status: 'claimed' });
      return candidate;
    });
  }

  /** Give a claimed command back to the queue without executing it. */
  async releaseClaim(commandId) {
    return this.store.mutateCommand(commandId, null, (command) => {
      command.status = 'queued';
      command.claimed_by = null;
      command.claimed_at = null;
      command.lease_until = null;
    });
  }

  /**
   * Deterministic part finished; the host Agent still owes reasoning or an
   * external action. The lease is kept: if the host never acks the
   * assignment, the lease recovery returns the command to queued.
   */
  async markWaitingAgent(commandId, { leaseMs = DEFAULT_LEASE_MS } = {}) {
    return this.store.mutateCommand(commandId, null, (command) => {
      command.status = 'waiting_agent';
      command.assignment_state = 'delivered';
      command.lease_until = new Date(Date.now() + leaseMs).toISOString();
    });
  }

  /** Host Agent confirms it owns the assignment; lease is cleared. */
  async ackCommand(commandId) {
    return this.store.mutateCommand(commandId, null, (command) => {
      if (command.status !== 'waiting_agent') {
        const error = new Error(`Command is not waiting for the agent: ${commandId}`);
        error.code = 'INVALID_STATE_TRANSITION';
        throw error;
      }
      command.assignment_state = 'acked';
      command.lease_until = null;
      command.acked_at = nowIso();
    });
  }

  async complete(commandId, { status = 'succeeded', error = null } = {}) {
    return this.store.mutateCommand(commandId, null, (command) => {
      if (command.status === 'cancelled') return; // Cancellation wins; never resurrect.
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

  /** Must run under the `commands` lock. */
  async recoverExpiredLeasesUnsafe() {
    const commands = await this.store.listCommands();
    const now = Date.now();
    const recovered = [];
    for (const command of commands) {
      const recoverable = command.status === 'claimed' ||
        (command.status === 'waiting_agent' && command.assignment_state !== 'acked');
      if (!recoverable || !command.lease_until) continue;
      const leaseUntil = Date.parse(command.lease_until);
      if (!Number.isNaN(leaseUntil) && leaseUntil > now) continue;
      command.status = 'queued';
      command.assignment_state = null;
      command.claimed_by = null;
      command.claimed_at = null;
      command.lease_until = null;
      await this.store.saveCommand(command);
      recovered.push(command.command_id);
      await this.store.logEvent('command_lease_recovered', { command_id: command.command_id, previous_status: command.status });
    }
    return recovered;
  }

  /**
   * Cancel every not-yet-completed command for an aggregate. Claimed and
   * delivered-but-unacked assignments are cancelled too; acked assignments
   * stay with the host (which re-checks task status before acting).
   */
  async cancelQueuedForAggregate(aggregateType, aggregateId) {
    return this.store.locks.withLocks(['commands'], async () => {
      const commands = await this.store.listCommands();
      const cancelled = [];
      for (const command of commands) {
        if (command.aggregate_type !== aggregateType || command.aggregate_id !== aggregateId) continue;
        if (!['queued', 'claimed', 'waiting_agent'].includes(command.status)) continue;
        if (command.status === 'waiting_agent' && command.assignment_state === 'acked') continue;
        command.status = 'cancelled';
        command.completed_at = nowIso();
        command.error = { code: 'AGGREGATE_CANCELLED', message: '任务已取消，命令不再执行。' };
        await this.store.saveCommand(command);
        cancelled.push(command.command_id);
        await this.store.logEvent('command_cancelled', { command_id: command.command_id, aggregate_id: aggregateId });
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
