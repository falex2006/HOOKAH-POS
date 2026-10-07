'use strict';

// Pure lineage consistency only. Caller-supplied rows do not attest tenant
// ownership, completeness of upstream facts or authority to persist a run.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target']);
const fail = (code) => { throw Object.assign(new TypeError(code), { code }); };
const uuid = (value) => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('payroll_source_uuid_invalid');
  return value.toLowerCase();
};
// Calculator allocation ties use exact code-unit IDs. Never lowercase those
// outputs after allocation: that could change the canonical database winner.
const calculatedUuid = (value) => {
  const normalized = uuid(value);
  if (value !== normalized) fail('payroll_source_calculated_uuid_noncanonical');
  return normalized;
};
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('payroll_source_date_invalid');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('payroll_source_date_invalid');
  return value;
};
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('payroll_source_text_invalid');
  return value.trim();
};
const money = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('payroll_source_money_invalid');
  return value;
};
const decimal = (value) => `${BigInt(value) / 100n}.${String(BigInt(value) % 100n).padStart(2, '0')}`;
const quantity = (value) => {
  const raw = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw)) fail('payroll_source_quantity_invalid');
  const [whole, fraction = ''] = raw.split('.');
  const units = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (units <= 0n || units > 99999999999999n) fail('payroll_source_quantity_invalid');
  return `${whole}.${fraction.padEnd(3, '0')}`;
};
const tenant = (row, venueId) => {
  if (row.venueId !== undefined && uuid(row.venueId) !== venueId) fail('payroll_source_venue_mismatch');
};

