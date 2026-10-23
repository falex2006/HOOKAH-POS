'use strict';
const { hasPayrollVerifiedWriteSnapshot } = require('./payroll-source-fence');

// Payroll-owned classification of an immutable POS product ID. This module
// never reads the live product/category catalog or changes sale amounts.
const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
// PostgreSQL jsonb::text orders object keys by UTF-8 byte length, then bytes,
// and uses spaces after separators. Keep this aligned with the migration hash.
const postgresKeyCompare = (left, right) => Buffer.byteLength(left, 'utf8') - Buffer.byteLength(right, 'utf8')
  || (left < right ? -1 : left > right ? 1 : 0);
const postgresJsonbText = value => {
  if (Array.isArray(value)) return `[${value.map(postgresJsonbText).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(postgresKeyCompare)
    .map(key => `${JSON.stringify(key)}: ${postgresJsonbText(value[key])}`).join(', ')}}`;
  return JSON.stringify(value);
};
const sha256 = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const mappingPayloadSha256 = rows => {
  const payload = normalizeProductDepartmentMappings(rows).map(({ productId, productName, departmentCode, departmentName, effectiveFrom, effectiveTo }) =>
    ({ productId, productName, departmentCode, departmentName, effectiveFrom, effectiveTo }));
  return createHash('sha256').update(postgresJsonbText(payload)).digest('hex');
};
const productDepartmentRevisionWatermark = (venueId, revision, rows) => sha256({ schemaVersion: 1, venueId,
  id: revision.id, revisionNo: revision.revisionNo, supersedesRevisionId: revision.supersedesRevisionId || null,
  reason: revision.reason, idempotencyKey: revision.idempotencyKey, payloadSha256: revision.payloadSha256,
  mappingCount: revision.mappingCount, effectiveFrom: revision.effectiveFrom, retroactiveAttested: revision.retroactiveAttested === true,
  retroactiveReason: revision.retroactiveReason || null, createdBy: revision.createdBy, createdByName: revision.createdByName,
  createdAt: revision.createdAt, mappings: normalizeProductDepartmentMappings(rows) });
const loadLatestProductDepartmentMappingInTransaction = async (db, venueId) => {
  if (!db || typeof db.query !== 'function' || !UUID.test(String(venueId || ''))) fail('payroll_department_mapping_transaction_invalid');
  const isolation = (await db.query('SHOW transaction_isolation')).rows?.[0]?.transaction_isolation;
  const readOnly = (await db.query('SHOW transaction_read_only')).rows?.[0]?.transaction_read_only;
  if (isolation !== 'repeatable read' || (readOnly !== 'on'
      && !(readOnly === 'off' && hasPayrollVerifiedWriteSnapshot(db, venueId)))) fail('payroll_department_mapping_repeatable_read_required');
  const capability = (await db.query(`SELECT to_regclass('payroll_product_department_revisions') IS NOT NULL AS revisions,
    to_regclass('payroll_product_department_mappings') IS NOT NULL AS mappings`)).rows?.[0];
  if (!capability?.revisions || !capability?.mappings) return { component: { status: 'unsupported', reasons: ['payroll_product_department_mapping_schema_missing'] }, revision: null, mappings: [] };
  const revision = (await db.query(`SELECT id::text,revision_no AS "revisionNo",supersedes_revision_id::text AS "supersedesRevisionId",
    reason,idempotency_key AS "idempotencyKey",payload_sha256 AS "payloadSha256",mapping_count AS "mappingCount",
    effective_from::text AS "effectiveFrom",retroactive_attested AS "retroactiveAttested",retroactive_reason AS "retroactiveReason",
    created_by::text AS "createdBy",created_by_name AS "createdByName",
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS "createdAt"
    FROM payroll_product_department_revisions WHERE venue_id=$1 ORDER BY revision_no DESC LIMIT 1`, [venueId])).rows?.[0] || null;
  if (!revision) return { component: { status: 'incomplete', reasons: ['payroll_product_department_mapping_revision_missing'] }, revision: null, mappings: [] };
  const mappings = (await db.query(`SELECT product_id::text AS "productId",product_name_snapshot AS "productName",
    department_code AS "departmentCode",department_name_snapshot AS "departmentName",effective_from::text AS "effectiveFrom",
    effective_to::text AS "effectiveTo" FROM payroll_product_department_mappings
    WHERE venue_id=$1 AND revision_id=$2 ORDER BY product_id,effective_from,effective_to NULLS LAST,department_code,department_name_snapshot`,
    [venueId, revision.id])).rows || [];
  try {
    const normalized = normalizeProductDepartmentMappings(mappings);
    if (normalized.length !== revision.mappingCount || mappingPayloadSha256(normalized) !== revision.payloadSha256) {
      return { component: { status: 'incomplete', reasons: ['payroll_product_department_mapping_revision_digest_mismatch'] }, revision, mappings: [] };
    }
    return { component: { status: 'available', reasons: [], revisionId: revision.id,
      sourceWatermark: productDepartmentRevisionWatermark(venueId, revision, normalized), watermarkScope: 'immutable_owner_attested_product_department_mapping_revision' },
      revision, mappings: normalized };
  } catch (error) {
    return { component: { status: 'incomplete', reasons: [error.code || 'payroll_product_department_mapping_rows_invalid'] }, revision, mappings: [] };
  }
};
const fail = code => { throw Object.assign(new TypeError(code), { code }); };

