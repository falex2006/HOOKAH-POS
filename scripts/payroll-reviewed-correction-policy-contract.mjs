import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { buildReviewedCorrectionPlan: plan, buildReviewedCorrectionWaiverPlan: waiver,
  buildReviewedCorrectionReleasePlan: cancellation } = createRequire(import.meta.url)('../payroll-reviewed-correction-policy');
const { normalizeReviewedCorrectionCommand: normalize, reviewedCorrectionRequestHash: requestHash,
  buildReviewedCorrectionCommand: command } = createRequire(import.meta.url)('../payroll-reviewed-correction-command');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venueId = id(1), employeeId = id(2), hash = 'a'.repeat(64);
const entry = (n, periodFrom, periodTo) => ({ id: id(n), venueId, employeeId, runId: id(n + 100),
  origin: 'calculation_run', currency: 'RUB', provenanceSha256: hash, periodFrom, periodTo, grossCents: 1000, netCents: 1000 });
const original = { ...entry(3, '2026-09-01', '2026-09-30'), status: 'paid',
  expense: { id: id(5), entryId: id(3), venueId, source: 'payroll', amountCents: 1000 } };
const target = { ...entry(4, '2026-10-01', '2026-10-31'), status: 'draft', protectedFixedCents: 700, eligibleVariableCents: 300 };
const line = n => ({ employeeId, refundLineEventId: id(n), sourceSnapshotLineId: id(n + 100), salaryImpactCents: -200, reasons: [] });
const assessment = { venueId, runId: original.runId, provenanceSha256: hash, coverage: 'complete',
  assessmentHash: hash, sourceHash: 'b'.repeat(64), lines: [line(10), line(11)] };
const input = () => structuredClone({ original, target, assessment, ledger: [] });
const event = (n, kind, cents, source = 10, to = target.id) => ({ id: id(n), sequenceNo: n, venueId, employeeId, currency: 'RUB',
  originalEntryId: original.id, refundLineEventId: id(source), kind, amountCents: cents,
  targetEntryId: kind === 'waive' ? null : to, reversesEventId: null });