const validatePayrollSnapshotSourceContext = ({ venueId, runId, venueTimezone, result, employees, sourceLines }) => {
  const venue = uuid(venueId), run = uuid(runId);
  let formatter;
  if (typeof venueTimezone !== 'string' || !venueTimezone.trim() || venueTimezone !== venueTimezone.trim()) fail('payroll_source_timezone_required');
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: venueTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch (_) { fail('payroll_source_timezone_invalid'); }
  if (!result || !Array.isArray(result.daily) || !Array.isArray(result.employees)
      || !Array.isArray(employees) || !Array.isArray(sourceLines)) fail('payroll_source_collections_required');
  const from = date(result.periodFrom), to = date(result.periodTo);
  if (to < from || from.slice(0, 7) !== to.slice(0, 7)) fail('payroll_source_period_invalid');
  if (typeof result.currency !== 'string' || !/^[A-Z]{3}$/.test(result.currency)) fail('payroll_source_currency_invalid');
  if (!MODES.has(result.mode) || !Array.isArray(result.modes) || result.modes.some((mode) => !MODES.has(mode))) fail('payroll_source_mode_invalid');
  const employeeById = new Map(), calculatedEmployees = new Set(), employeeDayByKey = new Map(), sourceById = new Map();
  for (const employee of employees) {
    if (!employee || typeof employee !== 'object') fail('payroll_source_employee_invalid');
    const id = uuid(employee.id); tenant(employee, venue);
    if (employeeById.has(id)) fail('payroll_source_employee_duplicate');
    employeeById.set(id, { id, name: text(employee.name || employee.fullName, 160) });
  }
  for (const row of result.employees) {
    const id = calculatedUuid(row?.employeeId);
    if (!employeeById.has(id) || calculatedEmployees.has(id)) fail('payroll_source_employee_context_mismatch');
    calculatedEmployees.add(id);
  }
  const items = new Set();
  for (const source of sourceLines) {
    if (!source || typeof source !== 'object') fail('payroll_source_line_invalid');
    tenant(source, venue);
    const id = uuid(source.id), orderId = uuid(source.orderId), orderItemId = uuid(source.orderItemId);
    if (sourceById.has(id) || items.has(orderItemId)) fail('payroll_source_line_duplicate');
    items.add(orderItemId);
    const employeeId = uuid(source.employeeId), menuItemId = uuid(source.menuItemId);
    if (!employeeById.has(employeeId)) fail('payroll_source_employee_context_mismatch');
    const localDate = date(source.localDate);
    const timestamp = typeof source.soldAt === 'string' && source.soldAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
    if (!timestamp || Number(timestamp[2]) > 23 || Number(timestamp[3]) > 59 || Number(timestamp[4]) > 59) fail('payroll_source_timestamp_invalid');
    date(timestamp[1]);
    const instant = new Date(source.soldAt);
    if (!Number.isFinite(instant.getTime())) fail('payroll_source_timestamp_invalid');
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` !== localDate) fail('payroll_source_local_date_mismatch');
    const gross = money(source.grossCents), discount = money(source.discountCents), refund = money(source.refundCents), net = money(source.commissionBaseCents);
    if (BigInt(gross) !== BigInt(discount) + BigInt(refund) + BigInt(net)) fail('payroll_source_net_reconciliation_failed');
    sourceById.set(id, { id, orderId, orderItemId, employeeId, menuItemId, localDate, soldAt: instant.toISOString(),
      employeeName: employeeById.get(employeeId).name, menuItemName: text(source.menuItemName, 160), roleId: text(source.roleId, 80), department: text(source.department, 80),
      quantity: quantity(source.quantity), grossCents: gross, discountCents: discount, refundCents: refund, commissionBaseCents: net,
      turnoverCents: money(source.turnoverCents), grossAmount: decimal(gross), discountAmount: decimal(discount), refundAmount: decimal(refund), commissionBaseNet: decimal(net),
      costSnapshot: source.costSnapshot === undefined ? undefined : structuredClone(source.costSnapshot) });
  }
  const seenDates = new Set(), calculatedLines = new Set();
  for (const day of result.daily) {
    const localDate = date(day?.date);
    if (localDate < from || localDate > to || seenDates.has(localDate) || !Array.isArray(day.employees) || !Array.isArray(day.lines)) fail('payroll_source_daily_context_invalid');
    seenDates.add(localDate);
    for (const row of day.employees) {
      const id = calculatedUuid(row?.employeeId), key = `${id}|${localDate}`;
      if (!calculatedEmployees.has(id) || employeeDayByKey.has(key)) fail('payroll_source_employee_context_mismatch');
      if (!MODES.has(row.mode) || !result.modes.includes(row.mode)) fail('payroll_source_mode_invalid');
      employeeDayByKey.set(key, { employeeId: id, localDate, roleId: text(row.roleId, 80), mode: row.mode });
    }
    for (const line of day.lines) {
      const id = calculatedUuid(line?.lineId), employeeId = calculatedUuid(line.employeeId), source = sourceById.get(id);
      if (calculatedLines.has(id)) fail('payroll_source_calculated_line_duplicate');
      calculatedLines.add(id);
      const context = employeeDayByKey.get(`${employeeId}|${localDate}`);
      if (!source || !context || source.employeeId !== employeeId || source.localDate !== localDate
          || source.roleId !== text(line.roleId, 80) || context.roleId !== source.roleId
          || source.menuItemId !== uuid(line.menuItemId) || source.department !== text(line.department, 80)) fail('payroll_source_line_context_mismatch');
      if (source.commissionBaseCents !== money(line.commissionBaseCents) || source.turnoverCents !== money(line.turnoverCents)) fail('payroll_source_line_amount_mismatch');
      money(line.commissionCents);
      // Rates and calculated commissions belong to payroll output, not POS input.
      const typedNull = (context.mode === 'personal_target' && line.targetAllocation)
        || (context.mode === 'margin_target' && line.marginAllocation);
      if (line.appliedRateBps === null ? !typedNull
        : (!Number.isSafeInteger(line.appliedRateBps) || line.appliedRateBps < 0 || line.appliedRateBps > 20000)) fail('payroll_source_calculated_rate_invalid');
      if (context.mode === 'margin_target') {
        const cost = source.costSnapshot, calculated = line.costSnapshot;
        if (!cost || typeof cost !== 'object' || Array.isArray(cost) || !calculated) fail('payroll_source_cost_snapshot_required');
        const costId = text(cost.id, 160), version = text(cost.version, 160), amount = money(cost.costCents);
        if (costId !== cost.id || version !== cost.version || cost.currency !== result.currency || !/^[A-Z]{3}$/.test(cost.currency)
            || costId !== calculated.id || version !== calculated.version || amount !== calculated.costCents || cost.currency !== calculated.currency) fail('payroll_source_cost_snapshot_mismatch');
        source.costSnapshot = { id: costId, version, currency: cost.currency, costCents: amount };
      } else delete source.costSnapshot;
    }
    if (day.teamFunds !== undefined && !Array.isArray(day.teamFunds)) fail('payroll_source_daily_context_invalid');
    for (const pool of day.teamFunds || []) {
      if (!Array.isArray(pool.memberIds) || !Array.isArray(pool.allocations) || !Array.isArray(pool.sourceLineIds)) fail('payroll_source_daily_context_invalid');
      pool.memberIds.forEach(calculatedUuid);
      pool.sourceLineIds.forEach(calculatedUuid);
      pool.allocations.forEach((allocation) => calculatedUuid(allocation?.id));
    }
  }
  if (calculatedLines.size !== sourceById.size) fail('payroll_source_line_coverage_mismatch');
  for (let day = new Date(`${from}T00:00:00Z`); day.toISOString().slice(0, 10) <= to; day.setUTCDate(day.getUTCDate() + 1)) {
    if (!seenDates.has(day.toISOString().slice(0, 10))) fail('payroll_source_date_coverage_mismatch');
  }
  return { venueId: venue, runId: run, venueTimezone, employeeById, employeeDayByKey, sourceById };
};

module.exports = { validatePayrollSnapshotSourceContext };
