import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../migrations/143_payroll_personal_departments.sql', import.meta.url), 'utf8');
const prior = await readFile(new URL('../migrations/089_payroll_milestone_snapshots.sql', import.meta.url), 'utf8');
const pathPattern = source => {
  const matches = [...source.matchAll(/parameter_path ~ '([^']+)'/g)];
  assert.equal(matches.length, 1, 'exactly one explicit parameter-path constraint');
  return matches[0][1];
};
const currentPattern = pathPattern(sql);
assert.equal(currentPattern.replace('itemRuleBasis|department|', 'itemRuleBasis|').replace('cap\\.(rateBps|basis|department)', 'cap\\.(rateBps|basis)'), pathPattern(prior), '143 is exactly the 089 path whitelist plus department and cap.department');
const allowed = new RegExp(currentPattern);
for (const parameter of ['mode', 'applyMilestones', 'milestoneEligibility', 'perShiftCents', 'stableRateBps', 'targetCents', 'baseRateBps', 'bonusRateBps', 'excessRatePolicy', 'teamWeight', 'lossPolicy', 'itemRuleBasis', 'bracketRatesBps.0', 'bracketRatesBps.40000000', 'cap.rateBps', 'cap.basis', 'milestoneBonusesCents.40000000', 'department', 'cap.department']) assert.equal(allowed.test(parameter), true, parameter);
for (const parameter of ['departments', 'cap', 'cap.department.name', 'department.name', 'teamFund.departments', 'teamFund.targetCents', 'capXdepartment', 'department ', 'department\n', '__proto__']) assert.equal(allowed.test(parameter), false, parameter);

const code = sql.replace(/--[^\r\n]*/g, '');
const statements = code.split(';').map(value => value.trim()).filter(Boolean);
assert.equal(statements.length, 4, 'only two named CHECK replacements; no new storage or backfill');
for (const [index, name] of ['payroll_employee_overrides_parameter_path_check', 'payroll_employee_overrides_department_value_check'].entries()) {
  assert.match(statements[index * 2], new RegExp(`^ALTER TABLE payroll_employee_overrides\\s+DROP CONSTRAINT IF EXISTS ${name}$`));
  assert.match(statements[index * 2 + 1], new RegExp(`^ALTER TABLE payroll_employee_overrides\\s+ADD CONSTRAINT ${name}\\s+CHECK \\(`));
}
assert.doesNotMatch(code, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|CASCADE|NOT VALID|DISABLE|ENABLE|EXECUTE|GRANT|REVOKE)\b/i);
assert.doesNotMatch(code, /\b(?:orders|payments|expenses|payroll_entries|payroll_calculation_runs|inventory_departments|users|venues)\b/i);
assert.match(code, /parameter_path NOT IN \('department','cap\.department'\)/);
assert.match(code, /OR override_mode = 'inherit'/);
assert.match(code, /override_mode = 'override'\s+AND value_json IS NOT NULL\s+AND jsonb_typeof\(value_json\) = 'string'/);
assert.match(code, /char_length\(value_json #>> '\{\}'\) BETWEEN 1 AND 80/);
assert.match(code, /\(value_json #>> '\{\}'\) = btrim\(value_json #>> '\{\}',/);
assert.match(code, /\(value_json #>> '\{\}'\) !~ U&'\[\\0001-\\001F\\007F-\\009F\]'/);
assert.doesNotMatch(code, /\[:(?:space|cntrl):\]/, 'SQL locale classes must not decide key identity');

// Compare the exact SQL btrim character set to JavaScript trim behavior. This
// verifies the declared grammar, not PostgreSQL execution of the CHECK.
const trimLiteral = code.match(/btrim\(value_json #>> '\{\}',\s*U&'([^']+)'\)/)?.[1];
assert.ok(trimLiteral);
const trimPoints = [...trimLiteral.matchAll(/\\([0-9A-F]{4})/g)].map(match => Number.parseInt(match[1], 16));
assert.equal(trimLiteral.replace(/\\[0-9A-F]{4}/g, ''), '');
assert.equal(new Set(trimPoints).size, trimPoints.length);
const ecmaTrimPoints = [0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF];
assert.deepEqual(trimPoints, ecmaTrimPoints);
for (const point of trimPoints) {
  const char = String.fromCodePoint(point);
  assert.equal(`${char}bar${char}`.trim(), 'bar');
}
// U+180E and U+200B are not ECMAScript trim whitespace; do not silently strip.
for (const point of [0x180E, 0x200B]) {
  const value = `${String.fromCodePoint(point)}bar`;
  assert.equal(value.trim(), value);
}
assert.equal([...('😀'.repeat(80))].length, 80);
assert.equal(('😀'.repeat(80)).length, 160, 'department bound is code points, not UTF-16 length');
console.log('PAYROLL PERSONAL DEPARTMENT MIGRATION: STATIC PASS (089 whitelist preserved, only two named replay-safe CHECK replacements, exact Unicode grammar; actual PostgreSQL replay/guards require separate QA)');
