import { approvalDecisionSchema, bulkDecisionSchema } from '../schemas/approvals.mjs';
import { serializeApproval } from '../serializers/approval-dto.mjs';
import { loadReadContext } from '../services/read-context.mjs';
import { ApiError } from '../middleware/error-handler.mjs';

function payloadInvalid(message, details = null) {
  return new ApiError(422, 'APPROVAL_PAYLOAD_INVALID', message, { details });
}

/**
 * The decision payload must match the approval kind so the page cannot
 * approve a schedule without picking an option, or submit an answer to a
 * message card (docs §7.9).
 */
function assertPayloadMatches(payload, decision, { optionId, answer, editedContent }) {
  switch (decision) {
    case 'approve':
      if (payload.type === 'schedule') {
        throw payloadInvalid('日程审批需要先选择一个时段，不能直接批准。');
      }
      if (payload.type === 'scope_change') {
        throw payloadInvalid('范围变更需要先选择处理方式。');
      }
      break;
    case 'select_option':
      if (payload.type === 'schedule') {
        if (!optionId || !payload.options.some((option) => option.id === optionId)) {
          throw payloadInvalid('请选择一个有效的时段。');
        }
      } else if (payload.type === 'scope_change') {
        if (!optionId || !payload.options.some((option) => option.value === optionId)) {
          throw payloadInvalid('请选择一个有效的处理方式。');
        }
      } else {
        throw payloadInvalid('该审批类型不支持选择选项。');
      }
      break;
    case 'submit_answer':
      if (payload.type !== 'clarification') throw payloadInvalid('该审批类型不支持填写回答。');
      if (!answer || !String(answer).trim()) throw payloadInvalid('请填写回答内容。');
      break;
    case 'edit':
      if (payload.type !== 'message') {
        throw payloadInvalid('该审批类型不支持修改内容。');
      }
      if (!editedContent || !String(editedContent).trim()) throw payloadInvalid('请填写修改后的内容。');
      break;
    case 'reject':
      break;
    default:
      break;
  }
}

export function register(register, context) {
  register('GET', '/api/v1/approvals', async ({ reply, query, repeat, context: ctx }) => {
    const statuses = repeat('status').filter(Boolean);
    const taskId = query.taskId ?? null;
    const limitRaw = query.limit ? Number(query.limit) : 50;
    const result = await ctx.approvalReadService.listApprovals({
      taskId,
      statuses: statuses.length ? statuses : ['pending'],
      cursor: query.cursor ?? null,
      limit: Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 100)
    });
    reply(200, result);
  });

  register('POST', '/api/v1/approvals/bulk-decisions', async ({ reply, body, context: ctx }) => {
    const result = await ctx.consoleCommandService.bulkMarkForEdit(body.approvalIds);
    reply(200, { changed: result.changed });
  }, { schema: bulkDecisionSchema });

  register('POST', '/api/v1/approvals/:approvalId/decisions', async ({ reply, params, body, context: ctx }) => {
    const { store, approvalReadService } = ctx;
    const approval = await store.loadApproval(params.approvalId).catch(() => null);
    if (!approval) {
      throw new ApiError(404, 'APPROVAL_NOT_FOUND', '审批不存在或已被处理。');
    }
    const readContext = await loadReadContext(store);
    const dto = serializeApproval(approval, readContext);
    assertPayloadMatches(dto.payload, body.decision, {
      optionId: body.optionId,
      answer: body.answer,
      editedContent: body.editedContent
    });

    const result = await ctx.consoleCommandService.decideApproval(params.approvalId, {
      decision: body.decision,
      expectedRevision: body.expectedRevision,
      optionId: body.optionId,
      answer: body.answer,
      editedContent: body.editedContent
    });
    const updated = await approvalReadService.getApproval(params.approvalId);
    if (result.commandId) {
      reply(202, { approval: updated, command: { id: result.commandId, status: 'queued' } });
      return;
    }
    reply(200, { approval: updated, command: null });
  }, { schema: approvalDecisionSchema });
}
