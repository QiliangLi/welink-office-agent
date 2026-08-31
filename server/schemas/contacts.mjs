/**
 * Body contract for contact config commands. Conditional requirements
 * (remove needs only employeeNumber, upsert also needs name) are enforced
 * in the route on top of this shape.
 */
export const contactCommandSchema = {
  type: 'object',
  required: ['type', 'employeeNumber'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['upsert', 'remove'] },
    employeeNumber: { type: 'string', minLength: 4, maxLength: 16 },
    name: { type: 'string', minLength: 1, maxLength: 32 },
    department: { type: 'string', maxLength: 32 },
    address: { type: 'string', maxLength: 16 },
    autoContact: { type: 'boolean' }
  }
};
