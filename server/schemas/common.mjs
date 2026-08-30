import { validationError } from '../middleware/error-handler.mjs';

/**
 * Minimal JSON Schema subset validator — enough for the console contract
 * without pulling a dependency into the portable Skill package. Schemas in
 * this directory are the single source of the HTTP contract; the frontend
 * mirrors them in web-console/src/api/contracts.ts.
 */
export function validate(schema, value, path = 'body') {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type) {
    const matched = types.some((type) => checkType(type, value));
    if (!matched) {
      throw validationError(`${path} 类型不正确，期望 ${types.join(' 或 ')}。`, { field: path });
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw validationError(`${path} 的取值不在允许范围内。`, { field: path, allowed: schema.enum });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw validationError(`${path} 长度不能少于 ${schema.minLength} 个字符。`, { field: path });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw validationError(`${path} 长度不能超过 ${schema.maxLength} 个字符。`, { field: path });
    }
    if (schema.format === 'iso-date-time' && Number.isNaN(Date.parse(value))) {
      throw validationError(`${path} 不是有效的时间。`, { field: path });
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw validationError(`${path} 不能小于 ${schema.minimum}。`, { field: path });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw validationError(`${path} 不能大于 ${schema.maximum}。`, { field: path });
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
  }
  if (checkType('object', value) && schema.properties) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) {
        throw validationError(`缺少必填字段 ${key}。`, { field: `${path}.${key}` });
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw validationError(`不支持的字段 ${key}。`, { field: `${path}.${key}` });
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) validate(propertySchema, value[key], `${path}.${key}`);
    }
  }
  return value;
}

function checkType(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

export const idempotencyKeySchema = { type: 'string', minLength: 8, maxLength: 128 };
