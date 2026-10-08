import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

// Dedicated synthetic PostgreSQL fixture. It deliberately cannot target a VPS.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const option = process.argv.indexOf('--config');
assert.ok(option >= 0 && process.argv[option + 1], 'Pass --config tmp/full-local-qa/runtime.json');
const configPath = path.resolve(root, process.argv[option + 1]);
assert.equal(configPath, path.join(root, 'tmp', 'full-local-qa', 'runtime.json'), 'Only the dedicated local runtime config is accepted');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
assert.equal(config.database, 'hookah_local_qa');
assert.equal(Number(config.appPort), 31932);
assert.equal(Number(config.dbPort), 31930);
assert.equal(config.container, 'hookah-full-local-qa-20261001');
assert.equal(config.volume, 'hookah-full-local-qa-data-20261001');
const inspection = spawnSync('docker', ['inspect', config.container], { encoding: 'utf8', windowsHide: true });
assert.equal(inspection.status, 0, 'Dedicated QA PostgreSQL must exist');
const container = JSON.parse(inspection.stdout)[0];
assert.equal(container.Config.Labels?.['hookah.local-qa'], '20261001');
assert.ok(container.State.Running && container.Config.Image.startsWith('postgres:'));
assert.ok(container.NetworkSettings.Ports['5432/tcp'].every(binding => binding.HostIp === '127.0.0.1' && Number(binding.HostPort) === 31930));
assert.equal(container.Mounts.length, 1, 'Only one declared persistent QA data mount is accepted');
assert.ok(container.Mounts[0].Type === 'volume' && container.Mounts[0].Name === config.volume && container.Mounts[0].Destination === '/var/lib/postgresql/data' && container.Mounts[0].RW === true && container.HostConfig.AutoRemove === false, 'Only the declared persistent QA volume is accepted');
const pool = new pg.Pool({ host: '127.0.0.1', port: 31930, database: config.database, user: config.dbUser, password: config.dbPassword, max: 1 });
let existingFixtures = 0;
try {
  const identity = (await pool.query('SELECT current_database() AS name')).rows[0];
  assert.equal(identity.name, config.database);
  existingFixtures = Number((await pool.query("SELECT COUNT(*)::int AS count FROM organizations WHERE slug IN ('qaprimary','qasecond')")).rows[0].count);
} finally { await pool.end(); }
const base = 'http://127.0.0.1:31932';
const manifestPath = path.join(root, 'tmp', 'full-local-qa', 'seed-manifest.json');
const manifest = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  assert.equal(existingFixtures, 0, 'QA fixtures already exist: restore their manifest before resuming; never replay financial/stock actions without it');
  return { version: 1, database: config.database, base, createdAt: new Date().toISOString(), entities: {}, actions: {}, credentials: [], organizations: [] };
});
assert.equal(manifest.database, config.database);
assert.equal(manifest.base, base);
const save = () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
let requests = 0;
let lastAt = 0;
let platform;
const fixtureImage = `data:image/png;base64,${(await fs.readFile(path.join(root, 'assets', 'brand', 'icons', 'favicon-48.png'))).toString('base64')}`;
async function request(token, endpoint, method = 'GET', input, statuses = [200]) {
  assert.ok(endpoint.startsWith('/api/') && !endpoint.includes('://'));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 370 - (Date.now() - lastAt))));
  lastAt = Date.now(); requests++;
  const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(25000) });
  if (response.status === 429) {
    const pause = Math.min(60000, Math.max(1000, Number(response.headers.get('retry-after') || 60) * 1000));
    console.log('SEED: local API rate limit; resuming after its retry window');
    for (let remaining = pause; remaining > 0; remaining -= 10000) await new Promise(resolve => setTimeout(resolve, Math.min(10000, remaining)));
    return request(token, endpoint, method, input, statuses);
  }
  const value = await response.json();
  if (response.status === 401 && token && token === platform?.token && endpoint.startsWith('/api/platform/')) {
    platform = await login(config.platformLogin, config.password);
    return request(platform.token, endpoint, method, input, statuses);
  }
  if (!statuses.includes(response.status)) throw new Error(`${method} ${endpoint}: HTTP ${response.status} ${value.error || 'unexpected_response'} ${value.detail || ''}`);
  return value;
}
const items = value => Array.isArray(value) ? value : value.items || value.zones || [];
async function ensure(token, key, listPath, createPath, input, predicate = candidate => candidate.name === input.name) {
  if (manifest.entities[key]) return manifest.entities[key];
  const found = items(await request(token, listPath)).find(predicate);
  const entity = found || await request(token, createPath, 'POST', input, [201]);
  manifest.entities[key] = entity; await save(); return entity;
}
async function once(key, action) {
  if (manifest.actions[key]) return manifest.actions[key];
  const result = await action(); manifest.actions[key] = result || { complete: true }; await save(); return result;
}
const date = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const instant = (days, hour) => `${date(days)}T${String(hour).padStart(2, '0')}:00:00+05:00`;
async function login(loginName, password) { return request(null, '/api/login', 'POST', { username: loginName, password }); }
async function logout(token) { await request(token, '/api/logout', 'POST', {}); }
const health = await request(null, '/api/health');
assert.equal(health.database, 'postgres', 'No in-memory fallback is accepted');
await request(null, '/api/staff', 'GET', undefined, [401,403]);
platform = await login(config.platformLogin, config.password);
assert.equal(platform.user.role, 'platform_owner');
manifest.credentials = [{ role: 'platform_owner', login: config.platformLogin, password: config.password, pin: null }];

