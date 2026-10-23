'use strict';

const { normalizeReviewedCorrectionPreview, normalizeReviewedCorrectionCommand } = require('./payroll-reviewed-correction-command');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const decodeId = (value) => {
  try { return decodeURIComponent(value); } catch (_) { return ''; }
};

const sameOriginMutation = (req) => {
  if (/^Bearer\s+/i.test(String(req.headers?.authorization || ''))) return true;
  const origin = String(req.headers?.origin || '');
  const host = String(req.headers?.host || '').trim().toLowerCase();
  const fetchSite = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (!origin || !host || (fetchSite && fetchSite !== 'same-origin')) return false;
  try {
    const parsed = new URL(origin);
    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const protocol = forwardedProto === 'https' || (!forwardedProto && req.socket?.encrypted) ? 'https:' : 'http:';
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.protocol === protocol && parsed.host.toLowerCase() === host;
  } catch (_) { return false; }
};

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const handlePayrollSchemeRoute = async ({ req, res, url, service, readBody, json }) => {
  const pathname = url?.pathname || '';
  const schemeIdPath = pathname.match(/^\/api\/payroll\/schemes\/([^/]+)\/versions$/);
  const versionActionPath = pathname.match(/^\/api\/payroll\/versions\/([^/]+)(?:\/(revisions|activate|preview|preview\/approved-attendance|preview\/venue-turnover|preview\/sourced|source-readiness))?$/);
  const isCollection = pathname === '/api/payroll/schemes';
  const isRunCollection = pathname === '/api/payroll/calculation-runs';
  const isRefundAwareRunCollection = pathname === '/api/payroll/refund-aware-calculation-runs';
  const replayPath = pathname.match(/^\/api\/payroll\/calculation-runs\/([^/]+)\/replay$/);
  const freshnessPath = pathname.match(/^\/api\/payroll\/calculation-runs\/([^/]+)\/freshness$/);
  const supersessionPath = pathname.match(/^\/api\/payroll\/calculation-runs\/([^/]+)\/supersession(\/preview)?$/);
  const calculationEntriesPath = pathname.match(/^\/api\/payroll\/calculation-runs\/([^/]+)\/entries$/);
  const calculationEntryStatePath = pathname.match(/^\/api\/payroll\/calculation-entries\/([^/]+)\/state$/);
  const calculationEntryTransitionPath = pathname.match(/^\/api\/payroll\/calculation-entries\/([^/]+)\/transition$/);
  const reviewedCorrectionContextPath = pathname.match(/^\/api\/payroll\/calculation-entries\/([^/]+)\/(corrections|refund-aware-corrections)$/);
  const isRefundAwareCorrection = reviewedCorrectionContextPath?.[2] === 'refund-aware-corrections'
    || ['/api/payroll/refund-aware-corrections', '/api/payroll/refund-aware-corrections/preview'].includes(pathname);
  const isReviewedCorrectionPreview = ['/api/payroll/reviewed-corrections/preview', '/api/payroll/refund-aware-corrections/preview'].includes(pathname);
  const isReviewedCorrectionWrite = ['/api/payroll/reviewed-corrections', '/api/payroll/refund-aware-corrections'].includes(pathname);
  const isReviewedCorrection = Boolean(reviewedCorrectionContextPath || isReviewedCorrectionPreview || isReviewedCorrectionWrite);
  const createRefundReviewPath = pathname.match(/^\/api\/payroll\/calculation-runs\/([^/]+)\/refund-reviews$/);
  const isRefundReviews = pathname === '/api/payroll/refund-reviews';
  const refundReviewPath = pathname.match(/^\/api\/payroll\/refund-reviews\/([^/]+)(\/decisions)?$/);
  const runPath = pathname.match(/^\/api\/payroll\/calculation-runs\/([^/]+)(?:\/(employees|days)\/([^/]+)(\/lines)?)?$/);
  const isRunPath = Boolean(runPath && (!runPath[2]
    || (runPath[2] === 'employees' && !runPath[4]) || (runPath[2] === 'days' && runPath[4])));
  const isCompare = pathname === '/api/payroll/compare';
  const isSourcedCompare = pathname === '/api/payroll/compare/sourced';
  const isEntryOverlapDiagnostic = pathname === '/api/payroll/entry-overlap-diagnostic';
  const isAttendanceCollection = pathname === '/api/payroll/attendance/approvals';
  const isEmploymentEligibilityCollection = pathname === '/api/payroll/employment-eligibility';
  const isEmploymentEligibilityEmployees = pathname === '/api/payroll/employment-eligibility/employees';
  const productDepartmentCollection = pathname === '/api/payroll/product-department-mappings';
  const productDepartmentRevisionPath = pathname.match(/^\/api\/payroll\/product-department-mappings\/revisions\/([^/]+)$/);
  const productDepartmentNormalWrite = pathname === '/api/payroll/product-department-mappings/revisions';
  const productDepartmentRetroWrite = pathname === '/api/payroll/product-department-mappings/retroactive-revisions';
  if (!isCollection && !isRunCollection && !isRefundAwareRunCollection && !isRunPath && !replayPath && !freshnessPath && !supersessionPath && !calculationEntriesPath && !calculationEntryStatePath && !calculationEntryTransitionPath && !isReviewedCorrection && !createRefundReviewPath && !isRefundReviews && !refundReviewPath && !schemeIdPath && !versionActionPath && !isCompare && !isSourcedCompare && !isEntryOverlapDiagnostic && !isAttendanceCollection
      && !isEmploymentEligibilityCollection && !isEmploymentEligibilityEmployees && !productDepartmentCollection
      && !productDepartmentRevisionPath && !productDepartmentNormalWrite && !productDepartmentRetroWrite) return false;

  if (!req.user) { json(res, 401, { error: 'authentication_required' }); return true; }
  const principal = { userId: req.user.id, venueId: req.user.venueId };
  // Refuse non-owner roles before touching payroll configuration or returning
  // whether a scheme/version exists. The service repeats this check against DB.
  if (req.user.role !== 'owner') { json(res, 403, { error: 'payroll_scheme_owner_only' }); return true; }
  if (!UUID.test(String(principal.userId || '')) || !UUID.test(String(principal.venueId || ''))) {
    json(res, 403, { error: 'payroll_scheme_owner_only' }); return true;
  }
  if ((replayPath || freshnessPath || supersessionPath || isRefundAwareRunCollection) && req.method !== 'POST') {
    res.setHeader?.('Allow', 'POST'); json(res, 405, { error: 'method_not_allowed' }); return true;
  }
  if (calculationEntriesPath && !['GET', 'POST'].includes(req.method)) {
    res.setHeader?.('Allow', 'GET, POST'); json(res, 405, { error: 'method_not_allowed' }); return true;
  }
  if ((calculationEntryStatePath && req.method !== 'GET') || (calculationEntryTransitionPath && req.method !== 'POST')) {
    const allow = calculationEntryStatePath ? 'GET' : 'POST';
    res.setHeader?.('Allow', allow); json(res, 405, { error: 'method_not_allowed' }); return true;
  }
  if (isReviewedCorrection && req.method !== (reviewedCorrectionContextPath ? 'GET' : 'POST')) {
    res.setHeader?.('Allow', reviewedCorrectionContextPath ? 'GET' : 'POST');
    json(res, 405, { error: 'method_not_allowed' }); return true;
  }
  if (createRefundReviewPath || isRefundReviews || refundReviewPath) {
    const allow = createRefundReviewPath || refundReviewPath?.[2] ? 'POST' : 'GET';
    if (req.method !== allow) { res.setHeader?.('Allow', allow); json(res, 405, { error: 'method_not_allowed' }); return true; }
  }
  if ((isRunCollection && !['GET', 'POST'].includes(req.method)) || (isRunPath && req.method !== 'GET')) {
    res.setHeader?.('Allow', isRunCollection ? 'GET, POST' : 'GET');
    json(res, 405, { error: 'method_not_allowed' }); return true;
  }
  if (isEmploymentEligibilityEmployees && req.method !== 'GET') {
    res.setHeader?.('Allow', 'GET'); json(res, 405, { error: 'method_not_allowed' }); return true;
  }
  if (isEntryOverlapDiagnostic && req.method !== 'GET') {
    res.setHeader?.('Allow', 'GET'); json(res, 405, { error: 'method_not_allowed' }); return true;
  }
  if ((productDepartmentCollection && !['GET', 'POST'].includes(req.method))
      || (productDepartmentRevisionPath && req.method !== 'GET')
      || ((productDepartmentNormalWrite || productDepartmentRetroWrite) && req.method !== 'POST')) {
    const allow = productDepartmentCollection ? 'GET, POST' : productDepartmentRevisionPath ? 'GET' : 'POST';
    res.setHeader?.('Allow', allow); json(res, 405, { error: 'method_not_allowed' }); return true;
  }
  if (!service) { json(res, 503, { error: 'payroll_scheme_database_required' }); return true; }

  const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
  if (write && !sameOriginMutation(req)) { json(res, 403, { error: 'same_origin_required' }); return true; }

  let id = '';
  if (schemeIdPath) id = decodeId(schemeIdPath[1]);
  if (versionActionPath) id = decodeId(versionActionPath[1]);
  if (id && !UUID.test(id)) { json(res, 400, { error: schemeIdPath ? 'invalid_payroll_scheme_id' : 'invalid_payroll_scheme_version_id' }); return true; }

  const inputForWrite = async () => {
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw Object.assign(new Error('json_content_type_required'), { status: 415, code: 'json_content_type_required' });
    try {
      const input = await readBody(req);
      if (!isObject(input)) throw Object.assign(new Error('invalid_json_body'), { status: 400, code: 'invalid_json_body' });
      return input;
    } catch (error) {
      if (error?.status) throw error;
      if (error instanceof SyntaxError) throw Object.assign(new Error('invalid_json_body'), { status: 400, code: 'invalid_json_body' });
      if (error?.code === 'payload_too_large') throw Object.assign(new Error('payload_too_large'), { status: 413, code: 'payload_too_large' });
      throw Object.assign(new Error('invalid_json_body'), { status: 400, code: 'invalid_json_body' });
    }
  };

  try {
    if (isRefundAwareRunCollection) {
      if (url.searchParams.size) { json(res, 400, { error: 'payroll_refund_aware_request_invalid' }); return true; }
      const input = await inputForWrite();
      const keys = ['schemeVersionId', 'periodFrom', 'periodTo', 'idempotencyKey'];
      if (Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
          || keys.some(key => !Object.hasOwn(input, key))
          || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))) {
        json(res, 400, { error: 'payroll_refund_aware_request_invalid' }); return true;
      }
      const result = await service.createRefundAwareRun(principal, input);
      json(res, result.status !== 'ready' ? 422 : result.replayed ? 200 : 201, result); return true;
    }
    if (supersessionPath) {
      const runId = decodeId(supersessionPath[1]);
      if (!UUID.test(runId) || url.searchParams.size) {
        json(res, 400, { error: 'invalid_payroll_supersession_request' }); return true;
      }
      const input = await inputForWrite();
      const keys = supersessionPath[2] ? [] : ['expectedPlanHash', 'reason', 'idempotencyKey'];
      if (Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
          || keys.some(key => !Object.hasOwn(input, key))
          || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))) {
        json(res, 400, { error: 'invalid_payroll_supersession_request' }); return true;
      }
      if (supersessionPath[2]) {
        json(res, 200, await service.previewUnpaidRunSupersession(principal, runId.toLowerCase())); return true;
      }
      const result = await service.commitUnpaidRunSupersession(principal, runId.toLowerCase(), input);
      json(res, result.replayed ? 200 : 201, result); return true;
    }
    if (isReviewedCorrection) {
      if (url.searchParams.size) { json(res, 400, { error: 'payroll_correction_request_invalid' }); return true; }
      if (reviewedCorrectionContextPath) {
        const entryId = decodeId(reviewedCorrectionContextPath[1]);
        if (!UUID.test(entryId)) { json(res, 400, { error: 'payroll_correction_entry_invalid' }); return true; }
        json(res, 200, await service[isRefundAwareCorrection ? 'getRefundAwareCorrectionContext' : 'getReviewedCorrectionContext'](principal, entryId.toLowerCase())); return true;
      }
      const input = await inputForWrite();
      const request = isReviewedCorrectionPreview ? normalizeReviewedCorrectionPreview(input) : normalizeReviewedCorrectionCommand(input);
      const result = isReviewedCorrectionPreview
        ? await service[isRefundAwareCorrection ? 'previewRefundAwareCorrection' : 'previewReviewedCorrection'](principal, request)
        : await service[isRefundAwareCorrection ? 'applyRefundAwareCorrection' : 'applyReviewedCorrection'](principal, request);
      json(res, isReviewedCorrectionWrite && !result.replayed ? 201 : 200, result); return true;
    }
    if (calculationEntryStatePath || calculationEntryTransitionPath) {
      const entryId = decodeId((calculationEntryStatePath || calculationEntryTransitionPath)[1]);
      if (!UUID.test(entryId) || url.searchParams.size) {
        json(res, 400, { error: 'invalid_payroll_entry_lifecycle_request' }); return true;
      }
      if (calculationEntryStatePath) {
        json(res, 200, await service.getCalculationEntryState(principal, entryId)); return true;
      }
      const input = await inputForWrite();
      const keys = ['action', 'expectedStateHash', 'idempotencyKey', 'paymentDate', 'paymentAccountId', 'paymentMethod', 'reason'];
      if (Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
          || keys.some(key => !Object.hasOwn(input, key))
          || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) {
        json(res, 400, { error: 'invalid_payroll_entry_lifecycle_request' }); return true;
      }
      const result = await service.transitionCalculationEntry(principal, entryId, input);
      json(res, 200, result); return true;
    }
    if (calculationEntriesPath) {
      const runId = decodeId(calculationEntriesPath[1]);
      if (!UUID.test(runId) || url.searchParams.size) {
        json(res, 400, { error: 'invalid_payroll_entry_materialization_request' }); return true;
      }
      if (req.method === 'GET') { json(res, 200, await service.listCalculationEntries(principal, runId)); return true; }
      const input = await inputForWrite();
      const keys = ['employeeId', 'financeCategoryId', 'idempotencyKey'];
      if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) {
        json(res, 400, { error: 'invalid_payroll_entry_materialization_request' }); return true;
      }
      const result = await service.materializeCalculationEntry(principal, runId, input);
      json(res, result.replayed || result.existing ? 200 : 201, result); return true;
    }
    if (createRefundReviewPath || isRefundReviews || refundReviewPath) {
      const reviewId = createRefundReviewPath ? decodeId(createRefundReviewPath[1]) : refundReviewPath ? decodeId(refundReviewPath[1]) : null;
      if (reviewId !== null && !UUID.test(reviewId)) {
        json(res, 400, { error: 'invalid_payroll_refund_review_request' }); return true;
      }
      const query = {};
      for (const [key, value] of url.searchParams) {
        if (!isRefundReviews || !['runId', 'limit', 'cursor'].includes(key) || Object.hasOwn(query, key)) {
          json(res, 400, { error: 'invalid_payroll_refund_review_request' }); return true;
        }
        query[key] = value;
      }
      if (isRefundReviews) { json(res, 200, await service.listRefundReviews(principal, query)); return true; }
      if (req.method === 'GET') { json(res, 200, await service.getRefundReview(principal, reviewId)); return true; }
      const input = await inputForWrite();
      const keys = createRefundReviewPath ? ['idempotencyKey'] : ['decision', 'reason', 'expectedAssessmentHash', 'idempotencyKey'];
      if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) {
        json(res, 400, { error: 'invalid_payroll_refund_review_request' }); return true;
      }
      const result = createRefundReviewPath ? await service.createRefundReview(principal, reviewId, input)
        : await service.decideRefundReview(principal, reviewId, input);
      json(res, result.replayed ? 200 : 201, result); return true;
    }
    if (replayPath || freshnessPath) {
      const runId = decodeId((replayPath || freshnessPath)[1]);
      if (!UUID.test(runId) || [...url.searchParams].length) {
        json(res, 400, { error: 'invalid_payroll_saved_run_request' }); return true;
      }
      const input = await inputForWrite();
      if (Object.keys(input).length) {
        json(res, 400, { error: 'invalid_payroll_saved_run_request' }); return true;
      }
      json(res, 200, await (freshnessPath ? service.checkSavedRunFreshness(principal, runId)
        : service.replaySavedRun(principal, runId))); return true;
    }
    if (isRunCollection || isRunPath) {
      const allowed = isRunCollection && req.method === 'GET' ? ['schemeVersionId', 'limit', 'cursor']
        : isRunPath && runPath[2] !== 'employees' ? ['limit', 'cursor'] : [];
      const query = {};
      for (const [key, value] of url.searchParams) {
        if (!allowed.includes(key) || Object.hasOwn(query, key)) {
          json(res, 400, { error: 'invalid_payroll_saved_run_request' }); return true;
        }
        query[key] = value;
      }
      if (isRunCollection && req.method === 'POST') {
        const result = await service.createVerifiedRun(principal, await inputForWrite());
        json(res, result.status === 'blocked' ? 422 : result.replayed ? 200 : 201, result); return true;
      }
      if (isRunCollection) {
        json(res, 200, await service.listSavedRuns(principal, query)); return true;
      }
      const runId = decodeId(runPath[1]), childId = runPath[3] ? decodeId(runPath[3]) : null;
      if (!UUID.test(runId) || (childId !== null && !UUID.test(childId))) {
        json(res, 400, { error: 'invalid_payroll_saved_run_request' }); return true;
      }
      const result = runPath[2] === 'employees'
        ? await service.getSavedRunEmployee(principal, runId, childId)
        : runPath[2] === 'days'
          ? await service.getSavedRunLines(principal, runId, childId, query)
          : await service.getSavedRun(principal, runId, query);
      json(res, 200, result); return true;
    }
    if (isEntryOverlapDiagnostic && req.method === 'GET') {
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 2 || keys.filter(key => key === 'from').length !== 1 || keys.filter(key => key === 'to').length !== 1) {
        json(res, 400, { error: 'invalid_payroll_entry_diagnostic_period' }); return true;
      }
      json(res, 200, await service.getEntryOverlapDiagnostic(principal, {
        from: url.searchParams.get('from'), to: url.searchParams.get('to')
      })); return true;
    }
    if ((productDepartmentCollection || productDepartmentRevisionPath) && req.method === 'GET' && url.searchParams.size > 0) {
      json(res, 400, { error: 'invalid_payroll_product_department_request' }); return true;
    }
    if (productDepartmentCollection && req.method === 'GET') {
      json(res, 200, await service.getProductDepartmentMappings(principal)); return true;
    }
    if (productDepartmentRevisionPath && req.method === 'GET') {
      const revisionId = decodeId(productDepartmentRevisionPath[1]);
      if (!UUID.test(revisionId)) { json(res, 400, { error: 'invalid_payroll_product_department_revision_id' }); return true; }
      json(res, 200, await service.getProductDepartmentRevision(principal, revisionId)); return true;
    }
    if (productDepartmentNormalWrite && req.method === 'POST') {
      const result = await service.writeProductDepartmentRevision(principal, await inputForWrite(), false);
      json(res, result.replayed ? 200 : 201, result); return true;
    }
    if (productDepartmentRetroWrite && req.method === 'POST') {
      const result = await service.writeProductDepartmentRevision(principal, await inputForWrite(), true);
      json(res, result.replayed ? 200 : 201, result); return true;
    }
    if ((isEmploymentEligibilityCollection || isEmploymentEligibilityEmployees) && req.method === 'GET' && url.searchParams.size > 0) {
      json(res, 400, { error: 'invalid_payroll_employment_eligibility_request' }); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'source-readiness' && req.method === 'GET') {
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 2 || keys.filter(key => key === 'from').length !== 1 || keys.filter(key => key === 'to').length !== 1) {
        json(res, 400, { error: 'invalid_payroll_source_readiness_period' }); return true;
      }
      json(res, 200, await service.getSourceReadiness(principal, id, {
        from: url.searchParams.get('from'), to: url.searchParams.get('to')
      })); return true;
    }
    if (isCollection && req.method === 'GET') {
      json(res, 200, { items: await service.listSchemes(principal) }); return true;
    }
    if (isCollection && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 201, await service.createScheme(principal, input)); return true;
    }
    if (schemeIdPath && req.method === 'GET') {
      const schemes = await service.listSchemes(principal);
      const scheme = schemes.find((item) => item.id === id);
      if (!scheme) json(res, 404, { error: 'payroll_scheme_not_found' });
      else json(res, 200, { items: scheme.versions || [] });
      return true;
    }
    if (schemeIdPath && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 201, await service.createVersion(principal, id, input.definition, input.payoutRiskAcknowledgement)); return true;
    }
    if (isCompare && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 200, await service.compare(principal, input.versionIds, input.previewInput, input.baselineVersionId)); return true;
    }
    if (isSourcedCompare && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 200, await service.compareSourced(principal, input)); return true;
    }
    if (isAttendanceCollection && req.method === 'GET') {
      json(res, 200, await service.readAttendanceCoverage(principal, {
        periodFrom: url.searchParams.get('from'), periodTo: url.searchParams.get('to')
      })); return true;
    }
    if (isAttendanceCollection && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 201, await service.approveAttendanceCoverage(principal, input)); return true;
    }
    if (isEmploymentEligibilityEmployees && req.method === 'GET') {
      json(res, 200, await service.listEmploymentEligibilityEmployees(principal)); return true;
    }
    if (isEmploymentEligibilityCollection && req.method === 'GET') {
      json(res, 200, await service.getEmploymentEligibilityHistory(principal)); return true;
    }
    if (isEmploymentEligibilityCollection && req.method === 'POST') {
      const input = await inputForWrite();
      const result = await service.createEmploymentEligibilityRevision(principal, input);
      json(res, result.replayed ? 200 : 201, result); return true;
    }
    if (versionActionPath && !versionActionPath[2] && req.method === 'GET') {
      json(res, 200, await service.getVersion(principal, id)); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'revisions' && req.method === 'GET') {
      json(res, 200, { items: await service.listVersionRevisions(principal, id) }); return true;
    }
    if (versionActionPath && !versionActionPath[2] && req.method === 'PUT') {
      const input = await inputForWrite();
      json(res, 200, await service.replaceDraftVersion(principal, id, input.definition, input.payoutRiskAcknowledgement)); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'activate' && req.method === 'POST') {
      json(res, 200, await service.activateVersion(principal, id)); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'preview' && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 200, await service.preview(principal, id, input.previewInput)); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'preview/approved-attendance' && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 200, await service.previewWithApprovedAttendance(principal, id, input.previewInput)); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'preview/venue-turnover' && req.method === 'POST') {
      const input = await inputForWrite();
      json(res, 200, await service.previewWithVenueDailyTurnover(principal, id, input.previewInput)); return true;
    }
    if (versionActionPath && versionActionPath[2] === 'preview/sourced' && req.method === 'POST') {
      const input = await inputForWrite();
      if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'periodFrom') || !Object.hasOwn(input, 'periodTo')) {
        json(res, 400, { error: 'invalid_payroll_sourced_preview_request' }); return true;
      }
      json(res, 200, await service.previewSourced(principal, id, input)); return true;
    }
    return false;
  } catch (error) {
    const lifecyclePath = Boolean(calculationEntryStatePath || calculationEntryTransitionPath);
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 499 ? error.status
      : versionActionPath?.[2] === 'source-readiness' ? 500 : 503;
    const code = lifecyclePath || isReviewedCorrection
      ? error?.code && /^payroll_[a-z0-9_]{1,100}$/.test(error.code) ? error.code
        : status === 415 ? 'json_content_type_required' : status === 413 ? 'payload_too_large'
          : status === 400 && ['invalid_json_body'].includes(error?.code) ? 'invalid_json_body'
            : isReviewedCorrection ? 'payroll_correction_unavailable' : 'payroll_entry_lifecycle_unavailable'
      : error?.code && /^[a-z0-9_]{1,100}$/.test(error.code)
        ? error.code
        : status >= 500 ? 'payroll_scheme_unavailable' : 'invalid_payroll_scheme_request';
    json(res, status, { error: code });
    return true;
  }
};

module.exports = { handlePayrollSchemeRoute, sameOriginMutation };
