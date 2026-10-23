import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { handlePayrollSchemeRoute, sameOriginMutation } = require('../payroll-scheme-routes.js');
const { makeService: makePayrollSchemeService } = require('../payroll-scheme-service.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = '00000000-0000-4000-8000-000000000001';
const venueId = '00000000-0000-4000-8000-000000000002';
const versionId = '00000000-0000-4000-8000-000000000003';
const payoutRiskAcknowledgement = { confirmed: true, policyCode: 'payroll-own-revenue-ceiling-v1' };

const responseFor = () => {
  const response = { status: null, body: null };
  return { response, json: (_res, status, body) => { response.status = status; response.body = body; } };
};
const requestFor = (method, pathname, overrides = {}) => ({
  method,
  user: { id, venueId, role: 'owner' },
  headers: { host: 'crm.example.test', origin: 'https://crm.example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(method === 'GET' ? {} : {}), ...overrides.headers },
  socket: { encrypted: true },
  url: pathname
});
const bodyReader = async (req) => req.body || {};

const calls = [];
const scheme = { id, name: 'Flexible', description: '', versions: [{ id: versionId, versionNo: 1, status: 'draft' }] };
const service = {
  listSchemes: async (principal) => { calls.push(['listSchemes', principal]); return [scheme]; },
  getVersion: async (principal, target) => { calls.push(['getVersion', principal, target]); return { ...scheme, versionId: target, status: 'draft' }; },
  listVersionRevisions: async (principal, target) => { calls.push(['listVersionRevisions', principal, target]); return []; },
  getSourceReadiness: async (principal, target, period) => { calls.push(['getSourceReadiness', principal, target, period]); return { officialReady: false }; },
  getEntryOverlapDiagnostic: async (principal, period) => { calls.push(['getEntryOverlapDiagnostic', principal, period]); return { diagnosticOnly: true, snapshotProvenance: 'unknown', period }; },
  createScheme: async (principal, input) => { calls.push(['createScheme', principal, input]); return { ...scheme, ...input }; },
  createVersion: async (principal, target, definition, acknowledgement) => { calls.push(['createVersion', principal, target, definition, acknowledgement]); return { ...scheme, schemeId: target, versionId, ...definition }; },
  replaceDraftVersion: async (principal, target, definition, acknowledgement) => { calls.push(['replaceDraftVersion', principal, target, definition, acknowledgement]); return { ...scheme, versionId: target, ...definition }; },
  activateVersion: async (principal, target) => { calls.push(['activateVersion', principal, target]); return { ...scheme, versionId: target, status: 'active' }; },
  preview: async (principal, target, input) => { calls.push(['preview', principal, target, input]); return { official: false, persistence: 'none', scenario: true, result: { status: 'ready' } }; },
  previewWithApprovedAttendance: async (principal, target, input) => { calls.push(['previewWithApprovedAttendance', principal, target, input]); return { official: false, persistence: 'none', scenario: true, sourceAttendanceApproval: { revision: 4 }, result: { status: 'ready' } }; },
  previewWithVenueDailyTurnover: async (principal, target, input) => {
    calls.push(['previewWithVenueDailyTurnover', principal, target, input]);
    return { official: false, persistence: 'none', scenario: true,
      sourceVenueTurnover: { official: false, persistence: 'none', previewOnly: true }, result: { status: 'blocked' } };
  },
  previewSourced: async (principal, target, input) => {
    calls.push(['previewSourced', principal, target, input]);
    return { candidateOnly: true, officialReady: false, calculationStatus: 'unavailable', amount: null };
  },
  compare: async (principal, ids, input, baseline) => { calls.push(['compare', principal, ids, input, baseline]); return { official: false, persistence: 'none', scenario: true, comparisons: [] }; },
  compareSourced: async (principal, input) => { calls.push(['compareSourced', principal, input]);
    return { comparisonKind: 'sourced_candidate', candidateOnly: true, officialReady: false, persistence: 'none' }; },
  readAttendanceCoverage: async (principal, period) => { calls.push(['readAttendanceCoverage', principal, period]); return { complete: true, sourceWatermark: 'a'.repeat(64) }; },
  approveAttendanceCoverage: async (principal, input) => { calls.push(['approveAttendanceCoverage', principal, input]); return { revision: 1 }; },
  listEmploymentEligibilityEmployees: async principal => { calls.push(['listEmploymentEligibilityEmployees', principal]); return { schemaVersion: 1, items: [{ id, name: 'Owner', active: true }] }; },
  getEmploymentEligibilityHistory: async principal => { calls.push(['getEmploymentEligibilityHistory', principal]); return { current: null, history: [] }; },
  createEmploymentEligibilityRevision: async (principal, input) => {
    calls.push(['createEmploymentEligibilityRevision', principal, input]); return { revisionNo: 1, replayed: false };
  },
  getProductDepartmentMappings: async principal => { calls.push(['getProductDepartmentMappings', principal]); return { currentRevision: null, history: [] }; },
  getProductDepartmentRevision: async (principal, target) => { calls.push(['getProductDepartmentRevision', principal, target]); return { id: target }; },
  writeProductDepartmentRevision: async (principal, input, retroactive) => {
    calls.push(['writeProductDepartmentRevision', principal, input, retroactive]); return { revisionNo: 1, replayed: false };
  }
};
const dispatch = async (req, { selectedService = service, body = bodyReader } = {}) => {
  const { response, json } = responseFor();
  const handled = await handlePayrollSchemeRoute({ req, res: response, url: new URL(req.url, 'https://crm.example.test'), service: selectedService, readBody: body, json });
  return { handled, ...response };
};

let result = await dispatch(requestFor('GET', '/api/payroll/schemes'));
assert.equal(result.handled, true);
assert.equal(result.status, 200);
assert.deepEqual(result.body.items, [scheme]);
assert.deepEqual(calls.at(-1), ['listSchemes', { userId: id, venueId }]);

result = await dispatch(requestFor('GET', '/api/payroll/attendance/approvals?from=2026-10-01&to=2026-10-31'));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['readAttendanceCoverage', { userId: id, venueId }, { periodFrom: '2026-10-01', periodTo: '2026-10-31' }]);
const attendanceInput = { periodFrom: '2026-10-01', periodTo: '2026-10-31', sourceWatermark: 'a'.repeat(64), reason: 'Сверка завершена', idempotencyKey: 'payroll-attendance:qa-key' };
result = await dispatch({ ...requestFor('POST', '/api/payroll/attendance/approvals'), body: attendanceInput });
assert.equal(result.status, 201);
assert.deepEqual(calls.at(-1), ['approveAttendanceCoverage', { userId: id, venueId }, attendanceInput]);
const attendanceCallsBeforeDenied = calls.length;
result = await dispatch({ ...requestFor('POST', '/api/payroll/attendance/approvals'), user: { id, venueId, role: 'manager' }, body: attendanceInput });
assert.equal(result.status, 403);
assert.equal(calls.length, attendanceCallsBeforeDenied, 'non-owner cannot reach attendance manifest service');

result = await dispatch(requestFor('GET', '/api/payroll/employment-eligibility'));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['getEmploymentEligibilityHistory', { userId: id, venueId }]);
result = await dispatch(requestFor('GET', '/api/payroll/employment-eligibility/employees'));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['listEmploymentEligibilityEmployees', { userId: id, venueId }]);
result = await dispatch(requestFor('GET', '/api/payroll/employment-eligibility/employees?venueId=foreign'));
assert.equal(result.status, 400);
result = await dispatch(requestFor('POST', '/api/payroll/employment-eligibility/employees'));
assert.equal(result.status, 405, 'minimal employee selector is read-only');
result = await dispatch(requestFor('GET', '/api/payroll/employment-eligibility?venueId=foreign'));
assert.equal(result.status, 400);
assert.deepEqual(result.body, { error: 'invalid_payroll_employment_eligibility_request' });
const employmentRevisionInput = { reason: 'Сверка кадрового состава', idempotencyKey: 'payroll-employment:qa-1', expectedRevisionId: null,
  periods: [{ employeeId: id, effectiveFrom: '2026-01-01', effectiveTo: null }] };