async function seedVenue(ownerToken, org, venueId, prefix, extensive) {
  await request(ownerToken, `/api/network/venues/${venueId}/select`, 'POST', {});
  const session = await request(ownerToken, '/api/session');
  assert.equal(session.user.venueId, venueId);
  const staffPassword = config.password.slice(0, 10);
  const staff = [];
  const roles = extensive ? ['admin','manager','senior_bartender','senior_hookah_master','bartender','hookah_master','developer','cleaner','security','technician','other_staff'] : ['admin','bartender','hookah_master'];
  for (const role of roles) {
    const nonCrm = ['cleaner','security','technician','other_staff'].includes(role);
    const loginName = `${prefix}_${role}`;
    const person = await ensure(ownerToken, `${prefix}:staff:${role}`, '/api/staff', '/api/staff', {
      name: `QA ${prefix} ${role}`, role, login: loginName, ...(nonCrm ? {} : { password: staffPassword }), birthDate: '1990-02-12', employmentStartedAt: date(-120), workNotes: 'Синтетический сотрудник для локального QA', phoneNumbers: [{ number: '+7 (000) 000-00-00', primary: true }],
    }, candidate => candidate.name === `QA ${prefix} ${role}`);
    staff.push(person);
    if (role === 'admin') {
      await once(`${prefix}:staff:avatar`, () => request(ownerToken, `/api/staff/${person.id}/avatar`, 'POST', { imageData: fixtureImage }));
      await once(`${prefix}:staff:sensitive-profile`, () => request(ownerToken, `/api/staff/${person.id}/profile`, 'PATCH', { photoUrl: fixtureImage, telegram: '@qa_staff_admin', passportData: { number: '0000 000000', issuedAt: '2000-01-01', issuer: 'ТОЛЬКО СИНТЕТИЧЕСКИЙ QA НЕ ДОКУМЕНТ' } }));
    }
    if (!nonCrm) {
      await once(`${prefix}:pin:${role}`, () => request(ownerToken, `/api/staff/${person.id}/pin`, 'PATCH', { pin: config.pin }));
      manifest.credentials.push({ organizationId: org.id, venueId, userId: person.id, role, login: loginName, password: staffPassword, pin: config.pin });
    }
  }
  if (extensive) {
    const restricted = await ensure(ownerToken, `${prefix}:staff:scoped`, '/api/staff', '/api/staff', { name: `QA ${prefix} scoped admin`, login: `${prefix}_scoped`, password: staffPassword, role: 'admin', permissionScopes: ['orders','reservations'], birthDate: '1992-06-21' });
    await once(`${prefix}:pin:scoped`, () => request(ownerToken, `/api/staff/${restricted.id}/pin`, 'PATCH', { pin: config.pin }));
    manifest.credentials.push({ organizationId: org.id, venueId, userId: restricted.id, role: 'admin_scoped', login: `${prefix}_scoped`, password: staffPassword, pin: config.pin });
    const archived = await ensure(ownerToken, `${prefix}:staff:archived`, '/api/staff', '/api/staff', { name: `QA ${prefix} архив`, login: `${prefix}_archived`, password: staffPassword, role: 'bartender', birthDate: '1991-01-01' });
    await once(`${prefix}:deactivate:staff`, () => request(ownerToken, `/api/staff/${archived.id}/status`, 'PATCH', { active: false }));
    await once(`${prefix}:archive:staff`, () => request(ownerToken, `/api/staff/${archived.id}/archive`, 'POST', {}));
  }
  const zones = [];
  for (const name of ['Основной зал','VIP','Терраса']) zones.push(await ensure(ownerToken, `${prefix}:zone:${name}`, '/api/floor', '/api/floor/zones', { name: `QA ${name}`, expectedVenueId: venueId }));
  const tables = [];
  for (let index = 0; index < 9; index++) {
    const zone = zones[index < 5 ? 0 : index < 7 ? 1 : 2];
    const key = `${prefix}:table:${index}`;
    if (!manifest.entities[key]) {
      const floor = items(await request(ownerToken, '/api/floor'));
      manifest.entities[key] = floor.flatMap(zone => zone.tables || []).find(table => table.name === `QA Стол ${index + 1}`) || await request(ownerToken, '/api/floor/tables', 'POST', { zoneId: zone.id, name: `QA Стол ${index + 1}`, capacity: index === 5 ? 8 : 4, minCapacity: 2, maxCapacity: index === 5 ? 8 : 4, minimumOrderTotal: index === 5 ? 1500 : 0, expectedVenueId: venueId }, [201]);
      await save();
    }
    const table = manifest.entities[key]; tables.push(table);
    await once(`${key}:layout`, () => request(ownerToken, `/api/floor/tables/${table.id}`, 'PATCH', { expectedVenueId: venueId, layout: { x: 40 + (index % 3) * 160, y: 40 + Math.floor(index / 3) * 120, width: 100, height: 70, shape: index % 2 ? 'rectangle' : 'oval', unit: 'px' } }));
  }
  await once(`${prefix}:blocked:table`, () => request(ownerToken, `/api/floor/tables/${tables[8].id}`, 'PATCH', { expectedVenueId: venueId, status: 'blocked' }));
  for (const [code, name] of [['bar','Бар'],['hookah','Кальянный цех'],['kitchen','Кухня'],['inventory','Прочее']]) await ensure(ownerToken, `${prefix}:department:${code}`, '/api/inventory/departments', '/api/inventory/departments', { code, name, color: 'coral' }, candidate => candidate.code === code || candidate.id === code);
  const categoryNames = { bar: 'QA Напитки', hookah: 'QA Кальяны', kitchen: 'QA Кухня', inventory: 'QA Услуги' };
  for (const [code, name] of Object.entries(categoryNames)) {
    const sub = await ensure(ownerToken, `${prefix}:sub:${code}`, '/api/inventory/subdepartments', '/api/inventory/subdepartments', { departmentCode: code, name: `QA ${code}` }, candidate => candidate.name === `QA ${code}` && candidate.departmentCode === code);
    await ensure(ownerToken, `${prefix}:category:${code}`, '/api/product-categories', '/api/product-categories', { name, department: code, subdepartmentId: sub.id });
  }
  const specifications = [
    ['Сироп', 'bar', 'мл', 0.2, 10000, 1000, 'бутылка', 1000], ['Вода','bar','мл',0.01,20000,1000,'бутылка',1000], ['Лайм','bar','г',0.4,5000,500,'кг',1000],
    ['Табак','hookah','г',5,3000,200,'банка',100], ['Уголь','hookah','шт',10,500,30,'пачка',72], ['Хлеб','kitchen','г',0.1,5000,500,'кг',1000], ['Сыр','kitchen','г',0.8,3000,300,'кг',1000],
    ['Готовый сироп','bar','мл',0,0,100,'мл',1], ['Мало на складе','inventory','шт',25,2,10,'шт',1], ['Нет на складе','inventory','шт',25,0,5,'шт',1], ['Инвентарь','inventory','шт',500,3,1,'шт',1], ['Расходник','inventory','шт',2,100,10,'упаковка',100],
  ];
  const stock = [];
  for (let index = 0; index < specifications.length; index++) {
    const [title, department, unit, cost, quantity, minLevel, purchaseUnit, packMultiplier] = specifications[index];
    const item = await ensure(ownerToken, `${prefix}:stock:${index}`, '/api/inventory', '/api/inventory/items', { name: `QA ${title}`, department, subdepartment: `QA ${department}`, category: categoryNames[department], unit, cost, minLevel, purchaseUnit, packMultiplier, supplier: 'QA Поставщик', itemType: index === 10 ? 'equipment' : index === 11 ? 'consumable' : 'ingredient', note: 'Только синтетический локальный QA' });
    stock.push(item);
    if (quantity) await once(`${prefix}:initial-stock:${index}`, () => request(ownerToken, '/api/inventory/movements', 'POST', { itemId: item.id, delta: quantity, unit, reason: `QA ${prefix} начальный остаток` }, [201]));
  }
  const products = [];
  for (const [index, title, department, price, inventoryMode] of [[0,'Лимонад','bar',300,'tracked'],[1,'Кальян','hookah',1200,'tracked'],[2,'Сэндвич','kitchen',450,'tracked'],[3,'Услуга','inventory',200,'non_stock'],[4,'Напиток с премиксом','bar',350,'tracked']]) products[index] = await ensure(ownerToken, `${prefix}:product:${index}`, '/api/products', '/api/products', { name: `QA ${title}`, category: categoryNames[department], price, inventoryMode, aliases: [`qa${index}`, title.toLowerCase()] });
  await once(`${prefix}:product:image`, () => request(ownerToken, `/api/products/${products[0].id}/image`, 'POST', { imageData: fixtureImage }));
  for (const [index, ingredientLines] of [[0,[[0,'30 мл'],[1,'200 мл'],[2,'20 г']]],[1,[[3,'20 г'],[4,'3 шт']]],[2,[[5,'100 г'],[6,'40 г']]],[4,[[7,'40 мл'],[1,'200 мл']]]]) await ensure(ownerToken, `${prefix}:recipe:${index}`, '/api/recipes', '/api/recipes', { name: `QA Техкарта ${index}`, productId: products[index].id, ingredients: ingredientLines.map(([itemIndex, quantity]) => ({ ingredientId: stock[itemIndex].id, quantity })), technology: 'Собрать согласно локальной тестовой карте', serve: 'Порция', yieldQuantity: 1, yieldUnit: 'порция', portionCount: 1 });
  const premixRecipe = await ensure(ownerToken, `${prefix}:recipe:premix`, '/api/recipes', '/api/recipes', { name: 'QA Сироп премикс', recipeType: 'premix', ingredients: [{ ingredientId: stock[0].id, quantity: '100 мл' },{ ingredientId: stock[1].id, quantity: '100 мл' }], yieldQuantity: 200, yieldUnit: 'мл', portionCount: 5 });
  const cancelledBatch = await once(`${prefix}:premix:cancelled`, () => request(ownerToken, '/api/inventory/premixes/produce', 'POST', { recipeId: premixRecipe.id, outputItemId: stock[7].id, multiplier: 1 }, [201]));
  await once(`${prefix}:premix:cancelled:void`, () => request(ownerToken, `/api/inventory/premixes/${cancelledBatch.id}/void`, 'POST', { reason: 'QA ошибочный выпуск до движений' }));
  const batch = await once(`${prefix}:premix:active`, () => request(ownerToken, '/api/inventory/premixes/produce', 'POST', { recipeId: premixRecipe.id, outputItemId: stock[7].id, multiplier: 4, actualOutput: 760, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }, [201]));
  await once(`${prefix}:premix:waste`, () => request(ownerToken, `/api/inventory/premixes/${batch.id}/waste`, 'POST', { quantity: 10, reason: 'QA порча' }));
  await once(`${prefix}:premix:count`, () => request(ownerToken, `/api/inventory/premixes/${batch.id}/count`, 'POST', { actualQuantity: 740, reason: 'QA пересчёт' }));
  const auto = await once(`${prefix}:auto:partial`, () => request(ownerToken, '/api/inventory/auto-orders', 'POST', { items: [{ itemId: stock[9].id, quantity: 20 }], note: 'QA частичная поставка' }, [201]));
  for (let index = 0; index < 4; index++) {
    const input = { supplierName: 'QA Поставщик', documentNumber: `${prefix}-QA-${index + 1}`, documentDate: index === 3 ? null : date(-index), ...(index === 0 ? { sourceAutoOrderId: auto.id } : {}), lines: [{ ingredientId: stock[index === 0 ? 9 : 0].id, quantity: index === 0 ? 10 : 1, unit: index === 0 ? 'шт' : 'бутылка', unitCost: index === 0 ? 25 : 200 }], note: 'QA документ' };
    const doc = await ensure(ownerToken, `${prefix}:purchase:${index}`, '/api/inventory/purchase-documents', '/api/inventory/purchase-documents', input, candidate => candidate.documentNumber === input.documentNumber);
    if (index < 2) await once(`${prefix}:purchase:${index}:post`, () => request(ownerToken, `/api/inventory/purchase-documents/${doc.id}/post`, 'POST', {}));
    if (index === 3) await once(`${prefix}:purchase:${index}:void`, () => request(ownerToken, `/api/inventory/purchase-documents/${doc.id}/void`, 'POST', {}));
    if (index === 0) await once(`${prefix}:purchase:payment`, () => request(ownerToken, `/api/finance/purchase-payables/${doc.id}/payments`, 'POST', { amount: 100, paymentDate: date(0), paymentMethod: 'bank_transfer', idempotencyKey: `${prefix}:purchase:payment:1`, documentUrl: '' }, [201,200]));
    if (index === 1) await once(`${prefix}:purchase:paid`, () => request(ownerToken, `/api/finance/purchase-payables/${doc.id}/payments`, 'POST', { amount: 200, paymentDate: date(0), paymentMethod: 'card', idempotencyKey: `${prefix}:purchase:payment:2`, documentUrl: '' }, [201,200]));
  }
  const groups = [];
  for (let index = 0; index < 3; index++) groups.push(await ensure(ownerToken, `${prefix}:discount:${index}`, '/api/discount-groups', '/api/discount-groups', { name: `QA Группа ${index}`, discountPercent: index * 5, bonusPercent: index * 3, depositMin: index * 500 }));
  const guests = [];
  for (let index = 0; index < 8; index++) {
    const guest = await ensure(ownerToken, `${prefix}:guest:${index}`, '/api/clients', '/api/clients', { name: `QA Гость ${index + 1}`, nickname: `qa_${prefix}_${index}`, guestStatus: ['new','regular','vip','blocked'][index % 4], phoneNumbers: [{ number: `+7 (000) 000-${String(index).padStart(2,'0')}-00`, primary: true }], discountGroupId: groups[index % 3].id, tobaccoPreferences: ['QA Табак'], bowlPreferences: ['Фанел'], barPreferences: ['Лимонад'], allergies: index === 2 ? 'Синтетическая тестовая аллергия' : '', notes: 'Не реальный клиент, локальный QA' });
    guests.push(guest);
  }
  for (let index = 0; index < guests.length; index++) if (index * 100) await once(`${prefix}:guest:loyalty:${index}`, () => request(ownerToken, `/api/clients/${guests[index].id}/loyalty`, 'POST', { delta: index * 100, reason: 'QA начальный баланс', idempotencyKey: `${prefix}:guest:loyalty:${index}` }));
  await once(`${prefix}:guest:loyalty:extra`, () => request(ownerToken, `/api/clients/${guests[1].id}/loyalty`, 'POST', { delta: 50, reason: 'QA начисление', idempotencyKey: `${prefix}:guest:loyalty:extra` }));
  await once(`${prefix}:guest:avatar`, () => request(ownerToken, `/api/clients/${guests[0].id}`, 'PATCH', { avatarUrl: fixtureImage, telegram: '@qa_guest_demo' }));
  await once(`${prefix}:guest:archive`, () => request(ownerToken, `/api/clients/${guests[7].id}/archive`, 'POST', {}));
  for (let index = 0; index < 3; index++) {
    const reservation = await ensure(ownerToken, `${prefix}:reservation:${index}`, '/api/reservations', '/api/reservations', { guestName: guests[index].name, clientId: guests[index].id, phone: `+7 (000) 000-0${index}-00`, date: date(index + 1), time: '19:30', tableId: tables[index === 1 ? 5 : 6 + index % 2].id, guests: index === 1 ? 6 : 2, deposit: index === 1 ? 1500 : 0, notes: `QA ${prefix} бронь ${index}` }, candidate => candidate.notes === `QA ${prefix} бронь ${index}`);
    if (index === 2) await once(`${prefix}:reservation:cancel`, () => request(ownerToken, `/api/reservations/${reservation.id}/cancel`, 'POST', {}));
  }
  for (let index = 0; index < 5; index++) {
    const delivery = await ensure(ownerToken, `${prefix}:delivery:${index}`, '/api/deliveries', '/api/deliveries', { customerName: `QA Доставка ${index}`, address: 'Тестовый город, улица QA, дом 1', total: 500 + index * 100, paymentMethod: ['cash','card','qr'][index % 3], comment: 'Локальный тест' }, candidate => candidate.customerName === `QA Доставка ${index}`);
    if (index) await once(`${prefix}:delivery:${index}:status`, () => request(ownerToken, `/api/deliveries/${delivery.id}`, 'PATCH', { status: ['new','confirmed','in_delivery','delivered','cancelled'][index], courier: 'QA Курьер' }));
  }
  for (let index = 0; index < 8; index++) await ensure(ownerToken, `${prefix}:task:${index}`, '/api/tasks', '/api/tasks', { title: `QA Задача ${index + 1}`, description: 'Синтетическая задача для проверок исполнителя и сроков', status: ['open','in_progress','done','cancelled'][index % 4], priority: ['low','normal','high','urgent'][index % 4], assigneeId: staff[index % staff.length].id, dueDate: date(index - 2) }, candidate => candidate.title === `QA Задача ${index + 1}`);
  for (let index = 0; index < 4; index++) await ensure(ownerToken, `${prefix}:tobacco:${index}`, '/api/tobacco-catalog?scope=all', '/api/tobacco-catalog', { scope: index % 2 ? 'organization' : 'venue', brand: 'QA Brand', flavor: `QA Flavor ${index}`, productLine: 'QA Line', productType: index === 3 ? 'tobacco_free' : 'tobacco', packageGrams: 100, aliases: [`qaflavor${index}`], country: 'Тест', strength: 'Средняя' }, candidate => candidate.flavor === `QA Flavor ${index}`);
  const expenseCategory = await ensure(ownerToken, `${prefix}:finance-category:expense`, '/api/finance/categories', '/api/finance/categories', { name: 'QA Расход', kind: 'expense' });
  await ensure(ownerToken, `${prefix}:finance-category:income`, '/api/finance/categories', '/api/finance/categories', { name: 'QA Доход', kind: 'income' });
  for (let index = 0; index < 3; index++) await ensure(ownerToken, `${prefix}:expense:${index}`, '/api/expenses', '/api/expenses', { categoryId: expenseCategory.id, amount: 500 + index * 250, expenseDate: date(-index), description: `QA ${prefix} расход ${index}`, source: 'manual' }, candidate => candidate.description === `QA ${prefix} расход ${index}`);
  for (let index = 0; index < staff.length; index++) {
    await once(`${prefix}:schedule:${index}`, () => request(ownerToken, '/api/staff/schedule', 'POST', { userId: staff[index].id, workDate: date(0), plannedStart: instant(0,12), plannedEnd: instant(0,20), note: 'QA график' }, [201]));
    await once(`${prefix}:time:${index}`, () => request(ownerToken, '/api/staff/time', 'POST', { userId: staff[index].id, startedAt: instant(-2,12), endedAt: instant(-2,20), source: 'manual', note: 'QA 8 часов' }, [201]));
  }
  for (let index = 0; index < 4; index++) {
    const ruleType = ['hourly','monthly','percent_revenue','per_shift'][index];
    const rule = await ensure(ownerToken, `${prefix}:payroll-rule:${index}`, '/api/payroll/rules', '/api/payroll/rules', { name: `QA ${ruleType}`, ruleType, rate: [300,30000,10,2000][index] });
    const entry = await once(`${prefix}:payroll-entry:${index}`, () => request(ownerToken, '/api/payroll/entries', 'POST', { userId: staff[index % staff.length].id, periodFrom: date(-7), periodTo: date(-1), ruleId: rule.id }, [201]));
    if (index === 1 || index === 3) await once(`${prefix}:payroll-entry:${index}:approve`, () => request(ownerToken, `/api/payroll/entries/${entry.id}`, 'PATCH', { action: 'approve' }));
    if (index === 1) await once(`${prefix}:payroll-entry:${index}:pay`, () => request(ownerToken, `/api/payroll/entries/${entry.id}`, 'PATCH', { action: 'pay', paymentDate: date(0) }));
    if (index === 2) await once(`${prefix}:payroll-entry:${index}:cancel`, () => request(ownerToken, `/api/payroll/entries/${entry.id}`, 'PATCH', { action: 'cancel', reason: 'QA отмена черновика' }));
  }
  const shift = await once(`${prefix}:shift:closed:create`, () => request(ownerToken, '/api/shifts', 'POST', { openingCash: 1000 }, [201]));
  for (let index = 0; index < 6; index++) {
    const key = `${prefix}:history-order:${index}`;
    const order = await ensure(ownerToken, key, '/api/orders', '/api/orders', { tableId: tables[index % 5].id, notes: key }, candidate => candidate.notes === key);
    await once(`${key}:guest`, () => request(ownerToken, `/api/orders/${order.id}`, 'PATCH', { clientId: guests[index % 3].id }));
    for (const productIndex of [index % 3,3]) await once(`${key}:item:${productIndex}`, () => request(ownerToken, `/api/orders/${order.id}/items`, 'POST', { productId: products[productIndex].id, quantity: 1 }, [201,200]));
    if (index === 0) {
      const discount = await once(`${key}:discount`, () => request(ownerToken, `/api/orders/${order.id}/discount-requests`, 'POST', { type: 'percent', value: 10, reason: 'QA скидка' }, [201]));
      await once(`${key}:discount:approve`, () => request(ownerToken, `/api/discount-requests/${discount.id}/approve`, 'POST', {}));
    }
    await once(`${key}:close`, () => request(ownerToken, `/api/orders/${order.id}/close`, 'POST', { paymentMethod: ['cash','card','qr'][index % 3] }));
  }
  let closingCash = 1000;
  for (let index = 0; index < 6; index++) {
    const payments = await request(ownerToken, `/api/orders/${manifest.entities[`${prefix}:history-order:${index}`].id}/payments`);
    closingCash += payments.items.filter(payment => payment.method === 'cash' && ['paid','partially_paid'].includes(payment.status)).reduce((total, payment) => total + Number(payment.amount), 0);
  }
  await once(`${prefix}:shift:closed:close`, () => request(ownerToken, `/api/shifts/${shift.id}/close`, 'POST', { closingCash, checklist: { version: 1, items: { ordersReviewed: true, cashCounted: true, inventoryReviewed: true, externalFiscalReportsHandled: true } } }));
  await once(`${prefix}:shift:open`, () => request(ownerToken, '/api/shifts', 'POST', { openingCash: 2000 }, [201]));
  for (let index = 1; index < guests.length; index++) await once(`${prefix}:guest:deposit:${index}`, () => request(ownerToken, `/api/clients/${guests[index].id}/deposit-top-ups`, 'POST', { amount: index * 250, method: 'card', reason: 'QA начальный баланс', idempotencyKey: `${prefix}:guest:deposit:${index}` }, [201, 200]));
  for (let index = 0; index < 5; index++) {
    const key = `${prefix}:active-order:${index}`;
    const order = await ensure(ownerToken, key, '/api/orders', '/api/orders', { tableId: tables[index].id, notes: key }, candidate => candidate.notes === key);
    await once(`${key}:guest`, () => request(ownerToken, `/api/orders/${order.id}`, 'PATCH', { clientId: guests[index % 3].id }));
    await once(`${key}:item`, () => request(ownerToken, `/api/orders/${order.id}/items`, 'POST', { productId: products[index].id, quantity: 1 }, [201,200]));
    if (index === 1 || index === 2) await once(`${key}:in-progress`, () => request(ownerToken, `/api/orders/${order.id}/status`, 'POST', { status: 'in_progress' }));
    if (index === 2) await once(`${key}:ready`, () => request(ownerToken, `/api/orders/${order.id}/status`, 'POST', { status: 'ready' }));
    if (index === 3) await once(`${key}:cancelled`, () => request(ownerToken, `/api/orders/${order.id}/status`, 'POST', { status: 'cancelled' }));
    if (index === 4) await once(`${key}:partial-payment`, () => request(ownerToken, `/api/orders/${order.id}/payments`, 'POST', { amount: 100, method: 'cash' }, [201]));
    if (index === 0) await once(`${key}:pending-discount`, () => request(ownerToken, `/api/orders/${order.id}/discount-requests`, 'POST', { type: 'percent', value: 5, reason: 'QA заявка ждёт администратора' }, [201]));
  }
  const notifications = await request(ownerToken, '/api/notifications');
  const firstNotification = notifications.items?.[0];
  if (firstNotification) await once(`${prefix}:notification:read`, () => request(ownerToken, `/api/notifications/${encodeURIComponent(firstNotification.id)}/read`, 'PUT', {}));
  manifest.entities[`${prefix}:venue-summary`] = { venueId, staff: staff.map(row => row.id), tables: tables.map(row => row.id), products: products.map(row => row.id), stock: stock.map(row => row.id), guests: guests.map(row => row.id) };
  await save();
  console.log(`SEED: ${prefix} domain fixtures completed`);
}