const reject = (change, code) => { const value = input(); change(value); assert.throws(() => plan(value), e => e.code === `payroll_correction_${code}`); };
const first = plan(input());
assert.equal(first.applyCents, 300);
assert.equal(first.targetAfterCents, 700);
assert.equal(first.residualReviewCents, 100);
assert.deepEqual(first.allocations.map(a => a.applyCents), [200, 100]);
assert.equal(first.ownerDecisionRequired, true);
assert.equal(first.payoutEligible, false);
assert.equal(first.persistence, 'none');
assert.deepEqual(plan({ ...input(), assessment: { ...assessment, lines: [...assessment.lines].reverse() } }), first, 'query order does not change exact plan hash');
const partial = input(); partial.ledger = [event(20, 'apply', 150)]; partial.target.netCents = 850;
const next = plan(partial);
assert.equal(next.applyCents, 150); assert.equal(next.residualReviewCents, 100);
assert.deepEqual(next.allocations.map(a => [a.alreadyDisposedCents, a.applyCents]), [[150, 50], [0, 100]]);
const waived = input(); waived.ledger = [event(21, 'waive', 200)];
assert.equal(plan(waived).applyCents, 200);
waived.assessment.lines.push(line(12));
assert.equal(plan(waived).allocations[0].applyCents, 0, 'later refund never reopens waived amount');
assert.equal(plan(waived).residualReviewCents, 100);
const cancelled = input(); const applied = event(22, 'apply', 200, 10, id(44));
const release = { ...event(23, 'release', 200, 10, id(44)), reversesEventId: applied.id };
cancelled.ledger = [release, applied];
assert.equal(plan(cancelled).applyCents, 300, 'exact released allocation becomes reviewable, not auto-applied');
assert.equal(plan(cancelled).ownerDecisionRequired, true);
const otherOrigin = input(); otherOrigin.target.netCents = 900;
otherOrigin.ledger = [{ ...event(24, 'apply', 100, 13), originalEntryId: id(77) }];
assert.equal(plan(otherOrigin).applyCents, 200, 'other original claims use target variable capacity too');
const zeroVariable = input(); zeroVariable.target.protectedFixedCents = 1000; zeroVariable.target.eligibleVariableCents = 0;
assert.equal(plan(zeroVariable).applyCents, 0); assert.equal(plan(zeroVariable).residualReviewCents, 400);
reject(v => { v.original.status = 'draft'; }, 'original_paid_basis_required');
reject(v => { v.original.expense.entryId = id(7); }, 'original_paid_basis_required');
reject(v => { v.original.expense.venueId = id(7); }, 'original_paid_basis_required');
reject(v => { v.original.expense.amountCents = 999; }, 'original_paid_basis_required');
reject(v => { v.target.status = 'approved'; }, 'target_draft_invalid');
reject(v => { v.target.employeeId = id(7); }, 'target_draft_invalid');
reject(v => { v.target.venueId = id(7); }, 'target_draft_invalid');
reject(v => { v.target.periodFrom = original.periodTo; }, 'target_draft_invalid');
reject(v => { v.target.currency = 'USD'; }, 'entry_basis_invalid');
reject(v => { v.target.periodFrom = '2026-02-30'; }, 'period_invalid');
reject(v => { v.target.netCents = 699; }, 'target_variable_basis_invalid');
reject(v => { v.target.eligibleVariableCents = 500; }, 'target_variable_basis_invalid');
reject(v => { v.assessment.coverage = 'needs_review'; }, 'assessment_required');
reject(v => { v.assessment.runId = id(8); }, 'assessment_required');
reject(v => { v.assessment.lines[0].salaryImpactCents = null; }, 'assessment_line_invalid');
reject(v => { v.assessment.lines[0].salaryImpactCents = 1; }, 'assessment_line_invalid');
reject(v => { v.assessment.lines[0].salaryImpactCents = -0.5; }, 'assessment_line_invalid');
reject(v => { v.assessment.lines.push(v.assessment.lines[0]); }, 'assessment_line_invalid');
reject(v => { v.ledger = [event(30, 'waive', 201)]; }, 'source_overallocated');
reject(v => { v.ledger = [event(30, 'waive', 1, 99)]; }, 'source_disposition_missing_from_assessment');
reject(v => { v.ledger = [event(30, 'apply', 100)]; }, 'target_ledger_mismatch');
reject(v => { v.ledger = [event(30, 'waive', 1), event(30, 'waive', 1)]; }, 'ledger_invalid');
reject(v => { v.ledger = [applied, release, { ...release, id: id(31), sequenceNo: 31 }]; }, 'release_invalid');
reject(v => { v.ledger = [release]; }, 'release_invalid');
reject(v => { v.ledger = [applied, { ...release, amountCents: 199 }]; }, 'release_invalid');
reject(v => { v.ledger = [event(30, 'waive', 10), { ...release, reversesEventId: id(30), sequenceNo: 31 }]; }, 'release_invalid');
reject(v => { v.target.netCents = 900; v.ledger = [{ ...event(24, 'apply', 100), originalEntryId: id(77) }]; }, 'source_original_entry_mismatch');
reject(v => { v.ledger = [{ ...applied, amountCents: 201 }, { ...release, amountCents: 201 }]; }, 'source_overallocated');
reject(v => { v.ledger = [applied, { ...release, sequenceNo: 1 }]; }, 'release_invalid');
reject(v => { v.ledger = [event(30, 'waive', 10), { ...event(31, 'waive', 10), sequenceNo: 30 }]; }, 'ledger_invalid');
assert.notEqual(plan({ ...input(), target: { ...target, provenanceSha256: 'c'.repeat(64) } }).planHash, first.planHash);
assert.deepEqual(plan({ ...cancelled, ledger: [...cancelled.ledger].reverse() }), plan(cancelled));
const max = input(); max.target.grossCents = max.target.netCents = Number.MAX_SAFE_INTEGER;
max.target.eligibleVariableCents = Number.MAX_SAFE_INTEGER - 700;
assert.equal(plan(max).targetAfterCents, Number.MAX_SAFE_INTEGER - 400);
const waiverInput = input(); delete waiverInput.target;
assert.equal(waiver(waiverInput).waiveCents, 400, 'waiving needs no later draft');
assert.equal(waiver(waived).waiveCents, 400, 'waiver consumes remaining current increments, including new refund');
assert.equal(waiver(partial).waiveCents, 250, 'already applied amount cannot also be waived');
assert.equal(waiver(cancelled).waiveCents, 400, 'released application is available for explicit waiver');
const allWaived = input(); allWaived.ledger = [event(40, 'waive', 200), event(41, 'waive', 200, 11)];
assert.equal(waiver(allWaived).waiveCents, 0);
assert.notEqual(waiver(input()).planHash, first.planHash, 'different owner operations bind different plans');
const toCancel = { ...target, netCents: 800 };
const cancellationApplication = event(55, 'apply', 200);
const cancelPlan = cancellation({ target: toCancel, applications: [cancellationApplication] });
assert.equal(cancelPlan.releaseCents, 200);
assert.equal(cancelPlan.cancelledHistoricalCents, 800, 'cancelled amount is not rewritten to original gross');
assert.equal(cancelPlan.releases[0].reversesEventId, cancellationApplication.id);
assert.equal(cancellation({ target, applications: [] }).releaseCents, 0);
assert.equal(cancellation({ target: { ...toCancel, status: 'approved' }, applications: [cancellationApplication] }).releaseCents, 200);
for (const status of ['paid', 'cancelled']) assert.throws(() => cancellation({ target: { ...toCancel, status }, applications: [cancellationApplication] }), /cancellation_target_invalid/);
assert.throws(() => cancellation({ target: toCancel, applications: [] }), /target_ledger_mismatch/);
assert.throws(() => cancellation({ target: toCancel, applications: [cancellationApplication, cancellationApplication] }), /ledger_invalid/);
assert.throws(() => cancellation({ target: toCancel, applications: [{ ...cancellationApplication, targetEntryId: id(90) }] }), /ledger_invalid/);
assert.throws(() => cancellation({ target: toCancel, applications: [{ ...cancellationApplication, kind: 'waive' }] }), /ledger_invalid/);
const actor = { venueId, userId: id(60) };
const intent = { operation: 'apply', originalEntryId: original.id, targetEntryId: target.id,
  expectedPlanHash: first.planHash, reason: '  Подтверждено владельцем  ', idempotencyKey: 'correction-0001' };