result = await dispatch({ ...requestFor('POST', '/api/payroll/employment-eligibility'), body: employmentRevisionInput });
assert.equal(result.status, 201);
assert.deepEqual(calls.at(-1), ['createEmploymentEligibilityRevision', { userId: id, venueId }, employmentRevisionInput]);
result = await dispatch(requestFor('GET', '/api/payroll/product-department-mappings'));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['getProductDepartmentMappings', { userId: id, venueId }]);
result = await dispatch(requestFor('GET', `/api/payroll/product-department-mappings/revisions/${versionId}`));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['getProductDepartmentRevision', { userId: id, venueId }, versionId]);
const departmentRevisionInput = { expectedRevisionId: null, idempotencyKey: 'payroll-departments:qa-1',
  reason: 'Начальная классификация', mappings: [] };
result = await dispatch({ ...requestFor('POST', '/api/payroll/product-department-mappings/revisions'), body: departmentRevisionInput });
assert.equal(result.status, 201);
assert.deepEqual(calls.at(-1), ['writeProductDepartmentRevision', { userId: id, venueId }, departmentRevisionInput, false]);
const retroDepartmentRevision = { ...departmentRevisionInput, effectiveFrom: '2026-01-01', retroactiveReason: 'Исправлена ошибка источника',
  ownerAttestation: { confirmed: true, action: 'retroactive_payroll_product_department_mapping' } };
