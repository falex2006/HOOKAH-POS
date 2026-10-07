import sharp from 'sharp';

const base = process.argv[2] || 'http://localhost:3000';
const target = new URL(base);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname)) {
  throw new Error(`Local-only contract test refused non-local BaseUrl: ${base}`);
}

const request = async (path, options = {}) => {
  const response = await fetch(new URL(path, target), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} ${response.status} ${JSON.stringify(payload)}`);
  return payload;
};
const requestRaw = async (path, options = {}) => {
  const response = await fetch(new URL(path, target), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  return { status: response.status, payload };
};
const body = (value) => JSON.stringify(value);
const suffix = Date.now();

const category = await request('/api/product-categories', { method: 'POST', body: body({ name: `Локальная проверка ${suffix}` }) });
const product = await request('/api/products', { method: 'POST', body: body({ name: `Локальная позиция ${suffix}`, category: category.name, price: 123, inventoryMode: 'non_stock', aliases: ['проверка', 'test'], imageUrl: 'data:image/png;base64,AA==' }) });
await request(`/api/products/${product.id}`, { method: 'PATCH', body: body({ price: 130, aliases: ['обновлённая позиция'] }) });
await request(`/api/products/${product.id}/image`, { method: 'POST', body: body({ imageData: 'data:image/png;base64,AA==' }) });

const inventoryItem = await request('/api/inventory/items', { method: 'POST', body: body({ name: `Локальный ингредиент ${suffix}`, unit: 'шт', itemType: 'ingredient', cost: 10 }) });
if (!inventoryItem) throw new Error('Inventory contract has no test item');
await request('/api/inventory/movements', { method: 'POST', body: body({ itemId: inventoryItem.id, unit: 'шт', delta: 1, reason: 'Локальная проверка' }) });
const inventoryAfter = await request('/api/inventory');
const persistedInventoryItem = inventoryAfter.items?.find((item) => item.id === inventoryItem.id);
if (Number(persistedInventoryItem?.onHand) !== 1) throw new Error('Inventory movement was not persisted');

const financeCategory = await request('/api/finance/categories', { method: 'POST', body: body({ name: `Локальная категория ${suffix}`, kind: 'expense' }) });
await request(`/api/finance/categories/${financeCategory.id}`, { method: 'PATCH', body: body({ name: `Обновлённая категория ${suffix}` }) });

const expectedFloorVenueId = (await request('/api/floor')).venueId;
const emptyZone = await request('/api/floor/zones', { method: 'POST', body: body({ expectedVenueId: expectedFloorVenueId, name: `Тестовый зал ${suffix}` }) });
const table = await request('/api/floor/tables', { method: 'POST', body: body({ expectedVenueId: expectedFloorVenueId, zoneId: emptyZone.id, name: `Стол тестовый ${suffix}`, capacity: 2 }) });
const tableLayout = await request(`/api/floor/tables/${table.id}`, { method: 'PATCH', body: body({ expectedVenueId: expectedFloorVenueId, name: `Стол тест ${suffix}`, capacity: 4, layout: { x: 120, y: 80, width: 160, height: 90, rotation: 0, shape: 'rectangle' } }) });
if (tableLayout.name !== `Стол тест ${suffix}` || Number(tableLayout.layout?.width) !== 160) throw new Error('Floor table layout contract returned incomplete data');
const floorAfter = await request('/api/floor');
const persistedTable = floorAfter.zones?.flatMap((zone) => zone.tables || []).find((entry) => entry.id === table.id);
if (!persistedTable || persistedTable.name !== `Стол тест ${suffix}` || Number(persistedTable.layout?.x) !== 120 || Number(persistedTable.layout?.height) !== 90) throw new Error('Floor table layout was not persisted to floor view');
const order = await request('/api/orders', { method: 'POST', body: body({ tableId: table.id, orderType: 'regular' }) });
await request(`/api/orders/${order.id}/items`, { method: 'POST', body: body({ productId: product.id, quantity: 1 }) });
const fixedDiscount = await requestRaw(`/api/orders/${order.id}/discount-requests`, { method: 'POST', body: body({ type: 'fixed', value: 100, reason: 'Неверный формат' }) });
if (fixedDiscount.status !== 400) throw new Error(`Fixed discount was accepted: ${fixedDiscount.status}`);
const percentDiscount = await request(`/api/orders/${order.id}/discount-requests`, { method: 'POST', body: body({ type: 'percent', value: 10, reason: 'Локальная проверка' }) });
const duplicateDiscount = await requestRaw(`/api/orders/${order.id}/discount-requests`, { method: 'POST', body: body({ type: 'percent', value: 5, reason: 'Повторная заявка' }) });
if (duplicateDiscount.status !== 409) throw new Error(`Duplicate discount was accepted: ${duplicateDiscount.status}`);
await request(`/api/discount-requests/${percentDiscount.id}/approve`, { method: 'POST', body: body({ decidedBy: 'локальная проверка' }) });
const shiftState = await request('/api/shifts');
if (!shiftState.current) await request('/api/shifts', { method: 'POST', body: body({ openingCash: 0 }) });
await request(`/api/orders/${order.id}/close`, { method: 'POST', body: body({ paymentMethod: 'cash' }) });
const reservation = await request('/api/reservations', { method: 'POST', body: body({ guestName: `Локальный гость ${suffix}`, phone: '+79990001122', date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), time: '22:00', tableId: table.id, guests: 2, deposit: 0, notes: 'Локальная проверка' }) });
await request(`/api/reservations/${reservation.id}/cancel`, { method: 'POST', body: '{}' });

const delivery = await request('/api/deliveries', { method: 'POST', body: body({ customerName: `Локальная доставка ${suffix}`, phone: '+79990001123', address: 'Тестовый адрес', total: 500 }) });
await request(`/api/deliveries/${delivery.id}`, { method: 'PATCH', body: body({ status: 'in_delivery', courier: 'QA courier' }) });
const deliveryAfter = (await request('/api/deliveries')).items?.find((item) => item.id === delivery.id);
if (!deliveryAfter || deliveryAfter.status !== 'in_delivery' || deliveryAfter.courier !== 'QA courier' || Number(deliveryAfter.total) !== 500 || deliveryAfter.address !== 'Тестовый адрес') throw new Error('Delivery round-trip did not preserve fields and status');
if ('venueId' in deliveryAfter || 'venue_id' in deliveryAfter) throw new Error('Delivery internal tenant field leaked into response');

const venueBefore = await request('/api/venue');
const venueAfter = await request('/api/venue', { method: 'PATCH', body: body({ expectedVenueId: venueBefore.id, name: `Территория тест ${suffix}`, city: 'Тестовый город', address: 'Тестовый адрес заведения', format: 'тестовый кальян-бар', timezone: 'Europe/Moscow', phone: '+79990001125', logoUrl: 'data:image/png;base64,AA==', vipRoomMinimums: { vip_room_1: 1500, vip_room_2: 2500 } }) });
if (venueAfter.name !== `Территория тест ${suffix}` || venueAfter.city !== 'Тестовый город' || venueAfter.address !== 'Тестовый адрес заведения' || venueAfter.format !== 'тестовый кальян-бар' || venueAfter.timezone !== 'Europe/Moscow' || venueAfter.phone !== '+79990001125' || venueAfter.logoUrl !== 'data:image/png;base64,AA==' || venueAfter.vipRoomMinimums?.vip_room_1 !== 1500 || venueAfter.vipRoomMinimums?.vip_room_2 !== 2500) throw new Error('Venue settings contract returned incomplete data');
await request('/api/venue', { method: 'PATCH', body: body({ expectedVenueId: venueBefore.id, name: venueBefore.name, city: venueBefore.city, address: venueBefore.address, format: venueBefore.format, timezone: venueBefore.timezone, phone: venueBefore.phone, logoUrl: venueBefore.logoUrl, vipRoomMinimums: venueBefore.vipRoomMinimums }) });

const staff = await request('/api/staff', { method: 'POST', body: body({ name: `Тестовый бармен ${suffix}`, login: `local_staff_${suffix}`, password: 'local1234', birthDate: '1995-05-15', role: 'bartender', phoneNumbers: [{ number: '+79990001124', primary: true }], telegram: '@local_staff_test' }) });
if (staff.role !== 'bartender' || !staff.phoneNumbers?.length) throw new Error('Staff create contract returned incomplete profile');
const avatarFixture = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 102, g: 34, b: 50 } } }).png().toBuffer();
const staffAvatar = await request(`/api/staff/${staff.id}/avatar`, { method: 'POST', body: body({ imageData: `data:image/png;base64,${avatarFixture.toString('base64')}` }) });
if (!staffAvatar.avatarUrl?.startsWith('data:image/webp;base64,') || Buffer.from(staffAvatar.avatarUrl.split(',')[1], 'base64').length > 80 * 1024) throw new Error('Staff avatar was not normalized into the storage budget');
const staffAvatarAfterReload = (await request('/api/staff')).items?.find((item) => item.id === staff.id);
if (staffAvatarAfterReload?.avatarUrl !== staffAvatar.avatarUrl) throw new Error('Normalized staff avatar did not persist in the staff list');
const invalidStaffAvatar = await requestRaw(`/api/staff/${staff.id}/avatar`, { method: 'POST', body: body({ imageData: 'data:image/png;base64,AA==' }) });
if (invalidStaffAvatar.status !== 400 || invalidStaffAvatar.payload?.error !== 'invalid_avatar') throw new Error('Invalid staff avatar was not rejected');
await request(`/api/staff/${staff.id}/status`, { method: 'PATCH', body: body({ active: false }) });
await request(`/api/staff/${staff.id}/archive`, { method: 'POST', body: '{}' });
const visibleStaff = await request('/api/staff');
if (visibleStaff.items?.some((person) => person.id === staff.id)) throw new Error('Archived staff remains visible');

await request(`/api/products/${product.id}`, { method: 'DELETE' });
await request(`/api/product-categories/${category.id}`, { method: 'DELETE' });
console.log(`LOCAL CRUD CONTRACT: PASS (product=${product.id}, inventory=${inventoryItem.id}, finance=${financeCategory.id}, reservation=${reservation.id}, delivery=${delivery.id}, venue=${venueAfter.id}, staff=${staff.id})`);