const normalizeProductDepartmentMappings = rows => {
  if (!Array.isArray(rows) || rows.length > 10000) fail('payroll_department_mappings_invalid');
  const result = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || !UUID.test(String(row.productId || '')) || typeof row.productName !== 'string' || !row.productName.trim()
        || row.productName.trim().length > 160 || !/^[a-z][a-z0-9_-]{0,63}$/.test(String(row.departmentCode || ''))
        || typeof row.departmentName !== 'string' || !row.departmentName.trim() || row.departmentName.trim().length > 160
        || !validDate(row.effectiveFrom) || (row.effectiveTo !== null && !validDate(row.effectiveTo))
        || (row.effectiveTo && row.effectiveTo < row.effectiveFrom)) fail('payroll_department_mapping_row_invalid');
    return { productId: String(row.productId).toLowerCase(), productName: row.productName.trim(), departmentCode: row.departmentCode,
      departmentName: row.departmentName.trim(), effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo || null };
  }).sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)
    || (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0)
    || (a.effectiveTo === b.effectiveTo ? 0 : a.effectiveTo === null ? 1 : b.effectiveTo === null ? -1
      : a.effectiveTo < b.effectiveTo ? -1 : 1)
    || (a.departmentCode < b.departmentCode ? -1 : a.departmentCode > b.departmentCode ? 1 : 0)
    || (a.departmentName < b.departmentName ? -1 : a.departmentName > b.departmentName ? 1 : 0));
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1], current = result[index];
    if (previous.productId === current.productId
        && (!previous.effectiveTo || previous.effectiveTo >= current.effectiveFrom)) fail('payroll_department_mappings_overlap');
  }
  return result;
};