result = await dispatch({ ...requestFor('POST', '/api/payroll/product-department-mappings/retroactive-revisions'), body: retroDepartmentRevision });
assert.equal(result.status, 201);
assert.deepEqual(calls.at(-1), ['writeProductDepartmentRevision', { userId: id, venueId }, retroDepartmentRevision, true]);
result = await dispatch(requestFor('GET', '/api/payroll/product-department-mappings?venueId=foreign'));
assert.equal(result.status, 400);
result = await dispatch(requestFor('DELETE', '/api/payroll/product-department-mappings'));
assert.equal(result.status, 405);
const beforeForeignMapping = calls.length;
result = await dispatch({ ...requestFor('POST', '/api/payroll/product-department-mappings/revisions'), user: { id, venueId, role: 'manager' }, body: departmentRevisionInput });
assert.equal(result.status, 403);
assert.equal(calls.length, beforeForeignMapping);
result = await dispatch({ ...requestFor('POST', '/api/payroll/product-department-mappings/revisions'),
  headers: { host: 'crm.example.test', origin: 'https://attacker.example.test', 'content-type': 'application/json' }, body: departmentRevisionInput });
assert.equal(result.status, 403);
assert.equal(calls.length, beforeForeignMapping);
const employmentCallsBeforeDenied = calls.length;
result = await dispatch({ ...requestFor('GET', '/api/payroll/employment-eligibility/employees'), user: { id, venueId, role: 'manager' } });
assert.equal(result.status, 403);
assert.equal(calls.length, employmentCallsBeforeDenied, 'non-owner cannot list payroll employees');
result = await dispatch({ ...requestFor('POST', '/api/payroll/employment-eligibility'), user: { id, venueId, role: 'manager' }, body: employmentRevisionInput });
assert.equal(result.status, 403);
assert.equal(calls.length, employmentCallsBeforeDenied, 'non-owner cannot access or mutate historical payroll eligibility');
result = await dispatch({ ...requestFor('POST', '/api/payroll/employment-eligibility'),
  headers: { host: 'crm.example.test', origin: 'https://attacker.example.test', 'content-type': 'application/json' }, body: employmentRevisionInput });
assert.equal(result.status, 403, 'employment eligibility writes require same-origin protection');
assert.equal(calls.length, employmentCallsBeforeDenied);