try {
  for (let index = 0; index < 2; index++) {
    const prefix = index ? 'qasecond' : 'qaprimary';
    const ownerLogin = `${prefix}@example.test`;
    const organization = await ensure(platform.token, `${prefix}:organization`, '/api/platform/organizations', '/api/platform/organizations', { name: index ? 'QA Независимая компания' : 'QA Hookah POS сеть', slug: prefix, ownerName: `QA Владелец ${index + 1}`, ownerLogin, ownerPassword: config.password, plan: 'enterprise', timezone: 'Asia/Yekaterinburg', city: 'Тестовый город', address: 'Тестовая улица 1' }, candidate => candidate.slug === prefix);
    if (!manifest.organizations.some(row => row.id === organization.id)) manifest.organizations.push({ id: organization.id, slug: prefix });
    const owner = await login(ownerLogin, config.password);
    try {
    manifest.credentials.push({ organizationId: organization.id, venueId: owner.user.venueId, userId: owner.user.id, role: 'owner', login: ownerLogin, password: config.password, pin: config.pin });
    await once(`${prefix}:owner:pin`, () => request(owner.token, `/api/staff/${owner.user.id}/pin`, 'PATCH', { pin: config.pin }));
    if (!index) manifest.primaryVenueId = owner.user.venueId;
    await save();
    await seedVenue(owner.token, organization, owner.user.venueId, prefix, !index);
    if (!index) {
      const secondVenue = await ensure(owner.token, `${prefix}:venue:second`, '/api/network/venues', '/api/network/venues', { name: 'QA Второй филиал', city: 'Тестовый город 2', address: 'QA улица 2', timezone: 'Europe/Moscow' });
      await seedVenue(owner.token, organization, secondVenue.id, 'qabranch', false);
      await request(owner.token, `/api/network/venues/${manifest.primaryVenueId}/select`, 'POST', {});
    }
    } finally { await logout(owner.token).catch(() => {}); }
  }
  manifest.completedAt = new Date().toISOString(); manifest.requestCount = requests;
  await save();
  console.log(`LOCAL FULL SEED: PASS (${manifest.organizations.length} tenants, 3 venues, ${Object.keys(manifest.entities).length} entities, ${Object.keys(manifest.actions).length} linked actions)`);
} finally { await logout(platform.token).catch(() => {}); }