const buildPayrollProductDepartmentSource = ({ venueId, period, timezone, recognitionManifest, revision, mappings }) => {
  if (!UUID.test(String(venueId || '')) || !period || !validDate(period.from) || !validDate(period.to)
      || period.to < period.from || !timezone || typeof timezone !== 'string'
      || !recognitionManifest || recognitionManifest.venueId !== venueId
      || recognitionManifest.period?.from !== period.from || recognitionManifest.period?.to !== period.to
      || (recognitionManifest.period?.timezone !== undefined && recognitionManifest.period.timezone !== timezone)
      || !Array.isArray(recognitionManifest.saleLines) || !Array.isArray(recognitionManifest.refundEvents)) {
    fail('payroll_department_source_evidence_invalid');
  }
  let normalized;
  try { normalized = normalizeProductDepartmentMappings(mappings); }
  catch (error) { return { status: 'incomplete', reasons: [error.code || 'payroll_department_mapping_invalid'], rows: [], refunds: [], coverage: null, sourceWatermark: null }; }
  const reasons = new Set();
  if (recognitionManifest.status !== 'available' || !SHA256.test(recognitionManifest.watermark || '')) {
    reasons.add('payroll_department_recognition_manifest_incomplete');
  }
  if (!revision || !UUID.test(String(revision.id || '')) || !Number.isSafeInteger(revision.revisionNo)
      || revision.revisionNo < 1 || !SHA256.test(revision.payloadSha256 || '')
      || revision.mappingCount !== normalized.length
      || mappingPayloadSha256(normalized) !== revision.payloadSha256) {
    reasons.add('payroll_department_mapping_revision_invalid');
  }
  const byProduct = new Map();
  for (const mapping of normalized) {
    const rows = byProduct.get(mapping.productId) || [];
    rows.push(mapping); byProduct.set(mapping.productId, rows);
  }
  const saleLineById = new Map(), rows = [];
  const saleLines = recognitionManifest.saleLines.map(line => ({ ...line, isRelatedRefundSale: false }));
  const periodSaleIds = new Set(saleLines.map(line => String(line?.saleLineEventId || '').toLowerCase()));
  const relatedRefundSales = Array.isArray(recognitionManifest.refundOriginalSaleAttributions) ? recognitionManifest.refundOriginalSaleAttributions : [];
  for (const line of relatedRefundSales) if (!periodSaleIds.has(String(line?.saleLineEventId || '').toLowerCase())) saleLines.push({ ...line, isRelatedRefundSale: true });
  const classifiedById = new Map();
  for (const line of saleLines) {
    const id = String(line?.saleLineEventId || '').toLowerCase();
    if (!UUID.test(id) || saleLineById.has(id) || line.venueId !== venueId || !validDate(line.recognizedLocalDate)
        || (!line.isRelatedRefundSale && (line.recognizedLocalDate < period.from || line.recognizedLocalDate > period.to))) {
      reasons.add('payroll_department_sale_line_invalid');
      continue;
    }
    saleLineById.set(id, line);
    const productId = String(line.productFacts?.productId || '').toLowerCase();
    if (!UUID.test(productId)) { reasons.add('payroll_department_product_id_missing'); continue; }
    const matches = (byProduct.get(productId) || []).filter(mapping => mapping.effectiveFrom <= line.recognizedLocalDate
      && (!mapping.effectiveTo || mapping.effectiveTo >= line.recognizedLocalDate));
    if (matches.length !== 1) { reasons.add(matches.length ? 'payroll_department_mapping_ambiguous' : 'payroll_department_mapping_missing'); continue; }
    const mapping = matches[0];
    const classified = { saleLineEventId: id, saleEventId: line.saleEventId, venueId, orderId: line.orderId, orderItemId: line.orderItemId,
      productId, productName: mapping.productName, employeeId: line.sellerId || null,
      recognizedLocalDate: line.recognizedLocalDate, timezoneSnapshot: line.timezoneSnapshot,
      departmentCode: mapping.departmentCode, departmentName: mapping.departmentName, mappingRevisionId: revision.id,
      mappingRevisionNo: revision.revisionNo, mappingRowEffectiveFrom: mapping.effectiveFrom, mappingRowEffectiveTo: mapping.effectiveTo };
    classifiedById.set(id, classified);
    if (!line.isRelatedRefundSale) rows.push(classified);
  }
  const refunds = [];
  for (const event of recognitionManifest.refundEvents) {
    if (!event || !UUID.test(String(event.eventId || '')) || event.venueId !== venueId
        || !validDate(event.recognizedLocalDate) || event.recognizedLocalDate < period.from || event.recognizedLocalDate > period.to
        || !Array.isArray(event.lines)) { reasons.add('payroll_department_refund_event_invalid'); continue; }
    for (const refundLine of event.lines) {
      const originalId = String(refundLine?.originalSaleLineEventId || '').toLowerCase();
      const original = saleLineById.get(originalId);
      const classified = classifiedById.get(originalId);
      if (!UUID.test(String(refundLine?.refundLineEventId || '')) || !UUID.test(String(refundLine?.orderItemId || ''))
          || !UUID.test(originalId) || !original || !classified || original.orderItemId !== refundLine.orderItemId) {
        reasons.add('payroll_department_refund_original_sale_unclassified');
        continue;
      }
      refunds.push({ refundEventId: event.eventId, refundLineEventId: refundLine.refundLineEventId,
        originalSaleLineEventId: originalId, originalRecognizedLocalDate: original.recognizedLocalDate,
        departmentCode: classified.departmentCode, mappingRevisionId: classified.mappingRevisionId });
    }
  }
  const coverage = { venueId, period: { from: period.from, to: period.to }, timezone, complete: reasons.size === 0,
    recognizedSaleLineCount: recognitionManifest.saleLines.length, classifiedSaleLineCount: rows.length,
    refundLineCount: recognitionManifest.refundEvents.reduce((sum, event) => sum + (Array.isArray(event?.lines) ? event.lines.length : 0), 0),
    classifiedRefundLineCount: refunds.length, mappingRevisionId: revision?.id || null,
    mappingSourceWatermark: revision && !reasons.has('payroll_department_mapping_revision_invalid')
      ? productDepartmentRevisionWatermark(venueId, revision, normalized) : null,
    recognitionWatermark: recognitionManifest.watermark || null };
  const sourceWatermark = sha256({ schemaVersion: 1, venueId, period, timezone, coverage,
    revision: revision && !reasons.has('payroll_department_mapping_revision_invalid')
      ? { id: revision.id, revisionNo: revision.revisionNo, payloadSha256: revision.payloadSha256,
        sourceWatermark: productDepartmentRevisionWatermark(venueId, revision, normalized) } : null,
    rows, refunds });
  return { schemaVersion: 1, status: reasons.size ? 'incomplete' : 'available', reasons: [...reasons].sort(), rows,
    refunds, coverage, mappingRevision: revision ? { id: revision.id, revisionNo: revision.revisionNo } : null,
    sourceWatermark, watermarkScope: 'payroll_owner_attested_product_department_classification' };
};

module.exports = { validDate, canonicalJson, postgresJsonbText, mappingPayloadSha256, productDepartmentRevisionWatermark,
  loadLatestProductDepartmentMappingInTransaction, normalizeProductDepartmentMappings, buildPayrollProductDepartmentSource };