const spoofed = { name: 'Draft', venueId: 'forged-venue', userId: 'forged-user', definition: { mode: 'progressive_daily' }, payoutRiskAcknowledgement };
result = await dispatch({ ...requestFor('POST', '/api/payroll/schemes'), body: spoofed });
assert.equal(result.status, 201);
assert.deepEqual(calls.at(-1), ['createScheme', { userId: id, venueId }, spoofed]);

result = await dispatch(requestFor('GET', `/api/payroll/schemes/${id}/versions`));
assert.equal(result.status, 200);
assert.deepEqual(result.body.items, scheme.versions);

result = await dispatch(requestFor('GET', `/api/payroll/versions/${versionId}`));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['getVersion', { userId: id, venueId }, versionId]);
result = await dispatch(requestFor('GET', `/api/payroll/versions/${versionId}/source-readiness?from=2026-10-01&to=2026-10-31`));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['getSourceReadiness', { userId: id, venueId }, versionId, { from: '2026-10-01', to: '2026-10-31' }]);
result = await dispatch(requestFor('GET', '/api/payroll/entry-overlap-diagnostic?from=2026-10-01&to=2026-10-15'));
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['getEntryOverlapDiagnostic', { userId: id, venueId }, { from: '2026-10-01', to: '2026-10-15' }]);
for (const query of ['from=2026-10-01', 'from=2026-10-01&to=2026-10-15&venueId=foreign', 'from=2026-10-01&from=2026-10-02&to=2026-10-15']) {
  const before = calls.length;
  result = await dispatch(requestFor('GET', `/api/payroll/entry-overlap-diagnostic?${query}`));
  assert.equal(result.status, 400); assert.equal(calls.length, before);
}
result = await dispatch({ ...requestFor('GET', '/api/payroll/entry-overlap-diagnostic?from=2026-10-01&to=2026-10-15'), user: { id, venueId, role: 'manager' } });
assert.equal(result.status, 403);
for (const query of ['from=2026-10-01', 'from=2026-10-01&from=2026-10-01&to=2026-10-31', 'from=2026-10-01&to=2026-10-31&coverage=complete']) {
  const before = calls.length;
  result = await dispatch(requestFor('GET', `/api/payroll/versions/${versionId}/source-readiness?${query}`));
  assert.equal(result.status, 400); assert.equal(calls.length, before);
}
result = await dispatch({ ...requestFor('GET', `/api/payroll/versions/${versionId}/source-readiness?from=2026-10-01&to=2026-10-31`), user: { id, venueId, role: 'bartender' } });
assert.equal(result.status, 403);

result = await dispatch(requestFor('GET', `/api/payroll/versions/${versionId}/revisions`));
assert.equal(result.status, 200);
assert.deepEqual(result.body.items, []);

for (const path of ['/api/payroll/schemes', `/api/payroll/versions/${versionId}`]) {
  result = await dispatch({ ...requestFor('GET', path), user: { id, venueId, role: 'manager' } });
  assert.equal(result.handled, true);
  assert.equal(result.status, 403, `non-owners cannot inspect scheme data at ${path}`);
  assert.equal(result.body.error, 'payroll_scheme_owner_only');
}

const definition = { effectiveFrom: '2026-10-01', roleParameters: { bartender: {} } };
result = await dispatch({ ...requestFor('POST', `/api/payroll/schemes/${id}/versions`), body: { definition, payoutRiskAcknowledgement } });
assert.equal(result.status, 201);
assert.deepEqual(calls.at(-1), ['createVersion', { userId: id, venueId }, id, definition, payoutRiskAcknowledgement]);

result = await dispatch({ ...requestFor('PUT', `/api/payroll/versions/${versionId}`), body: { definition, payoutRiskAcknowledgement } });
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['replaceDraftVersion', { userId: id, venueId }, versionId, definition, payoutRiskAcknowledgement]);

result = await dispatch(requestFor('POST', `/api/payroll/versions/${versionId}/activate`));
assert.equal(result.status, 200);
assert.equal(calls.at(-1)[0], 'activateVersion');

