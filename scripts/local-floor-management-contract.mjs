import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const base = process.argv[2] || 'http://localhost:3000';
const target = new URL(base);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname)) throw new Error(`Local-only floor contract refused non-local BaseUrl: ${base}`);
const portalSource = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const staffSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const databaseSource = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { ReservationRepository } = require('../db.js');
assert.match(portalSource, /pluralRu\(zone\.tables\?\.length\s*\|\|\s*0,\s*'стол',\s*'стола',\s*'столов'\)/, 'hall cards must say how many tables are configured, not call them seats');
assert.doesNotMatch(`${portalSource}\n${serverSource}`, /zone\.tables\.forEach\(\(entry,\s*(?:index|tableIndex)\)\s*=>\s*\{\s*entry\.name\s*=\s*`Стол/, 'creating or deleting a table must not silently rename the other tables');
assert.match(portalSource, /zoneForm\.dataset\.submitting\s*===\s*'1'/, 'hall creation must guard against duplicate submits');
assert.match(portalSource, /roomForm\.dataset\.submitting\s*===\s*'1'/, 'table creation must guard against duplicate submits');
assert.match(portalSource, /Зал создан, но список не обновился/, 'a saved hall must not be reported as a failed creation if the follow-up refresh fails');
assert.match(portalSource, /Стол создан, но список не обновился/, 'a saved table must not be reported as a failed creation if the follow-up refresh fails');
assert.match(portalSource, /name: 'minCapacity', label: 'Минимум гостей'/, 'editing a seating object must preserve its minimum guest count');
assert.match(portalSource, /name: 'maxCapacity', label: 'Максимум гостей'/, 'editing a seating object must preserve its maximum guest count');
assert.match(portalSource, /capacity: maxCapacity, minCapacity, maxCapacity, minimumOrderTotal/, 'the editor must persist both guest-range boundaries');
assert.match(portalSource, /field\.max !== undefined && Number\(data\[field\.name\]\) > Number\(field\.max\)/, 'numeric editor fields must enforce their configured upper limit');
assert.match(portalSource, /const canAddObjects = zones\.length > 0; for \(const button of \[root\.querySelector\('#new-floor-table'\), root\.querySelector\('#new-vip-room'\)\]\) \{ button\.disabled = !canAddObjects;/, 'table and VIP creation must not masquerade as hall creation when no hall exists');
assert.match(portalSource, /if \(zones\.some\(\(zone\) => zone\.id === selectedZoneId\)\) roomZone\.value = selectedZoneId/, 'refreshing halls must retain the target zone selected in the open table form');
assert.match(portalSource, /validate: \(data\) => Number\(data\.maxCapacity\) < Number\(data\.minCapacity\) \? 'Максимум гостей не может быть меньше минимума'/, 'the room editor must keep an invalid guest range visible and explain it before saving');
assert.match(portalSource, /label>Зал и место<select id="reservation-table" required>/, 'reservation should ask the operator to select a hall and place explicitly');
assert.match(portalSource, /select\.innerHTML = renderReservationTableOptions\(zones\)/, 'reservation choices must be rendered from persisted halls and grouped by their zone');
assert.match(portalSource, /select\.disabled = !tables\.some\(\(table\) => table\.status !== 'blocked'\)/, 'reloading floor data must re-enable the reservation selector when a bookable table appears');
assert.match(portalSource, /if \(tables\.some\(\(table\) => table\.id === selectedId && table\.status !== 'blocked'\)\) select\.value = selectedId/, 'refreshing reservations must preserve a still-bookable selected table');
assert.match(portalSource, /data-max-guests="\$\{maxGuests\}"/, 'reservation places must expose their maximum guest capacity to the form');
assert.match(portalSource, /guests\.max = String\(maximum\)/, 'the guest-count control must follow the selected place capacity');
assert.match(portalSource, /reason === 'table_capacity_exceeded' \? `Для этого места максимум/, 'capacity errors from the API must be explained in Russian');
assert.match(serverSource, /if \(Number\(input\.guests \|\| 1\) > tableMaximum\) return json\(res, 400, \{ error: 'table_capacity_exceeded', maximumGuests: tableMaximum \}\)/, 'the server must reject bookings larger than a table capacity');
assert.match(serverSource, /if \(input\.date === today\(\)\) table\.status = 'reserved'/, 'a future booking must not mark the in-memory floor as reserved today');
assert.match(serverSource, /r\.starts_at AT TIME ZONE COALESCE\(NULLIF\(v\.timezone,''\),'Asia\/Yekaterinburg'\)\)\:\:date=\(now\(\) AT TIME ZONE COALESCE\(NULLIF\(v\.timezone,''\),'Asia\/Yekaterinburg'\)\)\:\:date\) THEN 'reserved'/, 'PostgreSQL floor status must use the venue business timezone');
assert.match(serverSource, /r\.starts_at=\(\$3::timestamp AT TIME ZONE COALESCE\(NULLIF\(v\.timezone,''\),'Asia\/Yekaterinburg'\)\)/, 'PostgreSQL duplicate-booking checks must compare venue-local wall-clock time');
assert.match(serverSource, /FROM reservations r JOIN venues v ON v\.id=r\.venue_id WHERE r\.venue_id=\$1 AND \(r\.starts_at AT TIME ZONE COALESCE\(NULLIF\(v\.timezone,''\),'Asia\/Yekaterinburg'\)\)\:\:date=\(now\(\) AT TIME ZONE COALESCE\(NULLIF\(v\.timezone,''\),'Asia\/Yekaterinburg'\)\)\:\:date AND r\.status='confirmed'/, 'dashboard reservation counts must use the venue-local business date');
assert.match(databaseSource, /z\.name AS "zoneName"[\s\S]*LEFT JOIN zones z ON z\.id=t\.zone_id/, 'PostgreSQL reservation history must retain hall context');
assert.match(databaseSource, /to_char\(\$\{localStartsAt\},'HH24:MI'\)/, 'PostgreSQL reservations must display time in the venue timezone');
const reservationRepositorySource = databaseSource.match(/class ReservationRepository \{[\s\S]*?\n\}/)?.[0];
if (!reservationRepositorySource) throw new Error('Could not isolate PostgreSQL reservation repository');
assert.doesNotMatch(reservationRepositorySource, /UPDATE tables t SET status=.*reserved/, 'floor availability must derive from current reservations and not persist future reservations as today-reserved');
const reservationOptionHelpers = portalSource.match(/const reservationTableCapacityLabel = \(table\) => \{[\s\S]*?\r?\n\};\r?\nconst renderReservationTableOptions = \(zones\) => \{[\s\S]*?\r?\n\};/)?.[0];
if (!reservationOptionHelpers) throw new Error('Could not isolate reservation hall/table option rendering helpers');
const reservationOptionApi = new Function('esc', 'money', 'pluralRu', `${reservationOptionHelpers}; return { reservationTableCapacityLabel, renderReservationTableOptions };`)(
  (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  (value) => `${Number(value).toLocaleString('ru-RU')} ₽`,
  (value, one, few, many) => { const n = Math.abs(Number(value)) % 100; const last = n % 10; return n > 10 && n < 20 ? many : last > 1 && last < 5 ? few : last === 1 ? one : many; }
);
const reservationOptions = reservationOptionApi.renderReservationTableOptions([
  { id: 'hall-a', name: 'Основной зал', tables: [{ id: 'table-a', name: 'Стол 1', minCapacity: 2, maxCapacity: 4, status: 'free' }, { id: 'table-blocked', name: 'Стол 2', capacity: 2, status: 'blocked' }] },
  { id: 'hall-b', name: 'VIP-зал', tables: [{ id: 'room-a', name: 'Стол 1', capacity: 6, status: 'free', minimumOrderTotal: 3500 }] },
]);
for (const expected of ['<optgroup label="Основной зал">', '<optgroup label="VIP-зал">', '2–4 гостя', '6 гостей', 'депозит 3 500 ₽', 'data-max-guests="4"', 'disabled', 'value="table-a"', 'value="room-a"']) if (!reservationOptions.includes(expected)) throw new Error(`Reservation place selector is missing expected group/detail: ${expected}`);
if (!reservationOptionApi.renderReservationTableOptions([{ name: 'Пустой зал', tables: [] }]).includes('В залах ещё нет столов')) throw new Error('An empty floor should explain why there are no places to book');
if (!reservationOptionApi.renderReservationTableOptions([{ name: 'Закрытый зал', tables: [{ id: 'closed', status: 'blocked' }] }]).includes('Нет доступных столов')) throw new Error('A fully blocked floor should explain that no places can be booked');
const databaseCalls = [];
const fakePool = {
  query: async (sql, params) => { databaseCalls.push({ sql, params }); return { rows: [] }; },
  connect: async () => ({
    query: async (sql, params) => {
      databaseCalls.push({ sql, params });
      if (sql.includes('SELECT t.id,t.status::text AS status FROM tables')) return { rows: [{ id: 'qa-table', status: 'free' }] };
      if (sql.includes('INSERT INTO guests')) return { rows: [{ id: 'qa-guest' }] };
      if (sql.includes('INSERT INTO reservations')) return { rows: [{ id: 'qa-reservation' }] };
      return { rows: [] };
    },
    release: () => {},
  }),
};
const reservationRepository = new ReservationRepository(fakePool);
await reservationRepository.list('qa-venue', '2099-01-01');
const postgresListQuery = databaseCalls[0];
if (!postgresListQuery?.sql.includes('LEFT JOIN zones z ON z.id=t.zone_id')) throw new Error('PostgreSQL reservation listing must join and return its hall name');
if (!postgresListQuery.sql.includes("AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg')") || !postgresListQuery.sql.includes('::date=$2::date')) throw new Error('PostgreSQL reservation date and time must be listed and filtered in venue-local time');
databaseCalls.length = 0;
const pgReservationBase = { guestName: 'QA guest', venueId: 'qa-venue', tableId: 'qa-table', tableName: 'Table 1', zoneName: 'Main hall', date: '2099-01-01', time: '20:00', guests: 2, deposit: 0 };
const pgFutureReservation = await reservationRepository.create(pgReservationBase);
if (databaseCalls.some((call) => call.sql.includes('UPDATE tables'))) throw new Error('PostgreSQL repository must not set a future-reserved table to today-reserved');
if (pgFutureReservation.isToday !== undefined || pgFutureReservation.zoneName !== 'Main hall') throw new Error('Repository must retain hall context and must not add internal date flags to its response');
if (!databaseCalls.some((call) => call.sql.includes('AT TIME ZONE COALESCE((SELECT NULLIF(timezone') && call.sql.includes('INSERT INTO reservations'))) throw new Error('PostgreSQL reservation creation must interpret the selected date/time in the venue timezone');
databaseCalls.length = 0;
await reservationRepository.create(pgReservationBase);
if (databaseCalls.some((call) => call.sql.includes('UPDATE tables'))) throw new Error('PostgreSQL reservation creation must leave floor status to the derived floor query');
assert.match(staffSource, /const rawMin=t\.minCapacity\?\?t\.capacity,rawMax=t\.maxCapacity\?\?t\.capacity;[\s\S]*?const capacityText=hasCapacity\?\(/, 'the staff floor must show saved capacity and avoid invented fallback values');
assert.match(staffSource, /Вместимость не указана/, 'the staff floor must explain when capacity is unavailable');
assert.match(staffSource, /const normalizeTableId=\(value\)=>\{const raw=String\(value\|\|''\)\.trim\(\);return raw\.startsWith\('table-'\)\?raw:\(\/\^\\d\+\$\/\.test\(raw\)\?`table-\$\{raw\}`:raw\);\};/, 'UUID table ids from PostgreSQL must remain unchanged while numeric demo ids keep their prefix');
assert.match(staffSource, /JSON\.stringify\(\{tableId,minimumOrderTotal:tableMinimums\[tableId\]\|\|0\}\)/, 'opening an order must submit the original saved table id without adding a second prefix');
assert.match(staffSource, /const floorTableLabel=\(id\)=>\{const raw=String\(id\?\?''\)\.trim\(\);const table=floorTableFor\(raw\);return table\?\.name/, 'the order panel and queue must use the saved human-readable table name');
assert.match(staffSource, /const safeTableName=escapeFloorText\(String\(t\.name\|\|'Стол'\)\.replace\(\/\^Стол \/,''\)\)/, 'custom table names must render as text rather than executable markup');
assert.match(staffSource, /tables\.addEventListener\('click',\(event\)=>\{[\s\S]*?card\.classList\.add\('sel'\);[\s\S]*?else\{currentOrder=null;drawOrder\(\{tableId:id,items:\[\]\}\);\}/, 'selecting a table only updates selection and the right-hand card');
const tableSelectionBlock=staffSource.match(/tables\.addEventListener\('click',[\s\S]*?\n\}\);\ntableContextActions\?\.addEventListener/)?.[0]||'';
assert.doesNotMatch(tableSelectionBlock, /apiJson\(['"]\/api\/orders/, 'selecting a table must not create an order before the user chooses an item');

const normalizeDefinition = staffSource.match(/const normalizeTableId=\(value\)=>\{[\s\S]*?\};(?=\s*let serverZones)/)?.[0];
if (!normalizeDefinition) throw new Error('Could not isolate the worker table-id normalizer');
const normalizeTableId = new Function(`${normalizeDefinition}; return normalizeTableId;`)();
const pgTableId = 'c4c27d09-a49f-4ad2-947c-b1a5552b0001';
if (normalizeTableId(pgTableId) !== pgTableId || normalizeTableId('42') !== 'table-42' || normalizeTableId('table-42') !== 'table-42') throw new Error('Table-id normalization must preserve PostgreSQL UUIDs and legacy numeric table ids');
const labelHelpers = staffSource.match(/const escapeFloorText=[^\n]+\nconst floorTableFor=[^\n]+\nconst floorTableLabel=[^\n]+/)?.[0];
if (!labelHelpers) throw new Error('Could not isolate the worker table-label helper');
const tableLabelApi = new Function(`${normalizeDefinition}; let serverZones=[]; ${labelHelpers}; return { setZones:(zones)=>serverZones=zones, floorTableLabel };`)();
tableLabelApi.setZones([{ tables: [{ id: pgTableId, name: 'Терраса 1' }] }]);
if (tableLabelApi.floorTableLabel(pgTableId) !== 'Терраса 1') throw new Error('Orders must display a table name instead of its database id');
const body = (value) => JSON.stringify(value);
let qaToken = '';
const request = async (path, options = {}) => {
  const response = await fetch(new URL(path, target), { ...options, headers: { 'Content-Type': 'application/json', ...(qaToken ? { Authorization: `Bearer ${qaToken}` } : {}), ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} ${response.status} ${JSON.stringify(payload)}`);
  return payload;
};
const raw = async (path, options = {}) => {
  const response = await fetch(new URL(path, target), { ...options, headers: { 'Content-Type': 'application/json', ...(qaToken ? { Authorization: `Bearer ${qaToken}` } : {}), ...(options.headers || {}) } });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
};
const suffix = Date.now();
const manifest = JSON.parse(readFileSync(new URL('../tmp/full-local-qa/seed-manifest.json', import.meta.url), 'utf8'));
const owner = manifest.credentials.find((entry) => entry.role === 'owner');
if (!owner) throw new Error('Local floor contract requires a seeded owner credential');
const loginResponse = await fetch(new URL('/api/login', target), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: owner.login, password: owner.password }) });
const loginPayload = await loginResponse.json();
if (!loginResponse.ok || !loginPayload.token) throw new Error(`Local floor contract login failed: HTTP ${loginResponse.status}`);
qaToken = loginPayload.token;
const expectedVenueId = (await request('/api/floor')).venueId;
const zone = await request('/api/floor/zones', { method: 'POST', body: body({ expectedVenueId, name: `Тестовый этаж ${suffix}` }) });
if (!zone.id || zone.name !== `Тестовый этаж ${suffix}`) throw new Error('Zone creation returned incomplete data');
const floorBeforeTable = await request('/api/floor');
const visibleEmptyZone = (floorBeforeTable.zones || []).find((entry) => entry.id === zone.id);
if (!visibleEmptyZone || visibleEmptyZone.tables.length !== 0) throw new Error('New empty zone must remain visible before a table is created');
const tableName = `Стол у окна ${suffix}`;
const table = await request('/api/floor/tables', { method: 'POST', body: body({ expectedVenueId, zoneId: zone.id, name: tableName, capacity: 4, minCapacity: 2, maxCapacity: 4 }) });
if (table.name !== tableName || Number(table.minCapacity) !== 2 || Number(table.maxCapacity) !== 4) throw new Error('Creating a table must preserve its name and guest range');
const floorAfterTable = await request('/api/floor');
const createdZone = (floorAfterTable.zones || []).find((entry) => entry.id === zone.id);
if (!createdZone?.tables.some((entry) => entry.id === table.id && entry.name === tableName && Number(entry.minCapacity) === 2 && Number(entry.maxCapacity) === 4)) throw new Error('A table in a newly created zone must remain visible with its name and guest range after reloading the floor');
const reservationDate = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString().slice(0, 10);
const reservationInput = { guestName: `Тест брони ${suffix}`, date: reservationDate, time: '20:00', tableId: table.id, guests: 4, deposit: 0 };
const overCapacity = await raw('/api/reservations', { method: 'POST', body: body({ ...reservationInput, guestName: `Слишком много гостей ${suffix}`, guests: 5 }) });
if (overCapacity.status !== 400 || overCapacity.payload?.error !== 'table_capacity_exceeded' || Number(overCapacity.payload?.maximumGuests) !== 4) throw new Error('Reservation API must reject guest counts above the selected table capacity');
const reservation = await request('/api/reservations', { method: 'POST', body: body(reservationInput) });
if (reservation.tableId !== table.id || reservation.tableName !== tableName || reservation.zoneName !== zone.name) throw new Error('A reservation must retain the selected table and hall names');
const reservationList = await request('/api/reservations');
if (!(reservationList.items || []).some((entry) => entry.id === reservation.id && entry.zoneName === zone.name && entry.tableName === tableName)) throw new Error('Reservation list must return the hall and table names after save');
const floorAfterFutureReservation = await request('/api/floor');
if ((floorAfterFutureReservation.zones || []).find((entry) => entry.id === zone.id)?.tables.find((entry) => entry.id === table.id)?.status !== 'free') throw new Error('A reservation for a future date must not mark the table as reserved today');
await request(`/api/reservations/${encodeURIComponent(reservation.id)}/cancel`, { method: 'POST', body: body({}) });
const secondTableName = `Барная стойка ${suffix}`;
const secondTable = await request('/api/floor/tables', { method: 'POST', body: body({ expectedVenueId, zoneId: zone.id, name: secondTableName, capacity: 4 }) });
const floorAfterSecondTable = await request('/api/floor');
const savedTables = (floorAfterSecondTable.zones || []).find((entry) => entry.id === zone.id)?.tables || [];
if (!savedTables.some((entry) => entry.id === table.id && entry.name === tableName) || !savedTables.some((entry) => entry.id === secondTable.id && entry.name === secondTableName)) throw new Error('Adding another table must not overwrite existing table names');
const room = await request('/api/floor/tables', { method: 'POST', body: body({ expectedVenueId, zoneId: zone.id, name: `VIP-комната тест ${suffix}`, capacity: 8, minimumOrderTotal: 3500 }) });
if (!room.id || Number(room.capacity) !== 8 || Number(room.minimumOrderTotal) !== 3500) throw new Error('Room creation returned incomplete data');
const invalidRange = await raw(`/api/floor/tables/${encodeURIComponent(room.id)}`, { method: 'PATCH', body: body({ expectedVenueId, capacity: 3, minCapacity: 6, maxCapacity: 3 }) });
if (invalidRange.status !== 400 || invalidRange.payload?.error !== 'invalid_table_capacity') throw new Error('A guest range with a maximum below its minimum must be rejected');
const updated = await request(`/api/floor/tables/${encodeURIComponent(room.id)}`, { method: 'PATCH', body: body({ expectedVenueId, name: `VIP-комната обновлена ${suffix}`, capacity: 10, minCapacity: 6, maxCapacity: 10, minimumOrderTotal: 4000 }) });
if (updated.name !== `VIP-комната обновлена ${suffix}` || Number(updated.capacity) !== 10 || Number(updated.minCapacity) !== 6 || Number(updated.maxCapacity) !== 10 || Number(updated.minimumOrderTotal) !== 4000) throw new Error('Room update returned incomplete data');
const floorAfterEdit = await request('/api/floor');
const persistedRoom = (floorAfterEdit.zones || []).find((entry) => entry.id === zone.id)?.tables.find((entry) => entry.id === room.id);
if (!persistedRoom || Number(persistedRoom.minCapacity) !== 6 || Number(persistedRoom.maxCapacity) !== 10) throw new Error('Editing a room must persist its guest range across a floor reload');
const protectedZone = await raw(`/api/floor/zones/${encodeURIComponent(zone.id)}`, { method: 'DELETE', body: body({ expectedVenueId }) });
if (protectedZone.status !== 409 || protectedZone.payload?.error !== 'zone_not_empty') throw new Error('Non-empty zone deletion was not protected');
await request(`/api/floor/tables/${encodeURIComponent(room.id)}`, { method: 'DELETE', body: body({ expectedVenueId }) });
await request(`/api/floor/tables/${encodeURIComponent(secondTable.id)}`, { method: 'DELETE', body: body({ expectedVenueId }) });
const floorAfterDelete = await request('/api/floor');
if (!(floorAfterDelete.zones || []).find((entry) => entry.id === zone.id)?.tables.some((entry) => entry.id === table.id && entry.name === tableName)) throw new Error('Deleting a table must not rename the remaining tables');
const health = await request('/api/health');
if (health.database === 'postgres') {
  const historicalTableDelete = await raw(`/api/floor/tables/${encodeURIComponent(table.id)}`, { method: 'DELETE', body: body({ expectedVenueId }) });
  assert.equal(historicalTableDelete.status, 409, 'a table referenced by reservation history must be preserved');
  const history = await request('/api/reservations');
  assert.ok(history.items.some((entry) => entry.id === reservation.id && entry.tableName === tableName && entry.zoneName === zone.name), 'cancelled reservation retains its table and hall context');
} else {
  await request(`/api/floor/tables/${encodeURIComponent(table.id)}`, { method: 'DELETE', body: body({ expectedVenueId }) });
  await request(`/api/floor/zones/${encodeURIComponent(zone.id)}`, { method: 'DELETE', body: body({ expectedVenueId }) });
}
const floor = await request('/api/floor');
if (health.database !== 'postgres' && (floor.zones || []).some((entry) => entry.id === zone.id)) throw new Error('Deleted zone remains in floor response');
if (health.database === 'postgres') assert.ok((floor.zones || []).find((entry) => entry.id === zone.id)?.tables.some((entry) => entry.id === table.id), 'historical table remains available after refused deletion');
const floorObjects = (floor.zones || []).flatMap((entry) => entry.tables || []);
if (floorObjects.some((entry) => !Number.isInteger(Number(entry.capacity)) || Number(entry.capacity) < 1)) throw new Error('Floor response contains an object without a valid capacity');
console.log(`LOCAL FLOOR MANAGEMENT CONTRACT: PASS (empty zone reload→table creation→reload, room=${room.id})`);