const appliedCommand = command(actor, intent, input());
assert.equal(appliedCommand.events.reduce((sum, e) => sum + e.amountCents, 0), 300);
assert.equal(appliedCommand.command.reason, 'Подтверждено владельцем');
assert.equal(requestHash(actor, intent), requestHash(actor, { ...intent, idempotencyKey: 'correction-0002' }));
assert.notEqual(requestHash(actor, intent), requestHash({ ...actor, userId: id(61) }, intent));
assert.notEqual(requestHash(actor, intent), requestHash(actor, { ...intent, reason: 'Другое основание' }));
assert.throws(() => command(actor, { ...intent, expectedPlanHash: '0'.repeat(64) }, input()), /plan_stale/);
assert.throws(() => command(actor, intent, partial), /plan_stale/);
assert.throws(() => command({ ...actor, venueId: id(90) }, intent, input()), /command_basis_mismatch/);
const waiveIntent = { ...intent, operation: 'waive', targetEntryId: null, expectedPlanHash: waiver(waiverInput).planHash };
assert.equal(command(actor, waiveIntent, waiverInput).events.reduce((sum, e) => sum + e.amountCents, 0), 400);
assert.throws(() => command(actor, { ...waiveIntent, expectedPlanHash: waiver(allWaived).planHash }, allWaived), /nothing_to_dispose/);
for (const bad of [{ ...intent, amountCents: 1 }, { ...intent, targetEntryId: null }, { ...waiveIntent, targetEntryId: target.id },
  { ...intent, reason: '  ' }, { ...intent, idempotencyKey: 'bad' }, { ...intent, expectedPlanHash: null },
  { ...intent, originalEntryId: [original.id] }, { ...intent, expectedPlanHash: [first.planHash] },
  { ...intent, targetEntryId: [target.id] },
  { ...intent, operation: 'release' }, { ...intent, [Symbol('extra')]: true }]) assert.throws(() => normalize(bad), /command_invalid/);
const getter = { ...intent }; Object.defineProperty(getter, 'reason', { get: () => { throw new Error('must not read accessor'); }, enumerable: true });
assert.throws(() => normalize(getter), /command_invalid/);
// Cash-zero settlement may carry new refunds of its OWN earned sales. An
// incoming correction belongs to the earlier original and is never re-assessed.
assert.equal(first.policyVersion, 'owner-reviewed-variable-correction-v1');
assert.equal(Object.hasOwn(first, 'originalSettlementTransitionId'), false);
const zeroOriginal = { ...original, grossCents: 10000, netCents: 0, expense: null,
  settlement: { kind: 'zero', transitionId: id(301), venueId, entryId: original.id, employeeId, runId: original.runId,
    provenanceSha256: hash, grossCents: 10000, netCents: 0, protectedFixedCents: 0, incomingCorrectionCents: 10000,
    paidAt: '2026-10-01T00:00:00Z', paidBy: actor.userId, paymentDate: '2026-10-01' } };