const previewInput = { periodFrom: '2026-10-01', periodTo: '2026-10-01', employees: [], sales: [] };
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview`), body: { previewInput } });
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['preview', { userId: id, venueId }, versionId, previewInput]);
assert.equal(result.body.official, false);
assert.equal(result.body.persistence, 'none');

result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/approved-attendance`), body: { previewInput } });
assert.equal(result.status, 200);
assert.deepEqual(calls.at(-1), ['previewWithApprovedAttendance', { userId: id, venueId }, versionId, previewInput]);
assert.equal(result.body.official, false);
assert.equal(result.body.persistence, 'none');
assert.equal(result.body.sourceAttendanceApproval.revision, 4);
const callsBeforeNonOwnerAttendancePreview = calls.length;
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/approved-attendance`), user: { id, venueId, role: 'manager' }, body: { previewInput } });
assert.equal(result.status, 403, 'only owner may request an approved-attendance preview');
assert.equal(calls.length, callsBeforeNonOwnerAttendancePreview, 'non-owner is rejected before the approved-attendance preview service is called');
result = await dispatch(requestFor('GET', `/api/payroll/versions/${versionId}/preview/approved-attendance`));
assert.equal(result.handled, false);
assert.equal(result.status, null, 'approved-attendance preview is POST-only');
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/approved-attendance`), body: { previewInput } }, {
  selectedService: { ...service, previewWithApprovedAttendance: async () => {
    throw Object.assign(new Error('attendance changed'), { status: 409, code: 'payroll_preview_attendance_approval_stale' });
  } }
});
assert.equal(result.status, 409, 'stale approval blockers map to their safe domain status');
assert.deepEqual(result.body, { error: 'payroll_preview_attendance_approval_stale' });

const sourcedPreviewInput = { ...previewInput, venueId: 'forged-tenant', coverage: { kind: 'month_to_date_complete', from: '2026-10-01', through: '2026-10-01', complete: true, watermark: 'scenario-v1' } };
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/venue-turnover`), body: { previewInput: sourcedPreviewInput } });
assert.equal(result.status, 200);
assert.equal(calls.at(-1)[0], 'previewWithVenueDailyTurnover');
assert.deepEqual(calls.at(-1).slice(1), [{ userId: id, venueId }, versionId, sourcedPreviewInput],
  'sourced preview takes principal only from authenticated owner session and forwards scenario input unchanged');
assert.equal(result.body.official, false);
assert.equal(result.body.persistence, 'none');
assert.equal(result.body.sourceVenueTurnover.previewOnly, true);

const callsBeforeNonOwnerSourcedPreview = calls.length;
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/venue-turnover`), user: { id, venueId, role: 'manager' }, body: { previewInput } });
assert.equal(result.status, 403, 'only owner may request source-backed turnover previews');
assert.equal(calls.length, callsBeforeNonOwnerSourcedPreview, 'non-owner is rejected before the sourced-preview service is called');
result = await dispatch({ ...requestFor('GET', `/api/payroll/versions/${versionId}/preview/venue-turnover`) });
assert.equal(result.handled, false);
assert.equal(result.status, null, 'sourced preview is a POST-only action');
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/venue-turnover`), body: { previewInput },
  }, { selectedService: { ...service, previewWithVenueDailyTurnover: async () => {
    throw Object.assign(new Error('closed snapshot missing'), { status: 409, code: 'payroll_venue_turnover_snapshot_missing' });
  } } });
assert.equal(result.status, 409, 'source blockers map to their safe domain status');
assert.deepEqual(result.body, { error: 'payroll_venue_turnover_snapshot_missing' });

const sourcedPeriod = { periodFrom: '2026-10-01', periodTo: '2026-10-31' };
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/sourced`), body: sourcedPeriod });
assert.equal(result.status, 200);
assert.deepEqual(result.body, { candidateOnly: true, officialReady: false, calculationStatus: 'unavailable', amount: null });
assert.deepEqual(calls.at(-1), ['previewSourced', { userId: id, venueId }, versionId, sourcedPeriod]);
const callsBeforeExtraSourcedField = calls.length;
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/sourced`), body: { ...sourcedPeriod, sales: [] } });
assert.equal(result.status, 400);
assert.equal(result.body.error, 'invalid_payroll_sourced_preview_request');
assert.equal(calls.length, callsBeforeExtraSourcedField, 'scenario values and extra fields never reach sourced preview service');
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/sourced`),
  user: { id, venueId, role: 'manager' }, body: sourcedPeriod });
