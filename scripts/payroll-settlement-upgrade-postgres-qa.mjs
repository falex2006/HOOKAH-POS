import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { validateQaDatabaseUrl, assertQaDatabaseIdentity } from './postgres-qa-safety.mjs';

const { Client } = createRequire(import.meta.url)('pg');
const target = validateQaDatabaseUrl(process.env.MIGRATIONS_PG_TEST_DATABASE_URL);
const db = new Client({ connectionString: target.url.href });
const schema = 'payroll_upgrade_' + randomUUID().replaceAll('-', '');
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

await db.connect();
try {
  const identity = (await db.query(`SELECT current_database() AS database, inet_server_addr()::text AS address,
    inet_server_port() AS port,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
  assertQaDatabaseIdentity(identity, target.database, Number(target.url.port || 5432));
  await db.query('BEGIN');
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET LOCAL search_path TO "${schema}", public`);
  await db.query(read('schema.sql'));
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations.filter(name => Number(name.slice(0, 3)) <= 211)) {
    await db.query(read('migrations/' + name));
  }
  const venue = (await db.query("INSERT INTO venues(name) VALUES('Payroll upgrade QA') RETURNING id")).rows[0].id;
  const employee = (await db.query(`INSERT INTO users(venue_id,full_name,login,role)
    VALUES($1,'Upgrade QA','payroll-upgrade','bartender') RETURNING id`, [venue])).rows[0].id;
  const expense = (await db.query(`INSERT INTO expenses(venue_id,category,amount,expense_date,description,source)
    VALUES($1,'Salary',100,'2026-01-15','Historical payroll','payroll') RETURNING id`, [venue])).rows[0].id;
  const entry = (await db.query(`INSERT INTO payroll_entries(venue_id,user_id,period_from,period_to,amount,status,expense_id)
    VALUES($1,$2,'2026-01-01','2026-01-14',100,'paid',$3) RETURNING id`, [venue, employee, expense])).rows[0].id;
  await db.query('SET CONSTRAINTS ALL IMMEDIATE');
  const file = migrations.filter(name => name.startsWith('212_'));
  assert.equal(file.length, 1);
  await db.query(read('migrations/' + file[0]));
  const persisted = (await db.query(`SELECT e.expense_id,x.amount::text,x.description,x.payroll_settlement_entry_id
    FROM payroll_entries e JOIN expenses x ON x.venue_id=e.venue_id AND x.id=e.expense_id WHERE e.id=$1`, [entry])).rows[0];
  assert.deepEqual(persisted, {
    expense_id: expense, amount: '100.00', description: 'Historical payroll', payroll_settlement_entry_id: null
  });
  for (const [sql, id] of [
    ['UPDATE payroll_entries SET expense_id=NULL WHERE id=$1', entry],
    ['DELETE FROM payroll_entries WHERE id=$1', entry],
    ["UPDATE expenses SET description='changed' WHERE id=$1", expense]
  ]) {
    await db.query('SAVEPOINT protected_row');
    await assert.rejects(db.query(sql, [id]), error => error.code === '55000');
    await db.query('ROLLBACK TO SAVEPOINT protected_row');
  }
  console.log('PASS payroll 211 to 212 upgrade: historical amount, description and links preserved and immutable');
} finally {
  try { await db.query('ROLLBACK'); } finally { await db.end(); }
}

