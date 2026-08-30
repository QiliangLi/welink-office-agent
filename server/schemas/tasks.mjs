import { idempotencyKeySchema } from './common.mjs';

export const DISPLAY_STATUSES = [
  'queued',
  'running',
  'waiting_external',
  'waiting_approval',
  'paused',
  'partial',
  'failed',
  'stopped',
  'completed'
];

export const createTaskSchema = {
  type: 'object',
  required: ['description'],
  additionalProperties: false,
  properties: {
    description: { type: 'string', minLength: 12, maxLength: 2000 },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    deadline: { type: 'string', format: 'iso-date-time' },
    timezone: { type: 'string', maxLength: 64 },
    externalPolicy: { type: 'string', enum: ['conservative', 'balanced', 'active'] },
    executionMode: { type: 'string', enum: ['automatic', 'confirm'] },
    attachmentIds: { type: 'array', maxItems: 0, items: { type: 'string' } }
  }
};

export const taskCommandSchema = {
  type: 'object',
  required: ['type', 'expectedRevision'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['pause', 'resume', 'cancel', 'instruction', 'retry'] },
    expectedRevision: { type: 'integer', minimum: 1 },
    text: { type: 'string', minLength: 2, maxLength: 1000 }
  }
};

export const reminderSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    idempotencyKey: idempotencyKeySchema
  }
};

// URL query params always arrive as strings; parse+range-check in the route.
export const taskListQuerySchema = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 200 },
    status: { type: 'string', maxLength: 400 },
    updatedFrom: { type: 'string', maxLength: 64 },
    updatedTo: { type: 'string', maxLength: 64 },
    cursor: { type: 'string', maxLength: 512 },
    limit: { type: 'string', maxLength: 4 }
  }
};