assert.equal(result.status, 403);
assert.equal(calls.length, callsBeforeExtraSourcedField, 'non-owner is rejected before sourced preview service');
result = await dispatch(requestFor('GET', `/api/payroll/versions/${versionId}/preview/sourced`));
assert.equal(result.handled, false, 'sourced preview is POST-only');
result = await dispatch({ ...requestFor('POST', `/api/payroll/versions/${versionId}/preview/sourced`), body: sourcedPeriod }, {
  selectedService: { ...service, previewSourced: async () => { throw new Error('database read failed'); } }
});
assert.equal(result.status, 503, 'technical source reads stay server failures, not missing-data results');
assert.equal(result.body.error, 'payroll_scheme_unavailable');

result = await dispatch({ ...requestFor('POST', '/api/payroll/compare'), body: { versionIds: [versionId, id], baselineVersionId: versionId, previewInput } });
assert.equal(result.status, 200);
assert.equal(calls.at(-1)[0], 'compare');
assert.deepEqual(calls.at(-1).slice(1), [{ userId: id, venueId }, [versionId, id], previewInput, versionId]);
const sourcedComparisonInput = { versionIds: [versionId, id], baselineVersionId: versionId,
  periodFrom: '2026-11-01', periodTo: '2026-11-20' };
result = await dispatch({ ...requestFor('POST', '/api/payroll/compare/sourced'), body: sourcedComparisonInput });
assert.equal(result.status, 200);
assert.equal(calls.at(-1)[0], 'compareSourced');
assert.deepEqual(calls.at(-1).slice(1), [{ userId: id, venueId }, sourcedComparisonInput]);
result = await dispatch({ ...requestFor('POST', '/api/payroll/compare/sourced'),
  user: { id, venueId, role: 'manager' }, body: sourcedComparisonInput });
assert.equal(result.status, 403, 'sourced comparisons are owner-only');
const rejectingPool = {
  query: async () => { throw new Error('malformed comparison IDs must be rejected before DB access'); },
  connect: async () => { throw new Error('malformed comparison IDs must be rejected before DB access'); }
};
const validatingService = makePayrollSchemeService(rejectingPool);
await assert.rejects(() => validatingService.compareSourced({ userId: id, venueId }, { ...sourcedComparisonInput, previewInput }),
  error => error.code === 'invalid_payroll_sourced_comparison_request', 'sourced comparison rejects client-supplied sales scenarios');
result = await dispatch({ ...requestFor('POST', '/api/payroll/compare'), body: {
  versionIds: ['not-a-uuid', id], baselineVersionId: id, previewInput
} }, { selectedService: validatingService });
assert.equal(result.status, 400, 'malformed comparison version IDs are client errors');
assert.equal(result.body.error, 'invalid_payroll_scheme_version_id');
result = await dispatch({ ...requestFor('POST', '/api/payroll/compare'), body: {
  versionIds: [versionId, id], baselineVersionId: 42, previewInput
} }, { selectedService: validatingService });
assert.equal(result.status, 400, 'malformed comparison baseline IDs are client errors');
assert.equal(result.body.error, 'invalid_payroll_scheme_version_id');
result = await dispatch({ ...requestFor('POST', '/api/payroll/compare'), body: { versionIds: [versionId, id], baselineVersionId: versionId, previewInput } }, {
  selectedService: { ...service, compare: async () => { throw Object.assign(new Error('comparison_currency_mismatch'), { status: 400, code: 'comparison_currency_mismatch' }); } }
});
assert.equal(result.status, 400, 'mixed currency comparisons return a client error');
assert.equal(result.body.error, 'comparison_currency_mismatch');

