import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPayrollProductDepartmentSource, mappingPayloadSha256, normalizeProductDepartmentMappings } =
  require('../payroll-product-department-source.js');

const ids = {
  venue: '11111111-1111-4111-8111-111111111111', product: '22222222-2222-4222-8222-222222222222',
  employee: '33333333-3333-4333-8333-333333333333', sale: '44444444-4444-4444-8444-444444444444',
  line: '55555555-5555-4555-8555-555555555555', refund: '66666666-6666-4666-8666-666666666666',
  refundLine: '77777777-7777-4777-8777-777777777777', revision: '88888888-8888-4888-8888-888888888888'
};
const mappings = [{ productId: ids.product, productName: 'Чай', departmentCode: 'front-bar', departmentName: 'Бар',
  effectiveFrom: '2026-09-01', effectiveTo: null }];
const revision = { id: ids.revision, revisionNo: 1, supersedesRevisionId: null, reason: 'Начальная классификация товаров',
  idempotencyKey: 'department-map-0001', payloadSha256: mappingPayloadSha256(mappings), mappingCount: 1,
  effectiveFrom: '2026-10-01', retroactiveAttested: true, retroactiveReason: 'Подтверждено владельцем по рабочей классификации',
  createdBy: ids.employee, createdByName: 'Владелец', createdAt: '2026-10-01T00:00:00.000Z' };
const manifest = { venueId: ids.venue, currency: 'RUB', period: { from: '2026-10-01', to: '2026-10-31' },
  status: 'available', watermark: 'a'.repeat(64),
  saleLines: [{ saleLineEventId: ids.line, saleEventId: ids.sale, venueId: ids.venue, orderId: ids.sale,
    orderItemId: ids.line, sellerId: ids.employee, recognizedLocalDate: '2026-10-02', timezoneSnapshot: 'Asia/Yekaterinburg',
    productFacts: { productId: ids.product } }],
  refundEvents: [{ eventId: ids.refund, venueId: ids.venue, recognizedLocalDate: '2026-10-03',
    lines: [{ refundLineEventId: ids.refundLine, originalSaleLineEventId: ids.line, orderItemId: ids.line }] }] };
const args = { venueId: ids.venue, period: manifest.period, timezone: 'Asia/Yekaterinburg', recognitionManifest: manifest,
  revision, mappings };

const result = buildPayrollProductDepartmentSource(args);
assert.equal(result.status, 'available');
assert.equal(result.rows.length, 1);
assert.equal(result.rows[0].departmentCode, 'front-bar');
assert.equal(result.rows[0].productName, 'Чай', 'classification uses the frozen mapping name, not the current catalog');
assert.equal(result.rows[0].recognizedLocalDate, '2026-10-02');
assert.equal(result.rows[0].mappingRevisionId, ids.revision);
assert.equal(result.refunds.length, 1);
assert.equal(result.refunds[0].departmentCode, 'front-bar', 'refund inherits original sale classification even after period/date changes');
assert.equal(result.refunds[0].originalRecognizedLocalDate, '2026-10-02');
assert.equal(result.coverage.complete, true);
assert.equal(result.coverage.recognizedSaleLineCount, result.coverage.classifiedSaleLineCount);
assert.equal(result.sourceWatermark, buildPayrollProductDepartmentSource(args).sourceWatermark);

const priorSaleLine = '99999999-9999-4999-8999-999999999999';
const crossPeriod = buildPayrollProductDepartmentSource({ ...args, recognitionManifest: { ...manifest, saleLines: [],
  refundOriginalSaleAttributions: [{ saleLineEventId: priorSaleLine, saleEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    venueId: ids.venue, orderId: ids.sale, orderItemId: ids.line, sellerId: ids.employee,
    recognizedLocalDate: '2026-09-30', timezoneSnapshot: 'Asia/Yekaterinburg', productFacts: { productId: ids.product } }],
  refundEvents: [{ ...manifest.refundEvents[0], lines: [{ ...manifest.refundEvents[0].lines[0], originalSaleLineEventId: priorSaleLine }] }] } });
assert.equal(crossPeriod.status, 'available');
assert.equal(crossPeriod.rows.length, 0, 'prior-period sale is not included as current-period revenue');
assert.equal(crossPeriod.refunds[0].departmentCode, 'front-bar', 'current-period refund inherits classification from prior-period sale');
assert.equal(crossPeriod.refunds[0].originalRecognizedLocalDate, '2026-09-30');

const missing = buildPayrollProductDepartmentSource({ ...args, mappings: [] });
assert.equal(missing.status, 'incomplete');
assert.ok(missing.reasons.includes('payroll_department_mapping_missing'));
assert.equal(missing.coverage.complete, false);

const missingProductId = buildPayrollProductDepartmentSource({ ...args, recognitionManifest: { ...manifest,
  saleLines: [{ ...manifest.saleLines[0], productFacts: {} }] } });
assert.ok(missingProductId.reasons.includes('payroll_department_product_id_missing'));

const tamperedRevision = { ...revision, payloadSha256: 'f'.repeat(64) };
const tampered = buildPayrollProductDepartmentSource({ ...args, revision: tamperedRevision });
assert.equal(tampered.status, 'incomplete');
assert.ok(tampered.reasons.includes('payroll_department_mapping_revision_invalid'));

assert.throws(() => normalizeProductDepartmentMappings([...mappings,
  { ...mappings[0], effectiveFrom: '2026-10-20' }]), /payroll_department_mappings_overlap/);
assert.throws(() => normalizeProductDepartmentMappings([{ ...mappings[0], effectiveTo: '2026-08-31' }]),
  /payroll_department_mapping_row_invalid/);
assert.throws(() => normalizeProductDepartmentMappings(Array(10001).fill(mappings[0])),
  /payroll_department_mappings_invalid/, 'pure and database full-snapshot limits are both 10000 rows');
console.log('PASS payroll-product-department-source-contract');
