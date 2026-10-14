'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { config, folder, options } = require('./staff-schedule-local-config.cjs');
async function main() {
  const c = config();
  const file = path.join(folder, 'fixtures.json');
  const client = new Client(options(c));
  await client.connect();
  try {
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, c.database);
    let fixtures;
    if (fs.existsSync(file)) fixtures = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      const existing = await client.query("SELECT id FROM organizations WHERE slug IN ('schedule-qa-primary','schedule-qa-other')");
      assert.equal(existing.rowCount, 0, 'Fixtures exist without manifest; refusing to reset credentials');
      fixtures = { database: c.database, password: crypto.randomBytes(20).toString('base64url'),
        organizations: [crypto.randomUUID(), crypto.randomUUID()], venues: [crypto.randomUUID(), crypto.randomUUID()], users: [] };
      for (const [i, role] of ['owner', 'admin', 'manager', 'bartender', 'owner', 'manager'].entries()) {
        fixtures.users.push({ id: crypto.randomUUID(), role, tenant: i < 4 ? 0 : 1,
          login: `schedule-${i}-${role}@example.test`, name: ['Владелец Тестовый', 'Администратор Тестовый', 'Управляющий Тестовый', 'Сотрудник с длинным именем для проверки графика', 'Владелец другого заведения', 'Управляющий другого заведения'][i] });
      }
      fs.writeFileSync(file, JSON.stringify(fixtures, null, 2), { flag: 'wx', mode: 0o600 });
    }
    assert.equal(fixtures.database, c.database);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = `scrypt$${salt}$${crypto.scryptSync(fixtures.password, salt, 64).toString('hex')}`;
    await client.query('BEGIN');
    for (let i = 0; i < 2; i++) {
      await client.query('INSERT INTO organizations(id,name,slug,timezone) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
        [fixtures.organizations[i], `Тестовая организация графика ${i + 1}`, i ? 'schedule-qa-other' : 'schedule-qa-primary', 'Asia/Yekaterinburg']);
      await client.query("INSERT INTO organization_subscriptions(organization_id,plan,status,seats_limit,venues_limit) VALUES ($1,'network','active',50,10) ON CONFLICT (organization_id) DO NOTHING", [fixtures.organizations[i]]);
      await client.query('INSERT INTO venues(id,organization_id,name,timezone) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
        [fixtures.venues[i], fixtures.organizations[i], `График — локальное заведение ${i + 1}`, 'Asia/Yekaterinburg']);
    }
    for (const user of fixtures.users) {
      await client.query(`INSERT INTO users(id,venue_id,organization_id,full_name,login,password_hash,role,birth_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'1990-01-01') ON CONFLICT (id) DO NOTHING`,
      [user.id, fixtures.venues[user.tenant], fixtures.organizations[user.tenant], user.name, user.login, hash, user.role]);
      await client.query(`INSERT INTO organization_memberships(organization_id,user_id,membership_role,status,is_primary)
        VALUES ($1,$2,$3,'active',$4) ON CONFLICT (organization_id,user_id) DO NOTHING`,
      [fixtures.organizations[user.tenant], user.id, user.role === 'owner' ? 'owner' : 'member', user.role === 'owner']);
    }
    await client.query('COMMIT');
    console.log('SCHEDULE FIXTURES: 2 isolated tenants, 6 synthetic users; existing data and credentials preserved.');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