const incoming100 = { ...event(300, 'apply', 10000, 98, original.id), originalEntryId: id(299) };
const zeroInput = { original: zeroOriginal, target: { ...target, grossCents: 10000, netCents: 10000, protectedFixedCents: 0, eligibleVariableCents: 10000 },
  assessment: { ...assessment, lines: [{ ...line(10), salaryImpactCents: -2000 }] }, ledger: [incoming100] };
const own20 = plan(zeroInput);
assert.equal(own20.applyCents, 2000, 'own20 only, neither incoming100+20 nor cash0 cap');
assert.equal(own20.originalPaidCents, 0); assert.equal(own20.originalExpenseId, null);
assert.equal(own20.originalSettlementTransitionId, zeroOriginal.settlement.transitionId);
assert.equal(own20.policyVersion, 'owner-reviewed-variable-correction-v2');
assert.equal(own20.schemaVersion, 1);
assert.equal(waiver(zeroInput).waiveCents, 2000);
const applied20 = event(302, 'apply', 2000);
const after20 = { ...zeroInput, target: { ...zeroInput.target, netCents: 8000 }, ledger: [incoming100, applied20] };
assert.equal(plan(after20).applyCents, 0); assert.equal(waiver(after20).waiveCents, 0);
const released20 = { ...event(303, 'release', 2000), reversesEventId: applied20.id };
assert.equal(plan({ ...zeroInput, ledger: [incoming100, applied20, released20] }).applyCents, 2000);
assert.equal(cancellation({ target: after20.target, applications: [applied20] }).releaseCents, 2000);
assert.deepEqual(zeroInput.ledger, [incoming100], 'no mutation or reuse of incoming100');
assert.notEqual(plan({ ...zeroInput, original: { ...zeroOriginal, settlement: { ...zeroOriginal.settlement, transitionId: id(304) } } }).planHash, own20.planHash);
for (const change of [
  v => { delete v.original.settlement; }, v => { v.original.settlement.kind = 'positive_expense'; },
  v => { v.original.expense = original.expense; }, v => { v.original.settlement.entryId = target.id; },
  v => { v.original.settlement.venueId = id(9); }, v => { v.original.settlement.employeeId = id(9); },
  v => { v.original.settlement.runId = target.runId; }, v => { v.original.settlement.provenanceSha256 = 'b'.repeat(64); },
  v => { v.original.settlement.netCents = 1; }, v => { v.original.settlement.grossCents = 9999; },
  v => { v.original.settlement.protectedFixedCents = 1; }, v => { v.original.settlement.incomingCorrectionCents = 9999; },
  v => { v.original.settlement.paidAt = 'invalid'; }, v => { v.original.settlement.transitionId = null; },
  v => { v.original.settlement.paymentDate = '2026-02-30'; }, v => { v.original.settlement.paidBy = null; },
  v => { v.ledger = []; }, v => { v.ledger[0].amountCents = 9999; }
]) {
  const bad = structuredClone(zeroInput); change(bad);
  assert.throws(() => plan(bad), /payroll_correction_(original_paid_basis_required|original_settlement_ledger_invalid|identity_invalid|period_invalid)/);
}
const earnedZero = structuredClone(zeroInput);
earnedZero.original.grossCents = 0; earnedZero.original.settlement.grossCents = 0; earnedZero.original.settlement.incomingCorrectionCents = 0;
earnedZero.assessment.lines[0].salaryImpactCents = 0; earnedZero.ledger = [];
const emptyPlan = plan(earnedZero); assert.equal(emptyPlan.applyCents, 0);
assert.throws(() => command(actor, { ...intent, expectedPlanHash: emptyPlan.planHash }, earnedZero), /nothing_to_dispose/);

// Pins captured from the unmodified legacy consumer, including cash-zero v2.
assert.equal(first.planHash, 'e78a62cc838a9f4f4c1b645e72020faf6a51c14e315497d9c4f1c949e6a3a24c');
assert.equal(next.planHash, '1e8c98fd1e70d5367276a3cc328cc59764b58fdd1488d9080580a0915f1517c1');
assert.equal(waiver(waiverInput).planHash, 'def1f094cd835aca280bdb5d4e19f46ed01c1fe374a1241103ca53250f0cdd78');
assert.equal(cancelPlan.planHash, '2d867fd38a844888590637e5800b4c06cedec6092467b23d08da6da1556d79c7');
assert.equal(own20.planHash, '2de068d7c8dcfba72b2edd82ce1bab03ad29e8bfd9611cfcf43beb42a07ca0c1');

