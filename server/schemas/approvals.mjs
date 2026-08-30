export const approvalDecisionSchema = {
  type: 'object',
  required: ['decision', 'expectedRevision'],
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['approve', 'reject', 'edit', 'select_option', 'submit_answer'] },
    expectedRevision: { type: 'integer', minimum: 1 },
    optionId: { type: 'string', minLength: 1, maxLength: 128 },
    answer: { type: 'string', minLength: 1, maxLength: 2000 },
    editedContent: { type: 'string', minLength: 1, maxLength: 4000 }
  }
};

export const bulkDecisionSchema = {
  type: 'object',
  required: ['approvalIds', 'decision'],
  additionalProperties: false,
  properties: {
    approvalIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 64 } },
    decision: { type: 'string', enum: ['mark_for_edit'] }
  }
};
