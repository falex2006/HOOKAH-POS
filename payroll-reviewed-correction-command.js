'use strict';

// Strict request normalization and plan-bound intent, without writes or auth.
// The service must recompute evidence/plan within its fenced transaction.
const { createHash } = require('node:crypto');
const { buildReviewedCorrectionPlan, buildReviewedCorrectionWaiverPlan } = require('./payroll-reviewed-correction-policy');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const isId = value => typeof value === 'string' && UUID.test(value);
const isHash = value => typeof value === 'string' && SHA.test(value);
const fail = (code, status = 400) => { throw Object.assign(new Error(`payroll_correction_${code}`), { code: `payroll_correction_${code}`, status }); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const normalizeReviewedCorrectionPreview = input => {
  const keys = ['operation', 'originalEntryId', 'targetEntryId'];
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
      || keys.some(key => !Object.hasOwn(input, key))
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))
      || !['apply', 'waive'].includes(input.operation) || !isId(input.originalEntryId)
      || (input.operation === 'waive' ? input.targetEntryId !== null : !isId(input.targetEntryId))) fail('preview_invalid');
  return { operation: input.operation, originalEntryId: input.originalEntryId, targetEntryId: input.targetEntryId };
};
const normalizeReviewedCorrectionCommand = input => {
  const keys = ['operation', 'originalEntryId', 'targetEntryId', 'expectedPlanHash', 'reason', 'idempotencyKey'];
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
      || keys.some(key => !Object.hasOwn(input, key))
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))
      || !['apply', 'waive'].includes(input.operation) || !isId(input.originalEntryId)
      || (input.operation === 'waive' ? input.targetEntryId !== null : !isId(input.targetEntryId))
      || !isHash(input.expectedPlanHash) || typeof input.reason !== 'string'
      || input.reason.trim().length < 3 || input.reason.length > 2000
      || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(input.idempotencyKey)) fail('command_invalid');
  return { operation: input.operation, originalEntryId: input.originalEntryId, targetEntryId: input.targetEntryId,
    expectedPlanHash: input.expectedPlanHash, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey };
};
const reviewedCorrectionRequestHash = (actor, command) => {
  command = normalizeReviewedCorrectionCommand(command);
  if (!actor || !isId(actor.venueId) || !isId(actor.userId)) fail('actor_invalid');
  const { idempotencyKey, ...intent } = command;
  return hash({ schemaVersion: 1, venueId: actor.venueId, actorId: actor.userId, ...intent });
};
const buildReviewedCorrectionCommand = (actor, input, evidence) => {
  const command = normalizeReviewedCorrectionCommand(input), requestHash = reviewedCorrectionRequestHash(actor, command);
  if (!evidence || evidence.original?.id !== command.originalEntryId || evidence.original?.venueId !== actor.venueId
      || (command.operation === 'apply' && evidence.target?.id !== command.targetEntryId)) fail('command_basis_mismatch', 409);
  const plan = command.operation === 'apply' ? buildReviewedCorrectionPlan(evidence) : buildReviewedCorrectionWaiverPlan(evidence);
  if (plan.planHash !== command.expectedPlanHash) fail('plan_stale', 409);
  const amountField = command.operation === 'apply' ? 'applyCents' : 'waiveCents';
  if (plan[amountField] === 0) fail('nothing_to_dispose', 409);
  const events = plan.allocations.filter(line => line[amountField] > 0).map(line => ({
    kind: command.operation, originalEntryId: command.originalEntryId, targetEntryId: command.targetEntryId,
    refundLineEventId: line.refundLineEventId, sourceSnapshotLineId: line.sourceSnapshotLineId,
    amountCents: line[amountField], reversesEventId: null
  }));
  return { command, requestHash, plan, events };
};
module.exports = { normalizeReviewedCorrectionPreview, normalizeReviewedCorrectionCommand, reviewedCorrectionRequestHash, buildReviewedCorrectionCommand };