const periodEvent = (n, kind, cents, patch = {}) => ({ ...event(n, kind, cents), originalEntryId: id(400),
  refundLineEventId: null, sourceKind: 'period_v2', cohortClaimId: id(401), cohortAssessmentId: id(402), ...patch });
const periodApply = periodEvent(410, 'apply', 100);
const periodWaive = periodEvent(411, 'waive', 200);
const periodRelease = periodEvent(412, 'release', 100, { reversesEventId: periodApply.id });
const mixedInput = { ...input(), target: { ...target, netCents: 800 },
  ledger: [event(409, 'apply', 100), periodApply, periodWaive] };
const mixedBefore = structuredClone(mixedInput);
const mixedPlan = plan(mixedInput);
assert.equal(mixedPlan.availableVariableCents, 100, 'all source models consume the same target capacity');
assert.equal(mixedPlan.applyCents, 100);
assert.equal(mixedPlan.targetAfterCents, 700, 'protected fixed pay survives mixed incoming claims');
assert.equal(mixedPlan.residualReviewCents, 200);
assert.deepEqual(mixedPlan.allocations.map(a => a.alreadyDisposedCents), [100, 0], 'foreign period waiver does not consume legacy source');
assert.equal(waiver(mixedInput).waiveCents, 300);
assert.deepEqual(mixedInput, mixedBefore, 'normalization does not mutate evidence');
assert.deepEqual(plan({ ...mixedInput, ledger: [...mixedInput.ledger].reverse() }), mixedPlan);
assert.equal(plan({ ...mixedInput, target: { ...target, netCents: 900 }, ledger: [...mixedInput.ledger, periodRelease] }).applyCents, 200);
assert.equal(plan({ ...input(), ledger: [periodRelease, periodApply, periodWaive] }).applyCents, 300);
for (const patch of [{ cohortAssessmentId: id(403) }, { cohortClaimId: id(403) }, { originalEntryId: id(403) },
  { amountCents: 99 }, { targetEntryId: id(403) }, { sequenceNo: 408 }]) {
  assert.throws(() => waiver({ ...input(), ledger: [periodApply, { ...periodRelease, ...patch }] }), /payroll_correction_release_invalid/);
}
assert.throws(() => waiver({ ...input(), ledger: [periodRelease] }), /payroll_correction_release_invalid/);
assert.throws(() => waiver({ ...input(), ledger: [periodApply, periodRelease, { ...periodRelease, id: id(413), sequenceNo: 413 }] }), /payroll_correction_release_invalid/);
assert.throws(() => waiver({ ...input(), ledger: [periodWaive, { ...periodRelease, reversesEventId: periodWaive.id, amountCents: 200 }] }), /payroll_correction_release_invalid/);
for (const kind of ['apply', 'waive', 'release']) {
  const sameOriginal = periodEvent(420, kind, 100, { originalEntryId: original.id, reversesEventId: kind === 'release' ? id(410) : null });
  assert.throws(() => waiver({ ...input(), ledger: [sameOriginal] }), /payroll_correction_source_basis_mismatch/);
}
// Cumulative assessments may coexist, but each release retains its parent's assessment.
const laterApply = periodEvent(421, 'apply', 50, { cohortAssessmentId: id(403) });
assert.equal(plan({ ...input(), target: { ...target, netCents: 950 }, ledger: [periodApply, laterApply, periodRelease] }).applyCents, 250);
const laterRelease = { ...laterApply, kind: 'release', id: id(422), sequenceNo: 422, reversesEventId: laterApply.id };
assert.equal(plan({ ...input(), ledger: [periodApply, laterApply, periodRelease, laterRelease] }).applyCents, 300);

const mixedCancellation = cancellation({ target: mixedInput.target, applications: [periodApply, mixedInput.ledger[0]] });
assert.equal(mixedCancellation.releaseCents, 200);
assert.equal(mixedCancellation.cancelledHistoricalCents, 800);
assert.deepEqual(mixedCancellation.releases[0], { reversesEventId: id(409), originalEntryId: original.id,
  refundLineEventId: id(10), amountCents: 100 });