result = await dispatch({ ...requestFor('GET', '/api/payroll/schemes'), user: null });
assert.equal(result.status, 401);
assert.equal(result.body.error, 'authentication_required');

result = await dispatch({ ...requestFor('GET', '/api/payroll/schemes'), user: { id, venueId: 'bad', role: 'owner' } });
assert.equal(result.status, 403);

result = await dispatch(requestFor('GET', '/api/payroll/schemes'), { selectedService: null });
assert.equal(result.status, 503);
assert.equal(result.body.error, 'payroll_scheme_database_required');

result = await dispatch(requestFor('GET', `/api/payroll/versions/not-a-uuid`));
assert.equal(result.status, 400);

let bodyRead = false;
result = await dispatch({ ...requestFor('POST', '/api/payroll/schemes'), headers: { ...requestFor('POST', '/').headers, origin: 'https://evil.example.test' }, body: spoofed }, { body: async () => { bodyRead = true; return spoofed; } });
assert.equal(result.status, 403);
assert.equal(result.body.error, 'same_origin_required');
assert.equal(bodyRead, false);

result = await dispatch({ ...requestFor('POST', '/api/payroll/schemes'), headers: { ...requestFor('POST', '/').headers, 'content-type': 'text/plain' }, body: spoofed });
assert.equal(result.status, 415);

result = await dispatch({ ...requestFor('POST', '/api/payroll/schemes'), body: [] });
assert.equal(result.status, 400);

result = await dispatch(requestFor('POST', '/api/payroll/schemes'), {
  body: async () => { throw Object.assign(new Error('secret database text'), { code: 'internal_failure' }); }
});
assert.equal(result.status, 400);
assert.equal(result.body.error, 'invalid_json_body');
assert.equal(JSON.stringify(result.body).includes('secret'), false);

result = await dispatch(requestFor('GET', '/api/payroll/rules'));
assert.equal(result.handled, false, 'legacy payroll endpoints remain outside the scheme route adapter');

assert.equal(sameOriginMutation(requestFor('POST', '/api/payroll/schemes')), true);
assert.equal(sameOriginMutation(requestFor('POST', '/api/payroll/schemes', { headers: { origin: 'https://evil.example.test' } })), false);
assert.equal(sameOriginMutation(requestFor('POST', '/api/payroll/schemes', { headers: { authorization: 'Bearer test', origin: '' } })), true);

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const routeSource = fs.readFileSync(path.join(root, 'payroll-scheme-routes.js'), 'utf8');
assert.match(server, /makePayrollSchemeService\(repositories\.pool\)/, 'service is created only with the PostgreSQL pool');
assert.match(server, /await handlePayrollSchemeRoute\(\{ req, res, url, service: payrollSchemeService, readBody: body, json \}\)/, 'raw HTTP router mounts the isolated scheme adapter');
assert.match(server, /await handlePayrollSchemeRoute[\s\S]*?if \(pathname === '\/api\/payroll\/rules'/, 'new scheme endpoints dispatch before the legacy payroll routes');
assert.match(routeSource, /sameOriginMutation\(req\)/, 'scheme writes include CSRF origin validation');
assert.match(routeSource, /req\.user\.role !== 'owner'/, 'scheme API rejects non-owners before calling the service');
assert.doesNotMatch(routeSource, /payroll_entries|expenses/, 'scheme routes never create payroll entries or expenses');
assert.match(routeSource, /isEntryOverlapDiagnostic/, 'entry overlap diagnostic is a strict owner-only read endpoint');

console.log('PAYROLL SCHEME ROUTES CONTRACT: PASS (owner session boundary, CSRF, CRUD, revisions, scenario/source preview, compare and legacy isolation)');