assert.deepEqual(mixedCancellation.releases[1], { reversesEventId: periodApply.id, originalEntryId: periodApply.originalEntryId,
  refundLineEventId: null, amountCents: 100, sourceKind: 'period_v2', cohortClaimId: id(401), cohortAssessmentId: id(402) });
assert.equal(Object.hasOwn(mixedCancellation.releases[0], 'sourceKind'), false);
assert.equal(mixedCancellation.officialReady, false); assert.equal(mixedCancellation.payoutEligible, false);
assert.equal(mixedCancellation.persistence, 'none');
assert.deepEqual(cancellation({ target: mixedInput.target, applications: [mixedInput.ledger[0], periodApply] }), mixedCancellation);
assert.notEqual(cancellation({ target: mixedInput.target, applications: [mixedInput.ledger[0], { ...periodApply, cohortAssessmentId: id(403) }] }).planHash, mixedCancellation.planHash);
assert.throws(() => cancellation({ target: mixedInput.target, applications: [periodApply] }), /payroll_correction_target_ledger_mismatch/);
assert.throws(() => cancellation({ target: mixedInput.target, applications: [mixedInput.ledger[0], { ...periodApply, sequenceNo: 409 }] }), /payroll_correction_ledger_invalid/);
for (const patch of [{ venueId: id(999) }, { employeeId: id(999) }, { targetEntryId: id(999) },
  { originalEntryId: target.id }, { kind: 'release', reversesEventId: id(999) }]) {
  assert.throws(() => cancellation({ target: { ...target, netCents: 900 }, applications: [{ ...periodApply, ...patch }] }), /payroll_correction_ledger_invalid/);
}
// Incoming period correction can explain a cash-zero original without becoming
// part of its own assessed legacy earnings/refunds.
const zeroPeriod = { ...zeroInput, ledger: [periodEvent(430, 'apply', 10000, { targetEntryId: original.id })] };
assert.equal(plan(zeroPeriod).applyCents, 2000);
assert.equal(waiver(zeroPeriod).waiveCents, 2000);
assert.throws(() => plan({ ...zeroPeriod, ledger: [{ ...zeroPeriod.ledger[0], amountCents: 9999 }] }), /payroll_correction_original_settlement_ledger_invalid/);
assert.throws(() => plan({ ...zeroPeriod, ledger: [...zeroPeriod.ledger, { ...zeroPeriod.ledger[0], id: id(431),
  sequenceNo: 431, kind: 'release', reversesEventId: zeroPeriod.ledger[0].id }] }), /payroll_correction_original_settlement_ledger_invalid/);

// Strict shared shape validation stays inside each consumer's public namespace.
for (const bad of [null, { ...periodApply, extra: true }, { ...periodApply, sourceKind: 'line_v1' },
  { ...periodApply, refundLineEventId: id(10) }, { ...event(440, 'waive', 10), cohortClaimId: null },
  { ...periodApply, [Symbol('extra')]: true }, { ...periodApply, amountCents: 0 }]) {
  assert.throws(() => waiver({ ...input(), ledger: [bad] }), e => e.code === 'payroll_correction_ledger_invalid');
  assert.throws(() => cancellation({ target, applications: [bad] }), e => e.code === 'payroll_correction_ledger_invalid');
}
for (const cents of [-1, 1.5, '100', null, 1000000000000]) {
  assert.throws(() => waiver({ ...input(), ledger: [{ ...periodApply, amountCents: cents }] }), e => e.code === 'payroll_correction_amount_invalid');
}
assert.throws(() => waiver({ ...input(), ledger: [{ ...periodApply, cohortAssessmentId: null }] }), e => e.code === 'payroll_correction_identity_invalid');
let eventGetterRead = false;
const eventGetter = { ...periodApply };
Object.defineProperty(eventGetter, 'amountCents', { enumerable: true, get() { eventGetterRead = true; return 100; } });
assert.throws(() => waiver({ ...input(), ledger: [eventGetter] }), /payroll_correction_ledger_invalid/);
assert.throws(() => cancellation({ target, applications: [eventGetter] }), /payroll_correction_ledger_invalid/);
assert.equal(eventGetterRead, false);

console.log('PASS reviewed correction policy and commands: exact partial allocation, permanent waiver without target, full cancellation release, stale-plan refusal, actor/request binding; pure evidence tests, no authorization or money writes');
