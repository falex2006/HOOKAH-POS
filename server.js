const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRepositories, allocatePremixBatchConsumption } = require('./db');
const { orderAttentionReasons } = require('./order-attention');
const { scaleBatchRecipeIngredients } = require('./recipe-depletion');
const { validateDataUrl: validatePurchasePaymentDocument } = require('./purchase-document-validation');
const { normalizeStaffAvatarData } = require('./staff-avatar-image');
const { evaluateLoyaltyPricing, subtotalFromLines } = require('./loyalty-pricing');
const { sanitizeAuditEvent } = require('./audit-privacy');
const { buildMemoryPeriodBusiness, summarizeMemoryReservationPrepayments } = require('./loyalty-memory-reconciliation');
const shiftCloseContract = require('./shift-close-contract');
const { isValidIsoDate, countInclusiveDays, calculatePayrollAmount, canTransitionPayroll } = require('./payroll');
const { makeService: makePayrollSchemeService } = require('./payroll-scheme-service');
const { handlePayrollSchemeRoute, sameOriginMutation } = require('./payroll-scheme-routes');
const isValidIsoTimestamp = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const text = value.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = '00', , offset] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) return false;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) return false;
  return !Number.isNaN(Date.parse(text));
};
const scryptAsync = require('util').promisify(crypto.scrypt);
const catalogSeed = require('./catalog-seed');

function normalizeTaskDeadline(input) {
  const changed = input.dueDate !== undefined || input.dueAt !== undefined;
  if (!changed) return { changed: false };
  const present = (value) => value !== undefined && value !== null && value !== '';
  const validDay = (value) => typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
    && value.slice(0, 4) !== '0000' && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (present(input.dueDate) && present(input.dueAt)) return { error: 'invalid_task_deadline' };
  if (present(input.dueDate)) return validDay(input.dueDate)
    ? { changed, dueDate: input.dueDate, dueAt: null } : { error: 'invalid_task_due_date' };
  if (!present(input.dueAt)) return { changed, dueDate: null, dueAt: null };
  if (validDay(input.dueAt)) return { changed, dueDate: input.dueAt, dueAt: null };
  const match = typeof input.dueAt === 'string' && input.dueAt.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,6})?(Z|[+-]([0-9]{2}):([0-9]{2}))$/);
  if (!match || !validDay(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
      || (match[5] !== 'Z' && (Number(match[6]) > 23 || Number(match[7]) > 59)) || !Number.isFinite(Date.parse(input.dueAt))) {
    return { error: 'invalid_task_due_at' };
  }
  return { changed, dueDate: null, dueAt: input.dueAt };
}

const root = __dirname;
// Local development convenience: load ignored .env without adding a runtime dependency.
try {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch (_) {}
const repositories = createRepositories();
const payrollSchemeService = repositories?.pool ? makePayrollSchemeService(repositories.pool) : null;
const firstRunSetupEnabled = process.env.FIRST_RUN_SETUP_ENABLED === 'true';
const orderRepository = repositories?.orders || null;
const sessionRepository = repositories?.sessions || null;
// The selected network point is process-wide for the current local POS server.
// It starts from VENUE_ID and is updated by the network selector so subsequent
// floor, orders, inventory and reporting requests use the selected point.
let defaultVenueDbId = process.env.VENUE_ID || '00000000-0000-0000-0000-000000000001';
const venue = {
  id: 'venue-territory', name: 'Территория', format: 'кальян-бар', city: 'Тюмень',
  address: 'ул. Пермякова, 77, этаж -1', phone: '+7 (996) 641-95-10', logoUrl: null,
  timezone: 'Asia/Yekaterinburg', vipRoomMinimums: { vip_room_1: 1500, vip_room_2: 2500 }
};
const integrations = {
  telegram: { enabled: false, status: 'planned' }
};
const networkVenues = [{ id: venue.id, name: venue.name, format: venue.format, city: venue.city, address: venue.address, phone: venue.phone, phoneNumbers: [], logoUrl: venue.logoUrl, timezone: venue.timezone, vipRoomMinimums: { ...venue.vipRoomMinimums }, status: 'active', isCurrent: true }];
let currentVenueId = venue.id;
const saasAccount = { id: 'org-territory', name: 'Территория', slug: 'territory', plan: 'starter', subscriptionStatus: 'trialing', seatsLimit: 5, venuesLimit: 1 };
const saasPlans = { starter: { name: 'Starter', monthlyPrice: 0, seatsLimit: 5, venuesLimit: 1, description: 'Для первого тестового заведения' }, growth: { name: 'Growth', monthlyPrice: 0, seatsLimit: 15, venuesLimit: 3, description: 'Для растущей команды' }, network: { name: 'Network', monthlyPrice: 0, seatsLimit: 50, venuesLimit: 10, description: 'Для сети заведений' }, enterprise: { name: 'Enterprise', monthlyPrice: 0, seatsLimit: 9999, venuesLimit: 9999, description: 'Индивидуальные лимиты' } };
const saasOrganizations = [{ id: 'org-territory', name: 'Территория', slug: 'territory', plan: 'starter', status: 'trialing', city: 'Тюмень', venues: 1, seats: 2, seatsLimit: 5, venuesLimit: 1, monthlyPrice: 0, createdAt: '2026-09-16T00:00:00.000Z', isActive: true, ownerName: 'Владелец организации', ownerLogin: 'owner@example.com', ownerActive: true, owners: [{ id: 'owner-territory', name: 'Владелец организации', login: 'owner@example.com', active: true }] }];
const products = [
  { id: 'hookah-darkside', name: 'Кальян — Darkside Blueberry', price: 1200, station: 'hookah', aliases: ['кальян', 'darkside', 'blueberry'], imageUrl: null },
  { id: 'lemonade-maracuya', name: 'Лимонад Маракуйя', price: 300, station: 'bar', aliases: ['лимонад', 'маракуйя', 'maracuya'], imageUrl: null },
  { id: 'redbull', name: 'Red Bull', price: 250, station: 'bar', aliases: ['red bull', 'ред булл', 'энергетик'], imageUrl: null },
  { id: 'tea-earl-grey', name: 'Чай Эрл Грей', price: 300, station: 'bar', aliases: ['чай', 'earl grey'], imageUrl: null },
  { id: 'clay-bowl', name: 'Чаша глиняная', price: 500, station: 'hookah', aliases: ['чаша'], imageUrl: null },
  { id: 'coco-nara', name: 'Уголь Coco Nara', price: 600, station: 'hookah', aliases: ['уголь', 'coco nara'], imageUrl: null },
  { id: 'energy-tiger', name: 'Tiger Energy', price: 220, station: 'bar', aliases: ['тигр', 'энергетик tiger'], imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAJ50lEQVR42u3dZ29lRxnA8eczULV9193rXu61b3G377V3XdZtvc273l3vBtFEE1U00URTGqlKI40U0kkjjZQlDQgkkFCSEEIgkFBCSeiCF5YQEpPE55yZOTPn/KXfF5j/PM+bW86R16ypAOApee2aCgCektetqQDgKXn9mkoAnpI3rKkE4Cl549pKAJ6SNWurAHhK1q6tAuApWbe2CoCnZP26agCekg3rqgF4SjatqwbgKdm8rgaAp2TL+hoAnpKK9TUAPCWV62sBeEqq19cC8JTUbKgF4Cmp3VAHwFNSt6EOgKekfkMdAE9Jw8Z6AJ6Sxo31ADwlTRvrAXhKmjduBeApadm0FYCnpHVTAwBPSfumBgCeko5NDQA8JZ2bGn10fFspHE/PCyhJZnOjR45vL+ni18EBJclubnTfCe0lc7woAChJ9+Yml53YXrbD8Q6AkuQ2N7nppPayfc7WAJQkv6XJNSd1lOPlYBNASQpbmt1xckfZHU6VAZSkuKXZEU5t7wp34gBK0rul2QVf6ii7yZE+gJL0VbTE65SOUffFXglQkv6Klhh5sb0r4g0FKMlARUtcTu0Y9UuMrQAlGaxojcVpHaM+iisXoCTDla32nd456q9YigFKMlLZapnX27vCfjRASUqVbZad0TnmO/vRACUpV7bZlIDtXWG5G6Ako1Vt1pzZOZYkNtMBSjJW1W5HwrZ3hbV6gJJsr2q346zOseSxVg9QkvGqdgsSub0r7AQElGSiusOCszPbkspOQEBJJqs7TEvw9q6w0BBQkqnqTtPOyWxLNgsNASWZru406tzMtjQwnRFQkpmaTqNSssCmMwJKMluTMee8zPb0MFoSUJK5mow5qVpgoyUBJZmvyZjz5cz29DBaElCShZqsIednxtPGXExASXbVZg25IDueNuZiAkqyuzZrSAoX2FxMQEn21HaZcGF2PJ0M9QSUZG9tlwmpXWBDPQElWazrMuGi7Hg6GeoJKMn+um4TLs5OpJOhnoCSHKjrNuEr2Yl0MtQTUJKlum4TUrvAhnoCSnKwPmfCJV0T6WSoJ6Akh+pzJqR2gQ31BJRkuT5nwqVdE+lkqCegJEfq8yZc1jWZToZ6AkpydGvehNQusKGegJIctzVvwuVdk+lkqCegJG/aWjAhtQtsqCegJG/eWjDhiq7JdDLUE1CStzQUTbiieyqdDPUElOStDUUTruyeSidDPQEleVtD0YTULrChnoCSvL2hx4SruqfSyVBPQEne0dhjwtW5qXQy1BNQknc29hiSwu01FxNQknc19hpyTW5H2piLCTtT59155d2NvYZcm9uRNuZiwv6keXF2eU9Trzmp2l6jJRHjdLkcQd7b1GfOdbnp9DBaEi4MlYM15H1NfeZ8LTedHkZLwp1xcqqJvL+pz6iUbK/pjCnHjb8c+UBTv1HX56bTwHTG1OLeX5l8sLnftOvz08lmoWEKMQCrIR9q7jfthvx0sllomCqMwerJh5sHLLgxP5NUdgKmB8MQiHykecCCm/IzSWUnYEowD0HJR1sG7Ejk9lqrl3gMRjjysZZBO27OzySPtXrJxmyEJh9vGbQmYTdkM12CJXJ7rU2IfKJl0Kav52eSwXK3pErMPMQ1J/LJ1iHLbinM+s5+tERKwCTEPi3yqdYhyxJwJfajJU9Kttf0wMinW4fsu7Uw669YiiWM1wPg1NjIZ1qHY3FbYdZHceVKEk+v3s3hkc+2Dcfl9sKsX2JslRjeXbrjIySfaxuJ0e2FOV/EGyoZPLpuXwZJPt82Eq87CnPui71SMnhx137NknyhbcQFzuZ2pE8CsLomhkq+2F5yxDeKc65xJ47vHLzcZIyWHN9ecsedxTl3OFXGa05da8IGTE5oL7km9rIONvEau2puzOTE9rKb7irO2+dsDX/Fco++iJ5XTuoou+zu4rwdjnfwl7Ub9FH0vHJyR9l9RiN6UcBTrKjp8ZNTOkY9ck9xXhe/Du4pjfeVVBELy6kdoz46VpwPx9PzpuqO0iZKZDmtcxQw4VjPPFYjSmQ5vXMM0O6bPTuxeqE7yxmdY4B27GQgoTvLmZ1jgF739uxEUOFSy1md2wC97utZQFDhUsvZmW2AXvf3LiCocKnlnMw2QCNWMbQQteXczHZAowd6FxBOiNpyXmY7oBF7GFqI2nJ+djugy4O9C4giaHC5IDsO6PKt3l2IImhwuTA7DujCBkYUNLhclB0HdPl27y5EETS4XNw1AWjxnb5diC5Qc7mkawLQ4qG+XYguUHO5tGsS0OKhvt2ILlBzuaxrEtDiu327EV2g5nJ59ySgBbunRaDm8tXuKUCL7/XtRnSBmsuV3VOAFg/37UZ0gZrLVd1TgBaP9O1GdIGay9W5HYAWj/TvQXSBmss1uR2AFt/v34PoAjWXa3M7AC3YPS0CNZfrctOAFj/o34PoAjWX6/PTgBaP9u9BdIGayw35aUALdk+LQM3lxvwMoMVj/XsRXaDmclN+BtCC3dMiUHO5uTADaPHDgb2ILlBzuaUwC2jxo4F9iC5Qc7m1MAto8eOBfYguUHO5rTALaMHuaRGoudxemAO0+MnAPkQXqLncUZwDdGH9IgoaXO4szgG6PD6wD1EEDS53FecBXZ4YWEQUQYPL3cV5QJcnBxYRRdDgck/PTkCjJwcXEU6I2nKsZyeg0U8HFxFOiNpyb89OQKOnBhcRTojacl/PAqDXU4P7EVS41HJ/7wKg188G9yOocKnlgd4FQC+2MYRwqeXB3l2Adk8P7sfqhe4svBMdJrCTgYTuLLxPGYY8M7QfqxElsvA6VhjyzNABrEaUyMLbHGHOL4YO4JVFLCy8zRHmsJ+vKmJhebh/D2DOL4cP4OVEzyu8igZGPTt8AC8nel7hVTQwjUVV0tJWHu3fCxj1q+El/D8tbeWxgb2Aab8eXsL/0hVWeBA+7GBp/0tjVeExvLDmueEl6E0qPMgT1jw/vAS9SeXxwX2ANc+PLKWZ9p7yxOAiYNNvRg6mk4mYwqMAYV8Kt9dQSeFJYojFb0cOpoe5jMKjTBCX340cSgOjDeXpof1AXH4/cijZTAeUnw8dAGKU4O21UE94HgJi98LIoeSxk074RzVckLDttdZNnh1eAhzxh9Jh31kuJvyrC075Y+mwv+znEv4aAtd4ur2xtJLnhg8CDvpT6bAvYqwkz48cBJz159Jhl8XeR1L1izZ46sXSYdc4UkZS8nM2JMCLpWUXONVEEv9bNiTMS6XluDhYQ14oHQJ89FJ52Q6XI0gCvjpHyv2lvGyCF2cXjz6sB17VX8vLUXh3XnH8Y3oAr0BeLC8D8JRY+yQAgHZi6AMAABbI38pHAHhK/j56BICn5B+jRwB4Sv45ehSAp+Rfo0cBeEr+PXYcAE/9B4cXlZ2qZMJBAAAAAElFTkSuQmCC' },
  { id: 'lemonade-berry', name: 'Лимонад Лесные ягоды', price: 320, station: 'bar', aliases: ['ягоды', 'лесные ягоды', 'лимонад'], imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAJ1UlEQVR42u3dd5dV1RnH8ec1CIIgCNLLML3e6RV7wYZdEXsFpEiT3gYYYGhDkzJUqUaNiRpNYovRaNTUVxNXyloxHsycc/azz95nf9f6vIHz3fv3B9w758oV46YA8JSQAPB5wOOnAvCUXDGhCICnZNDEIgCekkGTpgHwlAyaXAzAUzJoSjEAT8ngqSUAPCWDi0oBeEoGTysF4CkZXFwGwFNyZXE5AE/JlSXlADwlV5ZWAPCUDCmrBOApGVJeCcBTMqSiCoCnZEhlNQBPydCqagCekqHVNQA8JUNragF4SobW1gLwlFxVVwfAU98PuADAU3JVoQDAUzKsvh6Ap2RYQwMAT8mwxgYAnpJhTY0+Kl4zJxlPnxeIJMObmzySeLc/5teDA5FkeEuz+4rXztXjRQEgkgxvbXaZ6nR/MGO3OwCRZHhbi5uK1821z9kaQCS5ur3VNSXr5mXLwSZAJLm6o9UdJevnucOpMkCk7wfc5gin1vufDbcBLpMRne0uKNnwspsc6QNEkhFd7dlydro/mHHWlYBIMmJ6R4ZKNs73RbahgEgy4rrOrHi03n9vOLtWQCQZeX1nJko3zfdRVrmASDLyhi77Sjct8FcmxYBIMvLG6ZaVdi/wnf1oQCQZedN0y/IwYOvRgEhyzc3X2VS6eWE+WO4GRJJrbrnemtItC/PEZjogkrBeNgyPBzzq1hvsKNuyKH+s1QMiyajbbrSgbOuivLITEIgko26/0YI8D9hKQCCSjJpxk7aynlfyzUJDIJKMvuNmbeU9i/PNQkMgkoy+82ZV5dsWh0A7IxBJRt91i6pQBqycEYgko+++VU/59iXhUC0JRJJr77lVT1ADVi0JRJJrZ96mp3zHknColgQiybX33q6kvHdpaPRiApFkzL0zlFT0Lg2NXkwgkoy5b4aSEAesFhOIJGPuv0NDxc5lYVLqCUSSMQ/cqSHcAev0BCLJ2Afv1FCxa1mYlHoCkWTsQ3dpqNi1PExKPYFIMvbhuzVU7F4eJqWeQCQZ+8jdGsIdsE5PIJKMe/QeDZV7Xg2TUk8gkoybNVND5d4VYVLqCUSScY/N1BDugHV6ApFk3Ox7NVT2rQiTUk8gkoyffZ+Gyr6VYVLqCUSS8Y/fpyHcAev0BCLJ+Cfu11C5b2WYlHoCkWTCkw9oqNq3KkxKPYFIMuGpBzRU7V8VJqWeQCSZ8PSDGsIdsE5PIJJMeOYhDVUHVodJqScQSSY++5CGYAes1BOIJBOfe1hD1cHVYVLqCUSSic8/oqTq0JrQ6MUEIsnEFx5REuKA1WLCzq3z7nll0guPKqk+tDY0ejFh/6Z58ewy6cVZeqpfWxsO1ZLI8Ha5HEEmvTRLT1gD1iwJFy6VgzVk8pzH9FQfXhcO1ZJw5zo51UQmz52tKpT1KmcMHCd+OTJ53uOqqo+sD4F2xmBx7j9NJr/8uLb8r1e/YYC4AAMhU+Y/oa3m6Pp8s9AwKFyDgZMpC560oObYhryyEzAcXIZYZMrCJy3I84CtBAwE9yEumbLoKTtq+jfkj7V6ucfFSEamvvK0HbX9G/PHWr18424kJpwT62W9/t4Qmbr4GZtqj2/MB8vd8io39yGreyJFS561rPb4Jt/Zj5ZLObgJmd8WKVr6rGW1Jzb5zn60/MnBNXDhwkjRsufsqz3R7a9MiuWM1xfAqWsjRcufz0TtyW4fZZUrTzw9ejcvj0x79fms1J3s9kuGrXLDu0N3/ArJtBUvZKju1GZfZBsqHzw6bl8ukkxb+WK26k5vdl/mlfLBi7P26y7JtFUvusDd3G70yQGmq3GppHj1S46oO7PFNe7E8Z2Dh5uPqyXFa+a4w63ELpXxGnPVu2DCeTNdBuzxgEvWznVT4fWt9jlbw1+ZnKMv0ueVknXzXGYvpdsd/MVKVW+dlKyf577C2a16vCjgKdWDy4eUhaVkw8seKZztMcWvB/eUwfPKq5SFpXTjfB8Vzm1LxtPnDeqMQpMmspRumg9oKJzfhoFIE1lKuxcAxjHLeBtO2llKNy8EjCtc2I6BS9xZyrYsAsyqv7AdcSVLLWVbFwFm1V/cjriSpZaynlcAs+ov7kBcyVJLec9iwCCmmFiC2lK+bTFgUP2lHUgmQW0p374EMKj+Ui+SSVBbyncsBUypf6MXacQNLhW9SwFTGt7oRRpxg0vFzmWAKQ0/24k04gaXil3LAVMa3tyJNOIGl4rdywEjmJ+ZDcdpLpV7XgWMaHxrF9KL1Vwq964AjGh8azfSi9VcKvtWAEY0vr0b6cVqLlV9KwEj2J4RsZpL1b5VgBGNb+9BerGaS9X+VYARjT/fg/RiNZeqA6sBI9iemQHHaS7VB9cARjS9sxfpxWou1YfWAEY0/WIv0ovVXKpfWwsYwfbMDDhOc6k+vA4woumXfUgvVnOpObIOMILtGRGrudQcXQ8Y0fRuH9KL1Vxqjm0AjGh6dx/Si9Vcavo3AEY0vbcP6cVqLrX9GwEjmt/bj/RiNZfa45sAI9iemQHHaS61J7oBI5rfP4D0YjWXupPdgBFsz4hYzaXu1GbAiOZfHUB6sZpL3ektgCnNHxxEGnGDS92ZLYApLDDtgGMGl8LrWwFTWj48iDTiBpfC2R7AlJYPDyGNuMGlcK4HMKjl14eQTILaUji/DTCIHSYfcPzaUn9hO2BQy29eQzIJajNgsGFf1/vPAV/cAZjFGpMMOFFqabjUC5jV+tvDiCtZauE30aGh9aPDGLjEnYXfRIeG1o+OYOASd5aGN3cBGlo/PoKBSBNZ+D1lKGGZA5QmsvBrjtDT+slR/LSUhYXfkoIe9vn/B5yusDS+swfQ0/rpUVxO+rzCT9FAVdunx3A56fN+P+A+QBVDvcx6DbQVfooG2to+O4YfM9JWmt/dB2hr/6wf/81UWOE92rCj/Xf9+BeDVaX5/f2AHe2f98NsUuE1vLCm/fPjMJtUWj44CFjT/vsTITPeU3gPICwLd70KMYU3icG+9i9OhEappPAqE2Si/YuT4dDLKLzKBFnp+PJkCFQbCm8zQYbyv17lgMLbTJCtji9P5ZWFetL28VEgWx1/OJU/dtJJ2ydHgcx1fHUqT6x1E/6qC+7o+Oq07ywXk7bP+gF3dHx92l/2cwl/GgLXdH592keZtBK+XA43df7xjC8yrCSBf7kcjnN9uln3kQC/lQrvdH5zxjWOlJFAvs6GHOj85nUXONVEcvkZOnKs89uzWXGwhuTsA3SEw95uHY4gnV+dBrzW9e1ZDV48u3R+fQbIja7vzqXh3fOKR5+2Afgf4sj/7AFIQJT+/QDAAun67iwAT0nXn84B8JR0/fk8AE/J9L+cB+Apmf7XCwA8JdP/dhGAp+S6v18C4Kl/ACLiNvPRXbgrAAAAAElFTkSuQmCC' },
  { id: 'hookah-mint', name: 'Кальян — Mint Mix', price: 1100, station: 'hookah', aliases: ['кальян', 'мята', 'mint'], imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAKAklEQVR42u3d95cW1R3H8e8fgTUGkV4s9M4WtrF9Fxa2V3rvHUGwgFQ15aQpCqLYjaCxYsOCBU2MJibRYKKpmhhjQupJ5hx/yYkjZ2fm3jv3zn2f8/oHnvd8P7/APs9Izx5DAThKevYYBsBRcmGP4QAcJReeNQKAo6TXWSMBOEp6nT0KgKPkorNHA3CU9D57DABHSe9zxgJwlPQ5ZxwAR0mfc8cDcJT0PXcCAEcFA54IwFHS77xJABwl/c/LAeAo6X9+LgBHyYDz8wA4KhhwPgBHycAvTQbgqGDABQAcJYMuKATgKBl8QREARwUDLgbgKBny5RIAjgoGPAWAo+TinmUAHCWX9CwH4KhgwBUAHCWXXlgJwFHBgKtc1JRzYzyOfl4glFzWq9ohzTk3qeLWBwdCBQOusZ/C3YYtuQZwlAztVWuz5pz9ZljeAQglwy6aaqeW3P3mWVsDCBUMeJptWnJvTpeFTYBQMrx3nT1Sn+7/sqoMECoY8HRLtOTeYht74gChZETvGTZozT1gJ0v6AKFkRJ/6dLXmHbBf6pWAUDKyT0OKWvMOuiLdUEAoGdW3MS1teQfdkmIrIFQw4KZUtOXd6qK0cgGhZHTfZvMcXe9nUikGhJLR/VoMa8s/5Drz0YBQMqZfq2Ht+YdcZz4aEErG9m8zqSP/tmww3A0IFQy43ZiO/NuzxGQ6IJSM699hRsbW+xlj9YBQMm5Apxkdkw9nj7F6QCgZP6DLgM7Jh7PKTEAglIwfOMuAzoI7sspMQCCUTBg4W7fOgjuzzUBDIJRMHDhHt66CO7PNQEMglEwcNFerroK7fKA7IxBKJg2ap5UnA9adEQglkwbP16er8G5/aC0JhJKcwQv0mVl4jz+0lgRCBQNeqI9nA14IGCa5QxZpMrPwXt/oiwmEkrwhizWZVXivb/TFBEJJ3sVLNJlVdJ9v9MUEQkn+xUt1mF10n5809QRCBQNepsPsovv9pKknEEomX7JcB28HrKknECoY8AodZhd910+aegKhpODSlTrMKX7AT5p6AqGk8NJVOng7YE09gVDBgFfrMKf4iJ809QRCSdFla3SYW3zET5p6AqGCAa/VYW7xUT9p6gmEkuKh63SYW3LUT5p6AqGkZOh6HeaVPOgnTT2BUMGAN+jg8YA3AMbIlGEbdZhX8pCfNPUEQgUD3qSDxwPeBBgjpcM36zB/ysN+0tQTCBUMeIsOHg94C2CMlA2/Qof5Ux7xk6aeQCgpH7FVhwWlj/hJU08gVDDgbTosKH3UT5p6AqGkYuSVmiwsfdQ3+mICoYIBX6XJwtLHfKMvJsxcnXOfVypHXq2JhwPWFxPmL82Jzy6Vo67RZ2HZ4/7QWhIpXpfNEaRq1HZ9FpU94Q+tJWHDUVlYQ6pH79DHqwFrLQl7zsmqJsGAr9VqUdkxH+jO6Dme+BeRmtE7tVpcdswHujN6i+d+ZlIzZpdui8ufzDYDDT3EAXSH1I7ZrVvmB2ygoVc4g+6TqWP3GLCk/KmsMhPQHxxDJMGA9xqQ6QHvBXeS1j3ItLH7zFhS/nT2GKuXeRxGPDJt3HVmLKl4OnuM1cs2biM2qRt3vTFLK57JEpPpMixjV2H4QqRu/A0mLa14NhsMd8uqzNxDWnci08d/xbBlFc+6zny0TMrAJaR+LTJj/FcNW1Zx3HXmo2VPBs7AhoORGRO+Zt6yyuPuSqVYxjh9AFadjdRP+Hoqllc+56K0cmWJo4/ezuOR+onfSMvyqufdkmKrzHDuoVt+QtIw8Zspcih9uqGywfP16jgkaZj0rXQtr3rBfqlXygYnnrVbtySNk75tgxVVL9rJkj4ZYO0jdvqopGnSdyxhYWh74riO0Wo6LWnKudEeK6pP2MOqMk6z6rFm7MCkOecm26ysPpEuC5s4LfUHaiclbaU5d7+dVla/ZJ61NdyVynN0RfK80pJ7s82MpbS8g7tYqdarCwZ8i/1WVr+sjxMFHKX1wWVDwsLSmnfAIatqXlbFrQ/uKIXPK6sSFpa2vIMuWlXzSjyOfl6vnpFvkkSWtvxbAR1YZncHnCCytOcfApRbXfMqui9252DAtwHKra45ie6L3Vk6Jt8OqLWm9iSiipdaOicfBtRaU/saooqXWjoL7gDUYo1xBhwrtXQV3AkotLb2dcQTo3Yw4LsAhdhhggFHri0zC+8GFFo79fuIJ0btYMD3AKowwsQbjhZcZhXdC6iybuoPkETU4DK76D5AlXVT30ASUYMHA74fUIUFJh5wtOAyp/gBQIn1036I5CI1DwZ8BFBi/bQ3kVyk5jK35CigxPq6N5FcpObBgB8ElFhf9xaSi9Rc5pU8BCixoe4tJBepucyf8j1AiY11P0JykZoHA34YUILtKRpwhOayoPQRQImN03+M5CI1Dwb8KKDExulvI7lIzWVh6WOAEpumv43kIjWXRWWPA0psmv4TJBepeTDgJwAl2J6iAUdoLovLjwFKXD7jp0guUvNgwE8CSrA9RQOO0FyWlD8FKHH5jJ8huUjNZUnF04ASbE/NgKM0l6UVzwBKbJ7xDpKL1FyWVT4LKLG5/l0kF6l5MODjgBJsT9GAIzSX5ZXPAUpsqf85kovUXJZXPQ8owfbUDDhKc1lR9QKgypb6U0gianBZUf0ioMqWhlNIImpwWVl9AlDliob3kETU4LKq+iVAla0N7yGJqMFlVc0rgEJbG3+BeGLUltU1rwIKbW38JeKJUVtW154EFNra+D7iiVFb1tS+Bqi1rfF9RBUvdTDg1wG1tjV+gKjipRbeiQ7ltjV9gKjipRbeiQ4drmz6FbovdmdZN+0NQDk2GW3AcTsL71OGJlc2/RrdkSSy8D5laMIyuz3g+JGFtzlCn6uaf4MzS1hYeBkc9Lmq+bc4s4SFhZfBQSsmeqb1Js4rvEsKWl3d/Dt8keR5hVfRQDeG+gXrVdBWeJMFdLum5ff4PCVthR/ChwHM9XPrVRNWNte/AxhwTcuH+IzCqrKl/l3AjO0tH0JtUuFneGHM9paPoDapXNFwCjBme+tHPlPeU/ghTxi2vfUPftIRU/gpQJi3o/WPvtFUUvgpQKTCs/Xqyij8mBjSsqP1Yx9obSj8GAJSdG3bn7JNd0Dh69RIV6bXq72e8I1qpO7a9k+yx0w64TuZsEHm1muom/CtLthjZ/ufXWe4mPC9EFhlZ/un7jKfS/hqCGzj7HpTaCWe/20qrLWr4y+uSLGSePuHqXCC9dNNuY94+FepcM7ujr/axpIysqPtY8AJtkzXpiaS+b9lQ8bs7jidFgtryM72TwAX7ek8bYbNESQD/3UOz+3p/JsOTnx22dX+KZAZCUfr3OcVh/63DcD/EQv/gR5AN8nuztMAHCWa/gEAgAGyt/PvABwle7v+AcBRsq/rnwAcJftm/guAo+S6mf8G4Ci5ftZ/ADjqv0IBuCyB6L7yAAAAAElFTkSuQmCC' }
];
const inventorySubdepartments = [];
const inventoryDepartments = [
  { id: 'kitchen', code: 'kitchen', name: 'Кухня', description: 'Продукты, заготовки и блюда', color: 'coral', sortOrder: 10, active: true },
  { id: 'bar', code: 'bar', name: 'Бар', description: 'Напитки, сиропы и чай', color: 'amber', sortOrder: 20, active: true },
  { id: 'hookah', code: 'hookah', name: 'Кальяны', description: 'Табак, уголь и расходники', color: 'violet', sortOrder: 30, active: true },
  { id: 'inventory', code: 'inventory', name: 'Хозяйственный склад', description: 'Расходники и инвентарь', color: 'green', sortOrder: 40, active: true },
];
const inventoryDeletionRequests = [];
products.forEach((product) => { product.category = product.category || (product.station === 'bar' ? 'Бар' : 'Кальянная зона'); });
products.push(...catalogSeed.products);
// The hosted demo starts with an empty business workspace. Technology cards
// remain seeded below, while menu items are created by the customer.
products.length = 0;
const productCategories = [
  { id: 'product-category-soft', name: 'Безалкогольные напитки', department: 'bar', active: true },
  { id: 'product-category-alcohol', name: 'Алкогольные напитки', department: 'bar', active: true },
  { id: 'product-category-tea', name: 'Чай и кофе', department: 'bar', active: true },
  { id: 'product-category-kitchen', name: 'Продукты и заготовки', department: 'kitchen', active: true },
  { id: 'product-category-hookah', name: 'Табак и смеси', department: 'hookah', active: true },
  { id: 'product-category-inventory', name: 'Расходники и инвентарь', department: 'inventory', active: true }
];
const importedProductCategoryNames = [...new Set(catalogSeed.products.map((item) => String(item.category || '').trim()).filter(Boolean))];
for (const name of importedProductCategoryNames) if (!productCategories.some((item) => item.name === name)) productCategories.push({ id: 'seed-category-' + name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').slice(0, 32), name, active: true });
productCategories.length = 0;
const recipes = (catalogSeed.recipes || []).map((recipe, index) => ({ ...recipe, id: recipe.id || 'recipe-' + (index + 1), ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [] }));
products.forEach((product) => { if (!product.inventoryMode) { const normalizedName = String(product.name || '').trim().toLocaleLowerCase('ru-RU'); const directRecipes = recipes.filter((recipe) => recipe.active !== false && recipe.recipeType !== 'premix' && String(recipe.productId || '') === String(product.id)); const genericRecipes = recipes.filter((recipe) => recipe.active !== false && recipe.recipeType !== 'premix' && !recipe.productId && String(recipe.name || '').trim().toLocaleLowerCase('ru-RU') === normalizedName); const sameNameProducts = products.filter((candidate) => candidate.active !== false && String(candidate.name || '').trim().toLocaleLowerCase('ru-RU') === normalizedName); product.inventoryMode = directRecipes.length === 1 ? 'tracked' : !directRecipes.length && genericRecipes.length === 1 && sameNameProducts.length === 1 ? 'tracked' : 'needs_review'; } });
let floor = [
  { id: 'hall', name: 'Зал', tables: Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return { id: `table-${n}`, name: `Стол ${n}`, status: n === 8 || [2, 6, 11].includes(n) ? 'occupied' : [4, 9].includes(n) ? 'reserved' : 'free', capacity: 2, minimumOrderTotal: 0, layout: {} };
  }) },
  { id: 'vip', name: 'VIP-комнаты', tables: [
    { id: 'vip-room-1', name: 'VIP-комната 1', status: 'free', capacity: 4, minimumOrderTotal: 1500, layout: {} },
    { id: 'vip-room-2', name: 'VIP-комната 2', status: 'free', capacity: 6, minimumOrderTotal: 2500, layout: {} }
  ] }
];
floor.length = 0;
const floorByVenueId = new Map([[currentVenueId, floor]]);
const orders = [];
const discountRequests = [];
const staff = [
  { id: 'u-owner', name: 'Владелец', role: 'owner', active: true, avatarUrl: null, telegram: '', phoneNumbers: [], passportData: null, permissionScopes: [] },
  { id: 'u-maria', name: 'Мария', role: 'bartender', active: true, avatarUrl: null, telegram: '', phoneNumbers: [], passportData: null, permissionScopes: [] }
];
staff.splice(1);
const inventory = [
  { id: 'ing-redbull', name: 'Red Bull', category: 'Холодильник', unit: 'шт', onHand: 24, minLevel: 10 },
  { id: 'ing-coco', name: 'Уголь Coco Nara', category: 'Кальянная зона', unit: 'уп', onHand: 8, minLevel: 5 },
  { id: 'ing-mint', name: 'Мята', category: 'Бар', unit: 'кг', onHand: 1.8, minLevel: 2 },
  { id: 'ing-lime', name: 'Лайм', category: 'Бар', unit: 'кг', onHand: 3.2, minLevel: 1 },
  { id: 'ing-bowl', name: 'Чаша глиняная', category: 'Кальянная зона', unit: 'шт', onHand: 14, minLevel: 4 }
];
inventory.length = 0;
const stockMovements = [];
// In the local/demo runtime auto-order requests live in memory. Production
// requests are persisted in inventory_auto_orders below so a manager can
// review the same request from another device.
const autoOrderRequests = [];
const reservations = [];
const legacyReservationDepositReviews = [];
const ensureMemoryLegacyReviewBaseline = (reservation, venueId) => {
  const amount = Number(reservation?.depositPaid || 0);
  if (!(amount > 0)) return [];
  const history = legacyReservationDepositReviews.filter((entry) => entry.venueId === venueId && entry.reservationId === reservation.id).sort((left, right) => left.sequence - right.sequence);
  const head = history.at(-1) || null;
  if (!head || Number(head.legacyAmount) !== amount) {
    const baseline = { id: `legacy-review-${crypto.randomUUID()}`, venueId, reservationId: reservation.id, legacyAmount: amount, sequence: Number(head?.sequence || 0) + 1, disposition: 'unreviewed', note: 'Исходная сумма прежней системы; получение денег не подтверждено.', evidenceReference: '', supersedesId: head?.id || null, idempotencyKey: `baseline:${reservation.id}:${Number(head?.sequence || 0) + 1}`, actorId: null, actorName: 'Система', createdAt: new Date().toISOString() };
    legacyReservationDepositReviews.push(baseline); history.push(baseline);
  }
  return history;
};
const deliveries = [];
const tobaccoCatalogItems = [];
const alcoholCatalogItems = [];
const tasks = [];
const manualExpenses = [];
const financeCategories = [
  { id: 'finance-kitchen', name: 'Кухня', kind: 'income', active: true },
  { id: 'finance-bar', name: 'Бар', kind: 'income', active: true },
  { id: 'finance-hookah', name: 'Кальяны', kind: 'income', active: true },
  { id: 'finance-stock', name: 'Склад', kind: 'expense', active: true },
  { id: 'finance-delivery', name: 'Доставка', kind: 'expense', active: true }
];
financeCategories.length = 0;
const auditEvents = [];
const staffNotifications = [];
const discountGroups = [
  { id: 'none', name: 'Без скидки', discountPercent: 0, bonusPercent: 0, depositMin: 0, active: true },
  { id: 'regular', name: 'Постоянный гость', discountPercent: 5, bonusPercent: 1, depositMin: 0, active: true },
  { id: 'vip', name: 'VIP', discountPercent: 10, bonusPercent: 2, depositMin: 3000, active: true }
];
const loyaltyProgramSettings = new Map();
const loyaltyPromotions = [];
const normalizePromotionInput = (input, base = {}) => {
  const value = { ...base, ...input };
  const name = String(value.name || '').trim();
  const description = String(value.description || '').trim();
  const timezone = String(value.timezone || '').trim();
  const dateInput = (date) => date instanceof Date ? date.toISOString() : String(date || '');
  const startsAt = dateInput(value.startsAt);
  const endsAt = dateInput(value.endsAt);
  const benefitKind = String(value.benefitKind || '');
  const benefitValue = Number(value.benefitValue);
  const priority = Number(value.priority ?? 0);
  let timezoneValid = false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0); timezoneValid = true; } catch (_) { /* invalid IANA timezone */ }
  const explicitOffset = (date) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(date);
  const productIds = (key) => Array.isArray(value[key]) ? [...new Set(value[key].map((id) => String(id).trim()))] : null;
  const includeProductIds = productIds('includeProductIds');
  const excludeProductIds = productIds('excludeProductIds');
  const includeCategories = Array.isArray(value.includeCategories) ? [...new Set(value.includeCategories.map((item) => String(item).trim()).filter(Boolean))] : null;
  const excludeCategories = Array.isArray(value.excludeCategories) ? [...new Set(value.excludeCategories.map((item) => String(item).trim()).filter(Boolean))] : null;
  const status = String(value.status || 'draft');
  const validMoney = Number.isFinite(benefitValue) && benefitValue > 0 && benefitValue <= 1000000 && Math.abs(benefitValue * 100 - Math.round(benefitValue * 100)) < 1e-6;
  if (!name || name.length > 100 || description.length > 500 || !timezoneValid || !explicitOffset(startsAt) || !explicitOffset(endsAt)
    || !Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(startsAt)
    || !['percent', 'fixed'].includes(benefitKind) || !validMoney || (benefitKind === 'percent' && benefitValue > 100)
    || !Number.isInteger(priority) || priority < -100000 || priority > 100000
    || !includeProductIds || !excludeProductIds || !includeCategories || !excludeCategories
    || !['draft', 'active', 'archived'].includes(status)
    || (!includeProductIds.length && !includeCategories.length)
    || includeProductIds.some((id) => excludeProductIds.includes(id))
    || includeCategories.some((category) => excludeCategories.includes(category))) return null;
  const productKey = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  if ([...includeProductIds, ...excludeProductIds].some((id) => !productKey.test(id)) || [...includeCategories, ...excludeCategories].some((item) => item.length > 80)) return null;
  return { name, description, timezone, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), benefitKind, benefitValue, priority, status, includeProductIds, excludeProductIds, includeCategories, excludeCategories };
};
const promotionTermsEqual = (left, right) => ['name','description','timezone','startsAt','endsAt','benefitKind','benefitValue','priority','includeProductIds','excludeProductIds','includeCategories','excludeCategories'].every((key) => {
  const normalize = (value) => key === 'benefitValue' ? Number(value) : Array.isArray(value) ? [...value].sort() : value;
  const a = normalize(left[key]); const b = normalize(right[key]);
  return JSON.stringify(a) === JSON.stringify(b);
});
discountGroups.length = 0;
const clients = [
  { id: 'client-anna', name: 'Анна Смирнова', phoneNumbers: [{ label: 'Основной', number: '+79991112233', primary: true }], telegram: '@anna_sm', tobaccoPreferences: ['Darkside', 'Мята'], bowlPreferences: ['Кальянная чаша'], barPreferences: ['Лимонад маракуйя', 'Red Bull'], allergies: '', notes: 'Предпочитает среднюю крепость', loyaltyPoints: 420, bonusBalance: 420, depositBalance: 0, discountGroupId: 'regular', visits: 6, totalSpent: 18400, lastVisitAt: '2026-09-18T21:30:00.000Z' },
  { id: 'client-igor', name: 'Игорь Волков', phoneNumbers: [{ label: 'Основной', number: '+79994445566', primary: true }, { label: 'Рабочий', number: '+79997778899', primary: false }], telegram: '', tobaccoPreferences: ['Tangiers', 'Ягодные миксы'], bowlPreferences: ['Калауд'], barPreferences: ['Кола', 'Виски'], allergies: 'Орехи', notes: '', loyaltyPoints: 180, bonusBalance: 180, depositBalance: 3000, discountGroupId: 'vip', visits: 3, totalSpent: 9200, lastVisitAt: '2026-09-12T20:10:00.000Z' }
];
clients.length = 0;
const sessions = new Map();
const memoryPreferencesByAccount = new Map();
const loginAttempts = new Map();
const pinUnlockAttempts = new Map();
const requestBuckets = new Map();
const configuredApiRateLimit = Number(process.env.API_RATE_LIMIT);
const API_RATE_LIMIT = Number.isInteger(configuredApiRateLimit) && configuredApiRateLimit >= 30 && configuredApiRateLimit <= 10000
  ? configuredApiRateLimit
  : 180;
const API_RATE_WINDOW_MS = 60_000;
const shifts = [];
const memoryShiftOpenPending = new Set();
const provisionedAccounts = [];
const demoAccounts = [
  { username: 'admin', venueId: process.env.VENUE_ID || '00000000-0000-0000-0000-000000000001', password: process.env.DEMO_ADMIN_PASSWORD || (process.env.AUTH_REQUIRED === 'true' ? '' : 'admin'), name: 'Александр', role: 'admin', organizationId: '00000000-0000-0000-0000-000000000010' },
  { username: 'owner', venueId: process.env.VENUE_ID || '00000000-0000-0000-0000-000000000001', password: process.env.DEMO_OWNER_PASSWORD || (process.env.AUTH_REQUIRED === 'true' ? '' : 'demo'), name: 'Владелец', role: 'owner', organizationId: '00000000-0000-0000-0000-000000000010' },
  { username: 'staff', venueId: process.env.VENUE_ID || '00000000-0000-0000-0000-000000000001', password: process.env.DEMO_STAFF_PASSWORD || (process.env.AUTH_REQUIRED === 'true' ? '' : 'demo'), pin: process.env.DEMO_STAFF_PIN || (process.env.AUTH_REQUIRED === 'true' ? '' : '1234'), name: 'Мария', role: 'bartender', organizationId: '00000000-0000-0000-0000-000000000010' },
  { username: process.env.SAAS_OWNER_EMAIL || 'platform-owner@example.com', password: process.env.SAAS_OWNER_PASSWORD || (process.env.AUTH_REQUIRED === 'true' ? '' : 'saas-demo'), name: 'Владелец SaaS', role: 'platform_owner', organizationId: null }
].filter((account) => Boolean(account.password));

const hashPassword = async (password) => { const salt = crypto.randomBytes(16).toString('hex'); const derived = await scryptAsync(String(password), salt, 64); return `scrypt$${salt}$${derived.toString('hex')}`; };
const verifyPassword = async (password, stored) => {
  if (!stored) return false;
  if (!String(stored).startsWith('scrypt$')) { const actual = Buffer.from(String(password)); const expectedPlain = Buffer.from(String(stored)); return actual.length === expectedPlain.length && crypto.timingSafeEqual(actual, expectedPlain); }
  const [, salt, encoded] = String(stored).split('$'); const derived = await scryptAsync(String(password), salt, 64); const expected = Buffer.from(encoded || '', 'hex'); return expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
};

const staffPassportCipher = {
  encrypt(value) {
    const secret = process.env.STAFF_PASSPORT_KEY;
    if (!secret) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { data: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  },
  decrypt(row) {
    const secret = process.env.STAFF_PASSPORT_KEY;
    if (!secret || !row?.passport_data_encrypted) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), Buffer.from(row.passport_data_iv, 'base64'));
      decipher.setAuthTag(Buffer.from(row.passport_data_tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.passport_data_encrypted, 'base64')), decipher.final()]).toString('utf8'));
    } catch (_) { return null; }
  }
};const rolePermissions = {
  owner: ['floor', 'orders', 'reservations', 'inventory', 'inventory_read', 'finance', 'finance_read', 'staff', 'staff_manage', 'staff_sensitive', 'tasks_manage', 'settings', 'diagnostics', 'integrations', 'delivery', 'loyalty'],
  admin: ['floor', 'orders', 'reservations', 'inventory', 'inventory_read', 'finance', 'finance_read', 'staff', 'staff_manage', 'staff_view', 'staff_sensitive', 'tasks_manage', 'settings', 'diagnostics', 'integrations', 'delivery', 'loyalty'],
  manager: ['floor', 'orders', 'reservations', 'inventory_read', 'finance_read', 'staff_view', 'tasks_manage', 'settings', 'loyalty'],
  senior_bartender: ['floor', 'orders', 'bar_tasks', 'finance_read'],
  senior_hookah_master: ['floor', 'orders', 'hookah_tasks', 'finance_read'],
  bartender: ['floor', 'orders', 'bar_tasks', 'finance_read'],
  hookah_master: ['floor', 'orders', 'hookah_tasks', 'finance_read'],
  developer: ['floor', 'orders', 'reservations', 'inventory_read', 'finance_read', 'staff', 'staff_manage', 'staff_view', 'tasks_manage', 'settings', 'diagnostics', 'integrations', 'delivery'],
  platform_owner: ['platform', 'diagnostics', 'settings'],
  cleaner: ['finance_read'],
  security: ['finance_read'],
  technician: ['finance_read'],
  other_staff: ['finance_read']
};
const staffPinCipher = {
  encrypt(pin) { const wrapped = staffPassportCipher.encrypt({ pin: String(pin) }); return wrapped; },
  decrypt(row) { const wrapped = staffPassportCipher.decrypt({ passport_data_encrypted: row?.pin_data_encrypted, passport_data_iv: row?.pin_data_iv, passport_data_tag: row?.pin_data_tag }); return wrapped?.pin || null; }
};
const permissionScopes = ['orders', 'reservations', 'inventory', 'inventory_categories', 'finance', 'finance_read', 'staff', 'delivery', 'integrations', 'settings', 'loyalty'];
const scopedPermissionMap = {
  orders: ['orders', 'floor'],
  reservations: ['reservations'],
  inventory: ['inventory', 'inventory_read'],
  inventory_categories: ['inventory_categories', 'inventory_read'],
  finance: ['finance', 'finance_read'],
  finance_read: ['finance_read'],
  staff: ['staff', 'staff_manage', 'staff_view', 'staff_sensitive', 'tasks_manage'],
  delivery: ['delivery'],
  integrations: ['integrations'],
  settings: ['settings'],
  loyalty: ['loyalty']
};
const normalizePermissionScopes = (value) => [...new Set((Array.isArray(value) ? value : []).map((scope) => String(scope || '').trim()).filter((scope) => permissionScopes.includes(scope)))];
const systemRoleScopeDefaults = {
  owner: [...permissionScopes],
  admin: [...permissionScopes],
  manager: ['orders', 'reservations', 'inventory_categories', 'finance_read', 'staff', 'settings', 'loyalty'],
  developer: ['orders', 'reservations', 'inventory_categories', 'finance_read', 'staff', 'settings', 'integrations', 'delivery'],
  senior_bartender: ['orders', 'finance_read'],
  senior_hookah_master: ['orders', 'finance_read'],
  bartender: ['orders', 'finance_read'],
  hookah_master: ['orders', 'finance_read'],
  cleaner: [],
  security: [],
  technician: [],
  other_staff: []
};
const effectivePermissions = (user) => {
  const base = rolePermissions[user?.role] || [];
  const hasRoleOverride = user?.rolePermissionOverrideActive === true || (Array.isArray(user?.rolePermissionScopes) && user.rolePermissionScopes.length > 0);
  const scopes = normalizePermissionScopes(hasRoleOverride ? user.rolePermissionScopes : (user?.customRolePermissionScopes?.length ? user.customRolePermissionScopes : user?.permissionScopes));
  if (!scopes.length) return base;
  const restricted = new Set(Object.values(scopedPermissionMap).flat());
  return [...new Set([...base.filter((permission) => !restricted.has(permission)), ...scopes.flatMap((scope) => scopedPermissionMap[scope] || [])])];
};

const json = (res, status, data) => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" };
  if (process.env.CORS_ORIGIN) headers['Access-Control-Allow-Origin'] = process.env.CORS_ORIGIN;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
};
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BODY_TIMEOUT_MS = 15_000;
const body = (req) => new Promise((resolve, reject) => {
  let raw = '';
  let bytes = 0;
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) reject(error); else resolve(value);
  };
  const timeout = setTimeout(() => {
    req.destroy();
    finish(Object.assign(new Error('request_body_timeout'), { code: 'request_body_timeout' }));
  }, BODY_TIMEOUT_MS);
  req.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES) {
      req.destroy();
      finish(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }));
      return;
    }
    raw += chunk;
  });
  req.on('end', () => {
    try { finish(null, raw ? JSON.parse(raw) : {}); } catch (error) { finish(error); }
  });
  req.on('error', (error) => finish(error));
});
const normalizePhoneNumbers = (value) => { const seen = new Set(); const contacts = (Array.isArray(value) ? value : []).map((entry) => ({ label: String(entry?.label || 'Дополнительный').trim().slice(0, 32), number: String(entry?.number || '').trim(), primary: Boolean(entry?.primary) })).filter((entry) => { const key = entry.number.replace(/\D/g, ''); if (!key || seen.has(key)) return false; seen.add(key); return true; }); if (contacts.length) { const primaryIndex = contacts.findIndex((entry) => entry.primary); contacts.forEach((entry, index) => { entry.primary = primaryIndex < 0 ? index === 0 : index === primaryIndex; }); } return contacts; };
const validEmploymentDate = (value) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
const orderTotal = (order) => order.items.reduce((sum, item) => sum + (Number(item.unitPrice) || 0) * (Number(item.quantity) || 0), 0);
const recipeUnitAliases = { г: 'г', гр: 'г', грамм: 'г', грамма: 'г', граммов: 'г', кг: 'кг', килограмм: 'кг', килограмма: 'кг', мл: 'мл', milliliter: 'мл', миллилитр: 'мл', миллилитра: 'мл', л: 'л', liter: 'л', литр: 'л', литра: 'л', шт: 'шт', штука: 'шт', штуки: 'шт', порция: 'порция', порции: 'порция', уп: 'уп', упаковка: 'упаковка' };
const recipeUnitFactors = { г: { г: 1, кг: 0.001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: 0.001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };
const normalizeRecipeUnit = (value) => recipeUnitAliases[String(value || '').trim().toLocaleLowerCase('ru-RU')] || null;
const parseRecipeQuantity = (value, targetUnit, fallbackUnit = null) => {
  const raw = String(value ?? '').trim().replace(',', '.'); const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-zа-яё]+)?$/i);
  const amount = match ? Number(match[1]) : NaN;
  if (!match || !Number.isFinite(amount) || amount <= 0) return { error: 'invalid_recipe_quantity' };
  const sourceUnit = normalizeRecipeUnit(match[2] || fallbackUnit || targetUnit); const normalizedTarget = normalizeRecipeUnit(targetUnit);
  if (!sourceUnit || !normalizedTarget || !recipeUnitFactors[sourceUnit]?.[normalizedTarget]) return { error: 'recipe_ingredient_unit_mismatch', sourceUnit: sourceUnit || match[2] || null, targetUnit: normalizedTarget || targetUnit || null };
  const factor = recipeUnitFactors[sourceUnit][normalizedTarget];
  if (!Number.isFinite(amount * factor)) return { error: 'invalid_recipe_quantity' };
  return { amount, sourceUnit, targetUnit: normalizedTarget, factor };
};
const recipeQuantityHasFiniteCost = (parsed, stockItem) => {
  const quantity = parsed.amount * parsed.factor;
  const lineCost = quantity * Number(stockItem.cost || 0);
  return Number.isFinite(quantity) && Number.isFinite(lineCost) && Number.isFinite(lineCost * 100);
};
const explicitDemoRuntime = () => process.env.DEMO_MODE === 'true' || (!repositories?.pool && process.env.AUTH_REQUIRED !== 'true' && process.env.NODE_ENV !== 'production');
async function normalizeRecipeIngredients(input, venueId) {
  if (!Array.isArray(input) || input.length === 0) throw Object.assign(new Error('recipe_ingredients_required'), { code: 'recipe_ingredients_required' });
  if (input.length > 50) throw Object.assign(new Error('recipe_ingredients_limit_exceeded'), { code: 'recipe_ingredients_limit_exceeded' });
  const source = input;
  const normalized = source.map((item) => typeof item === 'string' ? { name: item.trim(), quantity: '' } : { name: String(item?.name || '').trim(), ingredientId: String(item?.ingredientId || item?.inventoryItemId || '').trim() || null, quantity: String(item?.quantity ?? '').trim(), unit: String(item?.unit || '').trim() || null });
  if (!repositories?.pool) {
    const byId = new Map(inventory.map((item) => [String(item.id), item]));
    const byName = new Map(inventory.map((item) => [String(item.name || '').trim().toLocaleLowerCase('ru-RU'), item]));
    return normalized.map((item) => {
      if (!item.name && !item.ingredientId) throw Object.assign(new Error('recipe_ingredient_required'), { code: 'recipe_ingredient_required' });
      const stockItem = (item.ingredientId && byId.get(item.ingredientId)) || (!item.ingredientId && byName.get(item.name.toLocaleLowerCase('ru-RU')));
      if (!stockItem) throw Object.assign(new Error('recipe_ingredient_not_found'), { code: 'recipe_ingredient_not_found', ingredient: item.name || item.ingredientId });
      const parsed = parseRecipeQuantity(item.quantity, stockItem.unit, item.unit || null);
      if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error, sourceUnit: parsed.sourceUnit, targetUnit: parsed.targetUnit, ingredient: stockItem.name });
      if (!recipeQuantityHasFiniteCost(parsed, stockItem)) throw Object.assign(new Error('invalid_recipe_quantity'), { code: 'invalid_recipe_quantity', ingredient: stockItem.name });
      return { name: stockItem.name, ingredientId: stockItem.id, quantity: `${parsed.amount} ${parsed.sourceUnit}`, unit: parsed.sourceUnit };
    });
  }
  if (!repositories?.inventory) return null;
  const inventoryItems = (await repositories.inventory.list(venueId)).items;
  const byId = new Map(inventoryItems.map((item) => [String(item.id), item])); const byName = new Map(inventoryItems.map((item) => [String(item.name || '').trim().toLocaleLowerCase('ru-RU'), item]));
  const result = [];
  for (const item of normalized) {
    if (!item.name && !item.ingredientId) throw Object.assign(new Error('recipe_ingredient_required'), { code: 'recipe_ingredient_required' });
    const stockItem = (item.ingredientId && byId.get(item.ingredientId)) || (!item.ingredientId && byName.get(item.name.toLocaleLowerCase('ru-RU')));
    if (!stockItem) throw Object.assign(new Error('recipe_ingredient_not_found'), { code: 'recipe_ingredient_not_found', ingredient: item.name || item.ingredientId });
    const parsed = parseRecipeQuantity(item.quantity, stockItem.unit, item.unit || null);
    if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error, sourceUnit: parsed.sourceUnit, targetUnit: parsed.targetUnit, ingredient: stockItem.name });
    if (!recipeQuantityHasFiniteCost(parsed, stockItem)) throw Object.assign(new Error('invalid_recipe_quantity'), { code: 'invalid_recipe_quantity', ingredient: stockItem.name });
    result.push({ name: stockItem.name, ingredientId: stockItem.id, quantity: `${parsed.amount} ${parsed.sourceUnit}`, unit: parsed.sourceUnit });
  }
  return result;
}
const calculateRecipeCostLines = (ingredients, stock) => (Array.isArray(ingredients) ? ingredients : []).map((item) => {
  const stockItem = item.ingredientId ? stock.find((entry) => entry.id === item.ingredientId) : stock.find((entry) => entry.name.toLocaleLowerCase('ru-RU') === String(item.name || '').trim().toLocaleLowerCase('ru-RU'));
  if (!stockItem) return { ...item, stockName: item.name || null, unit: null, quantity: null, unitCost: 0, cost: 0, linked: false };
  const parsed = parseRecipeQuantity(item.quantity, stockItem.unit, item.unit || null);
  if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error, ingredient: stockItem.name, sourceUnit: parsed.sourceUnit, targetUnit: parsed.targetUnit });
  const quantity = Number((parsed.amount * parsed.factor).toFixed(6));
  const unitCost = Number(stockItem.cost || 0); const lineCost = quantity * unitCost;
  if (!Number.isFinite(quantity) || !Number.isFinite(lineCost) || !Number.isFinite(lineCost * 100)) throw Object.assign(new Error('invalid_recipe_quantity'), { code: 'invalid_recipe_quantity', ingredient: stockItem.name });
  const packMultiplier = Number(stockItem.packMultiplier || 1); return { ...item, stockName: stockItem.name, recipeQuantity: parsed.amount, recipeUnit: parsed.sourceUnit, unit: stockItem.unit, sourceUnit: parsed.sourceUnit, quantity, unitCost, cost: Math.round(lineCost * 100) / 100, purchaseUnit: stockItem.purchaseUnit || stockItem.unit, packMultiplier, packageEquivalentCost: Math.round(unitCost * packMultiplier * 100) / 100, linked: true };
});
const normalizeRecipeOutput = (input = {}, previous = {}) => {
  const rawQuantity = input.yieldQuantity ?? input.yield ?? previous.yieldQuantity;
  const rawUnit = input.yieldUnit ?? previous.yieldUnit;
  const rawPortions = input.portionCount ?? input.portions ?? previous.portionCount;
  const quantity = Number(String(rawQuantity ?? '').replace(',', '.'));
  const unit = normalizeRecipeUnit(rawUnit);
  const portions = Number(rawPortions);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) throw Object.assign(new Error('recipe_yield_required'), { code: 'recipe_yield_required' });
  if (!unit) throw Object.assign(new Error('recipe_yield_unit_invalid'), { code: 'recipe_yield_unit_invalid', targetUnit: rawUnit || null });
  if (!Number.isInteger(portions) || portions < 1 || portions > 100000) throw Object.assign(new Error('recipe_portions_invalid'), { code: 'recipe_portions_invalid' });
  return { yieldQuantity: Number(quantity.toFixed(6)), yieldUnit: unit, portionCount: portions };
};
async function depleteRecipeForOrder(pool, orderId, venueId, actorId, transactionClient = null) {
  const client = transactionClient || await pool.connect();
  const ownsTransaction = !transactionClient;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    let requirements = [];
    const cardProductIds = new Set();
    const { rows: cards } = await client.query(`SELECT oi.product_id AS "productId", oi.quantity AS "orderQuantity", p.name AS "productName", p.inventory_mode AS "inventoryMode",
        EXISTS (SELECT 1 FROM recipes legacy_recipe JOIN recipe_items legacy_item ON legacy_item.product_id=legacy_recipe.product_id
          JOIN ingredients legacy_ingredient ON legacy_ingredient.id=legacy_item.ingredient_id AND legacy_ingredient.venue_id=p.venue_id
          WHERE legacy_recipe.product_id=oi.product_id AND legacy_item.quantity>0) AS "hasLegacyRecipe",
        (SELECT COUNT(*)::int FROM inventory_recipe_cards direct_card WHERE direct_card.venue_id=$2 AND direct_card.active=true AND direct_card.recipe_type='sale' AND direct_card.product_id=oi.product_id) AS "directRecipeCount",
        (SELECT COUNT(*)::int FROM inventory_recipe_cards generic_card WHERE generic_card.venue_id=$2 AND generic_card.active=true AND generic_card.recipe_type='sale' AND generic_card.product_id IS NULL AND lower(btrim(generic_card.name))=lower(btrim(p.name))) AS "unboundRecipeCount",
        (SELECT COUNT(*)::int FROM products same_name_product WHERE same_name_product.venue_id=$2 AND same_name_product.is_active=true AND lower(btrim(same_name_product.name))=lower(btrim(p.name))) AS "sameNameProductCount",
        rc.id AS "recipeId", rc.ingredients, rc.portion_count AS "portionCount", (rc.product_id IS NOT NULL) AS "directlyBound"
      FROM order_items oi JOIN products p ON p.id=oi.product_id
      LEFT JOIN LATERAL (
        SELECT candidate.id,candidate.ingredients,candidate.portion_count,candidate.product_id
        FROM inventory_recipe_cards candidate
        WHERE candidate.venue_id=$2 AND candidate.active=true AND candidate.recipe_type='sale'
          AND (candidate.product_id=oi.product_id OR (candidate.product_id IS NULL AND lower(btrim(candidate.name))=lower(btrim(p.name))))
        ORDER BY (candidate.product_id=oi.product_id) DESC NULLS LAST,candidate.updated_at DESC,candidate.created_at DESC,candidate.id
        LIMIT 1
      ) rc ON true
      WHERE oi.order_id=$1`, [orderId, venueId]);
    for (const card of cards) {
      if (card.inventoryMode === 'non_stock') continue;
      if (card.inventoryMode === 'needs_review') throw Object.assign(new Error('product_inventory_mode_required'), { code: 'product_inventory_mode_required', productId: card.productId, productName: card.productName });
      if (card.inventoryMode !== 'tracked') throw Object.assign(new Error('product_inventory_mode_invalid'), { code: 'product_inventory_mode_invalid', productId: card.productId, productName: card.productName });
      if (Number(card.directRecipeCount || 0) > 1 || (!Number(card.directRecipeCount || 0) && Number(card.unboundRecipeCount || 0) > 0
        && (Number(card.unboundRecipeCount) !== 1 || Number(card.sameNameProductCount) !== 1))) {
        throw Object.assign(new Error('product_recipe_ambiguous'), { code: 'product_recipe_ambiguous', productId: card.productId, productName: card.productName });
      }
      if (!card.recipeId && !card.hasLegacyRecipe) throw Object.assign(new Error('product_recipe_required'), { code: 'product_recipe_required', productId: card.productId, productName: card.productName });
      if (!card.recipeId) continue;
      cardProductIds.add(card.productId);
      if (!Array.isArray(card.ingredients) || card.ingredients.length === 0) throw Object.assign(new Error('recipe_invalid'), { code: 'recipe_invalid', productId: card.productId });
      let scaledIngredients;
      try { scaledIngredients = scaleBatchRecipeIngredients(card.ingredients, Number(card.orderQuantity), Number(card.portionCount || 1)); }
      catch (error) { throw Object.assign(new Error('recipe_invalid'), { code: 'recipe_invalid', detail: error.message, productId: card.productId }); }
      for (const item of scaledIngredients) {
        const name = String(item.name || '').trim(); const ingredientId = String(item.ingredientId || '').trim();
        if (!name || !/^[0-9a-f-]{36}$/i.test(ingredientId)) throw Object.assign(new Error('recipe_invalid'), { code: 'recipe_invalid', productId: card.productId });
        requirements.push({ ingredientId, name, quantityText: String(item.quantity || ''), sourceUnit: String(item.unit || '') });
      }
    }
    // Older recipe rows remain a fallback only for products without an active
    // inventory recipe card; applying both sources would double-deplete stock.
    await client.query('SAVEPOINT legacy_recipe_lookup');
    try {
      const legacy = await client.query(`SELECT oi.product_id AS "productId",ri.ingredient_id AS "ingredientId",i.name,i.unit,SUM(ri.quantity * oi.quantity)::numeric AS quantity
        FROM order_items oi JOIN recipes r ON r.product_id=oi.product_id JOIN recipe_items ri ON ri.product_id=r.product_id
        JOIN ingredients i ON i.id=ri.ingredient_id WHERE oi.order_id=$1 AND i.venue_id=$2
          AND NOT (oi.product_id=ANY($3::uuid[]))
        GROUP BY oi.product_id,ri.ingredient_id,i.name,i.unit`, [orderId, venueId, [...cardProductIds]]);
      requirements.push(...legacy.rows.map((item) => ({ ...item, quantityText: String(item.quantity), sourceUnit: item.unit })));
    } catch (error) {
      // Some installations do not have the legacy recipe tables. Their absence
      // must not prevent current recipe cards from being applied.
      if (error.code !== '42P01') throw error;
      await client.query('ROLLBACK TO SAVEPOINT legacy_recipe_lookup');
    }
    if (!requirements.length) { if (ownsTransaction) await client.query('COMMIT'); return { lines: [], totalCost: 0 }; }
    const ids = requirements.map((item) => item.ingredientId).filter((item) => /^[0-9a-f-]{36}$/i.test(String(item || '')));
    const names = requirements.map((item) => String(item.name || '').toLowerCase()).filter(Boolean);
    const queryIds = ids.length ? ids : ['00000000-0000-0000-0000-000000000000'];
    const queryNames = names.length ? names : ['__none__'];
    await client.query('SELECT id FROM ingredients WHERE venue_id=$1 AND (id=ANY($2::uuid[]) OR lower(name)=ANY($3::text[])) FOR UPDATE', [venueId, queryIds, queryNames]);
    const existing = await client.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(sm.quantity * i.cost),0)::numeric AS cost FROM stock_movements sm JOIN ingredients i ON i.id=sm.ingredient_id WHERE sm.venue_id=$1 AND sm.order_id=$2 AND sm.direction='out'", [venueId, orderId]);
    if (Number(existing.rows[0]?.count || 0) > 0) {
      const snapshot = await client.query('SELECT cost FROM order_costs WHERE venue_id=$1 AND order_id=$2', [venueId, orderId]);
      const historicalCost = snapshot.rows[0] ? Number(snapshot.rows[0].cost) : Number(existing.rows[0].cost);
      if (ownsTransaction) await client.query('COMMIT');
      return { lines: [], totalCost: historicalCost, alreadyDepleted: true };
    }
    const { rows: stock } = await client.query(`SELECT i.id, i.name, i.cost, i.unit, COALESCE(SUM(CASE WHEN sm.direction IN ('in','transfer','adjustment') THEN sm.quantity WHEN sm.direction IN ('out','waste') THEN -sm.quantity ELSE 0 END),0)::numeric AS on_hand FROM ingredients i LEFT JOIN stock_movements sm ON sm.ingredient_id=i.id AND sm.venue_id=i.venue_id WHERE i.venue_id=$1 AND (i.id=ANY($2::uuid[]) OR lower(i.name)=ANY($3::text[])) GROUP BY i.id`, [venueId, queryIds, queryNames]);
    const byId = new Map(stock.map((item) => [item.id, item])); const byName = new Map(stock.map((item) => [item.name.toLowerCase(), item]));
    const grouped = new Map();
    const factors = { г: { г: 1, кг: 0.001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: 0.001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };
    for (const item of requirements) {
      const found = (item.ingredientId && byId.get(item.ingredientId)) || byName.get(String(item.name || '').toLowerCase());
      if (!found) throw Object.assign(new Error('recipe_ingredient_not_found'), { code: 'recipe_ingredient_not_found', ingredient: item.name || item.ingredientId });
      const parsed = parseRecipeQuantity(item.quantityText, found.unit, item.sourceUnit || null);
      if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error, ingredient: found.name, sourceUnit: parsed.sourceUnit, targetUnit: parsed.targetUnit });
      const converted = Number((parsed.amount * parsed.factor).toFixed(6));
      const previous = grouped.get(found.id);
      grouped.set(found.id, { ingredientId: found.id, name: found.name, unit: found.unit, quantity: (previous?.quantity || 0) + converted, stock: found });
    }
    const finalRequirements = [...grouped.values()]; const missing = finalRequirements.filter((item) => !item.stock || Number(item.stock.on_hand || 0) < Number(item.quantity));
    if (missing.length) { const error = new Error('insufficient_recipe_stock'); error.missing = missing.map((item) => ({ ...item, onHand: Number(item.stock?.on_hand || 0) })); throw error; }
    for (const item of finalRequirements) {
      const { rows: movementRows } = await client.query(`INSERT INTO stock_movements (venue_id,ingredient_id,direction,quantity,reason,order_id,created_by) VALUES ($1,$2,'out',$3,$4,$5,$6) RETURNING id`, [venueId, item.ingredientId, item.quantity, `Списание по заказу ${orderId}`, orderId, /^[0-9a-f-]{36}$/i.test(actorId || '') ? actorId : null]);
      await allocatePremixBatchConsumption(client, { venueId, ingredientId: item.ingredientId, stockMovementId: movementRows[0].id, quantity: item.quantity, onHandBefore: Number(item.stock?.on_hand || 0), createdBy: actorId, reason: `Списание по заказу ${orderId}` });
    }
    if (ownsTransaction) await client.query('COMMIT');
    return { lines: finalRequirements, totalCost: finalRequirements.reduce((sum, item) => sum + Number(item.quantity) * Number(item.stock?.cost || 0), 0) };
  } catch (error) {
    if (ownsTransaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { if (ownsTransaction) client.release(); }
}
const calculateOrderDiscount = (subtotal, entries) => {
  const base = roundMoney(Math.max(0, Number(subtotal) || 0));
  const requested = (entries || []).reduce((sum, request) => {
    const value = Math.max(0, Number(request.value) || 0);
    const amount = request.type === 'percent' ? base * Math.min(100, value) / 100 : request.type === 'fixed' ? value : 0;
    return sum + roundMoney(amount);
  }, 0);
  const discount = Math.min(moneyCents(base), moneyCents(requested)) / 100;
  return { subtotal: base, discount, net: roundMoney(base - discount) };
};
const selectOrderDiscount = (subtotal, approvedEntries, groupPercent = 0, hasGroup = false, promotions = [], lines = [], now = new Date(), groupName = null) => evaluateLoyaltyPricing({ subtotal, approvedDiscounts: approvedEntries, groupPercent, groupName, hasGroup, promotions, lines, now });
const approvedDiscountTotal = (orderId, subtotal) => calculateOrderDiscount(subtotal, discountRequests.filter((request) => request.orderId === orderId && request.status === 'approved')).discount;
const memoryOrderPricing = (order) => {
  if (order?.pricingLockedAt && order.pricingVersion && order.finalTotalSnapshot != null || order?.status === 'closed' && order.pricingVersion && order.finalTotalSnapshot != null) return { subtotal: Number(order.subtotalSnapshot), discount: Number(order.discountTotalSnapshot), net: roundMoney(Number(order.subtotalSnapshot) - Number(order.discountTotalSnapshot)), due: Number(order.finalTotalSnapshot), minimumAdjustment: Number(order.minimumAdjustmentSnapshot || 0), source: order.effectiveDiscountSource || 'none', groupDiscountAmount: order.groupDiscountAmount ?? null, groupDiscountGroupId: order.groupDiscountGroupId || null, groupDiscountName: order.groupDiscountName || null, groupDiscountPercent: order.groupDiscountPercent ?? null, groupDiscountBase: order.groupDiscountBase ?? null, selectedPromotion: order.selectedPromotionSnapshot || null, offers: order.pricingOffersSnapshot || [] };
  const latestPromotions = new Map();
  for (const item of loyaltyPromotions.filter((entry) => String(entry.venueId) === String(order.venueId))) if (!latestPromotions.has(item.promotionId) || Number(latestPromotions.get(item.promotionId).version) < Number(item.version)) latestPromotions.set(item.promotionId, item);
  const lines = (order.items || []).map((item) => { const product = products.find((entry) => String(entry.id) === String(item.productId)); return { orderItemId: item.id || item.orderItemId || null, productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice, category: product?.category || product?.station || item.station, productActive: product?.active !== false }; });
  const subtotal = subtotalFromLines(lines);
  const historicalOrder = order?.status === 'closed' || order?.status === 'cancelled' || Boolean(order?.pricingLockedAt);
  const selected = selectOrderDiscount(subtotal, discountRequests.filter((request) => request.orderId === order.id && request.status === 'approved'), Number(order.groupDiscountPercent || 0), Boolean(order.groupDiscountGroupId), historicalOrder ? [] : [...latestPromotions.values()].filter((item) => item.status === 'active'), lines, new Date(), order.groupDiscountName);
  const minimum = Number(order.minimumOrderTotal || 0);
  return { ...selected, subtotal, due: roundMoney(Math.max(selected.net, minimum)), minimumAdjustment: roundMoney(Math.max(0, minimum - selected.net)), groupDiscountGroupId: order.groupDiscountGroupId || null, groupDiscountName: order.groupDiscountName || null, groupDiscountPercent: order.groupDiscountPercent ?? null };
};
const orderNetTotal = (order) => memoryOrderPricing(order).net;
const receivedOrderPayments = (order) => (order.payments || []).filter((payment) => ['paid', 'partially_paid'].includes(payment.status)).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
const moneyCents = (value) => Math.round(Number(value) * 100);
const roundMoney = (value) => moneyCents(value) / 100;
const validPaymentAmount = (value) => Number.isFinite(value) && value > 0 && Math.abs(value * 100 - moneyCents(value)) < 1e-7;
const loyaltyBonusAccrual = (eligibleBase, bonusPercent) => {
  const base = roundMoney(Math.max(0, Number(eligibleBase) || 0));
  const percent = Math.min(100, Math.max(0, Number(bonusPercent) || 0));
  const percentBasisPoints = BigInt(Math.round(percent * 100));
  const earned = Number((BigInt(moneyCents(base)) * percentBasisPoints) / 1_000_000n);
  return { base, percent, earned };
};
const validCashAmount = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean' || Array.isArray(value) || (typeof value !== 'number' && typeof value !== 'string')) return false;
  const raw = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return false;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount >= 0 && amount <= 100000000;
};
const memoryOrderBalance = (order) => ({ due: memoryOrderPricing(order).due, paid: receivedOrderPayments(order) });
const orderBalanceConflict = ({ due, paid }) => moneyCents(paid) > moneyCents(due);
const orderBalanceConflictBody = ({ due, paid }) => ({ error: 'paid_order_total_conflict', due, paid });
async function pgOrderPricing(client, orderId, minimumOrderTotal = 0) {
  const { rows: orderRows } = await client.query('SELECT venue_id AS "venueId",status,pricing_locked_at AS "pricingLockedAt",group_discount_group_id AS "groupDiscountGroupId",group_discount_name AS "groupDiscountName",group_discount_percent AS "groupDiscountPercent",group_discount_base AS "groupDiscountBase",group_discount_amount AS "groupDiscountAmount",effective_discount_source AS "effectiveDiscountSource",subtotal_snapshot AS "subtotalSnapshot",discount_total_snapshot AS "discountTotalSnapshot",minimum_adjustment_snapshot AS "minimumAdjustmentSnapshot",final_total_snapshot AS "finalTotalSnapshot",pricing_version AS "pricingVersion",selected_promotion_id AS "selectedPromotionId",selected_promotion_version AS "selectedPromotionVersion",selected_promotion_name AS "selectedPromotionName",selected_promotion_benefit_kind AS "selectedPromotionBenefitKind",selected_promotion_benefit_value AS "selectedPromotionBenefitValue",selected_promotion_basis AS "selectedPromotionBasis",selected_promotion_amount AS "selectedPromotionAmount",pricing_offers_snapshot AS "pricingOffersSnapshot" FROM orders WHERE id=$1', [orderId]);
  const order = orderRows[0] || {};
  const canonical = await client.query(`SELECT s.*,COALESCE(jsonb_agg(jsonb_build_object('orderItemId',l.order_item_id,'grossCents',l.gross_minor,'discountCents',l.discount_minor,'netCents',l.net_minor,'eligibleForSelectedOffer',l.eligible,'quantity',l.quantity,'unitPrice',l.unit_price,'sellerId',l.seller_id,'soldAt',l.sold_at,'productFacts',l.product_facts) ORDER BY l.order_item_id) FILTER(WHERE l.id IS NOT NULL),'[]'::jsonb) AS lines FROM pos_order_pricing_snapshots s LEFT JOIN pos_order_pricing_snapshot_lines l ON l.snapshot_id=s.id WHERE s.venue_id=$1 AND s.order_id=$2 GROUP BY s.id`, [order.venueId,orderId]);
  if (canonical.rows[0]) {
    const s=canonical.rows[0]; const lines=s.lines||[];
    const subtotal=Number(s.subtotal_minor)/100, discount=Number(s.discount_minor)/100, net=subtotal-discount;
    return {subtotal,discount,net,due:Number(s.final_total_minor)/100,paid:Number((await client.query("SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE order_id=$1 AND status IN ('paid','partially_paid')",[orderId])).rows[0]?.paid||0),minimumAdjustment:Number(s.minimum_adjustment_minor)/100,source:s.discount_source,offers:s.frozen_terms?.offers||[],selectedPromotion:s.discount_source==='promotion'?s.winner_terms:null,groupDiscountGroupId:s.frozen_terms?.groupDiscountGroupId||null,groupDiscountName:s.frozen_terms?.groupDiscountName||null,groupDiscountPercent:s.frozen_terms?.groupDiscountPercent??null,lineAllocations:lines.map((line)=>({orderItemId:line.orderItemId,grossCents:Number(line.grossCents),discountCents:Number(line.discountCents),netCents:Number(line.netCents),gross:Number(line.grossCents)/100,discount:Number(line.discountCents)/100,net:Number(line.netCents)/100,eligibleForSelectedOffer:line.eligibleForSelectedOffer})),pricingLines:lines.map((line)=>({orderItemId:line.orderItemId,quantity:line.quantity,unitPrice:line.unitPrice,sellerId:line.sellerId,soldAt:line.soldAt,...line.productFacts})),lineSnapshotStatus:'complete'};
  }
  const { rows: itemRows } = await client.query('SELECT oi.id AS "orderItemId",oi.product_id AS "productId",oi.quantity,oi.unit_price AS "unitPrice",COALESCE(ROUND(SUM(oi.quantity*oi.unit_price) OVER (),2),0)::text AS subtotal,p.name AS "productName",p.category,p.is_active AS "productActive",oi.station,oi.sales_employee_id AS "sellerId",oi.sold_at::text AS "soldAt" FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id AND p.venue_id=$2 WHERE oi.order_id=$1 ORDER BY oi.id', [orderId, order.venueId]);
  const subtotal = itemRows.length ? itemRows[0].subtotal : '0.00';
  const { rows: discountRows } = await client.query("SELECT id,type,value FROM discounts WHERE order_id=$1 AND status='approved' ORDER BY id", [orderId]);
  const { rows: paidRows } = await client.query("SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE order_id=$1 AND status IN ('paid','partially_paid')", [orderId]);
  if ((order.status === 'closed' || order.pricingLockedAt) && order.pricingVersion && order.finalTotalSnapshot !== null) return { subtotal: Number(order.subtotalSnapshot), discount: Number(order.discountTotalSnapshot), net: roundMoney(Number(order.subtotalSnapshot) - Number(order.discountTotalSnapshot)), due: Number(order.finalTotalSnapshot), paid: Number(paidRows[0]?.paid || 0), minimumAdjustment: Number(order.minimumAdjustmentSnapshot || 0), source: order.effectiveDiscountSource || 'none', groupDiscountAmount: order.groupDiscountAmount === null ? null : Number(order.groupDiscountAmount), groupDiscountGroupId: order.groupDiscountGroupId, groupDiscountName: order.groupDiscountName, groupDiscountPercent: order.groupDiscountPercent === null ? null : Number(order.groupDiscountPercent), groupDiscountBase: order.groupDiscountBase === null ? null : Number(order.groupDiscountBase), selectedPromotion: order.selectedPromotionId ? { promotionId: order.selectedPromotionId, version: Number(order.selectedPromotionVersion), name: order.selectedPromotionName, benefitKind: order.selectedPromotionBenefitKind, benefitValue: Number(order.selectedPromotionBenefitValue), eligibleBasis: Number(order.selectedPromotionBasis), amount: Number(order.selectedPromotionAmount) } : null, offers: order.pricingOffersSnapshot || [], lineSnapshotStatus:'unknown' };
  const { rows: promotionRows } = await client.query(`SELECT p.promotion_id AS "promotionId",p.version,p.name,p.status,p.starts_at AS "startsAt",p.ends_at AS "endsAt",p.benefit_kind AS "benefitKind",p.benefit_value AS "benefitValue",p.priority,
      COALESCE(array_agg(s.product_id::text) FILTER (WHERE s.scope_kind='include_product'), '{}') AS "includeProductIds",COALESCE(array_agg(s.product_id::text) FILTER (WHERE s.scope_kind='exclude_product'), '{}') AS "excludeProductIds",
      COALESCE(array_agg(s.category_name) FILTER (WHERE s.scope_kind='include_category'), '{}') AS "includeCategories",COALESCE(array_agg(s.category_name) FILTER (WHERE s.scope_kind='exclude_category'), '{}') AS "excludeCategories"
    FROM (SELECT DISTINCT ON (venue_id,promotion_id) * FROM loyalty_promotions WHERE venue_id=$1 ORDER BY venue_id,promotion_id,version DESC) p
    LEFT JOIN loyalty_promotion_scopes s ON s.venue_id=p.venue_id AND s.promotion_id=p.promotion_id AND s.version=p.version
    GROUP BY p.promotion_id,p.version,p.name,p.status,p.starts_at,p.ends_at,p.benefit_kind,p.benefit_value,p.priority ORDER BY p.promotion_id`, [order.venueId]);
  const { rows: clockRows } = await client.query('SELECT now() AS instant');
  // A closed legacy order may predate pricing snapshots. Do not let promotions
  // activated later retroactively rewrite that historical price.
  const historicalOrder = order.status === 'closed' || order.status === 'cancelled' || Boolean(order.pricingLockedAt);
  const selected = selectOrderDiscount(subtotal, discountRows, Number(order.groupDiscountPercent || 0), Boolean(order.groupDiscountGroupId), historicalOrder ? [] : promotionRows.filter((item) => item.status === 'active'), itemRows, clockRows[0]?.instant || new Date(), order.groupDiscountName);
  const minimum = Number(minimumOrderTotal || 0);
  return { ...selected, subtotal, discount: selected.discount, due: roundMoney(Math.max(selected.net, minimum)), paid: Number(paidRows[0]?.paid || 0), minimumAdjustment: roundMoney(Math.max(0, minimum - selected.net)), groupDiscountGroupId: order.groupDiscountGroupId || null, groupDiscountName: order.groupDiscountName || null, groupDiscountPercent: order.groupDiscountPercent === null || order.groupDiscountPercent === undefined ? null : Number(order.groupDiscountPercent), pricingLines: itemRows, pricingInputs:{approvedDiscounts:discountRows,promotions:promotionRows.filter((item)=>item.status==='active')}, lineSnapshotStatus: historicalOrder ? 'unknown' : 'pending' };
}
async function writePosOrderPricingSnapshot(client, { venueId, orderId, pricing }) {
  const existing = await client.query('SELECT id FROM pos_order_pricing_snapshots WHERE venue_id=$1 AND order_id=$2', [venueId, orderId]);
  if (existing.rows[0]) return existing.rows[0].id;
  if (pricing.lineSnapshotStatus === 'unknown' || !Array.isArray(pricing.lineAllocations)) return null;
  const subtotalMinor = moneyCents(pricing.subtotal);
  const discountMinor = moneyCents(pricing.discount);
  const adjustmentMinor = moneyCents(pricing.minimumAdjustment || 0);
  const finalMinor = moneyCents(pricing.due);
  const selectedOffer = (pricing.offers || []).find((offer) => offer.reasonCode === 'selected') || {};
  const winnerSourceIds = pricing.source==='promotion' ? [selectedOffer.promotionId] : pricing.source==='guest_group' ? [pricing.groupDiscountGroupId] : pricing.source==='manual' ? (pricing.pricingInputs?.approvedDiscounts||[]).map((row)=>row.id) : [];
  const normalizedWinnerIds=winnerSourceIds.filter((id)=>/^[0-9a-f-]{36}$/i.test(String(id)));
  const { rows } = await client.query(`INSERT INTO pos_order_pricing_snapshots
    (venue_id,order_id,sold_at,subtotal_minor,discount_minor,minimum_adjustment_minor,final_total_minor,discount_source,winner_source_id,winner_terms,winner_source_ids,eligible_item_ids,frozen_terms)
    VALUES($1,$2,now(),$3,$4,$5,$6,$7,$8,$9::jsonb,$10::uuid[],$11::uuid[],$12::jsonb) RETURNING id`,
  [venueId,orderId,subtotalMinor,discountMinor,adjustmentMinor,finalMinor,pricing.source || 'none',normalizedWinnerIds.length===1?normalizedWinnerIds[0]:null,JSON.stringify(selectedOffer),normalizedWinnerIds,(selectedOffer.eligibleItemIds || []).filter((id)=>/^[0-9a-f-]{36}$/i.test(String(id))),JSON.stringify({offers:pricing.offers||[],inputs:pricing.pricingInputs||{},groupDiscountGroupId:pricing.groupDiscountGroupId,groupDiscountName:pricing.groupDiscountName,groupDiscountPercent:pricing.groupDiscountPercent,minimumAdjustment:pricing.minimumAdjustment,allocationPolicy:'largest-remainder-item-id-v1'})]);
  const snapshotId = rows[0].id;
  const lines = new Map((pricing.pricingLines || []).map((line)=>[String(line.orderItemId),line]));
  for (const allocation of pricing.lineAllocations) {
    const line=lines.get(String(allocation.orderItemId));
    if (!line) throw Object.assign(new Error('order_pricing_snapshot_line_missing'),{code:'order_pricing_snapshot_line_missing'});
    await client.query(`INSERT INTO pos_order_pricing_snapshot_lines
      (venue_id,snapshot_id,order_id,order_item_id,seller_id,sold_at,quantity,unit_price,gross_minor,discount_minor,net_minor,eligible,product_facts)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [venueId,snapshotId,orderId,line.orderItemId,line.sellerId||null,line.soldAt||null,line.quantity,line.unitPrice,allocation.grossCents,allocation.discountCents,allocation.netCents,allocation.eligibleForSelectedOffer,JSON.stringify({productId:line.productId,productName:line.productName,category:line.category,station:line.station,productActive:line.productActive})]);
  }
  return snapshotId;
}
const pgOrderBalance = async (client, orderId, minimumOrderTotal = 0) => { const { due, paid } = await pgOrderPricing(client, orderId, minimumOrderTotal); return { due, paid }; };
async function pgReservationPrepaymentState(client, venueId, reservationId) {
  if (!reservationId) return { available: 0, receipts: [] };
  const { rows } = await client.query(`SELECT p.id,p.amount,p.payment_method AS method,p.created_at AS "createdAt",
    GREATEST(0,p.amount-COALESCE(a.amount,0)+COALESCE(ar.amount,0)-COALESCE(rr.amount,0)) AS available
    FROM reservation_pre_payment_receipts p
    LEFT JOIN LATERAL (SELECT SUM(x.amount) AS amount FROM reservation_pre_payment_allocations x WHERE x.venue_id=p.venue_id AND x.receipt_id=p.id) a ON true
    LEFT JOIN LATERAL (SELECT SUM(x.amount) AS amount FROM reservation_pre_payment_allocation_reversals x JOIN reservation_pre_payment_allocations ax ON ax.venue_id=x.venue_id AND ax.id=x.allocation_id WHERE x.venue_id=p.venue_id AND ax.receipt_id=p.id) ar ON true
    LEFT JOIN LATERAL (SELECT SUM(amount) AS amount FROM reservation_pre_payment_receipt_reversals x WHERE x.venue_id=p.venue_id AND x.receipt_id=p.id) rr ON true
    WHERE p.venue_id=$1 AND p.reservation_id=$2
    ORDER BY p.created_at,p.id`, [venueId,reservationId]);
  const receipts = rows.map((row) => ({ ...row, amount: Number(row.amount), available: Number(row.available) })).filter((row) => row.available > 0);
  return { available: roundMoney(receipts.reduce((sum,row)=>sum+row.available,0)), receipts };
}
const orderPricingSqlCtes = `canonical_totals AS (
  SELECT order_id,venue_id,subtotal_minor/100.0 AS subtotal,discount_minor/100.0 AS discount,minimum_adjustment_minor/100.0 AS minimum_adjustment,final_total_minor/100.0 AS final_total
  FROM pos_order_pricing_snapshots
), item_totals AS (
  SELECT o.id AS order_id,COALESCE(c.subtotal,SUM(oi.quantity*oi.unit_price),0) AS subtotal FROM orders o
  LEFT JOIN canonical_totals c ON c.order_id=o.id AND c.venue_id=o.venue_id LEFT JOIN order_items oi ON oi.order_id=o.id GROUP BY o.id,c.subtotal
), manual_totals AS (
  SELECT d.order_id,LEAST(COALESCE(i.subtotal,0),COALESCE(SUM(ROUND(CASE WHEN d.type='percent' THEN COALESCE(i.subtotal,0)*LEAST(100,GREATEST(0,d.value))/100 ELSE GREATEST(0,d.value) END,2)),0)) AS amount
  FROM discounts d JOIN item_totals i ON i.order_id=d.order_id WHERE d.status='approved' GROUP BY d.order_id,i.subtotal
), latest_promotions AS (
  SELECT DISTINCT ON (venue_id,promotion_id) * FROM loyalty_promotions ORDER BY venue_id,promotion_id,version DESC
), promotion_basis AS (
  SELECT o.id AS order_id,p.venue_id,p.promotion_id,p.priority,p.benefit_kind,p.benefit_value,
    COALESCE(SUM(oi.quantity*oi.unit_price),0) AS basis
  FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products pr ON pr.id=oi.product_id AND pr.venue_id=o.venue_id AND pr.is_active=true
  JOIN latest_promotions p ON p.venue_id=o.venue_id AND p.status='active' AND p.starts_at<=now() AND now()<p.ends_at
    AND o.status NOT IN ('closed','cancelled') AND o.pricing_locked_at IS NULL
  WHERE EXISTS (SELECT 1 FROM loyalty_promotion_scopes s WHERE s.venue_id=p.venue_id AND s.promotion_id=p.promotion_id AND s.version=p.version AND ((s.scope_kind='include_product' AND s.product_id=oi.product_id) OR (s.scope_kind='include_category' AND s.category_name=pr.category)))
    AND NOT EXISTS (SELECT 1 FROM loyalty_promotion_scopes s WHERE s.venue_id=p.venue_id AND s.promotion_id=p.promotion_id AND s.version=p.version AND ((s.scope_kind='exclude_product' AND s.product_id=oi.product_id) OR (s.scope_kind='exclude_category' AND s.category_name=pr.category)))
  GROUP BY o.id,p.venue_id,p.promotion_id,p.priority,p.benefit_kind,p.benefit_value
), promotion_totals AS (
  SELECT DISTINCT ON (order_id) order_id,priority,amount FROM (
    SELECT order_id,promotion_id,priority,LEAST(basis,CASE WHEN benefit_kind='percent' THEN ROUND(basis*benefit_value/100,2) ELSE benefit_value END) AS amount
    FROM promotion_basis WHERE basis>0
  ) x ORDER BY order_id,amount DESC,priority DESC,promotion_id
), discount_candidates AS (
  SELECT o.id AS order_id,COALESCE(m.amount,0) AS amount,1 AS source_rank,0 AS priority,'manual'::text AS source
  FROM orders o LEFT JOIN manual_totals m ON m.order_id=o.id
  UNION ALL
  SELECT o.id,ROUND(COALESCE(i.subtotal,0)*COALESCE(o.group_discount_percent,0)/100,2),2,0,'guest_group'::text
  FROM orders o LEFT JOIN item_totals i ON i.order_id=o.id
  UNION ALL
  SELECT o.id,pt.amount,3,pt.priority,'promotion'::text
  FROM orders o JOIN promotion_totals pt ON pt.order_id=o.id
), best_discounts AS (
  SELECT DISTINCT ON (order_id) order_id,amount FROM discount_candidates ORDER BY order_id,amount DESC,source_rank DESC,priority DESC
), discount_totals AS (
  SELECT o.id AS order_id,
    CASE WHEN c.discount IS NOT NULL THEN c.discount WHEN (o.status='closed' OR o.pricing_locked_at IS NOT NULL) AND o.pricing_version IS NOT NULL AND o.discount_total_snapshot IS NOT NULL THEN o.discount_total_snapshot
    ELSE LEAST(COALESCE(i.subtotal,0),COALESCE(b.amount,0)) END AS discount
  FROM orders o LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN best_discounts b ON b.order_id=o.id LEFT JOIN canonical_totals c ON c.order_id=o.id AND c.venue_id=o.venue_id
)`;
const financeDateLedger = async (client, venueId, date, timezone) => {
  const salesResult = await client.query(`WITH ${orderPricingSqlCtes}, bounds AS (
      SELECT ($2::date::timestamp AT TIME ZONE $3) AS starts_at,(($2::date+1)::timestamp AT TIME ZONE $3) AS ends_at
    ), closed_sales AS (
      SELECT o.id,o.pricing_version,o.subtotal_snapshot,o.discount_total_snapshot,o.minimum_adjustment_snapshot,o.final_total_snapshot,(c.order_id IS NOT NULL) AS canonical_snapshot_present,
        COALESCE(c.subtotal,o.subtotal_snapshot,i.subtotal,0) AS gross,
        COALESCE(c.discount,o.discount_total_snapshot,d.discount,0) AS discount,
        COALESCE(c.minimum_adjustment,o.minimum_adjustment_snapshot,o.vip_minimum,0) AS minimum_adjustment,
        COALESCE(c.final_total,o.final_total_snapshot,
          GREATEST(0,GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0)))) AS net
      FROM orders o LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN discount_totals d ON d.order_id=o.id LEFT JOIN canonical_totals c ON c.order_id=o.id AND c.venue_id=o.venue_id CROSS JOIN bounds b
      WHERE o.venue_id=$1 AND o.status='closed' AND o.closed_at>=b.starts_at AND o.closed_at<b.ends_at
    )
    SELECT COUNT(*)::int AS orders,
      COUNT(*) FILTER (WHERE NOT canonical_snapshot_present)::int AS unsnapshotted_orders,
      COALESCE(SUM(gross),0)::numeric AS gross,COALESCE(SUM(discount),0)::numeric AS discounts,
      COALESCE(SUM(minimum_adjustment),0)::numeric AS minimum_adjustment,COALESCE(SUM(net),0)::numeric AS net
    FROM closed_sales`, [venueId,date,timezone]);
  const receiptResult = await client.query(`WITH bounds AS (
      SELECT ($2::date::timestamp AT TIME ZONE $3) AS starts_at,(($2::date+1)::timestamp AT TIME ZONE $3) AS ends_at
    ), receipts AS (
      SELECT p.method,p.amount,'order_payment'::text AS source FROM payments p JOIN orders o ON o.id=p.order_id CROSS JOIN bounds b
        WHERE o.venue_id=$1 AND p.method IN ('cash','card','qr') AND p.status IN ('paid','partially_paid') AND p.created_at>=b.starts_at AND p.created_at<b.ends_at
      UNION ALL SELECT p.payment_method,p.amount,'guest_account_top_up'::text FROM guest_deposit_receipts p,bounds b
        WHERE p.venue_id=$1 AND p.created_at>=b.starts_at AND p.created_at<b.ends_at
      UNION ALL SELECT p.payment_method,p.amount,'reservation_prepayment'::text FROM reservation_pre_payment_receipts p,bounds b
        WHERE p.venue_id=$1 AND p.created_at>=b.starts_at AND p.created_at<b.ends_at
    ) SELECT method,source,COALESCE(SUM(amount),0)::numeric AS amount,COUNT(*)::int AS count FROM receipts GROUP BY method,source ORDER BY source,method`, [venueId,date,timezone]);
  const payoutResult = await client.query(`WITH bounds AS (
      SELECT ($2::date::timestamp AT TIME ZONE $3) AS starts_at,(($2::date+1)::timestamp AT TIME ZONE $3) AS ends_at
    ), payouts AS (
      SELECT x.payout_method AS method,x.amount,'guest_account_refund'::text AS source FROM guest_account_reversals x,bounds b
        WHERE x.venue_id=$1 AND x.payout_method IN ('cash','card','qr') AND x.created_at>=b.starts_at AND x.created_at<b.ends_at
      UNION ALL SELECT x.payout_method,x.amount,'reservation_prepayment_refund'::text FROM reservation_pre_payment_receipt_reversals x,bounds b
        WHERE x.venue_id=$1 AND x.payout_method IN ('cash','card','qr') AND x.created_at>=b.starts_at AND x.created_at<b.ends_at
      UNION ALL SELECT t.payout_method,t.amount,'order_refund'::text FROM order_refund_tenders t JOIN order_refunds r ON r.venue_id=t.venue_id AND r.id=t.refund_id,bounds b
        WHERE t.venue_id=$1 AND t.payout_method IN ('cash','card','qr') AND t.created_at>=b.starts_at AND t.created_at<b.ends_at
    ) SELECT method,source,COALESCE(SUM(amount),0)::numeric AS amount,COUNT(*)::int AS count FROM payouts GROUP BY method,source ORDER BY source,method`, [venueId,date,timezone]);
  const fold = (rows) => {
    const byMethod = {}; const bySource = {}; let total = 0; let count = 0;
    for (const row of rows) {
      const amount = Number(row.amount || 0); const entries = Number(row.count || 0);
      byMethod[row.method] = (byMethod[row.method] || 0) + amount;
      bySource[row.source] = (bySource[row.source] || 0) + amount;
      total += amount; count += entries;
    }
    return { total: roundMoney(total), count, byMethod, bySource };
  };
  const sale = salesResult.rows[0] || {};
  return {
    sales: { orders: Number(sale.orders || 0), unsnapshottedOrders: Number(sale.unsnapshotted_orders || 0), gross: roundMoney(Number(sale.gross || 0)), discounts: roundMoney(Number(sale.discounts || 0)), minimumAdjustment: roundMoney(Number(sale.minimum_adjustment || 0)), net: roundMoney(Number(sale.net || 0)), dateBasis: 'closed_at' },
    receipts: { ...fold(receiptResult.rows), dateBasis: 'created_at', coverage: 'postgres_order_payments_and_guest_receipts' },
    payouts: { ...fold(payoutResult.rows), dateBasis: 'created_at', coverage: 'guest_account_reservation_prepayment_and_order_refund_ledgers_only' }
  };
};
async function accrueGuestOrderBonus(client, { venueId, guestId, orderId, eligibleBase, actorId }) {
  const base = roundMoney(Math.max(0, Number(eligibleBase) || 0));
  if (!guestId) return { base, percent: 0, earned: 0, balance: null };
  const { rows: guestRows } = await client.query('SELECT id,loyalty_points AS "loyaltyPoints",discount_group_id AS "discountGroupId" FROM guests WHERE id=$1 AND venue_id=$2 FOR UPDATE', [guestId, venueId]);
  const guest = guestRows[0];
  if (!guest) return { base, percent: 0, earned: 0, balance: null };
  let percent = 0;
  if (guest.discountGroupId) {
    const { rows: groupRows } = await client.query('SELECT bonus_percent AS "bonusPercent" FROM guest_discount_groups WHERE id=$1 AND venue_id=$2 AND active=true', [guest.discountGroupId, venueId]);
    percent = Number(groupRows[0]?.bonusPercent || 0);
  }
  const accrual = loyaltyBonusAccrual(base, percent);
  const currentBalance = Number(guest.loyaltyPoints || 0);
  const grossEarned = Math.min(accrual.earned, Math.max(0, 2147483647 - currentBalance));
  const sourceKey = `order:${orderId}:bonus-earned:v1`;
  if (grossEarned > 0) {
    const inserted = await client.query(`INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_id,source_key,actor_id)
      VALUES ($1,$2,'bonus',$3,'Бонусное начисление за заказ','order',$4,$5,$6)
      ON CONFLICT (guest_id,account_type,source_key) DO NOTHING RETURNING id`, [venueId, guest.id, grossEarned, orderId, sourceKey, /^[0-9a-f-]{36}$/i.test(actorId || '') ? actorId : null]);
    if (!inserted.rows[0]) throw Object.assign(new Error('loyalty_bonus_entry_conflict'), { code: 'loyalty_bonus_entry_conflict' });
    const { rows: holds } = await client.query(`SELECT reversal_id AS "reversalId",SUM(amount)::int AS remaining
      FROM guest_bonus_clawback_entries WHERE venue_id=$1 AND guest_id=$2 GROUP BY reversal_id HAVING SUM(amount)>0 ORDER BY MIN(created_at),reversal_id`, [venueId, guest.id]);
    let unspent = grossEarned;
    let clawedBack = 0;
    for (const hold of holds) {
      if (unspent <= 0) break;
      const consumed = Math.min(unspent, Number(hold.remaining || 0));
      if (!consumed) continue;
      const holdKey = `bonus-clawback-apply:${hold.reversalId}:order:${orderId}`;
      await client.query(`INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_id,source_key,actor_id)
        VALUES ($1,$2,'bonus',$3,'Зачёт удержания бонусов','reversal',$4,$5,$6)`, [venueId, guest.id, -consumed, hold.reversalId, holdKey, /^[0-9a-f-]{36}$/i.test(actorId || '') ? actorId : null]);
      await client.query(`INSERT INTO guest_bonus_clawback_entries (venue_id,guest_id,reversal_id,order_id,amount,source_key,reason,actor_id)
        VALUES ($1,$2,$3,$4,$5,$6,'Погашение удержания будущим начислением',$7)`, [venueId, guest.id, hold.reversalId, orderId, -consumed, holdKey, /^[0-9a-f-]{36}$/i.test(actorId || '') ? actorId : null]);
      unspent -= consumed;
      clawedBack += consumed;
    }
    const earned = grossEarned - clawedBack;
    const updated = await client.query('UPDATE guests SET loyalty_points=loyalty_points+$1 WHERE id=$2 AND venue_id=$3 RETURNING loyalty_points AS "loyaltyPoints"', [earned, guest.id, venueId]);
    if (!updated.rows[0]) throw Object.assign(new Error('loyalty_bonus_guest_missing'), { code: 'loyalty_bonus_guest_missing' });
    return { base: accrual.base, percent: accrual.percent, earned, balance: Number(updated.rows[0].loyaltyPoints) };
  }
  return { base: accrual.base, percent: accrual.percent, earned: 0, balance: currentBalance };
}
function accrueMemoryOrderBonus(order, eligibleBase, actorName) {
  const client = clients.find((entry) => entry.id === (order.clientId || order.guestId));
  const base = roundMoney(Math.max(0, Number(eligibleBase) || 0));
  const group = client?.discountGroupId && discountGroups.find((entry) => entry.id === client.discountGroupId && entry.venueId === currentVenueId && entry.active !== false);
  const accrual = loyaltyBonusAccrual(base, Number(group?.bonusPercent || 0));
  if (!client) return { base: accrual.base, percent: accrual.percent, earned: 0, balance: null };
  client.loyaltyPoints = Number(client.loyaltyPoints ?? client.bonusBalance ?? 0);
  client.bonusBalance = client.loyaltyPoints;
  client.accountEntries ||= [];
  const sourceKey = `order:${order.id}:bonus-earned:v1`;
  if (accrual.earned > 0 && !client.accountEntries.some((entry) => entry.sourceKey === sourceKey)) {
    const earned = Math.min(accrual.earned, Math.max(0, 2147483647 - client.loyaltyPoints));
    if (earned > 0) {
      client.loyaltyPoints += earned;
      client.bonusBalance = client.loyaltyPoints;
      client.accountEntries.unshift({ id: `account-${crypto.randomUUID()}`, accountType: 'bonus', amount: earned, reason: 'Бонусное начисление за заказ', sourceType: 'order', sourceId: order.id, sourceKey, createdAt: new Date().toISOString(), actorName: actorName || 'Система' });
    }
    return { base: accrual.base, percent: accrual.percent, earned, balance: client.loyaltyPoints };
  }
  return { base: accrual.base, percent: accrual.percent, earned: 0, balance: client.loyaltyPoints };
}
const orderStatusTransitions = { open: ['open', 'in_progress', 'cancelled'], in_progress: ['in_progress', 'ready', 'open', 'cancelled'], ready: ['ready', 'closed', 'in_progress', 'cancelled'], closed: ['closed'], cancelled: ['cancelled'] };
const validOrderTransition = (from, to) => Boolean(orderStatusTransitions[from]?.includes(to));
const vipSummary = (order) => {
  const pricing = memoryOrderPricing(order); const minimum = Number(order.minimumOrderTotal || 0);
  return { orderId: order.id, ...pricing, minimum, shortfall: Math.max(0, minimum - pricing.net), minimumApplied: minimum > 0 };
};
const businessTimezone = process.env.BUSINESS_TIMEZONE || 'Asia/Yekaterinburg';
const businessDateKey = (value) => { const raw = String(value || ''); if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw; const parsed = value instanceof Date ? value : new Date(value); if (Number.isNaN(parsed.getTime())) return raw.slice(0, 10); return new Intl.DateTimeFormat('en-CA', { timeZone: businessTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed); };
const medianOf = (values) => { const ordered = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); if (!ordered.length) return 0; const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2; };
const allocateMoneyByGross = (items, amount, keyOf, grossOf, fallbackKey = 'other') => {
  const grouped = new Map();
  for (const item of items || []) {
    const key = String(keyOf(item) || fallbackKey);
    const gross = Math.max(0, Number(grossOf(item) || 0));
    grouped.set(key, (grouped.get(key) || 0) + gross);
  }
  const entries = [...grouped.entries()];
  const targetCents = Math.max(0, Math.round(Number(amount || 0) * 100));
  const grossTotal = entries.reduce((sum, [, gross]) => sum + gross, 0);
  if (!entries.length || grossTotal <= 0) return new Map([[fallbackKey, targetCents / 100]]);
  const shares = entries.map(([key, gross], index) => {
    const exactCents = targetCents * gross / grossTotal;
    const cents = Math.floor(exactCents);
    return { key, cents, fraction: exactCents - cents, index };
  });
  let remaining = targetCents - shares.reduce((sum, share) => sum + share.cents, 0);
  for (const share of shares.slice().sort((a, b) => b.fraction - a.fraction || a.index - b.index)) {
    if (remaining <= 0) break;
    share.cents += 1;
    remaining -= 1;
  }
  return new Map(shares.map(({ key, cents }) => [key, cents / 100]));
};
const today = () => businessDateKey(new Date());
const normalizeRecipeCard = (recipe) => ({ ...recipe, yieldQuantity: Number(recipe.yieldQuantity || 1), portionCount: Number(recipe.portionCount || 1) });
const isValidIanaTimezone = (value) => {
  const timezone = String(value || '').trim();
  if (!timezone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0); return true; }
  catch (_) { return false; }
};
const resolveIanaTimezone = (...values) => values.map((value) => String(value || '').trim()).find(isValidIanaTimezone) || 'Asia/Yekaterinburg';
const venueBusinessDateContext = async (pool, venueId) => {
  const { rows } = await pool.query('SELECT v.timezone AS "venueTimezone", org.timezone AS "organizationTimezone" FROM venues v LEFT JOIN organizations org ON org.id=v.organization_id WHERE v.id=$1', [venueId]);
  if (!rows[0]) return null;
  const timezone = resolveIanaTimezone(rows[0].venueTimezone, rows[0].organizationTimezone);
  const { rows: dateRows } = await pool.query('SELECT (now() AT TIME ZONE $1)::date::text AS date', [timezone]);
  return dateRows[0]?.date ? { timezone, date: dateRows[0].date } : null;
};
const recentBusinessDates = (count = 7) => { const current = new Date(`${today()}T00:00:00Z`); return Array.from({ length: count }, (_, index) => { const date = new Date(current); date.setUTCDate(current.getUTCDate() - (count - 1 - index)); return date.toISOString().slice(0, 10); }); };
const pendingPaymentSummary = (items = orders) => { const active = items.filter((order) => ['open', 'in_progress', 'ready'].includes(order.status)); const pendingRevenue = active.reduce((sum, order) => { const due = Math.max(Number(order.minimumOrderTotal || 0), orderNetTotal(order)); const paid = (order.payments || []).filter((payment) => ['paid', 'partially_paid'].includes(payment.status)).reduce((total, payment) => total + Number(payment.amount || 0), 0); return sum + Math.max(0, due - paid); }, 0); return { pendingOrders: active.length, pendingRevenue: Math.round(pendingRevenue * 100) / 100 }; };
const isBelowInventoryMinimum = (item) => Number(item.minLevel || 0) > 0 && Number(item.onHand || 0) <= Number(item.minLevel || 0);
const metrics = () => ({
  ...pendingPaymentSummary(),
  openOrders: orders.filter((order) => ['open', 'in_progress', 'ready'].includes(order.status)).length,
  closedOrders: orders.filter((order) => order.status === 'closed').length,
  discountRequests: discountRequests.filter((request) => request.status === 'requested').length,
  staffActive: staff.filter((person) => person.active).length,
  reservationsToday: reservations.filter((reservation) => reservation.date === today()).length,
  lowStock: inventory.filter(isBelowInventoryMinimum).length
});
const visibleMetrics = (req, values) => {
  const visible = {};
  const include = (permission, fields) => { if (hasPermission(req, permission)) for (const field of fields) visible[field] = values[field]; };
  include('orders', ['openOrders', 'pendingOrders', 'closedOrders']);
  include('finance_read', ['pendingRevenue', 'discountRequests']);
  if (hasPermission(req, 'staff_view') || hasPermission(req, 'staff')) visible.staffActive = values.staffActive;
  include('reservations', ['reservationsToday']);
  include('inventory_read', ['lowStock']);
  return visible;
};
const setMemoryTableStatus = (tableId, status) => { const table = floor.flatMap((zone) => zone.tables).find((entry) => entry.id === tableId); if (table && table.status !== 'blocked') table.status = status; };
const releaseMemoryTableIfIdle = (tableId) => { const hasActiveOrder = orders.some((order) => order.tableId === tableId && ['open', 'in_progress', 'ready'].includes(order.status)); const hasReservation = reservations.some((reservation) => reservation.tableId === tableId && reservation.status === 'confirmed' && reservation.date === today()); if (!hasActiveOrder) setMemoryTableStatus(tableId, hasReservation ? 'reserved' : 'free'); };
const memoryPremixRemaining = (batch) => batch.status === 'voided' ? 0 : Number(Math.max(0, Number(batch.outputQuantity || 0) + (batch.lotMovements || []).reduce((sum, row) => sum + Number(row.quantityDelta || 0), 0)).toFixed(6));
const allocateMemoryPremixConsumption = (ingredientId, quantity, onHandBefore, movementId, reason, { apply = true } = {}) => {
  const lots = stockMovements.filter((item) => item.type === 'premix' && String(item.outputItemId) === String(ingredientId) && item.status !== 'voided' && memoryPremixRemaining(item) > 0)
    .sort((a, b) => (a.expiresAt || '9999').localeCompare(b.expiresAt || '9999') || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const tracked = lots.reduce((sum, batch) => sum + memoryPremixRemaining(batch), 0);
  let remaining = Math.max(0, Number(quantity) - Math.min(Number(quantity), Math.max(0, Number(onHandBefore || 0) - tracked)));
  const allocations = []; let available = 0;
  for (const batch of lots) if (!batch.expiresAt || new Date(batch.expiresAt).getTime() > Date.now()) available += memoryPremixRemaining(batch);
  if (remaining > available + 0.000001) throw new Error(lots.some((batch) => batch.expiresAt && new Date(batch.expiresAt).getTime() <= Date.now()) ? 'expired_premix_stock' : 'premix_batch_balance_mismatch');
  for (const batch of lots) { if (remaining <= 0.000001) break; if (batch.expiresAt && new Date(batch.expiresAt).getTime() <= Date.now()) continue; const used = Math.min(memoryPremixRemaining(batch), remaining); allocations.push({ batch, used }); remaining -= used; }
  if (apply) for (const { batch, used } of allocations) { batch.lotMovements ||= []; batch.lotMovements.push({ movementId, type: 'consumption', quantityDelta: -used, reason, createdAt: new Date().toISOString() }); }
  return allocations;
};
const depleteMemoryOrder = (order, { reason = `Списание по заказу ${order.id}` } = {}) => {
  if (order.recipeDepleted) return { lines: [], totalCost: Number(order.costOfGoods || 0), alreadyDepleted: true };
  const requirements = [];
  for (const orderItem of order.items || []) {
    const product = products.find((entry) => String(entry.id) === String(orderItem.productId));
    const inventoryMode = product?.inventoryMode || 'needs_review';
    if (inventoryMode === 'non_stock') continue;
    if (inventoryMode === 'needs_review') throw Object.assign(new Error('product_inventory_mode_required'), { code: 'product_inventory_mode_required', productId: orderItem.productId, productName: product?.name || orderItem.name });
    if (inventoryMode !== 'tracked') throw Object.assign(new Error('product_inventory_mode_invalid'), { code: 'product_inventory_mode_invalid', productId: orderItem.productId, productName: product?.name || orderItem.name });
    const normalizedName = String(product?.name || orderItem.name || '').trim().toLocaleLowerCase('ru-RU');
    const productRecipes = recipes.filter((entry) => entry.active !== false && entry.recipeType !== 'premix' && String(entry.productId || '') === String(orderItem.productId));
    const genericRecipes = recipes.filter((entry) => entry.active !== false && entry.recipeType !== 'premix' && !entry.productId && String(entry.name || '').trim().toLocaleLowerCase('ru-RU') === normalizedName);
    const sameNameProducts = products.filter((entry) => entry.active !== false && String(entry.name || '').trim().toLocaleLowerCase('ru-RU') === normalizedName);
    if (productRecipes.length > 1 || (!productRecipes.length && genericRecipes.length && (genericRecipes.length !== 1 || sameNameProducts.length !== 1))) throw Object.assign(new Error('product_recipe_ambiguous'), { code: 'product_recipe_ambiguous', productId: orderItem.productId, productName: product?.name || orderItem.name });
    const recipe = productRecipes[0] || genericRecipes[0];
    if (!recipe) throw Object.assign(new Error('product_recipe_required'), { code: 'product_recipe_required', productId: orderItem.productId, productName: product?.name || orderItem.name });
    if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) throw Object.assign(new Error('recipe_invalid'), { code: 'recipe_invalid', productId: orderItem.productId });
    let scaledIngredients;
    try { scaledIngredients = scaleBatchRecipeIngredients(recipe.ingredients, Number(orderItem.quantity), Number(recipe.portionCount || 1)); }
    catch (error) { throw Object.assign(new Error('recipe_invalid'), { code: 'recipe_invalid', detail: error.message, productId: orderItem.productId }); }
    for (const ingredient of scaledIngredients) {
      const name = String(ingredient.name || '').trim(); const ingredientId = String(ingredient.ingredientId || '').trim();
      if (!name || !ingredientId) throw Object.assign(new Error('recipe_invalid'), { code: 'recipe_invalid', productId: orderItem.productId });
      const stock = inventory.find((entry) => entry.id === ingredientId);
      if (!stock) throw Object.assign(new Error('recipe_ingredient_not_found'), { code: 'recipe_ingredient_not_found', ingredient: name });
      const parsed = parseRecipeQuantity(ingredient.quantity, stock.unit, ingredient.unit || null);
      if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error, ingredient: stock.name, sourceUnit: parsed.sourceUnit, targetUnit: parsed.targetUnit });
      const quantity = Number(parsed.amount) * Number(parsed.factor);
      const previous = requirements.find((entry) => entry.stock?.id === stock.id);
      if (previous) previous.quantity += quantity; else requirements.push({ name: stock.name, ingredientId: stock.id, quantity, stock });
    }
  }
  const missing = requirements.filter((entry) => !entry.stock || !Number.isFinite(entry.quantity) || Number(entry.stock.onHand || 0) < entry.quantity);
  if (missing.length) { const error = new Error('insufficient_recipe_stock'); error.missing = missing.map((entry) => ({ ...entry, onHand: Number(entry.stock?.onHand || 0) })); throw error; }
  const movementIds = new Map(requirements.map((entry) => [entry.ingredientId, `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`]));
  for (const entry of requirements) allocateMemoryPremixConsumption(entry.stock.id, entry.quantity, Number(entry.stock.onHand || 0), movementIds.get(entry.ingredientId), reason, { apply: false });
  const totalCost = requirements.reduce((sum, entry) => sum + Number(entry.quantity) * Number(entry.stock?.cost || 0), 0);
  for (const entry of requirements) { const before = Number(entry.stock.onHand || 0); const movementId = movementIds.get(entry.ingredientId); allocateMemoryPremixConsumption(entry.stock.id, entry.quantity, before, movementId, reason); entry.stock.onHand = Number((before - entry.quantity).toFixed(6)); stockMovements.push({ id: movementId, itemId: entry.stock.id, itemName: entry.stock.name, direction: 'out', delta: -entry.quantity, quantity: entry.quantity, reason, orderId: order.id, createdAt: new Date().toISOString() }); }
  order.recipeDepleted = true; order.costOfGoods = totalCost;
  return { lines: requirements, totalCost };
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const STANDARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TRUSTED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = STANDARD_SESSION_TTL_MS;
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const sessionTtlSeconds = (ttlMs) => Math.floor(ttlMs / 1000);
const timeValue = (value) => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};
const isTrustedSession = (session) => {
  if (!session) return false;
  if (session.trustedDevice === true) return true;
  const createdAt = timeValue(session.createdAt);
  const expiresAt = timeValue(session.expiresAt);
  return Number.isFinite(createdAt) && Number.isFinite(expiresAt) && expiresAt - createdAt > STANDARD_SESSION_TTL_MS;
};
const canUseTrustedDevice = (role) => ['owner', 'admin', 'developer'].includes(String(role || ''));
const requestCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((parts) => parts.length === 2));
const requestAuthToken = (req) => { const header = req.headers.authorization || ''; return header.startsWith('Bearer ') ? header.slice(7) : (requestCookies(req).crm_session || ''); };
const sessionFromRequest = async (req) => {
  const header = req.headers.authorization || '';
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((parts) => parts.length === 2));
  const token = header.startsWith('Bearer ') ? header.slice(7) : (cookies.crm_session || '');
  if (!token) return null;
  if (process.env.DATABASE_URL || sessionRepository) {
    if (sessionRepository) {
      try {
        const persisted = await sessionRepository.get(hashToken(token));
        if (persisted) { let rolePermissionScopes = []; let rolePermissionOverrideActive = false; if (typeof repositories !== 'undefined' && repositories?.pool && persisted.venueId && persisted.role && persisted.role !== 'owner') { try { const override = await repositories.pool.query('SELECT permission_scopes AS "permissionScopes" FROM system_role_permission_overrides WHERE venue_id=$1 AND role=$2 LIMIT 1', [persisted.venueId, persisted.role]); rolePermissionOverrideActive = Boolean(override.rows[0]); rolePermissionScopes = normalizePermissionScopes(override.rows[0]?.permissionScopes || []); } catch (_) {} } return { user: { id: persisted.userId, organizationId: persisted.organizationId || null, venueId: persisted.venueId || null, name: persisted.name, role: persisted.role, customRoleId: persisted.customRoleId || null, customRolePermissionScopes: normalizePermissionScopes(persisted.customRolePermissionScopes), rolePermissionScopes, rolePermissionOverrideActive, avatarUrl: persisted.avatarUrl || null, telegram: persisted.telegram || '', phoneNumbers: persisted.phoneNumbers || [], permissionScopes: normalizePermissionScopes(persisted.permissionScopes), preferences: persisted.preferences || {}, pinConfigured: Boolean(persisted.pinUpdatedAt) }, createdAt: persisted.createdAt, expiresAt: persisted.expiresAt, trustedDevice: isTrustedSession(persisted) }; }
      } catch (_) { return null; }
    }
    const memorySession = sessions.get(token);
    if (memorySession) {
      if (Date.now() > Number(memorySession.expiresAt || memorySession.createdAt + SESSION_TTL_MS)) { sessions.delete(token); return null; }
      return memorySession.user?.role === 'platform_owner' ? memorySession : null;
    }
    return null;
  }
  const memorySession = sessions.get(token);
  if (memorySession) { if (Date.now() > Number(memorySession.expiresAt || memorySession.createdAt + SESSION_TTL_MS)) { sessions.delete(token); return null; } return memorySession; }
  return null;
};
const recordAudit = (req, action, entityType, entityId, beforeData, afterData) => {
  const event = sanitizeAuditEvent({ id: `audit-${Date.now()}-${auditEvents.length}`, venueId: req.user?.venueId || defaultVenueDbId, action, entityType, entityId: entityId || null, actor: req.user?.name || 'demo', beforeData: beforeData || null, afterData: afterData || null, createdAt: new Date().toISOString() });
  auditEvents.push(event);
  if (repositories?.audit) return repositories.audit.record({ venueId: req.user?.venueId || defaultVenueDbId, actorId: /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null, action, entityType, entityId: /^[0-9a-f-]{36}$/i.test(entityId || '') ? entityId : null, beforeData, afterData }).catch(() => {});
};
const inventoryUnitFactors = { г: { г: 1, кг: 0.001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: 0.001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };
const normalizePurchaseInput = (input) => {
  const supplierName = String(input.supplierName || 'Не указан').trim();
  const documentNumber = String(input.documentNumber || '').trim() || null;
  const rawDocumentDate = input.documentDate === undefined || input.documentDate === null ? '' : String(input.documentDate).trim();
  const documentDate = rawDocumentDate || null;
  const note = String(input.note || '').trim() || null;
  const parsedDocumentDate = documentDate ? new Date(`${documentDate}T00:00:00.000Z`) : null;
  const validDocumentDate = !documentDate || (/^\d{4}-\d{2}-\d{2}$/.test(documentDate) && !Number.isNaN(parsedDocumentDate.getTime()) && parsedDocumentDate.toISOString().slice(0, 10) === documentDate);
  if (!supplierName || supplierName.length > 160 || (documentNumber && documentNumber.length > 80) || !validDocumentDate || (note && note.length > 2000)) { const error = new Error('invalid_purchase_document'); throw error; }
  if (input.sourceAutoOrderId !== undefined && input.sourceAutoOrderId !== null && input.sourceAutoOrderId !== '' && !/^[0-9a-f-]{36}$/i.test(String(input.sourceAutoOrderId))) { const error = new Error('invalid_source_auto_order'); throw error; }
  if (input.lines !== undefined && !Array.isArray(input.lines)) { const error = new Error('invalid_purchase_lines'); throw error; }
  const lines = (input.lines || []).map((entry) => {
    const ingredientId = String(entry.ingredientId || '').trim();
    const quantity = Number(entry.quantity); const unitCost = Number(entry.unitCost);
    const unit = String(entry.unit || '').trim();
    if (!ingredientId || !/^[0-9a-f-]{36}$/i.test(ingredientId) || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0 || (!inventoryUnitFactors[unit] && unit.length > 30)) { const error = new Error('invalid_purchase_line'); error.ingredientId = ingredientId; throw error; }
    return { ingredientId, quantity, unit, unitCost };
  });
  return { supplierName, documentNumber, documentDate, note, sourceAutoOrderId: input.sourceAutoOrderId || null, lines };
};
const validImageData = (value) => /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(value || '')) && String(value).length <= 700_000;
const hasPermission = (req, permission) => process.env.AUTH_REQUIRED !== 'true' || Boolean(req.user && effectivePermissions(req.user).includes(permission));
const isOperationalEmployee = (req) => ['bartender','hookah_master','senior_bartender','senior_hookah_master','cleaner','security','technician','other_staff'].includes(String(req.user?.role || '').toLowerCase());
const canAssignStaffRole = (req, role) => process.env.AUTH_REQUIRED !== 'true' || req.user?.role === 'owner';
const canCreateStaffRole = (req, role) => process.env.AUTH_REQUIRED !== 'true' || req.user?.role === 'owner' || (req.user?.role === 'admin' && ['senior_bartender','senior_hookah_master','bartender','hookah_master','cleaner','security','technician','other_staff'].includes(role));
const canManageStaffTarget = (req, targetRole) => process.env.AUTH_REQUIRED !== 'true' || req.user?.role === 'owner' || (req.user?.role === 'admin' && !['owner','admin','developer'].includes(targetRole)) || (req.user?.role === 'manager' && !['owner','admin','developer'].includes(targetRole));
const canManageVenueIdentity = (req) => process.env.AUTH_REQUIRED !== 'true' || ['owner', 'admin', 'developer'].includes(req.user?.role);
const requestOrganizationId = (req) => String(req.user?.organizationId || '').trim();
const runFloorMutation = async (req, res, expectedVenueId, selectedVenueId, operation) => {
  if (!expectedVenueId) return json(res, 428, { error: 'venue_precondition_required' });
  if (String(expectedVenueId) !== String(selectedVenueId)) return json(res, 409, { error: 'venue_context_changed' });
  let client;
  try {
    if (repositories?.pool) {
      const organizationId = requestOrganizationId(req) || null;
      if (process.env.AUTH_REQUIRED === 'true' && !organizationId) return json(res, 403, { error: 'organization_context_required' });
      client = await repositories.pool.connect();
      await client.query('BEGIN');
      const selected = await client.query('SELECT id FROM venues WHERE id=$1 AND ($2::uuid IS NULL OR organization_id=$2::uuid) AND is_active=true FOR UPDATE', [selectedVenueId, organizationId]);
      if (!selected.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'venue_not_found' }); }
      const token = requestAuthToken(req);
      if (token) {
        const active = await client.query('SELECT COALESCE(s.active_venue_id,u.venue_id) AS venue_id FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true AND ($2::uuid IS NULL OR u.organization_id=$2::uuid) FOR UPDATE OF s', [hashToken(token), organizationId]);
        if (!active.rows[0]) { await client.query('ROLLBACK'); return json(res, 401, { error: 'session_required' }); }
        if (String(active.rows[0].venue_id) !== String(expectedVenueId)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'venue_context_changed' }); }
      } else if (process.env.AUTH_REQUIRED === 'true') { await client.query('ROLLBACK'); return json(res, 401, { error: 'session_required' }); }
    }
    const result = await operation(client);
    if (client) await client.query(result.status >= 400 ? 'ROLLBACK' : 'COMMIT');
    if (result.audit && result.status < 400) recordAudit(req, result.audit.action, result.audit.entityType, result.audit.entityId, result.audit.before, result.audit.after);
    return json(res, result.status, result.body);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23503' || error.code === '23505') return json(res, 409, { error: 'floor_reference_conflict' });
    return json(res, 503, { error: 'floor_save_failed' });
  } finally { client?.release(); }
};
const requireOrganizationContext = (req, res) => {
  if (process.env.AUTH_REQUIRED === 'true' && repositories?.pool && !/^[0-9a-f-]{36}$/i.test(requestOrganizationId(req))) {
    json(res, 403, { error: 'organization_context_required' });
    return true;
  }
  return false;
};
const loadOrganizationEntitlements = async (client, organizationId, { lock = false } = {}) => {
  const suffix = lock ? ' FOR UPDATE OF o' : '';
  const { rows } = await client.query(`SELECT o.id,o.is_active AS "organizationActive",s.status AS "subscriptionStatus",s.seats_limit AS "seatsLimit",s.venues_limit AS "venuesLimit"
    FROM organizations o LEFT JOIN organization_subscriptions s ON s.organization_id=o.id WHERE o.id=$1${suffix}`, [organizationId]);
  return rows[0] || null;
};
const enforceOrganizationAccess = async (user) => {
  if (!repositories?.pool || !user?.organizationId || user.role === 'platform_owner') return null;
  try {
    const { rows } = await repositories.pool.query(`SELECT o.is_active AS active,s.status AS "subscriptionStatus",m.status AS "membershipStatus"
      FROM organizations o LEFT JOIN organization_subscriptions s ON s.organization_id=o.id
      LEFT JOIN organization_memberships m ON m.organization_id=o.id AND m.user_id=$2
      WHERE o.id=$1`, [user.organizationId, user.id]);
    const state = rows[0];
    if (!state || state.active !== true || !['trialing','active','past_due'].includes(state.subscriptionStatus) || !['active','invited','suspended'].includes(state.membershipStatus)) return { status: 403, error: 'organization_suspended' };
    if (state.membershipStatus !== 'active') return { status: 403, error: 'organization_membership_inactive' };
    return null;
  } catch (_) { return { status: 503, error: 'organization_access_unavailable' }; }
};
const checkOrganizationQuota = async (client, organizationId, kind) => {
  const entitlement = await loadOrganizationEntitlements(client, organizationId, { lock: true });
  if (!entitlement || entitlement.organizationActive !== true || !entitlement.subscriptionStatus) return { error: 'organization_unavailable', status: 403 };
  if (entitlement.subscriptionStatus === 'cancelled') return { error: 'organization_suspended', status: 403 };
  const isSeat = kind === 'seat';
  const limit = Number(isSeat ? entitlement.seatsLimit : entitlement.venuesLimit);
  if (!Number.isInteger(limit) || limit < 1) return { error: 'organization_limits_unavailable', status: 503 };
  const table = isSeat ? 'users' : 'venues';
  const { rows } = await client.query(isSeat
    ? 'SELECT COUNT(*)::int AS used FROM users WHERE organization_id=$1 AND is_active=true AND deleted_at IS NULL'
    : 'SELECT COUNT(*)::int AS used FROM venues WHERE organization_id=$1 AND is_active=true', [organizationId]);
  const used = Number(rows[0]?.used || 0);
  if (used >= limit) return { error: isSeat ? 'seat_limit_reached' : 'venue_limit_reached', status: 409, limit, used };
  return { entitlement, limit, used };
};
const canSeeSensitiveStaff = (req) => Boolean(req.user && effectivePermissions(req.user).includes('staff_sensitive'));
const canSeeStaffPhoto = (req) => Boolean(req.user && ['owner', 'admin', 'manager'].includes(req.user.role));
const validBirthDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const denyUnless = (req, res, permission) => { if (hasPermission(req, permission)) return false; json(res, 403, { error: 'forbidden', permission }); return true; };
const denyUnlessAny = (req, res, permissions) => { if (permissions.some((permission) => hasPermission(req, permission))) return false; json(res, 403, { error: 'forbidden', permission: permissions.join(' or ') }); return true; };
const notificationMemoryReads = new Map();
const notificationRoles = new Set(['owner', 'admin', 'manager', 'developer']);
const notificationVenueScope = (req, venueDbId) => {
  if (repositories?.pool) return venueDbId;
  const sessionVenueId = String(req.user?.venueId || currentVenueId);
  return sessionVenueId === 'venue-territory' ? defaultVenueDbId : sessionVenueId;
};
const notificationAccess = (req) => {
  if (process.env.AUTH_REQUIRED === 'true' && (isOperationalEmployee(req) || !notificationRoles.has(req.user?.role))) return null;
  const role = req.user?.role || '';
  const unrestricted = process.env.AUTH_REQUIRED !== 'true';
  return {
    shifts: (unrestricted || ['owner', 'admin', 'manager', 'developer'].includes(role)) && hasPermission(req, 'finance_read'),
    discounts: (unrestricted || ['owner', 'admin'].includes(role)) && hasPermission(req, 'finance_read') && hasPermission(req, 'orders'),
    autoOrders: (unrestricted || ['owner', 'admin', 'manager'].includes(role)) && hasPermission(req, 'inventory_read'),
    deletedOrders: (unrestricted || ['owner', 'admin', 'manager'].includes(role)) && hasPermission(req, 'orders'),
  };
};
async function collectNotificationEvents(req, venueId, limit = 100) {
  const access = notificationAccess(req);
  if (!access || !Object.values(access).some(Boolean)) return null;
  const items = [];
  let unreadCount = 0;
  const userId = String(req.user?.id || 'anonymous');
  if (repositories?.pool) {
    const queries = [];
    if (access.discounts) queries.push(repositories.pool.query(`SELECT 'discount:'||d.id::text AS id,'discount' AS type,'Запрошена скидка' AS title,'Запрос ожидает решения' AS summary,d.created_at AS "createdAt",d.order_id AS "orderId",r.read_at AS "readAt",count(*) FILTER (WHERE r.read_at IS NULL) OVER()::int AS "sourceUnreadCount",'/orders' AS href,true AS "requiresAction"
      FROM discounts d JOIN orders o ON o.id=d.order_id LEFT JOIN notification_reads r ON r.venue_id=o.venue_id AND r.user_id=$2 AND r.notification_key='discount:'||d.id::text
      WHERE o.venue_id=$1 AND d.status='requested' ORDER BY d.created_at DESC LIMIT $3`, [venueId, userId, limit]));
    if (access.autoOrders) queries.push(repositories.pool.query(`SELECT 'inventory_auto_order:'||a.id::text AS id,'inventory_auto_order' AS type,'Заявка на пополнение' AS title,'Заявка отправлена и ожидает обработки' AS summary,a.created_at AS "createdAt",a.id AS "autoOrderId",r.read_at AS "readAt",count(*) FILTER (WHERE r.read_at IS NULL) OVER()::int AS "sourceUnreadCount",'/inventory?view=auto-orders' AS href,false AS "requiresAction"
      FROM inventory_auto_orders a LEFT JOIN notification_reads r ON r.venue_id=a.venue_id AND r.user_id=$2 AND r.notification_key='inventory_auto_order:'||a.id::text
      WHERE a.venue_id=$1 AND a.status='sent' ORDER BY a.created_at DESC LIMIT $3`, [venueId, userId, limit]));
    if (access.deletedOrders) queries.push(repositories.pool.query(`SELECT 'order_deleted:'||e.id::text AS id,'order_deleted' AS type,'Заказ удалён' AS title,'Проверьте событие в журнале заказов' AS summary,e.created_at AS "createdAt",e.entity_id AS "orderId",r.read_at AS "readAt",count(*) FILTER (WHERE r.read_at IS NULL) OVER()::int AS "sourceUnreadCount",'/orders' AS href,false AS "requiresAction"
      FROM audit_events e LEFT JOIN notification_reads r ON r.venue_id=e.venue_id AND r.user_id=$2 AND r.notification_key='order_deleted:'||e.id::text
      WHERE e.venue_id=$1 AND e.action='order.deleted' ORDER BY e.created_at DESC LIMIT $3`, [venueId, userId, limit]));
    if (access.shifts) queries.push(repositories.pool.query(`SELECT 'shift_'||replace(e.action,'shift.','')||':'||e.entity_id::text AS id,'shift_'||replace(e.action,'shift.','') AS type,CASE WHEN e.action='shift.opened' THEN 'Смена открыта' ELSE 'Смена закрыта' END AS title,CASE WHEN e.action='shift.opened' THEN 'Проверьте состояние текущей смены' ELSE 'Смена закрыта и сохранена в журнале' END AS summary,e.created_at AS "createdAt",e.entity_id AS "shiftId",r.read_at AS "readAt",count(*) FILTER (WHERE r.read_at IS NULL) OVER()::int AS "sourceUnreadCount",'/admin#shift-control' AS href,false AS "requiresAction"
      FROM audit_events e LEFT JOIN notification_reads r ON r.venue_id=e.venue_id AND r.user_id=$2 AND r.notification_key=('shift_'||replace(e.action,'shift.','')||':'||e.entity_id::text)
      WHERE e.venue_id=$1 AND e.action IN ('shift.opened','shift.closed') ORDER BY e.created_at DESC LIMIT $3`, [venueId, userId, limit]));
    const results = await Promise.all(queries);
    for (const result of results) {
      unreadCount += Number(result.rows[0]?.sourceUnreadCount || 0);
      items.push(...result.rows.map(({ sourceUnreadCount, ...item }) => item));
    }
  } else {
    const venueMatches = (item) => String(item.venueId || '') === String(venueId);
    const recipientMatches = (item, roles) => !item.notificationRecipients?.length || !req.user?.role || (roles || item.notificationRecipients).includes(req.user.role);
    if (access.discounts) items.push(...discountRequests.filter((item) => venueMatches(item) && item.status === 'requested' && recipientMatches(item, ['owner', 'admin'])).map((item) => ({ id: `discount:${item.id}`, type: 'discount', title: 'Запрошена скидка', summary: 'Запрос ожидает решения', createdAt: item.createdAt, orderId: item.orderId, href: '/orders', requiresAction: true })));
    if (access.autoOrders) items.push(...autoOrderRequests.filter((item) => venueMatches(item) && item.status === 'sent' && recipientMatches(item, ['owner', 'admin', 'manager'])).map((item) => ({ id: `inventory_auto_order:${String(item.id).replace(/^auto-order:/, '')}`, type: 'inventory_auto_order', title: 'Заявка на пополнение', summary: 'Заявка отправлена и ожидает обработки', createdAt: item.createdAt, autoOrderId: item.id, href: '/inventory?view=auto-orders', requiresAction: false })));
    if (access.deletedOrders) items.push(...staffNotifications.filter((item) => venueMatches(item) && item.type === 'order_deleted' && recipientMatches(item, ['owner', 'admin', 'manager'])).map((item) => ({ id: `${item.type}:${item.id}`, type: item.type, title: 'Заказ удалён', summary: 'Проверьте событие в журнале заказов', createdAt: item.createdAt, ...(item.orderId ? { orderId: item.orderId } : {}), href: '/orders', requiresAction: false })));
    if (access.shifts) items.push(...auditEvents.filter((item) => venueMatches(item) && ['shift.opened', 'shift.closed'].includes(item.action)).map((item) => { const type = item.action === 'shift.opened' ? 'shift_opened' : 'shift_closed'; return { id: `${type}:${item.entityId}`, type, title: type === 'shift_opened' ? 'Смена открыта' : 'Смена закрыта', summary: type === 'shift_opened' ? 'Проверьте состояние текущей смены' : 'Смена закрыта и сохранена в журнале', createdAt: item.createdAt, shiftId: item.entityId, href: '/admin#shift-control', requiresAction: false }; }));
    items.forEach((item) => { const key = `${venueId}:${userId}:${item.id}`; item.readAt = notificationMemoryReads.get(key) || null; });
    unreadCount = items.filter((item) => !item.readAt).length;
  }
  items.sort((left, right) => Number(Boolean(right.requiresAction)) - Number(Boolean(left.requiresAction)) || new Date(right.createdAt || 0) - new Date(left.createdAt || 0) || String(right.id).localeCompare(String(left.id)));
  return { items, unreadCount };
}
const employeeNeedsShift = (req) => process.env.AUTH_REQUIRED === 'true' && ['bartender', 'hookah_master', 'senior_bartender', 'senior_hookah_master', 'staff', 'manager'].includes(req.user?.role);
const requireOpenShift = async (req, res) => {
  if (!employeeNeedsShift(req)) return false;
  try {
    if (repositories?.pool) {
      const result = await repositories.pool.query('SELECT 1 FROM shifts WHERE venue_id=$1 AND closed_at IS NULL LIMIT 1', [req.user?.venueId || defaultVenueDbId]);
      if (result.rows[0]) return false;
    } else if (shifts.some((entry) => entry.venueId === (req.user?.venueId || defaultVenueDbId) && !entry.closedAt)) return false;
  } catch (_) { json(res, 503, { error: 'shift_status_unavailable' }); return true; }
  json(res, 409, { error: 'active_shift_required', message: 'Откройте смену перед началом работы' }); return true;
};
async function getShiftCashSummary(client, venueId, shift) {
  const { rows } = await client.query(`SELECT
    $4::numeric
      + (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1 AND p.shift_id=$2 AND p.method='cash' AND p.status IN ('paid','partially_paid'))
      + (SELECT COALESCE(SUM(amount),0) FROM guest_deposit_receipts WHERE venue_id=$1 AND shift_id=$2 AND payment_method='cash')
      + (SELECT COALESCE(SUM(amount),0) FROM reservation_pre_payment_receipts WHERE venue_id=$1 AND shift_id=$2 AND payment_method='cash')
      - (SELECT COALESCE(SUM(amount),0) FROM guest_account_reversals WHERE venue_id=$1 AND shift_id=$2 AND payout_method='cash')
      - (SELECT COALESCE(SUM(amount),0) FROM reservation_pre_payment_receipt_reversals WHERE venue_id=$1 AND shift_id=$2 AND payout_method='cash')
      - (SELECT COALESCE(SUM(t.amount),0) FROM order_refund_tenders t JOIN order_refunds r ON r.venue_id=t.venue_id AND r.id=t.refund_id WHERE r.venue_id=$1 AND r.shift_id=$2 AND t.payout_method='cash')
      AS "expectedCash",
    (SELECT COUNT(*)::int FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1 AND p.shift_id IS NULL AND p.method='cash' AND p.status IN ('paid','partially_paid') AND p.created_at >= $3 AND p.created_at < statement_timestamp()) AS "unresolvedLegacyCashCount",
    (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=$1 AND p.shift_id IS NULL AND p.method='cash' AND p.status IN ('paid','partially_paid') AND p.created_at >= $3 AND p.created_at < statement_timestamp()) AS "unresolvedLegacyCashAmount",
    statement_timestamp() AS "cashPreviewAt"`, [venueId, shift.id, shift.openedAt, Number(shift.openingCash || 0)]);
  const row = rows[0] || {};
  return {
    expectedCash: Number(row.unresolvedLegacyCashCount || 0) > 0 ? null : Number(row.expectedCash || 0),
    unresolvedLegacyCashCount: Number(row.unresolvedLegacyCashCount || 0),
    unresolvedLegacyCashAmount: Number(row.unresolvedLegacyCashAmount || 0),
    cashPreviewAt: row.cashPreviewAt,
  };
}

async function captureShiftCloseLedger(client, venueId, shiftId) {
  const { rows: saleRows } = await client.query(`WITH ${orderPricingSqlCtes}, closed_sales AS (
    SELECT o.id,o.closed_at,COALESCE(o.final_total_snapshot,GREATEST(0,GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0)))) AS net
    FROM orders o LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN discount_totals d ON d.order_id=o.id
    WHERE o.venue_id=$1 AND o.status='closed' AND o.closed_in_shift_id=$2
  ) SELECT COUNT(*)::int AS count,COALESCE(SUM(net),0)::numeric::text AS net,
    COALESCE(jsonb_agg(jsonb_build_object('orderId',id::text,'closedAt',closed_at,'net',net::numeric::text) ORDER BY closed_at,id),'[]'::jsonb) AS items
    FROM closed_sales`, [venueId, shiftId]);
  const eventQuery = `SELECT source,event_id::text AS "eventId",order_id::text AS "orderId",direction,tender,amount::numeric::text AS amount,created_at AS "occurredAt"
    FROM (
      SELECT 'order_payment'::text AS source,p.id AS event_id,p.order_id,'receipt'::text AS direction,p.method AS tender,p.amount,p.created_at
        FROM payments p JOIN orders o ON o.id=p.order_id AND o.venue_id=$1
        WHERE p.shift_id=$2 AND p.status IN ('paid','partially_paid')
      UNION ALL SELECT 'guest_account_top_up',r.id,NULL,'receipt',r.payment_method,r.amount,r.created_at FROM guest_deposit_receipts r WHERE r.venue_id=$1 AND r.shift_id=$2
      UNION ALL SELECT 'reservation_pre_payment',r.id,NULL,'receipt',r.payment_method,r.amount,r.created_at FROM reservation_pre_payment_receipts r WHERE r.venue_id=$1 AND r.shift_id=$2
      UNION ALL SELECT 'guest_account_reversal',r.id,NULL,'payout',r.payout_method,r.amount,r.created_at FROM guest_account_reversals r WHERE r.venue_id=$1 AND r.shift_id=$2
      UNION ALL SELECT 'reservation_pre_payment_reversal',r.id,NULL,'payout',r.payout_method,r.amount,r.created_at FROM reservation_pre_payment_receipt_reversals r WHERE r.venue_id=$1 AND r.shift_id=$2
      UNION ALL SELECT 'pos_order_refund',t.id,t.order_id,'payout',t.payout_method,t.amount,t.created_at FROM order_refund_tenders t JOIN order_refunds r ON r.venue_id=t.venue_id AND r.id=t.refund_id WHERE r.venue_id=$1 AND r.shift_id=$2
    ) events ORDER BY "occurredAt",source,"eventId"`;
  const { rows: eventRows } = await client.query(eventQuery, [venueId, shiftId]);
  const receipts = eventRows.filter((event) => event.direction === 'receipt');
  const payouts = eventRows.filter((event) => event.direction === 'payout');
  return {
    sales: { closedOrderCount: Number(saleRows[0]?.count || 0), net: saleRows[0]?.net || '0.00', items: saleRows[0]?.items || [] },
    receipts,
    payouts,
  };
}

async function permanentlyDeleteInventoryEntry(client, venueId, entityType, entityId) {
  const targets = {
    department: { query: 'SELECT code AS id,name,false AS "subdepartmentId",false AS "departmentCode" FROM inventory_departments WHERE venue_id=$1 AND code=$2 AND is_active=false FOR UPDATE', table: 'inventory_departments', key: 'code' },
    subdepartment: { query: 'SELECT id::text AS id,name,department_code AS "departmentCode" FROM inventory_subdepartments WHERE venue_id=$1 AND id=$2::uuid AND is_active=false FOR UPDATE', table: 'inventory_subdepartments', key: 'id' },
    category: { query: 'SELECT id::text AS id,name,department,subdepartment_id::text AS "subdepartmentId" FROM product_categories WHERE venue_id=$1 AND id=$2::uuid AND is_active=false FOR UPDATE', table: 'product_categories', key: 'id' },
  };
  const target = targets[entityType];
  if (!target) return { error: 'inventory_deletion_type_invalid' };
  const current = (await client.query(target.query, [venueId, entityId])).rows[0];
  if (!current) return { error: 'inventory_archived_entry_not_found' };
  let used = false;
  if (entityType === 'department') {
    used = Boolean((await client.query(`SELECT EXISTS(SELECT 1 FROM inventory_subdepartments WHERE venue_id=$1 AND department_code=$2) OR EXISTS(SELECT 1 FROM product_categories WHERE venue_id=$1 AND department=$2) OR EXISTS(SELECT 1 FROM ingredients WHERE venue_id=$1 AND department=$2) OR EXISTS(SELECT 1 FROM products WHERE venue_id=$1 AND category IN (SELECT name FROM product_categories WHERE venue_id=$1 AND department=$2)) AS used`, [venueId, entityId])).rows[0]?.used);
  } else if (entityType === 'subdepartment') {
    used = Boolean((await client.query(`SELECT EXISTS(SELECT 1 FROM product_categories WHERE venue_id=$1 AND subdepartment_id=$2::uuid) OR EXISTS(SELECT 1 FROM ingredients WHERE venue_id=$1 AND department=$3 AND subdepartment=$4) AS used`, [venueId, entityId, current.departmentCode, current.name])).rows[0]?.used);
  } else {
    used = Boolean((await client.query(`SELECT EXISTS(SELECT 1 FROM ingredients WHERE venue_id=$1 AND department=$2 AND category=$3) OR EXISTS(SELECT 1 FROM products WHERE venue_id=$1 AND category=$3) AS used`, [venueId, current.department, current.name])).rows[0]?.used);
  }
  if (used) return { error: `inventory_${entityType}_in_use` };
  const { rows } = await client.query(`DELETE FROM ${target.table} WHERE venue_id=$1 AND ${target.key}=$2${entityType === 'subdepartment' || entityType === 'category' ? '::uuid' : ''} AND is_active=false RETURNING ${target.key} AS id,name`, [venueId, entityId]);
  return rows[0] ? { item: { ...rows[0], entityType } } : { error: 'inventory_archived_entry_not_found' };
}
function isInventoryEntryUsedInMemory(entityType, entityId, entity) {
  if (entityType === 'department') return inventorySubdepartments.some((item) => item.departmentCode === entityId) || productCategories.some((item) => item.department === entityId) || inventory.some((item) => item.department === entityId) || products.some((item) => productCategories.some((category) => category.department === entityId && category.name === item.category));
  if (entityType === 'subdepartment') return productCategories.some((item) => item.subdepartmentId === entityId) || inventory.some((item) => item.department === entity.departmentCode && item.subdepartment === entity.name);
  if (entityType === 'category') return inventory.some((item) => item.department === entity.department && item.category === entity.name) || products.some((item) => item.category === entity.name);
  return true;
}

async function api(req, res) {
  let venueDbId = defaultVenueDbId;
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (req.method === 'OPTIONS') { const headers = { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" }; if (process.env.CORS_ORIGIN) headers['Access-Control-Allow-Origin'] = process.env.CORS_ORIGIN; res.writeHead(204, headers); return res.end(); }
  const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now(); const bucket = requestBuckets.get(clientIp); const activeBucket = bucket && now - bucket.startedAt < API_RATE_WINDOW_MS ? bucket : { startedAt: now, count: 0 }; activeBucket.count += 1; requestBuckets.set(clientIp, activeBucket);
  if (activeBucket.count > API_RATE_LIMIT) { res.setHeader('Retry-After', '60'); return json(res, 429, { error: 'rate_limited', retryAfter: 60 }); }
  if (Number(req.headers['content-length'] || 0) > 2 * 1024 * 1024) return json(res, 413, { error: 'payload_too_large', maxBytes: 2 * 1024 * 1024 });
  if (pathname === '/api/setup/status' && req.method === 'GET') {
    if (!firstRunSetupEnabled) return json(res, 200, { required: false });
    if (repositories?.pool) {
      try { const { rows } = await repositories.pool.query('SELECT COUNT(*)::int AS count FROM users WHERE is_active=true AND deleted_at IS NULL'); return json(res, 200, { required: Number(rows[0]?.count || 0) === 0 }); } catch (_) { return json(res, 503, { error: 'setup_status_unavailable' }); }
    }
    // First-run provisioning must only be offered when it can be persisted.
    // A local/static test runtime without a database should remain on sign-in.
    return json(res, 200, { required: false });
  }
  if (pathname === '/api/setup/owner' && req.method === 'POST') {
    if (!firstRunSetupEnabled) return json(res, 404, { error: 'setup_disabled' });
    const input = await body(req);
    if (String(input.website || '').trim()) return json(res, 400, { error: 'bot_detected' });
    const venueName = String(input.venueName || '').trim();
    const ownerName = String(input.ownerName || '').trim();
    const ownerLogin = String(input.ownerLogin || '').trim().toLowerCase();
    const ownerPassword = String(input.ownerPassword || '');
    const city = String(input.city || '').trim();
    const timezone = input.timezone === undefined ? 'Europe/Moscow' : String(input.timezone).trim();
    if (!venueName || venueName.length > 120 || !ownerName || ownerName.length > 120 || !/^[^\s@]+@[^\s@]+$/.test(ownerLogin) || ownerPassword.length < 8 || !isValidIanaTimezone(timezone)) return json(res, 400, { error: 'valid_setup_data_required' });
    if (!repositories?.pool) return json(res, 503, { error: 'setup_requires_database' });
    {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('territory_crm_first_run_setup'))");
        const setupState = await client.query('SELECT COUNT(*)::int AS count FROM users WHERE is_active=true AND deleted_at IS NULL');
        if (Number(setupState.rows[0]?.count || 0) > 0) {
          await client.query('ROLLBACK');
          return json(res, 409, { error: 'setup_already_completed' });
        }
        const existing = await client.query('SELECT 1 FROM users WHERE login=$1 AND is_active=true LIMIT 1', [ownerLogin]);
        if (existing.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'owner_login_already_exists' }); }
        const orgResult = await client.query('INSERT INTO organizations (name,slug,plan,timezone) VALUES ($1,$2,$3,$4) RETURNING id', [venueName, `venue-${Date.now()}`, 'starter', timezone]);
        const organizationId = orgResult.rows[0].id;
        await client.query(`INSERT INTO organization_subscriptions (organization_id,plan,status,seats_limit,venues_limit) VALUES ($1,'starter','trialing',$2,$3)`, [organizationId, saasPlans.starter.seatsLimit, saasPlans.starter.venuesLimit]);
        const venueResult = await client.query('INSERT INTO venues (organization_id,name,city,format,timezone,is_current) VALUES ($1,$2,$3,$4,$5,true) RETURNING id', [organizationId, venueName, city, 'кальян-бар', timezone]);
        const passwordHash = await hashPassword(ownerPassword);
        const ownerResult = await client.query(`INSERT INTO users (venue_id,organization_id,full_name,login,password_hash,pin_hash,role) VALUES ($1,$2,$3,$4,$5,NULL,'owner') RETURNING id,full_name AS name,login,role`, [venueResult.rows[0].id, organizationId, ownerName, ownerLogin, passwordHash]);
        await client.query('INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,\'owner\',\'active\')', [organizationId, ownerResult.rows[0].id]);
        await client.query('COMMIT');
        return json(res, 201, { ok: true, owner: ownerResult.rows[0] });
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'setup_failed', detail: error.message }); }
      finally { client.release(); }
    }
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    const input = await body(req);
    if (input.resetToken && input.newPassword && !repositories?.pool) return json(res, 503, { error: 'password_reset_requires_database' });
    if (input.resetToken && input.newPassword && repositories?.pool) { const tokenHash = crypto.createHash('sha256').update(String(input.resetToken)).digest('hex'); const newPassword = String(input.newPassword); if (newPassword.length < 8) return json(res, 400, { error: 'password_too_short' }); try { const client = await repositories.pool.connect(); try { await client.query('BEGIN'); const result = await client.query('SELECT id,login,organization_id AS \"organizationId\" FROM users WHERE password_reset_token_hash=$1 AND password_reset_expires_at>now() AND is_active=true AND deleted_at IS NULL FOR UPDATE', [tokenHash]); if (!result.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'reset_token_invalid_or_expired' }); } const row = result.rows[0]; await client.query('UPDATE users SET password_hash=$1,password_reset_token_hash=NULL,password_reset_expires_at=NULL WHERE id=$2', [await hashPassword(newPassword), row.id]); await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [row.id]); await client.query('COMMIT'); recordAudit(req, 'auth.password_reset_completed', 'organization_owner', row.id, null, { organizationId: row.organizationId, login: row.login }); return json(res, 200, { ok: true, login: row.login }); } catch (error) { await client.query('ROLLBACK').catch(()=>{}); return json(res, 503, { error: 'password_reset_failed' }); } finally { client.release(); } } catch (_) { return json(res, 503, { error: 'authentication_unavailable' }); } }
    if (process.env.DATABASE_URL && (!repositories?.pool || !sessionRepository)) return json(res, 503, { error: 'authentication_unavailable' });
    if (String(input.website || '').trim()) return json(res, 400, { error: 'bot_detected' });
    const loginKey = String(input.username || '').trim().toLowerCase() || 'anonymous';
    const requestedPin = ''; // PIN используется только для разблокировки экрана, не для входа
    const attempt = loginAttempts.get(loginKey);
    if (attempt && attempt.blockedUntil > Date.now()) return json(res, 429, { error: 'too_many_login_attempts', retryAfter: Math.ceil((attempt.blockedUntil - Date.now()) / 1000) });
    let account = null;
    // The configured platform owner is an infrastructure identity, not a tenant
    // row. It must remain available when PostgreSQL is enabled; tenant users are
    // still resolved from the database below.
    const configuredPlatformOwner = demoAccounts.find((entry) => entry.role === 'platform_owner' && entry.username === loginKey && entry.password === input.password);
    if (configuredPlatformOwner) account = configuredPlatformOwner;
    if (!account && !process.env.DATABASE_URL) {
      account = [...demoAccounts, ...provisionedAccounts].find((entry) => entry.username === loginKey && ((requestedPin && entry.pin === requestedPin) || (!requestedPin && entry.password === input.password)));
      if (!account) { const person = staff.find((entry) => entry.active && entry.login === input.username); const credential = input.password; if (person && credential && await verifyPassword(credential, person.passwordHash)) account = { username: person.login, id: person.id, organizationId: person.organizationId || saasAccount.id, name: person.name, role: person.role, avatarUrl: person.avatarUrl, telegram: person.telegram, phoneNumbers: person.phoneNumbers, permissionScopes: person.permissionScopes || [], pinHash: person.pinHash || null, pinConfigured: Boolean(person.pinHash || person.pinCode) }; }
    }
    if (!account && repositories?.pool) {
      try {
        const { rows } = await repositories.pool.query('SELECT u.id,u.login,u.organization_id AS "organizationId",u.venue_id AS "venueId",u.full_name AS name,u.role,u.custom_role_id AS "customRoleId",cr.permission_scopes AS "customRolePermissionScopes",sro.permission_scopes AS "rolePermissionScopes",(sro.role IS NOT NULL) AS "rolePermissionOverrideActive",u.password_hash AS "passwordHash",u.pin_hash,u.pin_updated_at,u.preferences,u.avatar_url AS "avatarUrl",u.telegram_url AS telegram,u.phone_numbers AS "phoneNumbers",u.permission_scopes AS "permissionScopes" FROM users u LEFT JOIN custom_staff_roles cr ON cr.id=u.custom_role_id AND cr.venue_id=u.venue_id AND cr.is_active=true LEFT JOIN system_role_permission_overrides sro ON sro.venue_id=u.venue_id AND sro.role=u.role WHERE u.login=$1 AND u.is_active=true LIMIT 1', [input.username]);
        const row = rows[0]; const credential = input.password; if (row && credential && await verifyPassword(credential, row.passwordHash)) {
          if (!row.organizationId || !/^[0-9a-f-]{36}$/i.test(row.organizationId)) return json(res, 403, { error: 'organization_context_required' });
          const accessError = await enforceOrganizationAccess({ id: row.id, organizationId: row.organizationId, role: row.role });
          if (accessError) return json(res, accessError.status, { error: accessError.error });
          account = { username: row.login, id: row.id, organizationId: row.organizationId || null, venueId: row.venueId || null, name: row.name, role: row.role, customRoleId: row.customRoleId || null, customRolePermissionScopes: row.customRolePermissionScopes || [], rolePermissionScopes: row.rolePermissionScopes || [], rolePermissionOverrideActive: Boolean(row.rolePermissionOverrideActive), avatarUrl: row.avatarUrl, telegram: row.telegram || null, phoneNumbers: row.phoneNumbers || [], permissionScopes: row.permissionScopes || [], preferences: row.preferences || {}, pinHash: row.pin_updated_at ? row.pin_hash : null, pinConfigured: Boolean(row.pin_updated_at) };
        }
      } catch (_) { return json(res, 503, { error: 'authentication_unavailable' }); }
    }
    if (!account) { const current = loginAttempts.get(loginKey) || { count: 0, firstAt: Date.now() }; const withinWindow = Date.now() - current.firstAt < 60_000; const next = withinWindow ? { count: current.count + 1, firstAt: current.firstAt } : { count: 1, firstAt: Date.now() }; if (next.count >= 5) next.blockedUntil = Date.now() + 60_000; loginAttempts.set(loginKey, next); return json(res, next.blockedUntil ? 429 : 401, { error: next.blockedUntil ? 'too_many_login_attempts' : 'invalid_credentials', ...(next.blockedUntil ? { retryAfter: 60 } : {}) }); }
    loginAttempts.delete(loginKey);
    const userId = account.id || (account.username === 'owner' ? '20000000-0000-0000-0000-000000000001' : '20000000-0000-0000-0000-000000000002');
    const organizationId = account.organizationId === undefined ? '00000000-0000-0000-0000-000000000010' : account.organizationId;
    const userVenueId = account.venueId || null;
    const preferenceAccountKey = `${organizationId || 'none'}:${account.id || account.username}`;
    if (!repositories?.pool && !memoryPreferencesByAccount.has(preferenceAccountKey)) memoryPreferencesByAccount.set(preferenceAccountKey, account.preferences || {});
    const accountPreferences = repositories?.pool ? (account.preferences || {}) : memoryPreferencesByAccount.get(preferenceAccountKey);
    const token = crypto.randomBytes(32).toString('hex');
    const cookies = requestCookies(req);
    const deviceId = cookies.crm_device_id || crypto.randomUUID();
    const sameDeviceTokens = [...sessions.entries()].filter(([, session]) => session.user?.id === userId && session.deviceId === deviceId).map(([sessionToken]) => sessionToken);
    sameDeviceTokens.forEach((sessionToken) => sessions.delete(sessionToken));
    if (!sessionRepository) {
      const activeUserSessions = [...sessions.values()].filter((session) => session.user?.id === userId && Date.now() - session.createdAt <= SESSION_TTL_MS);
      if (activeUserSessions.length >= 2) return json(res, 409, { error: 'session_limit_reached', limit: 2 });
    }
    const ttlMs = input.trustDevice && canUseTrustedDevice(account.role) ? TRUSTED_SESSION_TTL_MS : STANDARD_SESSION_TTL_MS;
    const expiresAt = Date.now() + ttlMs;
    // The platform owner is an infrastructure identity and may not have a
    // tenant row for the auth_sessions foreign key. Keep that session in the
    // process memory; tenant users continue to use persisted PostgreSQL sessions.
    if (sessionRepository && account.role !== 'platform_owner') { try { const saved = await sessionRepository.create({ userId, deviceId, tokenHash: hashToken(token), expiresAt: new Date(expiresAt).toISOString(), activeVenueId: userVenueId }); if (!saved) return json(res, 409, { error: 'session_limit_reached', limit: 2 }); } catch (_) { return json(res, 503, { error: 'session_unavailable' }); } }
    if (!account.pinHash && account.pin) account.pinHash = await hashPassword(account.pin);
    sessions.set(token, { user: { id: userId, organizationId, venueId: userVenueId, name: account.name, role: account.role, customRoleId: account.customRoleId || null, customRolePermissionScopes: normalizePermissionScopes(account.customRolePermissionScopes), rolePermissionScopes: normalizePermissionScopes(account.rolePermissionScopes), rolePermissionOverrideActive: Boolean(account.rolePermissionOverrideActive), avatarUrl: account.avatarUrl || null, telegram: account.telegram || '', phoneNumbers: account.phoneNumbers || [], permissionScopes: normalizePermissionScopes(account.permissionScopes), preferences: accountPreferences, pinConfigured: Boolean(account.pinConfigured || account.pinHash) }, preferenceAccountKey, unlockHash: account.pinHash || null, deviceId, createdAt: Date.now(), expiresAt, trustedDevice: ttlMs === TRUSTED_SESSION_TTL_MS });
    [...sessions.entries()].filter(([, session]) => session.user?.id === userId).sort(([, left], [, right]) => right.createdAt - left.createdAt).slice(2).forEach(([sessionToken]) => sessions.delete(sessionToken));
    res.setHeader('Set-Cookie', [`crm_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionTtlSeconds(ttlMs)}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`, `crm_device_id=${encodeURIComponent(deviceId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`]);
    return json(res, 200, { token, user: { id: userId, organizationId, venueId: userVenueId, name: account.name, role: account.role, customRoleId: account.customRoleId || null, customRolePermissionScopes: normalizePermissionScopes(account.customRolePermissionScopes), rolePermissionScopes: normalizePermissionScopes(account.rolePermissionScopes), rolePermissionOverrideActive: Boolean(account.rolePermissionOverrideActive), avatarUrl: account.avatarUrl || null, telegram: account.telegram || '', phoneNumbers: account.phoneNumbers || [], permissionScopes: normalizePermissionScopes(account.permissionScopes), preferences: accountPreferences, pinConfigured: Boolean(account.pinConfigured || account.pinHash) }, permissions: effectivePermissions({ role: account.role, rolePermissionScopes: account.rolePermissionScopes, rolePermissionOverrideActive: account.rolePermissionOverrideActive, customRolePermissionScopes: account.customRolePermissionScopes, permissionScopes: account.permissionScopes }), expiresIn: sessionTtlSeconds(ttlMs), trustedDevice: ttlMs === TRUSTED_SESSION_TTL_MS });
  }
  if (pathname === '/api/logout' && req.method === 'POST') { const header = req.headers.authorization || ''; const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((parts) => parts.length === 2)); const token = header.startsWith('Bearer ') ? header.slice(7) : (cookies.crm_session || ''); if (token && sessionRepository) sessionRepository.remove(hashToken(token)).catch(() => {}); sessions.delete(token); res.setHeader('Set-Cookie', 'crm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
  const hasRequestCredential = Boolean((req.headers.authorization || '').startsWith('Bearer ') || String(req.headers.cookie || '').includes('crm_session='));
  if ((process.env.AUTH_REQUIRED === 'true' || hasRequestCredential) && pathname !== '/api/health' && pathname !== '/api/login' && pathname !== '/api/public/venue-brand') {
    const session = await sessionFromRequest(req);
    if (!session) return json(res, 401, { error: 'authentication_required' });
    else {
      req.user = session.user;
      const accessError = await enforceOrganizationAccess(req.user);
      if (accessError) return json(res, accessError.status, { error: accessError.error });
      if (req.user?.venueId && /^[0-9a-f-]{36}$/i.test(req.user.venueId)) venueDbId = req.user.venueId;
      // Refresh cookies issued before the longer session policy so an active
      // browser is not logged out simply because its old cookie reached 8 hours.
      const cookieToken = requestCookies(req).crm_session;
    }
  }
  const requestVenueId = req.user?.venueId || currentVenueId;
  if (await handlePayrollSchemeRoute({ req, res, url, service: payrollSchemeService, readBody: body, json })) return;
  if (pathname === '/api/health') {
    if (repositories?.pool) {
      try {
        await repositories.pool.query('SELECT 1');
        return json(res, 200, { status: 'ok', service: 'hookah-pos', database: 'postgres' });
      } catch (error) {
        return json(res, 503, { status: 'degraded', service: 'hookah-pos', database: 'unavailable' });
      }
    }
    return json(res, 200, { status: 'ok', service: 'hookah-pos', database: 'memory' });
  }
  if (pathname === '/api/session/unlock' && req.method === 'POST') {
    const input = await body(req); const pin = String(input.pin || '').trim();
    if (!/^\d{4}$/.test(pin)) return json(res, 400, { error: 'invalid_staff_pin_format' });
    const header = req.headers.authorization || ''; const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((parts) => parts.length === 2)); const token = header.startsWith('Bearer ') ? header.slice(7) : (cookies.crm_session || '');
    const identity = String(req.user?.id || ''); const address = String(req.socket?.remoteAddress || 'unknown'); const attemptKey = `${identity}:${address}`;
    const attempt = pinUnlockAttempts.get(attemptKey);
    if (attempt?.blockedUntil > Date.now()) return json(res, 429, { error: 'too_many_pin_attempts', retryAfter: Math.ceil((attempt.blockedUntil - Date.now()) / 1000) });
    const memorySession = sessions.get(token); let unlockHash = memorySession?.unlockHash || null; let pinConfigured = Boolean(memorySession?.user?.pinConfigured);
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(identity)) {
      try {
        const { rows } = await repositories.pool.query('SELECT pin_hash AS "pinHash",pin_updated_at AS "pinUpdatedAt",is_active AS active FROM users WHERE id=$1 AND venue_id=$2 AND deleted_at IS NULL LIMIT 1', [identity, memorySession?.user?.venueId || venueDbId]);
        unlockHash = rows[0]?.active && rows[0]?.pinUpdatedAt ? rows[0].pinHash : null;
        pinConfigured = Boolean(unlockHash);
      } catch (error) { return json(res, 503, { error: 'unlock_unavailable', detail: error.message }); }
    }
    if (!pinConfigured || !unlockHash) return json(res, 409, { error: 'pin_not_configured' });
    if (!(await verifyPassword(pin, unlockHash))) {
      const withinWindow = attempt && Date.now() - attempt.firstAt < 60_000;
      const next = withinWindow ? { count: attempt.count + 1, firstAt: attempt.firstAt } : { count: 1, firstAt: Date.now() };
      if (next.count >= 5) next.blockedUntil = Date.now() + 60_000;
      pinUnlockAttempts.set(attemptKey, next);
      return json(res, next.blockedUntil ? 429 : 401, { error: next.blockedUntil ? 'too_many_pin_attempts' : 'invalid_pin', ...(next.blockedUntil ? { retryAfter: 60 } : {}) });
    }
    pinUnlockAttempts.delete(attemptKey);
    if (memorySession) { memorySession.unlockHash = unlockHash; memorySession.user.pinConfigured = true; }
    return json(res, 200, { ok: true, token, user: req.user || memorySession?.user || null });
  }
  if (pathname === '/api/session/pin-return' && req.method === 'POST') {
    const trustedPinRoles = new Set(['owner', 'admin', 'developer']);
    if (!trustedPinRoles.has(String(req.user?.role || ''))) return json(res, 403, { error: 'pin_return_role_forbidden' });
    const input = await body(req); const pin = String(input.pin || '').trim();
    if (!/^\d{4}$/.test(pin)) return json(res, 400, { error: 'invalid_staff_pin_format' });
    const token = requestAuthToken(req);
    if (!token) return json(res, 401, { error: 'authentication_required' });
    const trustedSession = await sessionFromRequest(req);
    if (!isTrustedSession(trustedSession)) return json(res, 403, { error: 'pin_return_requires_trusted_device' });
    const identity = String(req.user?.id || ''); const address = String(req.socket?.remoteAddress || 'unknown'); const attemptKey = `${identity}:${address}:return`;
    const attempt = pinUnlockAttempts.get(attemptKey);
    if (attempt?.blockedUntil > Date.now()) return json(res, 429, { error: 'too_many_pin_attempts', retryAfter: Math.ceil((attempt.blockedUntil - Date.now()) / 1000) });
    const memorySession = sessions.get(token); let unlockHash = memorySession?.unlockHash || null; let pinConfigured = Boolean(memorySession?.user?.pinConfigured);
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(identity)) {
      try {
        const { rows } = await repositories.pool.query('SELECT pin_hash AS "pinHash",pin_updated_at AS "pinUpdatedAt",is_active AS active FROM users WHERE id=$1 AND organization_id IS NOT DISTINCT FROM $2::uuid LIMIT 1', [identity, req.user?.organizationId || null]);
        unlockHash = rows[0]?.active && rows[0]?.pinUpdatedAt ? rows[0].pinHash : null;
        pinConfigured = Boolean(unlockHash);
      } catch (error) { return json(res, 503, { error: 'pin_return_unavailable', detail: error.message }); }
    }
    if (!pinConfigured || !unlockHash) return json(res, 409, { error: 'pin_not_configured' });
    if (!(await verifyPassword(pin, unlockHash))) {
      const withinWindow = attempt && Date.now() - attempt.firstAt < 60_000;
      const next = withinWindow ? { count: attempt.count + 1, firstAt: attempt.firstAt } : { count: 1, firstAt: Date.now() };
      if (next.count >= 5) next.blockedUntil = Date.now() + 60_000;
      pinUnlockAttempts.set(attemptKey, next);
      return json(res, next.blockedUntil ? 429 : 401, { error: next.blockedUntil ? 'too_many_pin_attempts' : 'invalid_pin', ...(next.blockedUntil ? { retryAfter: 60 } : {}) });
    }
    pinUnlockAttempts.delete(attemptKey);
    if (memorySession) { memorySession.unlockHash = unlockHash; memorySession.user.pinConfigured = true; }
    if (req.user) req.user.pinConfigured = true;
    const user = memorySession?.user || req.user;
    return json(res, 200, { token, user, permissions: effectivePermissions(user), expiresIn: sessionTtlSeconds(TRUSTED_SESSION_TTL_MS), trustedDevice: true });
  }
  if (pathname === '/api/session/preferences' && (req.method === 'GET' || req.method === 'PATCH')) {
    const allowed = new Set(['lockTimeoutMinutes', 'dashboardModules', 'dashboardRevenueStyle', 'insights', 'deliveryEnabled', 'integrationsEnabled', 'navigationVisibility', 'financeMetrics', 'theme', 'staffDirectory']);
    const header = req.headers.authorization || ''; const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((parts) => parts.length === 2)); const token = header.startsWith('Bearer ') ? header.slice(7) : (cookies.crm_session || '');
    const memorySession = sessions.get(token);
    if (req.method === 'GET') {
      if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(req.user?.id || '')) {
        try {
          const { rows } = await repositories.pool.query('SELECT preferences FROM users WHERE id=$1 AND organization_id IS NOT DISTINCT FROM $2::uuid AND is_active=true LIMIT 1', [req.user.id, req.user.organizationId || null]);
          if (!rows[0]) return json(res, 404, { error: 'user_not_found' });
          if (memorySession) memorySession.user.preferences = rows[0].preferences || {};
          return json(res, 200, { preferences: rows[0].preferences || {} });
        } catch (_) { return json(res, 503, { error: 'preferences_load_failed' }); }
      }
      return json(res, 200, { preferences: memoryPreferencesByAccount.get(memorySession?.preferenceAccountKey) || memorySession?.user?.preferences || {} });
    }
    const input = await body(req); const incoming = input && typeof input.preferences === 'object' && !Array.isArray(input.preferences) ? input.preferences : input;
    if (!incoming || typeof incoming !== 'object') return json(res, 400, { error: 'preferences_object_required' });
    const patch = {}; for (const [key, value] of Object.entries(incoming)) if (allowed.has(key)) patch[key] = value;
    if (Object.prototype.hasOwnProperty.call(patch, 'lockTimeoutMinutes') && ![0, 1, 5, 10, 15, 30].includes(Number(patch.lockTimeoutMinutes))) return json(res, 400, { error: 'invalid_lock_timeout' });
    if (Object.prototype.hasOwnProperty.call(patch, 'dashboardRevenueStyle') && !['hero', 'split', 'minimal'].includes(String(patch.dashboardRevenueStyle))) return json(res, 400, { error: 'invalid_dashboard_revenue_style' });
    if (Object.prototype.hasOwnProperty.call(patch, 'theme') && !['light', 'dark'].includes(patch.theme)) return json(res, 400, { error: 'invalid_theme_preference' });
    if (Object.prototype.hasOwnProperty.call(patch, 'navigationVisibility') && (!patch.navigationVisibility || typeof patch.navigationVisibility !== 'object' || Array.isArray(patch.navigationVisibility) || Object.entries(patch.navigationVisibility).some(([key, value]) => !['orders','clients','reservations','floor','delivery','inventory','finance','discounts','loyalty','staff','integrations'].includes(key) || typeof value !== 'boolean'))) return json(res, 400, { error: 'invalid_navigation_visibility' });
    for (const key of ['deliveryEnabled', 'integrationsEnabled']) if (Object.prototype.hasOwnProperty.call(patch, key) && typeof patch[key] !== 'boolean') return json(res, 400, { error: `invalid_${key}` });
    for (const key of ['dashboardModules', 'insights', 'financeMetrics']) if (Object.prototype.hasOwnProperty.call(patch, key) && (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key]))) return json(res, 400, { error: `invalid_${key}_preferences` });
    if (Object.prototype.hasOwnProperty.call(patch, 'staffDirectory') && (!patch.staffDirectory || typeof patch.staffDirectory !== 'object' || Array.isArray(patch.staffDirectory) || Object.entries(patch.staffDirectory).some(([key, value]) => (key === 'view' && !['cards', 'list', 'table'].includes(value)) || (key === 'cardScale' && (!Number.isInteger(value) || value < 1 || value > 4)) || !['view', 'cardScale'].includes(key)))) return json(res, 400, { error: 'invalid_staff_directory_preferences' });
    const nestedKeys = ['dashboardModules', 'insights', 'financeMetrics', 'navigationVisibility', 'staffDirectory'];
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(req.user?.id || '')) {
      try {
        let merged = "COALESCE(preferences,'{}'::jsonb) || $1::jsonb";
        for (const key of nestedKeys) if (Object.prototype.hasOwnProperty.call(patch, key)) merged = `jsonb_set(${merged}, '{${key}}', COALESCE(preferences->'${key}','{}'::jsonb) || ($1::jsonb->'${key}'), true)`;
        const { rows } = await repositories.pool.query(`UPDATE users SET preferences=${merged} WHERE id=$2 AND organization_id IS NOT DISTINCT FROM $3::uuid AND is_active=true RETURNING preferences`, [JSON.stringify(patch), req.user.id, req.user.organizationId || null]);
        if (!rows[0]) return json(res, 404, { error: 'user_not_found' });
        const preferences = rows[0].preferences || {};
        for (const session of sessions.values()) if (session.user?.id === req.user.id && session.user?.organizationId === req.user.organizationId) session.user.preferences = preferences;
        return json(res, 200, { preferences });
      } catch (error) { return json(res, 503, { error: 'preferences_save_failed', detail: error.message }); }
    }
    const current = memoryPreferencesByAccount.get(memorySession?.preferenceAccountKey) || memorySession?.user?.preferences || {};
    const next = { ...current, ...patch };
    for (const key of nestedKeys) if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = { ...((current[key] && typeof current[key] === 'object' && !Array.isArray(current[key])) ? current[key] : {}), ...patch[key] };
    if (memorySession?.preferenceAccountKey) {
      memoryPreferencesByAccount.set(memorySession.preferenceAccountKey, next);
      for (const session of sessions.values()) if (session.preferenceAccountKey === memorySession.preferenceAccountKey) session.user.preferences = next;
    }
    return json(res, 200, { preferences: next });
  }
  if (pathname === '/api/public/venue-brand' && req.method === 'GET') {
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query('SELECT name,logo_url AS "logoUrl" FROM venues WHERE id=$1', [venueDbId]); if (rows[0]) return json(res, 200, rows[0]); } catch (_) {} }
    return json(res, 200, { name: venue.name, logoUrl: venue.logoUrl || null });
  }
  const notificationReadPath = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (pathname === '/api/notifications' && ['GET', 'POST'].includes(req.method) || notificationReadPath && req.method === 'PUT') {
    const access = notificationAccess(req);
    if (!access || !Object.values(access).some(Boolean)) return json(res, 403, { error: 'forbidden', permission: 'notifications' });
    if (repositories?.pool && !/^[0-9a-f-]{36}$/i.test(String(req.user?.id || ''))) return json(res, 401, { error: 'authentication_required' });
    if (req.method === 'GET') {
      const limitValue = Number(url.searchParams.get('limit') || 20);
      const limit = Number.isInteger(limitValue) ? Math.min(50, Math.max(1, limitValue)) : 20;
      const unreadOnly = url.searchParams.get('filter') === 'unread';
      try {
    const notificationVenueId = notificationVenueScope(req, venueDbId);
    const data = await collectNotificationEvents(req, notificationVenueId, 100);
        if (!data) return json(res, 403, { error: 'forbidden', permission: 'notifications' });
        const items = data.items.filter((item) => !unreadOnly || !item.readAt).slice(0, limit);
        return json(res, 200, { items, unreadCount: data.unreadCount, hasMore: data.items.filter((item) => !unreadOnly || !item.readAt).length > limit });
      } catch (_) { return json(res, 503, { error: 'notifications_unavailable' }); }
    }
    if (req.method === 'POST') {
      try {
        if (repositories?.pool) {
          const userId = req.user.id;
          const inserts = [];
          if (access.discounts) inserts.push(repositories.pool.query(`INSERT INTO notification_reads (venue_id,user_id,notification_key)
            SELECT o.venue_id,$2,'discount:'||d.id::text FROM discounts d JOIN orders o ON o.id=d.order_id WHERE o.venue_id=$1 AND d.status='requested'
            ON CONFLICT (venue_id,user_id,notification_key) DO UPDATE SET read_at=now()`, [venueDbId, userId]));
          if (access.autoOrders) inserts.push(repositories.pool.query(`INSERT INTO notification_reads (venue_id,user_id,notification_key)
            SELECT a.venue_id,$2,'inventory_auto_order:'||a.id::text FROM inventory_auto_orders a WHERE a.venue_id=$1 AND a.status='sent'
            ON CONFLICT (venue_id,user_id,notification_key) DO UPDATE SET read_at=now()`, [venueDbId, userId]));
          if (access.deletedOrders) inserts.push(repositories.pool.query(`INSERT INTO notification_reads (venue_id,user_id,notification_key)
            SELECT e.venue_id,$2,'order_deleted:'||e.id::text FROM audit_events e WHERE e.venue_id=$1 AND e.action='order.deleted'
            ON CONFLICT (venue_id,user_id,notification_key) DO UPDATE SET read_at=now()`, [venueDbId, userId]));
          if (access.shifts) inserts.push(repositories.pool.query(`INSERT INTO notification_reads (venue_id,user_id,notification_key)
            SELECT e.venue_id,$2,'shift_'||replace(e.action,'shift.','')||':'||e.entity_id::text FROM audit_events e WHERE e.venue_id=$1 AND e.action IN ('shift.opened','shift.closed')
            ON CONFLICT (venue_id,user_id,notification_key) DO UPDATE SET read_at=now()`, [venueDbId, userId]));
          if (access.staffPins) inserts.push(repositories.pool.query(`INSERT INTO notification_reads (venue_id,user_id,notification_key)
            SELECT e.venue_id,$2,'staff_pin_updated:'||e.id::text FROM audit_events e WHERE e.venue_id=$1 AND e.action='staff.pin_updated'
            ON CONFLICT (venue_id,user_id,notification_key) DO UPDATE SET read_at=now()`, [venueDbId, userId]));
          await Promise.all(inserts);
          const data = await collectNotificationEvents(req, notificationVenueScope(req, venueDbId), 100);
          return json(res, 200, { unreadCount: data?.unreadCount || 0 });
        }
        const notificationVenueId = notificationVenueScope(req, venueDbId);
        const data = await collectNotificationEvents(req, notificationVenueId, 10000);
        if (!data) return json(res, 403, { error: 'forbidden', permission: 'notifications' });
        for (const item of data.items) notificationMemoryReads.set(`${notificationVenueId}:${req.user?.id || 'anonymous'}:${item.id}`, new Date().toISOString());
        const refreshed = await collectNotificationEvents(req, notificationVenueId, 10000);
        return json(res, 200, { unreadCount: refreshed?.unreadCount || 0 });
      } catch (_) { return json(res, 503, { error: 'notifications_unavailable' }); }
    }
    let notificationId;
    try { notificationId = decodeURIComponent(notificationReadPath[1]); } catch (_) { return json(res, 400, { error: 'invalid_notification_id' }); }
    if (!/^(discount|inventory_auto_order|order_deleted|shift_opened|shift_closed):[A-Za-z0-9-]{1,150}$/.test(notificationId)) return json(res, 404, { error: 'notification_not_found' });
    const type = notificationId.slice(0, notificationId.indexOf(':'));
    if ((type === 'discount' && !access.discounts) || (type === 'inventory_auto_order' && !access.autoOrders) || (type === 'order_deleted' && !access.deletedOrders) || (type.startsWith('shift_') && !access.shifts)) return json(res, 404, { error: 'notification_not_found' });
    try {
      if (repositories?.pool) {
        const notificationVenueId = notificationVenueScope(req, venueDbId);
        const available = await collectNotificationEvents(req, notificationVenueId, 10000);
        if (!available?.items.some((item) => item.id === notificationId)) return json(res, 404, { error: 'notification_not_found' });
        await repositories.pool.query(`INSERT INTO notification_reads (venue_id,user_id,notification_key) VALUES ($1,$2,$3)
          ON CONFLICT (venue_id,user_id,notification_key) DO UPDATE SET read_at=now()`, [venueDbId, req.user.id, notificationId]);
      } else {
        const notificationVenueId = notificationVenueScope(req, venueDbId);
        const available = await collectNotificationEvents(req, notificationVenueId, 10000);
        if (!available?.items.some((item) => item.id === notificationId)) return json(res, 404, { error: 'notification_not_found' });
        notificationMemoryReads.set(`${notificationVenueId}:${req.user?.id || 'anonymous'}:${notificationId}`, new Date().toISOString());
      }
      const refreshed = await collectNotificationEvents(req, notificationVenueScope(req, venueDbId), 10000);
      return json(res, 200, { id: notificationId, readAt: new Date().toISOString(), unreadCount: refreshed?.unreadCount || 0 });
    } catch (_) { return json(res, 503, { error: 'notifications_unavailable' }); }
  }
  if (pathname === '/api/saas/account' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['settings', 'diagnostics'])) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(venueDbId)) {
      try {
        const { rows } = await repositories.pool.query(`SELECT o.id,o.name,o.slug,o.plan,o.timezone,
          COALESCE(s.status,'trialing') AS "subscriptionStatus",COALESCE(s.plan,o.plan) AS "subscriptionPlan",
          COALESCE(s.seats_limit,5) AS "seatsLimit",COALESCE(s.venues_limit,1) AS "venuesLimit",
          (SELECT COUNT(*)::int FROM users u WHERE u.organization_id=o.id AND u.is_active=true) AS "activeSeats",
          (SELECT COUNT(*)::int FROM venues v2 WHERE v2.organization_id=o.id AND v2.is_active=true) AS "activeVenues"
          FROM organizations o
          LEFT JOIN organization_subscriptions s ON s.organization_id=o.id WHERE o.id=$1 LIMIT 1`, [req.user?.organizationId || saasAccount.id]);
        if (rows[0]) return json(res, 200, { ...rows[0], seatsLimit: Number(rows[0].seatsLimit), venuesLimit: Number(rows[0].venuesLimit), activeSeats: Number(rows[0].activeSeats), activeVenues: Number(rows[0].activeVenues) });
      } catch (_) { return json(res, 503, { error: 'saas_account_unavailable' }); }
      return json(res, 404, { error: 'organization_not_found' });
    }
    const account = saasOrganizations.find((item) => item.id === req.user?.organizationId) || saasAccount;
    return json(res, 200, { ...account, subscriptionStatus: account.status || account.subscriptionStatus || 'trialing', subscriptionPlan: account.plan, activeSeats: Number(account.seats ?? staff.filter((person) => person.active).length), activeVenues: Number(account.venues ?? networkVenues.filter((item) => item.status !== 'archived').length) });
  }
  if (pathname === '/api/platform/plans' && req.method === 'GET') {
    if (denyUnless(req, res, 'platform')) return;
    return json(res, 200, { billingMode: 'test_free', currency: 'RUB', plans: saasPlans });
  }
  if (pathname === '/api/platform/overview' && req.method === 'GET') {
    if (denyUnless(req, res, 'platform')) return;
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query(`SELECT COUNT(*)::int AS companies, COUNT(*) FILTER (WHERE is_active=true)::int AS active_companies FROM organizations`); const subs = await repositories.pool.query(`SELECT COUNT(*)::int AS trials FROM organization_subscriptions WHERE status='trialing'`); return json(res, 200, { companies: Number(rows[0]?.companies || 0), activeCompanies: Number(rows[0]?.active_companies || 0), trials: Number(subs.rows[0]?.trials || 0) }); } catch (_) { return json(res, 503, { error: 'platform_overview_unavailable' }); } }
    return json(res, 200, { companies: saasOrganizations.length, activeCompanies: saasOrganizations.filter((item) => item.isActive).length, trials: saasOrganizations.filter((item) => item.status === 'trialing').length });
  }
  if (pathname === '/api/platform/organizations' && req.method === 'GET') {
    if (denyUnless(req, res, 'platform')) return;
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query(`SELECT o.id,o.name,o.slug,o.plan,o.is_active AS "isActive",o.created_at AS "createdAt",o.timezone,COALESCE(s.status,'trialing') AS status,(SELECT COUNT(*)::int FROM venues v WHERE v.organization_id=o.id AND v.is_active=true) AS venues,(SELECT COUNT(*)::int FROM users u WHERE u.organization_id=o.id AND u.is_active=true) AS seats,(SELECT city FROM venues v2 WHERE v2.organization_id=o.id ORDER BY v2.created_at LIMIT 1) AS city,(SELECT json_agg(json_build_object('id',u.id,'name',u.full_name,'login',u.login,'active',u.is_active,'isPrimary',m.is_primary) ORDER BY u.full_name) FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=o.id WHERE u.organization_id=o.id AND m.membership_role='owner' AND u.deleted_at IS NULL) AS owners FROM organizations o LEFT JOIN organization_subscriptions s ON s.organization_id=o.id ORDER BY o.created_at DESC`); return json(res, 200, { items: rows }); } catch (_) { return json(res, 503, { error: 'platform_organizations_unavailable' }); } }
    return json(res, 200, { items: saasOrganizations.slice().reverse().map((item) => ({ ...item, ...(saasPlans[item.plan] || saasPlans.starter), monthlyPrice: 0 })) });
  }
  if (pathname === '/api/platform/organizations' && req.method === 'POST') {
    if (denyUnless(req, res, 'platform')) return;
    const input = await body(req);
    const name = String(input.name || '').trim();
    const transliteration = { а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'e', ж:'zh', з:'z', и:'i', й:'y', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f', х:'h', ц:'c', ч:'ch', ш:'sh', щ:'sh', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya' };
    const generatedSlug = name.toLowerCase().replace(/[а-яё]/g, (letter) => transliteration[letter] || '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = String(input.slug || generatedSlug || `company-${Date.now()}`).trim().toLowerCase();
    const ownerName = String(input.ownerName || '').trim();
    const ownerLogin = String(input.ownerLogin || '').trim().toLowerCase();
    const ownerPassword = String(input.ownerPassword || '');
    const timezone = input.timezone === undefined ? 'Europe/Moscow' : String(input.timezone).trim();
    const plan = ['starter', 'growth', 'network', 'enterprise'].includes(input.plan) ? input.plan : 'starter';
    if (!name || name.length > 120 || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) return json(res, 400, { error: 'valid_name_and_slug_required' });
    if (!ownerName || ownerName.length > 120 || !/^[^\s@]+@[^\s@]+$/.test(ownerLogin) || ownerPassword.length < 8) return json(res, 400, { error: 'valid_owner_credentials_required' });
    if (!isValidIanaTimezone(timezone)) return json(res, 400, { error: 'invalid_organization_timezone' });
    if (repositories?.pool) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const org = await client.query(`INSERT INTO organizations (name,slug,plan,timezone) VALUES ($1,$2,$3,$4) RETURNING id,name,slug,plan,is_active AS "isActive",created_at AS "createdAt"`, [name, slug, plan, timezone]);
        const organization = org.rows[0];
        await client.query(`INSERT INTO organization_subscriptions (organization_id,plan,status,seats_limit,venues_limit) VALUES ($1,$2,'trialing',$3,$4)`, [organization.id, plan, saasPlans[plan].seatsLimit, saasPlans[plan].venuesLimit]);
        const venueRow = await client.query(`INSERT INTO venues (organization_id,name,city,address,format,timezone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [organization.id, name, String(input.city || '').trim(), String(input.address || '').trim(), 'кальян-бар', timezone]);
        const passwordHash = await hashPassword(ownerPassword);
        const owner = await client.query(`INSERT INTO users (venue_id,organization_id,full_name,login,password_hash,pin_hash,role) VALUES ($1,$2,$3,$4,$5,NULL,'owner') RETURNING id,full_name AS name,login,role`, [venueRow.rows[0].id, organization.id, ownerName, ownerLogin, passwordHash]);
        await client.query(`INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,'owner','active')`, [organization.id, owner.rows[0].id]);
        await client.query('COMMIT');
        recordAudit(req, 'platform.organization_created', 'organization', organization.id, null, { ...organization, ownerLogin });
        return json(res, 201, { ...organization, status: 'trialing', venues: 1, seats: 1, city: input.city || '', owner: owner.rows[0] });
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'organization_create_failed', detail: error.code === '23505' ? 'slug_or_owner_login_already_exists' : error.message }); }
      finally { client.release(); }
    }
    if (saasOrganizations.some((item) => item.slug === slug) || provisionedAccounts.some((item) => item.username === ownerLogin)) return json(res, 409, { error: 'slug_or_owner_login_already_exists' });
    const organizationId = `org-${Date.now()}`;
    const ownerId = crypto.randomUUID();
    const venueId = crypto.randomUUID();
    const item = { id: organizationId, name, slug, plan, status: 'trialing', city: String(input.city || '').trim(), venues: 1, seats: 1, createdAt: new Date().toISOString(), isActive: true, seatsLimit: saasPlans[plan].seatsLimit, venuesLimit: saasPlans[plan].venuesLimit };
    saasOrganizations.push(item);
    provisionedAccounts.push({ id: ownerId, username: ownerLogin, password: ownerPassword, name: ownerName, role: 'owner', organizationId, venueId });
    recordAudit(req, 'platform.organization_created', 'organization', item.id, null, { ...item, ownerLogin });
    return json(res, 201, { ...item, owner: { id: ownerId, name: ownerName, login: ownerLogin, role: 'owner' } });
  }
  const platformOrgSubscription = pathname.match(/^\/api\/platform\/organizations\/([^/]+)\/subscription$/);
  if (platformOrgSubscription && req.method === 'GET') {
    if (denyUnless(req, res, 'platform')) return;
    if (repositories?.pool) {
      if (!/^[0-9a-f-]{36}$/i.test(platformOrgSubscription[1])) return json(res, 404, { error: 'organization_not_found' });
      try { const { rows } = await repositories.pool.query(`SELECT organization_id AS "organizationId",plan,status,billing_mode AS "billingMode",monthly_price_cents AS "monthlyPriceCents",seats_limit AS "seatsLimit",venues_limit AS "venuesLimit",trial_ends_at AS "trialEndsAt" FROM organization_subscriptions WHERE organization_id=$1`, [platformOrgSubscription[1]]); if (rows[0]) return json(res, 200, { ...rows[0], monthlyPrice: Number(rows[0].monthlyPriceCents || 0) / 100 }); return json(res, 404, { error: 'subscription_not_found' }); } catch (_) { return json(res, 503, { error: 'subscription_unavailable' }); }
    }
    const item = saasOrganizations.find((entry) => entry.id === platformOrgSubscription[1]); if (!item) return json(res, 404, { error: 'organization_not_found' }); const plan = saasPlans[item.plan] || saasPlans.starter; return json(res, 200, { organizationId: item.id, plan: item.plan, status: item.status, billingMode: 'test_free', monthlyPrice: 0, seatsLimit: plan.seatsLimit, venuesLimit: plan.venuesLimit, trialEndsAt: item.trialEndsAt || null });
  }
  if (platformOrgSubscription && req.method === 'PATCH') {
    if (denyUnless(req, res, 'platform')) return;
    const input = await body(req);
    const organizationId = platformOrgSubscription[1];
    const planKey = String(input.plan || '');
    const status = input.status === undefined ? undefined : (['active', 'trialing', 'past_due', 'cancelled'].includes(input.status) ? input.status : null);
    if (!saasPlans[planKey]) return json(res, 400, { error: 'invalid_plan' });
    if (status === null) return json(res, 400, { error: 'invalid_subscription_status' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(organizationId)) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const beforeResult = await client.query(`SELECT o.id,o.plan,o.is_active AS "isActive",s.status,s.seats_limit AS "seatsLimit",s.venues_limit AS "venuesLimit"
          FROM organizations o LEFT JOIN organization_subscriptions s ON s.organization_id=o.id WHERE o.id=$1 FOR UPDATE OF o`, [organizationId]);
        if (!beforeResult.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'organization_not_found' }); }
        const before = beforeResult.rows[0];
        const nextStatus = status || before.status || 'trialing';
        await client.query(`INSERT INTO organization_subscriptions (organization_id,plan,status,billing_mode,monthly_price_cents,seats_limit,venues_limit,updated_at)
          VALUES ($1,$2,$3,'test_free',0,$4,$5,now())
          ON CONFLICT (organization_id) DO UPDATE SET plan=EXCLUDED.plan,status=EXCLUDED.status,billing_mode='test_free',monthly_price_cents=0,seats_limit=EXCLUDED.seats_limit,venues_limit=EXCLUDED.venues_limit,updated_at=now()`,
          [organizationId, planKey, nextStatus, saasPlans[planKey].seatsLimit, saasPlans[planKey].venuesLimit]);
        await client.query('UPDATE organizations SET plan=$1,is_active=$2,updated_at=now() WHERE id=$3', [planKey, nextStatus !== 'cancelled', organizationId]);
        await client.query('COMMIT');
        const updated = { organizationId, plan: planKey, status: nextStatus, billingMode: 'test_free', monthlyPrice: 0, seatsLimit: saasPlans[planKey].seatsLimit, venuesLimit: saasPlans[planKey].venuesLimit };
        recordAudit(req, 'platform.subscription_updated', 'organization_subscription', organizationId, before, updated);
        return json(res, 200, updated);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 503, { error: 'subscription_save_failed', detail: error.message }); }
      finally { client.release(); }
    }
    const item = saasOrganizations.find((entry) => entry.id === organizationId);
    if (!item) return json(res, 404, { error: 'organization_not_found' });
    const before = { ...item };
    item.plan = planKey;
    item.status = status || item.status;
    item.isActive = item.status !== 'cancelled';
    Object.assign(item, { seatsLimit: saasPlans[planKey].seatsLimit, venuesLimit: saasPlans[planKey].venuesLimit, monthlyPrice: 0 });
    recordAudit(req, 'platform.subscription_updated', 'organization_subscription', item.id, before, item);
    return json(res, 200, { organizationId: item.id, plan: item.plan, status: item.status, billingMode: 'test_free', monthlyPrice: 0, seatsLimit: item.seatsLimit, venuesLimit: item.venuesLimit });
  }
  const platformOrgPath = pathname.match(/^\/api\/platform\/organizations\/([^/]+)$/);
  const platformOwnersPath = pathname.match(/^\/api\/platform\/organizations\/([^/]+)\/owners(?:\/([^/]+))?(?:\/(reset|transfer))?$/);
  if (platformOwnersPath && ['GET','POST','PATCH','DELETE'].includes(req.method) || (platformOwnersPath && req.method === 'POST')) {
    if (denyUnless(req, res, 'platform')) return;
    const organizationId = platformOwnersPath[1]; const targetId = platformOwnersPath[2]; const action = platformOwnersPath[3];
    if (!repositories?.pool || !/^[0-9a-f-]{36}$/i.test(organizationId)) return json(res, 503, { error: 'owner_management_requires_database' });
    try {
      if (req.method === 'GET') {
        const { rows } = await repositories.pool.query(`SELECT u.id,u.full_name AS name,u.login,u.is_active AS active,m.status,m.is_primary AS "isPrimary",m.created_at AS "createdAt" FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id WHERE u.organization_id=$1 AND m.membership_role='owner' AND u.deleted_at IS NULL ORDER BY m.is_primary DESC,u.full_name`, [organizationId]);
        return json(res, 200, { items: rows });
      }
      if (req.method === 'POST' && action === 'reset' && targetId) {
        const token = crypto.randomBytes(32).toString('hex'); const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const result = await repositories.pool.query(`UPDATE users u SET password_reset_token_hash=$1,password_reset_expires_at=now()+interval '30 minutes' FROM organization_memberships m WHERE u.id=$2 AND u.organization_id=$3 AND m.user_id=u.id AND m.organization_id=$3 AND m.membership_role='owner' RETURNING u.id,u.login`, [tokenHash,targetId,organizationId]);
        if (!result.rows[0]) return json(res, 404, { error: 'owner_not_found' });
        recordAudit(req, 'platform.owner_reset_issued', 'organization_owner', targetId, null, { organizationId, login: result.rows[0].login, expiresInMinutes: 30 });
        return json(res, 200, { userId: targetId, login: result.rows[0].login, resetToken: token, expiresInMinutes: 30 });
      }
      if (req.method === 'POST' && action === 'transfer' && targetId) {
        const client = await repositories.pool.connect(); try { await client.query('BEGIN');
          const current = await client.query(`SELECT u.id,u.full_name AS name,u.login,m.is_primary AS "isPrimary" FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=$1 WHERE u.organization_id=$1 AND m.membership_role='owner' AND m.is_primary=true FOR UPDATE`, [organizationId]);
          const target = await client.query(`SELECT u.id,u.full_name AS name,u.login FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=$1 WHERE u.id=$2 AND u.organization_id=$1 AND m.membership_role='owner' AND u.is_active=true FOR UPDATE`, [organizationId,targetId]);
          if (!target.rows[0]) { await client.query('ROLLBACK'); return json(res,404,{error:'owner_not_found'}); }
          await client.query('UPDATE organization_memberships SET is_primary=false WHERE organization_id=$1 AND membership_role=\'owner\'', [organizationId]);
          await client.query('UPDATE organization_memberships SET is_primary=true,status=\'active\' WHERE organization_id=$1 AND user_id=$2', [organizationId,targetId]); await client.query('COMMIT');
          recordAudit(req,'platform.owner_transferred','organization_owner',targetId,current.rows[0]||null,target.rows[0]); return json(res,200,{owner:target.rows[0]});
        } catch (error) { await client.query('ROLLBACK').catch(()=>{}); return json(res,503,{error:'owner_transfer_failed',detail:error.message}); } finally { client.release(); }
      }
      if (req.method === 'POST' && !action) {
        const input = await body(req); const name=String(input.name||'').trim(); const login=String(input.login||'').trim().toLowerCase(); const password=String(input.password||'');
        if (!name || !/^[^\s@]+@[^\s@]+$/.test(login) || password.length < 8) return json(res,400,{error:'valid_owner_credentials_required'});
        const org = await repositories.pool.query('SELECT id FROM organizations WHERE id=$1',[organizationId]); if (!org.rows[0]) return json(res,404,{error:'organization_not_found'});
        const venue = await repositories.pool.query('SELECT id FROM venues WHERE organization_id=$1 ORDER BY created_at LIMIT 1',[organizationId]); if (!venue.rows[0]) return json(res,409,{error:'organization_venue_required'});
        const hash=await hashPassword(password); const client=await repositories.pool.connect(); try { await client.query('BEGIN'); const u=await client.query(`INSERT INTO users (venue_id,organization_id,full_name,login,password_hash,pin_hash,role) VALUES ($1,$2,$3,$4,$5,NULL,'owner') RETURNING id,full_name AS name,login,is_active AS active`,[venue.rows[0].id,organizationId,name,login,hash]); await client.query(`INSERT INTO organization_memberships (organization_id,user_id,membership_role,status,is_primary) VALUES ($1,$2,'owner','active',false)`,[organizationId,u.rows[0].id]); await client.query('COMMIT'); recordAudit(req,'platform.owner_added','organization_owner',u.rows[0].id,null,{organizationId,...u.rows[0]}); return json(res,201,{...u.rows[0],isPrimary:false}); } catch(error) { await client.query('ROLLBACK').catch(()=>{}); return json(res,409,{error:error.code==='23505'?'owner_login_already_exists':'owner_create_failed'}); } finally { client.release(); }
      }
      if (!targetId) return json(res,400,{error:'owner_id_required'});
      const current = await repositories.pool.query(`SELECT u.id,u.full_name AS name,u.login,u.is_active AS active,m.is_primary AS "isPrimary" FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=$1 WHERE u.id=$2 AND u.organization_id=$1 AND m.membership_role='owner'`,[organizationId,targetId]); if (!current.rows[0]) return json(res,404,{error:'owner_not_found'});
      if (req.method === 'DELETE') { if (current.rows[0].isPrimary) return json(res,409,{error:'transfer_primary_owner_first'}); await repositories.pool.query('UPDATE users SET deleted_at=now(),is_active=false WHERE id=$1',[targetId]); await repositories.pool.query('UPDATE organization_memberships SET status=\'suspended\' WHERE organization_id=$1 AND user_id=$2',[organizationId,targetId]); recordAudit(req,'platform.owner_removed','organization_owner',targetId,current.rows[0],null); return json(res,200,{ok:true}); }
      const input=await body(req); if (input.active === false && current.rows[0].isPrimary) return json(res,409,{error:'primary_owner_must_be_transferred_first'}); if (input.isPrimary === true && current.rows[0].active === false) return json(res,409,{error:'inactive_owner_cannot_be_primary'}); if (input.login !== undefined && !/^[^\s@]+@[^\s@]+$/.test(String(input.login).trim())) return json(res,400,{error:'valid_owner_email_required'}); if (req.method === 'PATCH' && input.isPrimary === true) { const client=await repositories.pool.connect(); try { await client.query('BEGIN'); await client.query('UPDATE organization_memberships SET is_primary=false WHERE organization_id=$1 AND membership_role=\'owner\'', [organizationId]); await client.query('UPDATE organization_memberships SET is_primary=true,status=\'active\' WHERE organization_id=$1 AND user_id=$2 AND membership_role=\'owner\'', [organizationId,targetId]); await client.query('COMMIT'); recordAudit(req,'platform.owner_transferred','organization_owner',targetId,current.rows[0],{...current.rows[0],isPrimary:true}); return json(res,200,{...current.rows[0],isPrimary:true}); } catch(error) { await client.query('ROLLBACK').catch(()=>{}); return json(res,503,{error:'owner_transfer_failed'}); } finally { client.release(); } } const fields=[]; const values=[]; if(input.name!==undefined){values.push(String(input.name).trim());fields.push(`full_name=$${values.length}`);} if(input.login!==undefined){values.push(String(input.login).trim().toLowerCase());fields.push(`login=$${values.length}`);} if(input.password){ if(String(input.password).length<8)return json(res,400,{error:'password_too_short'}); values.push(await hashPassword(input.password));fields.push(`password_hash=$${values.length}`); fields.push('password_reset_token_hash=NULL'); fields.push('password_reset_expires_at=NULL');} if(input.active!==undefined){values.push(Boolean(input.active));fields.push(`is_active=$${values.length}`);} if(!fields.length)return json(res,200,current.rows[0]); values.push(targetId); const targetIdParameter=values.length; values.push(organizationId); const organizationIdParameter=values.length; let updated; try { updated=await repositories.pool.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${targetIdParameter} AND organization_id=$${organizationIdParameter} RETURNING id,full_name AS name,login,is_active AS active`,values); } catch(error) { if(input.login!==undefined && error.code==='23505') return json(res,409,{error:'owner_login_already_exists'}); throw error; } if(input.password || input.active === false) { await repositories.pool.query('DELETE FROM auth_sessions WHERE user_id=$1',[targetId]); for (const [sessionToken, session] of sessions) if (session.user?.id === targetId) sessions.delete(sessionToken); } recordAudit(req,'platform.owner_updated','organization_owner',targetId,current.rows[0],updated.rows[0]); return json(res,200,updated.rows[0]);
    } catch (error) { return json(res,503,{error:'owner_management_failed'}); }
  }
  if (platformOrgPath && req.method === 'GET') {
    if (denyUnless(req, res, 'platform')) return;
    const organizationId = platformOrgPath[1];
    if (repositories?.pool && !/^[0-9a-f-]{36}$/i.test(organizationId)) return json(res, 404, { error: 'organization_not_found' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(organizationId)) {
      try {
        const { rows } = await repositories.pool.query(`SELECT o.id,o.name,o.slug,o.plan,o.is_active AS "isActive",o.created_at AS "createdAt",o.timezone,COALESCE(s.status,'trialing') AS status,COALESCE(s.plan,o.plan) AS "subscriptionPlan",COALESCE(s.seats_limit,5) AS "seatsLimit",COALESCE(s.venues_limit,1) AS "venuesLimit",
          (SELECT COUNT(*)::int FROM venues v WHERE v.organization_id=o.id AND v.is_active=true) AS venues,
          (SELECT COUNT(*)::int FROM users u WHERE u.organization_id=o.id AND u.is_active=true AND u.deleted_at IS NULL) AS seats,
          (SELECT city FROM venues v2 WHERE v2.organization_id=o.id ORDER BY v2.created_at LIMIT 1) AS city,
          (SELECT COALESCE(json_agg(json_build_object('id',u.id,'name',u.full_name,'login',u.login,'active',u.is_active,'isPrimary',m.is_primary) ORDER BY m.is_primary DESC,u.full_name),'[]'::json)
             FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=o.id
            WHERE u.organization_id=o.id AND m.membership_role='owner' AND u.deleted_at IS NULL) AS owners
          FROM organizations o LEFT JOIN organization_subscriptions s ON s.organization_id=o.id WHERE o.id=$1 LIMIT 1`, [organizationId]);
        if (!rows[0]) return json(res, 404, { error: 'organization_not_found' });
        const item = rows[0];
        return json(res, 200, { ...item, venues: Number(item.venues || 0), seats: Number(item.seats || 0), seatsLimit: Number(item.seatsLimit || 0), venuesLimit: Number(item.venuesLimit || 0), owners: item.owners || [] });
      } catch (_) { return json(res, 503, { error: 'organization_details_unavailable' }); }
    }
    const item = saasOrganizations.find((entry) => entry.id === organizationId);
    if (!item) return json(res, 404, { error: 'organization_not_found' });
    const owners = (item.owners || provisionedAccounts.filter((entry) => entry.organizationId === organizationId).map((entry) => ({ id: entry.id, name: entry.name, login: entry.username, active: true, isPrimary: true }))).map((owner) => ({ ...owner, active: owner.active !== false, isPrimary: owner.isPrimary !== false }));
    return json(res, 200, { ...item, venues: Number(item.venues || 0), seats: Number(item.seats || 0), seatsLimit: Number(item.seatsLimit || saasPlans[item.plan]?.seatsLimit || 0), venuesLimit: Number(item.venuesLimit || saasPlans[item.plan]?.venuesLimit || 0), owners });
  }
  if (platformOrgPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'platform')) return;
    if (repositories?.pool) return json(res, 410, { error: 'use_subscription_endpoint' });
    const input = await body(req);
    const name = input.name === undefined ? undefined : String(input.name).trim().slice(0, 120);
    const plan = input.plan === undefined ? undefined : String(input.plan);
    if (name !== undefined && !name) return json(res, 400, { error: 'organization_name_required' });
    if (plan !== undefined && !saasPlans[plan]) return json(res, 400, { error: 'invalid_plan' });
    const organizationId = platformOrgPath[1];
    if (repositories?.pool) return json(res, 410, { error: 'use_subscription_endpoint' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(organizationId)) {
      try {
        const beforeResult = await repositories.pool.query('SELECT id,name,plan,is_active AS "isActive" FROM organizations WHERE id=$1 LIMIT 1', [organizationId]);
        if (!beforeResult.rows[0]) return json(res, 404, { error: 'organization_not_found' });
        const before = beforeResult.rows[0];
        const fields = [];
        const values = [];
        if (name !== undefined) { values.push(name); fields.push(`name=$${values.length}`); }
        if (plan !== undefined) { values.push(plan); fields.push(`plan=$${values.length}`); }
        if (input.isActive !== undefined) { values.push(Boolean(input.isActive)); fields.push(`is_active=$${values.length}`); }
        if (!fields.length) return json(res, 200, before);
        values.push(organizationId);
        const client = await repositories.pool.connect();
        let updated;
        try {
          await client.query('BEGIN');
          const { rows } = await client.query(`UPDATE organizations SET ${fields.join(',')},updated_at=now() WHERE id=$${values.length} RETURNING id,name,plan,is_active AS "isActive"`, values);
          updated = rows[0];
          if (plan !== undefined) await client.query('UPDATE organization_subscriptions SET plan=$1,seats_limit=$2,venues_limit=$3,updated_at=now() WHERE organization_id=$4', [plan, saasPlans[plan].seatsLimit, saasPlans[plan].venuesLimit, organizationId]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally { client.release(); }
        recordAudit(req, 'platform.organization_updated', 'organization', organizationId, before, updated);
        return json(res, 200, updated);
      } catch (error) { return json(res, 503, { error: 'organization_save_failed', detail: error.message }); }
    }
    const item = saasOrganizations.find((entry) => entry.id === organizationId);
    if (!item) return json(res, 404, { error: 'organization_not_found' });
    const before = { ...item };
    if (name !== undefined) item.name = name;
    if (plan !== undefined) { item.plan = plan; item.seatsLimit = saasPlans[plan].seatsLimit; item.venuesLimit = saasPlans[plan].venuesLimit; }
    if (input.isActive !== undefined) item.isActive = Boolean(input.isActive);
    recordAudit(req, 'platform.organization_updated', 'organization', item.id, before, item);
    return json(res, 200, item);
  }
  if (pathname === '/api/shifts' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['floor', 'orders', 'finance_read'])) return;
    if (isOperationalEmployee(req)) {
      if (repositories?.pool) {
        try {
          const { rows } = await repositories.pool.query('SELECT s.id,s.opened_at AS "openedAt",s.opening_cash AS "openingCash",COALESCE(u.full_name,u.login,\'Не указан\') AS "openedByName" FROM shifts s LEFT JOIN users u ON u.id=s.opened_by AND (u.venue_id=s.venue_id OR u.organization_id=(SELECT organization_id FROM venues WHERE id=s.venue_id)) WHERE s.venue_id=$1 AND s.closed_at IS NULL ORDER BY s.opened_at DESC LIMIT 1', [venueDbId]);
          const row = rows[0];
          const current = row ? { id: row.id, openedAt: row.openedAt, closedAt: null, openingCash: Number(row.openingCash || 0) } : null;
          return json(res, 200, { items: current ? [current] : [], current });
        } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
      }
      const shift = shifts.find((entry) => entry.venueId === venueDbId && !entry.closedAt);
      const cashPayments = orders.flatMap((order) => order.payments || []).filter((payment) => payment.method === 'cash' && ['paid','partially_paid'].includes(payment.status) && new Date(payment.createdAt || 0) >= new Date(shift?.openedAt || 0));
      const unresolvedLegacyCash = cashPayments.filter((payment) => !payment.shiftId);
      const depositCash = clients.flatMap((guest) => guest.depositTopUps || []).filter((receipt) => receipt.shiftId === shift?.id && receipt.method === 'cash').reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0);
      const reservationCash = reservations.flatMap((reservation) => reservation.prepaymentReceipts || []).filter((receipt) => receipt.shiftId === shift?.id && receipt.method === 'cash').reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0);
      const current = shift ? { id: shift.id, openedAt: shift.openedAt, closedAt: null, openingCash: Number(shift.openingCash || 0) } : null;
      return json(res, 200, { items: current ? [current] : [], current });
    }
    const canSeeShiftOpener = hasPermission(req, 'finance_read');
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query(`SELECT s.id,s.opened_at AS "openedAt",s.closed_at AS "closedAt",s.opening_cash AS "openingCash",s.closing_cash AS "closingCash",s.expected_cash AS "expectedCash",s.cash_variance AS "cashVariance",COALESCE(u.full_name,u.login,'Не указан') AS "openedByName",s.opened_at + (COALESCE((SELECT SUM(p.amount) FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=s.venue_id AND p.shift_id=s.id AND p.method='cash' AND p.status IN ('paid','partially_paid')),0) * INTERVAL '0 second') AS "reconciliationAt" FROM shifts s LEFT JOIN users u ON u.id=s.opened_by AND (u.venue_id=s.venue_id OR u.organization_id=(SELECT organization_id FROM venues WHERE id=s.venue_id)) WHERE s.venue_id=$1 ORDER BY s.opened_at DESC LIMIT 20`, [venueDbId]); const visible = canSeeShiftOpener ? rows : rows.filter((entry) => !entry.closedAt).slice(0, 1).map((entry) => ({ id: entry.id, openedAt: entry.openedAt, closedAt: null, openingCash: entry.openingCash })); const current = visible.find((entry) => !entry.closedAt) || null; if (current) Object.assign(current, await getShiftCashSummary(repositories.pool, venueDbId, current)); return json(res, 200, { items: visible, current }); } catch (_) {} }
    const venueShifts = shifts.filter((entry) => entry.venueId === venueDbId); const visible = hasPermission(req, 'finance_read') ? venueShifts.slice().reverse() : venueShifts.filter((entry) => !entry.closedAt).slice(0, 1).map((entry) => ({ id: entry.id, openedAt: entry.openedAt, closedAt: null, openingCash: entry.openingCash }));
    const current = visible.find((entry) => !entry.closedAt) || null;
    if (current) { const cashPayments = orders.flatMap((order) => order.payments || []).filter((payment) => payment.method === 'cash' && ['paid','partially_paid'].includes(payment.status) && new Date(payment.createdAt || 0) >= new Date(current.openedAt)); const unassigned = cashPayments.filter((payment) => !payment.shiftId); const deposits = clients.flatMap((guest) => guest.depositTopUps || []).filter((receipt) => receipt.shiftId === current.id && receipt.method === 'cash').reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0); const prepayments = reservations.flatMap((reservation) => reservation.prepaymentReceipts || []).filter((receipt) => receipt.shiftId === current.id && receipt.method === 'cash').reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0); current.unresolvedLegacyCashCount = unassigned.length; current.unresolvedLegacyCashAmount = unassigned.reduce((sum, payment) => sum + Number(payment.amount || 0), 0); current.expectedCash = unassigned.length ? null : Number(current.openingCash || 0) + cashPayments.filter((payment) => payment.shiftId === current.id).reduce((sum, payment) => sum + Number(payment.amount || 0), 0) + deposits + prepayments; current.cashPreviewAt = new Date().toISOString(); }
    return json(res, 200, { items: visible, current });
  }
  if (pathname === '/api/shifts' && req.method === 'POST') {
    if (denyUnlessAny(req, res, ['floor', 'orders'])) return;
    const input = await body(req);
    if (!Object.prototype.hasOwnProperty.call(input, 'openingCash') || !validCashAmount(input.openingCash)) return json(res, 400, { error: 'opening_cash_required' });
    if (repositories?.pool) { let client; try { client = await repositories.pool.connect(); await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext('territory_crm_open_shift'),hashtext($1::text))", [venueDbId]); const open = await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL LIMIT 1 FOR UPDATE', [venueDbId]); if (open.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'shift_already_open' }); } const openedBy = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : '20000000-0000-0000-0000-000000000001'; const { rows } = await client.query('INSERT INTO shifts (venue_id,opened_by,opening_cash) VALUES ($1,$2,$3) RETURNING id,opened_at AS "openedAt",closed_at AS "closedAt",opening_cash AS "openingCash",closing_cash AS "closingCash"', [venueDbId, openedBy, Number(input.openingCash || 0)]); await client.query('INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,after_data) VALUES ($1,$2,$3,$4,$5,$6)', [venueDbId, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null, 'shift.opened', 'shift', rows[0].id, rows[0]]); await client.query('COMMIT'); return json(res, 201, rows[0]); } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') return json(res, 409, { error: 'shift_already_open' }); return json(res, 409, { error: 'shift_open_failed', detail: error.message }); } finally { client?.release(); } }
    if (shifts.some((entry) => entry.venueId === venueDbId && !entry.closedAt) || memoryShiftOpenPending.has(venueDbId)) return json(res, 409, { error: 'shift_already_open' });
    memoryShiftOpenPending.add(venueDbId);
    const shift = { venueId: venueDbId, id: `shift-${Date.now()}`, openedAt: new Date().toISOString(), closedAt: null, openingCash: Number(input.openingCash), closingCash: null, openedBy: req.user?.name || 'сотрудник' }; shifts.push(shift); memoryShiftOpenPending.delete(venueDbId); recordAudit(req, 'shift.opened', 'shift', shift.id, null, shift); return json(res, 201, shift);
  }
  const shiftClose = pathname.match(/^\/api\/shifts\/([^/]+)\/close$/);
  if (shiftClose && req.method === 'POST') {
    if (denyUnlessAny(req, res, ['floor', 'orders'])) return;
    const input = await body(req);
    if (!shiftCloseContract.validateChecklist(input.checklist)) return json(res, 400, { error: 'shift_checklist_required', message: 'Подтвердите каждый обязательный пункт чек-листа закрытия смены' });
    if (!Object.prototype.hasOwnProperty.call(input, 'closingCash') || !validCashAmount(input.closingCash)) return json(res, 400, { error: 'closing_cash_required' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(shiftClose[1])) {
      let client;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        const { rows: shiftRows } = await client.query('SELECT id,venue_id,opening_cash AS "openingCash",opened_at AS "openedAt" FROM shifts WHERE id=$1 AND venue_id=$2 AND closed_at IS NULL FOR UPDATE', [shiftClose[1], venueDbId]);
        if (!shiftRows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'shift_not_found_or_closed' }); }
        const shift = shiftRows[0];
        const cashSummary = await getShiftCashSummary(client, venueDbId, shift);
        if (cashSummary.unresolvedLegacyCashCount > 0) {
          await client.query('ROLLBACK');
          return json(res, 409, { error: 'shift_cash_attribution_unresolved', count: cashSummary.unresolvedLegacyCashCount, amount: cashSummary.unresolvedLegacyCashAmount });
        }
        const ledger = await captureShiftCloseLedger(client, venueDbId, shift.id);
        const { rows: timezoneRows } = await client.query("SELECT COALESCE(NULLIF(timezone,''),'Europe/Moscow') AS timezone FROM venues WHERE id=$1", [venueDbId]);
        const { rows } = await client.query('UPDATE shifts SET closed_at=clock_timestamp(),closing_cash=$1::numeric,expected_cash=$2::numeric,cash_variance=$1::numeric-$2::numeric WHERE id=$3 AND venue_id=$4 AND closed_at IS NULL RETURNING id,venue_id AS "venueId",opened_at AS "openedAt",closed_at AS "closedAt",opening_cash AS "openingCash",closing_cash AS "closingCash",expected_cash AS "expectedCash",cash_variance AS "cashVariance"', [Number(input.closingCash), cashSummary.expectedCash, shift.id, venueDbId]);
        if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'shift_not_found_or_closed' }); }
        const closed = rows[0];
        const actorId = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null;
        const checklist = shiftCloseContract.freezeChecklist(input.checklist, actorId, closed.closedAt);
        const snapshotPayload = {
          kind: 'internal_pos_shift_close',
          reportLabel: 'Внутренний снимок закрытия смены HOOKAH POS',
          fiscalDocument: false,
          fiscalNote: 'Не является фискальным Z-отчётом и не подтверждает работу фискального устройства.',
          schemaVersion: 1,
          currency: 'RUB',
          venueId: venueDbId,
          shift: { id: closed.id, openedAt: closed.openedAt, closedAt: closed.closedAt, closedBy: actorId },
          timezone: timezoneRows[0]?.timezone || 'Europe/Moscow',
          checklist,
          cashReconciliation: {
            openingCash: Number(shift.openingCash || 0),
            expectedCash: Number(closed.expectedCash),
            actualCash: Number(closed.closingCash),
            variance: Number(closed.cashVariance),
            calculatedAt: cashSummary.cashPreviewAt,
            legacyUnassignedCashCount: cashSummary.unresolvedLegacyCashCount,
          },
          ledger,
        };
        const snapshotJson = shiftCloseContract.stableJsonStringify(snapshotPayload);
        const snapshotSha256 = crypto.createHash('sha256').update(snapshotJson).digest('hex');
        const { rows: snapshotRows } = await client.query('INSERT INTO shift_close_snapshots (venue_id,shift_id,schema_version,checklist_version,snapshot_payload,snapshot_sha256,closed_by) VALUES ($1,$2,1,$3,$4::jsonb,$5,$6) RETURNING id::text AS "id",venue_id::text AS "venueId",shift_id::text AS "shiftId",schema_version AS "schemaVersion",checklist_version AS "checklistVersion",snapshot_payload AS "payload",snapshot_sha256 AS "sha256",closed_by::text AS "closedBy",captured_at AS "capturedAt"', [venueDbId, closed.id, checklist.version, snapshotJson, snapshotSha256, actorId]);
        const closeSnapshot = snapshotRows[0];
        await client.query('INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,after_data) VALUES ($1,$2,$3,$4,$5,$6)', [venueDbId, actorId, 'shift.closed', 'shift', closed.id, { ...closed, closeSnapshotId: closeSnapshot.id, closeSnapshotSha256: closeSnapshot.sha256 }]);
        await client.query('COMMIT');
        return json(res, 200, { ...closed, closeSnapshot });
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return json(res, 409, { error: 'shift_close_failed', detail: error.message });
      } finally { client?.release(); }
    }
    const shift = shifts.find((entry) => entry.id === shiftClose[1]); if (!shift || shift.closedAt) return json(res, 404, { error: 'shift_not_found_or_closed' });
    const cashPayments = orders.flatMap((order) => order.payments || []).filter((payment) => payment.method === 'cash' && ['paid', 'partially_paid'].includes(payment.status) && new Date(payment.createdAt || 0) >= new Date(shift.openedAt));
    const unassignedCashPayments = cashPayments.filter((payment) => !payment.shiftId);
    if (unassignedCashPayments.length) return json(res, 409, { error: 'shift_cash_attribution_unresolved', count: unassignedCashPayments.length, amount: unassignedCashPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) });
    const depositCash = clients.flatMap((guest) => guest.depositTopUps || []).filter((receipt) => receipt.shiftId === shift.id && receipt.method === 'cash').reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0); const reservationCash = reservations.flatMap((reservation) => reservation.prepaymentReceipts || []).filter((receipt) => receipt.shiftId === shift.id && receipt.method === 'cash').reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0); const expectedCash = Number(shift.openingCash || 0) + cashPayments.filter((payment) => payment.shiftId === shift.id).reduce((sum, payment) => sum + Number(payment.amount || 0), 0) + depositCash + reservationCash;
    shift.closedAt = new Date().toISOString(); shift.closedById = req.user?.id || null; shift.expectedCash = expectedCash; shift.closingCash = Number(input.closingCash); shift.cashVariance = shift.closingCash - expectedCash;
    shift.closeSnapshot = { id: `memory-close-${Date.now()}`, schemaVersion: 1, sha256: null, capturedAt: shift.closedAt, payload: { kind: 'internal_pos_shift_close', reportLabel: 'Внутренний снимок закрытия смены HOOKAH POS', fiscalDocument: false, fiscalNote: 'Демонстрационный снимок в памяти; не является фискальным Z-отчётом.', venueId: shift.venueId, shift: { id: shift.id, openedAt: shift.openedAt, closedAt: shift.closedAt }, checklist: shiftCloseContract.freezeChecklist(input.checklist, req.user?.id || null, shift.closedAt), cashReconciliation: { openingCash: Number(shift.openingCash || 0), expectedCash, actualCash: shift.closingCash, variance: shift.cashVariance }, ledger: { coverage: 'memory_demo_unverified' } } };
    recordAudit(req, 'shift.closed', 'shift', shift.id, null, { ...shift, closeSnapshotId: shift.closeSnapshot.id }); return json(res, 200, shift);
  }
  const shiftCloseSnapshot = pathname.match(/^\/api\/shifts\/([^/]+)\/close-snapshot$/);
  if (shiftCloseSnapshot && req.method === 'GET') {
    if (!hasPermission(req, 'floor') && !hasPermission(req, 'orders') && !hasPermission(req, 'finance_read')) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(shiftCloseSnapshot[1])) {
      try {
        const { rows } = await repositories.pool.query('SELECT id::text AS "id",venue_id::text AS "venueId",shift_id::text AS "shiftId",schema_version AS "schemaVersion",checklist_version AS "checklistVersion",snapshot_payload AS "payload",snapshot_sha256 AS "sha256",closed_by::text AS "closedBy",captured_at AS "capturedAt" FROM shift_close_snapshots WHERE venue_id=$1 AND shift_id=$2', [venueDbId, shiftCloseSnapshot[1]]);
        if (!rows[0]) return json(res, 404, { error: 'shift_close_snapshot_not_found' });
        if (!hasPermission(req, 'finance_read') && rows[0].closedBy !== req.user?.id) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
        return json(res, 200, rows[0]);
      } catch (error) { return json(res, 503, { error: 'shift_close_snapshot_unavailable', detail: error.message }); }
    }
    const closedShift = shifts.find((entry) => entry.id === shiftCloseSnapshot[1] && entry.venueId === venueDbId && entry.closedAt);
    if (!closedShift?.closeSnapshot) return json(res, 404, { error: 'shift_close_snapshot_not_found' });
    if (!hasPermission(req, 'finance_read') && String(closedShift.closedById || '') !== String(req.user?.id || '')) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
    return json(res, 200, { id: closedShift.closeSnapshot.id, venueId: venueDbId, shiftId: closedShift.id, schemaVersion: 1, checklistVersion: closedShift.closeSnapshot.payload.checklist.version, payload: closedShift.closeSnapshot.payload, sha256: closedShift.closeSnapshot.sha256, closedBy: closedShift.closedById || null, capturedAt: closedShift.closeSnapshot.capturedAt });
  }
  if (pathname === '/api/venue/purchase-reversal-policy' && ['GET','PATCH'].includes(req.method)) {
    if (!req.user) return json(res, 401, { error: 'authentication_required' });
    if (!['owner','admin'].includes(req.user.role) || !effectivePermissions(req.user).includes('settings')) return json(res, 403, { error: 'venue_admin_required' });
    if (!repositories?.purchaseDocuments || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(req.user.id || ''))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(req.user.venueId || ''))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(req.user.organizationId || ''))) return json(res, 503, { error: 'purchase_reversal_policy_unavailable' });
    const venueAccess = await repositories.pool.query('SELECT 1 FROM venues WHERE id=$1 AND organization_id=$2 AND is_active=true', [req.user.venueId,req.user.organizationId]).catch(() => ({ rows: [] }));
    if (!venueAccess.rows[0]) return json(res, 404, { error: 'venue_not_found' });
    if (req.method === 'GET') {
      try { const policy = await repositories.purchaseDocuments.getReversalPolicy(req.user.venueId); return policy ? json(res, 200, policy) : json(res, 503, { error: 'purchase_reversal_policy_unavailable' }); }
      catch (_) { return json(res, 503, { error: 'purchase_reversal_policy_unavailable' }); }
    }
    if (!sameOriginMutation(req)) return json(res, 403, { error: 'same_origin_required' });
    if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json(res, 415, { error: 'json_content_type_required' });
    let input;
    try { input = await body(req); } catch (_) { return json(res, 400, { error: 'invalid_json_body' }); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || typeof input.enabled !== 'boolean'
      || Object.keys(input).some((key) => !['expectedVersion','enabled'].includes(key))) return json(res, 400, { error: 'invalid_purchase_reversal_policy' });
    try { return json(res, 200, await repositories.purchaseDocuments.updateReversalPolicy({ venueId: req.user.venueId, actorId: req.user.id, expectedVersion: input.expectedVersion, enabled: input.enabled })); }
    catch (error) {
      const status = error.message === 'venue_not_found' ? 404 : error.message === 'purchase_reversal_policy_version_conflict' ? 409 : 503;
      return json(res, status, { error: ['venue_not_found','purchase_reversal_policy_version_conflict','purchase_reversal_policy_unavailable'].includes(error.message) ? error.message : 'purchase_reversal_policy_update_failed' });
    }
  }
  if (pathname === '/api/venue' && req.method === 'GET') {
    if (process.env.DATABASE_URL && !repositories?.pool) return json(res, 503, { error: 'venue_unavailable' });
    if (repositories?.pool) { try {
      const organizationId = requestOrganizationId(req) || null;
      if (process.env.AUTH_REQUIRED === 'true' && !organizationId) return json(res, 403, { error: 'organization_context_required' });
      const { rows } = await repositories.pool.query('SELECT id,name,city,format,phone,phone_numbers AS "phoneNumbers",address,logo_url AS "logoUrl",timezone FROM venues WHERE id=$1 AND ($2::uuid IS NULL OR organization_id=$2::uuid) AND is_active=true', [venueDbId, organizationId]);
      if (!rows[0]) return json(res, 404, { error: 'venue_not_found' });
      const { rows: vipRows } = await repositories.pool.query('SELECT t.name,t.min_order_total FROM tables t JOIN zones z ON z.id=t.zone_id WHERE z.venue_id=$1 AND t.name IN ($2,$3)', [venueDbId, 'VIP-\u043a\u043e\u043c\u043d\u0430\u0442\u0430 1', 'VIP-\u043a\u043e\u043c\u043d\u0430\u0442\u0430 2']);
      const vipRoomMinimums = { vip_room_1: 1500, vip_room_2: 2500 };
      vipRows.forEach((row) => { if (row.name.endsWith('1')) vipRoomMinimums.vip_room_1 = Number(row.min_order_total); if (row.name.endsWith('2')) vipRoomMinimums.vip_room_2 = Number(row.min_order_total); });
      return json(res, 200, { ...rows[0], vipRoomMinimums });
    } catch (_) { return json(res, 503, { error: 'venue_unavailable' }); } }
    return json(res, 200, { ...venue, id: currentVenueId });
  }
  if (pathname === '/api/venue' && (req.method === 'PATCH' || req.method === 'PUT')) {
    if (denyUnless(req, res, 'settings')) return;
    if (!canManageVenueIdentity(req)) return json(res, 403, { error: 'venue_admin_required' });
    const input = await body(req);
    if (input.name !== undefined && (!String(input.name).trim() || String(input.name).length > 120)) return json(res, 400, { error: 'venue_name_required' });
    if (input.city !== undefined && (!String(input.city).trim() || String(input.city).length > 80)) return json(res, 400, { error: 'venue_city_required' });
    if (input.address !== undefined && (!String(input.address).trim() || String(input.address).length > 240)) return json(res, 400, { error: 'venue_address_required' });
    if (input.format !== undefined && String(input.format).length > 80) return json(res, 400, { error: 'venue_format_too_long' });
    if (input.timezone !== undefined && String(input.timezone).length > 64) return json(res, 400, { error: 'venue_timezone_too_long' });
    if (input.timezone !== undefined && !isValidIanaTimezone(input.timezone)) return json(res, 400, { error: 'invalid_venue_timezone' });
    if (input.phoneNumbers !== undefined && (!Array.isArray(input.phoneNumbers) || input.phoneNumbers.length > 5 || input.phoneNumbers.some((entry) => !entry || !/^\+7[0-9 ()-]{7,24}$/.test(String(entry.number || '').trim())))) return json(res, 400, { error: 'invalid_phone_numbers' }); if (input.phoneNumbers !== undefined && input.phoneNumbers.length && input.phoneNumbers.filter((entry) => entry.primary).length !== 1) return json(res, 400, { error: 'one_primary_phone_required' }); if (input.phone !== undefined && input.phone && !/^\+7[0-9 ()-]{7,24}$/.test(String(input.phone))) return json(res, 400, { error: 'invalid_phone' });
    if (input.logoUrl !== undefined && input.logoUrl !== null && !validImageData(input.logoUrl)) return json(res, 400, { error: 'invalid_logo' });
    if (input.vipRoomMinimums !== undefined && ['vip_room_1', 'vip_room_2'].some((key) => input.vipRoomMinimums?.[key] !== undefined && (!Number.isFinite(Number(input.vipRoomMinimums[key])) || Number(input.vipRoomMinimums[key]) < 0))) return json(res, 400, { error: 'invalid_vip_minimum' });
    if (process.env.DATABASE_URL && !repositories?.pool) return json(res, 503, { error: 'venue_unavailable' });
    const selectedVenueId = repositories?.pool ? venueDbId : currentVenueId;
    if (!input.expectedVenueId) return json(res, 428, { error: 'venue_precondition_required' });
    if (String(input.expectedVenueId) !== String(selectedVenueId)) return json(res, 409, { error: 'venue_context_changed' });
    if (repositories?.pool) {
      const organizationId = requestOrganizationId(req) || null;
      if (process.env.AUTH_REQUIRED === 'true' && !organizationId) return json(res, 403, { error: 'organization_context_required' });
      let client;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT id,name,city,format,phone,phone_numbers AS "phoneNumbers",address,logo_url AS "logoUrl",timezone FROM venues WHERE id=$1 AND ($2::uuid IS NULL OR organization_id=$2::uuid) AND is_active=true FOR UPDATE', [venueDbId, organizationId]);
        if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'venue_not_found' }); }
        const token = requestAuthToken(req);
        if (token) {
          const activeSession = await client.query('SELECT COALESCE(s.active_venue_id,u.venue_id) AS venue_id FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true AND ($2::uuid IS NULL OR u.organization_id=$2::uuid) FOR UPDATE OF s', [hashToken(token), organizationId]);
          if (!activeSession.rows[0]) { await client.query('ROLLBACK'); return json(res, 401, { error: 'session_required' }); }
          if (String(activeSession.rows[0].venue_id) !== String(input.expectedVenueId)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'venue_context_changed' }); }
        } else if (process.env.AUTH_REQUIRED === 'true') { await client.query('ROLLBACK'); return json(res, 401, { error: 'session_required' }); }
        const before = rows[0];
        const incomingPhones = input.phoneNumbers === undefined ? before.phoneNumbers : input.phoneNumbers.map((entry) => ({ label: String(entry.label || 'Дополнительный').trim().slice(0, 32), number: String(entry.number || '').trim(), primary: Boolean(entry.primary) }));
        const next = {
          name: input.name === undefined ? before.name : String(input.name).trim(),
          city: input.city === undefined ? before.city : String(input.city).trim(),
          address: input.address === undefined ? before.address : String(input.address).trim(),
          format: input.format === undefined ? before.format : String(input.format).trim(),
          timezone: input.timezone === undefined ? before.timezone : String(input.timezone).trim(),
          phoneNumbers: incomingPhones,
          phone: input.phoneNumbers !== undefined ? incomingPhones.find((entry) => entry.primary)?.number || '' : input.phone === undefined ? before.phone : String(input.phone).trim(),
          logoUrl: input.logoUrl === undefined ? before.logoUrl : input.logoUrl,
        };
        const updated = await client.query('UPDATE venues SET name=$1,city=$2,format=$3,phone=$4,phone_numbers=$5::jsonb,address=$6,timezone=$7,logo_url=$8 WHERE id=$9 AND ($10::uuid IS NULL OR organization_id=$10::uuid) AND is_active=true RETURNING id,name,city,format,phone,phone_numbers AS "phoneNumbers",address,logo_url AS "logoUrl",timezone', [next.name, next.city, next.format, next.phone, JSON.stringify(next.phoneNumbers || []), next.address, next.timezone, next.logoUrl, venueDbId, organizationId]);
        if (!updated.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'venue_not_found' }); }
        if (input.vipRoomMinimums !== undefined) for (const [key, room] of [['vip_room_1', 'VIP-\u043a\u043e\u043c\u043d\u0430\u0442\u0430 1'], ['vip_room_2', 'VIP-\u043a\u043e\u043c\u043d\u0430\u0442\u0430 2']]) if (input.vipRoomMinimums[key] !== undefined) await client.query('UPDATE tables t SET min_deposit=$1,min_order_total=$1 FROM zones z WHERE t.zone_id=z.id AND z.venue_id=$2 AND t.name=$3', [Math.round(Number(input.vipRoomMinimums[key])), venueDbId, room]);
        const { rows: vipRows } = await client.query('SELECT t.name,t.min_order_total FROM tables t JOIN zones z ON z.id=t.zone_id WHERE z.venue_id=$1 AND t.name IN ($2,$3)', [venueDbId, 'VIP-\u043a\u043e\u043c\u043d\u0430\u0442\u0430 1', 'VIP-\u043a\u043e\u043c\u043d\u0430\u0442\u0430 2']);
        const vipRoomMinimums = { vip_room_1: 1500, vip_room_2: 2500 };
        vipRows.forEach((row) => { if (row.name.endsWith('1')) vipRoomMinimums.vip_room_1 = Number(row.min_order_total); if (row.name.endsWith('2')) vipRoomMinimums.vip_room_2 = Number(row.min_order_total); });
        await client.query('COMMIT');
        const saved = { ...updated.rows[0], vipRoomMinimums };
        recordAudit(req, 'venue.updated', 'venue', saved.id, before, saved);
        return json(res, 200, saved);
      } catch (_) { if (client) await client.query('ROLLBACK').catch(() => {}); return json(res, 503, { error: 'venue_save_failed' }); }
      finally { client?.release(); }
    }
    const before = { ...venue };
    if (input.vipRoomMinimums !== undefined) {
      const values = input.vipRoomMinimums || {};
      for (const key of ['vip_room_1', 'vip_room_2']) if (values[key] !== undefined && (!Number.isFinite(Number(values[key])) || Number(values[key]) < 0)) return json(res, 400, { error: 'invalid_vip_minimum' });
      venue.vipRoomMinimums = { ...venue.vipRoomMinimums, ...Object.fromEntries(['vip_room_1', 'vip_room_2'].filter((key) => values[key] !== undefined).map((key) => [key, Math.round(Number(values[key]))])) };
      floor.flatMap((zone) => zone.tables).forEach((table) => { if (table.id === 'vip-room-1') table.minimumOrderTotal = venue.vipRoomMinimums.vip_room_1; if (table.id === 'vip-room-2') table.minimumOrderTotal = venue.vipRoomMinimums.vip_room_2; });
    }
    const incomingPhones = input.phoneNumbers !== undefined ? input.phoneNumbers.map((entry) => ({ label: String(entry.label || 'Дополнительный').trim().slice(0, 32), number: String(entry.number || '').trim(), primary: Boolean(entry.primary) })) : undefined; if (incomingPhones !== undefined) { venue.phoneNumbers = incomingPhones; venue.phone = incomingPhones.find((entry) => entry.primary)?.number || ''; } Object.assign(venue, Object.fromEntries(['name', 'city', 'format', 'phone', 'address', 'timezone', 'logoUrl'].filter((key) => input[key] !== undefined).map((key) => [key, key === 'logoUrl' ? input[key] : String(input[key]).trim()])));
    const selected = networkVenues.find((item) => item.id === currentVenueId);
    if (selected) Object.assign(selected, { name: venue.name, city: venue.city, address: venue.address, format: venue.format, phone: venue.phone, timezone: venue.timezone, logoUrl: venue.logoUrl, phoneNumbers: venue.phoneNumbers, vipRoomMinimums: { ...venue.vipRoomMinimums } });
    const saved = { ...venue, id: currentVenueId };
    recordAudit(req, 'venue.updated', 'venue', currentVenueId, before, saved); return json(res, 200, saved);
  }
  if (pathname.startsWith('/api/integrations/') && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['diagnostics', 'settings', 'integrations'])) return;
    const key = pathname.split('/').pop(); const item = integrations[key];
    if (!item) return json(res, 404, { error: 'integration_not_found' });
    const requirements = { telegram: ['токен бота', 'чат уведомлений'] };
    return json(res, 200, { key, enabled: Boolean(item.enabled), status: item.status || 'planned', mode: item.mode || 'test', requirements: requirements[key] || ['Реквизиты сервиса'] });
  }
  if (pathname === '/api/integrations') { if (denyUnlessAny(req, res, ['diagnostics', 'settings', 'integrations'])) return; return json(res, 200, integrations); }
  if (pathname === '/api/network/venues' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['settings', 'diagnostics'])) return;
    if (!canManageVenueIdentity(req)) return json(res, 403, { error: 'venue_admin_required' });
    const organizationId = requestOrganizationId(req);
    if (process.env.DATABASE_URL || repositories?.pool) {
      if (!repositories?.pool) return json(res, 503, { error: 'network_unavailable' });
      if (requireOrganizationContext(req, res)) return;
      try { const { rows } = await repositories.pool.query('SELECT id,name,format,city,address,phone,timezone,is_current AS "isCurrent" FROM venues WHERE is_active=true AND organization_id=$1 ORDER BY name', [organizationId]); return json(res, 200, { items: rows.map((row) => ({ ...row, status: 'active', isCurrent: row.id === venueDbId })) }); } catch (_) { return json(res, 503, { error: 'network_unavailable' }); }
    }
    return json(res, 200, { items: networkVenues.filter((item) => item.status !== 'archived').map((item) => ({ ...item, isCurrent: item.id === currentVenueId })) });
  }
  if (pathname === '/api/network/venues' && req.method === 'POST') {
    if (denyUnless(req, res, 'settings')) return;
    if (!canManageVenueIdentity(req)) return json(res, 403, { error: 'venue_admin_required' });
    const input = await body(req); const name = String(input.name || '').trim(); const city = String(input.city || '').trim(); const address = String(input.address || '').trim();
    if (!name || name.length > 120 || !city || city.length > 80 || !address || address.length > 240) return json(res, 400, { error: 'venue_name_city_address_required' });
    const timezone = input.timezone === undefined ? resolveIanaTimezone(venue.timezone) : String(input.timezone).trim();
    if (!isValidIanaTimezone(timezone)) return json(res, 400, { error: 'invalid_venue_timezone' });
    const item = { id: `venue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, format: String(input.format || 'кальян-бар').trim().slice(0, 80), city, address, phone: String(input.phone || '').trim().slice(0, 32), phoneNumbers: [], logoUrl: null, vipRoomMinimums: { vip_room_1: 1500, vip_room_2: 2500 }, timezone, status: 'active', isCurrent: false };
    const organizationId = requestOrganizationId(req);
    if (process.env.DATABASE_URL || repositories?.pool) {
      if (!repositories?.pool) return json(res, 503, { error: 'network_unavailable' });
      if (requireOrganizationContext(req, res)) return;
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const quota = await checkOrganizationQuota(client, organizationId, 'venue');
        if (quota.error) { await client.query('ROLLBACK'); return json(res, quota.status, { error: quota.error, ...(quota.limit ? { limit: quota.limit, used: quota.used } : {}) }); }
        const { rows } = await client.query('INSERT INTO venues (organization_id,name,format,city,address,phone,timezone,is_current) VALUES ($1,$2,$3,$4,$5,$6,$7,false) RETURNING id,name,format,city,address,phone,timezone,is_current AS "isCurrent"', [organizationId, name, item.format, city, address, item.phone || null, item.timezone]);
        await client.query('COMMIT');
        const created = { ...rows[0], status: 'active', isCurrent: false }; recordAudit(req, 'venue.created', 'venue', created.id, null, created); return json(res, 201, created);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 503, { error: 'venue_create_failed' }); }
      finally { client.release(); }
    }
    networkVenues.push(item); recordAudit(req, 'venue.created', 'venue', item.id, null, item); return json(res, 201, item);
  }
  const networkVenuePath = pathname.match(/^\/api\/network\/venues\/([^/]+)$/);
  if (networkVenuePath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'settings')) return;
    if (!canManageVenueIdentity(req)) return json(res, 403, { error: 'venue_admin_required' });
    if (process.env.DATABASE_URL || repositories?.pool) {
      if (!repositories?.pool) return json(res, 503, { error: 'network_unavailable' });
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(networkVenuePath[1])) return json(res, 404, { error: 'venue_not_found' });
      if (requireOrganizationContext(req, res)) return;
      const organizationId = requestOrganizationId(req);
      const input = await body(req);
      if (['name', 'city', 'address'].some((key) => input[key] !== undefined && !String(input[key] || '').trim())) return json(res, 400, { error: 'venue_name_city_address_required' });
      if (input.timezone !== undefined && !isValidIanaTimezone(input.timezone)) return json(res, 400, { error: 'invalid_venue_timezone' });
      const fields = []; const values = [networkVenuePath[1]];
      for (const [column, key, max] of [['name', 'name', 120], ['format', 'format', 80], ['city', 'city', 80], ['address', 'address', 240], ['phone', 'phone', 32], ['timezone', 'timezone', 64]]) if (input[key] !== undefined) { fields.push(`${column}=$${values.length + 1}`); values.push(String(input[key] || '').trim().slice(0, max)); }
      if (!fields.length) return json(res, 400, { error: 'venue_name_city_address_required' });
      values.push(organizationId);
      try { const { rows } = await repositories.pool.query(`UPDATE venues SET ${fields.join(',')} WHERE id=$1 AND organization_id=$${values.length} AND is_active=true RETURNING id,name,format,city,address,phone,timezone`, values); if (!rows[0]) return json(res, 404, { error: 'venue_not_found' }); const updated = { ...rows[0], status: 'active', isCurrent: rows[0].id === venueDbId }; recordAudit(req, 'venue.updated', 'venue', updated.id, null, updated); return json(res, 200, updated); } catch (error) { return json(res, 409, { error: 'venue_update_failed', detail: error.message }); }
    }
    const item = networkVenues.find((entry) => entry.id === networkVenuePath[1]); if (!item || item.status === 'archived') return json(res, 404, { error: 'venue_not_found' });
    const input = await body(req); const before = { ...item };
    if (['name', 'city', 'address'].some((key) => input[key] !== undefined && !String(input[key] || '').trim())) return json(res, 400, { error: 'venue_name_city_address_required' });
    if (input.timezone !== undefined && !isValidIanaTimezone(input.timezone)) return json(res, 400, { error: 'invalid_venue_timezone' });
    for (const [key, max] of [['name', 120], ['city', 80], ['address', 240], ['format', 80], ['phone', 32], ['timezone', 64]]) if (input[key] !== undefined) item[key] = String(input[key] || '').trim().slice(0, max);
    if (!item.name || !item.city || !item.address) return json(res, 400, { error: 'venue_name_city_address_required' });
    if (item.id === currentVenueId) Object.assign(venue, { name: item.name, city: item.city, address: item.address, phone: item.phone, timezone: item.timezone, format: item.format });
    recordAudit(req, 'venue.updated', 'venue', item.id, before, item); return json(res, 200, { ...item, isCurrent: item.id === currentVenueId });
  }
  if (networkVenuePath && req.method === 'DELETE') {
    if (denyUnless(req, res, 'settings')) return;
    if (!canManageVenueIdentity(req)) return json(res, 403, { error: 'venue_admin_required' });
    if (process.env.DATABASE_URL || repositories?.pool) {
      if (!repositories?.pool) return json(res, 503, { error: 'network_unavailable' });
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(networkVenuePath[1])) return json(res, 404, { error: 'venue_not_found' });
      if (requireOrganizationContext(req, res)) return;
      if (networkVenuePath[1] === venueDbId) return json(res, 409, { error: 'current_venue_cannot_be_archived' });
      try { const { rows } = await repositories.pool.query('UPDATE venues SET is_active=false WHERE id=$1 AND organization_id=$2 AND is_active=true RETURNING id,name,format,city,address,phone,timezone', [networkVenuePath[1], requestOrganizationId(req)]); if (!rows[0]) return json(res, 404, { error: 'venue_not_found' }); const archived = { ...rows[0], status: 'archived', isCurrent: false }; recordAudit(req, 'venue.archived', 'venue', archived.id, { status: 'active' }, archived); return json(res, 200, archived); } catch (error) { return json(res, 409, { error: 'venue_archive_failed', detail: error.message }); }
    }
    const item = networkVenues.find((entry) => entry.id === networkVenuePath[1]); if (!item || item.status === 'archived') return json(res, 404, { error: 'venue_not_found' });
    if (item.id === currentVenueId) return json(res, 409, { error: 'current_venue_cannot_be_archived' });
    item.status = 'archived'; recordAudit(req, 'venue.archived', 'venue', item.id, { status: 'active' }, { status: 'archived' }); return json(res, 200, item);
  }
  const networkVenueSelect = pathname.match(/^\/api\/network\/venues\/([^/]+)\/select$/);
  if (networkVenueSelect && req.method === 'POST') {
    if (denyUnless(req, res, 'settings')) return;
    if (process.env.DATABASE_URL || repositories?.pool) {
      if (!repositories?.pool) return json(res, 503, { error: 'network_unavailable' });
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(networkVenueSelect[1])) return json(res, 404, { error: 'venue_not_found' });
      if (requireOrganizationContext(req, res)) return;
      const token = requestAuthToken(req);
      if (!token || !sessionRepository) return json(res, 401, { error: 'session_required' });
      try {
        const client = await repositories.pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query('SELECT id,name,format,city,address,phone,timezone FROM venues WHERE id=$1 AND organization_id=$2 AND is_active=true FOR UPDATE', [networkVenueSelect[1], requestOrganizationId(req)]);
          if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'venue_not_found' }); }
          const selected = { ...rows[0], status: 'active', isCurrent: true };
          const saved = await sessionRepository.setActiveVenue(hashToken(token), selected.id, client);
          if (!saved) { await client.query('ROLLBACK'); return json(res, 401, { error: 'session_required' }); }
          await client.query('COMMIT');
          const previousVenueId = venueDbId;
          venueDbId = selected.id;
          if (req.user) req.user.venueId = selected.id;
          recordAudit(req, 'venue.selected', 'venue', selected.id, { currentVenueId: previousVenueId }, { currentVenueId: selected.id });
          return json(res, 200, selected);
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
      } catch (_) { return json(res, 503, { error: 'venue_select_failed' }); }
    }
    const item = networkVenues.find((entry) => entry.id === networkVenueSelect[1]); if (!item || item.status === 'archived') return json(res, 404, { error: 'venue_not_found' });
    const before = networkVenues.find((entry) => entry.id === currentVenueId); floorByVenueId.set(currentVenueId, floor); currentVenueId = item.id; floor = floorByVenueId.get(currentVenueId) || []; floorByVenueId.set(currentVenueId, floor); Object.assign(venue, { name: item.name, city: item.city, address: item.address, phone: item.phone, phoneNumbers: item.phoneNumbers || [], logoUrl: item.logoUrl || null, timezone: item.timezone, format: item.format, vipRoomMinimums: { ...(item.vipRoomMinimums || { vip_room_1: 1500, vip_room_2: 2500 }) } }); if (req.user) req.user.venueId = item.id;
    recordAudit(req, 'venue.selected', 'venue', item.id, { currentVenueId: before?.id || null }, { currentVenueId: item.id }); return json(res, 200, { ...item, isCurrent: true });
  }
  if (pathname === '/api/finance/categories' && req.method === 'GET') {
    if (denyUnless(req, res, 'finance')) return;
    const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase('ru-RU');
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    if (includeArchived && denyUnless(req, res, 'finance')) return;
    if (repositories?.pool) {
      try {
        const { rows } = await repositories.pool.query(`SELECT c.id,c.name,c.kind,c.active,COUNT(e.id)::int AS "operationCount"
          FROM finance_categories c LEFT JOIN expenses e ON e.venue_id=c.venue_id AND e.category_id=c.id
          WHERE c.venue_id=$1 AND ($2::boolean OR c.active=true) AND ($3::text='' OR c.name ILIKE '%' || $3 || '%')
          GROUP BY c.id ORDER BY c.active DESC,c.kind,lower(c.name),c.id`, [venueDbId, includeArchived, query]);
        return json(res, 200, { items: rows });
      } catch (error) { return json(res, 503, { error: 'finance_categories_unavailable', detail: error.message }); }
    }
    return json(res, 200, { items: financeCategories.filter((item) => (includeArchived || item.active !== false) && (!query || item.name.toLocaleLowerCase('ru-RU').includes(query))).map((item) => ({ ...item, operationCount: manualExpenses.filter((expense) => expense.categoryId === item.id).length })) });
  }
  if (pathname === '/api/finance/categories' && req.method === 'POST') {
    if (denyUnless(req, res, 'finance')) return;
    const input = await body(req); const name = String(input.name || '').trim(); const kind = String(input.kind || 'income');
    if (!name || name.length > 80 || !['income', 'expense'].includes(kind)) return json(res, 400, { error: 'invalid_finance_category' });
    if (repositories?.pool) {
      try { const { rows } = await repositories.pool.query('INSERT INTO finance_categories (venue_id,name,kind) VALUES ($1,$2,$3) RETURNING id,name,kind,active,0::int AS "operationCount"', [venueDbId, name, kind]); recordAudit(req, 'finance_category.created', 'finance_category', rows[0].id, null, rows[0]); return json(res, 201, rows[0]); }
      catch (error) { return json(res, error.code === '23505' ? 409 : 503, { error: error.code === '23505' ? 'finance_category_exists' : 'finance_category_save_failed', detail: error.message }); }
    }
    if (financeCategories.some((item) => item.active && item.kind === kind && item.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) return json(res, 409, { error: 'finance_category_exists' });
    const category = { id: `finance-category-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, kind, active: true };
    financeCategories.push(category); recordAudit(req, 'finance_category.created', 'finance_category', category.id, null, category); return json(res, 201, category);
  }
  const financeCategoryPath = pathname.match(/^\/api\/finance\/categories\/([^/]+)$/);
  if (financeCategoryPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'finance')) return;
    if (repositories?.pool) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(financeCategoryPath[1])) return json(res, 404, { error: 'finance_category_not_found' });
      const input = await body(req); const client = await repositories.pool.connect(); let before = null; let updated = null;
      try {
        await client.query('BEGIN');
        const current = await client.query('SELECT id,name,kind,active FROM finance_categories WHERE id=$1 AND venue_id=$2 FOR UPDATE', [financeCategoryPath[1], venueDbId]);
        if (!current.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'finance_category_not_found' }); }
        before = current.rows[0];
        const name = input.name === undefined ? before.name : String(input.name || '').trim(); const kind = input.kind === undefined ? before.kind : String(input.kind); const active = input.active === undefined ? before.active : input.active;
        if (!name || name.length > 80 || !['income', 'expense'].includes(kind) || typeof active !== 'boolean') { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_finance_category' }); }
        if (before.kind === 'expense' && kind !== 'expense') {
          const usage = await client.query('SELECT 1 FROM expenses WHERE venue_id=$1 AND category_id=$2 LIMIT 1', [venueDbId, before.id]);
          if (usage.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'finance_category_has_expenses' }); }
        }
        const result = await client.query('UPDATE finance_categories SET name=$1,kind=$2,active=$3,updated_at=now() WHERE id=$4 AND venue_id=$5 RETURNING id,name,kind,active', [name,kind,active,before.id,venueDbId]);
        updated = result.rows[0];
        if (name !== before.name) await client.query('UPDATE expenses SET category=$1 WHERE venue_id=$2 AND category_id=$3', [name,venueDbId,before.id]);
        await client.query('COMMIT');
        recordAudit(req, active !== before.active ? active ? 'finance_category.restored' : 'finance_category.archived' : 'finance_category.updated', 'finance_category', updated.id, before, updated);
        return json(res, 200, updated);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, error.code === '23505' ? 409 : 503, { error: error.code === '23505' ? 'finance_category_exists' : 'finance_category_update_failed', detail: error.message }); }
      finally { client.release(); }
    }
    const category = financeCategories.find((item) => item.id === financeCategoryPath[1]); if (!category) return json(res, 404, { error: 'finance_category_not_found' });
    const input = await body(req); const name = input.name === undefined ? category.name : String(input.name || '').trim(); const kind = input.kind === undefined ? category.kind : String(input.kind);
    const active = input.active === undefined ? category.active !== false : input.active;
    if (!name || name.length > 80 || !['income', 'expense'].includes(kind) || typeof active !== 'boolean') return json(res, 400, { error: 'invalid_finance_category' });
    const before = { ...category }; category.name = name; category.kind = kind; category.active = active; recordAudit(req, active !== before.active ? active ? 'finance_category.restored' : 'finance_category.archived' : 'finance_category.updated', 'finance_category', category.id, before, category); return json(res, 200, category);
  }
  if (financeCategoryPath && req.method === 'DELETE') {
    if (denyUnless(req, res, 'finance')) return;
    if (repositories?.pool) { const { rows } = await repositories.pool.query('UPDATE finance_categories SET active=false,updated_at=now() WHERE id=$1 AND venue_id=$2 RETURNING id,name,kind,active', [financeCategoryPath[1],venueDbId]); if (!rows[0]) return json(res, 404, { error: 'finance_category_not_found' }); recordAudit(req, 'finance_category.archived', 'finance_category', rows[0].id, { active: true }, rows[0]); return json(res, 200, rows[0]); }
    const category = financeCategories.find((item) => item.id === financeCategoryPath[1]); if (!category) return json(res, 404, { error: 'finance_category_not_found' });
    category.active = false; recordAudit(req, 'finance_category.archived', 'finance_category', category.id, { active: true }, { active: false }); return json(res, 200, category);
  }
  if (pathname === '/api/metrics') {
    if (isOperationalEmployee(req)) {
      if (!hasPermission(req, 'orders')) return json(res, 200, { employeeView: true });
      if (repositories?.pool) {
        try {
          const { rows } = await repositories.pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE venue_id=$1 AND status IN ('open','in_progress','ready')", [venueDbId]);
          const openOrders = Number(rows[0]?.count || 0);
          return json(res, 200, { employeeView: true, openOrders, pendingOrders: openOrders });
        } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
      }
      const openOrders = orders.filter((order) => ['open', 'in_progress', 'ready'].includes(order.status)).length;
      return json(res, 200, { employeeView: true, openOrders, pendingOrders: openOrders });
    }
    if (repositories?.pool) {
      try {
        const [ordersMetric, discountsMetric, staffMetric, reservationsMetric, stockMetric] = await Promise.all([
          repositories.pool.query(`WITH ${orderPricingSqlCtes}, paid_totals AS (SELECT order_id, COALESCE(SUM(amount) FILTER (WHERE status IN ('paid','partially_paid')),0) AS paid FROM payments GROUP BY order_id) SELECT COUNT(*) FILTER (WHERE o.status IN ('open','in_progress','ready'))::int AS open_orders, COUNT(*) FILTER (WHERE o.status='closed')::int AS closed_orders, COALESCE(SUM(CASE WHEN o.status IN ('open','in_progress','ready') THEN GREATEST(0,GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0))-COALESCE(p.paid,0)) ELSE 0 END),0) AS pending_revenue FROM orders o LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN discount_totals d ON d.order_id=o.id LEFT JOIN paid_totals p ON p.order_id=o.id WHERE o.venue_id=$1`, [venueDbId]),
          repositories.pool.query(`SELECT COUNT(*)::int AS count FROM discounts d JOIN orders o ON o.id=d.order_id WHERE o.venue_id=$1 AND d.status='requested'`, [venueDbId]),
          repositories.pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE venue_id=$1 AND is_active=true`, [venueDbId]),
          repositories.pool.query(`SELECT COUNT(*)::int AS count FROM reservations r JOIN venues v ON v.id=r.venue_id WHERE r.venue_id=$1 AND (r.starts_at AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg'))::date=(now() AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg'))::date AND r.status='confirmed'`, [venueDbId]),
          repositories.pool.query(`WITH stock_balances AS (
            SELECT venue_id,ingredient_id,COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0) AS on_hand
            FROM stock_movements WHERE venue_id=$1 GROUP BY venue_id,ingredient_id
          ) SELECT COUNT(*)::int AS count FROM ingredients i LEFT JOIN stock_balances b ON b.venue_id=i.venue_id AND b.ingredient_id=i.id
            WHERE i.venue_id=$1 AND i.is_marked=true AND i.min_stock > 0 AND COALESCE(b.on_hand,0) <= i.min_stock`, [venueDbId])
        ]);
        const orderRow = ordersMetric.rows[0] || {};
        return json(res, 200, visibleMetrics(req, { openOrders: Number(orderRow.open_orders || 0), pendingOrders: Number(orderRow.open_orders || 0), pendingRevenue: Number(orderRow.pending_revenue || 0), closedOrders: Number(orderRow.closed_orders || 0), discountRequests: Number(discountsMetric.rows[0]?.count || 0), staffActive: Number(staffMetric.rows[0]?.count || 0), reservationsToday: Number(reservationsMetric.rows[0]?.count || 0), lowStock: Number(stockMetric.rows[0]?.count || 0) }));
      } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
    }
    return json(res, 200, visibleMetrics(req, metrics()));
  }
  if (pathname === '/api/analytics' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'finance_read') && !hasPermission(req, 'finance')) return json(res, 403, { error: 'forbidden', permission: 'analytics' });
    const employeeFinanceView = isOperationalEmployee(req); const requestedPeriod = employeeFinanceView ? '1' : String(url.searchParams.get('days') || '7').trim().toLowerCase(); const isAllTime = !employeeFinanceView && (requestedPeriod === 'all' || requestedPeriod === '0'); const requestedDays = Number(requestedPeriod); const analyticsDays = employeeFinanceView ? 1 : (isAllTime ? 365 : Math.min(Math.max(Number.isFinite(requestedDays) ? Math.round(requestedDays) : 7, 3), 90)); const end = new Date(); let venueTimezone = businessTimezone; let endDate = businessDateKey(end); if (repositories?.pool) { try { const { rows } = await repositories.pool.query('SELECT timezone FROM venues WHERE id=$1', [venueDbId]); venueTimezone = String(rows[0]?.timezone || businessTimezone); try { new Intl.DateTimeFormat('en-US', { timeZone: venueTimezone }).format(end); } catch (_) { venueTimezone = businessTimezone; } const localDate = await repositories.pool.query('SELECT (now() AT TIME ZONE $1)::date::text AS date', [venueTimezone]); endDate = localDate.rows[0]?.date || endDate; } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); } } let startDate; if (isAllTime && repositories?.pool) { try { const { rows } = await repositories.pool.query(`SELECT to_char(COALESCE(LEAST((SELECT MIN((closed_at AT TIME ZONE $2)::date) FROM orders WHERE venue_id=$1 AND status='closed'), (SELECT MIN(expense_date) FROM expenses WHERE venue_id=$1 AND source<>'payroll'), (SELECT MIN(period_from) FROM payroll_entries WHERE venue_id=$1 AND status IN ('approved','paid')), (SELECT MIN((o.closed_at AT TIME ZONE $2)::date) FROM order_costs c JOIN orders o ON o.id=c.order_id WHERE c.venue_id=$1)), $3::date), 'YYYY-MM-DD') AS start_date`, [venueDbId, venueTimezone, endDate]); startDate = String(rows[0]?.start_date || endDate).slice(0, 10); } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); } } else { const start = new Date(`${endDate}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - (analyticsDays - 1)); startDate = start.toISOString().slice(0, 10); }
    if (employeeFinanceView && repositories?.pool) {
      try {
        const actorId = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null;
        const { rows } = await repositories.pool.query(`SELECT COALESCE(SUM(p.amount),0) AS revenue, COUNT(DISTINCT o.id)::int AS orders FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.venue_id=$1 AND o.opened_by=$2 AND o.status='closed' AND (o.closed_at AT TIME ZONE $4)::date=$3::date AND p.status IN ('paid','partially_paid')`, [venueDbId, actorId, endDate, venueTimezone]);
        const revenue = Number(rows[0]?.revenue || 0); const ordersCount = Number(rows[0]?.orders || 0); return json(res, 200, { employeeView: true, period: 'today', days: [{ date: endDate, revenue, orders: ordersCount, averageCheck: ordersCount ? revenue / ordersCount : 0 }], totalRevenue: revenue, averageCheck: ordersCount ? revenue / ordersCount : 0, staffDynamics: [], staffSales: [], topProducts: [], byStation: {}, hallLoad: { busy: 0, total: 0 } });
      } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
    }
    if (repositories?.pool) {
      try {
        const [daily, products, hall, staffRows, stationRows, expenseRows, payrollRows, cashOutflowRows, costRows, staffItemRows, checkRows] = await Promise.all([
          repositories.pool.query(`SELECT to_char(d::date,'YYYY-MM-DD') AS date, COALESCE(SUM(p.amount),0) AS revenue, COUNT(DISTINCT o.id)::int AS orders FROM generate_series($2::date,$3::date,'1 day') d LEFT JOIN orders o ON o.venue_id=$1 AND o.status='closed' AND (o.closed_at AT TIME ZONE $4)::date=d::date LEFT JOIN payments p ON p.order_id=o.id AND p.status IN ('paid','partially_paid') GROUP BY d::date ORDER BY d::date`, [venueDbId, startDate, endDate, venueTimezone]),
          repositories.pool.query(`SELECT COALESCE(p.name,'Позиция') AS name, SUM(oi.quantity)::numeric AS quantity FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id WHERE o.venue_id=$1 AND o.status='closed' AND (o.closed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date GROUP BY p.name ORDER BY quantity DESC LIMIT 5`, [venueDbId, startDate, endDate, venueTimezone]),
          repositories.pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.status IN ('occupied','reserved'))::int AS busy FROM tables t JOIN zones z ON z.id=t.zone_id WHERE z.venue_id=$1`, [venueDbId]),
          repositories.pool.query(`SELECT COALESCE(u.full_name,u.login,'Не указан') AS name, COALESCE(SUM(p.amount),0) AS revenue, COUNT(DISTINCT o.id)::int AS orders FROM orders o LEFT JOIN payments p ON p.order_id=o.id AND p.status IN ('paid','partially_paid') LEFT JOIN users u ON u.id=o.opened_by WHERE o.venue_id=$1 AND o.status='closed' AND (o.closed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date GROUP BY u.full_name,u.login ORDER BY revenue DESC`, [venueDbId, startDate, endDate, venueTimezone]),
          repositories.pool.query(`SELECT oi.order_id AS order_id, COALESCE(oi.station,'other') AS station, COALESCE(SUM(oi.quantity * oi.unit_price),0) AS gross FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.venue_id=$1 AND o.status='closed' AND (o.closed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date GROUP BY oi.order_id,COALESCE(oi.station,'other')`, [venueDbId, startDate, endDate, venueTimezone]),
          repositories.pool.query(`SELECT to_char(expense_date,'YYYY-MM-DD') AS date, COALESCE(SUM(amount),0) AS amount FROM expenses e WHERE e.venue_id=$1 AND e.expense_date BETWEEN $2::date AND $3::date AND e.source <> 'purchase' AND e.source <> 'payroll' GROUP BY expense_date`, [venueDbId, startDate, endDate]),
          repositories.pool.query(`SELECT to_char(d::date,'YYYY-MM-DD') AS date, COALESCE(SUM(pe.amount / (pe.period_to - pe.period_from + 1)),0) AS amount FROM payroll_entries pe CROSS JOIN LATERAL generate_series(GREATEST(pe.period_from,$2::date)::timestamp,LEAST(pe.period_to,$3::date)::timestamp,INTERVAL '1 day') d WHERE pe.venue_id=$1 AND pe.status IN ('approved','paid') AND pe.period_from <= $3::date AND pe.period_to >= $2::date GROUP BY d::date`, [venueDbId, startDate, endDate]),
          repositories.pool.query(`SELECT to_char(expense_date,'YYYY-MM-DD') AS date, COALESCE(SUM(amount),0) AS amount FROM expenses e WHERE e.venue_id=$1 AND e.expense_date BETWEEN $2::date AND $3::date AND (e.source <> 'payroll' OR EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=e.venue_id AND pe.expense_id=e.id AND pe.status='paid')) GROUP BY e.expense_date`, [venueDbId, startDate, endDate]),
          repositories.pool.query(`SELECT to_char((o.closed_at AT TIME ZONE $4)::date,'YYYY-MM-DD') AS date, COALESCE(SUM(c.cost),0) AS amount FROM order_costs c JOIN orders o ON o.id=c.order_id AND o.venue_id=c.venue_id WHERE c.venue_id=$1 AND (o.closed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date GROUP BY (o.closed_at AT TIME ZONE $4)::date`, [venueDbId, startDate, endDate, venueTimezone]),
          repositories.pool.query(`SELECT o.id AS order_id, COALESCE(u.full_name,u.login,'Не указан') AS staff_name, COALESCE(p.name,'Позиция') AS product_name, SUM(oi.quantity)::numeric AS quantity, COALESCE(SUM(oi.quantity * oi.unit_price),0)::numeric AS gross FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN users u ON u.id=o.opened_by LEFT JOIN products p ON p.id=oi.product_id WHERE o.venue_id=$1 AND o.status='closed' AND (o.closed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date GROUP BY o.id,COALESCE(u.full_name,u.login,'Не указан'),COALESCE(p.name,'Позиция') ORDER BY staff_name, gross DESC`, [venueDbId, startDate, endDate, venueTimezone]),
          repositories.pool.query(`SELECT o.id AS order_id, to_char((o.closed_at AT TIME ZONE $4)::date,'YYYY-MM-DD') AS date, COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('paid','partially_paid')),0)::numeric AS check_total FROM orders o LEFT JOIN payments p ON p.order_id=o.id WHERE o.venue_id=$1 AND o.status='closed' AND (o.closed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date GROUP BY o.id,o.closed_at ORDER BY o.closed_at`, [venueDbId, startDate, endDate, venueTimezone])
        ]);
        const expenseMap = Object.fromEntries(expenseRows.rows.map((row) => [String(row.date).slice(0, 10), Number(row.amount || 0)])); const payrollMap = Object.fromEntries(payrollRows.rows.map((row) => [String(row.date).slice(0, 10), Number(row.amount || 0)])); const cashOutflowMap = Object.fromEntries(cashOutflowRows.rows.map((row) => [String(row.date).slice(0, 10), Number(row.amount || 0)])); const costsByDate = Object.fromEntries(costRows.rows.map((row) => [String(row.date).slice(0, 10), Number(row.amount || 0)])); const checksByDate = new Map(); for (const row of checkRows.rows) { const key = String(row.date).slice(0, 10); checksByDate.set(key, [...(checksByDate.get(key) || []), Number(row.check_total || 0)]); } const days = daily.rows.map((row) => { const date = String(row.date).slice(0, 10); const revenue = Number(row.revenue || 0); const expenses = (expenseMap[date] || 0) + (payrollMap[date] || 0); const cashOutflow = cashOutflowMap[date] || 0; const costOfGoods = costsByDate[date] || 0; const orders = Number(row.orders || 0); return { date, revenue, expenses, payroll: payrollMap[date] || 0, cashOutflow, costOfGoods, netProfit: revenue - expenses - costOfGoods, orders, averageCheck: orders ? revenue / orders : 0, medianCheck: medianOf(checksByDate.get(date) || []), tables: 0 }; }); const totalRevenue = days.reduce((sum, row) => sum + row.revenue, 0); const totalExpenses = days.reduce((sum, row) => sum + row.expenses, 0); const totalPayroll = days.reduce((sum, row) => sum + row.payroll, 0); const totalCashOutflow = days.reduce((sum, row) => sum + row.cashOutflow, 0); const totalCostOfGoods = days.reduce((sum, row) => sum + row.costOfGoods, 0); const totalOrders = days.reduce((sum, row) => sum + row.orders, 0); const hallRow = hall.rows[0] || {};
        const checkAmountsByOrder = new Map(checkRows.rows.map((row) => [String(row.order_id), Number(row.check_total || 0)])); const staffSalesMap = new Map(); const staffItemsByOrder = new Map(); for (const row of staffItemRows.rows) { const orderId = String(row.order_id); const rows = staffItemsByOrder.get(orderId) || []; rows.push(row); staffItemsByOrder.set(orderId, rows); } for (const [orderId, rows] of staffItemsByOrder) { const staffName = String(rows[0]?.staff_name || 'Не указан'); const entry = staffSalesMap.get(staffName) || { name: staffName, items: [], revenue: 0, orders: 0 }; const allocations = allocateMoneyByGross(rows, checkAmountsByOrder.get(orderId) || 0, (row) => row.product_name, (row) => Number(row.gross || 0)); for (const row of rows) { const name = String(row.product_name || 'Позиция'); const item = entry.items.find((existing) => existing.name === name); const revenue = allocations.get(name) || 0; if (item) { item.quantity += Number(row.quantity || 0); item.revenue += revenue; } else entry.items.push({ name, quantity: Number(row.quantity || 0), revenue }); } staffSalesMap.set(staffName, entry); } for (const row of staffRows.rows) { const name = String(row.name || 'Не указан'); const entry = staffSalesMap.get(name) || { name, items: [], revenue: 0, orders: 0 }; entry.revenue = Number(row.revenue || 0); entry.orders = Number(row.orders || 0); staffSalesMap.set(name, entry); } const stationTotals = new Map(); const stationsByOrder = new Map(); for (const row of stationRows.rows) { const orderId = String(row.order_id); const rows = stationsByOrder.get(orderId) || []; rows.push(row); stationsByOrder.set(orderId, rows); } for (const [orderId, rows] of stationsByOrder) { const allocations = allocateMoneyByGross(rows, checkAmountsByOrder.get(orderId) || 0, (row) => row.station, (row) => Number(row.gross || 0)); for (const row of rows) { const station = String(row.station || 'other'); const entry = stationTotals.get(station) || { revenue: 0, orders: 0 }; entry.revenue += allocations.get(station) || 0; entry.orders += 1; stationTotals.set(station, entry); } } const byStation = Object.fromEntries([...stationTotals].map(([station, row]) => [station, { ...row, averageCheck: row.orders ? row.revenue / row.orders : 0 }])); const fullAnalytics = { days, totalRevenue, totalExpenses, totalPayroll, totalCashOutflow, totalCostOfGoods, netProfit: totalRevenue - totalExpenses - totalCostOfGoods, averageCheck: totalOrders ? totalRevenue / totalOrders : 0, topProducts: products.rows.map((row) => ({ name: row.name, quantity: Number(row.quantity || 0) })), staffDynamics: staffRows.rows.map((row) => ({ name: row.name, revenue: Number(row.revenue || 0), orders: Number(row.orders || 0) })), staffSales: [...staffSalesMap.values()].sort((a, b) => b.revenue - a.revenue), medianCheck: medianOf(checkRows.rows.map((row) => row.check_total)), avgTablesPerDay: 0, byStation, hallLoad: { busy: Number(hallRow.busy || 0), total: Number(hallRow.total || 0) } }; if (employeeFinanceView) return json(res, 200, { employeeView: true, period: 'today', days: days.map((day) => ({ date: day.date, revenue: day.revenue, orders: day.orders, averageCheck: day.orders ? day.revenue / day.orders : 0 })), totalRevenue, averageCheck: fullAnalytics.averageCheck, staffDynamics: [], staffSales: [], topProducts: [], byStation: {}, hallLoad: { busy: 0, total: 0 } }); return json(res, 200, fullAnalytics);
      } catch (error) {
        return json(res, 503, { error: 'database_unavailable', detail: error.message });
      }
    }
    const employeeOrders = employeeFinanceView ? orders.filter((order) => String(order.openedBy || order.openedById || '') === String(req.user?.id || '')) : orders;
    const paidOrderAmount = (order) => (order.payments || []).filter((payment) => ['paid', 'partially_paid'].includes(payment.status)).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const revenueForOrder = (order) => { const paid = paidOrderAmount(order); if (paid > 0) return paid; if (order.finalTotal !== undefined && order.finalTotal !== null) return Number(order.finalTotal); return orderNetTotal(order); };
    const dayKey = (value) => businessDateKey(value);
    const dayDates = recentBusinessDates(analyticsDays);
    const days = dayDates.map((date) => {
      const closed = employeeOrders.filter((order) => order.status === 'closed' && dayKey(order.closedAt || order.createdAt) === date && (!employeeFinanceView || paidOrderAmount(order) > 0));
      const checks = closed.map((order) => employeeFinanceView ? paidOrderAmount(order) : revenueForOrder(order)).sort((a, b) => a - b);
      const revenue = checks.reduce((sum, value) => sum + value, 0);
      const costOfGoods = closed.reduce((sum, order) => sum + Number(order.costOfGoods || 0), 0);
      const medianCheck = checks.length ? (checks.length % 2 ? checks[(checks.length - 1) / 2] : (checks[checks.length / 2 - 1] + checks[checks.length / 2]) / 2) : 0;
      const expenses = manualExpenses.filter((expense) => expense.date === date && !['purchase', 'payroll'].includes(expense.source)).reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
      // Memory has no payroll-entry ledger: observed operating expenses cannot establish full P&L.
      return { date, revenue, operatingExpenses: expenses, expenses: null, payroll: null, cashOutflow: null, costOfGoods, netProfit: null, orders: closed.length, averageCheck: closed.length ? revenue / closed.length : 0, medianCheck, tables: new Set(closed.map((order) => order.tableId).filter(Boolean)).size };
    });
    const counts = new Map();
    employeeOrders.filter((order) => order.status === 'closed' && dayDates.includes(dayKey(order.closedAt || order.createdAt))).flatMap((order) => order.items || []).forEach((item) => { const name = item.name || item.productName || item.productId || 'Позиция'; counts.set(name, (counts.get(name) || 0) + Number(item.quantity || 0)); });
    const totalRevenue = days.reduce((sum, row) => sum + row.revenue, 0);
    const totalExpenses = null;
    const totalOperatingExpenses = days.reduce((sum, row) => sum + row.operatingExpenses, 0);
    const totalCostOfGoods = days.reduce((sum, row) => sum + row.costOfGoods, 0);
    const totalOrders = days.reduce((sum, row) => sum + row.orders, 0);
    const staffMap = new Map(); const staffSalesMap = new Map(); const stationMap = new Map();
employeeOrders.filter((order) => order.status === 'closed' && dayDates.includes(dayKey(order.closedAt || order.createdAt))).forEach((order) => {
  const orderRevenue = employeeFinanceView ? paidOrderAmount(order) : revenueForOrder(order);
  const name = order.createdByName || order.waiterName || 'Не указан'; const row = staffMap.get(name) || { name, revenue: 0, orders: 0 }; row.revenue += orderRevenue; row.orders += 1; staffMap.set(name, row);
  const sales = staffSalesMap.get(name) || { name, items: [], revenue: 0, orders: 0 }; sales.revenue = row.revenue; sales.orders = row.orders;
  const itemsByName = new Map(); for (const item of order.items || []) { const itemName = item.name || item.productName || item.productId || 'Позиция'; const line = itemsByName.get(itemName) || { name: itemName, quantity: 0, gross: 0 }; line.quantity += Number(item.quantity || 0); line.gross += Number(item.unitPrice || item.price || 0) * Number(item.quantity || 0); itemsByName.set(itemName, line); }
  const productLines = [...itemsByName.values()]; const productRevenue = allocateMoneyByGross(productLines, orderRevenue, (item) => item.name, (item) => item.gross);
  for (const item of productLines) { const existing = sales.items.find((entry) => entry.name === item.name); const itemRevenue = productRevenue.get(item.name) || 0; if (existing) { existing.quantity += item.quantity; existing.revenue += itemRevenue; } else sales.items.push({ name: item.name, quantity: item.quantity, revenue: itemRevenue }); }
  staffSalesMap.set(name, sales);
  const itemsByStation = new Map(); for (const item of order.items || []) { const station = item.station || 'other'; itemsByStation.set(station, (itemsByStation.get(station) || 0) + Number(item.unitPrice || item.price || 0) * Number(item.quantity || 0)); }
  const stationLines = [...itemsByStation].map(([station, gross]) => ({ station, gross })); const stationRevenue = allocateMoneyByGross(stationLines, orderRevenue, (item) => item.station, (item) => item.gross);
  for (const [station, amount] of stationRevenue) { const entry = stationMap.get(station) || { revenue: 0, orders: 0 }; entry.revenue += amount; if (stationLines.some((item) => item.station === station)) entry.orders += 1; stationMap.set(station, entry); }
});
const byStation = Object.fromEntries([...stationMap].map(([station, entry]) => [station, { ...entry, averageCheck: entry.orders ? entry.revenue / entry.orders : 0 }])); const tables = floor.flatMap((zone) => zone.tables || []);
    const periodChecks = employeeOrders.filter((order) => order.status === 'closed' && dayDates.includes(dayKey(order.closedAt || order.createdAt)) && (!employeeFinanceView || paidOrderAmount(order) > 0)).map((order) => employeeFinanceView ? paidOrderAmount(order) : revenueForOrder(order));
    const fullAnalytics = { days, totalRevenue, totalExpenses, totalOperatingExpenses, totalPayroll: null, totalCashOutflow: null, payrollCoverage: { status: 'unsupported', reason: 'payroll_requires_database' }, officialReady: false, totalCostOfGoods, netProfit: null, averageCheck: totalOrders ? totalRevenue / totalOrders : 0, topProducts: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, quantity]) => ({ name, quantity })), staffDynamics: [...staffMap.values()].sort((a, b) => b.revenue - a.revenue), staffSales: [...staffSalesMap.values()].sort((a, b) => b.revenue - a.revenue), medianCheck: medianOf(periodChecks), avgTablesPerDay: days.length ? days.reduce((sum, row) => sum + row.tables, 0) / days.length : 0, byStation, hallLoad: { busy: tables.filter((table) => ['occupied', 'reserved'].includes(table.status)).length, total: tables.length } };
    return json(res, 200, employeeFinanceView ? { employeeView: true, period: 'today', days: days.map((day) => ({ date: day.date, revenue: day.revenue, orders: day.orders, averageCheck: day.averageCheck })), totalRevenue, averageCheck: fullAnalytics.averageCheck, staffDynamics: [], staffSales: [], topProducts: [], byStation: {}, hallLoad: { busy: 0, total: 0 } } : fullAnalytics);
  }
  if (pathname === '/api/audit' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'diagnostics') && !hasPermission(req, 'settings')) return json(res, 403, { error: 'forbidden', permission: 'diagnostics' });
    const filters = { action: String(url.searchParams.get('action') || '').trim().slice(0, 120), entityType: String(url.searchParams.get('entityType') || '').trim().slice(0, 80), from: String(url.searchParams.get('from') || '').trim(), to: String(url.searchParams.get('to') || '').trim(), limit: url.searchParams.get('limit') };
    if (filters.from && !/^\d{4}-\d{2}-\d{2}$/.test(filters.from)) filters.from = '';
    if (filters.to && !/^\d{4}-\d{2}-\d{2}$/.test(filters.to)) filters.to = '';
    if (repositories?.audit) { try { return json(res, 200, { items: await repositories.audit.list(venueDbId, filters), filters }); } catch (_) { return json(res, 503, { error: 'audit_unavailable' }); } }
    if (process.env.DATABASE_URL) return json(res, 503, { error: 'audit_unavailable' });
    let items = auditEvents.slice().reverse();
    items = items.filter((item) => String(item.venueId || defaultVenueDbId) === String(venueDbId));
    if (filters.action) items = items.filter((item) => item.action === filters.action);
    if (filters.entityType) items = items.filter((item) => item.entityType === filters.entityType);
    if (filters.from) items = items.filter((item) => String(item.createdAt).slice(0, 10) >= filters.from);
    if (filters.to) items = items.filter((item) => String(item.createdAt).slice(0, 10) <= filters.to);
    items = items.slice(0, Math.min(Math.max(Number(filters.limit) || 100, 1), 300));
    return json(res, 200, { items: items.map(sanitizeAuditEvent), total: items.length, filters });
  }
  const floorTablePath = pathname.match(/^\/api\/floor\/tables\/([^/]+)$/);
  const floorTableLifecyclePath = pathname.match(/^\/api\/floor\/tables\/([^/]+)\/(archive|restore)$/);
  if ((pathname === '/api/floor' || pathname.startsWith('/api/floor/')) && process.env.DATABASE_URL && !repositories?.pool) return json(res, 503, { error: 'floor_unavailable' });
  if (pathname === '/api/floor/zones' && req.method === 'POST') {
    if (denyUnless(req, res, 'settings')) return;
    const input = await body(req); const name = String(input.name || '').trim();
    if (!name || name.length > 80) return json(res, 400, { error: 'invalid_zone_name' });
    const sortOrder = Number.isInteger(Number(input.sortOrder)) ? Number(input.sortOrder) : floor.length;
    return runFloorMutation(req, res, input.expectedVenueId, repositories?.pool ? venueDbId : currentVenueId, async (client) => {
      const nextSortOrder = client && input.sortOrder === undefined ? Number((await client.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM zones WHERE venue_id=$1', [venueDbId])).rows[0].next_order) : sortOrder;
      const zone = client
        ? { ...(await client.query('INSERT INTO zones (venue_id,name,sort_order) VALUES ($1,$2,$3) RETURNING id,name,sort_order', [venueDbId, name, nextSortOrder])).rows[0], tables: [] }
        : { id: `zone-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, sortOrder: nextSortOrder, tables: [] };
      if (!client) floor.push(zone);
      return { status: 201, body: zone, audit: { action: 'floor_zone.created', entityType: 'zone', entityId: zone.id, before: null, after: zone } };
    });
  }
  const floorZonePath = pathname.match(/^\/api\/floor\/zones\/([^/]+)$/);
  if (floorZonePath && ['PATCH', 'DELETE'].includes(req.method)) {
    if (denyUnless(req, res, 'settings')) return;
    const zoneId = decodeURIComponent(floorZonePath[1]);
    if (repositories?.pool && !/^[0-9a-f-]{36}$/i.test(zoneId)) return json(res, 404, { error: 'zone_not_found' });
    const input = await body(req);
    const name = String(input.name || '').trim();
    if (req.method === 'PATCH' && (!name || name.length > 80)) return json(res, 400, { error: 'invalid_zone_name' });
    return runFloorMutation(req, res, input.expectedVenueId, repositories?.pool ? venueDbId : currentVenueId, async (client) => {
      if (client) {
        if (req.method === 'PATCH') {
          const { rows } = await client.query('UPDATE zones SET name=$1,sort_order=COALESCE($2,sort_order) WHERE id=$3 AND venue_id=$4 RETURNING id,name,sort_order', [name, input.sortOrder === undefined ? null : Number(input.sortOrder), zoneId, venueDbId]);
          if (!rows[0]) return { status: 404, body: { error: 'zone_not_found' } };
          return { status: 200, body: rows[0], audit: { action: 'floor_zone.updated', entityType: 'zone', entityId: zoneId, before: null, after: rows[0] } };
        }
        const locked = await client.query('SELECT id FROM zones WHERE id=$1 AND venue_id=$2 FOR UPDATE', [zoneId, venueDbId]);
        if (!locked.rows[0]) return { status: 404, body: { error: 'zone_not_found' } };
        const count = await client.query('SELECT COUNT(*)::int AS count FROM tables t JOIN zones z ON z.id=t.zone_id WHERE z.id=$1 AND z.venue_id=$2', [zoneId, venueDbId]);
        if (Number(count.rows[0]?.count || 0)) return { status: 409, body: { error: 'zone_not_empty' } };
        const { rows } = await client.query('DELETE FROM zones WHERE id=$1 AND venue_id=$2 RETURNING id,name,sort_order', [zoneId, venueDbId]);
        if (!rows[0]) return { status: 404, body: { error: 'zone_not_found' } };
        return { status: 200, body: rows[0], audit: { action: 'floor_zone.deleted', entityType: 'zone', entityId: zoneId, before: rows[0], after: null } };
      }
      const zone = floor.find((entry) => entry.id === zoneId);
      if (!zone) return { status: 404, body: { error: 'zone_not_found' } };
      const before = { ...zone };
      if (req.method === 'PATCH') {
        zone.name = name;
        if (input.sortOrder !== undefined && Number.isInteger(Number(input.sortOrder))) zone.sortOrder = Number(input.sortOrder);
        return { status: 200, body: zone, audit: { action: 'floor_zone.updated', entityType: 'zone', entityId: zone.id, before, after: zone } };
      }
      if (zone.tables.length) return { status: 409, body: { error: 'zone_not_empty' } };
      floor.splice(floor.indexOf(zone), 1);
      return { status: 200, body: zone, audit: { action: 'floor_zone.deleted', entityType: 'zone', entityId: zone.id, before, after: null } };
    });
  }
  if (pathname === '/api/floor/tables' && req.method === 'POST') {
    if (denyUnless(req, res, 'settings')) return;
    const input = await body(req); const zoneId = String(input.zoneId || '').trim(); const name = String(input.name || '').trim(); const capacity = Number(input.capacity || 2); const minCapacity = Number(input.minCapacity ?? capacity); const maxCapacity = Number(input.maxCapacity ?? capacity); const minimumOrderTotal = Number(input.minimumOrderTotal || 0); const requestedLayout = input.layout && typeof input.layout === 'object' && !Array.isArray(input.layout) ? input.layout : {}; const amenities = requestedLayout.amenities && typeof requestedLayout.amenities === 'object' && !Array.isArray(requestedLayout.amenities) ? { playstation5: Boolean(requestedLayout.amenities.playstation5), television: Boolean(requestedLayout.amenities.television) } : { playstation5: false, television: false }; const tableLayout = { amenities };
    if (!zoneId || !name || name.length > 80) return json(res, 400, { error: 'invalid_table_name' });
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100 || !Number.isInteger(minCapacity) || !Number.isInteger(maxCapacity) || minCapacity < 1 || maxCapacity < minCapacity || maxCapacity > 100) return json(res, 400, { error: 'invalid_table_capacity' });
    if (!Number.isFinite(minimumOrderTotal) || minimumOrderTotal < 0) return json(res, 400, { error: 'invalid_vip_minimum' });
    if (repositories?.pool && !/^[0-9a-f-]{36}$/i.test(zoneId)) return json(res, 404, { error: 'zone_not_found' });
    return runFloorMutation(req, res, input.expectedVenueId, repositories?.pool ? venueDbId : currentVenueId, async (client) => {
      if (client) {
        const { rows } = await client.query('INSERT INTO tables (zone_id,name,capacity,min_capacity,max_capacity,min_deposit,min_order_total,layout) SELECT id,$2,$3,$4,$5,$6,$6,$7::jsonb FROM zones WHERE id=$1 AND venue_id=$8 RETURNING id,name,status,capacity,min_capacity,max_capacity,min_order_total,layout,archived_at AS "archivedAt",archive_version AS "archiveVersion"', [zoneId, name, capacity, minCapacity, maxCapacity, minimumOrderTotal, JSON.stringify(tableLayout), venueDbId]);
        if (!rows[0]) return { status: 404, body: { error: 'zone_not_found' } };
        const table = { ...rows[0], archiveVersion: Number(rows[0].archiveVersion || 0), minimumOrderTotal: Number(rows[0].min_order_total), minCapacity: Number(rows[0].min_capacity || rows[0].capacity), maxCapacity: Number(rows[0].max_capacity || rows[0].capacity), layout: rows[0].layout || {} };
        return { status: 201, body: table, audit: { action: 'floor_table.created', entityType: 'table', entityId: table.id, before: null, after: table } };
      }
      const zone = floor.find((entry) => entry.id === zoneId);
      if (!zone) return { status: 404, body: { error: 'zone_not_found' } };
      const table = { id: `table-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, status: 'free', capacity, minCapacity, maxCapacity, minimumOrderTotal, archivedAt: null, archiveVersion: 0, layout: tableLayout };
      zone.tables.push(table);
      return { status: 201, body: table, audit: { action: 'floor_table.created', entityType: 'table', entityId: table.id, before: null, after: table } };
    });
  }
  if (floorTableLifecyclePath && req.method === 'POST') {
    if (denyUnless(req, res, 'settings')) return;
    const [, rawTableId, action] = floorTableLifecyclePath;
    const tableId = decodeURIComponent(rawTableId);
    if (repositories?.pool && !/^[0-9a-f-]{36}$/i.test(tableId)) return json(res, 404, { error: 'table_not_found' });
    const input = await body(req);
    if (!Object.prototype.hasOwnProperty.call(input, 'expectedArchivedAt')) return json(res, 428, { error: 'table_archive_precondition_required' });
    if (!Object.prototype.hasOwnProperty.call(input, 'expectedArchiveVersion')) return json(res, 428, { error: 'table_archive_version_precondition_required' });
    const expectedArchivedAt = input.expectedArchivedAt === null ? null : String(input.expectedArchivedAt);
    if (expectedArchivedAt !== null && (!Number.isFinite(Date.parse(expectedArchivedAt)) || new Date(expectedArchivedAt).toISOString() !== expectedArchivedAt)) return json(res, 400, { error: 'invalid_table_archive_precondition' });
    const expectedArchiveVersion = input.expectedArchiveVersion;
    if (typeof expectedArchiveVersion !== 'number' || !Number.isSafeInteger(expectedArchiveVersion) || expectedArchiveVersion < 0) return json(res, 400, { error: 'invalid_table_archive_version_precondition' });
    return runFloorMutation(req, res, input.expectedVenueId, repositories?.pool ? venueDbId : currentVenueId, async (client) => {
      const now = new Date().toISOString();
      if (client) {
        const { rows } = await client.query(`SELECT t.id,t.name,t.zone_id AS "zoneId",t.archived_at AS "archivedAt",t.archive_version AS "archiveVersion"
          FROM tables t JOIN zones z ON z.id=t.zone_id WHERE t.id=$1 AND z.venue_id=$2 FOR UPDATE OF t`, [tableId, venueDbId]);
        const table = rows[0];
        if (!table) return { status: 404, body: { error: 'table_not_found' } };
        const archivedAt = table.archivedAt ? new Date(table.archivedAt).toISOString() : null;
        const archiveVersion = Number(table.archiveVersion);
        if (action === 'archive') {
          if (archivedAt) {
            if (expectedArchiveVersion !== archiveVersion && expectedArchiveVersion + 1 !== archiveVersion) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt, archiveVersion } };
            if (expectedArchivedAt !== null) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt, archiveVersion } };
            return { status: 200, body: { id: table.id, zoneId: table.zoneId, name: table.name, archivedAt, archiveVersion }, audit: null };
          }
          if (expectedArchiveVersion !== archiveVersion) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt, archiveVersion } };
          if (expectedArchivedAt !== null) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt: null, archiveVersion } };
          const activity = await client.query(`SELECT
            EXISTS(SELECT 1 FROM orders WHERE table_id=$1 AND venue_id=$2 AND status IN ('open','in_progress','ready')) OR
            EXISTS(SELECT 1 FROM reservations r JOIN venues v ON v.id=r.venue_id WHERE r.table_id=$1 AND r.venue_id=$2 AND r.status='confirmed' AND (r.starts_at AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg'))::date=(now() AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg'))::date) AS active`, [tableId, venueDbId]);
          if (activity.rows[0]?.active) return { status: 409, body: { error: 'table_has_live_activity' } };
          const archived = await client.query(`UPDATE tables SET archived_at=date_trunc('milliseconds',now()),archive_version=archive_version+1 WHERE id=$1 AND archived_at IS NULL AND archive_version=$2 RETURNING id,name,zone_id AS "zoneId",archived_at AS "archivedAt",archive_version AS "archiveVersion"`, [tableId, archiveVersion]);
          if (!archived.rows[0]) return { status: 409, body: { error: 'table_archive_state_changed' } };
          const result = { ...archived.rows[0], archivedAt: new Date(archived.rows[0].archivedAt).toISOString(), archiveVersion: Number(archived.rows[0].archiveVersion) };
          return { status: 200, body: result, audit: { action: 'floor_table.archived', entityType: 'table', entityId: tableId, before: { archivedAt: null, archiveVersion }, after: result } };
        }
        if (!archivedAt) {
          if (expectedArchiveVersion !== archiveVersion && expectedArchiveVersion + 1 !== archiveVersion) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt: null, archiveVersion } };
          return { status: 200, body: { id: table.id, zoneId: table.zoneId, name: table.name, archivedAt: null, archiveVersion }, audit: null };
        }
        if (expectedArchiveVersion !== archiveVersion || expectedArchivedAt !== archivedAt) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt, archiveVersion } };
        const restored = await client.query(`UPDATE tables SET archived_at=NULL,archive_version=archive_version+1 WHERE id=$1 AND archived_at=$2::timestamptz AND archive_version=$3 RETURNING id,name,zone_id AS "zoneId",archived_at AS "archivedAt",archive_version AS "archiveVersion"`, [tableId, archivedAt, archiveVersion]);
        if (!restored.rows[0]) return { status: 409, body: { error: 'table_archive_state_changed' } };
        const result = { ...restored.rows[0], archiveVersion: Number(restored.rows[0].archiveVersion) };
        return { status: 200, body: result, audit: { action: 'floor_table.restored', entityType: 'table', entityId: tableId, before: { archivedAt, archiveVersion }, after: result } };
      }
      const zone = floor.find((entry) => entry.tables.some((item) => item.id === tableId));
      const table = zone?.tables.find((item) => item.id === tableId);
      if (!table) return { status: 404, body: { error: 'table_not_found' } };
      const archivedAt = table.archivedAt || null;
      table.archiveVersion = Number(table.archiveVersion || 0);
      if (action === 'archive') {
        if (archivedAt) {
          if (expectedArchiveVersion !== table.archiveVersion && expectedArchiveVersion + 1 !== table.archiveVersion) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt, archiveVersion: table.archiveVersion } };
          if (expectedArchivedAt !== null) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt, archiveVersion: table.archiveVersion } };
          return { status: 200, body: { id: table.id, zoneId: zone.id, name: table.name, archivedAt, archiveVersion: table.archiveVersion }, audit: null };
        }
        if (expectedArchiveVersion !== table.archiveVersion) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt, archiveVersion: table.archiveVersion } };
        if (expectedArchivedAt !== null) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt: null, archiveVersion: table.archiveVersion } };
        const activeOrder = orders.some((order) => order.tableId === tableId && ['open', 'in_progress', 'ready'].includes(order.status));
        const activeReservation = reservations.some((reservation) => reservation.tableId === tableId && reservation.status === 'confirmed' && reservation.date === today());
        if (activeOrder || activeReservation) return { status: 409, body: { error: 'table_has_live_activity' } };
        table.archivedAt = now;
        table.archiveVersion += 1;
        const result = { id: table.id, zoneId: zone.id, name: table.name, archivedAt: now, archiveVersion: table.archiveVersion };
        return { status: 200, body: result, audit: { action: 'floor_table.archived', entityType: 'table', entityId: tableId, before: { archivedAt: null, archiveVersion: table.archiveVersion - 1 }, after: result } };
      }
      if (!archivedAt) {
        if (expectedArchiveVersion !== table.archiveVersion && expectedArchiveVersion + 1 !== table.archiveVersion) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt: null, archiveVersion: table.archiveVersion } };
        return { status: 200, body: { id: table.id, zoneId: zone.id, name: table.name, archivedAt: null, archiveVersion: table.archiveVersion }, audit: null };
      }
      if (expectedArchiveVersion !== table.archiveVersion || expectedArchivedAt !== archivedAt) return { status: 409, body: { error: 'table_archive_state_changed', archivedAt, archiveVersion: table.archiveVersion } };
      table.archivedAt = null;
      table.archiveVersion += 1;
      const result = { id: table.id, zoneId: zone.id, name: table.name, archivedAt: null, archiveVersion: table.archiveVersion };
      return { status: 200, body: result, audit: { action: 'floor_table.restored', entityType: 'table', entityId: tableId, before: { archivedAt, archiveVersion: table.archiveVersion - 1 }, after: result } };
    });
  }
  if (floorTablePath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'settings')) return;
    const input = await body(req);
    const tableId = decodeURIComponent(floorTablePath[1]);
    if (repositories?.pool && !/^[0-9a-f-]{36}$/i.test(tableId)) return json(res, 404, { error: 'table_not_found' });
    const requestedLayout = input.layout && typeof input.layout === 'object' && !Array.isArray(input.layout) ? input.layout : {};
    const layout = { ...requestedLayout };
    if (layout.amenities !== undefined) {
      if (!layout.amenities || typeof layout.amenities !== 'object' || Array.isArray(layout.amenities)) return json(res, 400, { error: 'invalid_table_amenities' });
      layout.amenities = { playstation5: Boolean(layout.amenities.playstation5), television: Boolean(layout.amenities.television) };
    }
    for (const key of ['x', 'y', 'width', 'height', 'rotation']) if (layout[key] !== undefined && (!Number.isFinite(Number(layout[key])) || Number(layout[key]) < 0 || Number(layout[key]) > 5000)) return json(res, 400, { error: 'invalid_table_layout' });
    if (layout.unit !== undefined && !['px', 'grid'].includes(String(layout.unit))) return json(res, 400, { error: 'invalid_table_layout_unit' });
    if (layout.shape !== undefined && !['rectangle', 'square', 'circle', 'oval', 'freeform'].includes(String(layout.shape))) return json(res, 400, { error: 'invalid_table_shape' });
    if (layout.width !== undefined && Number(layout.width) < 40 || layout.height !== undefined && Number(layout.height) < 40) return json(res, 400, { error: 'table_layout_too_small' });
    const changes = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name || name.length > 80) return json(res, 400, { error: 'invalid_table_name' });
      changes.name = name;
    }
    if (input.capacity !== undefined || input.minCapacity !== undefined || input.maxCapacity !== undefined) {
      const capacity = Number(input.capacity ?? input.maxCapacity ?? input.minCapacity);
      const minCapacity = Number(input.minCapacity ?? capacity);
      const maxCapacity = Number(input.maxCapacity ?? capacity);
      if (![capacity, minCapacity, maxCapacity].every(Number.isInteger) || capacity < 1 || capacity > 100 || minCapacity < 1 || maxCapacity < minCapacity || maxCapacity > 100) return json(res, 400, { error: 'invalid_table_capacity' });
      Object.assign(changes, { capacity, minCapacity, maxCapacity });
    }
    if (input.minimumOrderTotal !== undefined) {
      const minimum = Number(input.minimumOrderTotal);
      if (!Number.isFinite(minimum) || minimum < 0) return json(res, 400, { error: 'invalid_vip_minimum' });
      changes.minimumOrderTotal = minimum;
    }
    if (input.status !== undefined) {
      if (!['free', 'blocked'].includes(String(input.status))) return json(res, 400, { error: 'invalid_table_status' });
      changes.status = String(input.status);
    }
    if (Object.keys(layout).length) changes.layout = layout;
    if (!Object.keys(changes).length) return json(res, 400, { error: 'table_changes_required' });
    return runFloorMutation(req, res, input.expectedVenueId, repositories?.pool ? venueDbId : currentVenueId, async (client) => {
      if (client) {
        const locked = await client.query('SELECT t.id,t.status::text AS status,t.archived_at AS "archivedAt" FROM tables t JOIN zones z ON z.id=t.zone_id WHERE t.id=$1 AND z.venue_id=$2 FOR UPDATE OF t', [tableId, venueDbId]);
        if (!locked.rows[0]) return { status: 404, body: { error: 'table_not_found' } };
        if (locked.rows[0].archivedAt) return { status: 409, body: { error: 'table_archived' } };
        if (changes.status === 'blocked') {
          const activity = await client.query("SELECT EXISTS(SELECT 1 FROM orders WHERE table_id=$1 AND status IN ('open','in_progress','ready')) OR EXISTS(SELECT 1 FROM reservations r WHERE r.table_id=$1 AND r.status='confirmed' AND (r.starts_at AT TIME ZONE COALESCE(NULLIF((SELECT timezone FROM venues WHERE id=$2),''),'Asia/Yekaterinburg'))::date=(now() AT TIME ZONE COALESCE(NULLIF((SELECT timezone FROM venues WHERE id=$2),''),'Asia/Yekaterinburg'))::date) AS active", [tableId, venueDbId]);
          if (activity.rows[0]?.active) return { status: 409, body: { error: 'table_has_live_activity' } };
        }
        const fields = [];
        const values = [];
        const set = (column, value) => { values.push(value); fields.push(`${column}=$${values.length}`); };
        if (changes.name !== undefined) set('name', changes.name);
        if (changes.capacity !== undefined) { set('capacity', changes.capacity); set('min_capacity', changes.minCapacity); set('max_capacity', changes.maxCapacity); }
        if (changes.minimumOrderTotal !== undefined) { set('min_deposit', changes.minimumOrderTotal); set('min_order_total', changes.minimumOrderTotal); }
        if (changes.status !== undefined) set('status', changes.status);
        if (changes.layout !== undefined) { values.push(JSON.stringify(changes.layout)); fields.push(`layout=COALESCE(t.layout,'{}'::jsonb) || $${values.length}::jsonb`); }
        values.push(tableId, venueDbId);
        const { rows } = await client.query(`UPDATE tables t SET ${fields.join(',')} FROM zones z WHERE t.id=$${values.length - 1} AND t.zone_id=z.id AND z.venue_id=$${values.length} RETURNING t.id,t.name,t.status,t.capacity,t.min_capacity,t.max_capacity,t.min_order_total,t.layout`, values);
        if (!rows[0]) return { status: 404, body: { error: 'table_not_found' } };
        const table = { ...rows[0], minimumOrderTotal: Number(rows[0].min_order_total), minCapacity: Number(rows[0].min_capacity || rows[0].capacity), maxCapacity: Number(rows[0].max_capacity || rows[0].capacity), layout: rows[0].layout || {} };
        return { status: 200, body: table, audit: { action: 'floor_table.updated', entityType: 'table', entityId: tableId, before: null, after: table } };
      }
      const table = floor.flatMap((zone) => zone.tables).find((entry) => entry.id === tableId);
      if (!table) return { status: 404, body: { error: 'table_not_found' } };
      if (table.archivedAt) return { status: 409, body: { error: 'table_archived' } };
      if (changes.status === 'blocked') {
        const activeOrder = orders.some((order) => order.tableId === tableId && ['open', 'in_progress', 'ready'].includes(order.status));
        const activeReservation = reservations.some((reservation) => reservation.tableId === tableId && reservation.status === 'confirmed' && reservation.date === today());
        if (activeOrder || activeReservation) return { status: 409, body: { error: 'table_has_live_activity' } };
      }
      const before = { ...table, layout: { ...(table.layout || {}) } };
      Object.assign(table, changes);
      if (changes.layout !== undefined) table.layout = { ...before.layout, ...changes.layout };
      return { status: 200, body: table, audit: { action: 'floor_table.updated', entityType: 'table', entityId: tableId, before, after: table } };
    });
  }
  if (floorTablePath && req.method === 'DELETE') {
    if (denyUnless(req, res, 'settings')) return;
    const input = await body(req);
    const tableId = decodeURIComponent(floorTablePath[1]);
    if (repositories?.pool && !/^[0-9a-f-]{36}$/i.test(tableId)) return json(res, 404, { error: 'table_not_found' });
    return runFloorMutation(req, res, input.expectedVenueId, repositories?.pool ? venueDbId : currentVenueId, async (client) => {
      if (client) {
        const locked = await client.query('SELECT t.id,t.archived_at AS "archivedAt" FROM tables t JOIN zones z ON z.id=t.zone_id WHERE t.id=$1 AND z.venue_id=$2 FOR UPDATE OF t', [tableId, venueDbId]);
        if (!locked.rows[0]) return { status: 404, body: { error: 'table_not_found' } };
        if (locked.rows[0].archivedAt) return { status: 409, body: { error: 'table_archived' } };
        const active = await client.query("SELECT 1 FROM orders WHERE table_id=$1 AND venue_id=$2 AND status IN ('open','in_progress','ready') LIMIT 1", [tableId, venueDbId]);
        if (active.rows[0]) return { status: 409, body: { error: 'table_in_use' } };
        const history = await client.query('SELECT EXISTS(SELECT 1 FROM orders WHERE table_id=$1) OR EXISTS(SELECT 1 FROM reservations WHERE table_id=$1) AS referenced', [tableId]);
        if (history.rows[0]?.referenced) return { status: 409, body: { error: 'table_has_history' } };
        let rows;
        try {
          ({ rows } = await client.query('DELETE FROM tables WHERE id=$1 AND zone_id IN (SELECT id FROM zones WHERE venue_id=$2) RETURNING id,name,zone_id', [tableId, venueDbId]));
        } catch (error) {
          if (error.code === '23503') return { status: 409, body: { error: 'table_has_history' } };
          throw error;
        }
        if (!rows[0]) return { status: 404, body: { error: 'table_not_found' } };
        return { status: 200, body: rows[0], audit: { action: 'floor_table.deleted', entityType: 'table', entityId: tableId, before: rows[0], after: null } };
      }
      const zone = floor.find((entry) => entry.tables.some((table) => table.id === tableId));
      const table = zone?.tables.find((entry) => entry.id === tableId);
      if (!table) return { status: 404, body: { error: 'table_not_found' } };
      if (table.archivedAt) return { status: 409, body: { error: 'table_archived' } };
      if (orders.some((order) => order.tableId === tableId && ['open', 'in_progress', 'ready'].includes(order.status))) return { status: 409, body: { error: 'table_in_use' } };
      if (orders.some((order) => order.tableId === tableId) || reservations.some((reservation) => reservation.tableId === tableId)) return { status: 409, body: { error: 'table_has_history' } };
      zone.tables.splice(zone.tables.indexOf(table), 1);
      return { status: 200, body: table, audit: { action: 'floor_table.deleted', entityType: 'table', entityId: tableId, before: table, after: null } };
    });
  }
  if (pathname === '/api/floor') {
    if (denyUnless(req, res, 'floor')) return;
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    if (includeArchived && denyUnless(req, res, 'settings')) return;
    if (repositories?.pool) {
      if (requireOrganizationContext(req, res)) return;
      try {
        const organizationId = requestOrganizationId(req) || null;
        const selected = await repositories.pool.query('SELECT id FROM venues WHERE id=$1 AND ($2::uuid IS NULL OR organization_id=$2::uuid) AND is_active=true', [venueDbId, organizationId]);
        if (!selected.rows[0]) return json(res, 404, { error: 'venue_not_found' });
      } catch (_) { return json(res, 503, { error: 'floor_unavailable' }); }
    }
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query(`SELECT z.id AS zone_id,z.name AS zone_name,z.sort_order,t.id,t.name,t.archived_at AS "archivedAt",t.archive_version AS "archiveVersion",CASE WHEN t.status='blocked'::table_status THEN 'blocked' WHEN EXISTS (SELECT 1 FROM orders o WHERE o.table_id=t.id AND o.venue_id=$1 AND o.status IN ('open','in_progress','ready')) THEN 'occupied' WHEN EXISTS (SELECT 1 FROM reservations r JOIN venues v ON v.id=r.venue_id WHERE r.table_id=t.id AND r.venue_id=$1 AND r.status='confirmed' AND (r.starts_at AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg'))::date=(now() AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg'))::date) THEN 'reserved' ELSE CASE WHEN t.status='reserved'::table_status THEN 'free'::table_status ELSE t.status END END AS status,t.capacity,t.min_capacity,t.max_capacity,t.min_order_total,t.layout FROM zones z LEFT JOIN tables t ON t.zone_id=z.id AND ($2::boolean OR t.archived_at IS NULL) WHERE z.venue_id=$1 ORDER BY z.sort_order,CASE WHEN regexp_replace(t.name, '\\D', '', 'g') ~ '^[0-9]{1,9}$' THEN regexp_replace(t.name, '\\D', '', 'g')::int END NULLS LAST,t.name`, [venueDbId, includeArchived]); const zones = []; for (const row of rows) { let zone = zones.find((entry) => entry.id === row.zone_id); if (!zone) { zone = { id: row.zone_id, name: row.zone_name, tables: [] }; zones.push(zone); } if (row.id) zone.tables.push({ id: row.id, name: row.name, status: row.status, capacity: row.capacity, minCapacity: Number(row.min_capacity || row.capacity), maxCapacity: Number(row.max_capacity || row.capacity), minimumOrderTotal: Number(row.min_order_total), layout: row.layout || {}, archivedAt: row.archivedAt ? new Date(row.archivedAt).toISOString() : null, archiveVersion: Number(row.archiveVersion || 0) }); } return json(res, 200, { venueId: venueDbId, zones }); } catch (_) { return json(res, 503, { error: 'floor_unavailable' }); } }
    const derivedFloor = floor.map((zone) => ({ ...zone, tables: zone.tables.filter((table) => includeArchived || !table.archivedAt).map((table) => { const reservation = reservations.find((entry) => entry.tableId === table.id && entry.status === 'confirmed' && entry.date === today()); const occupied = orders.some((order) => order.tableId === table.id && ['open', 'in_progress', 'ready'].includes(order.status)); return { ...table, archivedAt: table.archivedAt || null, archiveVersion: Number(table.archiveVersion || 0), status: table.status === 'blocked' ? 'blocked' : (occupied ? 'occupied' : reservation ? 'reserved' : table.status === 'reserved' ? 'free' : table.status), reservation: reservation ? { id: reservation.id, guestName: reservation.guestName, date: reservation.date, time: reservation.time, createdByName: reservation.createdByName || 'Сотрудник', createdByRole: reservation.createdByRole || 'Сотрудник' } : null }; }) }));
    return json(res, 200, { venueId: currentVenueId, zones: derivedFloor });
  }
  const tobaccoCatalogPath = pathname.match(/^\/api\/tobacco-catalog\/([^/]+)$/);
  const tobaccoCatalogActor = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null;
  const tobaccoCatalogOrganizationId = requestOrganizationId(req) || (repositories?.pool ? '' : saasAccount.id);
  const tobaccoCatalogVenueId = req.user?.venueId || venueDbId || venue.id;
  const normalizeTobaccoCatalogInput = (raw, current = {}) => {
    const take = (key, max, nullable = false) => {
      const value = raw[key] === undefined ? current[key] : raw[key];
      if (value === null || value === undefined || String(value).trim() === '') return nullable ? null : '';
      const text = String(value).trim();
      if (text.length > max) throw new Error('invalid_tobacco_catalog_item');
      return text;
    };
    const brand = take('brand',120); const flavor = take('flavor',160);
    const productLine = take('productLine',120,true); const productType = raw.productType === undefined ? (current.productType || 'tobacco') : String(raw.productType);
    const packageRaw = raw.packageGrams === undefined ? current.packageGrams : raw.packageGrams;
    const packageGrams = packageRaw === '' || packageRaw === null || packageRaw === undefined ? null : Number(packageRaw);
    const aliasesRaw = raw.aliases === undefined ? current.aliases : raw.aliases;
    const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : typeof aliasesRaw === 'string' ? aliasesRaw.split(',') : [];
    const normalizedAliases = [...new Set(aliases.map((value) => String(value).trim()).filter(Boolean))];
    if (!brand || !flavor || !['tobacco','tobacco_free'].includes(productType) || (packageGrams !== null && (!Number.isFinite(packageGrams) || packageGrams <= 0 || packageGrams > 100000)) || normalizedAliases.length > 20 || normalizedAliases.some((value) => value.length > 80)) throw new Error('invalid_tobacco_catalog_item');
    const active = raw.active === undefined ? (current.active === undefined ? true : current.active) : raw.active;
    if (typeof active !== 'boolean') throw new Error('invalid_tobacco_catalog_item');
    return { brand, productLine, flavor, productType, packageGrams, strength: take('strength',80,true), country: take('country',80,true), leafType: take('leafType',100,true), barcode: take('barcode',64,true), aliases: normalizedAliases, description: take('description',1200), active };
  };
  if (pathname === '/api/tobacco-catalog' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['inventory_read','inventory'])) return;
    if (requireOrganizationContext(req, res)) return;
    const status = ['active','archived','all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'active';
    const scope = ['organization','venue'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : '';
    const query = String(url.searchParams.get('q') || '').trim().slice(0,120);
    if (repositories?.tobaccoCatalog) {
      try { return json(res,200,{ items: await repositories.tobaccoCatalog.list(tobaccoCatalogOrganizationId,tobaccoCatalogVenueId,{status,scope,query}) }); }
      catch (error) { return json(res,503,{error:'tobacco_catalog_unavailable',detail:error.message}); }
    }
    if (process.env.AUTH_REQUIRED === 'true') return json(res,503,{error:'tobacco_catalog_unavailable'});
    const normalizedQuery = query.toLocaleLowerCase('ru-RU');
    const items = tobaccoCatalogItems.filter((item) => item.organizationId === tobaccoCatalogOrganizationId && (item.scope === 'organization' || item.venueId === tobaccoCatalogVenueId) && (status === 'all' || (status === 'archived' ? !item.active : item.active)) && (!scope || item.scope === scope) && (!normalizedQuery || [item.brand,item.productLine,item.flavor,item.barcode,...item.aliases].join(' ').toLocaleLowerCase('ru-RU').includes(normalizedQuery))).sort((a,b) => `${a.brand} ${a.productLine || ''} ${a.flavor}`.localeCompare(`${b.brand} ${b.productLine || ''} ${b.flavor}`,'ru'));
    return json(res,200,{items});
  }
  if (pathname === '/api/tobacco-catalog' && req.method === 'POST') {
    if (denyUnless(req,res,'inventory')) return;
    if (requireOrganizationContext(req,res)) return;
    if (repositories?.pool && (!/^[0-9a-f-]{36}$/i.test(tobaccoCatalogVenueId) || !/^[0-9a-f-]{36}$/i.test(tobaccoCatalogOrganizationId))) return json(res,403,{error:'organization_context_required'});
    let input; try { input = await body(req); } catch (_) { return json(res,400,{error:'invalid_tobacco_catalog_item'}); }
    const scope = input.scope === 'organization' ? 'organization' : input.scope === 'venue' ? 'venue' : '';
    if (!scope) return json(res,400,{error:'invalid_tobacco_catalog_scope'});
    if (scope === 'organization' && !canManageVenueIdentity(req)) return json(res,403,{error:'tobacco_catalog_network_admin_required'});
    let item; try { item = normalizeTobaccoCatalogInput(input); } catch (_) { return json(res,400,{error:'invalid_tobacco_catalog_item'}); }
    if (repositories?.tobaccoCatalog) {
      try { const created = await repositories.tobaccoCatalog.create({ ...item,scope,organizationId:tobaccoCatalogOrganizationId,venueId:tobaccoCatalogVenueId,actorId:tobaccoCatalogActor }); recordAudit(req,'tobacco_catalog.created','tobacco_catalog_item',created.id,null,created); return json(res,201,created); }
      catch (error) { if (error.code === '23505') return json(res,409,{error:'tobacco_catalog_duplicate'}); if (error.message === 'tobacco_catalog_venue_not_found') return json(res,404,{error:error.message}); return json(res,503,{error:'tobacco_catalog_create_failed',detail:error.message}); }
    }
    if (process.env.AUTH_REQUIRED === 'true') return json(res,503,{error:'tobacco_catalog_unavailable'});
    const duplicate = tobaccoCatalogItems.some((entry) => entry.active && entry.scope === scope && entry.organizationId === tobaccoCatalogOrganizationId && (scope === 'organization' || entry.venueId === tobaccoCatalogVenueId) && entry.brand.toLocaleLowerCase('ru-RU') === item.brand.toLocaleLowerCase('ru-RU') && (entry.productLine || '').toLocaleLowerCase('ru-RU') === (item.productLine || '').toLocaleLowerCase('ru-RU') && entry.flavor.toLocaleLowerCase('ru-RU') === item.flavor.toLocaleLowerCase('ru-RU') && entry.productType === item.productType && Number(entry.packageGrams || 0) === Number(item.packageGrams || 0));
    if (duplicate) return json(res,409,{error:'tobacco_catalog_duplicate'});
    const created = {id:`tobacco-${Date.now()}-${Math.random().toString(16).slice(2,8)}`,organizationId:tobaccoCatalogOrganizationId,scope,venueId:scope === 'venue' ? tobaccoCatalogVenueId : null,...item,createdBy:tobaccoCatalogActor,updatedBy:tobaccoCatalogActor,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; tobaccoCatalogItems.push(created); recordAudit(req,'tobacco_catalog.created','tobacco_catalog_item',created.id,null,created); return json(res,201,created);
  }
  if (tobaccoCatalogPath && (req.method === 'GET' || req.method === 'PATCH')) {
    if (req.method === 'PATCH' && denyUnless(req,res,'inventory')) return;
    if (req.method === 'GET' && denyUnlessAny(req,res,['inventory_read','inventory'])) return;
    if (requireOrganizationContext(req,res)) return;
    const id = decodeURIComponent(tobaccoCatalogPath[1]);
    if (repositories?.tobaccoCatalog) {
      if (req.method === 'GET') { try { const item=await repositories.tobaccoCatalog.get(tobaccoCatalogOrganizationId,tobaccoCatalogVenueId,id); return item ? json(res,200,item) : json(res,404,{error:'tobacco_catalog_item_not_found'}); } catch (error) { return json(res,503,{error:'tobacco_catalog_unavailable',detail:error.message}); } }
      let raw; try { raw = await body(req); } catch (_) { return json(res,400,{error:'invalid_tobacco_catalog_item'}); }
      let current; try { current = await repositories.tobaccoCatalog.get(tobaccoCatalogOrganizationId,tobaccoCatalogVenueId,id); } catch (error) { return json(res,503,{error:'tobacco_catalog_unavailable',detail:error.message}); }
      if (!current) return json(res,404,{error:'tobacco_catalog_item_not_found'});
      if (current.scope === 'organization' && !canManageVenueIdentity(req)) return json(res,403,{error:'tobacco_catalog_network_admin_required'});
      let updated; try { updated = normalizeTobaccoCatalogInput(raw,current); } catch (_) { return json(res,400,{error:'invalid_tobacco_catalog_item'}); }
      try { const saved=await repositories.tobaccoCatalog.update(tobaccoCatalogOrganizationId,tobaccoCatalogVenueId,id,updated,tobaccoCatalogActor); if (!saved) return json(res,404,{error:'tobacco_catalog_item_not_found'}); recordAudit(req,updated.active ? 'tobacco_catalog.updated':'tobacco_catalog.archived','tobacco_catalog_item',id,current,saved); return json(res,200,saved); }
      catch (error) { return json(res,error.code === '23505' ? 409 : 503,{error:error.code === '23505' ? 'tobacco_catalog_duplicate':'tobacco_catalog_update_failed',detail:error.message}); }
    }
    if (process.env.AUTH_REQUIRED === 'true') return json(res,503,{error:'tobacco_catalog_unavailable'});
    const current=tobaccoCatalogItems.find((entry)=>entry.id===id&&entry.organizationId===tobaccoCatalogOrganizationId&&(entry.scope==='organization'||entry.venueId===tobaccoCatalogVenueId)); if (!current) return json(res,404,{error:'tobacco_catalog_item_not_found'});
    if (req.method === 'GET') return json(res,200,current);
    if (current.scope === 'organization' && !canManageVenueIdentity(req)) return json(res,403,{error:'tobacco_catalog_network_admin_required'});
    let raw; try { raw=await body(req); } catch (_) { return json(res,400,{error:'invalid_tobacco_catalog_item'}); }
    let updated; try { updated=normalizeTobaccoCatalogInput(raw,current); } catch (_) { return json(res,400,{error:'invalid_tobacco_catalog_item'}); }
    const duplicate=tobaccoCatalogItems.some((entry)=>entry.id!==id&&entry.active&&updated.active&&entry.scope===current.scope&&entry.organizationId===current.organizationId&&(current.scope==='organization'||entry.venueId===current.venueId)&&entry.brand.toLocaleLowerCase('ru-RU')===updated.brand.toLocaleLowerCase('ru-RU')&&(entry.productLine||'').toLocaleLowerCase('ru-RU')===(updated.productLine||'').toLocaleLowerCase('ru-RU')&&entry.flavor.toLocaleLowerCase('ru-RU')===updated.flavor.toLocaleLowerCase('ru-RU')&&entry.productType===updated.productType&&Number(entry.packageGrams||0)===Number(updated.packageGrams||0)); if (duplicate) return json(res,409,{error:'tobacco_catalog_duplicate'});
    Object.assign(current,updated,{updatedBy:tobaccoCatalogActor,updatedAt:new Date().toISOString()}); recordAudit(req,updated.active?'tobacco_catalog.updated':'tobacco_catalog.archived','tobacco_catalog_item',id,null,current); return json(res,200,current);
  }
  const alcoholCatalogPath = pathname.match(/^\/api\/alcohol-catalog\/([^/]+)$/);
  const alcoholCatalogActor = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null;
  const alcoholCatalogOrganizationId = requestOrganizationId(req) || (repositories?.pool ? '' : saasAccount.id);
  const alcoholCatalogVenueId = req.user?.venueId || venueDbId || venue.id;
  const normalizeAlcoholCatalogInput = (raw, current = {}) => {
    const take = (key, max, nullable = false) => {
      const value = raw[key] === undefined ? current[key] : raw[key];
      if (value === null || value === undefined || String(value).trim() === '') return nullable ? null : '';
      const text = String(value).trim(); if (text.length > max) throw new Error('invalid_alcohol_catalog_item'); return text;
    };
    const brand=take('brand',120), name=take('name',160), productLine=take('productLine',120,true);
    const spiritType=raw.spiritType===undefined?(current.spiritType||''):String(raw.spiritType).trim();
    const spiritSubtype=take('spiritSubtype',100,true);
    const abvRaw=raw.abv===undefined?current.abv:raw.abv, bottleRaw=raw.bottleMl===undefined?current.bottleMl:raw.bottleMl, ageRaw=raw.ageYears===undefined?current.ageYears:raw.ageYears;
    const abv=abvRaw===''||abvRaw===null||abvRaw===undefined?null:Number(abvRaw), bottleMl=bottleRaw===''||bottleRaw===null||bottleRaw===undefined?null:Number(bottleRaw), ageYears=ageRaw===''||ageRaw===null||ageRaw===undefined?null:Number(ageRaw);
    const aliasesRaw=raw.aliases===undefined?current.aliases:raw.aliases, aliases=Array.isArray(aliasesRaw)?aliasesRaw:typeof aliasesRaw==='string'?aliasesRaw.split(','):[];
    const normalizedAliases=[...new Set(aliases.map(value=>String(value).trim()).filter(Boolean))];
    const active=raw.active===undefined?(current.active===undefined?true:current.active):raw.active;
    if (!brand||!name||!['whisky','vodka','rum','tequila','gin','cognac','brandy','liqueur','other'].includes(spiritType)||(abv!==null&&(!Number.isFinite(abv)||abv<0||abv>100))||(bottleMl!==null&&(!Number.isFinite(bottleMl)||bottleMl<=0||bottleMl>100000))||(ageYears!==null&&(!Number.isFinite(ageYears)||ageYears<0||ageYears>200))||normalizedAliases.length>20||normalizedAliases.some(value=>value.length>80)||typeof active!=='boolean') throw new Error('invalid_alcohol_catalog_item');
    return {brand,productLine,name,spiritType,spiritSubtype,country:take('country',80,true),abv,bottleMl,ageYears,barcode:take('barcode',64,true),aliases:normalizedAliases,description:take('description',1200),active};
  };
  if (pathname==='/api/alcohol-catalog' && req.method==='GET') {
    if (denyUnlessAny(req,res,['inventory_read','inventory'])) return;
    if (requireOrganizationContext(req,res)) return;
    const status=['active','archived','all'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'active';
    const scope=['organization','venue'].includes(url.searchParams.get('scope'))?url.searchParams.get('scope'):'';
    const query=String(url.searchParams.get('q')||'').trim().slice(0,120);
    if (repositories?.alcoholCatalog) { try { return json(res,200,{items:await repositories.alcoholCatalog.list(alcoholCatalogOrganizationId,alcoholCatalogVenueId,{status,scope,query})}); } catch(error) { return json(res,503,{error:'alcohol_catalog_unavailable',detail:error.message}); } }
    if (process.env.AUTH_REQUIRED==='true') return json(res,503,{error:'alcohol_catalog_unavailable'});
    const q=query.toLocaleLowerCase('ru-RU'); const items=alcoholCatalogItems.filter(item=>item.organizationId===alcoholCatalogOrganizationId&&(item.scope==='organization'||item.venueId===alcoholCatalogVenueId)&&(status==='all'||(status==='archived'?!item.active:item.active))&&(!scope||item.scope===scope)&&(!q||[item.brand,item.productLine,item.name,item.spiritType,item.spiritSubtype,item.country,item.barcode,...item.aliases].join(' ').toLocaleLowerCase('ru-RU').includes(q))).sort((a,b)=>`${a.brand} ${a.productLine||''} ${a.name}`.localeCompare(`${b.brand} ${b.productLine||''} ${b.name}`,'ru'));
    return json(res,200,{items});
  }
  if (pathname==='/api/alcohol-catalog' && req.method==='POST') {
    if (denyUnless(req,res,'inventory')) return;
    if (requireOrganizationContext(req,res)) return;
    if (repositories?.pool&&(!/^[0-9a-f-]{36}$/i.test(alcoholCatalogVenueId)||!/^[0-9a-f-]{36}$/i.test(alcoholCatalogOrganizationId))) return json(res,403,{error:'organization_context_required'});
    let raw; try { raw=await body(req); } catch(_) { return json(res,400,{error:'invalid_alcohol_catalog_item'}); }
    const scope=raw.scope==='organization'?'organization':raw.scope==='venue'?'venue':'';
    if (!scope) return json(res,400,{error:'invalid_alcohol_catalog_scope'});
    if (scope==='organization'&&!canManageVenueIdentity(req)) return json(res,403,{error:'alcohol_catalog_network_admin_required'});
    let item; try { item=normalizeAlcoholCatalogInput(raw); } catch(_) { return json(res,400,{error:'invalid_alcohol_catalog_item'}); }
    if (repositories?.alcoholCatalog) { try { const created=await repositories.alcoholCatalog.create({...item,scope,organizationId:alcoholCatalogOrganizationId,venueId:alcoholCatalogVenueId,actorId:alcoholCatalogActor}); recordAudit(req,'alcohol_catalog.created','alcohol_catalog_item',created.id,null,created); return json(res,201,created); } catch(error) { if(error.code==='23505') return json(res,409,{error:'alcohol_catalog_duplicate'}); if(error.message==='alcohol_catalog_venue_not_found') return json(res,404,{error:error.message}); return json(res,503,{error:'alcohol_catalog_create_failed',detail:error.message}); } }
    if (process.env.AUTH_REQUIRED==='true') return json(res,503,{error:'alcohol_catalog_unavailable'});
    const duplicate=alcoholCatalogItems.some(entry=>entry.active&&entry.scope===scope&&entry.organizationId===alcoholCatalogOrganizationId&&(scope==='organization'||entry.venueId===alcoholCatalogVenueId)&&entry.brand.toLocaleLowerCase('ru-RU')===item.brand.toLocaleLowerCase('ru-RU')&&(entry.productLine||'').toLocaleLowerCase('ru-RU')===(item.productLine||'').toLocaleLowerCase('ru-RU')&&entry.name.toLocaleLowerCase('ru-RU')===item.name.toLocaleLowerCase('ru-RU')&&entry.spiritType===item.spiritType&&(entry.spiritSubtype||'').toLocaleLowerCase('ru-RU')===(item.spiritSubtype||'').toLocaleLowerCase('ru-RU')&&Number(entry.bottleMl||0)===Number(item.bottleMl||0));
    if(duplicate) return json(res,409,{error:'alcohol_catalog_duplicate'});
    const created={id:`alcohol-${Date.now()}-${Math.random().toString(16).slice(2,8)}`,organizationId:alcoholCatalogOrganizationId,scope,venueId:scope==='venue'?alcoholCatalogVenueId:null,...item,createdBy:alcoholCatalogActor,updatedBy:alcoholCatalogActor,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; alcoholCatalogItems.push(created); recordAudit(req,'alcohol_catalog.created','alcohol_catalog_item',created.id,null,created); return json(res,201,created);
  }
  if (alcoholCatalogPath&&(req.method==='GET'||req.method==='PATCH')) {
    if(req.method==='PATCH'&&denyUnless(req,res,'inventory')) return;
    if(req.method==='GET'&&denyUnlessAny(req,res,['inventory_read','inventory'])) return;
    if(requireOrganizationContext(req,res)) return;
    const id=decodeURIComponent(alcoholCatalogPath[1]);
    if(repositories?.alcoholCatalog) {
      if(req.method==='GET') { try { const item=await repositories.alcoholCatalog.get(alcoholCatalogOrganizationId,alcoholCatalogVenueId,id); return item?json(res,200,item):json(res,404,{error:'alcohol_catalog_item_not_found'}); } catch(error) { return json(res,503,{error:'alcohol_catalog_unavailable',detail:error.message}); } }
      let raw; try { raw=await body(req); } catch(_) { return json(res,400,{error:'invalid_alcohol_catalog_item'}); }
      let current; try { current=await repositories.alcoholCatalog.get(alcoholCatalogOrganizationId,alcoholCatalogVenueId,id); } catch(error) { return json(res,503,{error:'alcohol_catalog_unavailable',detail:error.message}); }
      if(!current) return json(res,404,{error:'alcohol_catalog_item_not_found'});
      if(current.scope==='organization'&&!canManageVenueIdentity(req)) return json(res,403,{error:'alcohol_catalog_network_admin_required'});
      let updated; try { updated=normalizeAlcoholCatalogInput(raw,current); } catch(_) { return json(res,400,{error:'invalid_alcohol_catalog_item'}); }
      try { const saved=await repositories.alcoholCatalog.update(alcoholCatalogOrganizationId,alcoholCatalogVenueId,id,updated,alcoholCatalogActor); if(!saved) return json(res,404,{error:'alcohol_catalog_item_not_found'}); recordAudit(req,updated.active?'alcohol_catalog.updated':'alcohol_catalog.archived','alcohol_catalog_item',id,current,saved); return json(res,200,saved); } catch(error) { return json(res,error.code==='23505'?409:503,{error:error.code==='23505'?'alcohol_catalog_duplicate':'alcohol_catalog_update_failed',detail:error.message}); }
    }
    if(process.env.AUTH_REQUIRED==='true') return json(res,503,{error:'alcohol_catalog_unavailable'});
    const current=alcoholCatalogItems.find(entry=>entry.id===id&&entry.organizationId===alcoholCatalogOrganizationId&&(entry.scope==='organization'||entry.venueId===alcoholCatalogVenueId)); if(!current) return json(res,404,{error:'alcohol_catalog_item_not_found'}); if(req.method==='GET') return json(res,200,current);
    if(current.scope==='organization'&&!canManageVenueIdentity(req)) return json(res,403,{error:'alcohol_catalog_network_admin_required'});
    let raw; try { raw=await body(req); } catch(_) { return json(res,400,{error:'invalid_alcohol_catalog_item'}); }
    let updated; try { updated=normalizeAlcoholCatalogInput(raw,current); } catch(_) { return json(res,400,{error:'invalid_alcohol_catalog_item'}); }
    const duplicate=alcoholCatalogItems.some(entry=>entry.id!==id&&entry.active&&updated.active&&entry.scope===current.scope&&entry.organizationId===current.organizationId&&(current.scope==='organization'||entry.venueId===current.venueId)&&entry.brand.toLocaleLowerCase('ru-RU')===updated.brand.toLocaleLowerCase('ru-RU')&&(entry.productLine||'').toLocaleLowerCase('ru-RU')===(updated.productLine||'').toLocaleLowerCase('ru-RU')&&entry.name.toLocaleLowerCase('ru-RU')===updated.name.toLocaleLowerCase('ru-RU')&&entry.spiritType===updated.spiritType&&(entry.spiritSubtype||'').toLocaleLowerCase('ru-RU')===(updated.spiritSubtype||'').toLocaleLowerCase('ru-RU')&&Number(entry.bottleMl||0)===Number(updated.bottleMl||0)); if(duplicate) return json(res,409,{error:'alcohol_catalog_duplicate'});
    Object.assign(current,updated,{updatedBy:alcoholCatalogActor,updatedAt:new Date().toISOString()}); recordAudit(req,updated.active?'alcohol_catalog.updated':'alcohol_catalog.archived','alcohol_catalog_item',id,null,current); return json(res,200,current);
  }
  if (pathname === '/api/inventory/deletion-requests' && req.method === 'GET') {
    if (denyUnless(req, res, 'inventory_read')) return;
    const owner = req.user?.role === 'owner';
    if (repositories?.pool) {
      try {
        const params = owner ? [venueDbId] : [venueDbId, req.user?.id || null];
        const where = owner ? 'venue_id=$1' : 'venue_id=$1 AND requested_by=$2';
        const { rows } = await repositories.pool.query(`SELECT id,entity_type AS "entityType",entity_id AS "entityId",entity_name AS "entityName",parent_name AS "parentName",reason,status,requested_by_name AS "requestedByName",requested_at AS "requestedAt",decided_by_name AS "decidedByName",decided_at AS "decidedAt" FROM inventory_deletion_requests WHERE ${where} AND status='pending' ORDER BY requested_at DESC`, params);
        return json(res, 200, { items: rows });
      } catch (error) { return json(res, 503, { error: 'inventory_deletion_requests_unavailable', detail: error.message }); }
    }
    return json(res, 200, { items: inventoryDeletionRequests.filter((item) => item.venueId === venueDbId && item.status === 'pending' && (owner || item.requestedBy === req.user?.id)) });
  }
  if (pathname === '/api/inventory/deletion-requests' && req.method === 'POST') {
    if (denyUnlessAny(req, res, ['inventory', 'inventory_categories'])) return;
    if (req.user?.role !== 'manager') return json(res, 403, { error: 'inventory_deletion_request_manager_only' });
    const input = await body(req); const entityType = String(input.entityType || ''); const entityId = String(input.entityId || '').trim(); const allowedTypes = new Set(['department','subdepartment','category']);
    if (!allowedTypes.has(entityType) || !entityId || entityId.length > 80 || (repositories?.pool && entityType !== 'department' && !/^[0-9a-f-]{36}$/i.test(entityId))) return json(res, 400, { error: 'invalid_inventory_deletion_request' });
    if (hasPermission(req, 'inventory_categories') && !hasPermission(req, 'inventory') && entityType !== 'category') return json(res, 403, { error: 'inventory_category_permission_only' });
    const names = { department: 'inventory_departments', subdepartment: 'inventory_subdepartments', category: 'product_categories' };
    if (repositories?.pool) {
      try {
        const table = names[entityType]; const key = entityType === 'department' ? 'code' : 'id';
        const idCast = entityType === 'department' ? '' : '::uuid';
        const { rows } = await repositories.pool.query(`SELECT t.name${entityType === 'department' ? '' : entityType === 'subdepartment' ? ',t.department_code AS parent' : ',t.department AS parent'} FROM ${table} t WHERE t.venue_id=$1 AND t.${key}=$2${idCast} AND t.is_active=false`, [venueDbId, entityId]);
        if (!rows[0]) return json(res, 409, { error: 'inventory_entry_must_be_archived' });
        const requesterId = /^[0-9a-f-]{36}$/i.test(String(req.user?.id || '')) ? req.user.id : null;
        const { rows: saved } = await repositories.pool.query(`INSERT INTO inventory_deletion_requests (venue_id,entity_type,entity_id,entity_name,parent_name,reason,requested_by,requested_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,entity_type AS "entityType",entity_id AS "entityId",entity_name AS "entityName",parent_name AS "parentName",reason,status,requested_by_name AS "requestedByName",requested_at AS "requestedAt"`, [venueDbId, entityType, entityId, rows[0].name, rows[0].parent || null, String(input.reason || '').trim().slice(0, 500), requesterId, String(req.user?.name || 'Управляющий').slice(0, 120)]);
        recordAudit(req, 'inventory.deletion_requested', entityType, entityId, null, { requestId: saved[0].id, entityName: saved[0].entityName });
        return json(res, 201, saved[0]);
      } catch (error) { return json(res, error.code === '23505' ? 409 : 503, { error: error.code === '23505' ? 'inventory_deletion_request_pending' : 'inventory_deletion_request_failed' }); }
    }
    const collection = entityType === 'department' ? inventoryDepartments : entityType === 'subdepartment' ? inventorySubdepartments : productCategories;
    const entity = collection.find((item) => String(item.id || item.code) === entityId && item.active === false);
    if (!entity) return json(res, 409, { error: 'inventory_entry_must_be_archived' });
    if (inventoryDeletionRequests.some((item) => item.venueId === venueDbId && item.entityType === entityType && item.entityId === entityId && item.status === 'pending')) return json(res, 409, { error: 'inventory_deletion_request_pending' });
    const request = { id: crypto.randomUUID(), venueId: venueDbId, entityType, entityId, entityName: entity.name, parentName: entity.departmentCode || entity.department || null, reason: String(input.reason || '').trim().slice(0, 500), status: 'pending', requestedBy: req.user?.id || null, requestedByName: String(req.user?.name || 'Управляющий'), requestedAt: new Date().toISOString() };
    inventoryDeletionRequests.push(request); recordAudit(req, 'inventory.deletion_requested', entityType, entityId, null, { requestId: request.id, entityName: request.entityName }); return json(res, 201, request);
  }
  const inventoryDeletionDecision = pathname.match(/^\/api\/inventory\/deletion-requests\/([^/]+)\/(approve|reject)$/);
  if (inventoryDeletionDecision && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    if (req.user?.role !== 'owner') return json(res, 403, { error: 'inventory_deletion_owner_required' });
    if (!/^[0-9a-f-]{36}$/i.test(inventoryDeletionDecision[1])) return json(res, 400, { error: 'invalid_inventory_deletion_request' });
    const decision = inventoryDeletionDecision[2];
    if (repositories?.pool) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(`SELECT id,entity_type AS "entityType",entity_id AS "entityId",entity_name AS "entityName",status FROM inventory_deletion_requests WHERE venue_id=$1 AND id=$2::uuid FOR UPDATE`, [venueDbId, inventoryDeletionDecision[1]]);
        const request = rows[0]; if (!request || request.status !== 'pending') { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_deletion_request_not_found' }); }
        if (decision === 'approve') {
          const removed = await permanentlyDeleteInventoryEntry(client, venueDbId, request.entityType, request.entityId);
          if (removed.error) { await client.query('ROLLBACK'); return json(res, 409, { error: removed.error }); }
        }
        const { rows: updated } = await client.query(`UPDATE inventory_deletion_requests SET status=$1,decided_by=$2::uuid,decided_by_name=$3,decided_at=now() WHERE id=$4::uuid AND venue_id=$5 AND status='pending' RETURNING id,status,entity_type AS "entityType",entity_id AS "entityId",entity_name AS "entityName",decided_at AS "decidedAt"`, [decision === 'approve' ? 'approved' : 'rejected', /^[0-9a-f-]{36}$/i.test(String(req.user?.id || '')) ? req.user.id : null, String(req.user?.name || 'Владелец').slice(0,120), request.id, venueDbId]);
        await client.query('COMMIT');
        recordAudit(req, decision === 'approve' ? 'inventory.deletion_approved' : 'inventory.deletion_rejected', request.entityType, request.entityId, { status: 'pending' }, updated[0]);
        if (decision === 'approve') recordAudit(req, 'inventory.entry_deleted', request.entityType, request.entityId, { name: request.entityName }, null);
        return json(res, 200, updated[0]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 503, { error: 'inventory_deletion_decision_failed' }); } finally { client.release(); }
    }
    const request = inventoryDeletionRequests.find((item) => item.id === inventoryDeletionDecision[1] && item.venueId === venueDbId && item.status === 'pending');
    if (!request) return json(res, 404, { error: 'inventory_deletion_request_not_found' });
    if (decision === 'approve') {
      const collections = { department: inventoryDepartments, subdepartment: inventorySubdepartments, category: productCategories };
      const collection = collections[request.entityType]; const itemIndex = collection.findIndex((item) => String(item.id || item.code) === request.entityId && item.active === false);
      if (itemIndex < 0) return json(res, 409, { error: 'inventory_archived_entry_not_found' });
      const removed = collection[itemIndex];
      const used = isInventoryEntryUsedInMemory(request.entityType, request.entityId, removed);
      if (used) return json(res, 409, { error: `inventory_${request.entityType}_in_use` });
      collection.splice(itemIndex, 1);
    }
    request.status = decision === 'approve' ? 'approved' : 'rejected'; request.decidedByName = req.user?.name || 'Владелец'; request.decidedAt = new Date().toISOString();
    recordAudit(req, decision === 'approve' ? 'inventory.deletion_approved' : 'inventory.deletion_rejected', request.entityType, request.entityId, { status: 'pending' }, request);
    if (decision === 'approve') recordAudit(req, 'inventory.entry_deleted', request.entityType, request.entityId, { name: request.entityName }, null);
    return json(res, 200, request);
  }
  if (pathname === '/api/inventory/permanent-deletions' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    if (req.user?.role !== 'owner') return json(res, 403, { error: 'inventory_deletion_owner_required' });
    const input = await body(req); const entityType = String(input.entityType || ''); const entityId = String(input.entityId || '').trim();
    if (!['department','subdepartment','category'].includes(entityType) || !entityId || entityId.length > 80 || (repositories?.pool && entityType !== 'department' && !/^[0-9a-f-]{36}$/i.test(entityId))) return json(res, 400, { error: 'invalid_inventory_deletion_request' });
    if (repositories?.pool) {
      const client = await repositories.pool.connect();
      try { await client.query('BEGIN'); const removed = await permanentlyDeleteInventoryEntry(client, venueDbId, entityType, entityId); if (removed.error) { await client.query('ROLLBACK'); return json(res, 409, { error: removed.error }); } const { rows: closedRequests } = await client.query(`UPDATE inventory_deletion_requests SET status='rejected',decided_by=$1::uuid,decided_by_name=$2,decided_at=now() WHERE venue_id=$3 AND entity_type=$4 AND entity_id=$5 AND status='pending' RETURNING id`, [/^[0-9a-f-]{36}$/i.test(String(req.user?.id || '')) ? req.user.id : null, String(req.user?.name || 'Владелец').slice(0,120), venueDbId, entityType, entityId]); await client.query('COMMIT'); recordAudit(req, 'inventory.entry_deleted', entityType, entityId, removed.item, null); for (const request of closedRequests) recordAudit(req, 'inventory.deletion_request_closed_by_owner', entityType, entityId, { requestId: request.id }, { status: 'rejected' }); return json(res, 200, { id: entityId, entityType, deleted: true }); }
      catch (_) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'inventory_entry_delete_failed' }); } finally { client.release(); }
    }
    const collection = entityType === 'department' ? inventoryDepartments : entityType === 'subdepartment' ? inventorySubdepartments : productCategories; const index = collection.findIndex((item) => String(item.id || item.code) === entityId && item.active === false); if (index < 0) return json(res, 404, { error: 'inventory_archived_entry_not_found' }); const archived = collection[index]; if (isInventoryEntryUsedInMemory(entityType, entityId, archived)) return json(res, 409, { error: `inventory_${entityType}_in_use` }); collection.splice(index, 1); for (const request of inventoryDeletionRequests) if (request.venueId === venueDbId && request.entityType === entityType && request.entityId === entityId && request.status === 'pending') { request.status = 'rejected'; request.decidedByName = req.user?.name || 'Владелец'; request.decidedAt = new Date().toISOString(); recordAudit(req, 'inventory.deletion_request_closed_by_owner', entityType, entityId, { requestId: request.id }, { status: 'rejected' }); } recordAudit(req, 'inventory.entry_deleted', entityType, entityId, archived, null); return json(res, 200, { id: entityId, entityType, deleted: true });
  }

  if (pathname === '/api/inventory/departments' && req.method === 'GET') {
    if (denyUnless(req, res, 'inventory_read')) return;
    const status = ['active','archived','all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'active';
    if (repositories?.pool) { try { const filter = status === 'all' ? '' : status === 'archived' ? ' AND is_active=false' : ' AND is_active=true'; const { rows } = await repositories.pool.query(`SELECT code AS id,code,name,description,color,sort_order AS "sortOrder",is_active AS active FROM inventory_departments WHERE venue_id=$1${filter} ORDER BY sort_order,name`, [venueDbId]); return json(res, 200, { items: rows }); } catch (error) { return json(res, 503, { error: 'inventory_departments_unavailable', detail: error.message }); } }
    return json(res, 200, { items: inventoryDepartments.filter((item) => status === 'all' || (status === 'archived' ? item.active === false : item.active !== false)) });
  }
  if (pathname === '/api/inventory/departments' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const name = String(input.name || '').trim(); const code = String(input.code || name).trim().toLocaleLowerCase('ru-RU').replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48);
    if (!name || name.length > 80 || !code) return json(res, 400, { error: 'invalid_inventory_department' });
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query('INSERT INTO inventory_departments (venue_id,code,name,description,color,sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING code AS id,code,name,description,color,sort_order AS "sortOrder",is_active AS active', [venueDbId, code, name, String(input.description || '').trim().slice(0, 300), ['coral','amber','violet','green'].includes(input.color) ? input.color : 'coral', Number.isInteger(Number(input.sortOrder)) ? Number(input.sortOrder) : 50]); recordAudit(req, 'inventory.department_created', 'inventory_department', rows[0].id, null, rows[0]); return json(res, 201, rows[0]); } catch (error) { return json(res, 409, { error: error.code === '23505' ? 'inventory_department_exists' : 'inventory_department_create_failed' }); } }
    if (inventoryDepartments.some((item) => item.code === code)) return json(res, 409, { error: 'inventory_department_exists' }); const created = { id: code, code, name, description: String(input.description || '').trim().slice(0, 300), color: input.color || 'coral', sortOrder: inventoryDepartments.length * 10 + 10, active: true }; inventoryDepartments.push(created); return json(res, 201, created);
  }
  const inventoryDepartmentPath = pathname.match(/^\/api\/inventory\/departments\/([^/]+)$/);
  if (inventoryDepartmentPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const code = decodeURIComponent(inventoryDepartmentPath[1]); const name = String(input.name || '').trim(); if (!name || name.length > 80) return json(res, 400, { error: 'invalid_inventory_department' });
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query('UPDATE inventory_departments SET name=$1,description=$2,color=$3,sort_order=$4 WHERE venue_id=$5 AND code=$6 AND is_active=true RETURNING code AS id,code,name,description,color,sort_order AS "sortOrder",is_active AS active', [name, String(input.description || '').trim().slice(0, 300), ['coral','amber','violet','green'].includes(input.color) ? input.color : 'coral', Number.isInteger(Number(input.sortOrder)) ? Number(input.sortOrder) : 50, venueDbId, code]); if (!rows[0]) return json(res, 404, { error: 'inventory_department_not_found' }); recordAudit(req, 'inventory.department_updated', 'inventory_department', code, null, rows[0]); return json(res, 200, rows[0]); } catch (error) { return json(res, 409, { error: 'inventory_department_update_failed' }); } }
    const memoryItem = inventoryDepartments.find((item) => item.code === code && item.active !== false); if (!memoryItem) return json(res, 404, { error: 'inventory_department_not_found' }); Object.assign(memoryItem, { name, description: String(input.description || '').trim().slice(0,300) }); recordAudit(req, 'inventory.department_updated', 'inventory_department', code, null, memoryItem); return json(res, 200, memoryItem);
  }
  const inventoryDepartmentRestore = pathname.match(/^\/api\/inventory\/departments\/([^/]+)\/restore$/);
  if (inventoryDepartmentRestore && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const code = decodeURIComponent(inventoryDepartmentRestore[1]);
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query('UPDATE inventory_departments SET is_active=true WHERE venue_id=$1 AND code=$2 AND is_active=false RETURNING code AS id,code,name,description,color,sort_order AS "sortOrder",is_active AS active', [venueDbId, code]); if (!rows[0]) return json(res, 404, { error: 'inventory_archived_entry_not_found' }); recordAudit(req, 'inventory.department_restored', 'inventory_department', code, { active: false }, rows[0]); return json(res, 200, rows[0]); } catch (error) { return json(res, 409, { error: error.code === '23505' ? 'inventory_department_exists' : 'inventory_department_restore_failed' }); } }
    const memoryItem = inventoryDepartments.find((item) => item.code === code && item.active === false); if (!memoryItem) return json(res, 404, { error: 'inventory_archived_entry_not_found' }); memoryItem.active = true; recordAudit(req, 'inventory.department_restored', 'inventory_department', code, { active: false }, memoryItem); return json(res, 200, memoryItem);
  }
  if (inventoryDepartmentPath && req.method === 'DELETE') {
    if (denyUnless(req, res, 'inventory')) return;
    const code = decodeURIComponent(inventoryDepartmentPath[1]); if (repositories?.pool) { let client; try { client = await repositories.pool.connect(); await client.query('BEGIN'); const department = await client.query('SELECT 1 FROM inventory_departments WHERE venue_id=$1 AND code=$2 AND is_active=true FOR UPDATE', [venueDbId, code]); if (!department.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_department_not_found' }); } const used = await client.query('SELECT EXISTS(SELECT 1 FROM product_categories WHERE venue_id=$1 AND department=$2 AND is_active=true) OR EXISTS(SELECT 1 FROM inventory_subdepartments WHERE venue_id=$1 AND department_code=$2 AND is_active=true) OR EXISTS(SELECT 1 FROM ingredients WHERE venue_id=$1 AND department=$2) AS used', [venueDbId, code]); if (used.rows[0]?.used) { await client.query('ROLLBACK'); return json(res, 409, { error: 'inventory_department_in_use' }); } const { rows } = await client.query('UPDATE inventory_departments SET is_active=false WHERE venue_id=$1 AND code=$2 AND is_active=true RETURNING code AS id,code,name,is_active AS active', [venueDbId, code]); if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_department_not_found' }); } await client.query('COMMIT'); recordAudit(req, 'inventory.department_archived', 'inventory_department', code, { active: true }, rows[0]); return json(res, 200, rows[0]); } catch (error) { await client?.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'inventory_department_archive_failed' }); } finally { client?.release(); } }
    const memoryItem = inventoryDepartments.find((item) => item.code === code && item.active !== false); if (!memoryItem) return json(res, 404, { error: 'inventory_department_not_found' }); if (inventorySubdepartments.some((item) => item.departmentCode === code && item.active !== false) || productCategories.some((item) => item.department === code && item.active !== false) || inventory.some((item) => item.department === code)) return json(res, 409, { error: 'inventory_department_in_use' }); memoryItem.active = false; recordAudit(req, 'inventory.department_archived', 'inventory_department', code, { active: true }, memoryItem); return json(res, 200, memoryItem);
  }
  if (pathname === '/api/product-categories' && req.method === 'GET') {
    if (denyUnless(req, res, 'inventory_read')) return;
    const status = ['active','archived','all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'active';
    if (repositories?.pool) { try { const filter = status === 'all' ? '' : status === 'archived' ? ' AND c.is_active=false' : ' AND c.is_active=true'; const { rows } = await repositories.pool.query(`SELECT c.id,c.name,c.department,c.subdepartment_id AS "subdepartmentId",s.name AS "subdepartmentName",c.is_active AS active FROM product_categories c LEFT JOIN inventory_subdepartments s ON s.id=c.subdepartment_id AND s.venue_id=c.venue_id WHERE c.venue_id=$1${filter} ORDER BY c.department,s.name NULLS FIRST,c.name`, [venueDbId]); return json(res, 200, { items: rows }); } catch (error) { return json(res, 503, { error: 'product_categories_unavailable', detail: error.message }); } }
    return json(res, 200, { items: productCategories.filter((item) => status === 'all' || (status === 'archived' ? item.active === false : item.active !== false)).map((item) => ({ ...item, subdepartmentName: inventorySubdepartments.find((entry) => entry.id === item.subdepartmentId)?.name || null })) });
  }
  if (pathname === '/api/product-categories' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const name = String(input.name || '').trim();
    if (!name || name.length > 80) return json(res, 400, { error: 'invalid_product_category' });
    const department = String(input.department || 'inventory').trim();
    if (!department || department.length > 48) return json(res, 400, { error: 'invalid_product_category_department' });
    const subdepartmentId = String(input.subdepartmentId || '').trim() || null;
    if (repositories?.pool && subdepartmentId && !/^[0-9a-f-]{36}$/i.test(subdepartmentId)) return json(res, 400, { error: 'invalid_product_category_subdepartment' });
    if (repositories?.pool) { let client; let checkingParent = true; try { client = await repositories.pool.connect(); await client.query('BEGIN'); const departmentResult = await client.query('SELECT 1 FROM inventory_departments WHERE venue_id=$1 AND code=$2 AND is_active=true FOR UPDATE', [venueDbId, department]); checkingParent = false; if (!departmentResult.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'inventory_department_not_found' }); } let subdepartmentName = null; if (subdepartmentId) { const subdepartment = await client.query('SELECT id,name FROM inventory_subdepartments WHERE venue_id=$1 AND department_code=$2 AND id=$3 AND is_active=true FOR UPDATE', [venueDbId, department, subdepartmentId]); if (!subdepartment.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'inventory_subdepartment_not_found' }); } subdepartmentName = subdepartment.rows[0].name; } const { rows } = await client.query('INSERT INTO product_categories (venue_id,name,department,subdepartment_id) VALUES ($1,$2,$3,$4) RETURNING id,name,department,subdepartment_id AS "subdepartmentId",is_active AS active', [venueDbId, name, department, subdepartmentId]); await client.query('COMMIT'); const category = { ...rows[0], subdepartmentName }; recordAudit(req, 'product_category.created', 'product_category', category.id, null, category); return json(res, 201, category); } catch (error) { await client?.query('ROLLBACK').catch(() => {}); if (checkingParent) return json(res, 503, { error: 'inventory_hierarchy_unavailable' }); return json(res, 409, { error: error.code === '23505' ? 'product_category_exists' : 'product_category_create_failed', detail: error.message }); } finally { client?.release(); } }
    if (!inventoryDepartments.some((item) => item.code === department && item.active !== false)) return json(res, 400, { error: 'inventory_department_not_found' });
    if (productCategories.some((item) => item.name.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU"))) return json(res, 409, { error: 'product_category_exists' });
    const subdepartment = subdepartmentId && inventorySubdepartments.find((item) => item.id === subdepartmentId && item.departmentCode === department && item.active !== false);
    if (subdepartmentId && !subdepartment) return json(res, 400, { error: 'inventory_subdepartment_not_found' });
    const category = { id: `product-category-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, department, subdepartmentId, subdepartmentName: subdepartment?.name || null, active: true };
    productCategories.push(category); recordAudit(req, 'product_category.created', 'product_category', category.id, null, category); return json(res, 201, category);
  }
  const productCategoryPath = pathname.match(/^\/api\/product-categories\/([^/]+)$/);
  if (productCategoryPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'inventory')) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(productCategoryPath[1])) {
      const input = await body(req); const name = String(input.name || '').trim(); const department = String(input.department || 'inventory').trim(); const subdepartmentId = String(input.subdepartmentId || '').trim() || null;
      if (!name || name.length > 80) return json(res, 400, { error: 'invalid_product_category' });
      if (!department || department.length > 48) return json(res, 400, { error: 'invalid_product_category_department' });
      if (subdepartmentId && !/^[0-9a-f-]{36}$/i.test(subdepartmentId)) return json(res, 400, { error: 'invalid_product_category_subdepartment' });
      let client;
      let updated;
      let before;
      let checkingParent = true;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        const departmentResult = await client.query('SELECT 1 FROM inventory_departments WHERE venue_id=$1 AND code=$2 AND is_active=true FOR UPDATE', [venueDbId, department]);
        checkingParent = false;
        if (!departmentResult.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'inventory_department_not_found' }); }
        let subdepartmentName = null;
        if (subdepartmentId) { const subdepartment = await client.query('SELECT id,name FROM inventory_subdepartments WHERE venue_id=$1 AND department_code=$2 AND id=$3 AND is_active=true FOR UPDATE', [venueDbId, department, subdepartmentId]); if (!subdepartment.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'inventory_subdepartment_not_found' }); } subdepartmentName = subdepartment.rows[0].name; }
        const current = await client.query('SELECT id,name,department,subdepartment_id AS "subdepartmentId" FROM product_categories WHERE id=$1 AND venue_id=$2 AND is_active=true FOR UPDATE', [productCategoryPath[1], venueDbId]);
        before = current.rows[0];
        if (!before) { await client.query('ROLLBACK'); return json(res, 404, { error: 'product_category_not_found' }); }
        const result = await client.query('UPDATE product_categories SET name=$1,department=$2,subdepartment_id=$3 WHERE id=$4 AND venue_id=$5 AND is_active=true RETURNING id,name,department,subdepartment_id AS "subdepartmentId",is_active AS active', [name, department, subdepartmentId, productCategoryPath[1], venueDbId]);
        updated = result.rows[0];
        if (!updated) { await client.query('ROLLBACK'); return json(res, 404, { error: 'product_category_not_found' }); }
        if (before.name !== name || before.department !== department || String(before.subdepartmentId || '') !== String(subdepartmentId || '')) {
          await client.query(`UPDATE ingredients SET category=$1,department=$2,subdepartment=CASE WHEN $3::uuid IS NOT NULL THEN $4 WHEN $2<>$5 THEN '' ELSE subdepartment END WHERE venue_id=$6 AND category_id=$7 AND is_marked=true`, [name, department, subdepartmentId, subdepartmentName, before.department, venueDbId, productCategoryPath[1]]);
        }
        await client.query('COMMIT');
        updated.subdepartmentName = subdepartmentName;
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (checkingParent) return json(res, 503, { error: 'inventory_hierarchy_unavailable' });
        return json(res, 409, { error: error.code === '23505' ? 'product_category_exists' : 'product_category_update_failed', detail: error.message });
      } finally { client?.release(); }
      recordAudit(req, 'product_category.updated', 'product_category', updated.id, before, updated);
      return json(res, 200, updated);
    }
    const category = productCategories.find((item) => item.id === productCategoryPath[1]); if (!category) return json(res, 404, { error: 'product_category_not_found' });
    const input = await body(req); const name = String(input.name || '').trim();
    if (!name || name.length > 80) return json(res, 400, { error: 'invalid_product_category' });
    if (productCategories.some((item) => item.active && item.id !== category.id && item.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) return json(res, 409, { error: 'product_category_exists' });
    const department = String(input.department || category.department || 'inventory').trim(); if (!inventoryDepartments.some((item) => item.code === department && item.active !== false)) return json(res, 400, { error: 'inventory_department_not_found' }); const subdepartmentId = String(input.subdepartmentId || '').trim() || null; const subdepartment = subdepartmentId && inventorySubdepartments.find((item) => item.id === subdepartmentId && item.departmentCode === department && item.active); if (subdepartmentId && !subdepartment) return json(res, 400, { error: 'inventory_subdepartment_not_found' }); const before = { ...category }; Object.assign(category, { name, department, subdepartmentId, subdepartmentName: subdepartment?.name || null }); recordAudit(req, 'product_category.updated', 'product_category', category.id, before, category); return json(res, 200, category);
  }
  if (productCategoryPath && req.method === 'DELETE') {
    if (denyUnlessAny(req, res, ['inventory', 'inventory_categories'])) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(productCategoryPath[1])) { try { const used = await repositories.pool.query('SELECT EXISTS(SELECT 1 FROM ingredients WHERE venue_id=$1 AND (category_id=$2 OR (category_id IS NULL AND department=(SELECT department FROM product_categories WHERE id=$2 AND venue_id=$1) AND category=(SELECT name FROM product_categories WHERE id=$2 AND venue_id=$1)))) OR EXISTS(SELECT 1 FROM products WHERE venue_id=$1 AND category=(SELECT name FROM product_categories WHERE id=$2 AND venue_id=$1)) AS used', [venueDbId, productCategoryPath[1]]); if (used.rows[0]?.used) return json(res, 409, { error: 'inventory_category_in_use' }); const { rows } = await repositories.pool.query('UPDATE product_categories SET is_active=false WHERE id=$1 AND venue_id=$2 AND is_active=true RETURNING id,name,department,is_active AS active', [productCategoryPath[1], venueDbId]); if (!rows[0]) return json(res, 404, { error: 'product_category_not_found' }); recordAudit(req, 'product_category.deactivated', 'product_category', rows[0].id, { active: true }, rows[0]); return json(res, 200, rows[0]); } catch (error) { return json(res, 409, { error: 'product_category_delete_failed', detail: error.message }); } }
    const category = productCategories.find((item) => item.id === productCategoryPath[1]); if (!category) return json(res, 404, { error: 'product_category_not_found' });
    if (inventory.some((item) => item.department === category.department && item.category === category.name) || products.some((item) => item.category === category.name)) return json(res, 409, { error: 'inventory_category_in_use' });
    const before = { ...category }; category.active = false; recordAudit(req, 'product_category.deactivated', 'product_category', category.id, before, category); return json(res, 200, category);
  }
  const productCategoryRestore = pathname.match(/^\/api\/product-categories\/([^/]+)\/restore$/);
  if (productCategoryRestore && req.method === 'POST') {
    if (denyUnlessAny(req, res, ['inventory', 'inventory_categories'])) return;
    if (repositories?.pool && !/^[0-9a-f-]{36}$/i.test(productCategoryRestore[1])) return json(res, 400, { error: 'invalid_product_category' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(productCategoryRestore[1])) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const categoryResult = await client.query('SELECT department,subdepartment_id AS "subdepartmentId" FROM product_categories WHERE venue_id=$1 AND id=$2::uuid AND is_active=false FOR UPDATE', [venueDbId, productCategoryRestore[1]]);
        const category = categoryResult.rows[0];
        if (!category) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_archived_entry_not_found' }); }
        const department = await client.query('SELECT code FROM inventory_departments WHERE venue_id=$1 AND code=$2 AND is_active=true FOR UPDATE', [venueDbId, category.department]);
        if (!department.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'inventory_category_parent_inactive' }); }
        if (category.subdepartmentId) {
          const subdepartment = await client.query('SELECT id FROM inventory_subdepartments WHERE venue_id=$1 AND id=$2 AND department_code=$3 AND is_active=true FOR UPDATE', [venueDbId, category.subdepartmentId, category.department]);
          if (!subdepartment.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'inventory_category_parent_inactive' }); }
        }
        const { rows } = await client.query('UPDATE product_categories SET is_active=true WHERE venue_id=$1 AND id=$2::uuid AND is_active=false RETURNING id,name,department,subdepartment_id AS "subdepartmentId",is_active AS active', [venueDbId, productCategoryRestore[1]]);
        if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_archived_entry_not_found' }); }
        await client.query('COMMIT'); recordAudit(req, 'product_category.restored', 'product_category', rows[0].id, { active: false }, rows[0]); return json(res, 200, rows[0]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: error.code === '23505' ? 'product_category_exists' : 'product_category_restore_failed' }); } finally { client.release(); }
    }
    const category = productCategories.find((item) => item.id === productCategoryRestore[1] && item.active === false); if (!category) return json(res, 404, { error: 'inventory_archived_entry_not_found' });
    if (!inventoryDepartments.some((item) => item.code === category.department && item.active !== false) || (category.subdepartmentId && !inventorySubdepartments.some((item) => item.id === category.subdepartmentId && item.departmentCode === category.department && item.active !== false))) return json(res, 409, { error: 'inventory_category_parent_inactive' });
    category.active = true; recordAudit(req, 'product_category.restored', 'product_category', category.id, { active: false }, category); return json(res, 200, category);
  }
  if (pathname === '/api/products' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'floor') && !hasPermission(req, 'inventory_read') && !hasPermission(req, 'inventory')) return json(res, 403, { error: 'forbidden', permission: 'floor' });
    if (repositories?.products) {
      try { return json(res, 200, { items: await repositories.products.list(venueDbId) }); }
      catch (_) { if (process.env.DATABASE_URL) return json(res, 503, { error: 'products_unavailable' }); }
    }
    if (process.env.DATABASE_URL) return json(res, 503, { error: 'products_unavailable' });
    return json(res, 200, { items: products });
  }
  if (pathname === '/api/recipes' && req.method === 'GET') {
    if (denyUnless(req, res, 'inventory_read')) return;
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query('SELECT id,product_id AS "productId",name,category,ingredients,technology,serve,yield_quantity AS "yieldQuantity",yield_unit AS "yieldUnit",portion_count AS "portionCount",recipe_type AS "recipeType",active,created_at AS "createdAt",updated_at AS "updatedAt" FROM inventory_recipe_cards WHERE venue_id=$1 AND active=true ORDER BY category,name', [venueDbId]); return json(res, 200, { items: rows.map(normalizeRecipeCard) }); } catch (error) { return json(res, 503, { error: 'recipes_unavailable', detail: error.message }); } }
    return json(res, 200, { items: recipes.map((recipe) => ({ ...recipe, yieldQuantity: recipe.yieldQuantity || 1, yieldUnit: recipe.yieldUnit || 'порция', portionCount: recipe.portionCount || 1 })) });
  }
  if (pathname === '/api/recipes' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const name = String(input.name || '').trim(); const category = String(input.category || '').trim();
    let ingredients;
    try { ingredients = await normalizeRecipeIngredients(input.ingredients, venueDbId); } catch (error) { return json(res, 400, { error: error.code || 'invalid_recipe_ingredients', ingredient: error.ingredient, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit }); }
    if (!ingredients) return json(res, 503, { error: 'recipe_ingredients_unavailable' });
    let output; try { output = normalizeRecipeOutput(input); } catch (error) { return json(res, 400, { error: error.code || 'invalid_recipe_output', targetUnit: error.targetUnit }); }
    const technology = String(input.technology || '').trim(); const serve = String(input.serve || '').trim(); const recipeType = ['sale','premix'].includes(String(input.recipeType || 'sale')) ? String(input.recipeType || 'sale') : 'sale';
    const requestedProductId = input.productId === undefined || input.productId === null ? null : String(input.productId).trim() || null;
    if (!name || name.length > 120 || category.length > 80 || technology.length > 4000 || serve.length > 1000) return json(res, 400, { error: 'invalid_recipe' });
    if (recipeType === 'premix' && requestedProductId) return json(res, 400, { error: 'premix_product_binding_not_allowed' });
    if (requestedProductId && repositories?.pool && !/^[0-9a-f-]{36}$/i.test(requestedProductId)) return json(res, 400, { error: 'recipe_product_invalid' });
    if (requestedProductId && !repositories?.pool && !products.some((item) => item.id === requestedProductId)) return json(res, 400, { error: 'recipe_product_not_found' });
    if (requestedProductId && !repositories?.pool && recipeType === 'sale') {
      const targetProduct = products.find((item) => item.id === requestedProductId);
      if (targetProduct?.inventoryMode === 'non_stock') return json(res, 409, { error: 'non_stock_product_has_recipe' });
      if (recipes.some((item) => item.active !== false && item.recipeType !== 'premix' && String(item.productId || '') === requestedProductId)) return json(res, 409, { error: 'product_recipe_ambiguous' });
    }
    if (requestedProductId && repositories?.pool) { const product = await repositories.pool.query('SELECT id FROM products WHERE id=$1 AND venue_id=$2', [requestedProductId, venueDbId]); if (!product.rows[0]) return json(res, 400, { error: 'recipe_product_not_found' }); }

    if (repositories?.pool) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        if (requestedProductId && recipeType === 'sale') {
          const product = await client.query('SELECT id,inventory_mode AS "inventoryMode" FROM products WHERE id=$1 AND venue_id=$2 AND is_active=true FOR UPDATE', [requestedProductId, venueDbId]);
          if (!product.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'recipe_product_not_found' }); }
          if (product.rows[0].inventoryMode === 'non_stock') { await client.query('ROLLBACK'); return json(res, 409, { error: 'non_stock_product_has_recipe' }); }
          const duplicate = await client.query("SELECT 1 FROM inventory_recipe_cards WHERE venue_id=$1 AND product_id=$2 AND active=true AND recipe_type='sale' LIMIT 1", [venueDbId, requestedProductId]);
          if (duplicate.rowCount) { await client.query('ROLLBACK'); return json(res, 409, { error: 'product_recipe_ambiguous' }); }
        } else if (requestedProductId) {
          const product = await client.query('SELECT id FROM products WHERE id=$1 AND venue_id=$2 AND is_active=true FOR UPDATE', [requestedProductId, venueDbId]);
          if (!product.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'recipe_product_not_found' }); }
        }
        const { rows } = await client.query('INSERT INTO inventory_recipe_cards (venue_id,product_id,name,category,ingredients,technology,serve,yield_quantity,yield_unit,portion_count,recipe_type) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING id,product_id AS "productId",name,category,ingredients,technology,serve,yield_quantity AS "yieldQuantity",yield_unit AS "yieldUnit",portion_count AS "portionCount",recipe_type AS "recipeType",active,created_at AS "createdAt",updated_at AS "updatedAt"', [venueDbId, requestedProductId, name, category, JSON.stringify(ingredients), technology || null, serve || null, output.yieldQuantity, output.yieldUnit, output.portionCount, recipeType]);
        await client.query('COMMIT');
        const recipe = normalizeRecipeCard(rows[0]);
        recordAudit(req, 'recipe.created', 'recipe', recipe.id, null, recipe);
        return json(res, 201, recipe);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'recipe_save_failed', detail: error.message }); }
      finally { client.release(); }
    }
    const recipe = { id: 'recipe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), productId: requestedProductId, name, category, ingredients, technology, serve, recipeType, ...output }; recipes.push(recipe); recordAudit(req, 'recipe.created', 'recipe', recipe.id, null, recipe); return json(res, 201, recipe);
  }
  const recipeProfile = pathname.match(/^\/api\/recipes\/([^/]+)$/);
  if (recipeProfile && req.method === 'PATCH') {
    if (denyUnless(req, res, 'inventory')) return;

    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(recipeProfile[1])) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const input = await body(req);
        const existingResult = await client.query('SELECT product_id AS "productId",category,recipe_type AS "recipeType",yield_quantity AS "yieldQuantity",yield_unit AS "yieldUnit",portion_count AS "portionCount" FROM inventory_recipe_cards WHERE id=$1 AND venue_id=$2 AND active=true FOR UPDATE', [recipeProfile[1], venueDbId]);
        const existing = existingResult.rows[0];
        if (!existing) { await client.query('ROLLBACK'); return json(res, 404, { error: 'recipe_not_found' }); }
        const nextType = input.recipeType === undefined ? existing.recipeType : (['sale','premix'].includes(String(input.recipeType)) ? String(input.recipeType) : null);
        if (!nextType) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_recipe_type' }); }
        const nextProductId = input.productId === undefined ? existing.productId : (input.productId === null ? null : String(input.productId).trim() || null);
        if (nextType === 'premix' && nextProductId) { await client.query('ROLLBACK'); return json(res, 400, { error: 'premix_product_binding_not_allowed' }); }
        if (nextProductId && !/^[0-9a-f-]{36}$/i.test(nextProductId)) { await client.query('ROLLBACK'); return json(res, 400, { error: 'recipe_product_invalid' }); }
        if (nextProductId && nextType === 'sale') {
          const product = await client.query('SELECT id,inventory_mode AS "inventoryMode" FROM products WHERE id=$1 AND venue_id=$2 AND is_active=true FOR UPDATE', [nextProductId, venueDbId]);
          if (!product.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'recipe_product_not_found' }); }
          if (product.rows[0].inventoryMode === 'non_stock') { await client.query('ROLLBACK'); return json(res, 409, { error: 'non_stock_product_has_recipe' }); }
          const duplicate = await client.query("SELECT 1 FROM inventory_recipe_cards WHERE venue_id=$1 AND product_id=$2 AND active=true AND recipe_type='sale' AND id<>$3 LIMIT 1", [venueDbId, nextProductId, recipeProfile[1]]);
          if (duplicate.rowCount) { await client.query('ROLLBACK'); return json(res, 409, { error: 'product_recipe_ambiguous' }); }
        } else if (nextProductId) {
          const product = await client.query('SELECT id FROM products WHERE id=$1 AND venue_id=$2 AND is_active=true FOR UPDATE', [nextProductId, venueDbId]);
          if (!product.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'recipe_product_not_found' }); }
        }
        if (input.ingredients !== undefined) {
          if (!Array.isArray(input.ingredients) || !input.ingredients.length) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_recipe' }); }
          try { input.ingredients = await normalizeRecipeIngredients(input.ingredients, venueDbId); }
          catch (error) { await client.query('ROLLBACK'); return json(res, 400, { error: error.code || 'invalid_recipe_ingredients', ingredient: error.ingredient, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit }); }
          if (!input.ingredients) { await client.query('ROLLBACK'); return json(res, 503, { error: 'recipe_ingredients_unavailable' }); }
        }
        let output = null;
        if (input.yieldQuantity !== undefined || input.yieldUnit !== undefined || input.portionCount !== undefined || input.yield !== undefined || input.portions !== undefined) {
          try { output = normalizeRecipeOutput(input, existing); }
          catch (error) { await client.query('ROLLBACK'); return json(res, 400, { error: error.code || 'invalid_recipe_output', targetUnit: error.targetUnit }); }
        }
        const fields = []; const values = [recipeProfile[1], venueDbId];
        if (input.productId !== undefined) { values.push(nextProductId); fields.push(`product_id=$${values.length}`); }
        if (input.name !== undefined) { const name = String(input.name || '').trim(); if (!name || name.length > 120) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_recipe' }); } values.push(name); fields.push(`name=$${values.length}`); }
        if (input.category !== undefined) { const category = String(input.category || '').trim(); if (category.length > 80) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_recipe' }); } values.push(category); fields.push(`category=$${values.length}`); }
        if (input.ingredients !== undefined) { values.push(JSON.stringify(input.ingredients.slice(0, 50))); fields.push(`ingredients=$${values.length}::jsonb`); }
        if (input.technology !== undefined) { const technology = String(input.technology || '').trim(); if (technology.length > 4000) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_recipe' }); } values.push(technology || null); fields.push(`technology=$${values.length}`); }
        if (input.serve !== undefined) { const serve = String(input.serve || '').trim(); if (serve.length > 1000) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_recipe' }); } values.push(serve || null); fields.push(`serve=$${values.length}`); }
        if (output) { values.push(output.yieldQuantity, output.yieldUnit, output.portionCount); fields.push(`yield_quantity=$${values.length - 2}`, `yield_unit=$${values.length - 1}`, `portion_count=$${values.length}`); }
        if (input.recipeType !== undefined) { values.push(nextType); fields.push(`recipe_type=$${values.length}`); }
        if (!fields.length) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_recipe' }); }
        fields.push('updated_at=now()');
        const { rows } = await client.query(`UPDATE inventory_recipe_cards SET ${fields.join(',')} WHERE id=$1 AND venue_id=$2 AND active=true RETURNING id,product_id AS "productId",name,category,ingredients,technology,serve,yield_quantity AS "yieldQuantity",yield_unit AS "yieldUnit",portion_count AS "portionCount",recipe_type AS "recipeType",active,created_at AS "createdAt",updated_at AS "updatedAt"`, values);
        if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'recipe_not_found' }); }
        await client.query('COMMIT');
        const updated = normalizeRecipeCard(rows[0]); recordAudit(req, 'recipe.updated', 'recipe', updated.id, null, updated); return json(res, 200, updated);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'recipe_save_failed', detail: error.message }); }
      finally { client.release(); }
    }
    const storedRecipe = recipes.find((item) => item.id === recipeProfile[1]); const recipe = storedRecipe && { ...storedRecipe }; if (!recipe) return json(res, 404, { error: 'recipe_not_found' });
    const input = await body(req); const before = { ...recipe };
    if (input.category !== undefined) { const category = String(input.category || '').trim(); if (category.length > 80) return json(res, 400, { error: 'invalid_recipe' }); recipe.category = category; }
    if (input.productId !== undefined) { const productId = input.productId === null ? null : String(input.productId).trim() || null; if (productId && repositories?.pool && !/^[0-9a-f-]{36}$/i.test(productId)) return json(res, 400, { error: 'recipe_product_invalid' }); if (productId && !repositories?.pool && !products.some((item) => item.id === productId)) return json(res, 400, { error: 'recipe_product_not_found' }); recipe.productId = productId; }
    if (input.name !== undefined) { const name = String(input.name || '').trim(); if (!name || name.length > 120) return json(res, 400, { error: 'invalid_recipe' }); recipe.name = name; }
    if (input.ingredients !== undefined) { if (!Array.isArray(input.ingredients)) return json(res, 400, { error: 'invalid_recipe' }); try { recipe.ingredients = await normalizeRecipeIngredients(input.ingredients, venueDbId); } catch (error) { return json(res, 400, { error: error.code || 'invalid_recipe_ingredients', ingredient: error.ingredient, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit }); } if (!recipe.ingredients) return json(res, 503, { error: 'recipe_ingredients_unavailable' }); }
    if (input.technology !== undefined) { recipe.technology = String(input.technology || '').trim(); if (recipe.technology.length > 4000) return json(res, 400, { error: 'invalid_recipe' }); }
    if (input.serve !== undefined) { recipe.serve = String(input.serve || '').trim(); if (recipe.serve.length > 1000) return json(res, 400, { error: 'invalid_recipe' }); } if (input.recipeType !== undefined) { if (!['sale','premix'].includes(String(input.recipeType))) return json(res, 400, { error: 'invalid_recipe_type' }); recipe.recipeType = String(input.recipeType); }
    if (recipe.recipeType === 'premix' && recipe.productId) return json(res, 400, { error: 'premix_product_binding_not_allowed' });
    if (input.yieldQuantity !== undefined || input.yieldUnit !== undefined || input.portionCount !== undefined || input.yield !== undefined || input.portions !== undefined) { try { Object.assign(recipe, normalizeRecipeOutput(input, { yieldQuantity: recipe.yieldQuantity || 1, yieldUnit: recipe.yieldUnit || 'порция', portionCount: recipe.portionCount || 1 })); } catch (error) { return json(res, 400, { error: error.code || 'invalid_recipe_output', targetUnit: error.targetUnit }); } }
    if (recipe.productId && recipe.recipeType !== 'premix') { const targetProduct = products.find((item) => item.id === recipe.productId); if (!targetProduct) return json(res, 400, { error: 'recipe_product_not_found' }); if (targetProduct.inventoryMode === 'non_stock') return json(res, 409, { error: 'non_stock_product_has_recipe' }); if (recipes.some((item) => item.id !== recipe.id && item.active !== false && item.recipeType !== 'premix' && String(item.productId || '') === String(recipe.productId))) return json(res, 409, { error: 'product_recipe_ambiguous' }); }
    Object.assign(storedRecipe, recipe); recordAudit(req, 'recipe.updated', 'recipe', recipe.id, before, recipe); return json(res, 200, recipe);
  }
  if (recipeProfile && req.method === 'DELETE') {
    if (denyUnless(req, res, 'inventory')) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(recipeProfile[1])) { try { const { rows } = await repositories.pool.query('UPDATE inventory_recipe_cards SET active=false,updated_at=now() WHERE id=$1 AND venue_id=$2 AND active=true RETURNING id,name,active', [recipeProfile[1], venueDbId]); if (!rows[0]) return json(res, 404, { error: 'recipe_not_found' }); recordAudit(req, 'recipe.archived', 'recipe', rows[0].id, { active: true }, rows[0]); return json(res, 200, rows[0]); } catch (error) { return json(res, 409, { error: 'recipe_delete_failed', detail: error.message }); } }
    const index = recipes.findIndex((item) => item.id === recipeProfile[1]); if (index < 0) return json(res, 404, { error: 'recipe_not_found' });
    const recipe = recipes.splice(index, 1)[0]; recordAudit(req, 'recipe.deleted', 'recipe', recipe.id, recipe, null); return json(res, 200, recipe);
  }
  if (pathname === '/api/products' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const name = String(input.name || '').trim(); const category = String(input.category || input.station || '').trim(); const price = Number(input.price); const inventoryMode = String(input.inventoryMode || 'tracked');
    const aliases = Array.isArray(input.aliases) ? input.aliases.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) : [];
    if (!name || name.length > 120 || !category || category.length > 80 || !Number.isFinite(price) || price < 0 || price > 10000000 || !['tracked','non_stock'].includes(inventoryMode)) return json(res, 400, { error: 'invalid_product' });
    if (input.imageUrl && (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(input.imageUrl)) || String(input.imageUrl).length > 1500000)) return json(res, 400, { error: 'invalid_image' });
    if (repositories?.products) { try { const product = await repositories.products.create({ venueId: venueDbId, name, category, price, aliases, imageUrl: input.imageUrl, inventoryMode }); recordAudit(req, 'product.created', 'product', product.id, null, product); return json(res, 201, product); } catch (error) { return json(res, 409, { error: 'product_create_failed', detail: error.message }); } }
    const product = { id: `product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, category, station: category, price, aliases, imageUrl: input.imageUrl || null, inventoryMode };
    products.push(product); recordAudit(req, 'product.created', 'product', product.id, null, product); return json(res, 201, product);
  }
  const productProfile = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productProfile && req.method === 'PATCH') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const name = input.name === undefined ? undefined : String(input.name || '').trim(); const category = input.category === undefined && input.station === undefined ? undefined : String(input.category ?? input.station ?? '').trim(); const price = input.price === undefined ? undefined : Number(input.price); const inventoryMode = input.inventoryMode === undefined ? undefined : String(input.inventoryMode);
    const aliases = input.aliases === undefined ? undefined : (Array.isArray(input.aliases) ? input.aliases.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) : null);
    if (name !== undefined && (!name || name.length > 120) || category !== undefined && (!category || category.length > 80) || price !== undefined && (!Number.isFinite(price) || price < 0 || price > 10000000) || aliases === null || inventoryMode !== undefined && !['tracked','non_stock','needs_review'].includes(inventoryMode)) return json(res, 400, { error: 'invalid_product' });
    if (input.imageUrl !== undefined && input.imageUrl && (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(input.imageUrl)) || String(input.imageUrl).length > 1500000)) return json(res, 400, { error: 'invalid_image' });
    if (repositories?.products) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT id,name,category,sale_price AS price,search_aliases AS aliases,image_url AS "imageUrl",inventory_mode AS "inventoryMode" FROM products WHERE id=$1 AND venue_id=$2 AND is_active=true FOR UPDATE', [productProfile[1], venueDbId]);
        const before = rows[0] && { ...rows[0], price: Number(rows[0].price), aliases: rows[0].aliases || [] };
        if (!before) { await client.query('ROLLBACK'); return json(res, 404, { error: 'product_not_found' }); }
        if (inventoryMode === 'non_stock') {
          const recipe = await client.query(`SELECT 1 FROM inventory_recipe_cards c WHERE c.venue_id=$1 AND c.active=true AND c.recipe_type='sale' AND (c.product_id=$2 OR (c.product_id IS NULL AND lower(btrim(c.name))=lower(btrim($3)))) UNION ALL SELECT 1 FROM recipes r JOIN recipe_items ri ON ri.product_id=r.product_id JOIN ingredients i ON i.id=ri.ingredient_id AND i.venue_id=$1 WHERE r.product_id=$2 AND ri.quantity>0 LIMIT 1`, [venueDbId, productProfile[1], name || before.name]);
          if (recipe.rowCount) { await client.query('ROLLBACK'); return json(res, 409, { error: 'non_stock_product_has_recipe' }); }
          const openOrder = await client.query("SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.venue_id=$1 AND oi.product_id=$2 AND o.status IN ('open','in_progress','ready') LIMIT 1", [venueDbId, productProfile[1]]);
          if (openOrder.rowCount) { await client.query('ROLLBACK'); return json(res, 409, { error: 'product_has_open_orders' }); }
        }
        const product = await repositories.products.update(venueDbId, productProfile[1], { name, category, price, aliases, imageUrl: input.imageUrl, inventoryMode }, client);
        await client.query('COMMIT');
        recordAudit(req, 'product.updated', 'product', product.id, before, product);
        return json(res, 200, product);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'product_update_failed', detail: error.message }); }
      finally { client.release(); }
    }
    const product = products.find((entry) => entry.id === productProfile[1]); if (!product) return json(res, 404, { error: 'product_not_found' }); if (inventoryMode === 'non_stock') { const nextName = name || product.name; if (recipes.some((recipe) => recipe.active !== false && recipe.recipeType !== 'premix' && (recipe.productId === product.id || (!recipe.productId && String(recipe.name || '').toLocaleLowerCase('ru-RU') === String(nextName).toLocaleLowerCase('ru-RU'))))) return json(res, 409, { error: 'non_stock_product_has_recipe' }); if (orders.some((order) => ['open','in_progress','ready'].includes(order.status) && (order.items || []).some((item) => item.productId === product.id))) return json(res, 409, { error: 'product_has_open_orders' }); } const before = { ...product }; if (name !== undefined) product.name = name; if (category !== undefined) { product.category = category; product.station = category; } if (price !== undefined) product.price = price; if (aliases !== undefined) product.aliases = aliases; if (inventoryMode !== undefined) product.inventoryMode = inventoryMode; if (input.imageUrl !== undefined) product.imageUrl = input.imageUrl || null; recordAudit(req, 'product.updated', 'product', product.id, before, product); return json(res, 200, product);
  }
  if (productProfile && req.method === 'DELETE') {
    if (denyUnless(req, res, 'inventory')) return;
    if (repositories?.products) { try { const product = await repositories.products.deactivate(venueDbId, productProfile[1]); if (!product) return json(res, 404, { error: 'product_not_found' }); recordAudit(req, 'product.deactivated', 'product', product.id, { active: true }, { active: false }); return json(res, 200, { ...product, active: false }); } catch (error) { return json(res, 409, { error: 'product_delete_failed', detail: error.message }); } }
    const index = products.findIndex((entry) => entry.id === productProfile[1]); if (index < 0) return json(res, 404, { error: 'product_not_found' }); const [product] = products.splice(index, 1); recordAudit(req, 'product.deactivated', 'product', product.id, { active: true }, { active: false }); return json(res, 200, { ...product, active: false });
  }
  if (pathname === '/api/loyalty/settings' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'orders') && !hasPermission(req, 'loyalty') && !hasPermission(req, 'staff_view')) return json(res, 403, { error: 'forbidden', permission: 'loyalty' });
    const expectedVenueId = url.searchParams.get('expectedVenueId');
    const selectedVenueId = repositories?.pool ? venueDbId : currentVenueId;
    if (!selectedVenueId) return json(res, 409, { error: 'venue_context_required' });
    if (expectedVenueId && String(expectedVenueId) !== String(selectedVenueId)) return json(res, 409, { error: 'venue_context_changed' });
    const defaults = { venueId: selectedVenueId, version: 0, bonusRublesPerPoint: 1, maxRedemptionPercent: 100, minimumRedemptionPoints: 1, bonusExpirationDays: null, source: 'legacy_default', effectiveAt: null };
    if (repositories?.pool) {
      try {
        const { rows } = await repositories.pool.query('SELECT venue_id AS "venueId",version,bonus_ruble_rate AS "bonusRublesPerPoint",max_redemption_percent AS "maxRedemptionPercent",min_redemption_points AS "minimumRedemptionPoints",bonus_expiration_days AS "bonusExpirationDays",effective_at AS "effectiveAt" FROM loyalty_program_settings WHERE venue_id=$1 ORDER BY version DESC LIMIT 1', [selectedVenueId]);
        const row = rows[0];
        return json(res, 200, row ? { ...row, version: Number(row.version), bonusRublesPerPoint: Number(row.bonusRublesPerPoint), maxRedemptionPercent: Number(row.maxRedemptionPercent), minimumRedemptionPoints: Number(row.minimumRedemptionPoints), bonusExpirationDays: row.bonusExpirationDays === null ? null : Number(row.bonusExpirationDays), source: 'stored' } : defaults);
      } catch (error) { return json(res, 503, { error: 'loyalty_settings_unavailable', detail: error.message }); }
    }
    return json(res, 200, { ...defaults, ...(loyaltyProgramSettings.get(String(selectedVenueId)) || {}) });
  }
  if (pathname === '/api/loyalty/promotions' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'orders') && !hasPermission(req, 'loyalty') && !hasPermission(req, 'staff_view')) return json(res, 403, { error: 'forbidden', permission: 'loyalty' });
    const selectedVenueId = repositories?.pool ? venueDbId : currentVenueId;
    const expectedVenueId = url.searchParams.get('expectedVenueId');
    if (!selectedVenueId) return json(res, 409, { error: 'venue_context_required' });
    if (expectedVenueId && String(expectedVenueId) !== String(selectedVenueId)) return json(res, 409, { error: 'venue_context_changed' });
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    if (repositories?.pool) {
      try {
        const { rows } = await repositories.pool.query(`SELECT p.venue_id AS "venueId",p.promotion_id AS "promotionId",p.version,p.name,p.description,p.status,p.starts_at AS "startsAt",p.ends_at AS "endsAt",p.timezone,p.benefit_kind AS "benefitKind",p.benefit_value AS "benefitValue",p.priority,
          COALESCE(array_agg(s.product_id::text) FILTER (WHERE s.scope_kind='include_product'), '{}') AS "includeProductIds",
          COALESCE(array_agg(s.product_id::text) FILTER (WHERE s.scope_kind='exclude_product'), '{}') AS "excludeProductIds",
          COALESCE(array_agg(s.category_name) FILTER (WHERE s.scope_kind='include_category'), '{}') AS "includeCategories",
          COALESCE(array_agg(s.category_name) FILTER (WHERE s.scope_kind='exclude_category'), '{}') AS "excludeCategories"
          FROM (SELECT DISTINCT ON (venue_id,promotion_id) * FROM loyalty_promotions WHERE venue_id=$1 ORDER BY venue_id,promotion_id,version DESC) p
          LEFT JOIN loyalty_promotion_scopes s ON s.venue_id=p.venue_id AND s.promotion_id=p.promotion_id AND s.version=p.version
          WHERE ($2::boolean OR p.status<>'archived') GROUP BY p.venue_id,p.promotion_id,p.version,p.name,p.description,p.status,p.starts_at,p.ends_at,p.timezone,p.benefit_kind,p.benefit_value,p.priority ORDER BY p.name,p.promotion_id`, [selectedVenueId, includeArchived]);
        return json(res, 200, { items: rows.map((row) => ({ ...row, version: Number(row.version), benefitValue: Number(row.benefitValue), priority: Number(row.priority) })) });
      } catch (error) { return json(res, 503, { error: 'loyalty_promotions_unavailable', detail: error.message }); }
    }
    const latest = new Map();
    for (const item of loyaltyPromotions.filter((entry) => String(entry.venueId) === String(selectedVenueId))) if (!latest.has(item.promotionId) || latest.get(item.promotionId).version < item.version) latest.set(item.promotionId, item);
    return json(res, 200, { items: [...latest.values()].filter((item) => includeArchived || item.status !== 'archived').map(({ createdBy, ...item }) => item).sort((a, b) => a.name.localeCompare(b.name, 'ru')) });
  }
  if (pathname === '/api/loyalty/promotions' && req.method === 'POST') {
    if (process.env.AUTH_REQUIRED === 'true' && !['owner', 'admin'].includes(req.user?.role)) return json(res, 403, { error: 'loyalty_promotion_owner_admin_required' });
    const input = await body(req); const selectedVenueId = repositories?.pool ? venueDbId : currentVenueId;
    if (!selectedVenueId) return json(res, 409, { error: 'venue_context_required' });
    const allowedFields = new Set(['expectedVenueId','name','description','startsAt','endsAt','timezone','benefitKind','benefitValue','priority','includeProductIds','excludeProductIds','includeCategories','excludeCategories','status']);
    if (Object.keys(input).some((key) => !allowedFields.has(key)) || (input.status !== undefined && input.status !== 'draft')) return json(res, 400, { error: 'invalid_loyalty_promotion' });
    if (!input.expectedVenueId) return json(res, 428, { error: 'loyalty_promotion_precondition_required' });
    if (String(input.expectedVenueId) !== String(selectedVenueId)) return json(res, 409, { error: 'venue_context_changed' });
    const promotion = normalizePromotionInput({ ...input, status: 'draft' });
    if (!promotion) return json(res, 400, { error: 'invalid_loyalty_promotion' });
    if (repositories?.pool) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const ids = [...promotion.includeProductIds, ...promotion.excludeProductIds];
        if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) { await client.query('ROLLBACK'); return json(res, 400, { error: 'loyalty_promotion_scope_invalid' }); }
        if (ids.length) { const found = await client.query('SELECT id FROM products WHERE venue_id=$1 AND id=ANY($2::uuid[]) AND is_active=true', [selectedVenueId, ids]); if (found.rowCount !== ids.length) { await client.query('ROLLBACK'); return json(res, 400, { error: 'loyalty_promotion_scope_invalid' }); } }
        const categories = [...promotion.includeCategories, ...promotion.excludeCategories];
        if (categories.length) { const found = await client.query('SELECT DISTINCT category FROM products WHERE venue_id=$1 AND is_active=true AND category=ANY($2::text[])', [selectedVenueId, categories]); if (found.rowCount !== categories.length) { await client.query('ROLLBACK'); return json(res, 400, { error: 'loyalty_promotion_scope_invalid' }); } }
        const { rows } = await client.query(`INSERT INTO loyalty_promotions (venue_id,version,name,description,status,starts_at,ends_at,timezone,benefit_kind,benefit_value,priority,created_by)
          VALUES ($1,1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10) RETURNING promotion_id AS "promotionId",version,name,description,status,starts_at AS "startsAt",ends_at AS "endsAt",timezone,benefit_kind AS "benefitKind",benefit_value AS "benefitValue",priority`, [selectedVenueId, promotion.name, promotion.description, promotion.startsAt, promotion.endsAt, promotion.timezone, promotion.benefitKind, promotion.benefitValue, promotion.priority, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]);
        for (const [kind, values] of [['include_product', promotion.includeProductIds], ['exclude_product', promotion.excludeProductIds], ['include_category', promotion.includeCategories], ['exclude_category', promotion.excludeCategories]]) for (const value of values) await client.query('INSERT INTO loyalty_promotion_scopes (venue_id,promotion_id,version,scope_kind,product_id,category_name) VALUES ($1,$2,$3,$4,$5,$6)', [selectedVenueId, rows[0].promotionId, rows[0].version, kind, kind.endsWith('product') ? value : null, kind.endsWith('category') ? value : null]);
        const after = { ...rows[0], ...promotion };
        await client.query('INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,$2,$3,$4,$5,NULL,$6)', [selectedVenueId, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null, 'loyalty.promotion_created', 'loyalty_promotion', rows[0].promotionId, JSON.stringify(after)]);
        await client.query('COMMIT'); return json(res, 201, after);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 503, { error: 'loyalty_promotion_save_failed', detail: error.message }); } finally { client.release(); }
    }
    const categories = [...promotion.includeCategories, ...promotion.excludeCategories];
    if ([...promotion.includeProductIds, ...promotion.excludeProductIds].some((id) => !products.some((product) => String(product.id) === id))) return json(res, 400, { error: 'loyalty_promotion_scope_invalid' });
    if (categories.some((category) => !products.some((product) => String(product.category || product.station || '') === category))) return json(res, 400, { error: 'loyalty_promotion_scope_invalid' });
    const saved = { promotionId: `promotion-${crypto.randomUUID()}`, version: 1, ...promotion, venueId: selectedVenueId, createdBy: req.user?.id || null };
    loyaltyPromotions.push(saved); recordAudit(req, 'loyalty.promotion_created', 'loyalty_promotion', null, null, saved); return json(res, 201, Object.fromEntries(Object.entries(saved).filter(([key]) => !['venueId', 'createdBy'].includes(key))));
  }
  const promotionProfile = pathname.match(/^\/api\/loyalty\/promotions\/([^/]+)$/);
  if (promotionProfile && req.method === 'PATCH') {
    if (process.env.AUTH_REQUIRED === 'true' && !['owner', 'admin'].includes(req.user?.role)) return json(res, 403, { error: 'loyalty_promotion_owner_admin_required' });
    const input = await body(req); const selectedVenueId = repositories?.pool ? venueDbId : currentVenueId;
    const allowedFields = new Set(['expectedVenueId','expectedVersion','name','description','startsAt','endsAt','timezone','benefitKind','benefitValue','priority','includeProductIds','excludeProductIds','includeCategories','excludeCategories','status']);
    if (Object.keys(input).some((key) => !allowedFields.has(key))) return json(res, 400, { error: 'invalid_loyalty_promotion' });
    if (!Number.isInteger(Number(input.expectedVersion)) || !input.expectedVenueId) return json(res, 428, { error: 'loyalty_promotion_precondition_required' });
    if (String(input.expectedVenueId) !== String(selectedVenueId)) return json(res, 409, { error: 'venue_context_changed' });
    if (repositories?.pool) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize campaign activation/version changes against order price capture for this venue.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('loyalty_promotions_venue'),hashtext($1::text))", [selectedVenueId]);
        const latest = await client.query('SELECT promotion_id AS "promotionId",version,name,description,status,starts_at AS "startsAt",ends_at AS "endsAt",timezone,benefit_kind AS "benefitKind",benefit_value AS "benefitValue",priority FROM loyalty_promotions WHERE venue_id=$1 AND promotion_id=$2 ORDER BY version DESC LIMIT 1', [selectedVenueId, promotionProfile[1]]);
        if (!latest.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'loyalty_promotion_not_found' }); }
        const base = latest.rows[0];
        if (Number(base.version) !== Number(input.expectedVersion)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'loyalty_promotion_version_conflict', currentVersion: Number(base.version) }); }
        const scope = await client.query('SELECT scope_kind AS kind,product_id AS "productId",category_name AS category FROM loyalty_promotion_scopes WHERE venue_id=$1 AND promotion_id=$2 AND version=$3', [selectedVenueId, promotionProfile[1], base.version]);
        const previous = { ...base, includeProductIds: scope.rows.filter((r) => r.kind === 'include_product').map((r) => r.productId), excludeProductIds: scope.rows.filter((r) => r.kind === 'exclude_product').map((r) => r.productId), includeCategories: scope.rows.filter((r) => r.kind === 'include_category').map((r) => r.category), excludeCategories: scope.rows.filter((r) => r.kind === 'exclude_category').map((r) => r.category) };
        const next = normalizePromotionInput(input, previous);
        if (!next) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_loyalty_promotion' }); }
        if (next.status === 'archived' && !promotionTermsEqual(previous, next)) { await client.query('ROLLBACK'); return json(res, 400, { error: 'loyalty_promotion_archive_terms_immutable' }); }
        const ids = [...next.includeProductIds, ...next.excludeProductIds];
        if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) { await client.query('ROLLBACK'); return json(res, 400, { error: 'loyalty_promotion_scope_invalid' }); }
        const previousIncludeIds = new Set(previous.includeProductIds); const previousExcludeIds = new Set(previous.excludeProductIds);
        const addedIds = [...next.includeProductIds.filter((id) => !previousIncludeIds.has(id)), ...next.excludeProductIds.filter((id) => !previousExcludeIds.has(id))];
        if (ids.length) { const found = await client.query('SELECT id,is_active AS active FROM products WHERE venue_id=$1 AND id=ANY($2::uuid[])', [selectedVenueId, ids]); if (found.rowCount !== ids.length || addedIds.some((id) => !found.rows.some((row) => row.id === id && row.active))) { await client.query('ROLLBACK'); return json(res, 400, { error: 'loyalty_promotion_scope_invalid' }); } }
        const categories = [...next.includeCategories, ...next.excludeCategories];
        const previousIncludeCategories = new Set(previous.includeCategories); const previousExcludeCategories = new Set(previous.excludeCategories);
        const addedCategories = [...next.includeCategories.filter((category) => !previousIncludeCategories.has(category)), ...next.excludeCategories.filter((category) => !previousExcludeCategories.has(category))];
        if (addedCategories.length) { const found = await client.query('SELECT DISTINCT category FROM products WHERE venue_id=$1 AND is_active=true AND category=ANY($2::text[])', [selectedVenueId, addedCategories]); if (found.rowCount !== addedCategories.length) { await client.query('ROLLBACK'); return json(res, 400, { error: 'loyalty_promotion_scope_invalid' }); } }
        const { rows } = await client.query(`INSERT INTO loyalty_promotions (venue_id,promotion_id,version,name,description,status,starts_at,ends_at,timezone,benefit_kind,benefit_value,priority,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING promotion_id AS "promotionId",version,name,description,status,starts_at AS "startsAt",ends_at AS "endsAt",timezone,benefit_kind AS "benefitKind",benefit_value AS "benefitValue",priority`, [selectedVenueId, promotionProfile[1], Number(base.version) + 1, next.name, next.description, next.status, next.startsAt, next.endsAt, next.timezone, next.benefitKind, next.benefitValue, next.priority, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]);
        for (const [kind, values] of [['include_product', next.includeProductIds], ['exclude_product', next.excludeProductIds], ['include_category', next.includeCategories], ['exclude_category', next.excludeCategories]]) for (const value of values) await client.query('INSERT INTO loyalty_promotion_scopes (venue_id,promotion_id,version,scope_kind,product_id,category_name) VALUES ($1,$2,$3,$4,$5,$6)', [selectedVenueId, promotionProfile[1], Number(base.version) + 1, kind, kind.endsWith('product') ? value : null, kind.endsWith('category') ? value : null]);
        const after = { ...rows[0], ...next }; await client.query('INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [selectedVenueId, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null, next.status === 'archived' ? 'loyalty.promotion_archived' : 'loyalty.promotion_version_created', 'loyalty_promotion', promotionProfile[1], JSON.stringify(previous), JSON.stringify(after)]);
        await client.query('COMMIT'); return json(res, 200, after);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 503, { error: 'loyalty_promotion_save_failed', detail: error.message }); } finally { client.release(); }
    }
    const matches = loyaltyPromotions.filter((entry) => entry.promotionId === promotionProfile[1] && String(entry.venueId) === String(selectedVenueId)).sort((a, b) => b.version - a.version);
    const previous = matches[0]; if (!previous) return json(res, 404, { error: 'loyalty_promotion_not_found' });
    if (previous.version !== Number(input.expectedVersion)) return json(res, 409, { error: 'loyalty_promotion_version_conflict', currentVersion: previous.version });
    const next = normalizePromotionInput(input, previous); if (!next) return json(res, 400, { error: 'invalid_loyalty_promotion' });
    if (next.status === 'archived' && !promotionTermsEqual(previous, next)) return json(res, 400, { error: 'loyalty_promotion_archive_terms_immutable' });
    const categories = [...next.includeCategories, ...next.excludeCategories];
    if (next.status !== 'archived') {
      const previousIncludeIds = new Set(previous.includeProductIds); const previousExcludeIds = new Set(previous.excludeProductIds);
      const addedIds = [...next.includeProductIds.filter((id) => !previousIncludeIds.has(id)), ...next.excludeProductIds.filter((id) => !previousExcludeIds.has(id))];
      if (addedIds.some((id) => !products.some((product) => String(product.id) === id && product.active !== false))) return json(res, 400, { error: 'loyalty_promotion_scope_invalid' });
      const previousIncludeCategories = new Set(previous.includeCategories); const previousExcludeCategories = new Set(previous.excludeCategories);
      const addedCategories = [...next.includeCategories.filter((category) => !previousIncludeCategories.has(category)), ...next.excludeCategories.filter((category) => !previousExcludeCategories.has(category))];
      if (addedCategories.some((category) => !products.some((product) => String(product.category || product.station || '') === category && product.active !== false))) return json(res, 400, { error: 'loyalty_promotion_scope_invalid' });
    }
    const saved = { ...next, promotionId: previous.promotionId, version: previous.version + 1, venueId: previous.venueId, createdBy: req.user?.id || null };
    loyaltyPromotions.push(saved); recordAudit(req, saved.status === 'archived' ? 'loyalty.promotion_archived' : 'loyalty.promotion_version_created', 'loyalty_promotion', null, previous, saved);
    return json(res, 200, Object.fromEntries(Object.entries(saved).filter(([key]) => !['venueId', 'createdBy'].includes(key))));
  }
  if (pathname === '/api/loyalty/reconciliation' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'finance_read') && !hasPermission(req, 'finance')) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
    if (process.env.AUTH_REQUIRED === 'true' && isOperationalEmployee(req)) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
    const canReviewLegacyReservations = process.env.AUTH_REQUIRED !== 'true' || (['owner', 'admin'].includes(String(req.user?.role || '').toLowerCase()) && hasPermission(req, 'finance'));
    const selectedVenueId = repositories?.pool ? venueDbId : currentVenueId;
    if (!selectedVenueId) return json(res, 409, { error: 'venue_context_required' });
    const requestedFrom = String(url.searchParams.get('from') || ''); const requestedTo = String(url.searchParams.get('to') || '');
    const validReportDate=(value)=>{if(!value)return true;if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const parsed=new Date(`${value}T00:00:00Z`);return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;};
    if (!validReportDate(requestedFrom) || !validReportDate(requestedTo)) return json(res, 400, { error: 'invalid_reconciliation_date' });
    if (repositories?.pool) {
      try {
        const businessContext = await venueBusinessDateContext(repositories.pool, selectedVenueId); if (!businessContext) return json(res,503,{error:'venue_context_required'});
        const periodTo = requestedTo || businessContext.date; const periodFrom = requestedFrom || `${periodTo.slice(0,8)}01`;
        if (periodFrom > periodTo) return json(res,400,{error:'invalid_reconciliation_period'});
        const periodBounds = [periodFrom,periodTo,businessContext.timezone];
        const { rows } = await repositories.pool.query(`WITH wallet AS (
          SELECT id AS guest_id, loyalty_points::numeric AS bonus_balance, deposit_balance::numeric AS deposit_balance FROM guests WHERE venue_id=$1
        ), ledger AS (
          SELECT guest_id,account_type,SUM(amount)::numeric AS balance FROM guest_account_entries WHERE venue_id=$1 GROUP BY guest_id,account_type
        ), differences AS (
          SELECT w.guest_id,'bonus'::text AS account_type,w.bonus_balance AS wallet_balance,COALESCE(l.balance,0)::numeric AS ledger_balance FROM wallet w LEFT JOIN ledger l ON l.guest_id=w.guest_id AND l.account_type='bonus'
          UNION ALL
          SELECT w.guest_id,'deposit'::text,w.deposit_balance,COALESCE(l.balance,0)::numeric FROM wallet w LEFT JOIN ledger l ON l.guest_id=w.guest_id AND l.account_type='deposit'
        ), movements AS (
          SELECT
            COALESCE(SUM(amount) FILTER (WHERE account_type='bonus' AND source_type='order' AND source_key LIKE '%:bonus-earned:%' AND amount>0),0)::numeric AS bonus_issued,
            COALESCE(-SUM(amount) FILTER (WHERE account_type='bonus' AND source_type='order' AND amount<0),0)::numeric AS bonus_redeemed,
            COALESCE(SUM(amount) FILTER (WHERE account_type='bonus' AND source_type='reversal' AND amount>0),0)::numeric AS bonus_returned,
            COALESCE(SUM(amount) FILTER (WHERE account_type='deposit' AND source_type='deposit_top_up' AND amount>0),0)::numeric AS deposit_topped_up,
            COALESCE(-SUM(amount) FILTER (WHERE account_type='deposit' AND source_type='order' AND amount<0),0)::numeric AS deposit_redeemed,
            COALESCE(SUM(amount) FILTER (WHERE account_type='deposit' AND source_type='reversal' AND amount>0),0)::numeric AS deposit_returned
          FROM guest_account_entries WHERE venue_id=$1
        ), clawbacks AS (
          SELECT COALESCE(SUM(amount),0)::numeric AS outstanding FROM guest_bonus_clawback_entries WHERE venue_id=$1
        )
        SELECT
          COALESCE(SUM(wallet_balance) FILTER (WHERE account_type='bonus'),0)::numeric AS bonus_wallet,
          COALESCE(SUM(ledger_balance) FILTER (WHERE account_type='bonus'),0)::numeric AS bonus_ledger,
          COUNT(*) FILTER (WHERE account_type='bonus' AND wallet_balance<>ledger_balance)::int AS bonus_mismatch_count,
          COALESCE(SUM(ABS(wallet_balance-ledger_balance)) FILTER (WHERE account_type='bonus'),0)::numeric AS bonus_mismatch_amount,
          COALESCE(SUM(wallet_balance) FILTER (WHERE account_type='deposit'),0)::numeric AS deposit_wallet,
          COALESCE(SUM(ledger_balance) FILTER (WHERE account_type='deposit'),0)::numeric AS deposit_ledger,
          COUNT(*) FILTER (WHERE account_type='deposit' AND wallet_balance<>ledger_balance)::int AS deposit_mismatch_count,
          COALESCE(SUM(ABS(wallet_balance-ledger_balance)) FILTER (WHERE account_type='deposit'),0)::numeric AS deposit_mismatch_amount,
          (SELECT outstanding FROM clawbacks) AS bonus_clawback_outstanding,
          (SELECT bonus_issued FROM movements) AS bonus_issued,
          (SELECT bonus_redeemed FROM movements) AS bonus_redeemed,
          (SELECT bonus_returned FROM movements) AS bonus_returned,
          (SELECT deposit_topped_up FROM movements) AS deposit_topped_up,
          (SELECT deposit_redeemed FROM movements) AS deposit_redeemed,
          (SELECT deposit_returned FROM movements) AS deposit_returned,
          (SELECT COUNT(*)::int FROM wallet) AS guest_count,
          now() AS generated_at
        FROM differences`, [selectedVenueId]);
        const row=rows[0];
        const {rows:flowRows}=await repositories.pool.query(`WITH bounds AS (SELECT ($1::date::timestamp AT TIME ZONE $3) AS starts_at,(($2::date+1)::timestamp AT TIME ZONE $3) AS ends_at), receipt_state AS (
          SELECT p.venue_id,p.reservation_id,p.id,p.amount-COALESCE(a.applied,0)+COALESCE(ar.reversed,0)-COALESCE(rr.refunded,0) AS remaining
          FROM reservation_pre_payment_receipts p CROSS JOIN bounds b
          LEFT JOIN LATERAL (SELECT SUM(x.amount) AS applied FROM reservation_pre_payment_allocations x WHERE x.venue_id=p.venue_id AND x.receipt_id=p.id) a ON true
          LEFT JOIN LATERAL (SELECT SUM(x.amount) AS reversed FROM reservation_pre_payment_allocation_reversals x JOIN reservation_pre_payment_allocations ax ON ax.venue_id=x.venue_id AND ax.id=x.allocation_id WHERE x.venue_id=p.venue_id AND ax.receipt_id=p.id) ar ON true
          LEFT JOIN LATERAL (SELECT SUM(x.amount) AS refunded FROM reservation_pre_payment_receipt_reversals x WHERE x.venue_id=p.venue_id AND x.receipt_id=p.id) rr ON true
          WHERE p.venue_id=$4
        ), prepayment_check AS (SELECT r.id,r.verified_deposit_paid,COALESCE(p.receipts,0)-COALESCE(ref.refunds,0) AS receipt_total
          FROM reservations r
          LEFT JOIN LATERAL (SELECT SUM(x.amount) AS receipts FROM reservation_pre_payment_receipts x WHERE x.venue_id=r.venue_id AND x.reservation_id=r.id) p ON true
          LEFT JOIN LATERAL (SELECT SUM(x.amount) AS refunds FROM reservation_pre_payment_receipts src JOIN reservation_pre_payment_receipt_reversals x ON x.venue_id=src.venue_id AND x.receipt_id=src.id WHERE src.venue_id=r.venue_id AND src.reservation_id=r.id) ref ON true
          WHERE r.venue_id=$4)
          SELECT
          COALESCE((SELECT SUM(e.amount) FROM guest_account_entries e,bounds b WHERE e.venue_id=$4 AND e.account_type='bonus' AND e.source_type='order' AND e.source_key LIKE '%:bonus-earned:%' AND e.amount>0 AND e.created_at>=b.starts_at AND e.created_at<b.ends_at),0)::numeric AS bonus_issued,
          COALESCE((SELECT -SUM(e.amount) FROM guest_account_entries e,bounds b WHERE e.venue_id=$4 AND e.account_type='bonus' AND e.source_type='order' AND e.amount<0 AND e.created_at>=b.starts_at AND e.created_at<b.ends_at),0)::numeric AS bonus_redeemed,
          COALESCE((SELECT SUM(x.amount) FROM guest_account_reversals x,bounds b WHERE x.venue_id=$4 AND x.account_type='bonus' AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS bonus_reversed,
          COALESCE((SELECT SUM(x.amount) FROM guest_bonus_clawback_entries x,bounds b WHERE x.venue_id=$4 AND x.amount>0 AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS bonus_clawback_added,
          COALESCE((SELECT -SUM(x.amount) FROM guest_bonus_clawback_entries x,bounds b WHERE x.venue_id=$4 AND x.amount<0 AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS bonus_clawback_released,
          COALESCE((SELECT SUM(x.amount) FROM guest_deposit_receipts x,bounds b WHERE x.venue_id=$4 AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS deposit_topped_up,
          COALESCE((SELECT -SUM(e.amount) FROM guest_account_entries e,bounds b WHERE e.venue_id=$4 AND e.account_type='deposit' AND e.source_type='order' AND e.amount<0 AND e.created_at>=b.starts_at AND e.created_at<b.ends_at),0)::numeric AS deposit_redeemed,
          COALESCE((SELECT SUM(x.amount) FROM guest_account_reversals x,bounds b WHERE x.venue_id=$4 AND x.account_type='deposit' AND x.payout_method='wallet' AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS deposit_reversed,
          COALESCE((SELECT SUM(x.amount) FROM guest_account_reversals x,bounds b WHERE x.venue_id=$4 AND x.account_type='deposit' AND x.payout_method IN ('cash','card','qr') AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS deposit_external_refund,
          COALESCE((SELECT SUM(x.amount) FROM reservation_pre_payment_receipts x,bounds b WHERE x.venue_id=$4 AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS prepayment_collected,
          COALESCE((SELECT SUM(x.amount) FROM reservation_pre_payment_allocations x,bounds b WHERE x.venue_id=$4 AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS prepayment_applied,
          COALESCE((SELECT SUM(x.amount) FROM reservation_pre_payment_allocation_reversals x,bounds b WHERE x.venue_id=$4 AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS prepayment_reopened,
          COALESCE((SELECT SUM(x.amount) FROM reservation_pre_payment_receipt_reversals x,bounds b WHERE x.venue_id=$4 AND x.created_at>=b.starts_at AND x.created_at<b.ends_at),0)::numeric AS prepayment_refunded,
          COALESCE((SELECT SUM(GREATEST(remaining,0)) FROM receipt_state),0)::numeric AS prepayment_outstanding,
          COALESCE((SELECT COUNT(*) FROM prepayment_check WHERE verified_deposit_paid<>receipt_total),0)::int AS prepayment_mismatch_count,
          COALESCE((SELECT SUM(ABS(verified_deposit_paid-receipt_total)) FROM prepayment_check),0)::numeric AS prepayment_mismatch_amount,
          COALESCE((SELECT SUM(deposit_paid) FROM reservations WHERE venue_id=$4 AND deposit_paid>0),0)::numeric AS legacy_unverified_deposit,
          COALESCE((SELECT COUNT(*) FROM reservations WHERE venue_id=$4 AND deposit_paid>0),0)::int AS legacy_unverified_count,
          (SELECT starts_at FROM bounds) AS starts_at,(SELECT ends_at FROM bounds) AS ends_at,
          COALESCE((SELECT SUM(amount) FROM guest_bonus_clawback_entries WHERE venue_id=$4),0)::numeric AS clawback_outstanding`,[periodFrom,periodTo,businessContext.timezone,selectedVenueId]);
        const flow=flowRows[0]||{}; const n=(key)=>Number(flow[key]||0);
        const {rows:businessRows}=await repositories.pool.query(`WITH bounds AS (SELECT ($1::date::timestamp AT TIME ZONE $3) starts_at,(($2::date+1)::timestamp AT TIME ZONE $3) ends_at), closed_sales AS (
          SELECT o.*,
            (SELECT s.subtotal_minor/100.0 FROM pos_order_pricing_snapshots s WHERE s.venue_id=o.venue_id AND s.order_id=o.id) AS canonical_gross,
            (SELECT s.discount_minor/100.0 FROM pos_order_pricing_snapshots s WHERE s.venue_id=o.venue_id AND s.order_id=o.id) AS canonical_discount,
            (SELECT s.minimum_adjustment_minor/100.0 FROM pos_order_pricing_snapshots s WHERE s.venue_id=o.venue_id AND s.order_id=o.id) AS canonical_minimum_adjustment,
            (SELECT s.final_total_minor/100.0 FROM pos_order_pricing_snapshots s WHERE s.venue_id=o.venue_id AND s.order_id=o.id) AS canonical_final_total,
            (SELECT COALESCE(SUM(oi.quantity*oi.unit_price),0) FROM order_items oi WHERE oi.order_id=o.id) AS legacy_gross,
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.order_id=o.id AND p.status IN ('paid','partially_paid')) AS legacy_paid
          FROM orders o,bounds b WHERE o.venue_id=$4 AND o.status='closed' AND o.closed_at>=b.starts_at AND o.closed_at<b.ends_at
        ), receipts AS (
          SELECT p.payment_method AS method,p.amount,'guest_account_top_up'::text AS source FROM guest_deposit_receipts p,bounds b WHERE p.venue_id=$4 AND p.created_at>=b.starts_at AND p.created_at<b.ends_at
          UNION ALL SELECT p.payment_method,p.amount,'reservation_prepayment' FROM reservation_pre_payment_receipts p,bounds b WHERE p.venue_id=$4 AND p.created_at>=b.starts_at AND p.created_at<b.ends_at
          UNION ALL SELECT p.method,p.amount,'order_payment' FROM payments p JOIN orders o ON o.id=p.order_id CROSS JOIN bounds b WHERE o.venue_id=$4 AND p.method IN ('cash','card','qr') AND p.status IN ('paid','partially_paid') AND p.created_at>=b.starts_at AND p.created_at<b.ends_at
        ), payouts AS (
          SELECT x.payout_method AS method,x.amount,'guest_account_refund'::text AS source FROM guest_account_reversals x,bounds b WHERE x.venue_id=$4 AND x.payout_method IN ('cash','card','qr') AND x.created_at>=b.starts_at AND x.created_at<b.ends_at
          UNION ALL SELECT x.payout_method,x.amount,'reservation_prepayment_refund' FROM reservation_pre_payment_receipt_reversals x,bounds b WHERE x.venue_id=$4 AND x.created_at>=b.starts_at AND x.created_at<b.ends_at
          UNION ALL SELECT t.payout_method,t.amount,'order_refund' FROM order_refund_tenders t JOIN order_refunds r ON r.venue_id=t.venue_id AND r.id=t.refund_id,bounds b WHERE t.venue_id=$4 AND t.payout_method IN ('cash','card','qr') AND t.created_at>=b.starts_at AND t.created_at<b.ends_at
        )
        SELECT
          (SELECT COUNT(*)::int FROM closed_sales) AS sale_count,
          (SELECT COUNT(*)::int FROM closed_sales WHERE canonical_gross IS NULL) AS unsnapshotted_sale_count,
          COALESCE((SELECT SUM(COALESCE(canonical_gross,subtotal_snapshot)) FROM closed_sales),0)::numeric AS sale_gross,
          COALESCE((SELECT SUM(COALESCE(canonical_discount,discount_total_snapshot)) FROM closed_sales),0)::numeric AS discounts_total,
          COALESCE((SELECT SUM(COALESCE(canonical_final_total,final_total_snapshot)) FROM closed_sales),0)::numeric AS sale_net,
          COALESCE((SELECT SUM(COALESCE(canonical_minimum_adjustment,minimum_adjustment_snapshot)) FROM closed_sales),0)::numeric AS minimum_adjustment,
          COALESCE((SELECT jsonb_object_agg(source,amount) FROM (SELECT COALESCE(effective_discount_source,'none') source,SUM(COALESCE(discount_total_snapshot,0)) amount FROM closed_sales GROUP BY 1) x),'{}'::jsonb) AS discounts_by_source,
          COALESCE((SELECT jsonb_object_agg(group_name,amount) FROM (SELECT COALESCE(group_discount_name,'Без группы') group_name,SUM(COALESCE(group_discount_amount,0)) amount FROM closed_sales WHERE COALESCE(group_discount_amount,0)>0 GROUP BY 1) x),'{}'::jsonb) AS discounts_by_group,
          COALESCE((SELECT jsonb_object_agg(promotion_name,amount) FROM (SELECT selected_promotion_name promotion_name,SUM(COALESCE(selected_promotion_amount,0)) amount FROM closed_sales WHERE selected_promotion_name IS NOT NULL GROUP BY 1) x),'{}'::jsonb) AS discounts_by_promotion,
          COALESCE((SELECT jsonb_object_agg(method,amount) FROM (SELECT method,SUM(amount) amount FROM receipts GROUP BY method) x),'{}'::jsonb) AS receipts_by_method,
          COALESCE((SELECT jsonb_object_agg(source,amount) FROM (SELECT source,SUM(amount) amount FROM receipts GROUP BY source) x),'{}'::jsonb) AS receipts_by_source,
          COALESCE((SELECT jsonb_object_agg(method,amount) FROM (SELECT method,SUM(amount) amount FROM payouts GROUP BY method) x),'{}'::jsonb) AS payouts_by_method,
          COALESCE((SELECT jsonb_object_agg(source,amount) FROM (SELECT source,SUM(amount) amount FROM payouts GROUP BY source) x),'{}'::jsonb) AS payouts_by_source`,[periodFrom,periodTo,businessContext.timezone,selectedVenueId]);
        const business=businessRows[0]||{}; const asNumbers=(value)=>Object.fromEntries(Object.entries(value||{}).map(([key,amount])=>[key,Number(amount||0)]));
         const {rows:legacyRows}=canReviewLegacyReservations?await repositories.pool.query(`SELECT r.id,r.starts_at AS "startsAt",r.status,r.deposit_required AS "depositRequired",r.deposit_paid AS "legacyAmount",r.verified_deposit_paid AS "verifiedAmount",g.full_name AS "guestName",COALESCE(receipt.receipt_count,0)::int AS "receiptCount",COALESCE(receipt.receipt_total,0)::numeric AS "receiptTotal",review_head.id AS "reviewId",COALESCE(review_head.disposition,'unreviewed') AS "reviewDisposition",review_head.review_note AS "reviewNote",review_head.evidence_reference AS "evidenceReference",review_head.created_at AS "reviewedAt",COALESCE(review_history.items,'[]'::jsonb) AS "reviewHistory"
          FROM reservations r LEFT JOIN guests g ON g.id=r.guest_id AND g.venue_id=r.venue_id
          LEFT JOIN LATERAL (SELECT COUNT(*) AS receipt_count,SUM(GREATEST(0,p.amount-COALESCE(rr.refunded,0))) AS receipt_total FROM reservation_pre_payment_receipts p LEFT JOIN LATERAL (SELECT SUM(x.amount) AS refunded FROM reservation_pre_payment_receipt_reversals x WHERE x.venue_id=p.venue_id AND x.receipt_id=p.id) rr ON true WHERE p.venue_id=r.venue_id AND p.reservation_id=r.id) receipt ON true
          LEFT JOIN LATERAL (SELECT id,disposition,review_note,evidence_reference,created_at FROM reservation_legacy_deposit_reviews WHERE venue_id=r.venue_id AND reservation_id=r.id ORDER BY sequence DESC LIMIT 1) review_head ON true
          LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',x.id,'sequence',x.sequence,'disposition',x.disposition,'note',x.review_note,'evidenceReference',x.evidence_reference,'createdAt',x.created_at,'actorName',u.full_name) ORDER BY x.sequence) AS items FROM reservation_legacy_deposit_reviews x LEFT JOIN users u ON u.id=x.actor_id AND (u.venue_id=x.venue_id OR u.organization_id=(SELECT organization_id FROM venues WHERE id=x.venue_id)) WHERE x.venue_id=r.venue_id AND x.reservation_id=r.id) review_history ON true
          WHERE r.venue_id=$1 AND r.deposit_paid>0 ORDER BY r.starts_at DESC,r.id LIMIT 251`,[selectedVenueId]):{rows:[]};
         const legacyReservations=canReviewLegacyReservations?legacyRows.slice(0,250).map((item)=>({...item,depositRequired:Number(item.depositRequired||0),legacyAmount:Number(item.legacyAmount||0),verifiedAmount:Number(item.verifiedAmount||0),receiptCount:Number(item.receiptCount||0),receiptTotal:Number(item.receiptTotal||0),reviewHistory:item.reviewHistory||[],reviewStatus:Number(item.receiptCount||0)>0?'legacy_and_verified_receipts':'legacy_unverified'})):[];
         return json(res,200,{venueId:selectedVenueId,generatedAt:row.generated_at,guestCount:Number(row.guest_count||0),period:{from:periodFrom,to:periodTo,timeZone:businessContext.timezone,startsAt:flow.starts_at,endsAtExclusive:flow.ends_at},balances:{bonus:{wallet:Number(row.bonus_wallet||0),ledger:Number(row.bonus_ledger||0),mismatchCount:Number(row.bonus_mismatch_count||0),mismatchAmount:Number(row.bonus_mismatch_amount||0),outstandingClawback:n('clawback_outstanding')},deposit:{wallet:Number(row.deposit_wallet||0),ledger:Number(row.deposit_ledger||0),mismatchCount:Number(row.deposit_mismatch_count||0),mismatchAmount:Number(row.deposit_mismatch_amount||0)},reservationPrepayment:{unapplied:n('prepayment_outstanding'),verifiedCounterMismatchCount:n('prepayment_mismatch_count'),verifiedCounterMismatchAmount:n('prepayment_mismatch_amount'),legacyUnverified:n('legacy_unverified_deposit'),legacyReservationCount:n('legacy_unverified_count'),legacyReviewReturnedCount:canReviewLegacyReservations?legacyReservations.length:0,legacyReviewTruncated:canReviewLegacyReservations&&legacyRows.length>250}},legacyReviewAccessRequired:!canReviewLegacyReservations,legacyReservations,bonus:{issued:Number(row.bonus_issued||0),redeemed:Number(row.bonus_redeemed||0),returned:Number(row.bonus_returned||0),outstandingClawback:n('clawback_outstanding')},deposit:{toppedUp:Number(row.deposit_topped_up||0),redeemed:Number(row.deposit_redeemed||0),returned:Number(row.deposit_returned||0)},periodMovements:{bonus:{issued:n('bonus_issued'),redeemed:n('bonus_redeemed'),reversed:n('bonus_reversed'),clawbackAdded:n('bonus_clawback_added'),clawbackReleased:n('bonus_clawback_released')},deposit:{toppedUp:n('deposit_topped_up'),redeemed:n('deposit_redeemed'),reversed:n('deposit_reversed'),externalRefund:n('deposit_external_refund')},reservationPrepayment:{collected:n('prepayment_collected'),applied:n('prepayment_applied'),reopened:n('prepayment_reopened'),refunded:n('prepayment_refunded')}},periodBusiness:{sales:{orders:Number(business.sale_count||0),unsnapshottedOrders:Number(business.unsnapshotted_sale_count||0),gross:Number(business.sale_gross||0),discounts:Number(business.discounts_total||0),minimumAdjustment:Number(business.minimum_adjustment||0),net:Number(business.sale_net||0),discountsBySource:asNumbers(business.discounts_by_source),discountsByGroup:asNumbers(business.discounts_by_group),discountsByPromotion:asNumbers(business.discounts_by_promotion)},receipts:{byMethod:asNumbers(business.receipts_by_method),bySource:asNumbers(business.receipts_by_source)},payouts:{byMethod:asNumbers(business.payouts_by_method),bySource:asNumbers(business.payouts_by_source)}}});
      } catch (error) { return json(res,503,{error:'loyalty_reconciliation_unavailable',detail:error.message}); }
    }
    const reconciliationTimezone=resolveIanaTimezone(venue?.timezone,businessTimezone); const formatVenueDate=(value)=>new Intl.DateTimeFormat('en-CA',{timeZone:reconciliationTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(value instanceof Date?value:new Date(value));
    const periodTo=requestedTo||formatVenueDate(new Date()); const periodFrom=requestedFrom||`${periodTo.slice(0,8)}01`; if(periodFrom>periodTo)return json(res,400,{error:'invalid_reconciliation_period'});
    const venueGuests=clients.filter((guest)=>guest.venueId===currentVenueId);
    const entries=venueGuests.flatMap((guest)=>guest.accountEntries||[]);
    const balance=(guest,type)=>Number(type==='bonus'?(guest.loyaltyPoints??guest.bonusBalance??0):(guest.depositBalance||0));
    const ledger=(guest,type)=>(guest.accountEntries||[]).filter((entry)=>entry.accountType===type).reduce((sum,entry)=>sum+Number(entry.amount||0),0);
    const summarize=(type)=>{const mismatches=venueGuests.filter((guest)=>Math.round(balance(guest,type)*100)!==Math.round(ledger(guest,type)*100));return{wallet:venueGuests.reduce((sum,guest)=>sum+balance(guest,type),0),ledger:venueGuests.reduce((sum,guest)=>sum+ledger(guest,type),0),mismatchCount:mismatches.length,mismatchAmount:mismatches.reduce((sum,guest)=>sum+Math.abs(balance(guest,type)-ledger(guest,type)),0)}};
    const sum=(filter)=>entries.filter(filter).reduce((total,entry)=>total+Number(entry.amount||0),0); const inPeriod=(createdAt)=>{if(!createdAt)return false;const date=formatVenueDate(new Date(createdAt));return date>=periodFrom&&date<=periodTo;}; const periodSum=(filter)=>entries.filter((entry)=>inPeriod(entry.createdAt)&&filter(entry)).reduce((total,entry)=>total+Number(entry.amount||0),0);
    const venueReservations=reservations.filter((reservation)=>reservation.venueId===currentVenueId); const bookingReceipts=venueReservations.flatMap((reservation)=>reservation.prepaymentReceipts||[]); const prepaymentSummary=summarizeMemoryReservationPrepayments(venueReservations,currentVenueId); const unappliedPrepayment=prepaymentSummary.unapplied; const memoryPeriodBusiness=buildMemoryPeriodBusiness({venueId:currentVenueId,timeZone:reconciliationTimezone,from:periodFrom,to:periodTo,orders,guests:venueGuests,reservations:venueReservations}); const periodPrepaymentAllocations=venueReservations.flatMap((reservation)=>reservation.prepaymentAllocations||[]); const appliedPrepayment=periodPrepaymentAllocations.filter((entry)=>inPeriod(entry.createdAt)).reduce((total,entry)=>total+Number(entry.amount||0),0); const legacyBookings=venueReservations.filter((reservation)=>Number(reservation.depositPaid||0)>0);
    const legacyReservations=canReviewLegacyReservations?legacyBookings.map((item)=>{const reviewHistory=ensureMemoryLegacyReviewBaseline(item,currentVenueId);const latest=reviewHistory.at(-1);return{id:item.id,startsAt:item.startsAt||`${item.date||''}T${item.time||'00:00'}`,status:item.status,guestName:item.guestName||'',depositRequired:Number(item.depositRequired??item.deposit??0),legacyAmount:Number(item.depositPaid||0),verifiedAmount:Number(item.verifiedDepositPaid||0),receiptCount:(item.prepaymentReceipts||[]).length,receiptTotal:(item.prepaymentReceipts||[]).reduce((total,receipt)=>total+Math.max(0,Number(receipt.amount||0)-(item.prepaymentRefunds||[]).filter((refund)=>refund.receiptId===receipt.id).reduce((sum,refund)=>sum+Number(refund.amount||0),0)),0),reviewId:latest?.id||null,reviewDisposition:latest?.disposition||'unreviewed',reviewNote:latest?.note||'Исходная сумма прежней системы; получение денег не подтверждено.',evidenceReference:latest?.evidenceReference||'',reviewHistory,reviewStatus:(item.prepaymentReceipts||[]).length?'legacy_and_verified_receipts':'legacy_unverified'};}):[];
    return json(res,200,{venueId:selectedVenueId,generatedAt:new Date().toISOString(),guestCount:venueGuests.length,period:{from:periodFrom,to:periodTo,timeZone:reconciliationTimezone},balances:{bonus:{...summarize('bonus'),outstandingClawback:null},deposit:summarize('deposit'),reservationPrepayment:{unapplied:unappliedPrepayment,verifiedCounterMismatchCount:prepaymentSummary.verifiedCounterMismatchCount,verifiedCounterMismatchAmount:prepaymentSummary.verifiedCounterMismatchAmount,legacyUnverified:legacyBookings.reduce((total,item)=>total+Number(item.depositPaid||0),0),legacyReservationCount:legacyBookings.length,legacyReviewReturnedCount:canReviewLegacyReservations?legacyReservations.length:0,legacyReviewTruncated:false}},legacyReviewAccessRequired:!canReviewLegacyReservations,legacyReservations,coverage:{source:'memory',complete:false,unavailable:[...memoryPeriodBusiness.coverage.unavailable,'bonus clawback balance and period movements','external account refunds','reservation prepayment reopening and refund period movements']},bonus:{issued:sum((entry)=>entry.accountType==='bonus'&&entry.sourceKey?.includes(':bonus-earned:')&&entry.amount>0),redeemed:-sum((entry)=>entry.accountType==='bonus'&&entry.sourceType==='order'&&entry.amount<0),returned:sum((entry)=>entry.accountType==='bonus'&&entry.sourceType==='reversal'&&entry.amount>0),outstandingClawback:null},deposit:{toppedUp:sum((entry)=>entry.accountType==='deposit'&&entry.sourceType==='deposit_top_up'&&entry.amount>0),redeemed:-sum((entry)=>entry.accountType==='deposit'&&entry.sourceType==='order'&&entry.amount<0),returned:sum((entry)=>entry.accountType==='deposit'&&entry.sourceType==='reversal'&&entry.amount>0),externalRefund:null},periodMovements:{bonus:{issued:periodSum((entry)=>entry.accountType==='bonus'&&entry.sourceKey?.includes(':bonus-earned:')&&entry.amount>0),redeemed:-periodSum((entry)=>entry.accountType==='bonus'&&entry.sourceType==='order'&&entry.amount<0),reversed:periodSum((entry)=>entry.accountType==='bonus'&&entry.sourceType==='reversal'&&entry.amount>0),clawbackAdded:null,clawbackReleased:null},deposit:{toppedUp:periodSum((entry)=>entry.accountType==='deposit'&&entry.sourceType==='deposit_top_up'&&entry.amount>0),redeemed:-periodSum((entry)=>entry.accountType==='deposit'&&entry.sourceType==='order'&&entry.amount<0),reversed:periodSum((entry)=>entry.accountType==='deposit'&&entry.sourceType==='reversal'&&entry.amount>0),externalRefund:null},reservationPrepayment:{collected:bookingReceipts.filter((receipt)=>inPeriod(receipt.createdAt)).reduce((total,receipt)=>total+Number(receipt.amount||0),0),applied:appliedPrepayment,reopened:null,refunded:null}},periodBusiness:memoryPeriodBusiness});
  }
  const legacyReviewPath=pathname.match(/^\/api\/reservations\/([^/]+)\/legacy-deposit-reviews$/);
  if(legacyReviewPath&&req.method==='POST'){
    if(process.env.AUTH_REQUIRED==='true'&&(!['owner','admin'].includes(String(req.user?.role||'').toLowerCase())||!hasPermission(req,'finance')))return json(res,403,{error:'legacy_deposit_review_forbidden',permission:'finance'});
    const input=await body(req);const disposition=String(input.disposition||'');const note=String(input.note||'').trim();const evidenceReference=String(input.evidenceReference||'').trim();const idempotencyKey=String(input.idempotencyKey||'').trim();const expectedReviewId=input.expectedReviewId?String(input.expectedReviewId):null;
    if(!['documents_found','documents_not_found','disputed'].includes(disposition)||note.length<8||note.length>500||evidenceReference.length>250||(disposition==='documents_found'&&!evidenceReference)||idempotencyKey.length<8||idempotencyKey.length>120)return json(res,400,{error:'invalid_legacy_deposit_review'});
    if(repositories?.pool){let client;try{client=await repositories.pool.connect();await client.query('BEGIN');const reservationResult=await client.query('SELECT id,deposit_paid AS "legacyAmount" FROM reservations WHERE id=$1 AND venue_id=$2 FOR UPDATE',[legacyReviewPath[1],venueDbId]);const reservation=reservationResult.rows[0];if(!reservation||Number(reservation.legacyAmount)<=0){await client.query('ROLLBACK');return json(res,404,{error:'legacy_deposit_not_found'});}const priorResult=await client.query('SELECT id,reservation_id AS "reservationId",legacy_amount_snapshot AS "legacyAmount",sequence,disposition,review_note AS note,evidence_reference AS "evidenceReference",created_at AS "createdAt" FROM reservation_legacy_deposit_reviews WHERE venue_id=$1 AND idempotency_key=$2',[venueDbId,idempotencyKey]);const prior=priorResult.rows[0];if(prior){const matches=prior.reservationId===legacyReviewPath[1]&&Number(prior.legacyAmount)===Number(reservation.legacyAmount)&&prior.disposition===disposition&&prior.note===note&&prior.evidenceReference===evidenceReference;if(!matches){await client.query('ROLLBACK');return json(res,409,{error:'idempotency_key_reused'});}await client.query('COMMIT');return json(res,200,{...prior,legacyAmount:Number(prior.legacyAmount),idempotentReplay:true});}const headResult=await client.query('SELECT id,sequence,legacy_amount_snapshot AS "legacyAmount",disposition FROM reservation_legacy_deposit_reviews WHERE venue_id=$1 AND reservation_id=$2 ORDER BY sequence DESC LIMIT 1',[venueDbId,legacyReviewPath[1]]);const head=headResult.rows[0]||null;if((head?.id||null)!==expectedReviewId){await client.query('ROLLBACK');return json(res,409,{error:'legacy_deposit_review_stale'});}if(head&&Number(head.legacyAmount)!==Number(reservation.legacyAmount)){await client.query('ROLLBACK');return json(res,409,{error:'legacy_deposit_amount_changed'});}const sequence=Number(head?.sequence||0)+1;const actorId=/^[0-9a-f-]{36}$/i.test(req.user?.id||'')?req.user.id:null;const inserted=await client.query('INSERT INTO reservation_legacy_deposit_reviews (venue_id,reservation_id,legacy_amount_snapshot,sequence,disposition,review_note,evidence_reference,supersedes_id,idempotency_key,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,reservation_id AS "reservationId",legacy_amount_snapshot AS "legacyAmount",sequence,disposition,review_note AS note,evidence_reference AS "evidenceReference",actor_id AS "actorId",created_at AS "createdAt"',[venueDbId,legacyReviewPath[1],reservation.legacyAmount,sequence,disposition,note,evidenceReference,head?.id||null,idempotencyKey,actorId]);const review=inserted.rows[0];await client.query('INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6,$7)',[venueDbId,actorId,'reservation.legacy_deposit_review_recorded','reservation_legacy_deposit_review',review.id,head?{id:head.id,disposition:head.disposition}:null,{...review,legacyAmount:Number(review.legacyAmount),financialEffect:0}]);await client.query('COMMIT');return json(res,201,{...review,legacyAmount:Number(review.legacyAmount)});}catch(error){await client?.query('ROLLBACK').catch(()=>{});return json(res,409,{error:'legacy_deposit_review_save_failed'});}finally{client?.release();}}
    const reservation=reservations.find((item)=>item.id===legacyReviewPath[1]&&item.venueId===currentVenueId&&Number(item.depositPaid||0)>0);if(!reservation)return json(res,404,{error:'legacy_deposit_not_found'});const history=ensureMemoryLegacyReviewBaseline(reservation,currentVenueId);const prior=legacyReservationDepositReviews.find((item)=>item.venueId===currentVenueId&&item.idempotencyKey===idempotencyKey);if(prior){if(prior.reservationId!==reservation.id||Number(prior.legacyAmount)!==Number(reservation.depositPaid)||prior.disposition!==disposition||prior.note!==note||prior.evidenceReference!==evidenceReference)return json(res,409,{error:'idempotency_key_reused'});return json(res,200,{...prior,idempotentReplay:true});}const head=history.at(-1)||null;if((head?.id||null)!==expectedReviewId)return json(res,409,{error:'legacy_deposit_review_stale'});const review={id:`legacy-review-${crypto.randomUUID()}`,venueId:currentVenueId,reservationId:reservation.id,legacyAmount:Number(reservation.depositPaid),sequence:Number(head?.sequence||0)+1,disposition,note,evidenceReference,supersedesId:head?.id||null,idempotencyKey,actorId:req.user?.id||null,actorName:req.user?.name||'Система',createdAt:new Date().toISOString()};legacyReservationDepositReviews.push(review);recordAudit(req,'reservation.legacy_deposit_review_recorded','reservation_legacy_deposit_review',review.id,head,{...review,financialEffect:0});return json(res,201,review);
  }
  if (pathname === '/api/loyalty/settings' && req.method === 'PATCH') {
    if (process.env.AUTH_REQUIRED === 'true' && !['owner', 'admin'].includes(req.user?.role)) return json(res, 403, { error: 'loyalty_settings_owner_admin_required' });
    const input = await body(req);
    const selectedVenueId = repositories?.pool ? venueDbId : currentVenueId;
    if (!selectedVenueId) return json(res, 409, { error: 'venue_context_required' });
    if (!input.expectedVenueId) return json(res, 428, { error: 'venue_precondition_required' });
    if (String(input.expectedVenueId) !== String(selectedVenueId)) return json(res, 409, { error: 'venue_context_changed' });
    const allowedFields = new Set(['expectedVenueId', 'expectedVersion', 'bonusRublesPerPoint', 'maxRedemptionPercent', 'minimumRedemptionPoints']);
    if (Object.keys(input).some((key) => !allowedFields.has(key))) return json(res, 400, { error: 'unknown_loyalty_setting' });
    const expectedVersion = Number(input.expectedVersion);
    const bonusRublesPerPoint = Number(input.bonusRublesPerPoint);
    const maxRedemptionPercent = Number(input.maxRedemptionPercent);
    const minimumRedemptionPoints = Number(input.minimumRedemptionPoints);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || bonusRublesPerPoint !== 1 || !Number.isFinite(maxRedemptionPercent) || maxRedemptionPercent < 0 || maxRedemptionPercent > 100 || !Number.isInteger(minimumRedemptionPoints) || minimumRedemptionPoints < 1 || minimumRedemptionPoints > 1000000) return json(res, 400, { error: 'invalid_loyalty_settings' });
    const after = { venueId: selectedVenueId, version: expectedVersion + 1, bonusRublesPerPoint, maxRedemptionPercent, minimumRedemptionPoints, bonusExpirationDays: null, source: 'stored' };
    if (repositories?.pool) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const venue = await client.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [selectedVenueId]);
        if (!venue.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'venue_context_changed' }); }
        const current = await client.query('SELECT id,version,bonus_ruble_rate AS "bonusRublesPerPoint",max_redemption_percent AS "maxRedemptionPercent",min_redemption_points AS "minimumRedemptionPoints",bonus_expiration_days AS "bonusExpirationDays" FROM loyalty_program_settings WHERE venue_id=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE', [selectedVenueId]);
        const currentVersion = Number(current.rows[0]?.version || 0);
        if (currentVersion !== expectedVersion) { await client.query('ROLLBACK'); return json(res, 409, { error: 'loyalty_settings_version_conflict', currentVersion }); }
        const before = current.rows[0] ? { venueId: selectedVenueId, version: currentVersion, bonusRublesPerPoint: Number(current.rows[0].bonusRublesPerPoint), maxRedemptionPercent: Number(current.rows[0].maxRedemptionPercent), minimumRedemptionPoints: Number(current.rows[0].minimumRedemptionPoints), bonusExpirationDays: current.rows[0].bonusExpirationDays === null ? null : Number(current.rows[0].bonusExpirationDays), source: 'stored' } : { venueId: selectedVenueId, version: 0, bonusRublesPerPoint: 1, maxRedemptionPercent: 100, minimumRedemptionPoints: 1, bonusExpirationDays: null, source: 'legacy_default' };
        const inserted = await client.query('INSERT INTO loyalty_program_settings (venue_id,version,bonus_ruble_rate,max_redemption_percent,min_redemption_points,bonus_expiration_days,created_by) VALUES ($1,$2,$3,$4,$5,NULL,$6) RETURNING id,effective_at AS "effectiveAt"', [selectedVenueId, after.version, bonusRublesPerPoint, maxRedemptionPercent, minimumRedemptionPoints, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]);
        await repositories.audit.record({ venueId: selectedVenueId, actorId: /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null, action: 'loyalty.settings_version_created', entityType: 'loyalty_settings', entityId: inserted.rows[0].id, beforeData: before, afterData: { ...after, effectiveAt: inserted.rows[0].effectiveAt } }, client);
        await client.query('COMMIT');
        return json(res, 201, { ...after, effectiveAt: inserted.rows[0].effectiveAt });
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 503, { error: 'loyalty_settings_save_failed', detail: error.message }); }
      finally { client.release(); }
    }
    const current = loyaltyProgramSettings.get(String(selectedVenueId)) || { venueId: selectedVenueId, version: 0, bonusRublesPerPoint: 1, maxRedemptionPercent: 100, minimumRedemptionPoints: 1, bonusExpirationDays: null, source: 'legacy_default', effectiveAt: null };
    if (Number(current.version) !== expectedVersion) return json(res, 409, { error: 'loyalty_settings_version_conflict', currentVersion: Number(current.version) });
    const saved = { ...after, effectiveAt: new Date().toISOString() }; loyaltyProgramSettings.set(String(selectedVenueId), saved); recordAudit(req, 'loyalty.settings_version_created', 'loyalty_settings', null, current, saved); return json(res, 201, saved);
  }
  if (pathname === '/api/discount-groups' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'staff') && !hasPermission(req, 'staff_view') && !hasPermission(req, 'staff_manage') && !hasPermission(req, 'finance') && !hasPermission(req, 'orders') && !hasPermission(req, 'loyalty')) return json(res, 403, { error: 'forbidden', permission: 'loyalty' });
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    if (includeArchived && process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'staff_manage') && !hasPermission(req, 'finance') && !hasPermission(req, 'loyalty')) return json(res, 403, { error: 'forbidden', permission: 'loyalty' });
    if (repositories?.pool) {
      try {
        const { rows } = await repositories.pool.query(`SELECT id,name,discount_percent AS "discountPercent",bonus_percent AS "bonusPercent",deposit_min AS "depositMin",active FROM guest_discount_groups WHERE venue_id=$1 AND ($2::boolean OR active=true) ORDER BY active DESC,lower(name),id`, [venueDbId, includeArchived]);
        return json(res, 200, { items: rows.map((row) => ({ ...row, discountPercent: Number(row.discountPercent), bonusPercent: Number(row.bonusPercent), depositMin: Number(row.depositMin) })) });
      } catch (error) { return json(res, 503, { error: 'discount_groups_unavailable', detail: error.message }); }
    }
    return json(res, 200, { items: discountGroups.filter((group) => group.venueId === currentVenueId && (includeArchived || group.active !== false)) });
  }
  if (pathname === '/api/discount-groups' && req.method === 'POST') {
    if (denyUnlessAny(req, res, ['staff_manage', 'finance', 'loyalty'])) return;
    const input = await body(req); const name = String(input.name || '').trim(); const discountPercent = Number(input.discountPercent ?? 0); const bonusPercent = Number(input.bonusPercent ?? 0); const depositMin = Number(input.depositMin ?? 0);
    if (!name || name.length > 80 || ![discountPercent, bonusPercent, depositMin].every(Number.isFinite) || discountPercent < 0 || discountPercent > 100 || bonusPercent < 0 || bonusPercent > 100 || depositMin < 0 || depositMin > 9999999999.99 || Math.abs(depositMin * 100 - Math.round(depositMin * 100)) > 1e-6) return json(res, 400, { error: 'invalid_discount_group' });
    if (repositories?.pool) {
      try { const { rows } = await repositories.pool.query(`INSERT INTO guest_discount_groups (venue_id,name,discount_percent,bonus_percent,deposit_min) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,discount_percent AS "discountPercent",bonus_percent AS "bonusPercent",deposit_min AS "depositMin",active`, [venueDbId, name, discountPercent, bonusPercent, depositMin]); const group = { ...rows[0], discountPercent: Number(rows[0].discountPercent), bonusPercent: Number(rows[0].bonusPercent), depositMin: Number(rows[0].depositMin) }; recordAudit(req, 'discount_group.created', 'discount_group', group.id, null, group); return json(res, 201, group); }
      catch (error) { return json(res, error.code === '23505' ? 409 : 503, { error: error.code === '23505' ? 'discount_group_name_exists' : 'discount_group_save_failed', detail: error.message }); }
    }
    if (discountGroups.some((group) => group.venueId === currentVenueId && group.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) return json(res, 409, { error: 'discount_group_name_exists' });
    const group = { id: `discount-group-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, venueId: currentVenueId, name, discountPercent, bonusPercent, depositMin, active: true };
    discountGroups.push(group); recordAudit(req, 'discount_group.created', 'discount_group', group.id, null, group); return json(res, 201, group);
  }
  const discountGroupProfile = pathname.match(/^\/api\/discount-groups\/([^/]+)$/);
  if (discountGroupProfile && req.method === 'PATCH') {
    if (denyUnlessAny(req, res, ['staff_manage', 'finance', 'loyalty'])) return;
    const input = await body(req);
    const name = input.name === undefined ? undefined : String(input.name || '').trim();
    const discountPercent = input.discountPercent === undefined ? undefined : Number(input.discountPercent);
    const bonusPercent = input.bonusPercent === undefined ? undefined : Number(input.bonusPercent);
    const depositMin = input.depositMin === undefined ? undefined : Number(input.depositMin);
    const active = input.active === undefined ? undefined : input.active;
    if (active !== undefined && typeof active !== 'boolean') return json(res, 400, { error: 'invalid_discount_group' });
    if (name !== undefined && (!name || name.length > 80) || [discountPercent, bonusPercent, depositMin].some((value) => value !== undefined && !Number.isFinite(value)) || discountPercent !== undefined && (discountPercent < 0 || discountPercent > 100) || bonusPercent !== undefined && (bonusPercent < 0 || bonusPercent > 100) || depositMin !== undefined && (depositMin < 0 || depositMin > 9999999999.99 || Math.abs(depositMin * 100 - Math.round(depositMin * 100)) > 1e-6)) return json(res, 400, { error: 'invalid_discount_group' });
    if (repositories?.pool) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(discountGroupProfile[1])) return json(res, 404, { error: 'discount_group_not_found' });
      const fields = []; const values = [discountGroupProfile[1], venueDbId];
      if (name !== undefined) { values.push(name); fields.push(`name=$${values.length}`); }
      if (discountPercent !== undefined) { values.push(discountPercent); fields.push(`discount_percent=$${values.length}`); }
      if (bonusPercent !== undefined) { values.push(bonusPercent); fields.push(`bonus_percent=$${values.length}`); }
      if (depositMin !== undefined) { values.push(depositMin); fields.push(`deposit_min=$${values.length}`); }
      if (active !== undefined) { values.push(active); fields.push(`active=$${values.length}`); }
      if (!fields.length) return json(res, 400, { error: 'invalid_discount_group' });
      fields.push('updated_at=now()');
      try { const { rows } = await repositories.pool.query(`UPDATE guest_discount_groups SET ${fields.join(',')} WHERE id=$1 AND venue_id=$2 RETURNING id,name,discount_percent AS "discountPercent",bonus_percent AS "bonusPercent",deposit_min AS "depositMin",active`, values); if (!rows[0]) return json(res, 404, { error: 'discount_group_not_found' }); const group = { ...rows[0], discountPercent: Number(rows[0].discountPercent), bonusPercent: Number(rows[0].bonusPercent), depositMin: Number(rows[0].depositMin) }; recordAudit(req, active === undefined ? 'discount_group.updated' : active ? 'discount_group.restored' : 'discount_group.archived', 'discount_group', group.id, null, group); return json(res, 200, group); }
      catch (error) { return json(res, error.code === '23505' ? 409 : 503, { error: error.code === '23505' ? 'discount_group_name_exists' : 'discount_group_save_failed', detail: error.message }); }
    }
    const group = discountGroups.find((entry) => entry.id === discountGroupProfile[1] && entry.venueId === currentVenueId); if (!group) return json(res, 404, { error: 'discount_group_not_found' });
    if (name !== undefined && discountGroups.some((entry) => entry.venueId === currentVenueId && entry.id !== group.id && entry.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) return json(res, 409, { error: 'discount_group_name_exists' });
    const before = { ...group };
    if (name !== undefined) group.name = name; if (discountPercent !== undefined) group.discountPercent = discountPercent; if (bonusPercent !== undefined) group.bonusPercent = bonusPercent; if (depositMin !== undefined) group.depositMin = depositMin; if (active !== undefined) group.active = active;
    recordAudit(req, active === undefined ? 'discount_group.updated' : active ? 'discount_group.restored' : 'discount_group.archived', 'discount_group', group.id, before, group); return json(res, 200, group);
  }
  if (pathname === '/api/clients' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'staff') && !hasPermission(req, 'staff_view') && !hasPermission(req, 'orders')) return json(res, 403, { error: 'forbidden', permission: 'clients' });
    const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const requestedGuestDays = Number(url.searchParams.get('days') || 30);
    const guestDays = Number.isFinite(requestedGuestDays) ? Math.min(365, Math.max(1, Math.round(requestedGuestDays))) : 30;
    const guestPeriodFrom = new Date(Date.now() - guestDays * 86400000).toISOString();
    const canReadGuestBalances = process.env.AUTH_REQUIRED !== 'true' || hasPermission(req, 'finance') || hasPermission(req, 'loyalty') || hasPermission(req, 'staff_manage');
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query(`SELECT g.id,g.full_name AS name,g.nickname,g.phone,g.email,g.avatar_url AS "avatarUrl",g.guest_status AS "guestStatus",g.archived_at AS "archivedAt",g.phone_numbers AS "phoneNumbers",g.telegram,g.tobacco_preferences AS "tobaccoPreferences",g.bowl_preferences AS "bowlPreferences",g.bar_preferences AS "barPreferences",g.allergies,g.loyalty_points AS "loyaltyPoints",g.discount_group_id AS "discountGroupId",g.deposit_balance AS "depositBalance",dg.name AS "discountGroupName",dg.discount_percent AS "discountPercent",g.notes,COUNT(DISTINCT o.id)::int AS visits,COALESCE(SUM(p.amount),0)::numeric AS "totalSpent",MAX(o.closed_at) AS "lastVisitAt" FROM guests g LEFT JOIN guest_discount_groups dg ON dg.id=g.discount_group_id AND dg.venue_id=g.venue_id LEFT JOIN orders o ON o.guest_id=g.id AND o.status='closed' AND o.closed_at >= $3::timestamptz LEFT JOIN payments p ON p.order_id=o.id AND p.status IN ('paid','partially_paid') WHERE g.venue_id=$1 AND g.archived_at IS NULL AND ($2='' OR LOWER(CONCAT_WS(' ',g.full_name,g.nickname,g.phone,g.telegram,g.phone_numbers::text,ARRAY_TO_STRING(COALESCE(g.tobacco_preferences,'{}'),' '),ARRAY_TO_STRING(COALESCE(g.bowl_preferences,'{}'),' '),ARRAY_TO_STRING(COALESCE(g.bar_preferences,'{}'),' '),g.allergies,g.notes)) LIKE '%'||LOWER($2)||'%') GROUP BY g.id,dg.name,dg.discount_percent ORDER BY COALESCE(MAX(o.closed_at),g.created_at) DESC`, [venueDbId, query, guestPeriodFrom]); return json(res, 200, { items: rows.map((row) => ({ ...row, phoneNumbers: row.phoneNumbers || (row.phone ? [{ label: 'Основной', number: row.phone, primary: true }] : []), tobaccoPreferences: row.tobaccoPreferences || [], bowlPreferences: row.bowlPreferences || [], barPreferences: row.barPreferences || [], loyaltyPoints: canReadGuestBalances ? Number(row.loyaltyPoints || 0) : undefined, bonusBalance: canReadGuestBalances ? Number(row.loyaltyPoints || 0) : undefined, depositBalance: canReadGuestBalances ? Number(row.depositBalance || 0) : undefined, discountPercent: Number(row.discountPercent || 0), visits: Number(row.visits || 0), totalSpent: Number(row.totalSpent || 0) })), periodDays: guestDays, periodFrom: guestPeriodFrom }); } catch (error) { return json(res, 503, { error: 'clients_unavailable', detail: error.message }); } }
    const venueItems = clients.filter((client) => client.venueId === requestVenueId && (!query || `${client.name} ${client.nickname || ''} ${client.telegram} ${(client.phoneNumbers || []).map((phone) => phone.number).join(' ')} ${(client.tobaccoPreferences || []).join(' ')} ${(client.barPreferences || []).join(' ')}`.toLowerCase().includes(query)));
    const items = canReadGuestBalances ? venueItems : venueItems.map(({ loyaltyPoints, bonusBalance, depositBalance, ...client }) => client);
    return json(res, 200, { items, periodDays: guestDays, periodFrom: guestPeriodFrom });
  }
  const clientArchive = pathname.match(/^\/api\/clients\/([^/]+)\/archive$/);
  if (clientArchive && req.method === 'POST') { if (denyUnlessAny(req, res, ['staff_manage', 'orders'])) return; const id = clientArchive[1]; const memory = clients.find((entry) => entry.id === id && entry.venueId === requestVenueId); if (memory) { memory.archivedAt = new Date().toISOString(); recordAudit(req, 'client.archived', 'client', id, { archivedAt: null }, { archivedAt: memory.archivedAt }); return json(res, 200, memory); } if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(id)) { try { const { rows } = await repositories.pool.query('UPDATE guests SET archived_at=now() WHERE id=$1 AND venue_id=$2 AND archived_at IS NULL RETURNING id,full_name AS name,archived_at AS "archivedAt"', [id, venueDbId]); if (!rows[0]) return json(res, 404, { error: 'client_not_found' }); recordAudit(req, 'client.archived', 'client', id, { archivedAt: null }, rows[0]); return json(res, 200, rows[0]); } catch (error) { return json(res, 409, { error: 'client_archive_failed', detail: error.message }); } } return json(res, 404, { error: 'client_not_found' }); }
  const clientDelete = pathname.match(/^\/api\/clients\/([^/]+)$/);
  if (clientDelete && req.method === 'DELETE') { if (denyUnless(req, res, 'staff_manage')) return; if (req.user?.role !== 'owner') return json(res, 403, { error: 'client_delete_owner_required' }); const id = clientDelete[1]; const index = clients.findIndex((entry) => entry.id === id && entry.venueId === requestVenueId); if (index >= 0) { const [removed] = clients.splice(index, 1); recordAudit(req, 'client.deleted', 'client', id, { recordDeleted: true }, null); return json(res, 200, { id, deleted: true }); } if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(id)) { try { const { rows } = await repositories.pool.query('DELETE FROM guests WHERE id=$1 AND venue_id=$2 RETURNING id', [id, venueDbId]); if (!rows[0]) return json(res, 404, { error: 'client_not_found' }); recordAudit(req, 'client.deleted', 'client', id, { id }, null); return json(res, 200, { id, deleted: true }); } catch (error) { return json(res, 409, { error: 'client_delete_failed', detail: error.message }); } } return json(res, 404, { error: 'client_not_found' }); }
  if (pathname === '/api/clients' && req.method === 'POST') {
    if (denyUnlessAny(req, res, ['staff_manage', 'orders'])) return;
    const input = await body(req);
    const protectedGuestFields = ['discountGroupId', 'bonusBalance', 'loyaltyPoints', 'depositBalance'];
    if (process.env.AUTH_REQUIRED === 'true' && protectedGuestFields.some((field) => Object.hasOwn(input, field)
      && !hasPermission(req, 'finance') && !hasPermission(req, 'staff_manage') && !hasPermission(req, 'loyalty'))) {
      return json(res, 403, { error: 'forbidden', permission: 'loyalty' });
    }
    if (Number(input.bonusBalance ?? input.loyaltyPoints ?? 0) !== 0 || Number(input.depositBalance ?? 0) !== 0) {
      return json(res, 409, { error: 'guest_balances_require_ledger' });
    }
    const name = String(input.name || '').trim();
    if (!name || name.length > 120) return json(res, 400, { error: 'client_name_required' });
    if (input.phoneNumbers !== undefined && (!Array.isArray(input.phoneNumbers) || input.phoneNumbers.length > 5 || input.phoneNumbers.some((entry) => !entry || !/^\+7[0-9 ()-]{7,24}$/.test(String(entry.number || '').trim())))) return json(res, 400, { error: 'invalid_phone_numbers' });
    const phoneNumbers = normalizePhoneNumbers(input.phoneNumbers);
    if (phoneNumbers.length && phoneNumbers.filter((phone) => phone.primary).length !== 1) return json(res, 400, { error: 'one_primary_phone_required' });
    if (input.telegram && !/^(@[A-Za-z0-9_]{5,32}|https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$)/.test(String(input.telegram).trim())) return json(res, 400, { error: 'invalid_telegram' });
    const avatarUrl = input.avatarUrl === undefined ? null : String(input.avatarUrl || '');
    const guestStatus = String(input.guestStatus || 'new');
    if (!['new', 'regular', 'vip', 'blocked'].includes(guestStatus)) return json(res, 400, { error: 'invalid_guest_status' });
    if (avatarUrl && (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarUrl) || avatarUrl.length > 700000)) return json(res, 400, { error: 'invalid_avatar' });
    const discountGroupId = input.discountGroupId ? String(input.discountGroupId) : null;
    if (repositories?.pool && discountGroupId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(discountGroupId)) return json(res, 400, { error: 'discount_group_not_found' });
    const loyaltyPoints = Number(input.bonusBalance ?? input.loyaltyPoints ?? 0);
    const depositBalance = Number(input.depositBalance ?? 0);
    if (!Number.isInteger(loyaltyPoints) || loyaltyPoints < 0 || loyaltyPoints > 1000000000 || !Number.isFinite(depositBalance) || depositBalance < 0 || depositBalance > 1000000000) return json(res, 400, { error: 'invalid_guest_balance' });
    const client = { id: `client-${Date.now()}`, venueId: requestVenueId, name, nickname: String(input.nickname || '').trim().slice(0, 80), avatarUrl, guestStatus, phoneNumbers, telegram: String(input.telegram || '').trim(), tobaccoPreferences: Array.isArray(input.tobaccoPreferences) ? input.tobaccoPreferences.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) : [], bowlPreferences: Array.isArray(input.bowlPreferences) ? input.bowlPreferences.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20) : [], barPreferences: Array.isArray(input.barPreferences) ? input.barPreferences.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) : [], allergies: String(input.allergies || '').trim().slice(0, 500), notes: String(input.notes || '').trim().slice(0, 2000), loyaltyPoints, bonusBalance: loyaltyPoints, depositBalance, discountGroupId, visits: 0, totalSpent: 0, lastVisitAt: null };
    if (repositories?.pool) {
      try {
        if (discountGroupId) { const group = await repositories.pool.query('SELECT id FROM guest_discount_groups WHERE id=$1 AND venue_id=$2 AND active=true', [discountGroupId, venueDbId]); if (!group.rows[0]) return json(res, 400, { error: 'discount_group_not_found' }); }
        const primary = phoneNumbers.find((phone) => phone.primary)?.number || null;
        const { rows } = await repositories.pool.query(`INSERT INTO guests (venue_id,phone,full_name,avatar_url,guest_status,phone_numbers,telegram,tobacco_preferences,bowl_preferences,bar_preferences,allergies,notes,loyalty_points,discount_group_id,deposit_balance,nickname) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,full_name AS name,nickname,phone,avatar_url AS "avatarUrl",guest_status AS "guestStatus",phone_numbers AS "phoneNumbers",telegram,tobacco_preferences AS "tobaccoPreferences",bowl_preferences AS "bowlPreferences",bar_preferences AS "barPreferences",allergies,notes,loyalty_points AS "loyaltyPoints",discount_group_id AS "discountGroupId",deposit_balance AS "depositBalance"`, [venueDbId, primary, name, client.avatarUrl || null, client.guestStatus, JSON.stringify(phoneNumbers), client.telegram || null, client.tobaccoPreferences, client.bowlPreferences, client.barPreferences, client.allergies || null, client.notes || null, loyaltyPoints, discountGroupId, depositBalance, client.nickname]);
        if (rows[0]) { const persistedClient = { ...client, ...rows[0], bonusBalance: Number(rows[0].loyaltyPoints || 0), depositBalance: Number(rows[0].depositBalance || 0) }; await recordAudit(req, 'client.created', 'client', persistedClient.id, null, { profileCreated: true }); return json(res, 201, persistedClient); }
      } catch (error) { return json(res, 503, { error: 'client_create_failed', detail: error.message }); }
    }
    if (discountGroupId && !discountGroups.some((group) => group.id === discountGroupId && group.venueId === requestVenueId && group.active !== false)) return json(res, 400, { error: 'discount_group_not_found' });
    clients.push(client); recordAudit(req, 'client.created', 'client', client.id, null, { profileCreated: true }); return json(res, 201, client);
  }
  const clientProfile = pathname.match(/^\/api\/clients\/([^/]+)$/);
  if (clientProfile && req.method === 'PATCH') {
    if (denyUnlessAny(req, res, ['staff_manage', 'orders'])) return;
    let client = clients.find((entry) => entry.id === clientProfile[1] && entry.venueId === requestVenueId);
    if (!client && repositories?.pool && /^[0-9a-f-]{36}$/i.test(clientProfile[1])) {
      try {
        const { rows } = await repositories.pool.query(`SELECT id,full_name AS name,nickname,phone,avatar_url AS "avatarUrl",guest_status AS "guestStatus",phone_numbers AS "phoneNumbers",telegram,tobacco_preferences AS "tobaccoPreferences",bowl_preferences AS "bowlPreferences",bar_preferences AS "barPreferences",allergies,notes,loyalty_points AS "loyaltyPoints",discount_group_id AS "discountGroupId",deposit_balance AS "depositBalance" FROM guests WHERE id=$1 AND venue_id=$2`, [clientProfile[1], venueDbId]);
        if (rows[0]) client = { ...rows[0], phoneNumbers: rows[0].phoneNumbers || (rows[0].phone ? [{ label: 'Основной', number: rows[0].phone, primary: true }] : []), tobaccoPreferences: rows[0].tobaccoPreferences || [], bowlPreferences: rows[0].bowlPreferences || [], barPreferences: rows[0].barPreferences || [], loyaltyPoints: Number(rows[0].loyaltyPoints || 0), bonusBalance: Number(rows[0].loyaltyPoints || 0), depositBalance: Number(rows[0].depositBalance || 0) };
      } catch (_) {}
    }
    if (!client) return json(res, 404, { error: 'client_not_found' });
    const canReadGuestBalances = process.env.AUTH_REQUIRED !== 'true' || hasPermission(req, 'finance') || hasPermission(req, 'loyalty') || hasPermission(req, 'staff_manage');
    const input = await body(req);
    const protectedGuestFields = ['discountGroupId', 'bonusBalance', 'loyaltyPoints', 'depositBalance'];
    if (process.env.AUTH_REQUIRED === 'true' && protectedGuestFields.some((field) => Object.hasOwn(input, field)
      && !hasPermission(req, 'finance') && !hasPermission(req, 'staff_manage') && !hasPermission(req, 'loyalty'))) {
      return json(res, 403, { error: 'forbidden', permission: 'loyalty' });
    }
    const before = JSON.parse(JSON.stringify(client));
    if ((input.bonusBalance !== undefined || input.loyaltyPoints !== undefined || input.depositBalance !== undefined)
      && (Number(input.bonusBalance ?? input.loyaltyPoints ?? client.loyaltyPoints ?? 0) !== Number(client.loyaltyPoints ?? 0)
        || Number(input.depositBalance ?? client.depositBalance ?? 0) !== Number(client.depositBalance ?? 0))) {
      return json(res, 409, { error: 'guest_balances_require_ledger' });
    }
    if (input.nickname !== undefined) client.nickname = String(input.nickname || '').trim().slice(0, 80);
    if (input.name !== undefined) { const name = String(input.name || '').trim(); if (!name || name.length > 120) return json(res, 400, { error: 'client_name_required' }); client.name = name; }
    if (input.phoneNumbers !== undefined) { if (!Array.isArray(input.phoneNumbers) || input.phoneNumbers.length > 5 || input.phoneNumbers.some((entry) => !entry || !/^\+7[0-9 ()-]{7,24}$/.test(String(entry.number || '').trim()))) return json(res, 400, { error: 'invalid_phone_numbers' }); const phoneNumbers = normalizePhoneNumbers(input.phoneNumbers); if (phoneNumbers.length && phoneNumbers.filter((phone) => phone.primary).length !== 1) return json(res, 400, { error: 'one_primary_phone_required' }); client.phoneNumbers = phoneNumbers; }
    if (input.avatarUrl !== undefined) { const avatarUrl = String(input.avatarUrl || ''); if (avatarUrl && (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarUrl) || avatarUrl.length > 700000)) return json(res, 400, { error: 'invalid_avatar' }); client.avatarUrl = avatarUrl || null; }
    if (input.guestStatus !== undefined) { const guestStatus = String(input.guestStatus || 'new'); if (!['new', 'regular', 'vip', 'blocked'].includes(guestStatus)) return json(res, 400, { error: 'invalid_guest_status' }); client.guestStatus = guestStatus; }
    if (input.telegram !== undefined) { const telegram = String(input.telegram || '').trim(); if (telegram && !/^(@[A-Za-z0-9_]{5,32}|https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$)/.test(telegram)) return json(res, 400, { error: 'invalid_telegram' }); client.telegram = telegram; }
    for (const key of ['tobaccoPreferences', 'bowlPreferences', 'barPreferences']) if (input[key] !== undefined) client[key] = Array.isArray(input[key]) ? input[key].map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) : [];
    if (input.allergies !== undefined) client.allergies = String(input.allergies || '').trim().slice(0, 500);
    if (input.notes !== undefined) client.notes = String(input.notes || '').trim().slice(0, 2000);
    if (input.discountGroupId !== undefined) {
      const nextGroupId = input.discountGroupId ? String(input.discountGroupId) : null;
      if (nextGroupId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nextGroupId)) return json(res, 400, { error: 'discount_group_not_found' });
      if (nextGroupId && repositories?.pool) { try { const group = await repositories.pool.query('SELECT id FROM guest_discount_groups WHERE id=$1 AND venue_id=$2 AND active=true', [nextGroupId, venueDbId]); if (!group.rows[0]) return json(res, 400, { error: 'discount_group_not_found' }); } catch (error) { return json(res, 503, { error: 'discount_groups_unavailable', detail: error.message }); } }
      if (nextGroupId && !repositories?.pool && !discountGroups.some((group) => group.id === nextGroupId && group.venueId === requestVenueId && group.active !== false)) return json(res, 400, { error: 'discount_group_not_found' });
      client.discountGroupId = nextGroupId;
    }
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(client.id)) { try { const primary = client.phoneNumbers.find((phone) => phone.primary)?.number || null; const { rows } = await repositories.pool.query(`UPDATE guests SET phone=$1,full_name=$2,avatar_url=$3,guest_status=$4,phone_numbers=$5::jsonb,telegram=$6,tobacco_preferences=$7,bowl_preferences=$8,bar_preferences=$9,allergies=$10,notes=$11,discount_group_id=$12,nickname=$13 WHERE id=$14 AND venue_id=$15 RETURNING id,full_name AS name,nickname,phone,avatar_url AS "avatarUrl",guest_status AS "guestStatus",phone_numbers AS "phoneNumbers",telegram,tobacco_preferences AS "tobaccoPreferences",bowl_preferences AS "bowlPreferences",bar_preferences AS "barPreferences",allergies,notes,loyalty_points AS "loyaltyPoints",discount_group_id AS "discountGroupId",deposit_balance AS "depositBalance"`, [primary, client.name, client.avatarUrl || null, client.guestStatus, JSON.stringify(client.phoneNumbers), client.telegram || null, client.tobaccoPreferences, client.bowlPreferences, client.barPreferences, client.allergies || null, client.notes || null, client.discountGroupId || null, client.nickname || '', client.id, venueDbId]); if (rows[0]) { const persistedClient = { ...client, ...rows[0], bonusBalance: Number(rows[0].loyaltyPoints || 0), depositBalance: Number(rows[0].depositBalance || 0) }; await recordAudit(req, 'client.updated', 'client', persistedClient.id, null, { profileUpdated: true, changedFieldCount: Object.keys(input).length }); if (!canReadGuestBalances) { delete persistedClient.loyaltyPoints; delete persistedClient.bonusBalance; delete persistedClient.depositBalance; } return json(res, 200, persistedClient); } } catch (error) { Object.assign(client, before); return json(res, 503, { error: 'client_update_failed', detail: error.message }); } }
    recordAudit(req, 'client.updated', 'client', client.id, null, { profileUpdated: true, changedFieldCount: Object.keys(input).length }); if (!canReadGuestBalances) { const { loyaltyPoints, bonusBalance, depositBalance, ...profile } = client; return json(res, 200, profile); } return json(res, 200, client);
  }
  const clientHistory = pathname.match(/^\/api\/clients\/([^/]+)\/history$/);
  if (clientHistory && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'staff') && !hasPermission(req, 'staff_view') && !hasPermission(req, 'orders')) return json(res, 403, { error: 'forbidden', permission: 'clients' });
    const clientId = clientHistory[1];
    const reservationPaymentsVisible = process.env.AUTH_REQUIRED !== 'true' || hasPermission(req, 'reservations') || hasPermission(req, 'finance') || hasPermission(req, 'loyalty');
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(clientId)) {
      try {
        const guest = await repositories.pool.query('SELECT id FROM guests WHERE id=$1 AND venue_id=$2', [clientId, venueDbId]);
        if (!guest.rows[0]) return json(res, 404, { error: 'client_not_found' });
        const [orderRows, reservationRows] = await Promise.all([
          repositories.pool.query(`SELECT o.id,o.table_id AS "tableId",o.status,o.created_at AS "createdAt",o.closed_at AS "closedAt",o.vip_minimum AS "minimumOrderTotal",COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('paid','partially_paid')),0)::numeric AS total FROM orders o LEFT JOIN payments p ON p.order_id=o.id WHERE o.venue_id=$1 AND o.guest_id=$2 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 50`, [venueDbId, clientId]),
          repositories.pool.query(`SELECT r.id,r.table_id AS "tableId",r.starts_at AS "startsAt",to_char(r.starts_at AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg'),'YYYY-MM-DD') AS date,to_char(r.starts_at AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg'),'HH24:MI') AS time,r.status,r.deposit_paid AS deposit,r.deposit_paid AS "depositPaid",r.deposit_paid AS "legacyDepositPaid",r.deposit_required AS "depositRequired",r.verified_deposit_paid AS "verifiedDepositPaid",r.guests_count AS guests,r.notes,COALESCE(prepayments.receipts,'[]'::jsonb) AS "prepaymentReceipts" FROM reservations r JOIN venues v ON v.id=r.venue_id LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'refundedAmount',COALESCE(refunds.amount,0),'netAmount',GREATEST(0,p.amount-COALESCE(refunds.amount,0)),'method',p.payment_method,'reason',p.reason,'shiftId',p.shift_id,'createdAt',p.created_at,'actorName',u.full_name) ORDER BY p.created_at,p.id) AS receipts FROM reservation_pre_payment_receipts p LEFT JOIN users u ON u.id=p.actor_id LEFT JOIN LATERAL (SELECT SUM(rr.amount) AS amount FROM reservation_pre_payment_receipt_reversals rr WHERE rr.venue_id=p.venue_id AND rr.receipt_id=p.id) refunds ON true WHERE p.venue_id=r.venue_id AND p.reservation_id=r.id) prepayments ON true WHERE r.venue_id=$1 AND r.guest_id=$2 ORDER BY r.starts_at DESC LIMIT 50`, [venueDbId, clientId])
        ]);
        return json(res, 200, { orders: orderRows.rows.map((row) => ({ ...row, total: Number(row.total || 0), minimumOrderTotal: Number(row.minimumOrderTotal || 0) })), reservations: reservationRows.rows.map((row) => ({ id: row.id, tableId: row.tableId, startsAt: row.startsAt, date: row.date, time: row.time, status: row.status, guests: Number(row.guests || 0), ...(reservationPaymentsVisible ? { deposit: Number(row.deposit || 0), depositPaid: Number(row.depositPaid || 0), legacyDepositPaid: Number(row.legacyDepositPaid || 0), depositRequired: Number(row.depositRequired || 0), verifiedDepositPaid: Number(row.verifiedDepositPaid || 0), prepaymentReceipts: row.prepaymentReceipts || [], notes: row.notes || '' } : {}) })), reservationPaymentsVisible });
      } catch (error) { return json(res, 503, { error: 'client_history_unavailable', detail: error.message }); }
    }
    const client = clients.find((entry) => entry.id === clientId && entry.venueId === requestVenueId);
    if (!client) return json(res, 404, { error: 'client_not_found' });
    const historyOrders = orders.filter((order) => order.venueId === requestVenueId && (order.clientId === clientId || order.guestId === clientId)).map((order) => ({ id: order.id, tableId: order.tableId, status: order.status, createdAt: order.createdAt, closedAt: order.closedAt || null, total: order.finalTotal ?? (order.items || []).reduce((sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 0), 0), minimumOrderTotal: Number(order.minimumOrderTotal || 0) }));
    const historyReservations = reservations.filter((reservation) => reservation.venueId === requestVenueId && (reservation.clientId === clientId || reservation.guestId === clientId)).map((reservation) => ({ id: reservation.id, tableId: reservation.tableId, date: reservation.date, time: reservation.time, status: reservation.status, guests: reservation.guests, ...(reservationPaymentsVisible ? { deposit: Number(reservation.depositPaid ?? reservation.deposit ?? 0), depositPaid: Number(reservation.depositPaid ?? reservation.deposit ?? 0), legacyDepositPaid: Number(reservation.depositPaid ?? 0), depositRequired: Number(reservation.depositRequired ?? reservation.deposit ?? 0), verifiedDepositPaid: Number(reservation.verifiedDepositPaid || 0), prepaymentReceipts: (reservation.prepaymentReceipts || []).map((receipt) => { const refundedAmount=(reservation.prepaymentRefunds||[]).filter((refund)=>refund.receiptId===receipt.id).reduce((sum,refund)=>sum+Number(refund.amount||0),0); return { ...receipt, refundedAmount, netAmount: Math.max(0,Number(receipt.amount||0)-refundedAmount) }; }), notes: reservation.notes || '' } : {}) }));
    return json(res, 200, { orders: historyOrders.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 50), reservations: historyReservations.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`)).slice(0, 50), reservationPaymentsVisible });
  }
  const clientDepositTopUps = pathname.match(/^\/api\/clients\/([^/]+)\/deposit-top-ups$/);
  if (clientDepositTopUps && req.method === 'POST') {
    if (denyUnlessAny(req, res, ['orders', 'finance'])) return;
    const input = await body(req); const amount = Number(input.amount); const method = String(input.method || 'cash'); const reason = String(input.reason || '').trim(); const idempotencyKey = String(input.idempotencyKey || req.headers?.['idempotency-key'] || '').trim();
    if (!validPaymentAmount(amount) || amount > 10000000 || !['cash', 'card', 'qr'].includes(method)) return json(res, 400, { error: 'invalid_deposit_top_up' });
    if (!reason || reason.length > 500) return json(res, 400, { error: 'deposit_top_up_reason_required' });
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) return json(res, 400, { error: 'valid_idempotency_key_required' });
    if (repositories?.pool && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientDepositTopUps[1])) {
      let client;
      try {
        client = await repositories.pool.connect(); await client.query('BEGIN');
        const prior = await client.query('SELECT id,guest_id AS "guestId",shift_id AS "shiftId",amount,payment_method AS method,reason,created_at AS "createdAt" FROM guest_deposit_receipts WHERE venue_id=$1 AND idempotency_key=$2', [venueDbId, idempotencyKey]);
        if (prior.rows[0]) {
          const entry = prior.rows[0];
          if (entry.guestId !== clientDepositTopUps[1] || Number(entry.amount) !== amount || entry.method !== method || entry.reason !== reason) { await client.query('ROLLBACK'); return json(res, 409, { error: 'idempotency_key_reused' }); }
          const balance = await client.query('SELECT deposit_balance AS balance FROM guests WHERE id=$1 AND venue_id=$2', [entry.guestId, venueDbId]);
          if (!balance.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'client_not_found' }); }
          await client.query('COMMIT'); return json(res, 200, { ...entry, amount: Number(entry.amount), depositBalance: Number(balance.rows[0].balance), idempotentReplay: true });
        }
        const shift = await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE', [venueDbId]);
        if (!shift.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'open_shift_required' }); }
        const guest = await client.query('SELECT id,deposit_balance AS balance FROM guests WHERE id=$1 AND venue_id=$2 FOR UPDATE', [clientDepositTopUps[1], venueDbId]);
        if (!guest.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'client_not_found' }); }
        const actorId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.user?.id || '') ? req.user.id : null;
        const receipt = await client.query('INSERT INTO guest_deposit_receipts (venue_id,guest_id,shift_id,amount,payment_method,reason,idempotency_key,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,guest_id AS "guestId",shift_id AS "shiftId",amount,payment_method AS method,reason,created_at AS "createdAt"', [venueDbId, clientDepositTopUps[1], shift.rows[0].id, amount, method, reason, idempotencyKey, actorId]);
        const entry = receipt.rows[0];
        await client.query("INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_id,source_key,actor_id) VALUES ($1,$2,'deposit',$3,$4,'deposit_top_up',$5,$6,$7)", [venueDbId, clientDepositTopUps[1], amount, `Пополнение счёта: ${reason}`, entry.id, `deposit-top-up:${idempotencyKey}`, actorId]);
        const balance = await client.query('UPDATE guests SET deposit_balance=deposit_balance+$1 WHERE id=$2 AND venue_id=$3 RETURNING deposit_balance AS balance', [amount, clientDepositTopUps[1], venueDbId]);
        await client.query("INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,after_data) VALUES ($1,$2,'guest.deposit_topped_up','guest_deposit_receipt',$3,$4)", [venueDbId, actorId, entry.id, { guestId: entry.guestId, amount, method, reason, shiftId: entry.shiftId, idempotencyKey }]);
        await client.query('COMMIT'); return json(res, 201, { ...entry, amount: Number(entry.amount), depositBalance: Number(balance.rows[0].balance) });
      } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') return json(res, 409, { error: 'idempotency_key_reused' }); return json(res, 503, { error: 'deposit_top_up_failed', detail: error.message }); }
      finally { client?.release(); }
    }
    const guest = clients.find((entry) => entry.id === clientDepositTopUps[1] && entry.venueId === requestVenueId);
    if (!guest) return json(res, 404, { error: 'client_not_found' });
    const shift = shifts.find((entry) => entry.venueId === venueDbId && !entry.closedAt);
    if (!shift) return json(res, 409, { error: 'open_shift_required' });
    guest.depositTopUps ||= []; const prior = guest.depositTopUps.find((entry) => entry.idempotencyKey === idempotencyKey);
    if (prior) { if (Number(prior.amount) !== amount || prior.method !== method || prior.reason !== reason) return json(res, 409, { error: 'idempotency_key_reused' }); return json(res, 200, { ...prior, depositBalance: Number(guest.depositBalance || 0), idempotentReplay: true }); }
    guest.depositBalance = Number(guest.depositBalance || 0) + amount; guest.accountEntries ||= [];
    const entry = { id: `deposit-${crypto.randomUUID()}`, guestId: guest.id, shiftId: shift.id, amount, method, reason, idempotencyKey, depositBalance: guest.depositBalance, createdAt: new Date().toISOString() };
    entry.actorId = req.user?.id || null; guest.depositTopUps.unshift(entry); guest.accountEntries.unshift({ id: entry.id, accountType: 'deposit', amount, reason: `Пополнение счёта: ${reason}`, sourceType: 'deposit_top_up', sourceId: entry.id, sourceKey: `deposit-top-up:${idempotencyKey}`, method, shiftId: shift.id, createdAt: entry.createdAt, actorId: entry.actorId, actorName: req.user?.name || 'Сотрудник' });
    recordAudit(req, 'guest.deposit_topped_up', 'guest', guest.id, { depositBalance: guest.depositBalance - amount }, { depositBalance: guest.depositBalance, amount, method, shiftId: shift.id });
    return json(res, 201, entry);
  }
  const clientLoyalty = pathname.match(/^\/api\/clients\/([^/]+)\/loyalty$/);
  if (clientLoyalty && req.method === 'POST') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'finance') && !hasPermission(req, 'staff_manage') && !hasPermission(req, 'loyalty')) return json(res, 403, { error: 'forbidden', permission: 'loyalty' });
    const input = await body(req); const delta = Number(input.delta); const reason = String(input.reason || '').trim(); const idempotencyKey = String(input.idempotencyKey || req.headers?.['idempotency-key'] || '').trim();
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000 || !reason || reason.length > 500 || !/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) return json(res, 400, { error: 'invalid_loyalty_adjustment' });
    const sourceKey = `loyalty-adjustment:${idempotencyKey}`;
    if (repositories?.pool && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientLoyalty[1])) {
      let client;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT id,loyalty_points AS "loyaltyPoints" FROM guests WHERE id=$1 AND venue_id=$2 FOR UPDATE', [clientLoyalty[1], venueDbId]);
        if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'client_not_found' }); }
        const before = Number(rows[0].loyaltyPoints || 0);
        const existing = await client.query('SELECT amount,reason FROM guest_account_entries WHERE guest_id=$1 AND account_type=\'bonus\' AND source_key=$2', [clientLoyalty[1], sourceKey]);
        if (existing.rows[0]) {
          await client.query('ROLLBACK');
          if (Number(existing.rows[0].amount) !== delta || existing.rows[0].reason !== reason) return json(res, 409, { error: 'idempotency_key_reused' });
          return json(res, 200, { id: rows[0].id, loyaltyPoints: before, bonusBalance: before, delta, reason, duplicate: true });
        }
        const next = before + delta;
        if (next < 0) { await client.query('ROLLBACK'); return json(res, 409, { error: 'insufficient_bonus_balance', balance: before }); }
        if (next > 2147483647) { await client.query('ROLLBACK'); return json(res, 409, { error: 'loyalty_balance_limit' }); }
        await client.query('UPDATE guests SET loyalty_points=$1 WHERE id=$2 AND venue_id=$3', [next, clientLoyalty[1], venueDbId]);
        const actorId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.user?.id || '') ? req.user.id : null;
        const accountEntry = await client.query(`INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_key,actor_id)
          VALUES ($1,$2,'bonus',$3,$4,'manual_adjustment',$5,$6) RETURNING id`, [venueDbId, clientLoyalty[1], delta, reason, sourceKey, actorId]);
        await repositories.audit.record({ venueId: venueDbId, actorId, action: 'client.loyalty_adjusted', entityType: 'client', entityId: rows[0].id,
          beforeData: { loyaltyPoints: before }, afterData: { loyaltyPoints: next, delta, reason, accountEntryId: accountEntry.rows[0].id, sourceKey } }, client);
        await client.query('COMMIT');
        return json(res, 200, { id: rows[0].id, loyaltyPoints: next, bonusBalance: next, previousBalance: before, delta, reason });
      } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); return json(res, 503, { error: 'loyalty_save_failed', detail: error.message }); }
      finally { client?.release(); }
    }
    let client = clients.find((entry) => entry.id === clientLoyalty[1] && entry.venueId === requestVenueId);
    if (!client) return json(res, 404, { error: 'client_not_found' });
    client.accountEntries ||= []; const existing = client.accountEntries.find((entry) => entry.sourceKey === sourceKey);
    if (existing) { if (existing.amount !== delta || existing.reason !== reason) return json(res, 409, { error: 'idempotency_key_reused' }); return json(res, 200, { id: client.id, loyaltyPoints: Number(client.loyaltyPoints || 0), bonusBalance: Number(client.bonusBalance ?? client.loyaltyPoints ?? 0), delta, reason, duplicate: true }); }
    const before = Number(client.loyaltyPoints || 0); if (before + delta < 0) return json(res, 409, { error: 'insufficient_bonus_balance', balance: before }); client.loyaltyPoints = client.bonusBalance = before + delta;
    client.accountEntries.unshift({ id: `account-${crypto.randomUUID()}`, accountType: 'bonus', amount: delta, reason, sourceType: 'manual_adjustment', sourceKey, createdAt: new Date().toISOString(), actorName: req.user?.name || 'Сотрудник' });
    recordAudit(req, 'client.loyalty_adjusted', 'client', client.id, { loyaltyPoints: before }, { loyaltyPoints: client.loyaltyPoints, delta, reason }); return json(res, 200, { id: client.id, loyaltyPoints: client.loyaltyPoints, bonusBalance: client.bonusBalance, previousBalance: before, delta, reason });
  }
  const clientAccountEntries = pathname.match(/^\/api\/clients\/([^/]+)\/account-entries$/);
  const clientAccountReversal = pathname.match(/^\/api\/clients\/([^/]+)\/account-entries\/([^/]+)\/reversals$/);
  if (clientAccountReversal && req.method === 'POST') {
    if (!repositories?.pool) return json(res, 503, { error: 'account_reversal_requires_database' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientAccountReversal[1]) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientAccountReversal[2])) return json(res, 400, { error: 'valid_guest_and_entry_required' });
    const input = await body(req);
    const amount = Number(input.amount);
    const reason = String(input.reason || '').trim();
    const method = String(input.method || '');
    const idempotencyKey = String(input.idempotencyKey || '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6 || !reason || reason.length > 500 || idempotencyKey.length < 8 || idempotencyKey.length > 120 || !['wallet','cash','card','qr','clawback'].includes(method)) return json(res, 400, { error: 'valid_reversal_details_required' });
    const financeAllowed = hasPermission(req, 'finance');
    if (process.env.AUTH_REQUIRED === 'true' && !financeAllowed && !(['wallet','clawback'].includes(method) && hasPermission(req, 'loyalty'))) return json(res, 403, { error: 'forbidden', permission: 'finance' });
    if (process.env.AUTH_REQUIRED === 'true' && ['cash','card','qr'].includes(method) && (!financeAllowed || !['owner','admin'].includes(req.user?.role))) return json(res, 403, { error: 'external_payout_requires_owner_admin_finance' });
    let tx;
    try {
      tx = await repositories.pool.connect(); await tx.query('BEGIN');
      const { rows: guestRows } = await tx.query('SELECT id,loyalty_points AS "bonusBalance",deposit_balance AS "depositBalance" FROM guests WHERE id=$1 AND venue_id=$2 FOR UPDATE', [clientAccountReversal[1], venueDbId]);
      if (!guestRows[0]) { await tx.query('ROLLBACK'); return json(res, 404, { error: 'client_not_found' }); }
      const { rows: existing } = await tx.query('SELECT id,guest_id AS "guestId",source_entry_id AS "sourceEntryId",amount, payout_method AS method,reason,idempotency_key AS "idempotencyKey",shift_id AS "shiftId" FROM guest_account_reversals WHERE venue_id=$1 AND idempotency_key=$2', [venueDbId, idempotencyKey]);
      if (existing[0]) {
        const prior = existing[0];
        if (prior.guestId !== clientAccountReversal[1] || prior.sourceEntryId !== clientAccountReversal[2] || Number(prior.amount) !== amount || prior.method !== method || prior.reason !== reason) { await tx.query('ROLLBACK'); return json(res, 409, { error: 'idempotency_key_reused' }); }
        const replayAmounts = await tx.query(`SELECT COALESCE((SELECT SUM(amount) FROM guest_account_entries WHERE venue_id=$1 AND guest_id=$2 AND source_type='reversal' AND source_id=$3 AND source_key=$4),0) AS wallet_delta,
          COALESCE((SELECT SUM(amount) FROM guest_bonus_clawback_entries WHERE venue_id=$1 AND guest_id=$2 AND reversal_id=$3 AND amount>0),0) AS clawback_amount`, [venueDbId, clientAccountReversal[1], prior.id, `reversal:${prior.id}`]);
        await tx.query('COMMIT'); return json(res, 200, { ...prior, amount: Number(prior.amount), immediateWalletDelta: Number(replayAmounts.rows[0]?.wallet_delta || 0), clawbackAmount: Number(replayAmounts.rows[0]?.clawback_amount || 0), balances: { bonus: Number(guestRows[0].bonusBalance || 0), deposit: Number(guestRows[0].depositBalance || 0) }, idempotentReplay: true });
      }
      const { rows: sourceRows } = await tx.query('SELECT id,account_type AS "accountType",amount,source_type AS "sourceType",source_key AS "sourceKey" FROM guest_account_entries WHERE id=$1 AND venue_id=$2 AND guest_id=$3 FOR UPDATE', [clientAccountReversal[2], venueDbId, clientAccountReversal[1]]);
      const source = sourceRows[0];
      if (!source) { await tx.query('ROLLBACK'); return json(res, 404, { error: 'account_entry_not_found' }); }
      const sourceAmount = Number(source.amount);
      const bonusEntry = source.accountType === 'bonus';
      const eligible = (bonusEntry && ((sourceAmount > 0 && source.sourceType === 'order' && String(source.sourceKey || '').includes('bonus-earned')) || (sourceAmount < 0 && source.sourceType === 'order'))) || (!bonusEntry && ((sourceAmount > 0 && source.sourceType === 'deposit_top_up') || (sourceAmount < 0 && source.sourceType === 'order')));
      if (!eligible || (bonusEntry && !Number.isInteger(amount)) || (bonusEntry && sourceAmount > 0 && method !== 'clawback') || (bonusEntry && sourceAmount < 0 && method !== 'wallet') || (!bonusEntry && sourceAmount < 0 && method !== 'wallet') || (!bonusEntry && sourceAmount > 0 && !['wallet','cash','card','qr'].includes(method))) { await tx.query('ROLLBACK'); return json(res, 409, { error: 'source_not_reversible' }); }
      const { rows: sumRows } = await tx.query('SELECT COALESCE(SUM(amount),0) AS amount FROM guest_account_reversals WHERE venue_id=$1 AND source_entry_id=$2', [venueDbId, source.id]);
      const remaining = Math.max(0, Math.abs(sourceAmount) - Number(sumRows[0]?.amount || 0));
      if (amount > remaining + 0.000001) { await tx.query('ROLLBACK'); return json(res, 409, { error: 'reversal_exceeds_remainder', remaining }); }
      const { rows: shiftRows } = await tx.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE', [venueDbId]);
      if (!shiftRows[0]) { await tx.query('ROLLBACK'); return json(res, 409, { error: 'open_shift_required' }); }
      const shiftId = shiftRows[0].id;
      const reversal = await tx.query(`INSERT INTO guest_account_reversals (venue_id,guest_id,source_entry_id,shift_id,account_type,amount,payout_method,reason,idempotency_key,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,guest_id AS "guestId",source_entry_id AS "sourceEntryId",amount,payout_method AS method,reason,idempotency_key AS "idempotencyKey",shift_id AS "shiftId"`, [venueDbId, clientAccountReversal[1], source.id, shiftId, source.accountType, amount, method, reason, idempotencyKey, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]);
      const reversalRow = reversal.rows[0];
      let delta = -Math.sign(sourceAmount) * amount;
      let immediate = amount;
      let clawback = 0;
      if (bonusEntry && sourceAmount > 0) {
        immediate = Math.min(amount, Number(guestRows[0].bonusBalance || 0));
        clawback = amount - immediate;
        delta = -immediate;
      }
      if (!bonusEntry && delta < 0 && Number(guestRows[0].depositBalance || 0) < -delta) { await tx.query('ROLLBACK'); return json(res, 409, { error: 'insufficient_deposit_balance', available: Number(guestRows[0].depositBalance || 0) }); }
      if (delta !== 0) {
        await tx.query(`INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_id,source_key,actor_id) VALUES ($1,$2,$3,$4,$5,'reversal',$6,$7,$8)`, [venueDbId, clientAccountReversal[1], source.accountType, delta, `Сторно движения: ${reason}`, reversalRow.id, `reversal:${reversalRow.id}`, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]);
        const balanceColumn = bonusEntry ? 'loyalty_points' : 'deposit_balance';
        await tx.query(`UPDATE guests SET ${balanceColumn}=${balanceColumn}+$1 WHERE id=$2 AND venue_id=$3`, [delta, clientAccountReversal[1], venueDbId]);
      }
      if (clawback > 0) await tx.query("INSERT INTO guest_bonus_clawback_entries (venue_id,guest_id,reversal_id,amount,source_key,reason,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [venueDbId, clientAccountReversal[1], reversalRow.id, clawback, `bonus-clawback:${reversalRow.id}`, `Удержание при возврате начисленных бонусов: ${reason}`, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]);
      await tx.query("INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,$2,'guest.account_reversed','guest_account_reversal',$3,$4,$5)", [venueDbId, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null, reversalRow.id, { sourceEntryId: source.id, amount: sourceAmount, bonusBalance: Number(guestRows[0].bonusBalance || 0), depositBalance: Number(guestRows[0].depositBalance || 0) }, { ...reversalRow, sourceEntryId: source.id, originalAmount: sourceAmount, immediateWalletDelta: delta, clawbackAmount: clawback, reason, actorId: req.user?.id || null }]);
      const { rows: balanceRows } = await tx.query('SELECT loyalty_points AS "bonusBalance",deposit_balance AS "depositBalance" FROM guests WHERE id=$1 AND venue_id=$2', [clientAccountReversal[1], venueDbId]);
      await tx.query('COMMIT');
      return json(res, 201, { ...reversalRow, amount: Number(reversalRow.amount), immediateWalletDelta: delta, clawbackAmount: clawback, balances: { bonus: Number(balanceRows[0].bonusBalance || 0), deposit: Number(balanceRows[0].depositBalance || 0) } });
    } catch (error) {
      if (tx) await tx.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return json(res, 409, { error: 'idempotency_key_reused' });
      return json(res, 503, { error: 'account_reversal_failed' });
    } finally { tx?.release(); }
  }
  if (clientAccountEntries && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'finance') && !hasPermission(req, 'staff_manage') && !hasPermission(req, 'loyalty')) return json(res, 403, { error: 'forbidden', permission: 'loyalty' });
    if (repositories?.pool && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientAccountEntries[1])) return json(res, 400, { error: 'invalid_client_id' });
    if (repositories?.pool) {
      try {
        const { rows } = await repositories.pool.query(`SELECT e.id,e.account_type AS "accountType",e.amount,e.reason,e.source_type AS "sourceType",e.source_id AS "sourceId",e.source_key AS "sourceKey",e.created_at AS "createdAt",u.full_name AS "actorName",r.payment_method AS method,r.shift_id AS "shiftId",rev.payout_method AS "reversalMethod",rev.shift_id AS "reversalShiftId",rev.source_entry_id AS "reversedSourceEntryId",rev.amount AS "reversedAmount",
          GREATEST(ABS(e.amount)-COALESCE(rv.amount,0),0) AS "reversibleRemaining",
          CASE WHEN COALESCE(rv.amount,0)<ABS(e.amount) AND ((e.account_type='bonus' AND e.source_type='order' AND ((e.amount>0 AND e.source_key LIKE '%bonus-earned%') OR e.amount<0)) OR (e.account_type='deposit' AND ((e.amount>0 AND e.source_type='deposit_top_up') OR (e.amount<0 AND e.source_type='order')))) THEN true ELSE false END AS "canReverse"
          FROM guest_account_entries e LEFT JOIN users u ON u.id=e.actor_id LEFT JOIN guest_deposit_receipts r ON r.venue_id=e.venue_id AND r.id=e.source_id AND e.source_type='deposit_top_up'
          LEFT JOIN guest_account_reversals rev ON rev.venue_id=e.venue_id AND rev.id=e.source_id AND e.source_type='reversal'
          LEFT JOIN LATERAL (SELECT SUM(amount) AS amount FROM guest_account_reversals x WHERE x.venue_id=e.venue_id AND x.source_entry_id=e.id) rv ON true
          WHERE e.venue_id=$1 AND e.guest_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 100`, [venueDbId, clientAccountEntries[1]]);
        // A fully spent bonus award can be reversed with no immediate balance movement.
        // Keep its immutable reversal visible even though no guest_account_entries row exists.
        const { rows: reversalOnlyRows } = await repositories.pool.query(`SELECT rev.id,rev.account_type AS "accountType",0::numeric AS amount,rev.reason,'reversal'::text AS "sourceType",src.id AS "sourceId",rev.id::text AS "sourceKey",rev.created_at AS "createdAt",u.full_name AS "actorName",NULL::text AS method,NULL::uuid AS "shiftId",rev.payout_method AS "reversalMethod",rev.shift_id AS "reversalShiftId",src.id AS "reversedSourceEntryId",rev.amount AS "reversedAmount",'reversal'::text AS "entryKind",0::numeric AS "reversibleRemaining",false AS "canReverse"
          FROM guest_account_reversals rev JOIN guest_account_entries src ON src.venue_id=rev.venue_id AND src.guest_id=rev.guest_id AND src.id=rev.source_entry_id LEFT JOIN users u ON u.id=rev.actor_id
          WHERE rev.venue_id=$1 AND rev.guest_id=$2 AND NOT EXISTS (SELECT 1 FROM guest_account_entries movement WHERE movement.venue_id=rev.venue_id AND movement.guest_id=rev.guest_id AND movement.source_type='reversal' AND movement.source_id=rev.id)`, [venueDbId, clientAccountEntries[1]]);
        const { rows: guestRows } = await repositories.pool.query('SELECT loyalty_points AS "bonusBalance",deposit_balance AS "depositBalance" FROM guests WHERE id=$1 AND venue_id=$2', [clientAccountEntries[1], venueDbId]);
        if (!guestRows[0]) return json(res, 404, { error: 'client_not_found' });
        const { rows: holdRows } = await repositories.pool.query('SELECT COALESCE(SUM(amount),0)::int AS amount FROM guest_bonus_clawback_entries WHERE venue_id=$1 AND guest_id=$2', [venueDbId, clientAccountEntries[1]]);
        const items = [...rows, ...reversalOnlyRows].map((row) => ({ ...row, amount: Number(row.amount), reversedAmount: Number(row.reversedAmount || 0), reversibleRemaining: Number(row.reversibleRemaining || 0), canReverse: Boolean(row.canReverse) })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || String(b.id).localeCompare(String(a.id))).slice(0, 100);
        return json(res, 200, { items, balances: { bonus: Number(guestRows[0].bonusBalance || 0), deposit: Number(guestRows[0].depositBalance || 0), bonusClawback: Number(holdRows[0]?.amount || 0) } });
      } catch (error) { return json(res, 503, { error: 'guest_account_history_unavailable', detail: error.message }); }
    }
    const client = clients.find((entry) => entry.id === clientAccountEntries[1] && entry.venueId === requestVenueId);
    if (!client) return json(res, 404, { error: 'client_not_found' });
    client.accountEntries ||= [];
    for (const [accountType, amount] of [['bonus', Number(client.bonusBalance ?? client.loyaltyPoints ?? 0)], ['deposit', Number(client.depositBalance || 0)]]) {
      if (amount > 0 && !client.accountEntries.some((entry) => entry.accountType === accountType)) client.accountEntries.push({ id: `opening-${client.id}-${accountType}`, accountType, amount, reason: 'Начальный остаток демо-режима', sourceType: 'opening_balance', sourceKey: `opening:${accountType}`, createdAt: client.createdAt || new Date().toISOString(), actorName: 'Система' });
    }
    return json(res, 200, { items: client.accountEntries || [], balances: { bonus: Number(client.bonusBalance ?? client.loyaltyPoints ?? 0), deposit: Number(client.depositBalance || 0) } });
  }
  const productImage = pathname.match(/^\/api\/products\/([^/]+)\/image$/);
  if (productImage && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const imageData = String(input.imageData || '');
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData) || imageData.length > 1_500_000) return json(res, 400, { error: 'invalid_image', message: 'Поддерживаются PNG, JPG и WebP до 1.5 МБ' });
    if (repositories?.inventory) { const product = await repositories.inventory.setProductImage(venueDbId, productImage[1], imageData); if (!product) return json(res, 404, { error: 'product_not_found' }); recordAudit(req, 'product.image_updated', 'product', product.id, null, { id: product.id, name: product.name, imageUrl: '[image]' }); return json(res, 200, product); }
    const product = products.find((entry) => entry.id === productImage[1]); if (!product) return json(res, 404, { error: 'product_not_found' }); product.imageUrl = imageData; recordAudit(req, 'product.image_updated', 'product', product.id, null, { id: product.id, name: product.name, imageUrl: '[image]' }); return json(res, 200, product);
  }
  if (pathname === '/api/session') {
    const persistedSession = await sessionFromRequest(req);
    const user = req.user || persistedSession?.user || { name: 'Демо сотрудник', role: 'bartender' };
    return json(res, 200, { user, permissions: effectivePermissions(user), permissionScopes: normalizePermissionScopes(user.permissionScopes), trustedDevice: Boolean(persistedSession?.trustedDevice) });
  }
  const systemRolePath = pathname.match(/^\/api\/staff\/system-roles(?:\/([^/]+))?$/);
  if (systemRolePath) {
    if (req.user?.role !== 'owner') return json(res, 403, { error: 'system_roles_owner_required' });
    if (!repositories?.pool) return json(res, 503, { error: 'system_roles_requires_database' });
    const organizationId = requestOrganizationId(req); const role = systemRolePath[1] || null;
    if (!/^[0-9a-f-]{36}$/i.test(organizationId) || !/^[0-9a-f-]{36}$/i.test(venueDbId)) return json(res, 403, { error: 'organization_context_required' });
    const roles = Object.keys(systemRoleScopeDefaults).filter((key) => key !== 'owner');
    if (role && !roles.includes(role)) return json(res, role === 'owner' ? 409 : 400, { error: role === 'owner' ? 'owner_role_always_full_access' : 'system_role_invalid' });
    try {
      if (req.method === 'GET' && !role) {
        const result = await repositories.pool.query('SELECT role,permission_scopes AS "permissionScopes",updated_at AS "updatedAt" FROM system_role_permission_overrides WHERE venue_id=$1', [venueDbId]);
        const overrides = new Map(result.rows.map((row) => [row.role, normalizePermissionScopes(row.permissionScopes)]));
        return json(res, 200, { items: roles.map((key) => ({ role: key, permissionScopes: overrides.has(key) ? overrides.get(key) : systemRoleScopeDefaults[key], overridden: overrides.has(key) })) });
      }
      if (!role || req.method !== 'PATCH') return json(res, 405, { error: 'method_not_allowed' });
      const input = await body(req); const scopes = normalizePermissionScopes(input.permissionScopes);
      if (!Array.isArray(input.permissionScopes) || scopes.length !== new Set(input.permissionScopes).size) return json(res, 400, { error: 'invalid_permission_scopes' });
      const { rows } = await repositories.pool.query(`INSERT INTO system_role_permission_overrides (venue_id,role,permission_scopes,updated_by,updated_at) VALUES ($1,$2,$3::jsonb,$4,now()) ON CONFLICT (venue_id,role) DO UPDATE SET permission_scopes=EXCLUDED.permission_scopes,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING role,permission_scopes AS "permissionScopes",updated_at AS "updatedAt"`, [venueDbId, role, JSON.stringify(scopes), req.user?.id || null]);
      const saved = { ...rows[0], permissionScopes: normalizePermissionScopes(rows[0].permissionScopes || []), overridden: true };
      recordAudit(req, 'staff.system_role_permissions_updated', 'system_role', role, null, saved);
      return json(res, 200, saved);
    } catch (error) { return json(res, 503, { error: 'system_role_save_failed', detail: error.message }); }
  }
  const customStaffRolePath = pathname.match(/^\/api\/staff\/roles(?:\/([^/]+))?(?:\/(archive))?$/);
  if (customStaffRolePath) {
    if (process.env.AUTH_REQUIRED === 'true' && req.user?.role !== 'owner') return json(res, 403, { error: 'custom_roles_owner_required' });
    if (req.user && req.user.role !== 'owner') return json(res, 403, { error: 'custom_roles_owner_required' });
    if (!repositories?.pool) return json(res, 503, { error: 'custom_roles_requires_database' });
    const organizationId = requestOrganizationId(req);
    if (!/^[0-9a-f-]{36}$/i.test(organizationId) || !/^[0-9a-f-]{36}$/i.test(venueDbId)) return json(res, 403, { error: 'organization_context_required' });
    const roleId = customStaffRolePath[1] || null;
    const archived = customStaffRolePath[2] === 'archive';
    const roleIdIsUuid = roleId && /^[0-9a-f-]{36}$/i.test(roleId);
    if (roleId && !roleIdIsUuid) return json(res, 400, { error: 'custom_role_id_invalid' });
    try {
      if (req.method === 'GET' && !roleId) {
        const includeArchived = url.searchParams.get('status') === 'all' || url.searchParams.get('status') === 'archived';
        const activeClause = includeArchived ? '' : ' AND r.is_active=true';
        const { rows } = await repositories.pool.query(`SELECT r.id,r.name,r.description,r.permission_scopes AS "permissionScopes",r.is_active AS active,r.created_at AS "createdAt",r.updated_at AS "updatedAt",COUNT(u.id)::int AS "assignedCount"
          FROM custom_staff_roles r LEFT JOIN users u ON u.custom_role_id=r.id AND u.venue_id=r.venue_id AND u.deleted_at IS NULL
          WHERE r.organization_id=$1 AND r.venue_id=$2${activeClause} GROUP BY r.id ORDER BY r.is_active DESC,lower(r.name),r.id`, [organizationId, venueDbId]);
        return json(res, 200, { items: rows.map((row) => ({ ...row, permissionScopes: normalizePermissionScopes(row.permissionScopes || []) })) });
      }
      if (req.method === 'POST' && !roleId) {
        if (archived) return json(res, 404, { error: 'custom_role_not_found' });
        const input = await body(req);
        const name = String(input.name || '').trim();
        const description = String(input.description || '').trim();
        const scopes = normalizePermissionScopes(input.permissionScopes);
        if (!name || name.length > 80 || description.length > 300 || !Array.isArray(input.permissionScopes) || scopes.length !== new Set(input.permissionScopes).size) return json(res, 400, { error: 'custom_role_invalid' });
        const venueCheck = await repositories.pool.query('SELECT id FROM venues WHERE id=$1 AND organization_id=$2 AND is_active=true', [venueDbId, organizationId]);
        if (!venueCheck.rows[0]) return json(res, 403, { error: 'venue_not_in_organization' });
        const { rows } = await repositories.pool.query(`INSERT INTO custom_staff_roles (organization_id,venue_id,name,description,permission_scopes,created_by,updated_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6) RETURNING id,name,description,permission_scopes AS "permissionScopes",is_active AS active,created_at AS "createdAt",updated_at AS "updatedAt"`, [organizationId, venueDbId, name, description, JSON.stringify(scopes), req.user?.id || null]);
        const created = { ...rows[0], permissionScopes: normalizePermissionScopes(rows[0].permissionScopes || []), assignedCount: 0 };
        recordAudit(req, 'staff.custom_role_created', 'custom_staff_role', created.id, null, created);
        return json(res, 201, created);
      }
      if (!roleId) return json(res, 405, { error: 'method_not_allowed' });
      if (archived && req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      if (!archived && req.method !== 'PATCH') return json(res, 405, { error: 'method_not_allowed' });
      const currentResult = await repositories.pool.query(`SELECT id,name,description,permission_scopes AS "permissionScopes",is_active AS active FROM custom_staff_roles WHERE id=$1 AND organization_id=$2 AND venue_id=$3`, [roleId, organizationId, venueDbId]);
      const current = currentResult.rows[0];
      if (!current) return json(res, 404, { error: 'custom_role_not_found' });
      if (archived) {
        if (!current.active) return json(res, 200, { ...current, archivedAt: null });
        const assigned = await repositories.pool.query('SELECT COUNT(*)::int AS count FROM users WHERE custom_role_id=$1 AND venue_id=$2 AND deleted_at IS NULL', [roleId, venueDbId]);
        if (Number(assigned.rows[0]?.count || 0) > 0) return json(res, 409, { error: 'custom_role_in_use', assignedCount: Number(assigned.rows[0].count) });
        const { rows } = await repositories.pool.query('UPDATE custom_staff_roles SET is_active=false,updated_by=$1,updated_at=now() WHERE id=$2 AND organization_id=$3 AND venue_id=$4 RETURNING id,name,description,permission_scopes AS "permissionScopes",is_active AS active,updated_at AS "updatedAt"', [req.user?.id || null, roleId, organizationId, venueDbId]);
        recordAudit(req, 'staff.custom_role_archived', 'custom_staff_role', roleId, current, rows[0]);
        return json(res, 200, { ...rows[0], permissionScopes: normalizePermissionScopes(rows[0].permissionScopes || []) });
      }
      const input = await body(req);
      const name = input.name === undefined ? current.name : String(input.name || '').trim();
      const description = input.description === undefined ? current.description : String(input.description || '').trim();
      const scopes = input.permissionScopes === undefined ? normalizePermissionScopes(current.permissionScopes || []) : normalizePermissionScopes(input.permissionScopes);
      if (!name || name.length > 80 || description.length > 300 || (input.permissionScopes !== undefined && (!Array.isArray(input.permissionScopes) || scopes.length !== new Set(input.permissionScopes).size))) return json(res, 400, { error: 'custom_role_invalid' });
      const { rows } = await repositories.pool.query('UPDATE custom_staff_roles SET name=$1,description=$2,permission_scopes=$3::jsonb,updated_by=$4,updated_at=now() WHERE id=$5 AND organization_id=$6 AND venue_id=$7 AND is_active=true RETURNING id,name,description,permission_scopes AS "permissionScopes",is_active AS active,updated_at AS "updatedAt"', [name, description, JSON.stringify(scopes), req.user?.id || null, roleId, organizationId, venueDbId]);
      recordAudit(req, 'staff.custom_role_updated', 'custom_staff_role', roleId, current, rows[0]);
      return json(res, 200, { ...rows[0], permissionScopes: normalizePermissionScopes(rows[0].permissionScopes || []) });
    } catch (error) {
      if (error.code === '23505') return json(res, 409, { error: 'custom_role_name_exists' });
      return json(res, 503, { error: 'custom_role_save_failed', detail: error.message });
    }
  }
  if (pathname === '/api/staff' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'staff') && !hasPermission(req, 'settings') && !hasPermission(req, 'staff_view')) return json(res, 403, { error: 'forbidden', permission: 'staff' });
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query(`SELECT u.id,u.full_name AS name,u.login,u.contact_email AS email,u.role,u.is_active AS active,u.avatar_url AS "avatarUrl",u.photo_url AS "photoUrl",u.birth_date::text AS "birthDate",u.telegram_url AS telegram,u.phone_numbers AS "phoneNumbers",u.permission_scopes AS "permissionScopes",u.custom_role_id AS "customRoleId",cr.name AS "customRoleName",u.employment_started_at::text AS "employmentStartedAt",u.work_notes AS "workNotes",u.pin_updated_at AS "pinUpdatedAt" FROM users u LEFT JOIN custom_staff_roles cr ON cr.id=u.custom_role_id AND cr.venue_id=u.venue_id AND cr.is_active=true WHERE u.venue_id=$1 AND u.deleted_at IS NULL ORDER BY u.full_name`, [venueDbId]); return json(res, 200, { items: rows.map((row) => { row.pinConfigured = Boolean(row.pinUpdatedAt); if (!row.pinConfigured) delete row.pinUpdatedAt; if (!canSeeStaffPhoto(req)) delete row.photoUrl; return row; }) }); } catch (_) { try { const { rows } = await repositories.pool.query(`SELECT id,full_name AS name,login,contact_email AS email,role,is_active AS active,avatar_url AS "avatarUrl",photo_url AS "photoUrl",birth_date::text AS "birthDate",telegram_url AS telegram,phone_numbers AS "phoneNumbers" FROM users WHERE venue_id=$1 AND deleted_at IS NULL ORDER BY full_name`, [venueDbId]); return json(res, 200, { items: rows.map((row) => { if (!canSeeStaffPhoto(req)) delete row.photoUrl; return { ...row, pinConfigured: false, permissionScopes: [], employmentStartedAt: null, workNotes: '' }; }) }); } catch (_) { try { const { rows } = await repositories.pool.query(`SELECT id,full_name AS name,login,contact_email AS email,role,is_active AS active,avatar_url AS "avatarUrl" FROM users WHERE venue_id=$1 AND deleted_at IS NULL ORDER BY full_name`, [venueDbId]); return json(res, 200, { items: rows.map((row) => ({ ...row, pinConfigured: false, telegram: null, phoneNumbers: [], permissionScopes: [], employmentStartedAt: null, workNotes: '' })) }); } catch (_) {} } } }
    return json(res, 200, { items: staff.filter((person) => !person.deletedAt).map(({ passwordHash, ...person }) => { person.pinConfigured = Boolean(person.pinCode || person.pinHash || person.pinConfigured); if (!canSeeSensitiveStaff(req)) { delete person.passportData; delete person.pinCode; } if (!canSeeStaffPhoto(req)) delete person.photoUrl; if (!person.pinConfigured) delete person.pinUpdatedAt; return person; }) });
  }
  if (pathname === '/api/staff' && req.method === 'POST') {
    if (denyUnless(req, res, 'staff_manage')) return;
    const input = await body(req);
    if (!input.name || !rolePermissions[input.role] || input.role === 'owner') return json(res, 400, { error: 'name_and_valid_role_required' });
    const nonCrmRole = ['cleaner','security','technician','other_staff'].includes(input.role);
    if (!nonCrmRole && !input.password) return json(res, 400, { error: 'password_required' });
    if (!nonCrmRole && input.password !== undefined && (String(input.password).length < 4 || String(input.password).length > 11)) return json(res, 400, { error: 'password_length_invalid' });
        if (!canCreateStaffRole(req, input.role)) return json(res, 403, { error: 'staff_role_assignment_required' });
    const requestedScopes = normalizePermissionScopes(input.permissionScopes);
    if (input.permissionScopes !== undefined && (!Array.isArray(input.permissionScopes) || requestedScopes.length !== new Set(input.permissionScopes).size)) return json(res, 400, { error: 'invalid_permission_scopes' });
    if (input.permissionScopes !== undefined && process.env.AUTH_REQUIRED === 'true' && req.user?.role !== 'owner') return json(res, 403, { error: 'permission_scopes_owner_required' });
    const assignedScopes = input.permissionScopes === undefined ? [] : requestedScopes;
    if (!validBirthDate(input.birthDate)) return json(res, 400, { error: 'birth_date_required' });
    if (!validEmploymentDate(input.employmentStartedAt)) return json(res, 400, { error: 'invalid_employment_date' });
    if (input.workNotes !== undefined && String(input.workNotes).length > 4000) return json(res, 400, { error: 'work_notes_too_long' });
    if (input.telegram && !/^(@[A-Za-z0-9_]{5,32}|https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$)/.test(String(input.telegram).trim())) return json(res, 400, { error: 'invalid_telegram' });
    if (input.phoneNumbers !== undefined && (!Array.isArray(input.phoneNumbers) || input.phoneNumbers.length > 5 || input.phoneNumbers.some((entry) => !entry || !/^\+7[0-9 ()-]{7,24}$/.test(String(entry.number || '').trim())))) return json(res, 400, { error: 'invalid_phone_numbers' });
    if (input.photoUrl !== undefined && !canSeeStaffPhoto(req)) return json(res, 403, { error: 'staff_photo_permission_required' });
    if (input.avatarUrl) {
      try { input.avatarUrl = await normalizeStaffAvatarData(input.avatarUrl); } catch (error) { return json(res, 400, { error: error.code || 'invalid_avatar' }); }
    }
    if (input.photoUrl) {
      try { input.photoUrl = await normalizeStaffAvatarData(input.photoUrl); } catch (error) { return json(res, 400, { error: error.code || 'invalid_staff_photo' }); }
    }
    if (!nonCrmRole && input.login !== undefined && !/^[A-Za-zА-Яа-яЁё0-9_-]{3,32}$/.test(String(input.login).trim())) return json(res, 400, { error: 'invalid_staff_login' });
    if (!nonCrmRole && input.login !== undefined && ['admin', 'owner', 'staff', String(process.env.SAAS_OWNER_EMAIL || '').trim().toLowerCase()].includes(String(input.login).trim().toLowerCase())) return json(res, 409, { error: 'reserved_staff_login' });
    if (input.email !== undefined && (input.email === null || typeof input.email !== 'string' || String(input.email).trim().length > 254 || (String(input.email).trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email).trim())))) return json(res, 400, { error: 'invalid_staff_email' });
    const contactNumbers = normalizePhoneNumbers(input.phoneNumbers);
    if (contactNumbers.length && contactNumbers.filter((entry) => entry.primary).length !== 1) return json(res, 400, { error: 'one_primary_phone_required' });
    const createdPassport = input.passportData !== undefined ? staffPassportCipher.encrypt(input.passportData) : null;
    if (input.passportData !== undefined && !canSeeSensitiveStaff(req)) return json(res, 403, { error: 'sensitive_staff_permission_required' });
    if (input.passportData !== undefined && !createdPassport) return json(res, 503, { error: 'staff_passport_key_required' });
    if (repositories?.pool) {
      const organizationId = requestOrganizationId(req);
      if (!/^[0-9a-f-]{36}$/i.test(organizationId)) return json(res, 403, { error: 'organization_context_required' });
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const quota = await checkOrganizationQuota(client, organizationId, 'seat');
        if (quota.error) { await client.query('ROLLBACK'); return json(res, quota.status, { error: quota.error, ...(quota.limit ? { limit: quota.limit, used: quota.used } : {}) }); }
        const venueCheck = await client.query('SELECT id FROM venues WHERE id=$1 AND organization_id=$2 AND is_active=true FOR UPDATE', [venueDbId, organizationId]);
        if (!venueCheck.rows[0]) { await client.query('ROLLBACK'); return json(res, 403, { error: 'venue_not_in_organization' }); }
        const login = nonCrmRole ? `staff_${Date.now()}` : (input.login || `user_${Date.now()}`);
        const passwordHash = nonCrmRole ? null : await hashPassword(input.password);
        const insert = async (legacySchema = false) => client.query(legacySchema
          ? `INSERT INTO users (venue_id,organization_id,full_name,login,password_hash,pin_hash,role,avatar_url,photo_url,birth_date,telegram_url,phone_numbers,employment_started_at,work_notes,passport_data_encrypted,passport_data_iv,passport_data_tag) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9::date,$10,$11::jsonb,$12,$13,$14,$15,$16) RETURNING id,full_name AS name,login,role,is_active AS active,avatar_url AS "avatarUrl",photo_url AS "photoUrl",birth_date::text AS "birthDate",telegram_url AS telegram,phone_numbers AS "phoneNumbers",employment_started_at::text AS "employmentStartedAt",work_notes AS "workNotes"`
          : `INSERT INTO users (venue_id,organization_id,full_name,login,password_hash,pin_hash,role,permission_scopes,avatar_url,photo_url,birth_date,telegram_url,phone_numbers,employment_started_at,work_notes,passport_data_encrypted,passport_data_iv,passport_data_tag) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7::jsonb,$8,$9,$10::date,$11,$12::jsonb,$13,$14,$15,$16,$17) RETURNING id,full_name AS name,login,role,permission_scopes AS "permissionScopes",is_active AS active,avatar_url AS "avatarUrl",photo_url AS "photoUrl",birth_date::text AS "birthDate",telegram_url AS telegram,phone_numbers AS "phoneNumbers",employment_started_at::text AS "employmentStartedAt",work_notes AS "workNotes"`,
          legacySchema
            ? [venueDbId, organizationId, input.name, login, passwordHash, input.role, input.avatarUrl || null, input.photoUrl || null, input.birthDate, input.telegram || null, JSON.stringify(contactNumbers), input.employmentStartedAt || null, String(input.workNotes || '').slice(0, 4000), createdPassport?.data || null, createdPassport?.iv || null, createdPassport?.tag || null]
            : [venueDbId, organizationId, input.name, login, passwordHash, input.role, JSON.stringify(assignedScopes), input.avatarUrl || null, input.photoUrl || null, input.birthDate, input.telegram || null, JSON.stringify(contactNumbers), input.employmentStartedAt || null, String(input.workNotes || '').slice(0, 4000), createdPassport?.data || null, createdPassport?.iv || null, createdPassport?.tag || null]);
        let rows;
        try { ({ rows } = await insert()); }
        catch (error) { if (error.code !== '42703' && error.code !== '42704') throw error; ({ rows } = await insert(true)); }
        const membershipRole = input.role === 'admin' ? 'admin' : 'member';
        await client.query(`INSERT INTO organization_memberships (organization_id,user_id,membership_role,status) VALUES ($1,$2,$3,'active') ON CONFLICT (organization_id,user_id) DO UPDATE SET membership_role=EXCLUDED.membership_role,status='active'`, [organizationId, rows[0].id, membershipRole]);
        if (input.email !== undefined) {
          const email = String(input.email).trim().replace(/@([^@]+)$/, (_, domain) => `@${domain.toLowerCase()}`);
          await client.query('UPDATE users SET contact_email=$1 WHERE id=$2 AND venue_id=$3', [email, rows[0].id, venueDbId]);
          rows[0].email = email;
        }
        await client.query('COMMIT');
        const result = { ...rows[0], permissionScopes: rows[0].permissionScopes || assignedScopes, employmentStartedAt: input.employmentStartedAt || null, workNotes: String(input.workNotes || '').slice(0, 4000) };
        if (!canSeeStaffPhoto(req)) delete result.photoUrl;
        recordAudit(req, 'staff.created', 'staff', rows[0].id, null, result); return json(res, 201, result);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: error.code === '23505' ? 'login_already_exists' : 'staff_create_failed', detail: error.message }); }
      finally { client.release(); }
    }
    const person = { id: `u-${Date.now()}`, name: input.name, login: nonCrmRole ? `staff_${Date.now()}` : (input.login || `user_${Date.now()}`), passwordHash: nonCrmRole ? null : await hashPassword(input.password), role: input.role, active: true, avatarUrl: input.avatarUrl || null, photoUrl: input.photoUrl || null, birthDate: input.birthDate, telegram: input.telegram || null, phoneNumbers: contactNumbers, permissionScopes: assignedScopes, employmentStartedAt: input.employmentStartedAt || null, workNotes: String(input.workNotes || '').slice(0, 4000), passportData: input.passportData || null, pinCode: null, pinConfigured: false, pinUpdatedAt: null };
    staff.push(person);
    const { passwordHash, ...publicPerson } = person;
    recordAudit(req, 'staff.created', 'staff', person.id, null, publicPerson);
    return json(res, 201, publicPerson);
  }
  const staffStatus = pathname.match(/^\/api\/staff\/([^/]+)\/status$/);
  if (staffStatus && req.method === 'PATCH') {
    if (denyUnless(req, res, 'staff_manage')) return;
    const input = await body(req); if (typeof input.active !== 'boolean') return json(res, 400, { error: 'active_boolean_required' });
    if (String(req.user?.id || '') === staffStatus[1] && !input.active) return json(res, 409, { error: 'self_deactivation_forbidden' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(staffStatus[1])) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(`SELECT id,organization_id AS "organizationId",is_active AS active FROM users WHERE id=$1 AND venue_id=$2 AND role <> 'owner' AND deleted_at IS NULL`, [staffStatus[1], venueDbId]);
        if (!current.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'staff_not_found_or_archived_or_owner' }); }
        const person = current.rows[0];
        if (input.active && !person.active) {
          const quota = await checkOrganizationQuota(client, person.organizationId || requestOrganizationId(req), 'seat');
          if (quota.error) { await client.query('ROLLBACK'); return json(res, quota.status, { error: quota.error, ...(quota.limit ? { limit: quota.limit, used: quota.used } : {}) }); }
        }
        const locked = await client.query(`SELECT id FROM users WHERE id=$1 AND venue_id=$2 AND role <> 'owner' AND deleted_at IS NULL FOR UPDATE`, [staffStatus[1], venueDbId]);
        if (!locked.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'staff_not_found_or_archived_or_owner' }); }
        const { rows } = await client.query(`UPDATE users SET is_active=$1 WHERE id=$2 AND venue_id=$3 RETURNING id,full_name AS name,role,is_active AS active,avatar_url AS "avatarUrl"`, [input.active, staffStatus[1], venueDbId]);
        await client.query('COMMIT'); recordAudit(req, input.active ? 'staff.activated' : 'staff.deactivated', 'staff', rows[0].id, { active: !input.active }, rows[0]); return json(res, 200, rows[0]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'staff_status_update_failed', detail: error.message }); }
      finally { client.release(); }
    }
    const person = staff.find((entry) => entry.id === staffStatus[1]); if (!person || person.role === 'owner' || person.deletedAt) return json(res, 404, { error: 'staff_not_found_or_archived_or_owner' }); if (!canManageStaffTarget(req, person.role)) return json(res, 403, { error: 'staff_management_required' }); const before = { active: person.active }; person.active = input.active; recordAudit(req, input.active ? 'staff.activated' : 'staff.deactivated', 'staff', person.id, before, { active: person.active }); return json(res, 200, person);
  }
  const staffDelete = pathname.match(/^\/api\/staff\/([^/]+)$/);
  if (staffDelete && req.method === 'DELETE') {
    if (denyUnless(req, res, 'staff_manage')) return;
    if (String(req.user?.id || '') === staffDelete[1]) return json(res, 409, { error: 'self_deactivation_forbidden' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(staffDelete[1])) { try { const { rows } = await repositories.pool.query(`UPDATE users SET is_active=false WHERE id=$1 AND venue_id=$2 AND role <> 'owner' AND is_active=true RETURNING id,full_name AS name,role,is_active AS active,avatar_url AS "avatarUrl"`, [staffDelete[1], venueDbId]); if (!rows[0]) return json(res, 404, { error: 'staff_not_found_or_owner' }); recordAudit(req, 'staff.deactivated', 'staff', rows[0].id, { active: true }, { active: false }); return json(res, 200, rows[0]); } catch (error) { return json(res, 409, { error: 'staff_delete_failed', detail: error.message }); } }
    const person = staff.find((entry) => entry.id === staffDelete[1]);
    if (!person) return json(res, 404, { error: 'staff_not_found' });
    if (person.role === 'owner') return json(res, 409, { error: 'owner_cannot_be_deleted' });
    if (!person.active) return json(res, 409, { error: 'staff_already_inactive' });
    person.active = false; recordAudit(req, 'staff.deactivated', 'staff', person.id, { active: true }, { active: false });
    return json(res, 200, person);
  }
  const staffArchive = pathname.match(/^\/api\/staff\/([^/]+)\/archive$/);
  if (staffArchive && req.method === 'POST') {
    if (denyUnless(req, res, 'staff_manage')) return;
    if (process.env.AUTH_REQUIRED === 'true' && req.user?.role !== 'owner') return json(res, 403, { error: 'staff_archive_owner_required' });
    if (String(req.user?.id || '') === staffArchive[1]) return json(res, 409, { error: 'self_archive_forbidden' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(staffArchive[1])) {
      try {
        const { rows } = await repositories.pool.query(`UPDATE users SET is_active=false,deleted_at=now() WHERE id=$1 AND venue_id=$2 AND role <> 'owner' AND is_active=false AND deleted_at IS NULL RETURNING id,full_name AS name,role,is_active AS active,deleted_at AS "archivedAt"`, [staffArchive[1], venueDbId]);
        if (!rows[0]) return json(res, 404, { error: 'staff_not_found_or_owner' });
        recordAudit(req, 'staff.archived', 'staff', rows[0].id, { active: true }, { active: false, archivedAt: rows[0].archivedAt });
        return json(res, 200, rows[0]);
      } catch (error) { return json(res, 409, { error: 'staff_archive_failed', detail: error.message }); }
    }
    const index = staff.findIndex((person) => person.id === staffArchive[1]);
    const person = staff[index];
    if (!person || person.role === 'owner' || person.active || person.deletedAt) return json(res, 409, { error: 'staff_must_be_blocked_before_archive' });
    person.active = false; person.deletedAt = new Date().toISOString();
    recordAudit(req, 'staff.archived', 'staff', person.id, { active: true }, { active: false, archivedAt: person.deletedAt });
    return json(res, 200, { id: person.id, name: person.name, role: person.role, active: false, archivedAt: person.deletedAt });
  }
  const staffAvatar = pathname.match(/^\/api\/staff\/([^/]+)\/avatar$/);
  if (staffAvatar && req.method === 'POST') {
    const isSelf = String(req.user?.id || '') === staffAvatar[1];
    if (!hasPermission(req, 'staff_manage') && !isSelf) return json(res, 403, { error: 'forbidden', permission: 'staff' });
    const input = await body(req);
    let normalizedAvatar;
    try { normalizedAvatar = await normalizeStaffAvatarData(input.imageData); } catch (error) { return json(res, 400, { error: error.code || 'invalid_avatar' }); }
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(staffAvatar[1])) { try { const target = await repositories.pool.query('SELECT id,role FROM users WHERE id=$1 AND venue_id=$2 AND deleted_at IS NULL', [staffAvatar[1], venueDbId]); if (!target.rows[0]) return json(res, 404, { error: 'staff_not_found' }); if (!isSelf && !canManageStaffTarget(req, target.rows[0].role)) return json(res, 403, { error: target.rows[0].role === 'owner' ? 'owner_staff_protected' : 'staff_management_required' }); const { rows } = await repositories.pool.query(`UPDATE users SET avatar_url=$1 WHERE id=$2 AND venue_id=$3 RETURNING id,full_name AS name,role,is_active AS active,avatar_url AS "avatarUrl"`, [normalizedAvatar, staffAvatar[1], venueDbId]); recordAudit(req, 'staff.avatar_updated', 'staff', rows[0].id, { avatarUrl: '[image]' }, { avatarUrl: '[image]' }); return json(res, 200, rows[0]); } catch (error) { return json(res, 409, { error: 'staff_avatar_failed', detail: error.message }); } }
    const person = staff.find((entry) => entry.id === staffAvatar[1]); if (!person) return json(res, 404, { error: 'staff_not_found' }); if (!isSelf && !canManageStaffTarget(req, person.role)) return json(res, 403, { error: person.role === 'owner' ? 'owner_staff_protected' : 'staff_management_required' });
    const hadAvatar = Boolean(person.avatarUrl); person.avatarUrl = normalizedAvatar; recordAudit(req, 'staff.avatar_updated', 'staff', person.id, { avatarUrl: hadAvatar ? '[image]' : null }, { avatarUrl: '[image]' }); return json(res, 200, person);
  }
  const staffProfile = pathname.match(/^\/api\/staff\/([^/]+)\/profile$/);
  const staffPinPath = pathname.match(/^\/api\/staff\/([^/]+)\/pin$/);
  if (staffPinPath && req.method === 'PATCH') {
    const personId = staffPinPath[1]; const isSelf = String(req.user?.id || '') === personId;
    if (!isSelf && denyUnless(req, res, 'staff_manage')) return;
    const input = await body(req); const pin = String(input.pin || '').trim();
    if (!/^\d{4}$/.test(pin)) return json(res, 400, { error: 'invalid_staff_pin_format' });
    const memoryPerson = staff.find((entry) => entry.id === personId);
    if (memoryPerson) {
      if (!memoryPerson.active || memoryPerson.deletedAt) return json(res, 404, { error: 'staff_not_found' });
      memoryPerson.pinHash = await hashPassword(pin); memoryPerson.pinCode = null; memoryPerson.pinConfigured = true; memoryPerson.pinUpdatedAt = new Date().toISOString();
      for (const session of sessions.values()) if (String(session.user?.id || '') === personId) { session.unlockHash = memoryPerson.pinHash; session.user.pinConfigured = true; }
      const notification = { id: `staff-pin-${crypto.randomUUID()}`, venueId: notificationVenueScope(req, venueDbId), type: 'staff_pin_updated', staffId: personId, staffName: memoryPerson.name, actor: req.user?.name || 'сотрудник', createdAt: memoryPerson.pinUpdatedAt, notificationRecipients: ['owner', 'admin'] };
      staffNotifications.push(notification); recordAudit(req, 'staff.pin_updated', 'staff', personId, { pinConfigured: true }, { pinConfigured: true, notificationRecipients: ['owner', 'admin'] });
      return json(res, 200, { id: personId, pinConfigured: true, pinUpdatedAt: memoryPerson.pinUpdatedAt });
    }
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(personId)) {
      try {
        // PIN verification only needs the one-way hash. It must remain usable when
        // optional passport encryption is not configured for the venue.
        const { rows } = await repositories.pool.query('UPDATE users SET pin_hash=$1,pin_data_encrypted=NULL,pin_data_iv=NULL,pin_data_tag=NULL,pin_updated_at=now() WHERE id=$2 AND venue_id=$3 AND is_active=true AND deleted_at IS NULL RETURNING id,full_name AS name,pin_updated_at AS "pinUpdatedAt"', [await hashPassword(pin), personId, venueDbId]);
        if (!rows[0]) return json(res, 404, { error: 'staff_not_found' });
        for (const session of sessions.values()) if (String(session.user?.id || '') === personId) { session.unlockHash = null; session.user.pinConfigured = true; }
        recordAudit(req, 'staff.pin_updated', 'staff', personId, { pinConfigured: true }, { pinConfigured: true, notificationRecipients: ['owner', 'admin'] });
        return json(res, 200, { id: rows[0].id, pinConfigured: true, pinUpdatedAt: rows[0].pinUpdatedAt });
      } catch (error) { return json(res, 409, { error: 'staff_pin_save_failed', detail: error.message }); }
    }
    return json(res, 404, { error: 'staff_not_found' });
  }
if (staffProfile && req.method === 'GET') {
  const personId = staffProfile[1];
  const canRead = hasPermission(req, 'staff') || hasPermission(req, 'staff_view') || String(req.user?.id || '') === personId;
  if (!canRead) return json(res, 403, { error: 'forbidden', permission: 'staff_view' });
  if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(personId)) {
    try {
      const { rows } = await repositories.pool.query('SELECT u.id,u.full_name AS name,u.login,u.contact_email AS email,u.role,u.is_active AS active,u.avatar_url AS "avatarUrl",u.photo_url AS "photoUrl",u.birth_date::text AS "birthDate",u.telegram_url AS telegram,u.phone_numbers AS "phoneNumbers",u.permission_scopes AS "permissionScopes",u.custom_role_id AS "customRoleId",cr.name AS "customRoleName",u.employment_started_at::text AS "employmentStartedAt",u.work_notes AS "workNotes",u.pin_updated_at AS "pinUpdatedAt",u.passport_data_encrypted,u.passport_data_iv,u.passport_data_tag FROM users u LEFT JOIN custom_staff_roles cr ON cr.id=u.custom_role_id AND cr.venue_id=u.venue_id AND cr.is_active=true WHERE u.id=$1 AND u.venue_id=$2 AND u.deleted_at IS NULL LIMIT 1', [personId, venueDbId]);
      if (!rows[0]) return json(res, 404, { error: 'staff_not_found' });
      const profile = { ...rows[0], pinConfigured: Boolean(rows[0].pinUpdatedAt), workspacePermissions: effectivePermissions({ role: rows[0].role, customRolePermissionScopes: rows[0].customRolePermissionScopes, permissionScopes: rows[0].permissionScopes }) };
      if (canSeeSensitiveStaff(req)) profile.passportData = staffPassportCipher.decrypt(rows[0]);
      if (!canSeeStaffPhoto(req)) delete profile.photoUrl;
      delete profile.passport_data_encrypted; delete profile.passport_data_iv; delete profile.passport_data_tag;
      return json(res, 200, profile);
    } catch (error) {
      // Keep migration 002 contact data available when the employment migration is not applied yet.
      try {
        const { rows } = await repositories.pool.query('SELECT id,full_name AS name,login,contact_email AS email,role,is_active AS active,avatar_url AS "avatarUrl",photo_url AS "photoUrl",birth_date::text AS "birthDate",telegram_url AS telegram,phone_numbers AS "phoneNumbers",passport_data_encrypted,passport_data_iv,passport_data_tag FROM users WHERE id=$1 AND venue_id=$2 AND deleted_at IS NULL LIMIT 1', [personId, venueDbId]);
        if (!rows[0]) return json(res, 404, { error: 'staff_not_found' });
        const profile = { ...rows[0], permissionScopes: [], employmentStartedAt: null, workNotes: '', workspacePermissions: effectivePermissions({ role: rows[0].role, permissionScopes: [] }) };
        if (canSeeSensitiveStaff(req)) profile.passportData = staffPassportCipher.decrypt(rows[0]);
        if (!canSeeStaffPhoto(req)) delete profile.photoUrl;
        delete profile.passport_data_encrypted; delete profile.passport_data_iv; delete profile.passport_data_tag;
        return json(res, 200, profile);
      } catch (_) {
        try {
          const { rows } = await repositories.pool.query('SELECT id,full_name AS name,login,contact_email AS email,role,is_active AS active,avatar_url AS "avatarUrl" FROM users WHERE id=$1 AND venue_id=$2 AND deleted_at IS NULL LIMIT 1', [personId, venueDbId]);
          if (!rows[0]) return json(res, 404, { error: 'staff_not_found' });
          return json(res, 200, { ...rows[0], telegram: null, phoneNumbers: [], permissionScopes: [], employmentStartedAt: null, workNotes: '', workspacePermissions: effectivePermissions({ role: rows[0].role, permissionScopes: [] }) });
        } catch (fallbackError) { return json(res, 409, { error: 'staff_profile_read_failed', detail: fallbackError.message }); }
      }
    }
  }
  const person = staff.find((entry) => entry.id === personId);
  if (!person) return json(res, 404, { error: 'staff_not_found' });
  const profile = { ...person, workspacePermissions: effectivePermissions(person) }; if (!canSeeSensitiveStaff(req)) delete profile.passportData; if (!canSeeStaffPhoto(req)) delete profile.photoUrl;
  return json(res, 200, profile);
}
if (staffProfile && req.method === 'PATCH') {
  const personId = staffProfile[1];
  const canManage = hasPermission(req, 'staff_manage');
  const canManageSensitive = canSeeSensitiveStaff(req);
  const isSelf = String(req.user?.id || '') === personId;
  if (!canManage && !isSelf) return json(res, 403, { error: 'forbidden', permission: 'staff' });
  const input = await body(req);
  const memoryPerson = staff.find((entry) => entry.id === personId);
  let before = memoryPerson ? { ...memoryPerson, phoneNumbers: Array.isArray(memoryPerson.phoneNumbers) ? memoryPerson.phoneNumbers.map((phone) => ({ ...phone })) : [] } : null;
  if (!before && repositories?.pool && /^[0-9a-f-]{36}$/i.test(personId)) {
    try {
      const { rows } = await repositories.pool.query('SELECT id,full_name AS name,login,contact_email AS email,role,is_active AS active,avatar_url AS "avatarUrl",photo_url AS "photoUrl",birth_date::text AS "birthDate",telegram_url AS telegram,phone_numbers AS "phoneNumbers",permission_scopes AS "permissionScopes",custom_role_id AS "customRoleId",employment_started_at::text AS "employmentStartedAt",work_notes AS "workNotes" FROM users WHERE id=$1 AND venue_id=$2 AND deleted_at IS NULL LIMIT 1', [personId, venueDbId]);
      before = rows[0] || null;
    } catch (_) {}
  }
  if (!before) return json(res, 404, { error: 'staff_not_found' });
  const selfContactOnly = isSelf && Object.keys(input).every((key) => key === 'email');
  if (!selfContactOnly && !canManageStaffTarget(req, before.role)) return json(res, 403, { error: before.role === 'owner' ? 'owner_staff_protected' : (req.user?.role === 'admin' && ['admin','developer'].includes(before.role) ? 'staff_role_assignment_required' : 'staff_management_required') });
  const nextLogin = input.login === undefined ? undefined : (typeof input.login === 'string' ? input.login.trim() : null);
  if (nextLogin !== undefined && (nextLogin === null || !/^[A-Za-zА-Яа-яЁё0-9_-]{3,32}$/.test(nextLogin))) return json(res, 400, { error: 'invalid_staff_login' });
  const nextEmail = input.email === undefined ? undefined : (input.email === null ? null : (typeof input.email === 'string' ? input.email.trim() : '__invalid_email_type__'));
  if (nextEmail !== undefined && (nextEmail === '__invalid_email_type__' || (nextEmail !== null && nextEmail.length > 254) || (nextEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)))) return json(res, 400, { error: 'invalid_staff_email' });
  const normalizedEmail = nextEmail ? nextEmail.replace(/@([^@]+)$/, (_, domain) => `@${domain.toLowerCase()}`) : null;
  const currentLogin = before.login;
  if (nextLogin !== undefined && ['admin', 'owner', 'staff', String(process.env.SAAS_OWNER_EMAIL || '').trim().toLowerCase()].includes(nextLogin.toLowerCase())) return json(res, 409, { error: 'reserved_staff_login' });
  if (nextLogin !== undefined && nextLogin !== currentLogin && repositories?.pool) {
    const duplicate = await repositories.pool.query('SELECT 1 FROM users WHERE login=$1 AND id<>$2 LIMIT 1', [nextLogin, personId]);
    if (duplicate.rowCount) return json(res, 409, { error: 'login_already_exists' });
    try {
      await repositories.pool.query('INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)', [venueDbId, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null, 'staff.login_updated', 'staff', personId, JSON.stringify({ login: currentLogin }), JSON.stringify({ login: nextLogin })]);
    } catch (error) { return json(res, 503, { error: 'staff_profile_save_failed', detail: error.message }); }
  }
  const auditBefore = { ...before, phoneNumbers: Array.isArray(before.phoneNumbers) ? before.phoneNumbers.map((phone) => ({ ...phone })) : [] };
  if (!canManageSensitive) delete auditBefore.passportData;
  if (input.name !== undefined && !canManage) return json(res, 403, { error: 'staff_management_required' });
  if (input.role !== undefined && !canManage) return json(res, 403, { error: 'staff_management_required' });
  if (input.name !== undefined && (!String(input.name).trim() || String(input.name).trim().length > 120)) return json(res, 400, { error: 'invalid_staff_name' });
  if (input.role !== undefined && (!rolePermissions[input.role] || input.role === 'owner')) return json(res, 400, { error: 'invalid_staff_role' });
  if (input.role !== undefined && !canAssignStaffRole(req, input.role)) return json(res, 403, { error: 'staff_role_assignment_required' });
  if (input.permissionScopes !== undefined && (!Array.isArray(input.permissionScopes) || normalizePermissionScopes(input.permissionScopes).length !== new Set(input.permissionScopes).size)) return json(res, 400, { error: 'invalid_permission_scopes' });
  if (input.permissionScopes !== undefined && process.env.AUTH_REQUIRED === 'true' && req.user?.role !== 'owner') return json(res, 403, { error: 'permission_scopes_owner_required' });
  if (input.customRoleId !== undefined && (req.user?.role !== 'owner' || before.role === 'owner')) return json(res, 403, { error: 'custom_role_owner_required' });
  if (input.customRoleId !== undefined && input.customRoleId !== null && !/^[0-9a-f-]{36}$/i.test(String(input.customRoleId))) return json(res, 400, { error: 'custom_role_id_invalid' });
  if (input.customRoleId !== undefined && !repositories?.pool) return json(res, 503, { error: 'custom_roles_requires_database' });
  if (input.customRoleId !== undefined) before.customRoleId = input.customRoleId || null;
  if (input.employmentStartedAt !== undefined && !canManage) return json(res, 403, { error: 'staff_management_required' });
  if (input.birthDate !== undefined && !canManage) return json(res, 403, { error: 'staff_management_required' });
  if (input.workNotes !== undefined && !canManage) return json(res, 403, { error: 'staff_management_required' });
  if (input.birthDate !== undefined && !validBirthDate(input.birthDate)) return json(res, 400, { error: 'invalid_birth_date' });
  if (input.employmentStartedAt !== undefined && !validEmploymentDate(input.employmentStartedAt)) return json(res, 400, { error: 'invalid_employment_date' });
  if (input.workNotes !== undefined && String(input.workNotes).length > 4000) return json(res, 400, { error: 'work_notes_too_long' });
  if (input.telegram !== undefined && input.telegram && !/^(@[A-Za-z0-9_]{5,32}|https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$)/.test(String(input.telegram).trim())) return json(res, 400, { error: 'invalid_telegram' });
  if (input.phoneNumbers !== undefined && (!Array.isArray(input.phoneNumbers) || input.phoneNumbers.length > 5 || input.phoneNumbers.some((entry) => !entry || !/^\+7[0-9 ()-]{7,24}$/.test(String(entry.number || '').trim())))) return json(res, 400, { error: 'invalid_phone_numbers' });
  if (input.passportData !== undefined && !canManageSensitive) return json(res, 403, { error: 'sensitive_staff_permission_required' });
  const clearPassportRequested = input.passportData?.clear === true;
  if (clearPassportRequested && req.user?.role !== 'owner') return json(res, 403, { error: 'staff_passport_clear_owner_required' });
  if (input.avatarUrl !== undefined) {
    if (input.avatarUrl) {
      try { input.avatarUrl = before.avatarUrl = await normalizeStaffAvatarData(input.avatarUrl); } catch (error) { return json(res, 400, { error: error.code || 'invalid_avatar' }); }
    } else before.avatarUrl = null;
  }
  if (input.photoUrl !== undefined && !canSeeStaffPhoto(req)) return json(res, 403, { error: 'staff_photo_permission_required' });
  if (input.photoUrl) {
    try { input.photoUrl = await normalizeStaffAvatarData(input.photoUrl); } catch (error) { return json(res, 400, { error: error.code || 'invalid_staff_photo' }); }
  }
  if (input.name !== undefined) before.name = String(input.name).trim();
  if (input.role !== undefined) before.role = input.role;
  if (nextLogin !== undefined) before.login = nextLogin;
  if (nextEmail !== undefined) before.email = normalizedEmail;
  if (input.permissionScopes !== undefined) before.permissionScopes = normalizePermissionScopes(input.permissionScopes);
  if (input.telegram !== undefined) before.telegram = String(input.telegram || '').trim();
  if (input.employmentStartedAt !== undefined) before.employmentStartedAt = input.employmentStartedAt || null;
  if (input.birthDate !== undefined) before.birthDate = input.birthDate || null;
  if (input.photoUrl !== undefined) before.photoUrl = input.photoUrl || null;
  if (input.workNotes !== undefined) before.workNotes = String(input.workNotes || '').slice(0, 4000);
  let contactJson = null;
  if (input.phoneNumbers !== undefined) {
    const contacts = normalizePhoneNumbers(input.phoneNumbers);
    if (contacts.length && contacts.filter((entry) => entry.primary).length !== 1) return json(res, 400, { error: 'one_primary_phone_required' });
    before.phoneNumbers = contacts;
    contactJson = JSON.stringify(contacts);
  }
  const clearPassportData = clearPassportRequested && canManageSensitive;
  const hasPassportData = input.passportData !== undefined && input.passportData && typeof input.passportData === 'object' && ['number', 'issuedAt', 'issuer'].some((key) => String(input.passportData[key] || '').trim());
  if (clearPassportData) before.passportData = null; else if (hasPassportData) before.passportData = input.passportData;
  const encryptedPassport = hasPassportData && canManageSensitive ? staffPassportCipher.encrypt(input.passportData) : null;
  if (hasPassportData && repositories?.pool && canManageSensitive && !encryptedPassport) return json(res, 503, { error: 'staff_passport_key_required' });
  if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(personId)) {
    try {
      if (input.customRoleId) {
        const availableRole = await repositories.pool.query('SELECT id FROM custom_staff_roles WHERE id=$1 AND organization_id=$2 AND venue_id=$3 AND is_active=true LIMIT 1', [input.customRoleId, requestOrganizationId(req), venueDbId]);
        if (!availableRole.rows[0]) return json(res, 400, { error: 'custom_role_not_available' });
      }
      try { await repositories.pool.query('UPDATE users SET avatar_url=CASE WHEN $1 THEN $2 ELSE avatar_url END,photo_url=CASE WHEN $3 THEN $4 ELSE photo_url END,birth_date=CASE WHEN $5 THEN $6::date ELSE birth_date END,telegram_url=CASE WHEN $7 THEN $8 ELSE telegram_url END,phone_numbers=CASE WHEN $9 THEN $10::jsonb ELSE phone_numbers END,employment_started_at=CASE WHEN $11 THEN $12::date ELSE employment_started_at END,work_notes=CASE WHEN $13 THEN $14 ELSE work_notes END,passport_data_encrypted=CASE WHEN $24 THEN NULL ELSE COALESCE($15,passport_data_encrypted) END,passport_data_iv=CASE WHEN $24 THEN NULL ELSE COALESCE($16,passport_data_iv) END,passport_data_tag=CASE WHEN $24 THEN NULL ELSE COALESCE($17,passport_data_tag) END,full_name=CASE WHEN $18 THEN $19 ELSE full_name END,role=CASE WHEN $20 THEN $21 ELSE role END WHERE id=$22 AND venue_id=$23', [input.avatarUrl !== undefined, input.avatarUrl || null, input.photoUrl !== undefined, input.photoUrl || null, input.birthDate !== undefined, input.birthDate || null, input.telegram !== undefined, input.telegram !== undefined ? (input.telegram || null) : null, input.phoneNumbers !== undefined, contactJson || '[]', input.employmentStartedAt !== undefined, input.employmentStartedAt || null, input.workNotes !== undefined, input.workNotes !== undefined ? String(input.workNotes || '').slice(0, 4000) : null, encryptedPassport?.data || null, encryptedPassport?.iv || null, encryptedPassport?.tag || null, input.name !== undefined, before.name, input.role !== undefined, before.role, personId, venueDbId, clearPassportData]); } catch (_) {
        await repositories.pool.query('UPDATE users SET avatar_url=CASE WHEN $1 THEN $2 ELSE avatar_url END,photo_url=CASE WHEN $3 THEN $4 ELSE photo_url END,birth_date=CASE WHEN $5 THEN $6::date ELSE birth_date END,telegram_url=CASE WHEN $7 THEN $8 ELSE telegram_url END,phone_numbers=CASE WHEN $9 THEN $10::jsonb ELSE phone_numbers END,passport_data_encrypted=CASE WHEN $20 THEN NULL ELSE COALESCE($11,passport_data_encrypted) END,passport_data_iv=CASE WHEN $20 THEN NULL ELSE COALESCE($12,passport_data_iv) END,passport_data_tag=CASE WHEN $20 THEN NULL ELSE COALESCE($13,passport_data_tag) END,full_name=CASE WHEN $14 THEN $15 ELSE full_name END,role=CASE WHEN $16 THEN $17 ELSE role END WHERE id=$18 AND venue_id=$19', [input.avatarUrl !== undefined, input.avatarUrl || null, input.photoUrl !== undefined, input.photoUrl || null, input.birthDate !== undefined, input.birthDate || null, input.telegram !== undefined, input.telegram !== undefined ? (input.telegram || null) : null, input.phoneNumbers !== undefined, contactJson || '[]', encryptedPassport?.data || null, encryptedPassport?.iv || null, encryptedPassport?.tag || null, input.name !== undefined, before.name, input.role !== undefined, before.role, personId, venueDbId, clearPassportData]);
      }
      if (nextLogin !== undefined || nextEmail !== undefined) {
        if (nextLogin !== undefined && nextLogin !== currentLogin) {
          const duplicate = await repositories.pool.query('SELECT 1 FROM users WHERE login=$1 AND id<>$2 LIMIT 1', [nextLogin, personId]);
          if (duplicate.rowCount) return json(res, 409, { error: 'login_already_exists' });
        }
        try {
          await repositories.pool.query('UPDATE users SET login=COALESCE($1,login),contact_email=CASE WHEN $2 THEN $3 ELSE contact_email END WHERE id=$4 AND venue_id=$5', [nextLogin, nextEmail !== undefined, normalizedEmail, personId, venueDbId]);
          if (nextLogin !== undefined && nextLogin !== currentLogin) {
            await repositories.pool.query('DELETE FROM auth_sessions WHERE user_id=$1', [personId]);
            for (const [sessionToken, session] of sessions) if (String(session.user?.id || '') === personId) sessions.delete(sessionToken);
          }
        } catch (error) { if (error.code === '23505') return json(res, 409, { error: 'login_already_exists' }); throw error; }
      }
      if (input.permissionScopes !== undefined) { await repositories.pool.query('UPDATE users SET permission_scopes=$1::jsonb WHERE id=$2 AND venue_id=$3', [JSON.stringify(before.permissionScopes || []), personId, venueDbId]); }
      if (input.customRoleId !== undefined) { await repositories.pool.query('UPDATE users SET custom_role_id=$1::uuid WHERE id=$2 AND venue_id=$3', [input.customRoleId || null, personId, venueDbId]); }
    } catch (error) { return json(res, 409, { error: 'staff_profile_save_failed', detail: error.message }); }
  }
  if (memoryPerson) Object.assign(memoryPerson, before);
  const publicPerson = { ...before };
  if (!canManageSensitive) delete publicPerson.passportData;
  if (!canSeeStaffPhoto(req)) delete publicPerson.photoUrl;
  recordAudit(req, 'staff.profile_updated', 'staff', before.id, auditBefore, publicPerson);
  return json(res, 200, publicPerson);
}
  if (pathname === '/api/staff/schedule' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['staff_manage', 'staff_view'])) return;
    const from = url.searchParams.get('from') || today(); const to = url.searchParams.get('to') || from;
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query('SELECT s.*,u.full_name AS "userName" FROM staff_schedules s JOIN users u ON u.id=s.user_id AND u.venue_id=s.venue_id WHERE s.venue_id=$1 AND s.work_date BETWEEN $2::date AND $3::date ORDER BY s.work_date,s.planned_start', [venueDbId, from, to]); return json(res, 200, { items: rows }); } catch (error) { return json(res, 503, { error: 'schedule_unavailable', detail: error.message }); } }
    return json(res, 200, { items: [] });
  }
  if (pathname === '/api/inventory/subdepartments' && req.method === 'GET') {
    if (denyUnless(req, res, 'inventory_read')) return;
    const status = ['active','archived','all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'active';
    if (repositories?.pool) { try { const filter = status === 'all' ? '' : status === 'archived' ? ' AND is_active=false' : ' AND is_active=true'; const { rows } = await repositories.pool.query(`SELECT id,department_code AS "departmentCode",name,is_active AS active FROM inventory_subdepartments WHERE venue_id=$1${filter} ORDER BY department_code,name`, [venueDbId]); return json(res, 200, { items: rows }); } catch (error) { return json(res, 503, { error: 'inventory_subdepartments_unavailable', detail: error.message }); } }
    return json(res, 200, { items: inventorySubdepartments.filter((item) => status === 'all' || (status === 'archived' ? item.active === false : item.active !== false)) });
  }
  if (pathname === '/api/inventory/subdepartments' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const name = String(input.name || '').trim(); const departmentCode = String(input.departmentCode || '').trim();
    if (!name || name.length > 80 || !departmentCode || departmentCode.length > 48) return json(res, 400, { error: 'invalid_inventory_subdepartment' });
    if (repositories?.pool) { let client; let checkingParent = true; try { client = await repositories.pool.connect(); await client.query('BEGIN'); const departmentResult = await client.query('SELECT 1 FROM inventory_departments WHERE venue_id=$1 AND code=$2 AND is_active=true FOR UPDATE', [venueDbId, departmentCode]); checkingParent = false; if (!departmentResult.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'inventory_department_not_found' }); } const { rows } = await client.query('INSERT INTO inventory_subdepartments (venue_id,department_code,name) VALUES ($1,$2,$3) RETURNING id,department_code AS "departmentCode",name,is_active AS active', [venueDbId, departmentCode, name]); await client.query('COMMIT'); recordAudit(req, 'inventory.subdepartment_created', 'inventory_subdepartment', rows[0].id, null, rows[0]); return json(res, 201, rows[0]); } catch (error) { await client?.query('ROLLBACK').catch(() => {}); if (checkingParent) return json(res, 503, { error: 'inventory_hierarchy_unavailable' }); return json(res, 409, { error: error.code === '23505' ? 'inventory_subdepartment_exists' : 'inventory_subdepartment_create_failed' }); } finally { client?.release(); } }
    if (inventorySubdepartments.some((item) => item.departmentCode === departmentCode && item.name.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU"))) return json(res, 409, { error: 'inventory_subdepartment_exists' });
    const created = { id: `subdepartment-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, departmentCode, name, active: true }; inventorySubdepartments.push(created); return json(res, 201, created);
  }
  const inventorySubdepartmentPath = pathname.match(/^\/api\/inventory\/subdepartments\/([^/]+)$/);
  if (inventorySubdepartmentPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const id = decodeURIComponent(inventorySubdepartmentPath[1]); const name = String(input.name || '').trim(); const departmentCode = String(input.departmentCode || '').trim();
    if (!name || name.length > 80 || !departmentCode || departmentCode.length > 48) return json(res, 400, { error: 'invalid_inventory_subdepartment' });
    if (repositories?.pool) {
      let client;
      let updated;
      let before;
      let checkingParent = true;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        const departmentResult = await client.query('SELECT 1 FROM inventory_departments WHERE venue_id=$1 AND code=$2 AND is_active=true FOR UPDATE', [venueDbId, departmentCode]);
        checkingParent = false;
        if (!departmentResult.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'inventory_department_not_found' }); }
        const current = await client.query('SELECT id,department_code AS "departmentCode",name FROM inventory_subdepartments WHERE venue_id=$1 AND id=$2 AND is_active=true FOR UPDATE', [venueDbId, id]);
        before = current.rows[0];
        if (!before) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_subdepartment_not_found' }); }
        const result = await client.query('UPDATE inventory_subdepartments SET name=$1,department_code=$2 WHERE venue_id=$3 AND id=$4 AND is_active=true RETURNING id,department_code AS "departmentCode",name,is_active AS active', [name, departmentCode, venueDbId, id]);
        updated = result.rows[0];
        if (!updated) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_subdepartment_not_found' }); }
        if (before.name !== name || before.departmentCode !== departmentCode) {
          if (before.departmentCode !== departmentCode) await client.query('UPDATE product_categories SET department=$1 WHERE venue_id=$2 AND subdepartment_id=$3 AND is_active=true', [departmentCode, venueDbId, id]);
          await client.query('UPDATE ingredients SET subdepartment=$1,department=$2 WHERE venue_id=$3 AND subdepartment=$4 AND department=$5 AND is_marked=true', [name, departmentCode, venueDbId, before.name, before.departmentCode]);
        }
        await client.query('COMMIT');
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (checkingParent) return json(res, 503, { error: 'inventory_hierarchy_unavailable' });
        return json(res, 409, { error: error.code === '23505' ? 'inventory_subdepartment_exists' : 'inventory_subdepartment_update_failed' });
      } finally { client?.release(); }
      recordAudit(req, 'inventory.subdepartment_updated', 'inventory_subdepartment', id, before, updated);
      return json(res, 200, updated);
    }
    const memoryItem = inventorySubdepartments.find((item) => item.id === id && item.active);
    if (!memoryItem) return json(res, 404, { error: 'inventory_subdepartment_not_found' });
    if (inventorySubdepartments.some((item) => item.active && item.id !== id && item.departmentCode === departmentCode && item.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) return json(res, 409, { error: 'inventory_subdepartment_exists' });
    const before = { ...memoryItem };
    Object.assign(memoryItem, { departmentCode, name });
    for (const category of productCategories) if (category.active && category.subdepartmentId === id) category.department = departmentCode;
    for (const item of inventory) if (item.department === before.departmentCode && item.subdepartment === before.name) Object.assign(item, { department: departmentCode, subdepartment: name });
    return json(res, 200, memoryItem);
  }
  if (inventorySubdepartmentPath && req.method === 'DELETE') {
    if (denyUnless(req, res, 'inventory')) return;
    const id = decodeURIComponent(inventorySubdepartmentPath[1]); if (repositories?.pool) { const client = await repositories.pool.connect(); try { await client.query('BEGIN'); const current = await client.query('SELECT id,department_code AS "departmentCode",name FROM inventory_subdepartments WHERE venue_id=$1 AND id=$2 AND is_active=true FOR UPDATE', [venueDbId, id]); if (!current.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_subdepartment_not_found' }); } const used = await client.query('SELECT EXISTS(SELECT 1 FROM ingredients WHERE venue_id=$1 AND department=$2 AND subdepartment=$3) OR EXISTS(SELECT 1 FROM product_categories WHERE venue_id=$1 AND subdepartment_id=$4 AND is_active=true) AS used', [venueDbId, current.rows[0].departmentCode, current.rows[0].name, id]); if (used.rows[0]?.used) { await client.query('ROLLBACK'); return json(res, 409, { error: 'inventory_subdepartment_in_use' }); } const { rows } = await client.query('UPDATE inventory_subdepartments SET is_active=false WHERE venue_id=$1 AND id=$2 AND is_active=true RETURNING id,name,is_active AS active', [venueDbId, id]); if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_subdepartment_not_found' }); } await client.query('COMMIT'); recordAudit(req, 'inventory.subdepartment_archived', 'inventory_subdepartment', id, { active: true }, rows[0]); return json(res, 200, rows[0]); } catch (_) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'inventory_subdepartment_archive_failed' }); } finally { client.release(); } }
    const memoryItem = inventorySubdepartments.find((item) => item.id === id && item.active); if (!memoryItem) return json(res, 404, { error: 'inventory_subdepartment_not_found' }); if (productCategories.some((item) => item.active && item.subdepartmentId === id) || inventory.some((item) => item.department === memoryItem.departmentCode && item.subdepartment === memoryItem.name)) return json(res, 409, { error: 'inventory_subdepartment_in_use' }); memoryItem.active = false; recordAudit(req, 'inventory.subdepartment_archived', 'inventory_subdepartment', id, { active: true }, { id, active: false }); return json(res, 200, { id, active: false });
  }
  const inventorySubdepartmentRestore = pathname.match(/^\/api\/inventory\/subdepartments\/([^/]+)\/restore$/);
  if (inventorySubdepartmentRestore && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const id = decodeURIComponent(inventorySubdepartmentRestore[1]);
    if (repositories?.pool && !/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'invalid_inventory_subdepartment' });
    if (repositories?.pool) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query('SELECT department_code AS "departmentCode" FROM inventory_subdepartments WHERE venue_id=$1 AND id=$2::uuid AND is_active=false FOR UPDATE', [venueDbId, id]);
        if (!current.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_archived_entry_not_found' }); }
        const parent = await client.query('SELECT code FROM inventory_departments WHERE venue_id=$1 AND code=$2 AND is_active=true FOR UPDATE', [venueDbId, current.rows[0].departmentCode]);
        if (!parent.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'inventory_subdepartment_parent_inactive_or_not_found' }); }
        const { rows } = await client.query('UPDATE inventory_subdepartments SET is_active=true WHERE venue_id=$1 AND id=$2::uuid AND is_active=false RETURNING id,department_code AS "departmentCode",name,is_active AS active', [venueDbId, id]);
        if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_archived_entry_not_found' }); }
        await client.query('COMMIT'); recordAudit(req, 'inventory.subdepartment_restored', 'inventory_subdepartment', id, { active: false }, rows[0]); return json(res, 200, rows[0]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: error.code === '23505' ? 'inventory_subdepartment_exists' : 'inventory_subdepartment_restore_failed' }); } finally { client.release(); }
    }
    const memoryItem = inventorySubdepartments.find((item) => item.id === id && item.active === false); if (!memoryItem) return json(res, 404, { error: 'inventory_archived_entry_not_found' }); if (!inventoryDepartments.some((item) => item.code === memoryItem.departmentCode && item.active !== false)) return json(res, 409, { error: 'inventory_subdepartment_parent_inactive_or_not_found' }); memoryItem.active = true; recordAudit(req, 'inventory.subdepartment_restored', 'inventory_subdepartment', id, { active: false }, memoryItem); return json(res, 200, memoryItem);
  }
  const recipeCostPath = pathname.match(/^\/api\/recipes\/([^/]+)\/cost$/);
  if (recipeCostPath && req.method === 'GET') {
    if (denyUnless(req, res, 'inventory_read')) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(recipeCostPath[1])) { try { const { rows } = await repositories.pool.query('SELECT id,name,ingredients,yield_quantity AS "yieldQuantity",yield_unit AS "yieldUnit",portion_count AS "portionCount" FROM inventory_recipe_cards WHERE id=$1 AND venue_id=$2 AND active=true', [recipeCostPath[1], venueDbId]); const recipe = rows[0]; if (!recipe) return json(res, 404, { error: 'recipe_not_found' }); const stock = (await repositories.inventory.list(venueDbId)).items; const lines = calculateRecipeCostLines(recipe.ingredients, stock); const totalCost = Math.round(lines.reduce((sum, line) => sum + line.cost, 0) * 100) / 100; const portionCount = Math.max(1, Number(recipe.portionCount || 1)); return json(res, 200, { recipeId: recipe.id, yieldQuantity: Number(recipe.yieldQuantity), yieldUnit: recipe.yieldUnit, portionCount, lines, totalCost, costPerPortion: Math.round((totalCost / portionCount) * 100) / 100, missing: lines.filter((line) => !line.linked) }); } catch (error) { if (error.code === 'recipe_ingredient_unit_mismatch' || error.code === 'invalid_recipe_quantity') return json(res, 409, { error: error.code, ingredient: error.ingredient, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit }); return json(res, 503, { error: 'recipe_cost_unavailable', detail: error.message }); } }
    const recipe = recipes.find((item) => item.id === recipeCostPath[1]); if (!recipe) return json(res, 404, { error: 'recipe_not_found' });
    const stock = repositories?.inventory ? (await repositories.inventory.list(venueDbId)).items : inventory;
    let lines; try { lines = calculateRecipeCostLines(recipe.ingredients, stock); } catch (error) { return json(res, 409, { error: error.code || 'recipe_cost_invalid', ingredient: error.ingredient, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit }); }
    const totalCost = Math.round(lines.reduce((sum, line) => sum + line.cost, 0) * 100) / 100; const portionCount = Math.max(1, Number(recipe.portionCount || 1)); return json(res, 200, { recipeId: recipe.id, yieldQuantity: Number(recipe.yieldQuantity || 1), yieldUnit: recipe.yieldUnit || 'порция', portionCount, lines, totalCost, costPerPortion: Math.round((totalCost / portionCount) * 100) / 100, missing: lines.filter((line) => !line.linked) });
  }
  if (pathname === '/api/staff/schedule' && req.method === 'POST') {
    if (denyUnless(req, res, 'staff_manage')) return;
    const input = await body(req); const userId = String(input.userId || '').trim(); const workDate = String(input.workDate || '').trim(); const plannedStart = input.plannedStart === '' || input.plannedStart == null ? null : input.plannedStart; const plannedEnd = input.plannedEnd === '' || input.plannedEnd == null ? null : input.plannedEnd;
    if (!userId || !isValidIsoDate(workDate)) return json(res, 400, { error: 'invalid_schedule_entry' });
    if ((plannedStart !== null && !isValidIsoTimestamp(plannedStart)) || (plannedEnd !== null && !isValidIsoTimestamp(plannedEnd)) || (plannedStart !== null && plannedEnd !== null && Date.parse(plannedEnd) <= Date.parse(plannedStart))) return json(res, 400, { error: 'invalid_schedule_time' });
    if (repositories?.pool) { if (!/^[0-9a-f-]{36}$/i.test(userId)) return json(res, 400, { error: 'invalid_schedule_employee' }); try { const employee = await repositories.pool.query('SELECT id FROM users WHERE id=$1 AND venue_id=$2 AND is_active=true AND deleted_at IS NULL', [userId, venueDbId]); if (!employee.rows[0]) return json(res, 404, { error: 'staff_member_not_found' }); const { rows } = await repositories.pool.query('INSERT INTO staff_schedules (venue_id,user_id,work_date,planned_start,planned_end,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (venue_id,user_id,work_date) DO UPDATE SET planned_start=EXCLUDED.planned_start,planned_end=EXCLUDED.planned_end,note=EXCLUDED.note RETURNING *', [venueDbId, userId, workDate, plannedStart, plannedEnd, String(input.note || '').slice(0,500) || null, req.user?.id || null]); return json(res, 201, rows[0]); } catch (error) { return json(res, 409, { error: 'schedule_save_failed', detail: error.message }); } }
  }
  if (pathname === '/api/staff/time' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['staff_manage', 'staff_view'])) return;
    let from = url.searchParams.get('from') || ''; let to = url.searchParams.get('to') || '';
    if (repositories?.pool && (!from || !to)) {
      try {
        const localDate = await repositories.pool.query(`SELECT (now() AT TIME ZONE COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg'))::date::text AS date FROM venues v LEFT JOIN organizations org ON org.id=v.organization_id WHERE v.id=$1`, [venueDbId]);
        const venueDate = localDate.rows[0]?.date;
        if (!venueDate) return json(res, 503, { error: 'work_time_unavailable' });
        if (!from) from = venueDate;
        if (!to) to = from;
      } catch (error) { return json(res, 503, { error: 'work_time_unavailable', detail: error.message }); }
    } else {
      from ||= today();
      to ||= from;
    }
    if (!isValidIsoDate(from) || !isValidIsoDate(to) || to < from) return json(res, 400, { error: 'invalid_work_time_period' });
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query(`WITH tz AS (SELECT COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg') AS name FROM venues v LEFT JOIN organizations org ON org.id=v.organization_id WHERE v.id=$1), bounds AS (SELECT ($2::date::timestamp AT TIME ZONE name) starts_at, (($3::date+1)::timestamp AT TIME ZONE name) ends_at FROM tz), clipped AS (SELECT w.*,u.full_name AS "userName",GREATEST(w.started_at,b.starts_at) starts_at,LEAST(COALESCE(w.ended_at,now()),b.ends_at) ends_at FROM bounds b JOIN staff_work_logs w ON w.venue_id=$1 AND w.started_at < b.ends_at AND COALESCE(w.ended_at,now()) > b.starts_at JOIN users u ON u.id=w.user_id), ordered AS (SELECT *,MAX(ends_at) OVER (PARTITION BY user_id ORDER BY starts_at,ends_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous_end FROM clipped), merged AS (SELECT *,GREATEST(starts_at,COALESCE(previous_end,starts_at)) effective_start FROM ordered) SELECT id,venue_id,user_id,started_at AS "started_at",ended_at AS "ended_at",source,note,created_at,"userName",COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (ends_at-effective_start))/3600),0)::numeric AS hours FROM merged ORDER BY started_at DESC`, [venueDbId, from, to]); return json(res, 200, { items: rows.map((row) => ({ ...row, hours: Number(Number(row.hours || 0).toFixed(2)) })) }); } catch (error) { return json(res, 503, { error: 'work_time_unavailable', detail: error.message }); } }
    return json(res, 200, { items: [] });
  }
  if (pathname === '/api/staff/time' && req.method === 'POST') {
    if (denyUnless(req, res, 'staff_manage')) return;
    const input = await body(req); const userId = String(input.userId || '').trim(); const startedAt = new Date(input.startedAt || ''); const endedAt = input.endedAt ? new Date(input.endedAt) : null;
    const source = String(input.source || 'manual');
    if (!/^[0-9a-f-]{36}$/i.test(userId) || Number.isNaN(startedAt.getTime()) || (endedAt && Number.isNaN(endedAt.getTime())) || (endedAt && endedAt <= startedAt) || !['manual','shift','device'].includes(source)) return json(res, 400, { error: 'invalid_work_log' });
    if (repositories?.pool) { let client; try { client = await repositories.pool.connect(); await client.query('BEGIN'); const employee = await client.query('SELECT id FROM users WHERE id=$1 AND venue_id=$2 AND is_active=true AND deleted_at IS NULL FOR UPDATE', [userId,venueDbId]); if (!employee.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'staff_member_not_found' }); } const overlapping = await client.query(`SELECT id FROM staff_work_logs WHERE venue_id=$1 AND user_id=$2 AND started_at < COALESCE($4::timestamptz,'infinity'::timestamptz) AND COALESCE(ended_at,'infinity'::timestamptz) > $3::timestamptz LIMIT 1 FOR UPDATE`, [venueDbId,userId,startedAt.toISOString(),endedAt?.toISOString() || null]); if (overlapping.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'work_log_overlaps_existing' }); } const { rows } = await client.query('INSERT INTO staff_work_logs (venue_id,user_id,started_at,ended_at,source,note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [venueDbId,userId,startedAt.toISOString(),endedAt?.toISOString() || null,source,String(input.note || '').slice(0,500) || null]); await client.query('COMMIT'); recordAudit(req, 'staff.work_time_recorded', 'staff', rows[0].user_id, null, rows[0]); return json(res, 201, rows[0]); } catch (error) { await client?.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'work_log_save_failed', detail: error.message }); } finally { client?.release(); } }
  }
  if (pathname === '/api/payroll/rules' && req.method === 'GET') {
    if (denyUnless(req, res, 'finance')) return;
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query('SELECT * FROM payroll_rules WHERE venue_id=$1 ORDER BY active DESC,name', [venueDbId]); return json(res, 200, { items: rows }); } catch (error) { return json(res, 503, { error: 'payroll_rules_unavailable', detail: error.message }); } }
    return json(res, 200, { items: [] });
  }
  if (pathname === '/api/finance/purchase-payables' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['finance', 'finance_read'])) return;
    if (isOperationalEmployee(req)) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
    if (!repositories?.purchaseDocuments) return json(res, 503, { error: 'purchase_payables_unavailable' });
    const readSingle = (name) => { const values = url.searchParams.getAll(name); return values.length === 1 ? values[0].trim() : values.length === 0 ? '' : null; };
    const documentDateFrom = readSingle('documentDateFrom');
    const documentDateTo = readSingle('documentDateTo');
    const undatedValue = readSingle('includeUndated');
    const paymentStatus = readSingle('paymentStatus');
    if (documentDateFrom === null || documentDateTo === null || undatedValue === null || paymentStatus === null
      || documentDateFrom && !isValidIsoDate(documentDateFrom) || documentDateTo && !isValidIsoDate(documentDateTo)
      || documentDateFrom && documentDateTo && documentDateFrom > documentDateTo
      || undatedValue && !['true', 'false'].includes(undatedValue)
      || paymentStatus && !['unpaid', 'partially_paid', 'paid'].includes(paymentStatus)) return json(res, 400, { error: 'invalid_payables_filter' });
    const dateFilter = { documentDateFrom, documentDateTo, includeUndated: undatedValue === 'true', paymentStatus };
    try { return json(res, 200, { items: await repositories.purchaseDocuments.listPayables(venueDbId, dateFilter) }); }
    catch (error) { return json(res, 503, { error: 'purchase_payables_unavailable', detail: error.message }); }
  }
  const purchasePaymentPath = pathname.match(/^\/api\/finance\/purchase-payables\/([^/]+)\/payments$/);
  if (purchasePaymentPath && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['finance', 'finance_read'])) return;
    if (isOperationalEmployee(req)) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
    if (!repositories?.purchaseDocuments) return json(res, 503, { error: 'purchase_payments_unavailable' });
    const id = decodeURIComponent(purchasePaymentPath[1]);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'invalid_purchase_document_id' });
    try {
      const items = await repositories.purchaseDocuments.listPayments(venueDbId, id);
      return items === null ? json(res, 404, { error: 'purchase_document_not_found' }) : json(res, 200, { items });
    } catch (error) { return json(res, 503, { error: 'purchase_payments_unavailable', detail: error.message }); }
  }
  if (purchasePaymentPath && req.method === 'POST') {
    if (denyUnless(req, res, 'finance')) return;
    if (!repositories?.purchaseDocuments) return json(res, 503, { error: 'purchase_payments_unavailable' });
    const id = decodeURIComponent(purchasePaymentPath[1]);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'invalid_purchase_document_id' });
    const input = await body(req);
    const amount = Number(input.amount);
    const paymentDate = String(input.paymentDate || '');
    const paymentMethod = String(input.paymentMethod || '');
    const idempotencyKey = String(input.idempotencyKey || req.headers['idempotency-key'] || '').trim();
    const documentUrl = String(input.documentUrl || '');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999999.99 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) return json(res, 400, { error: 'invalid_purchase_payment_amount' });
    if (!isValidIsoDate(paymentDate)) return json(res, 400, { error: 'invalid_purchase_payment_date' });
    if (!['cash','card','bank_transfer','other'].includes(paymentMethod)) return json(res, 400, { error: 'invalid_purchase_payment_method' });
    if (!/^[\w:.-]{8,128}$/.test(idempotencyKey)) return json(res, 400, { error: 'purchase_payment_idempotency_key_required' });
    const documentValidation = validatePurchasePaymentDocument(documentUrl);
    if (!documentValidation.valid) return json(res, 400, { error: documentValidation.error });
    try {
      const result = await repositories.purchaseDocuments.addPayment({ id, venueId: venueDbId, amount, paymentDate, paymentMethod, documentUrl, idempotencyKey, createdBy: /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null });
      if (!result.idempotent) recordAudit(req, 'finance.purchase_payment_created', 'purchase_document', id, null, { expenseId: result.expenseId, amount: result.amount, paymentDate: result.paymentDate, paymentMethod: result.paymentMethod, totalPaid: result.totalPaid, balanceDue: result.balanceDue });
      return json(res, result.idempotent ? 200 : 201, result);
    } catch (error) {
      const statuses = { purchase_document_not_found: 404, purchase_document_not_posted: 409, purchase_payment_exceeds_balance: 409, purchase_payment_idempotency_conflict: 409 };
      return json(res, statuses[error.message] || (error.code === '23505' ? 409 : 503), { error: statuses[error.message] ? error.message : error.code === '23505' ? 'purchase_payment_idempotency_conflict' : 'purchase_payment_save_failed', detail: error.message });
    }
  }
  if (pathname === '/api/expenses' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['finance', 'finance_read'])) return;
    if (isOperationalEmployee(req)) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
    const from = url.searchParams.get('from') || '1900-01-01'; const to = url.searchParams.get('to') || '2999-12-31';
    const rawLimit = url.searchParams.get('limit'); const rawOffset = url.searchParams.get('offset');
    const limit = rawLimit === null ? null : Number(rawLimit); const offset = rawOffset === null ? 0 : Number(rawOffset);
    if ((limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) || !Number.isInteger(offset) || offset < 0 || (limit === null && rawOffset !== null)) return json(res, 400, { error: 'invalid_expense_pagination' });
    if (repositories?.pool) {
      try {
        const values = [venueDbId,from,to,hasPermission(req,'finance')];
        const where = 'WHERE e.venue_id=$1 AND e.expense_date BETWEEN $2::date AND $3::date AND ($4::boolean OR e.source <> \'payroll\')';
        const [countResult, expenseResult] = await Promise.all([
          repositories.pool.query(`SELECT COUNT(*)::int AS count FROM expenses e ${where}`, values),
          repositories.pool.query(`SELECT e.*,e.category_id AS "categoryId",e.expense_date AS "expenseDate",e.document_url AS "documentUrl",CASE WHEN e.source='payroll' THEN COALESCE(payroll.status,'legacy_unmatched') ELSE NULL END AS "payrollStatus", (e.source='payroll' AND NOT EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=e.venue_id AND pe.expense_id=e.id AND pe.status='paid')) AS "payrollNeedsReview", CASE WHEN e.source='payroll' AND payroll.id IS NOT NULL THEN 'Выплата зарплаты за ' || to_char(payroll.period_from,'DD.MM.YYYY') || ' — ' || to_char(payroll.period_to,'DD.MM.YYYY') ELSE e.description END AS description FROM expenses e LEFT JOIN LATERAL (SELECT pe.id,pe.status,pe.period_from,pe.period_to FROM payroll_entries pe WHERE pe.venue_id=e.venue_id AND pe.expense_id=e.id ORDER BY pe.created_at DESC,pe.id DESC LIMIT 1) payroll ON true ${where} ORDER BY e.expense_date DESC,e.created_at DESC${limit === null ? '' : ' LIMIT $5 OFFSET $6'}`, limit === null ? values : [...values,limit,offset]),
        ]);
        return json(res, 200, { items: expenseResult.rows, totalCount: countResult.rows[0].count, limit, offset });
      } catch (error) { return json(res, 503, { error: 'expenses_unavailable', detail: error.message }); }
    }
    const filteredExpenses = manualExpenses.filter((expense) => expense.date >= from && expense.date <= to).sort((a,b) => b.date.localeCompare(a.date));
    return json(res, 200, { items: limit === null ? filteredExpenses : filteredExpenses.slice(offset, offset + limit), totalCount: filteredExpenses.length, limit, offset });
  }
  if (pathname === '/api/expenses' && req.method === 'POST') {
    if (denyUnless(req, res, 'finance')) return;
    const input = await body(req); let category = String(input.category || '').trim(); let categoryId = input.categoryId ? String(input.categoryId) : null; const amount = Number(input.amount); const expenseDate = String(input.expenseDate || today());
    const documentUrl = String(input.documentUrl || '');
    const documentValidation = validatePurchasePaymentDocument(documentUrl);
    if (!documentValidation.valid) return json(res, 400, { error: documentValidation.error });
    if (repositories?.pool && categoryId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(categoryId)) return json(res, 400, { error: 'invalid_finance_category' });
    if ((!categoryId && (!category || category.length > 80)) || !Number.isFinite(amount) || amount < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return json(res, 400, { error: 'invalid_expense' });
    if (input.source === 'payroll') return json(res, 400, { error: 'payroll_expense_must_be_paid_through_payroll' });
    if (input.source === 'purchase') return json(res, 400, { error: 'purchase_payment_requires_receipt_link' });
    if (repositories?.pool) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        if (categoryId) {
          const selected = await client.query("SELECT name FROM finance_categories WHERE id=$1 AND venue_id=$2 AND active=true AND kind='expense' FOR UPDATE", [categoryId,venueDbId]);
          if (!selected.rows[0]) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_finance_category' }); }
          category = selected.rows[0].name;
        }
        if (!category || category.length > 80) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_expense' }); }
        const { rows } = await client.query('INSERT INTO expenses (venue_id,category,category_id,amount,expense_date,description,source,document_url,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [venueDbId,category,categoryId,amount,expenseDate,String(input.description || '').slice(0,1000) || null,['manual','purchase','other'].includes(input.source) ? input.source : 'manual',documentUrl || null,req.user?.id || null]);
        await client.query('COMMIT');
        return json(res, 201, rows[0]);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        return json(res, error.code === '23503' ? 400 : 409, { error: error.code === '23503' ? 'invalid_finance_category' : 'expense_save_failed', detail: error.message });
      } finally { client.release(); }
    }
    if (categoryId) { const selected = financeCategories.find((item) => item.id === categoryId && item.active !== false && item.kind === 'expense'); if (!selected) return json(res, 400, { error: 'invalid_finance_category' }); category = selected.name; }
    if (!category || category.length > 80) return json(res, 400, { error: 'invalid_expense' });
    const expense = { id: `expense-${Date.now()}`, category, categoryId, amount, date: expenseDate, expenseDate, description: String(input.description || '').slice(0,1000), source: ['manual','other'].includes(input.source) ? input.source : 'manual', documentUrl: documentUrl || null, createdAt: new Date().toISOString() }; manualExpenses.push(expense); return json(res, 201, expense);
  }
  if (pathname === '/api/payroll/rules' && req.method === 'POST') {
    if (denyUnless(req, res, 'finance')) return;
    const input = await body(req); const name = String(input.name || '').trim(); const ruleType = String(input.ruleType || 'hourly'); const rate = Number(input.rate);
    if (!name || !['hourly','monthly','percent_revenue','per_shift'].includes(ruleType) || !Number.isFinite(rate) || rate < 0) return json(res, 400, { error: 'invalid_payroll_rule' });
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query('INSERT INTO payroll_rules (venue_id,name,rule_type,rate) VALUES ($1,$2,$3,$4) RETURNING *', [venueDbId,name,ruleType,rate]); return json(res, 201, rows[0]); } catch (error) { return json(res, 409, { error: 'payroll_rule_save_failed', detail: error.message }); } }
  }
  const payrollEntryPath = pathname.match(/^\/api\/payroll\/entries\/([^/]+)$/);
  if ((pathname === '/api/payroll/entries' && req.method === 'GET') || (payrollEntryPath && req.method === 'GET')) {
    if (denyUnless(req, res, 'finance')) return;
    if (!repositories?.pool) return json(res, 503, { error: 'payroll_requires_database' });
    const from = String(url.searchParams.get('from') || '1900-01-01'); const to = String(url.searchParams.get('to') || '2999-12-31');
    const userId = String(url.searchParams.get('userId') || ''); const status = String(url.searchParams.get('status') || '');
    if (!isValidIsoDate(from) || !isValidIsoDate(to) || to < from || (userId && !/^[0-9a-f-]{36}$/i.test(userId)) || (status && !['draft','approved','paid','cancelled'].includes(status))) return json(res, 400, { error: 'invalid_payroll_filter' });
    const id = payrollEntryPath ? decodeURIComponent(payrollEntryPath[1]) : '';
    if (id && !/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'invalid_payroll_entry_id' });
    try {
      const { rows } = await repositories.pool.query(`SELECT pe.id,pe.user_id AS "userId",u.full_name AS "userName",pe.rule_id AS "ruleId",pr.name AS "ruleName",pr.rule_type AS "ruleType",pe.period_from AS "periodFrom",pe.period_to AS "periodTo",pe.amount,pe.status,pe.payment_date AS "paymentDate",pe.expense_id AS "expenseId",pe.approved_at AS "approvedAt",pe.paid_at AS "paidAt",pe.cancelled_at AS "cancelledAt",COALESCE(work.hours,0)::numeric AS hours FROM payroll_entries pe JOIN users u ON u.id=pe.user_id LEFT JOIN payroll_rules pr ON pr.id=pe.rule_id AND pr.venue_id=pe.venue_id JOIN venues v ON v.id=pe.venue_id LEFT JOIN organizations org ON org.id=v.organization_id LEFT JOIN LATERAL (WITH bounds AS (SELECT (pe.period_from::timestamp AT TIME ZONE COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg')) starts_at,((pe.period_to+1)::timestamp AT TIME ZONE COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg')) ends_at),clipped AS (SELECT GREATEST(w.started_at,b.starts_at) starts_at,LEAST(COALESCE(w.ended_at,now()),b.ends_at) ends_at FROM bounds b JOIN staff_work_logs w ON w.venue_id=pe.venue_id AND w.user_id=pe.user_id AND w.started_at < b.ends_at AND COALESCE(w.ended_at,now()) > b.starts_at),ordered AS (SELECT *,MAX(ends_at) OVER (ORDER BY starts_at,ends_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous_end FROM clipped),merged AS (SELECT *,GREATEST(starts_at,COALESCE(previous_end,starts_at)) effective_start FROM ordered) SELECT SUM(GREATEST(0,EXTRACT(EPOCH FROM (ends_at-effective_start))/3600)) hours FROM merged) work ON true WHERE pe.venue_id=$1 AND ($2::date IS NULL OR pe.period_to >= $2::date) AND ($3::date IS NULL OR pe.period_from <= $3::date) AND ($4::uuid IS NULL OR pe.user_id=$4) AND ($5::text='' OR pe.status=$5) AND ($6::uuid IS NULL OR pe.id=$6) ORDER BY pe.period_from DESC,u.full_name`, [venueDbId, from === '1900-01-01' ? null : from, to === '2999-12-31' ? null : to, userId || null, status, id || null]);
      if (id && !rows[0]) return json(res, 404, { error: 'payroll_entry_not_found' });
      return json(res, 200, id ? rows[0] : { items: rows.map((row) => ({ ...row, amount: Number(row.amount || 0), hours: Number(Number(row.hours || 0).toFixed(2)) })) });
    } catch (error) { return json(res, 503, { error: 'payroll_entries_unavailable', detail: error.message }); }
  }
  if (pathname === '/api/payroll/entries' && req.method === 'POST') {
    if (denyUnless(req, res, 'finance')) return;
    if (!repositories?.pool) return json(res, 503, { error: 'payroll_requires_database' });
    const input = await body(req); const userId = String(input.userId || '').trim(); const periodFrom = String(input.periodFrom || '').trim(); const periodTo = String(input.periodTo || '').trim(); const ruleId = String(input.ruleId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^[0-9a-f-]{36}$/i.test(ruleId) || !isValidIsoDate(periodFrom) || !isValidIsoDate(periodTo) || periodTo < periodFrom || countInclusiveDays(periodFrom, periodTo) > 366) return json(res, 400, { error: 'invalid_payroll_period' });
    try {
      const [userResult, ruleResult] = await Promise.all([
        repositories.pool.query('SELECT id FROM users WHERE id=$1 AND venue_id=$2 AND is_active=true AND deleted_at IS NULL', [userId, venueDbId]),
        repositories.pool.query('SELECT * FROM payroll_rules WHERE id=$1 AND venue_id=$2 AND active=true LIMIT 1', [ruleId, venueDbId]),
      ]);
      if (!userResult.rows[0]) return json(res, 404, { error: 'payroll_user_not_found' });
      const rule = ruleResult.rows[0]; if (!rule) return json(res, 404, { error: 'payroll_rule_not_found' });
      const timeResult = await repositories.pool.query(`WITH tz AS (SELECT COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg') AS name FROM venues v LEFT JOIN organizations org ON org.id=v.organization_id WHERE v.id=$1), bounds AS (SELECT ($3::date::timestamp AT TIME ZONE name) starts_at, (($4::date+1)::timestamp AT TIME ZONE name) ends_at, name FROM tz), clipped AS (SELECT GREATEST(w.started_at,b.starts_at) starts_at,LEAST(COALESCE(w.ended_at,now()),b.ends_at) ends_at,(w.started_at AT TIME ZONE b.name)::date shift_date,(w.started_at >= b.starts_at AND w.started_at < b.ends_at) is_shift_start FROM bounds b JOIN staff_work_logs w ON w.venue_id=$1 AND w.user_id=$2 AND w.started_at < b.ends_at AND COALESCE(w.ended_at,now()) > b.starts_at), ordered AS (SELECT *,MAX(ends_at) OVER (ORDER BY starts_at,ends_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous_end FROM clipped), merged AS (SELECT *,GREATEST(starts_at,COALESCE(previous_end,starts_at)) effective_start FROM ordered) SELECT COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (ends_at-effective_start))/3600)),0) AS hours,COUNT(DISTINCT shift_date) FILTER (WHERE is_shift_start)::int AS shifts FROM merged`, [venueDbId,userId,periodFrom,periodTo]);
      const hours = Number(timeResult.rows[0]?.hours || 0); const shifts = Number(timeResult.rows[0]?.shifts || 0); let revenue = 0;
      if (rule.rule_type === 'percent_revenue') {
        const sales = await repositories.pool.query(`SELECT COALESCE(SUM(p.amount),0) AS revenue FROM orders o JOIN payments p ON p.order_id=o.id JOIN venues v ON v.id=o.venue_id LEFT JOIN organizations org ON org.id=v.organization_id WHERE o.venue_id=$1 AND o.opened_by=$2 AND o.status='closed' AND o.closed_at >= ($3::date::timestamp AT TIME ZONE COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg')) AND o.closed_at < (($4::date+1)::timestamp AT TIME ZONE COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg')) AND p.status IN ('paid','partially_paid')`, [venueDbId,userId,periodFrom,periodTo]);
        revenue = Number(sales.rows[0]?.revenue || 0);
      }
      const amount = calculatePayrollAmount({ ruleType: rule.rule_type, rate: rule.rate, hours, shifts, revenue, periodFrom, periodTo });
      if (amount === null) return json(res, 400, { error: 'invalid_payroll_rule' });
      const { rows } = await repositories.pool.query(`INSERT INTO payroll_entries (venue_id,user_id,rule_id,period_from,period_to,amount,status) VALUES ($1,$2,$3,$4,$5,$6,'draft') ON CONFLICT (venue_id,user_id,period_from,period_to,rule_id) DO UPDATE SET amount=EXCLUDED.amount WHERE payroll_entries.status='draft' RETURNING *`, [venueDbId,userId,ruleId,periodFrom,periodTo,amount]);
      if (!rows[0]) return json(res, 409, { error: 'payroll_entry_not_editable' });
      const entry = rows[0]; recordAudit(req, 'payroll.entry_drafted', 'payroll_entry', entry.id, null, { ...entry, hours });
      return json(res, 201, { ...entry, amount: Number(entry.amount), hours: Number(hours.toFixed(2)), expenseId: entry.expense_id || null });
    } catch (error) { return json(res, 409, { error: 'payroll_entry_save_failed', detail: error.message }); }
  }
  if (payrollEntryPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'finance')) return;
    if (!repositories?.pool) return json(res, 503, { error: 'payroll_requires_database' });
    const id = decodeURIComponent(payrollEntryPath[1]); if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'invalid_payroll_entry_id' });
    const input = await body(req); const action = String(input.action || '');
    if (!['approve','pay','cancel'].includes(action)) return json(res, 400, { error: 'invalid_payroll_action' });
    const paymentDate = String(input.paymentDate || today()); const reason = String(input.reason || '').trim();
    if (action === 'pay' && !isValidIsoDate(paymentDate)) return json(res, 400, { error: 'invalid_payroll_payment_date' });
    if (action === 'cancel' && (reason.length < 3 || reason.length > 500)) return json(res, 400, { error: 'payroll_cancellation_reason_required' });
    let client; let before;
    try {
      client = await repositories.pool.connect(); await client.query('BEGIN');
      const locked = await client.query("SELECT *, to_char(period_from,'DD.MM.YYYY') AS period_from_label, to_char(period_to,'DD.MM.YYYY') AS period_to_label FROM payroll_entries WHERE id=$1 AND venue_id=$2 FOR UPDATE", [id, venueDbId]); before = locked.rows[0];
      if (!before) { await client.query('ROLLBACK'); return json(res, 404, { error: 'payroll_entry_not_found' }); }
      if (!canTransitionPayroll(before.status, action)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'payroll_transition_not_allowed', status: before.status, action }); }
      const findPayrollPeriodOverlap = async () => {
        // Serialize approve/pay transitions for one employee and rule so two
        // overlapping entries cannot be approved or paid at the same time.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('territory_crm_payroll_period'),hashtext($1::text || ':' || $2::text || ':' || $3::text))", [venueDbId, before.user_id, before.rule_id]);
        return client.query(`SELECT id FROM payroll_entries
          WHERE venue_id=$1 AND user_id=$2 AND rule_id=$3 AND id<>$4
            AND status IN ('approved','paid')
            AND period_from <= $6::date AND period_to >= $5::date
          LIMIT 1`, [venueDbId, before.user_id, before.rule_id, id, before.period_from, before.period_to]);
      };
      let updated;
      if (action === 'approve') {
        const overlap = await findPayrollPeriodOverlap();
        if (overlap.rows[0]) {
          await client.query('ROLLBACK');
          return json(res, 409, { error: 'payroll_period_overlap', conflictingEntryId: overlap.rows[0].id });
        }
        const { rows } = await client.query("UPDATE payroll_entries SET status='approved',approved_at=now(),approved_by=$3 WHERE id=$1 AND venue_id=$2 RETURNING *", [id,venueDbId,/^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]); updated = rows[0];
      } else if (action === 'cancel') {
        const { rows } = await client.query("UPDATE payroll_entries SET status='cancelled',cancelled_at=now(),cancelled_by=$3,cancellation_reason=$4 WHERE id=$1 AND venue_id=$2 RETURNING *", [id,venueDbId,/^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null,reason]); updated = rows[0];
      } else {
        const overlap = await findPayrollPeriodOverlap();
        if (overlap.rows[0]) {
          await client.query('ROLLBACK');
          return json(res, 409, { error: 'payroll_period_overlap', conflictingEntryId: overlap.rows[0].id });
        }
        const description = `Выплата зарплаты за ${before.period_from_label} — ${before.period_to_label}`;
        let expenseId = before.expense_id;
        if (expenseId) {
          const { rows } = await client.query("UPDATE expenses SET category='Зарплата',amount=$1,expense_date=$2,description=$3,source='payroll',created_by=COALESCE($4,created_by) WHERE id=$5 AND venue_id=$6 RETURNING id", [before.amount,paymentDate,description,/^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null,expenseId,venueDbId]);
          if (!rows[0]) return await client.query('ROLLBACK').then(() => json(res, 409, { error: 'payroll_expense_link_invalid' }));
          expenseId = rows[0].id;
        } else {
          const { rows } = await client.query("INSERT INTO expenses (venue_id,category,amount,expense_date,description,source,created_by) VALUES ($1,'Зарплата',$2,$3,$4,'payroll',$5) RETURNING id", [venueDbId,before.amount,paymentDate,description,/^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]); expenseId = rows[0].id;
        }
        const { rows } = await client.query("UPDATE payroll_entries SET status='paid',paid_at=now(),paid_by=$3,payment_date=$4,expense_id=$5 WHERE id=$1 AND venue_id=$2 RETURNING *", [id,venueDbId,/^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null,paymentDate,expenseId]); updated = rows[0];
      }
      await client.query('COMMIT');
      recordAudit(req, `payroll.entry_${action === 'pay' ? 'paid' : action === 'approve' ? 'approved' : 'cancelled'}`, 'payroll_entry', id, before, updated);
      return json(res, 200, { ...updated, amount: Number(updated.amount), expenseId: updated.expense_id || null });
    } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'payroll_entry_transition_failed', detail: error.message }); }
    finally { client?.release(); }
  }
  if (pathname === '/api/inventory/auto-orders' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['inventory', 'inventory_read'])) return;
    const buildSuggestions = (items) => items.filter((item) => Number(item.minLevel || 0) > 0 && Number(item.onHand || 0) <= Number(item.minLevel || 0)).map((item) => {
      const onHand = Number(item.onHand || 0); const minLevel = Number(item.minLevel || 0); const packMultiplier = Math.max(0.000001, Number(item.packMultiplier || 1));
      const targetLevel = Math.max(minLevel * 2, minLevel + packMultiplier); const shortage = Math.max(0, targetLevel - onHand); const orderQuantity = Math.ceil(shortage / packMultiplier) * packMultiplier;
      return { id: item.id, name: item.name, department: item.department, subdepartment: item.subdepartment, category: item.category, unit: item.unit, purchaseUnit: item.purchaseUnit || item.unit, packMultiplier, supplier: item.supplier || null, cost: Number(item.cost || 0), onHand, minLevel, targetLevel: Number(targetLevel.toFixed(6)), shortage: Number(shortage.toFixed(6)), orderQuantity: Number(orderQuantity.toFixed(6)), estimate: Number((orderQuantity * Number(item.cost || 0)).toFixed(2)) };
    });
    if (repositories?.inventory) {
      try {
        const data = await repositories.inventory.list(venueDbId);
        const { rows } = await repositories.pool.query(`SELECT id,status,lines,note,total_estimate AS "totalEstimate",created_at AS "createdAt",sent_at AS "sentAt",updated_at AS "updatedAt" FROM inventory_auto_orders WHERE venue_id=$1 ORDER BY created_at DESC LIMIT 20`, [venueDbId]);
        return json(res, 200, { items: buildSuggestions(data.items), requests: rows.map((row) => ({ ...row, totalEstimate: Number(row.totalEstimate || 0), lines: Array.isArray(row.lines) ? row.lines.map((line) => ({ ...line, quantity: Number(line.quantity || 0), receivedQuantity: Number(line.receivedQuantity || 0) })) : [] })) });
      } catch (error) { return json(res, 503, { error: 'auto_orders_unavailable', detail: error.message }); }
    }
    const suggestions = buildSuggestions(inventory); return json(res, 200, { items: suggestions, requests: autoOrderRequests.slice().reverse().slice(0, 20).map((request) => ({ ...request, lines: Array.isArray(request.lines) ? request.lines.map((line) => ({ ...line, quantity: Number(line.quantity || 0), receivedQuantity: Number(line.receivedQuantity || 0) })) : [] })) });
  }
  if (pathname === '/api/inventory/auto-orders' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const rawItems = Array.isArray(input.items) ? input.items.slice(0, 100) : [];
    if (!rawItems.length) return json(res, 400, { error: 'auto_order_items_required' });
    const requestedLines = rawItems.map((line) => ({ itemId: String(line.itemId || '').trim(), quantity: Number(line.quantity) })).filter((line) => line.itemId && Number.isFinite(line.quantity) && line.quantity > 0);
    if (!requestedLines.length || requestedLines.length !== rawItems.length) return json(res, 400, { error: 'invalid_auto_order_lines' });
    const current = repositories?.inventory ? (await repositories.inventory.list(venueDbId)).items : inventory;
    const lines = requestedLines.map((line) => { const item = current.find((entry) => entry.id === line.itemId); if (!item) return null; const pack = Math.max(0.000001, Number(item.packMultiplier || 1)); const quantity = Math.ceil(line.quantity / pack) * pack; return { itemId: item.id, name: item.name, quantity: Number(quantity.toFixed(6)), receivedQuantity: 0, unit: item.unit, purchaseUnit: item.purchaseUnit || item.unit, packMultiplier: Number(item.packMultiplier || 1), supplier: item.supplier || null, unitCost: Number(item.cost || 0), estimate: Number((quantity * Number(item.cost || 0)).toFixed(2)) }; });
    if (lines.some((line) => !line)) return json(res, 400, { error: 'auto_order_item_not_found' });
    const totalEstimate = Number(lines.reduce((sum, line) => sum + line.estimate, 0).toFixed(2)); const note = String(input.note || '').trim().slice(0, 500) || null;
    if (repositories?.pool) {
      try {
        const requestedBy = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null;
        const { rows } = await repositories.pool.query(`INSERT INTO inventory_auto_orders (venue_id,status,lines,note,total_estimate,requested_by,sent_at) VALUES ($1,'sent',$2::jsonb,$3,$4,$5,now()) RETURNING id,status,lines,note,total_estimate AS "totalEstimate",created_at AS "createdAt",sent_at AS "sentAt",updated_at AS "updatedAt"`, [venueDbId, JSON.stringify(lines), note, totalEstimate, requestedBy]);
        recordAudit(req, 'inventory.auto_order_sent', 'inventory_auto_order', rows[0].id, null, rows[0]); return json(res, 201, { ...rows[0], totalEstimate: Number(rows[0].totalEstimate || 0), lines: rows[0].lines || [] });
      } catch (error) { return json(res, 409, { error: 'auto_order_save_failed', detail: error.message }); }
    }
    const request = { id: `auto-order-${crypto.randomUUID()}`, venueId: notificationVenueScope(req, venueDbId), status: 'sent', lines, note, totalEstimate, createdAt: new Date().toISOString(), sentAt: new Date().toISOString() }; autoOrderRequests.push(request); recordAudit(req, 'inventory.auto_order_sent', 'inventory_auto_order', request.id, null, request); return json(res, 201, request);
  }
  const autoOrderPath = pathname.match(/^\/api\/inventory\/auto-orders\/([^/]+)$/);
  if (autoOrderPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req);
    if (input.status === 'received' || input.status === 'partially_received' || Array.isArray(input.receipts)) {
      return json(res, 409, { error: 'purchase_document_required' });
    }
    if (input.status !== 'cancelled') return json(res, 400, { error: 'invalid_auto_order_status' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(autoOrderPath[1])) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query('SELECT id,status,lines FROM inventory_auto_orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [autoOrderPath[1], venueDbId]);
        if (!current.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'auto_order_not_found' }); }
        if (!['sent', 'partially_received'].includes(current.rows[0].status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'auto_order_not_cancellable' }); }
        const drafts = await client.query("SELECT EXISTS(SELECT 1 FROM inventory_purchase_documents WHERE source_auto_order_id=$1 AND venue_id=$2 AND status='draft') AS has_drafts", [autoOrderPath[1], venueDbId]);
        if (drafts.rows[0]?.has_drafts) { await client.query('ROLLBACK'); return json(res, 409, { error: 'auto_order_has_draft_receipts' }); }
        const { rows } = await client.query(`UPDATE inventory_auto_orders SET status='cancelled',updated_at=now() WHERE id=$1 AND venue_id=$2 RETURNING id,status,lines,note,total_estimate AS "totalEstimate",created_at AS "createdAt",sent_at AS "sentAt",updated_at AS "updatedAt"`, [autoOrderPath[1], venueDbId]);
        await client.query('COMMIT');
        recordAudit(req, 'inventory.auto_order_cancelled', 'inventory_auto_order', rows[0].id, null, rows[0]);
        return json(res, 200, { ...rows[0], totalEstimate: Number(rows[0].totalEstimate || 0), lines: rows[0].lines || [] });
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'auto_order_status_save_failed', detail: error.message }); } finally { client.release(); }
    }
    const request = autoOrderRequests.find((entry) => entry.id === autoOrderPath[1]);
    if (!request) return json(res, 404, { error: 'auto_order_not_found' });
    if (!['sent', 'partially_received'].includes(request.status)) return json(res, 409, { error: 'auto_order_not_cancellable' });
    request.status = 'cancelled'; request.updatedAt = new Date().toISOString();
    recordAudit(req, 'inventory.auto_order_cancelled', 'inventory_auto_order', request.id, null, request);
    return json(res, 200, request);
  }
  const inventoryItemPath = pathname.match(/^\/api\/inventory\/items\/([^/]+)$/);
  const validateInventoryHierarchy = async (department, subdepartment, client = repositories?.pool) => {
    if (!repositories?.pool) return null;
    const departmentCode = String(department || '').trim(); const subdepartmentName = String(subdepartment || '').trim();
    try {
      const departmentResult = await client.query('SELECT 1 FROM inventory_departments WHERE venue_id=$1 AND code=$2 AND is_active=true FOR SHARE', [venueDbId, departmentCode]);
      if (!departmentResult.rows[0]) return 'inventory_department_not_found';
      if (subdepartmentName) {
        const subdepartmentResult = await client.query('SELECT 1 FROM inventory_subdepartments WHERE venue_id=$1 AND department_code=$2 AND name=$3 AND is_active=true FOR SHARE', [venueDbId, departmentCode, subdepartmentName]);
        if (!subdepartmentResult.rows[0]) return 'inventory_subdepartment_not_found';
      }
      return null;
    } catch (error) { if (error?.code === '42P01') return 'inventory_hierarchy_unavailable'; throw error; }
  };
  const validateInventoryCategorySubdepartment = async (department, subdepartment, categoryName, client = repositories?.pool) => {
    if (!repositories?.pool || !String(categoryName || '').trim()) return null;
    try {
      const result = await client.query(`SELECT c.department,s.name AS "subdepartmentName" FROM product_categories c
        LEFT JOIN inventory_subdepartments s ON s.id=c.subdepartment_id AND s.venue_id=c.venue_id
        WHERE c.venue_id=$1 AND lower(btrim(c.name))=lower(btrim($2)) AND c.is_active=true FOR SHARE OF c`, [venueDbId, String(categoryName).trim()]);
      const rows = result.rows;
      const selected = rows.find((row) => row.department === String(department || '').trim());
      if (!selected && rows.length) return 'inventory_category_department_mismatch';
      if (String(categoryName).trim() !== 'Без категории' && !selected) return 'inventory_category_not_found';
      const requiredSubdepartment = selected?.subdepartmentName;
      if (requiredSubdepartment && String(subdepartment || '').trim() !== requiredSubdepartment) return 'inventory_category_subdepartment_mismatch';
      return null;
    } catch (error) { if (error?.code === '42P01' || error?.code === '42703') return 'inventory_hierarchy_unavailable'; throw error; }
  };
  const resolveInventoryCategoryId = async (categoryId, department, subdepartment, categoryName, client) => {
    const name = String(categoryName || '').trim();
    if (!categoryId && (!name || name === 'Без категории')) return null;
    const result = await client.query(`SELECT c.id,s.name AS "subdepartmentName" FROM product_categories c
      LEFT JOIN inventory_subdepartments s ON s.venue_id=c.venue_id AND s.id=c.subdepartment_id
      WHERE c.venue_id=$1 AND c.department=$2 AND c.is_active=true
        AND (($3::uuid IS NOT NULL AND c.id=$3::uuid) OR ($3::uuid IS NULL AND lower(btrim(c.name))=lower(btrim($4))))
      FOR SHARE OF c`, [venueDbId, String(department || '').trim(), categoryId || null, name]);
    if (categoryId && !result.rows.length) throw new Error('inventory_category_not_found');
    if (result.rows.length > 1) throw new Error('inventory_category_ambiguous');
    const selected = result.rows[0];
    if (selected?.subdepartmentName && String(subdepartment || '').trim() !== selected.subdepartmentName) throw new Error('inventory_category_subdepartment_mismatch');
    return selected?.id || null;
  };
  const validateTobaccoCatalogLink = async (value) => {
    if (value === undefined || value === null || value === '') return null;
    if (!repositories?.pool) return null;
    const result = await repositories.pool.query(`SELECT 1 FROM tobacco_catalog_items
      WHERE organization_id=$1 AND id=$2 AND is_active=true AND (scope='organization' OR venue_id=$3)`, [requestOrganizationId(req), value, venueDbId]);
    return result.rows[0] ? null : 'tobacco_catalog_item_not_found_or_inactive';
  };
  const validateAlcoholCatalogLink = async (value, inventoryId = null) => {
    if (value === undefined || value === null || value === '') return null;
    const id=String(value);
    if (repositories?.alcoholCatalog) {
      const item=await repositories.alcoholCatalog.get(requestOrganizationId(req),venueDbId,id);
      if (item?.active) return null;
      if (inventoryId && item) { const linked=await repositories.pool.query('SELECT alcohol_catalog_item_id AS id FROM ingredients WHERE id=$1 AND venue_id=$2 AND is_marked=true',[inventoryId,venueDbId]); if(String(linked.rows[0]?.id||'')===id) return null; }
      return 'alcohol_catalog_item_not_found_or_inactive';
    }
    const item=alcoholCatalogItems.find(entry=>entry.id===id&&entry.organizationId===alcoholCatalogOrganizationId&&(entry.scope==='organization'||entry.venueId===alcoholCatalogVenueId));
    if (item?.active) return null;
    if (inventoryId && item && String(inventory.find(entry=>String(entry.id)===String(inventoryId))?.alcoholCatalogItemId||'')===id) return null;
    return 'alcohol_catalog_item_not_found_or_inactive';
  };
  const withInventoryHierarchyTransaction = async (department, subdepartment, categoryName, write, categoryId = null) => {
    const client = await repositories.pool.connect();
    try {
      await client.query('BEGIN');
      const hierarchyError = await validateInventoryHierarchy(department, subdepartment, client);
      if (hierarchyError) { await client.query('ROLLBACK'); return { error: hierarchyError }; }
      const categoryError = await validateInventoryCategorySubdepartment(department, subdepartment, categoryName, client);
      if (categoryError) { await client.query('ROLLBACK'); return { error: categoryError }; }
      const resolvedCategoryId = await resolveInventoryCategoryId(categoryId, department, subdepartment, categoryName, client);
      const value = await write(client, resolvedCategoryId);
      await client.query('COMMIT');
      return { value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };
  if (pathname === '/api/inventory/items' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req);
    const name = String(input.name || '').trim();
    const allowedUnits = ['шт', 'г', 'кг', 'мл', 'л', 'порция', 'уп', 'упаковка'];
    const itemType = String(input.itemType || 'ingredient');
    const department = String(input.department || 'inventory').trim();
    const unit = String(input.unit || '').trim();
    const purchaseCost = input.purchaseCost === undefined || input.purchaseCost === null || input.purchaseCost === '' ? null : Number(input.purchaseCost); const cost = Number(input.cost || 0); const minLevel = Number(input.minLevel || 0); const packMultiplier = Number(input.packMultiplier ?? 1); const calculatedCost = purchaseCost === null ? cost : Number((purchaseCost / packMultiplier).toFixed(4));
    if (!name || name.length > 120) return json(res, 400, { error: 'invalid_inventory_item_name' });
    if (!allowedUnits.includes(unit) || !['ingredient', 'product', 'consumable', 'equipment'].includes(itemType)) return json(res, 400, { error: 'invalid_inventory_item_measurement' });
    if (!Number.isFinite(cost) || cost < 0 || (purchaseCost !== null && (!Number.isFinite(purchaseCost) || purchaseCost < 0)) || !Number.isFinite(calculatedCost) || calculatedCost < 0 || !Number.isFinite(minLevel) || minLevel < 0 || !Number.isFinite(packMultiplier) || packMultiplier <= 0) return json(res, 400, { error: 'invalid_inventory_item_numbers' });
    if (String(input.subdepartment || '').length > 80 || String(input.category || '').length > 80 || String(input.supplier || '').length > 160 || String(input.barcode || '').length > 64 || String(input.note || '').length > 500) return json(res, 400, { error: 'inventory_item_field_too_long' });
    if (input.categoryId !== undefined && input.categoryId !== null && !/^[0-9a-f-]{36}$/i.test(String(input.categoryId))) return json(res,400,{error:'invalid_inventory_category_id'});
    if (input.alcoholCatalogItemId !== undefined && input.alcoholCatalogItemId !== null && typeof input.alcoholCatalogItemId !== 'string') return json(res,400,{error:'invalid_alcohol_catalog_item_id'});
    const alcoholLinkError=await validateAlcoholCatalogLink(input.alcoholCatalogItemId); if(alcoholLinkError) return json(res,400,{error:alcoholLinkError});
    if (input.tobaccoCatalogItemId !== undefined && input.tobaccoCatalogItemId !== null && typeof input.tobaccoCatalogItemId !== 'string') return json(res,400,{error:'invalid_tobacco_catalog_item_id'});
    const tobaccoLinkError=await validateTobaccoCatalogLink(input.tobaccoCatalogItemId); if(tobaccoLinkError) return json(res,400,{error:tobaccoLinkError});
    const clean = { name, shortName: String(input.shortName || '').trim().slice(0, 80) || null, department, subdepartment: String(input.subdepartment || '').trim().slice(0, 80), category: String(input.category || 'Без категории').trim().slice(0, 80) || 'Без категории', categoryId: input.categoryId || null, tobaccoCatalogItemId: input.tobaccoCatalogItemId || null, itemType, unit, purchaseUnit: String(input.purchaseUnit || '').trim().slice(0, 30) || null, packMultiplier, cost: calculatedCost, minLevel, supplier: String(input.supplier || '').trim().slice(0, 160) || null, barcode: String(input.barcode || '').trim().slice(0, 64) || null, note: String(input.note || '').trim().slice(0, 500) || null, alcoholCatalogItemId: input.alcoholCatalogItemId || null };
    if (repositories?.inventory) { try { const result = repositories?.pool ? await withInventoryHierarchyTransaction(department, clean.subdepartment, clean.category, (client, categoryId) => repositories.inventory.create(venueDbId, { ...clean, categoryId }, client), clean.categoryId) : { value: await repositories.inventory.create(venueDbId, clean) }; if (result.error) return json(res, result.error === 'inventory_hierarchy_unavailable' ? 503 : 400, { error: result.error }); const item = result.value; recordAudit(req, 'inventory.item_created', 'inventory', item.id, null, item); return json(res, 201, { ...item, onHand: 0 }); } catch (error) { const validationErrors = new Set(['inventory_category_not_found','inventory_category_ambiguous','inventory_category_subdepartment_mismatch']); if (validationErrors.has(error.message)) return json(res,400,{error:error.message}); return json(res, 409, { error: 'inventory_item_create_failed', detail: error.message }); } }
    const item = { id: `ing-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, ...clean, onHand: 0, active: true }; inventory.push(item); recordAudit(req, 'inventory.item_created', 'inventory', item.id, null, item); return json(res, 201, item);
  }
  if (inventoryItemPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req);
    const editableFields = ['name','shortName','department','subdepartment','category','categoryId','tobaccoCatalogItemId','itemType','unit','purchaseUnit','packMultiplier','purchaseCost','cost','minLevel','supplier','barcode','note','alcoholCatalogItemId'];
    if (!Object.keys(input).length || Object.keys(input).some((key) => !editableFields.includes(key))) return json(res, 400, { error: 'invalid_inventory_item_fields' });
    const allowedUnits = ['шт', 'г', 'кг', 'мл', 'л', 'порция', 'уп', 'упаковка'];
    if (input.name !== undefined && (!String(input.name).trim() || String(input.name).length > 120)) return json(res, 400, { error: 'invalid_inventory_item_name' });
    if (input.unit !== undefined && !allowedUnits.includes(String(input.unit))) return json(res, 400, { error: 'invalid_inventory_item_measurement' });
    if (input.itemType !== undefined && !['ingredient', 'product', 'consumable', 'equipment'].includes(String(input.itemType))) return json(res, 400, { error: 'invalid_inventory_item_measurement' });
    if (input.alcoholCatalogItemId !== undefined && input.alcoholCatalogItemId !== null && typeof input.alcoholCatalogItemId !== 'string') return json(res,400,{error:'invalid_alcohol_catalog_item_id'});
    if (input.categoryId !== undefined && input.categoryId !== null && !/^[0-9a-f-]{36}$/i.test(String(input.categoryId))) return json(res,400,{error:'invalid_inventory_category_id'});
    if (input.tobaccoCatalogItemId !== undefined && input.tobaccoCatalogItemId !== null && typeof input.tobaccoCatalogItemId !== 'string') return json(res,400,{error:'invalid_tobacco_catalog_item_id'});
    const tobaccoLinkError=await validateTobaccoCatalogLink(input.tobaccoCatalogItemId); if(tobaccoLinkError) return json(res,400,{error:tobaccoLinkError});
    const alcoholLinkError=await validateAlcoholCatalogLink(input.alcoholCatalogItemId,inventoryItemPath[1]); if(alcoholLinkError) return json(res,400,{error:alcoholLinkError});
    for (const key of ['cost', 'purchaseCost', 'minLevel', 'packMultiplier']) if (input[key] !== undefined && input[key] !== null && input[key] !== '' && (!Number.isFinite(Number(input[key])) || Number(input[key]) < (key === 'packMultiplier' ? 0.01 : 0))) return json(res, 400, { error: 'invalid_inventory_item_numbers' });
    if (repositories?.inventory) {
      try {
        let item;
        if (repositories?.pool) {
          const client = await repositories.pool.connect();
          try {
            await client.query('BEGIN');
            const current = await client.query('SELECT department,subdepartment,category,category_id AS "categoryId",pack_multiplier AS "packMultiplier",cost FROM ingredients WHERE id=$1 AND venue_id=$2 AND is_marked=true', [inventoryItemPath[1], venueDbId]);
            if (!current.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_item_not_found' }); }
            const observed = current.rows[0];
            const nextDepartment = input.department !== undefined ? input.department : observed.department;
            const nextSubdepartment = input.subdepartment !== undefined ? input.subdepartment : observed.subdepartment;
            const nextCategory = input.category !== undefined ? input.category : observed.category;
            const hierarchyError = await validateInventoryHierarchy(nextDepartment, nextSubdepartment, client);
            if (hierarchyError) { await client.query('ROLLBACK'); return json(res, hierarchyError === 'inventory_hierarchy_unavailable' ? 503 : 400, { error: hierarchyError }); }
            const categoryChanged = input.category !== undefined || input.department !== undefined || input.subdepartment !== undefined;
            const categoryError = categoryChanged ? await validateInventoryCategorySubdepartment(nextDepartment, nextSubdepartment, nextCategory, client) : null;
            if (categoryError) { await client.query('ROLLBACK'); return json(res, categoryError === 'inventory_hierarchy_unavailable' ? 503 : 400, { error: categoryError }); }
            const resolvedCategoryId = categoryChanged || input.categoryId !== undefined
              ? await resolveInventoryCategoryId(input.categoryId ?? null, nextDepartment, nextSubdepartment, nextCategory, client)
              : observed.categoryId;
            const locked = await client.query('SELECT department,subdepartment,category FROM ingredients WHERE id=$1 AND venue_id=$2 AND is_marked=true FOR UPDATE', [inventoryItemPath[1], venueDbId]);
            if (!locked.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'inventory_item_not_found' }); }
            if (locked.rows[0].department !== observed.department || locked.rows[0].subdepartment !== observed.subdepartment || locked.rows[0].category !== observed.category) { await client.query('ROLLBACK'); return json(res, 409, { error: 'inventory_item_changed_retry' }); }
            const normalizedInput = { ...input }; if (input.purchaseCost !== undefined && input.purchaseCost !== null && input.purchaseCost !== '') { const factor = Number(input.packMultiplier ?? observed.packMultiplier); normalizedInput.cost = Number((Number(input.purchaseCost) / factor).toFixed(4)); } delete normalizedInput.purchaseCost; item = await repositories.inventory.update(venueDbId, inventoryItemPath[1], { ...normalizedInput, ...(categoryChanged || input.categoryId !== undefined ? { categoryId: resolvedCategoryId } : {}) }, client);
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
          finally { client.release(); }
        } else { const normalizedInput = { ...input }; const current = inventory.find((entry) => entry.id === inventoryItemPath[1]); if (input.purchaseCost !== undefined && input.purchaseCost !== null && input.purchaseCost !== '') { const factor = Number(input.packMultiplier ?? current?.packMultiplier ?? 1); normalizedInput.cost = Number((Number(input.purchaseCost) / factor).toFixed(4)); } delete normalizedInput.purchaseCost; item = await repositories.inventory.update(venueDbId, inventoryItemPath[1], normalizedInput); }
        if (!item) return json(res, 404, { error: 'inventory_item_not_found' });
        recordAudit(req, 'inventory.item_updated', 'inventory', item.id, null, item);
        return json(res, 200, item);
      } catch (error) { const validationErrors = new Set(['inventory_category_not_found','inventory_category_ambiguous','inventory_category_subdepartment_mismatch']); if (validationErrors.has(error.message)) return json(res,400,{error:error.message}); return json(res, 409, { error: 'inventory_item_update_failed', detail: error.message }); }
    }
    const item = inventory.find((entry) => entry.id === inventoryItemPath[1]); if (!item) return json(res, 404, { error: 'inventory_item_not_found' }); if (input.unit !== undefined && input.unit !== item.unit && stockMovements.some((movement) => movement.itemId === item.id)) return json(res, 409, { error: 'inventory_unit_has_movements' }); const normalizedInput = { ...input }; if (input.purchaseCost !== undefined && input.purchaseCost !== null && input.purchaseCost !== '') { const factor = Number(input.packMultiplier ?? item.packMultiplier ?? 1); normalizedInput.cost = Number((Number(input.purchaseCost) / factor).toFixed(4)); } delete normalizedInput.purchaseCost; Object.assign(item, normalizedInput); recordAudit(req, 'inventory.item_updated', 'inventory', item.id, null, item); return json(res, 200, item);
  }
  if (inventoryItemPath && req.method === 'DELETE') {
    if (denyUnless(req, res, 'inventory')) return;
    if (repositories?.inventory) { try { const item = await repositories.inventory.archive(venueDbId, inventoryItemPath[1]); if (!item) return json(res, 404, { error: 'inventory_item_not_found' }); recordAudit(req, 'inventory.item_archived', 'inventory', item.id, item, null); return json(res, 200, item); } catch (error) { return json(res, 409, { error: error.code === 'inventory_item_has_stock' ? 'inventory_item_has_stock' : 'inventory_item_archive_failed', detail: error.message }); } }
    const index = inventory.findIndex((entry) => entry.id === inventoryItemPath[1]); if (index < 0) return json(res, 404, { error: 'inventory_item_not_found' }); if (inventory[index].onHand !== 0) return json(res, 409, { error: 'inventory_item_has_stock' }); const [item] = inventory.splice(index, 1); recordAudit(req, 'inventory.item_archived', 'inventory', item.id, item, null); return json(res, 200, item);
  }
  if (pathname === '/api/inventory' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'inventory') && !hasPermission(req, 'inventory_read')) return json(res, 403, { error: 'forbidden', permission: 'inventory' });
    if (repositories?.inventory) { try { const data = await repositories.inventory.list(venueDbId); return json(res, 200, { ...data, lowStock: data.items.filter(isBelowInventoryMinimum) }); } catch (_) { return json(res, 503, { error: 'inventory_unavailable' }); } }
    return json(res, 200, { items: inventory, lowStock: inventory.filter(isBelowInventoryMinimum), movements: stockMovements.slice(-20).reverse() });
  }
  if (pathname === '/api/inventory/supplies' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const quantity = Number(input.quantity); const unitCost = Number(input.unitCost);
    if (!input.itemId || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) return json(res, 400, { error: 'invalid_supply' });
    const reason = String(input.reason || `Поставка${input.supplier ? ` · ${input.supplier}` : ''}`).trim().slice(0, 200);
    const unitFactors = { г: { г: 1, кг: 0.001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: 0.001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };
    if (repositories?.inventory) {
      try {
        const current = await repositories.inventory.list(venueDbId); const item = current.items.find((entry) => entry.id === input.itemId); const sourceUnit = String(input.unit || item?.unit || ''); const conversionFactor = item && unitFactors[sourceUnit]?.[item.unit]; const converted = item && conversionFactor ? quantity * conversionFactor : quantity;
        if (!item || !conversionFactor || !Number.isFinite(converted) || converted <= 0) return json(res, 400, { error: 'invalid_supply_unit' });
        const movement = await repositories.inventory.receive({ venueId: venueDbId, ingredientId: item.id, stockUnit: item.unit, quantity: converted, conversionFactor, unitCost, reason, createdBy: /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null });
        recordAudit(req, 'inventory.supply_received', 'inventory', item.id, { onHand: movement.onHandBefore, cost: item.cost }, { onHand: movement.onHandAfter, cost: movement.weightedCost, movement });
        return json(res, 201, { ...movement, delta: converted, sourceUnit, unitCost });
      } catch (error) { return json(res, 409, { error: 'supply_save_failed', detail: error.message }); }
    }
    const item = inventory.find((entry) => entry.id === input.itemId); const sourceUnit = String(input.unit || item?.unit || ''); const conversionFactor = item && unitFactors[sourceUnit]?.[item.unit]; const converted = item && conversionFactor ? quantity * conversionFactor : quantity;
    if (!item || !conversionFactor || !Number.isFinite(converted) || converted <= 0) return json(res, 400, { error: 'invalid_supply_unit' }); const previousValue = Number(item.onHand || 0) * Number(item.cost || 0); const normalizedUnitCost = unitCost / conversionFactor; item.cost = Number(((previousValue + converted * normalizedUnitCost) / (Number(item.onHand || 0) + converted)).toFixed(4)); item.onHand = Number((Number(item.onHand || 0) + converted).toFixed(6)); const movement = { id: `mov-${Date.now()}`, itemId: item.id, itemName: item.name, delta: converted, unit: item.unit, sourceUnit, reason, createdAt: new Date().toISOString() }; stockMovements.push(movement); recordAudit(req, 'inventory.supply_received', 'inventory', item.id, null, { onHand: item.onHand, cost: item.cost, movement }); return json(res, 201, { ...movement, unitCost, weightedCost: item.cost });
  }
  const purchaseDocumentPath = pathname.match(/^\/api\/inventory\/purchase-documents\/([^/]+)$/);
  const purchaseDocumentPostPath = pathname.match(/^\/api\/inventory\/purchase-documents\/([^/]+)\/post$/);
  const purchaseDocumentVoidPath = pathname.match(/^\/api\/inventory\/purchase-documents\/([^/]+)\/void$/);
  const purchaseDocumentReversePath = pathname.match(/^\/api\/inventory\/purchase-documents\/([^/]+)\/reverse$/);
  if (purchaseDocumentReversePath && req.method === 'POST') {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!req.user) return json(res, 401, { error: 'authentication_required' });
    const permissions = effectivePermissions(req.user);
    if (!permissions.includes('inventory') || !permissions.includes('finance')) return json(res, 403, { error: 'purchase_document_reversal_permission_required' });
    if (!uuid.test(String(req.user.id || '')) || !uuid.test(String(req.user.venueId || '')) || !uuid.test(String(req.user.organizationId || '')) || !uuid.test(String(purchaseDocumentReversePath[1] || ''))) return json(res, 404, { error: 'purchase_document_not_found' });
    if (!sameOriginMutation(req)) return json(res, 403, { error: 'same_origin_required' });
    if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json(res, 415, { error: 'json_content_type_required' });
    if (!repositories?.purchaseDocuments || !repositories?.pool) return json(res, 503, { error: 'purchase_document_reversal_unavailable' });
    let input;
    try { input = await body(req); } catch (_) { return json(res, 400, { error: 'invalid_json_body' }); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['reason','idempotencyKey'].includes(key))) return json(res, 400, { error: 'invalid_purchase_document_reversal' });
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    const idempotencyKey = String(input.idempotencyKey || '').trim();
    if (reason.length < 3 || reason.length > 500 || !uuid.test(idempotencyKey)) return json(res, 400, { error: 'invalid_purchase_document_reversal' });
    try {
      const result = await repositories.purchaseDocuments.reverse({ venueId: req.user.venueId, organizationId: req.user.organizationId, documentId: purchaseDocumentReversePath[1], actorId: req.user.id, reason, idempotencyKey });
      return json(res, 200, result);
    } catch (error) {
      const statusByCode = {
        purchase_document_not_found: 404,
        purchase_document_not_reversible: 409,
        purchase_document_already_reversed: 409,
        purchase_document_reversal_idempotency_conflict: 409,
        purchase_document_reversal_policy_unavailable: 409,
        purchase_document_reversal_open_shift_required: 409,
        purchase_document_reversal_date_unavailable: 409,
        purchase_document_reversal_paid: 409,
        purchase_document_reversal_payment_coverage_unavailable: 409,
        purchase_document_reversal_snapshot_unavailable: 409,
        purchase_document_reversal_stock_changed: 409,
        purchase_document_reversal_valuation_changed: 409,
        purchase_document_reversal_auto_order_unavailable: 409,
        purchase_document_reversal_auto_order_changed: 409,
        purchase_document_reversal_actor_invalid: 404,
      };
      const code = statusByCode[error.message] ? error.message : 'purchase_document_reversal_failed';
      return json(res, statusByCode[code] || 503, { error: code });
    }
  }
  if (pathname === '/api/inventory/purchase-documents' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['inventory_read', 'inventory'])) return;
    if (!repositories?.purchaseDocuments) return json(res, 200, { items: [] });
    const readSingle = (name) => { const values = url.searchParams.getAll(name); return values.length === 1 ? values[0].trim() : values.length === 0 ? '' : null; };
    const status = readSingle('status');
    const documentDateFrom = readSingle('documentDateFrom');
    const documentDateTo = readSingle('documentDateTo');
    const undatedValue = readSingle('includeUndated');
    if (status === null || documentDateFrom === null || documentDateTo === null || undatedValue === null
      || status && !['draft', 'posted', 'voided'].includes(status)
      || documentDateFrom && !isValidIsoDate(documentDateFrom) || documentDateTo && !isValidIsoDate(documentDateTo)
      || documentDateFrom && documentDateTo && documentDateFrom > documentDateTo
      || undatedValue && !['true', 'false'].includes(undatedValue)) return json(res, 400, { error: 'invalid_purchase_filter' });
    const dateFilter = { documentDateFrom, documentDateTo, includeUndated: undatedValue === 'true' };
    try { return json(res, 200, { items: await repositories.purchaseDocuments.list(venueDbId, status || null, dateFilter) }); } catch (error) { return json(res, 503, { error: 'purchase_documents_unavailable', detail: error.message }); }
  }
  if (pathname === '/api/inventory/purchase-documents' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    if (!repositories?.purchaseDocuments) return json(res, 503, { error: 'purchase_documents_unavailable' });
    try {
      const input = normalizePurchaseInput(await body(req));
      const created = await repositories.purchaseDocuments.saveDraft({ ...input, venueId: venueDbId, createdBy: /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null });
      recordAudit(req, 'inventory.purchase_document_created', 'purchase_document', created.id, null, created);
      return json(res, 201, created);
    } catch (error) { return json(res, error.message === 'purchase_ingredient_not_found' ? 400 : error.message === 'invalid_purchase_unit' ? 400 : error.code === '23505' ? 409 : 400, { error: error.message === 'purchase_ingredient_not_found' ? 'purchase_ingredient_not_found' : error.message === 'invalid_purchase_unit' ? 'invalid_purchase_unit' : error.message === 'invalid_purchase_document' || error.message === 'invalid_purchase_line' || error.message === 'invalid_purchase_lines' || error.message === 'invalid_source_auto_order' ? error.message : 'purchase_document_create_failed', ingredientId: error.ingredientId, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit, detail: error.code === '23505' ? 'document_number_exists' : error.message }); }
  }
  if (purchaseDocumentPath && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['inventory_read', 'inventory'])) return;
    if (!repositories?.purchaseDocuments) return json(res, 404, { error: 'purchase_document_not_found' });
    try { const item = await repositories.purchaseDocuments.get(venueDbId, purchaseDocumentPath[1]); return item ? json(res, 200, item) : json(res, 404, { error: 'purchase_document_not_found' }); } catch (error) { return json(res, 503, { error: 'purchase_document_unavailable', detail: error.message }); }
  }
  if (purchaseDocumentPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'inventory')) return;
    if (!repositories?.purchaseDocuments) return json(res, 503, { error: 'purchase_documents_unavailable' });
    try {
      const input = normalizePurchaseInput(await body(req));
      const updated = await repositories.purchaseDocuments.updateDraft({ ...input, id: purchaseDocumentPath[1], venueId: venueDbId });
      recordAudit(req, 'inventory.purchase_document_updated', 'purchase_document', updated.id, null, updated);
      return json(res, 200, updated);
    } catch (error) { const status = error.message === 'purchase_document_not_found' ? 404 : error.message === 'purchase_document_not_draft' ? 409 : 400; return json(res, status, { error: ['purchase_document_not_found', 'purchase_document_not_draft', 'purchase_ingredient_not_found', 'invalid_purchase_unit', 'invalid_source_auto_order'].includes(error.message) ? error.message : 'purchase_document_update_failed', ingredientId: error.ingredientId, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit, detail: error.message }); }
  }
  if (purchaseDocumentVoidPath && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    if (!repositories?.purchaseDocuments) return json(res, 503, { error: 'purchase_documents_unavailable' });
    try {
      const cancelled = await repositories.purchaseDocuments.voidDraft(venueDbId, purchaseDocumentVoidPath[1]);
      recordAudit(req, 'inventory.purchase_document_voided', 'purchase_document', cancelled.id, null, cancelled);
      return json(res, 200, cancelled);
    } catch (error) {
      const status = error.message === 'purchase_document_not_found' ? 404 : error.message === 'purchase_document_not_voidable' ? 409 : 400;
      return json(res, status, { error: ['purchase_document_not_found', 'purchase_document_not_voidable'].includes(error.message) ? error.message : 'purchase_document_void_failed', status: error.status, detail: error.message });
    }
  }
  if (purchaseDocumentPostPath && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    if (!repositories?.purchaseDocuments) return json(res, 503, { error: 'purchase_documents_unavailable' });
    try {
      const result = await repositories.purchaseDocuments.post(venueDbId, purchaseDocumentPostPath[1], /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null);
      recordAudit(req, 'inventory.purchase_document_posted', 'purchase_document', result.document.id, { status: 'draft' }, result.document);
      return json(res, 200, result);
    } catch (error) { const status = ['purchase_document_not_found'].includes(error.message) ? 404 : ['purchase_document_not_postable', 'purchase_document_empty', 'purchase_ingredient_archived'].includes(error.message) ? 409 : 400; return json(res, status, { error: ['purchase_document_not_postable', 'purchase_document_empty', 'purchase_ingredient_archived', 'purchase_document_not_found'].includes(error.message) ? error.message : 'purchase_document_post_failed', status: error.status, detail: error.message, ingredientId: error.ingredientId }); }
  }
  if (pathname === '/api/inventory/premixes' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'inventory_read') && !hasPermission(req, 'inventory')) return json(res, 403, { error: 'forbidden', permission: 'inventory' });
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query(`SELECT b.id,b.recipe_id AS "recipeId",r.name AS "recipeName",b.output_ingredient_id AS "outputItemId",i.name AS "outputItemName",b.output_movement_id AS "outputMovementId",b.output_quantity AS "outputQuantity",b.planned_output_quantity AS "plannedOutputQuantity",GREATEST(0,b.output_quantity+COALESCE(SUM(m.quantity_delta),0)) AS "remainingQuantity",b.output_unit AS "outputUnit",b.total_cost AS "totalCost",b.ingredients,b.expires_at AS "expiresAt",(b.expires_at IS NOT NULL AND b.expires_at<=now()) AS expired,b.status,b.created_at AS "createdAt",b.produced_by AS "producedById",u.full_name AS "producedBy" FROM inventory_premix_batches b JOIN inventory_recipe_cards r ON r.id=b.recipe_id JOIN ingredients i ON i.id=b.output_ingredient_id LEFT JOIN inventory_premix_batch_movements m ON m.batch_id=b.id LEFT JOIN users u ON u.id=b.produced_by WHERE b.venue_id=$1 GROUP BY b.id,r.name,i.name,u.full_name ORDER BY b.created_at DESC LIMIT 100`, [venueDbId]); return json(res, 200, { items: rows.map((row) => ({ ...row, expired: Boolean(row.expired), outputQuantity: Number(row.outputQuantity), plannedOutputQuantity: Number(row.plannedOutputQuantity), remainingQuantity: Number(row.remainingQuantity), totalCost: Number(row.totalCost) })) }); } catch (error) { return json(res, 503, { error: 'premixes_unavailable', detail: error.message }); } }
    return json(res, 200, { items: stockMovements.filter((item) => item.type === 'premix').slice(-100).reverse().map((batch) => ({ ...batch, plannedOutputQuantity: Number(batch.plannedOutputQuantity ?? batch.outputQuantity), remainingQuantity: memoryPremixRemaining(batch), producedBy: batch.producedBy || null, expired: Boolean(batch.expiresAt && new Date(batch.expiresAt).getTime() <= Date.now()) })) });
  }
  const premixAction = pathname.match(/^\/api\/inventory\/premixes\/([^/]+)\/(waste|count|void)$/);
  if (premixAction && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const batchId = premixAction[1]; const action = premixAction[2]; const input = await body(req);
    const reason = String(input.reason || (action === 'waste' ? 'Списание порчи' : action === 'count' ? 'Инвентаризационная корректировка' : '')).trim();
    if (action !== 'void' && (!reason || reason.length > 200)) return json(res, 400, { error: 'premix_batch_reason_required' });
    if (!repositories?.pool) {
      const batch = stockMovements.find((entry) => entry.type === 'premix' && String(entry.id) === String(batchId)); if (!batch) return json(res, 404, { error: 'premix_batch_not_found' });
      const item = inventory.find((entry) => String(entry.id) === String(batch.outputItemId)); if (!item) return json(res, 404, { error: 'premix_output_item_not_found' });
      const remaining = memoryPremixRemaining(batch); const actor = req.user?.name || 'администратор';
      if (batch.status === 'voided') return json(res, 409, { error: 'premix_batch_not_active' });
      if (action === 'void') {
        const later = stockMovements.some((entry) => entry.type !== 'premix' && String(entry.itemId) === String(item.id) && new Date(entry.createdAt || 0) > new Date(batch.createdAt));
        if (!batch.outputMovementId || (batch.lotMovements || []).length || later || Math.abs(remaining - Number(batch.outputQuantity)) > 0.000001) return json(res, 409, { error: 'premix_batch_cannot_be_voided_after_stock_activity' });
        const components = (batch.ingredients || []).map((entry) => ({ entry, item: inventory.find((candidate) => String(candidate.id) === String(entry.ingredientId)) }));
        if (components.some(({ item: source }) => !source)) return json(res, 409, { error: 'premix_ingredient_not_found' });
        if (Number(item.onHand || 0) + 0.000001 < remaining) return json(res, 409, { error: 'insufficient_stock' });
        item.onHand = Number((Number(item.onHand) - remaining).toFixed(6)); item.cost = Number(batch.previousOutputCost || 0);
        for (const { entry, item: source } of components) { source.onHand = Number((Number(source.onHand || 0) + Number(entry.quantity)).toFixed(6)); stockMovements.push({ id: `mov-${Date.now()}-${Math.random()}`, itemId: source.id, itemName: source.name, direction: 'in', delta: Number(entry.quantity), quantity: Number(entry.quantity), reason: `Возврат сырья при отмене партии ${batchId}`, createdAt: new Date().toISOString() }); }
        batch.status = 'voided'; batch.voidReason = String(input.reason || 'Ошибка выпуска').slice(0, 200); batch.voidedBy = actor; batch.voidedAt = new Date().toISOString(); stockMovements.push({ id: `mov-${Date.now()}-${Math.random()}`, itemId: item.id, itemName: item.name, direction: 'out', delta: -remaining, quantity: remaining, reason: `Отмена выпуска партии ${batchId}`, createdAt: new Date().toISOString() });
      } else {
        let delta; if (action === 'waste') { const quantity = Number(input.quantity); if (!Number.isFinite(quantity) || quantity <= 0 || quantity > remaining) return json(res, 400, { error: 'invalid_premix_batch_quantity' }); delta = -quantity; } else { const actual = Number(input.actualQuantity); if (!Number.isFinite(actual) || actual < 0) return json(res, 400, { error: 'invalid_premix_batch_count' }); delta = actual - remaining; if (Math.abs(delta) < 0.000001) return json(res, 200, { id: batchId, remainingQuantity: remaining }); }
        if (Number(item.onHand || 0) + delta < -0.000001) return json(res, 409, { error: 'insufficient_stock' }); item.onHand = Number((Number(item.onHand || 0) + delta).toFixed(6)); batch.lotMovements ||= []; batch.lotMovements.push({ id: `premix-move-${Date.now()}`, type: action === 'waste' ? 'waste' : 'adjustment', quantityDelta: delta, reason, createdBy: actor, createdAt: new Date().toISOString() }); stockMovements.push({ id: `mov-${Date.now()}-${Math.random()}`, itemId: item.id, itemName: item.name, direction: delta < 0 ? (action === 'waste' ? 'waste' : 'out') : 'adjustment', delta, quantity: Math.abs(delta), reason, createdAt: new Date().toISOString() });
      }
      recordAudit(req, `inventory.premix_batch_${action}`, 'premix', batchId, { remainingQuantity: remaining }, { action, reason }); return json(res, 200, { id: batchId, status: batch.status || 'produced', remainingQuantity: action === 'void' ? 0 : memoryPremixRemaining(batch) });
    }
    let client;
    try {
      client = await repositories.pool.connect(); await client.query('BEGIN');
      const { rows: batchRows } = await client.query(`SELECT b.*,i.name AS output_name,i.unit AS output_stock_unit,i.cost AS output_cost
        FROM inventory_premix_batches b JOIN ingredients i ON i.id=b.output_ingredient_id
        WHERE b.id=$1 AND b.venue_id=$2 FOR UPDATE OF b,i`, [batchId, venueDbId]);
      const batch = batchRows[0]; if (!batch) { await client.query('ROLLBACK'); return json(res, 404, { error: 'premix_batch_not_found' }); }
      const balanceRows = await client.query('SELECT COALESCE(SUM(quantity_delta),0)::numeric AS delta FROM inventory_premix_batch_movements WHERE batch_id=$1', [batchId]);
      const remaining = Math.max(0, Number(batch.output_quantity) + Number(balanceRows.rows[0]?.delta || 0));
      const actorId = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null;
      if (batch.status !== 'produced') { await client.query('ROLLBACK'); return json(res, 409, { error: 'premix_batch_not_active' }); }
      if (action === 'void') {
        const hasLotEvents = await client.query('SELECT 1 FROM inventory_premix_batch_movements WHERE batch_id=$1 LIMIT 1', [batchId]);
        const hasLaterItemMovement = await client.query(`SELECT 1 FROM stock_movements sm
          WHERE sm.venue_id=$1 AND sm.ingredient_id=$2 AND sm.id<>$3
            AND sm.created_at >= (SELECT source.created_at FROM stock_movements source WHERE source.id=$3)
          LIMIT 1`, [venueDbId, batch.output_ingredient_id, batch.output_movement_id]);
        if (!batch.output_movement_id || hasLotEvents.rowCount || hasLaterItemMovement.rowCount || Math.abs(remaining - Number(batch.output_quantity)) > 0.000001) { await client.query('ROLLBACK'); return json(res, 409, { error: 'premix_batch_cannot_be_voided_after_stock_activity' }); }
        const { rows: reverseRows } = await client.query(`INSERT INTO stock_movements (venue_id,ingredient_id,direction,quantity,reason,created_by)
          VALUES ($1,$2,'out',$3,$4,$5) RETURNING id`, [venueDbId, batch.output_ingredient_id, Number(batch.output_quantity), `Отмена выпуска партии ${batchId}`, actorId]);
        await client.query(`INSERT INTO inventory_premix_batch_movements (venue_id,batch_id,stock_movement_id,movement_type,quantity_delta,reason,created_by)
          VALUES ($1,$2,$3,'reversal',$4,$5,$6)`, [venueDbId, batchId, reverseRows[0].id, -Number(batch.output_quantity), 'Отмена выпуска партии', actorId]);
        const components = Array.isArray(batch.ingredients) ? batch.ingredients : [];
        const componentIds = [...new Set(components.map((component) => String(component.ingredientId || '')).filter(Boolean))];
        const sourceRows = componentIds.length ? await client.query(`SELECT id FROM ingredients WHERE venue_id=$1 AND id=ANY($2::uuid[]) AND is_marked=true FOR UPDATE`, [venueDbId, componentIds]) : { rows: [] };
        if (!components.length || sourceRows.rowCount !== componentIds.length || components.some((component) => !component.ingredientId || !Number.isFinite(Number(component.quantity)) || Number(component.quantity) <= 0)) {
          throw new Error('premix_ingredient_not_found');
        }
        for (const component of components) {
          const { rows: restoredRows } = await client.query(`INSERT INTO stock_movements (venue_id,ingredient_id,direction,quantity,reason,created_by)
            SELECT $1,i.id,'in',$3,$4,$5 FROM ingredients i WHERE i.id=$2 AND i.venue_id=$1 AND i.is_marked=true RETURNING id`,
          [venueDbId, component.ingredientId, Number(component.quantity), `Возврат сырья при отмене партии ${batchId}`, actorId]);
          if (!restoredRows.length) throw new Error('premix_ingredient_not_found');
        }
        await client.query('UPDATE ingredients SET cost=$1 WHERE id=$2 AND venue_id=$3', [batch.previous_output_cost, batch.output_ingredient_id, venueDbId]);
        await client.query('UPDATE inventory_premix_batches SET status=\'voided\',voided_at=now(),voided_by=$1,void_reason=$2 WHERE id=$3 AND venue_id=$4', [actorId, String(input.reason || 'Ошибка выпуска').slice(0, 200), batchId, venueDbId]);
      } else {
        let delta; let movementDirection; let movementType;
        if (action === 'waste') {
          delta = -Number(input.quantity); movementDirection = 'waste'; movementType = 'waste';
          if (!Number.isFinite(-delta) || delta >= 0 || -delta > remaining || -delta <= 0) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_premix_batch_quantity', remainingQuantity: remaining }); }
        } else {
          const counted = Number(input.actualQuantity); delta = counted - remaining; movementDirection = delta >= 0 ? 'adjustment' : 'out'; movementType = 'adjustment';
          if (!Number.isFinite(counted) || counted < 0) { await client.query('ROLLBACK'); return json(res, 400, { error: 'invalid_premix_batch_count', remainingQuantity: remaining }); }
          if (Math.abs(delta) < 0.0000001) { await client.query('COMMIT'); return json(res, 200, { id: batchId, status: 'produced', remainingQuantity: remaining }); }
        }
        const { rows: movementRows } = await client.query(`INSERT INTO stock_movements (venue_id,ingredient_id,direction,quantity,reason,created_by)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [venueDbId, batch.output_ingredient_id, movementDirection, Math.abs(delta), reason, actorId]);
        await client.query(`INSERT INTO inventory_premix_batch_movements (venue_id,batch_id,stock_movement_id,movement_type,quantity_delta,reason,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [venueDbId, batchId, movementRows[0].id, movementType, delta, reason, actorId]);
      }
      await client.query('COMMIT');
      recordAudit(req, `inventory.premix_batch_${action}`, 'premix', batchId, { remainingQuantity: remaining }, { action, reason, quantity: input.quantity, actualQuantity: input.actualQuantity });
      return json(res, 200, { id: batchId, status: action === 'void' ? 'voided' : 'produced', remainingQuantity: action === 'void' ? 0 : action === 'count' ? Number(input.actualQuantity) : Number((remaining - Number(input.quantity)).toFixed(6)) });
    } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: error.message === 'insufficient_stock' ? 'insufficient_stock' : 'premix_batch_action_failed', detail: error.message }); }
    finally { client?.release(); }
  }
  if (pathname === '/api/inventory/premixes/produce' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req); const recipeId = String(input.recipeId || '').trim(); const outputItemId = String(input.outputItemId || '').trim(); const multiplier = Number(input.multiplier || 1);
    const requestedActualOutput = input.actualOutput === undefined || input.actualOutput === '' ? null : Number(input.actualOutput);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (!recipeId || !outputItemId || !Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1000 || (requestedActualOutput !== null && (!Number.isFinite(requestedActualOutput) || requestedActualOutput <= 0 || requestedActualOutput > 100000000)) || (input.expiresAt && (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()))) return json(res, 400, { error: 'invalid_premix_production' });
    const unitFactors = { г: { г: 1, кг: 0.001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: 0.001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };
    if (repositories?.pool) {
      let client;
      try {
        const recipeResult = await repositories.pool.query('SELECT id,name,ingredients,yield_quantity AS "yieldQuantity",yield_unit AS "yieldUnit" FROM inventory_recipe_cards WHERE id=$1 AND venue_id=$2 AND active=true AND recipe_type=\'premix\'', [recipeId, venueDbId]); const recipe = recipeResult.rows[0]; if (!recipe) return json(res, 404, { error: 'premix_recipe_not_found' });
        const outputResult = await repositories.pool.query('SELECT id,name,unit,cost FROM ingredients WHERE id=$1 AND venue_id=$2 AND is_marked=true', [outputItemId, venueDbId]); const output = outputResult.rows[0]; if (!output) return json(res, 404, { error: 'premix_output_item_not_found' });
        const stock = (await repositories.inventory.list(venueDbId)).items; const requirements = []; for (const entry of (recipe.ingredients || [])) { const item = stock.find((candidate) => String(candidate.id) === String(entry.ingredientId) || String(candidate.name).toLocaleLowerCase('ru-RU') === String(entry.name || '').toLocaleLowerCase('ru-RU')); if (!item) return json(res, 409, { error: 'premix_ingredient_not_found', ingredient: entry.name || entry.ingredientId }); const parsed = parseRecipeQuantity(entry.quantity, item.unit, entry.unit || null); if (parsed.error) return json(res, 409, { error: parsed.error, ingredient: item.name, sourceUnit: parsed.sourceUnit, targetUnit: parsed.targetUnit }); requirements.push({ item, quantity: Number((parsed.amount * parsed.factor * multiplier).toFixed(6)), unit: item.unit }); }
        const combinedRequirements = new Map(); for (const entry of requirements) { const key = String(entry.item.id); const previous = combinedRequirements.get(key); if (previous) previous.quantity += entry.quantity; else combinedRequirements.set(key, { ...entry }); } requirements.splice(0, requirements.length, ...combinedRequirements.values());
        const outputFactor = unitFactors[recipe.yieldUnit]?.[output.unit]; if (!outputFactor) return json(res, 409, { error: 'premix_output_unit_mismatch', sourceUnit: recipe.yieldUnit, targetUnit: output.unit }); const plannedOutputQuantity = Number((Number(recipe.yieldQuantity) * multiplier * outputFactor).toFixed(6)); const outputQuantity = Number(((requestedActualOutput ?? Number(recipe.yieldQuantity) * multiplier) * outputFactor).toFixed(6));
        if (requirements.some((entry) => String(entry.item.id) === String(output.id))) return json(res, 409, { error: 'premix_output_cannot_be_an_ingredient' });
        client = await repositories.pool.connect(); await client.query('BEGIN'); let totalCost = 0;
        const lockIds = [...new Set([...requirements.map((entry) => String(entry.item.id)), String(output.id)])].sort();
        const locked = await client.query('SELECT id,name,unit,cost FROM ingredients WHERE venue_id=$1 AND id=ANY($2::uuid[]) AND is_marked=true ORDER BY id FOR UPDATE', [venueDbId, lockIds]);
        const lockedById = new Map(locked.rows.map((row) => [String(row.id), row]));
        for (const requirement of requirements) {
          const row = lockedById.get(String(requirement.item.id));
          const stockResult = row ? await client.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS on_hand FROM stock_movements WHERE ingredient_id=$1 AND venue_id=$2", [requirement.item.id, venueDbId]) : { rows: [] };
          const onHand = Number(stockResult.rows[0]?.on_hand || 0);
          if (!row || onHand < requirement.quantity) { const error = new Error('insufficient_premix_stock'); error.missing = [{ name: requirement.item.name, required: requirement.quantity, onHand, unit: requirement.unit }]; throw error; }
          requirement.item = { ...row, onHand }; totalCost += requirement.quantity * Number(row.cost || 0);
        }
        const outputRow = lockedById.get(String(output.id));
        if (!outputRow) throw new Error('premix_output_item_not_found');
        const outputBalance = await client.query("SELECT COALESCE(SUM(CASE WHEN direction IN ('in','transfer','adjustment') THEN quantity WHEN direction IN ('out','waste') THEN -quantity ELSE 0 END),0)::numeric AS on_hand FROM stock_movements WHERE ingredient_id=$1 AND venue_id=$2", [output.id, venueDbId]);
        const previousOutputQuantity = Number(outputBalance.rows[0]?.on_hand || 0);
        for (const requirement of requirements) {
          const { rows: movementRows } = await client.query('INSERT INTO stock_movements (venue_id,ingredient_id,direction,quantity,reason,created_by) VALUES ($1,$2,\'out\',$3,$4,$5) RETURNING id', [venueDbId, requirement.item.id, requirement.quantity, `Приготовление премикса «${recipe.name}»`, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]);
          await allocatePremixBatchConsumption(client, { venueId: venueDbId, ingredientId: requirement.item.id, stockMovementId: movementRows[0].id, quantity: requirement.quantity, onHandBefore: Number(requirement.item.onHand || 0), createdBy: /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null, reason: `Приготовление премикса «${recipe.name}»` });
        }
        const { rows: outputMovementRows } = await client.query('INSERT INTO stock_movements (venue_id,ingredient_id,direction,quantity,reason,created_by) VALUES ($1,$2,\'in\',$3,$4,$5) RETURNING id', [venueDbId, output.id, outputQuantity, `Выход премикса «${recipe.name}»`, /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]);
        const nextOutputQuantity = previousOutputQuantity + outputQuantity;
        const batchUnitCost = outputQuantity > 0 ? totalCost / outputQuantity : 0;
        const nextOutputCost = nextOutputQuantity > 0 ? ((previousOutputQuantity * Number(outputRow.cost || 0)) + totalCost) / nextOutputQuantity : batchUnitCost;
        await client.query('UPDATE ingredients SET cost=$1 WHERE id=$2 AND venue_id=$3', [Number(nextOutputCost.toFixed(4)), output.id, venueDbId]);
        const { rows } = await client.query('INSERT INTO inventory_premix_batches (venue_id,recipe_id,output_ingredient_id,output_quantity,planned_output_quantity,previous_output_cost,output_movement_id,output_unit,total_cost,ingredients,produced_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING id,recipe_id AS "recipeId",output_ingredient_id AS "outputItemId",output_quantity AS "outputQuantity",planned_output_quantity AS "plannedOutputQuantity",output_unit AS "outputUnit",total_cost AS "totalCost",ingredients,expires_at AS "expiresAt",created_at AS "createdAt",produced_by AS "producedById"', [venueDbId, recipe.id, output.id, outputQuantity, plannedOutputQuantity, Number(outputRow.cost || 0), outputMovementRows[0].id, output.unit, Math.round(totalCost * 100) / 100, JSON.stringify(requirements.map((entry) => ({ ingredientId: entry.item.id, name: entry.item.name, quantity: entry.quantity, unit: entry.unit }))), /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null, expiresAt]); await client.query('COMMIT'); recordAudit(req, 'inventory.premix_produced', 'premix', rows[0].id, null, { ...rows[0], recipeName: recipe.name, outputItemName: output.name, batchUnitCost: Math.round(totalCost / outputQuantity * 100) / 100 }); return json(res, 201, { ...rows[0], recipeName: recipe.name, outputItemName: output.name, remainingQuantity: outputQuantity, producedBy: req.user?.name || null, batchUnitCost: Math.round(totalCost / outputQuantity * 100) / 100 });
      } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: ['insufficient_premix_stock','expired_premix_stock'].includes(error.message) ? error.message : 'premix_production_failed', missing: error.missing, detail: error.message }); } finally { client?.release(); }
    }
    const recipe = recipes.find((item) => item.id === recipeId && (item.recipeType || 'sale') === 'premix'); const output = inventory.find((item) => item.id === outputItemId); if (!recipe) return json(res, 404, { error: 'premix_recipe_not_found' }); if (!output) return json(res, 404, { error: 'premix_output_item_not_found' }); const requirements = []; let totalCost = 0; for (const entry of recipe.ingredients || []) { const item = inventory.find((candidate) => candidate.id === entry.ingredientId || String(candidate.name).toLocaleLowerCase('ru-RU') === String(entry.name || '').toLocaleLowerCase('ru-RU')); if (!item) return json(res, 409, { error: 'premix_ingredient_not_found', ingredient: entry.name || entry.ingredientId }); if (String(item.id) === String(output.id)) return json(res, 409, { error: 'premix_output_cannot_be_an_ingredient' }); const parsed = parseRecipeQuantity(entry.quantity, item.unit, entry.unit || null); if (parsed.error) return json(res, 409, { error: parsed.error, ingredient: item.name }); const quantity = Number((parsed.amount * parsed.factor * multiplier).toFixed(6)); requirements.push({ item, quantity, unit: item.unit }); } const combinedRequirements = new Map(); for (const entry of requirements) { const key = String(entry.item.id); const previous = combinedRequirements.get(key); if (previous) previous.quantity += entry.quantity; else combinedRequirements.set(key, { ...entry }); } requirements.splice(0, requirements.length, ...combinedRequirements.values()); for (const entry of requirements) { if (Number(entry.item.onHand || 0) < entry.quantity) return json(res, 409, { error: 'insufficient_premix_stock', missing: [{ name: entry.item.name, required: entry.quantity, onHand: Number(entry.item.onHand || 0), unit: entry.unit }] }); totalCost += entry.quantity * Number(entry.item.cost || 0); } const outputFactor = unitFactors[recipe.yieldUnit]?.[output.unit]; if (!outputFactor) return json(res, 409, { error: 'premix_output_unit_mismatch' }); const plannedOutputQuantity = Number((Number(recipe.yieldQuantity) * multiplier * outputFactor).toFixed(6)); const actualOutput = input.actualOutput === undefined || input.actualOutput === '' ? null : Number(input.actualOutput); if (actualOutput !== null && (!Number.isFinite(actualOutput) || actualOutput <= 0)) return json(res, 400, { error: 'invalid_premix_production' }); const outputQuantity = Number(((actualOutput ?? Number(recipe.yieldQuantity) * multiplier) * outputFactor).toFixed(6)); const batchExpiresAt = expiresAt ? expiresAt.toISOString() : null; const previousOutputCost = Number(output.cost || 0); const newOutputQuantity = Number(output.onHand || 0) + outputQuantity; const batchUnitCost = outputQuantity > 0 ? totalCost / outputQuantity : 0; output.cost = Number((newOutputQuantity > 0 ? ((Number(output.onHand || 0) * Number(output.cost || 0)) + totalCost) / newOutputQuantity : batchUnitCost).toFixed(4)); const sourceMovements = requirements.map((requirement) => ({ requirement, id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` })); for (const { requirement, id } of sourceMovements) { try { allocateMemoryPremixConsumption(requirement.item.id, requirement.quantity, Number(requirement.item.onHand || 0), id, `Приготовление премикса «${recipe.name}»`, { apply: false }); } catch (error) { return json(res, 409, { error: error.message }); } } for (const { requirement, id } of sourceMovements) { allocateMemoryPremixConsumption(requirement.item.id, requirement.quantity, Number(requirement.item.onHand || 0), id, `Приготовление премикса «${recipe.name}»`); requirement.item.onHand = Number((Number(requirement.item.onHand || 0) - requirement.quantity).toFixed(6)); stockMovements.push({ id, itemId: requirement.item.id, itemName: requirement.item.name, direction: 'out', delta: -requirement.quantity, quantity: requirement.quantity, reason: `Приготовление премикса «${recipe.name}»`, createdAt: new Date().toISOString() }); } output.onHand = Number(newOutputQuantity.toFixed(6)); const batch = { id: `premix-${Date.now()}`, recipeId, recipeName: recipe.name, outputItemId, outputItemName: output.name, outputQuantity, plannedOutputQuantity, previousOutputCost, expiresAt: batchExpiresAt, outputUnit: output.unit, totalCost: Math.round(totalCost * 100) / 100, batchUnitCost: Math.round(batchUnitCost * 100) / 100, producedBy: req.user?.name || 'администратор', ingredients: requirements.map(({ item, quantity, unit }) => ({ ingredientId: item.id, name: item.name, quantity, unit })), type: 'premix', status: 'produced', lotMovements: [], createdAt: new Date().toISOString() }; batch.outputMovementId = `premix-out-${batch.id}`; batch.outputMovementId = `premix-out-${batch.id}`; stockMovements.push(batch); recordAudit(req, 'inventory.premix_produced', 'premix', batch.id, null, batch); return json(res, 201, batch);
  }
  if (pathname === '/api/inventory/movements' && req.method === 'POST') {
    if (denyUnless(req, res, 'inventory')) return;
    const input = await body(req);
    if (input.reason !== undefined && String(input.reason).length > 200) return json(res, 400, { error: 'movement_reason_too_long' });
    input.reason = String(input.reason || 'Корректировка').trim().slice(0, 200);
    const unitFactors = { г: { г: 1, кг: 0.001 }, кг: { кг: 1, г: 1000 }, мл: { мл: 1, л: 0.001 }, л: { л: 1, мл: 1000 }, шт: { шт: 1 }, порция: { порция: 1 }, уп: { уп: 1 }, упаковка: { упаковка: 1 } };
    if (repositories?.inventory) {
      const current = await repositories.inventory.list(venueDbId); const item = current.items.find((entry) => entry.id === input.itemId); const delta = Number(input.delta);
      const sourceUnit = String(input.unit || item?.unit || ''); const conversionFactor = item && unitFactors[sourceUnit]?.[item.unit]; const convertedDelta = item && conversionFactor ? delta * conversionFactor : delta;
      if (!item || !conversionFactor || !Number.isFinite(delta) || delta === 0 || !Number.isFinite(convertedDelta)) return json(res, 400, { error: !conversionFactor ? 'invalid_movement_unit' : 'item_and_nonzero_delta_required' });
      let movement;
      try { movement = await repositories.inventory.move({ venueId: venueDbId, ingredientId: item.id, unit: item.unit, direction: convertedDelta > 0 ? 'in' : 'out', quantity: Math.abs(convertedDelta), reason: input.reason, createdBy: /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null }); }
      catch (error) { if (error.code === 'insufficient_stock') return json(res, 409, { error: 'insufficient_stock', onHand: error.onHand }); if (error.message === 'expired_premix_stock') return json(res, 409, { error: 'expired_premix_stock' }); if (error.message === 'inventory_unit_changed') return json(res, 409, { error: 'invalid_movement_unit' }); throw error; }
      recordAudit(req, 'inventory.movement', 'inventory', item.id, { onHand: movement.onHandBefore }, { onHand: movement.onHandAfter, movement });
      return json(res, 201, { ...movement, delta: convertedDelta, sourceUnit });
    }
    const item = inventory.find((entry) => entry.id === input.itemId);
    const delta = Number(input.delta); const sourceUnit = String(input.unit || item?.unit || ''); const conversionFactor = item && unitFactors[sourceUnit]?.[item.unit]; const convertedDelta = item && conversionFactor ? delta * conversionFactor : delta;
    if (!item || !conversionFactor || !Number.isFinite(delta) || delta === 0 || !Number.isFinite(convertedDelta)) return json(res, 400, { error: !conversionFactor ? 'invalid_movement_unit' : 'item_and_nonzero_delta_required' });
    if (item.onHand + convertedDelta < 0) return json(res, 409, { error: 'insufficient_stock', onHand: item.onHand });
    const movement = { id: `mov-${Date.now()}`, itemId: item.id, itemName: item.name, delta: convertedDelta, unit: item.unit, sourceUnit, reason: input.reason, createdAt: new Date().toISOString() };
    if (convertedDelta < 0) { try { allocateMemoryPremixConsumption(item.id, -convertedDelta, Number(item.onHand || 0), movement.id, input.reason || 'Списание'); } catch (error) { return json(res, 409, { error: error.message }); } }
    item.onHand = Number((item.onHand + convertedDelta).toFixed(6));
    stockMovements.push(movement);
    recordAudit(req, 'inventory.movement', 'inventory', item.id, { onHand: item.onHand - convertedDelta }, { onHand: item.onHand, movement });
    return json(res, 201, movement);
  }
  if (pathname === '/api/dashboard/shift-kpis' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'finance') && !hasPermission(req, 'finance_read')) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
    const employeeView = isOperationalEmployee(req);
    let timezone = businessTimezone;
    const requestedDate = url.searchParams.get('date') || '';
    const requestedShiftId = employeeView ? '' : (url.searchParams.get('shiftId') || '');
    if (repositories?.pool && requestedShiftId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedShiftId)) return json(res, 400, { error: 'invalid_shift_id' });
    let reportDate = requestedDate || today();
    if (repositories?.pool) {
      try {
        const venueRow = await repositories.pool.query('SELECT timezone FROM venues WHERE id=$1', [venueDbId]);
        timezone = String(venueRow.rows[0]?.timezone || timezone);
        try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); } catch (_) { timezone = businessTimezone; }
        const currentDate = await repositories.pool.query("SELECT (now() AT TIME ZONE $1)::date::text AS date", [timezone]);
        if (employeeView && !/^[0-9a-f-]{36}$/i.test(req.user?.id || '')) return json(res, 403, { error: 'employee_identity_required' });
        if (employeeView || !requestedDate) reportDate = currentDate.rows[0]?.date || reportDate;
        const dateTimestamp = Date.parse(`${reportDate}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !Number.isFinite(dateTimestamp) || new Date(dateTimestamp).toISOString().slice(0, 10) !== reportDate) return json(res, 400, { error: 'invalid_shift_kpi_date' });
        if (employeeView) {
          const employeeTotals = await repositories.pool.query(`
            SELECT COALESCE(payments.revenue,0) AS revenue, COALESCE(payments.payment_count,0)::int AS payment_count,
              COALESCE(payments.cash,0) AS cash, COALESCE(payments.cashless,0) AS cashless,
              COALESCE(payments.other,0) AS other, checks.closed_orders
            FROM (
              SELECT SUM(p.amount) FILTER (WHERE p.method<>'reservation' OR o.status='closed') AS revenue, COUNT(p.id)::int AS payment_count,
                SUM(p.amount) FILTER (WHERE p.method='cash') AS cash,
                SUM(p.amount) FILTER (WHERE p.method IN ('card','qr')) AS cashless,
                SUM(p.amount) FILTER (WHERE p.method NOT IN ('cash','card','qr') AND (p.method<>'reservation' OR o.status='closed')) AS other
              FROM payments p JOIN orders o ON o.id=p.order_id
              WHERE o.venue_id=$1 AND o.opened_by=$2 AND p.status IN ('paid','partially_paid')
                AND p.created_at >= ($3::date::timestamp AT TIME ZONE $4)
                AND p.created_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
            ) payments CROSS JOIN (
              SELECT COUNT(*)::int AS closed_orders FROM orders o
              WHERE o.venue_id=$1 AND o.opened_by=$2 AND o.status='closed'
                AND o.closed_at >= ($3::date::timestamp AT TIME ZONE $4)
                AND o.closed_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
            ) checks`, [venueDbId, req.user.id, reportDate, timezone]);
          const row = employeeTotals.rows[0] || {};
          const employeeTopUps = await repositories.pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COALESCE(SUM(amount) FILTER (WHERE payment_method='cash'),0) AS cash, COALESCE(SUM(amount) FILTER (WHERE payment_method IN ('card','qr')),0) AS cashless, COUNT(*)::int AS count FROM guest_deposit_receipts WHERE venue_id=$1 AND actor_id=$2 AND created_at >= ($3::date::timestamp AT TIME ZONE $4) AND created_at < (($3::date + 1)::timestamp AT TIME ZONE $4)`, [venueDbId, req.user.id, reportDate, timezone]);
          const topUps = employeeTopUps.rows[0] || {};
          const employeeReservationPrepayments = await repositories.pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COALESCE(SUM(amount) FILTER (WHERE payment_method='cash'),0) AS cash, COALESCE(SUM(amount) FILTER (WHERE payment_method IN ('card','qr')),0) AS cashless, COUNT(*)::int AS count FROM reservation_pre_payment_receipts WHERE venue_id=$1 AND actor_id=$2 AND created_at >= ($3::date::timestamp AT TIME ZONE $4) AND created_at < (($3::date + 1)::timestamp AT TIME ZONE $4)`, [venueDbId, req.user.id, reportDate, timezone]);
          const reservationPrepayments = employeeReservationPrepayments.rows[0] || {};
          return json(res, 200, { date: reportDate, timezone, employeeView: true, selectedShiftId: null,
            shifts: [{ id: 'employee-today' }], totals: { revenue: Number(row.revenue || 0), paymentCount: Number(row.payment_count || 0), cash: Number(row.cash || 0), cashless: Number(row.cashless || 0), other: Number(row.other || 0), closedOrders: Number(row.closed_orders || 0), depositTopUps: { total: Number(topUps.total || 0), cash: Number(topUps.cash || 0), cashless: Number(topUps.cashless || 0), count: Number(topUps.count || 0) }, reservationPrepayments: { total: Number(reservationPrepayments.total || 0), cash: Number(reservationPrepayments.cash || 0), cashless: Number(reservationPrepayments.cashless || 0), count: Number(reservationPrepayments.count || 0) } },
            unassignedPaymentCount: 0, ambiguousPaymentCount: 0 });
        }
        const selectedShiftId = requestedShiftId;
        const shiftsResult = await repositories.pool.query(`
          SELECT s.id, s.opened_at AS "openedAt", s.closed_at AS "closedAt",
            COALESCE(payments.revenue,0)::numeric AS revenue,
            COALESCE(payments.payment_count,0)::int AS "paymentCount",
            COALESCE(payments.cash,0)::numeric AS cash,
            COALESCE(payments.cashless,0)::numeric AS cashless,
            COALESCE(payments.other,0)::numeric AS other,
            COALESCE(checks.closed_orders,0)::int AS "closedOrders"
          FROM shifts s
          LEFT JOIN LATERAL (
            SELECT SUM(p.amount) FILTER (WHERE p.method<>'reservation' OR o.status='closed') AS revenue,
              COUNT(p.id)::int AS payment_count,
              SUM(p.amount) FILTER (WHERE p.method='cash') AS cash,
              SUM(p.amount) FILTER (WHERE p.method IN ('card','qr')) AS cashless,
              SUM(p.amount) FILTER (WHERE p.method NOT IN ('cash','card','qr') AND (p.method<>'reservation' OR o.status='closed')) AS other
            FROM payments p JOIN orders o ON o.id=p.order_id AND o.venue_id=s.venue_id
            WHERE p.status IN ('paid','partially_paid') AND p.shift_id=s.id
              AND ($3::uuid IS NULL OR o.opened_by=$3::uuid)
          ) payments ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS closed_orders FROM orders o
            WHERE o.venue_id=s.venue_id AND o.status='closed' AND o.closed_in_shift_id=s.id
              AND ($3::uuid IS NULL OR o.opened_by=$3::uuid)
          ) checks ON true
          WHERE s.venue_id=$1 AND (s.opened_at AT TIME ZONE $2)::date=$4::date
          ORDER BY s.opened_at DESC`, [venueDbId, timezone, employeeView ? req.user.id : null, reportDate]);
        const topUpsByShift = await repositories.pool.query(`SELECT shift_id AS "shiftId", SUM(amount) AS total, SUM(amount) FILTER (WHERE payment_method='cash') AS cash, SUM(amount) FILTER (WHERE payment_method IN ('card','qr')) AS cashless, COUNT(*)::int AS count FROM guest_deposit_receipts WHERE venue_id=$1 AND shift_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR actor_id=$3::uuid) GROUP BY shift_id`, [venueDbId, shiftsResult.rows.map((row) => row.id), employeeView ? req.user.id : null]);
        const topUpMap = new Map(topUpsByShift.rows.map((row) => [row.shiftId, { total: Number(row.total || 0), cash: Number(row.cash || 0), cashless: Number(row.cashless || 0), count: Number(row.count || 0) }]));
        const reservationPrepaymentsByShift = await repositories.pool.query(`SELECT shift_id AS "shiftId", SUM(amount) AS total, SUM(amount) FILTER (WHERE payment_method='cash') AS cash, SUM(amount) FILTER (WHERE payment_method IN ('card','qr')) AS cashless, COUNT(*)::int AS count FROM reservation_pre_payment_receipts WHERE venue_id=$1 AND shift_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR actor_id=$3::uuid) GROUP BY shift_id`, [venueDbId, shiftsResult.rows.map((row) => row.id), employeeView ? req.user.id : null]);
        const reservationPrepaymentMap = new Map(reservationPrepaymentsByShift.rows.map((row) => [row.shiftId, { total: Number(row.total || 0), cash: Number(row.cash || 0), cashless: Number(row.cashless || 0), count: Number(row.count || 0) }]));
        const shiftsForDate = shiftsResult.rows.map((row) => ({ ...row, revenue: Number(row.revenue || 0), cash: Number(row.cash || 0), cashless: Number(row.cashless || 0), other: Number(row.other || 0), paymentCount: Number(row.paymentCount || 0), closedOrders: Number(row.closedOrders || 0), depositTopUps: topUpMap.get(row.id) || { total: 0, cash: 0, cashless: 0, count: 0 }, reservationPrepayments: reservationPrepaymentMap.get(row.id) || { total: 0, cash: 0, cashless: 0, count: 0 } }));
        if (selectedShiftId && !shiftsForDate.some((shift) => shift.id === selectedShiftId)) return json(res, 404, { error: 'shift_not_found_for_date' });
        const selected = selectedShiftId ? shiftsForDate.filter((shift) => shift.id === selectedShiftId) : shiftsForDate;
        const totals = selected.reduce((result, shift) => ({ revenue: result.revenue + shift.revenue, paymentCount: result.paymentCount + shift.paymentCount, cash: result.cash + shift.cash, cashless: result.cashless + shift.cashless, other: result.other + shift.other, closedOrders: result.closedOrders + shift.closedOrders, depositTopUps: { total: result.depositTopUps.total + shift.depositTopUps.total, cash: result.depositTopUps.cash + shift.depositTopUps.cash, cashless: result.depositTopUps.cashless + shift.depositTopUps.cashless, count: result.depositTopUps.count + shift.depositTopUps.count }, reservationPrepayments: { total: result.reservationPrepayments.total + shift.reservationPrepayments.total, cash: result.reservationPrepayments.cash + shift.reservationPrepayments.cash, cashless: result.reservationPrepayments.cashless + shift.reservationPrepayments.cashless, count: result.reservationPrepayments.count + shift.reservationPrepayments.count } }), { revenue: 0, paymentCount: 0, cash: 0, cashless: 0, other: 0, closedOrders: 0, depositTopUps: { total: 0, cash: 0, cashless: 0, count: 0 }, reservationPrepayments: { total: 0, cash: 0, cashless: 0, count: 0 } });
        const unmatchedResult = employeeView ? { rows: [{ count: 0 }] } : await repositories.pool.query(`SELECT COUNT(DISTINCT p.id)::int AS count FROM payments p JOIN orders o ON o.id=p.order_id AND o.venue_id=$1 WHERE p.status IN ('paid','partially_paid') AND p.shift_id IS NULL AND ((($4::uuid IS NULL) AND (p.created_at AT TIME ZONE $2)::date=$3::date) OR EXISTS (SELECT 1 FROM shifts s WHERE s.venue_id=$1 AND (s.opened_at AT TIME ZONE $2)::date=$3::date AND ($4::uuid IS NULL OR s.id=$4::uuid) AND p.created_at>=s.opened_at AND p.created_at<COALESCE(s.closed_at,now())))`, [venueDbId, timezone, reportDate, selectedShiftId || null]);
        const visibleShifts = employeeView ? (shiftsForDate.length ? [{ id: 'employee-today' }] : []) : shiftsForDate;
        return json(res, 200, { date: reportDate, timezone, employeeView, selectedShiftId: selectedShiftId || null, shifts: visibleShifts, totals, unassignedPaymentCount: Number(unmatchedResult.rows[0]?.count || 0), ambiguousPaymentCount: 0 });
      } catch (error) { return json(res, 503, { error: 'shift_kpis_unavailable', detail: error.message }); }
    }
    if (employeeView) reportDate = today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !Number.isFinite(Date.parse(`${reportDate}T00:00:00Z`)) || new Date(`${reportDate}T00:00:00Z`).toISOString().slice(0, 10) !== reportDate) return json(res, 400, { error: 'invalid_shift_kpi_date' });
    if (employeeView) {
      const totals = { revenue: 0, paymentCount: 0, cash: 0, cashless: 0, other: 0, closedOrders: 0, depositTopUps: { total: 0, cash: 0, cashless: 0, count: 0 }, reservationPrepayments: { total: 0, cash: 0, cashless: 0, count: 0 } };
      for (const order of orders.filter((item) => String(item.openedById || item.openedBy || '') === String(req.user?.id || ''))) {
        if (order.status === 'closed' && order.closedAt && businessDateKey(order.closedAt) === reportDate) totals.closedOrders += 1;
        for (const payment of order.payments || []) {
          if (!['paid', 'partially_paid'].includes(payment.status) || !payment.createdAt || businessDateKey(payment.createdAt) !== reportDate || (payment.method==='reservation'&&order.status!=='closed')) continue;
          const amount = Number(payment.amount || 0);
          const method = payment.method === 'cash' ? 'cash' : ['card', 'qr'].includes(payment.method) ? 'cashless' : 'other';
          totals.revenue += amount; totals.paymentCount += 1; totals[method] += amount;
        }
      }
      for (const receipt of clients.flatMap((guest) => guest.depositTopUps || [])) if (receipt.actorId === req.user?.id && businessDateKey(receipt.createdAt) === reportDate) { const bucket = receipt.method === 'cash' ? 'cash' : 'cashless'; totals.depositTopUps.total += Number(receipt.amount || 0); totals.depositTopUps[bucket] += Number(receipt.amount || 0); totals.depositTopUps.count += 1; }
      for (const receipt of reservations.flatMap((reservation) => reservation.prepaymentReceipts || [])) if (receipt.actorId === req.user?.id && businessDateKey(receipt.createdAt) === reportDate) { const bucket = receipt.method === 'cash' ? 'cash' : 'cashless'; totals.reservationPrepayments.total += Number(receipt.amount || 0); totals.reservationPrepayments[bucket] += Number(receipt.amount || 0); totals.reservationPrepayments.count += 1; }
      return json(res, 200, { date: reportDate, timezone: businessTimezone, employeeView: true, selectedShiftId: null,
        shifts: [{ id: 'employee-today' }], totals, unassignedPaymentCount: 0, ambiguousPaymentCount: 0 });
    }
    const localShifts = shifts.filter((shift) => businessDateKey(shift.openedAt) === reportDate);
    const matches = localShifts;
    const selectedShiftId = requestedShiftId;
    if (selectedShiftId && !matches.some((shift) => shift.id === selectedShiftId)) return json(res, 404, { error: 'shift_not_found_for_date' });
    const chosen = selectedShiftId ? matches.filter((shift) => shift.id === selectedShiftId) : matches;
    const sums = { revenue: 0, paymentCount: 0, cash: 0, cashless: 0, other: 0, closedOrders: 0, ambiguousPayments: 0, depositTopUps: { total: 0, cash: 0, cashless: 0, count: 0 }, reservationPrepayments: { total: 0, cash: 0, cashless: 0, count: 0 } };
    const visibleOrders = orders.filter((order) => !employeeView || String(order.openedById || order.openedBy || '') === String(req.user?.id || ''));
    for (const order of visibleOrders) {
      if (order.status === 'closed' && order.closedAt) {
        const closedAt = new Date(order.closedAt);
        const closingShift = order.closedInShiftId || null;
        if (closingShift && chosen.some((shift) => shift.id === closingShift)) sums.closedOrders += 1;
      }
      for (const payment of order.payments || []) {
        if (!['paid','partially_paid'].includes(payment.status)) continue;
        if (payment.method==='reservation' && order.status!=='closed') continue;
        const paymentShiftId = payment.shiftId || null;
        if (!paymentShiftId || !chosen.some((shift) => shift.id === paymentShiftId)) continue;
        const key = payment.method === 'cash' ? 'cash' : ['card','qr'].includes(payment.method) ? 'cashless' : 'other';
        const amount = Number(payment.amount || 0);
        sums.revenue += amount; sums.paymentCount += 1; sums[key] += amount;
      }
    }
    for (const receipt of clients.flatMap((guest) => guest.depositTopUps || [])) if (chosen.some((shift) => shift.id === receipt.shiftId)) { const bucket = receipt.method === 'cash' ? 'cash' : 'cashless'; sums.depositTopUps.total += Number(receipt.amount || 0); sums.depositTopUps[bucket] += Number(receipt.amount || 0); sums.depositTopUps.count += 1; }
    for (const receipt of reservations.flatMap((reservation) => reservation.prepaymentReceipts || [])) if (chosen.some((shift) => shift.id === receipt.shiftId)) { const bucket = receipt.method === 'cash' ? 'cash' : 'cashless'; sums.reservationPrepayments.total += Number(receipt.amount || 0); sums.reservationPrepayments[bucket] += Number(receipt.amount || 0); sums.reservationPrepayments.count += 1; }
    const safeShifts = employeeView ? (matches.length ? [{ id: 'employee-today' }] : []) : matches.map(({ id, openedAt, closedAt }) => ({ id, openedAt, closedAt: closedAt || null }));
    const unmatchedPaymentCount = employeeView ? 0 : visibleOrders.reduce((count, order) => count + (order.payments || []).filter((payment) => {
      if (!['paid', 'partially_paid'].includes(payment.status) || payment.shiftId) return false;
      const paidAt = new Date(payment.createdAt || order.closedAt || order.createdAt || 0);
      const relatesToDate = businessDateKey(paidAt) === reportDate;
      const relatesToShift = chosen.some((shift) => paidAt >= new Date(shift.openedAt) && (!shift.closedAt || paidAt < new Date(shift.closedAt)));
      return selectedShiftId ? relatesToShift : (relatesToDate || relatesToShift);
    }).length, 0);
    return json(res, 200, { date: reportDate, timezone, employeeView, selectedShiftId: selectedShiftId || null, shifts: safeShifts, totals: sums, unassignedPaymentCount: unmatchedPaymentCount, ambiguousPaymentCount: sums.ambiguousPayments });
  }
  if (pathname === '/api/finance/summary' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'finance') && !hasPermission(req, 'finance_read')) return json(res, 403, { error: 'forbidden', permission: 'finance' });
    const employeeFinanceView = isOperationalEmployee(req); const requestedDate = url.searchParams.get('date') || ''; let date = employeeFinanceView ? today() : (requestedDate || today()); let timezone = businessTimezone;
    if (repositories?.pool) {
      try { const context = await venueBusinessDateContext(repositories.pool, venueDbId); if (!context) return json(res, 503, { error: 'database_unavailable' }); timezone = context.timezone; if (employeeFinanceView || !requestedDate) date = context.date; }
      catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'invalid_finance_date' });
    if (employeeFinanceView && repositories?.pool) {
      try {
        const actorId = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null;
        const { rows } = await repositories.pool.query(`SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.method<>'reservation' OR o.status='closed'),0) AS revenue FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.venue_id=$1 AND o.opened_by=$2 AND p.created_at >= ($3::date::timestamp AT TIME ZONE $4) AND p.created_at < (($3::date + 1)::timestamp AT TIME ZONE $4) AND p.status IN ('paid','partially_paid')`, [venueDbId, actorId, date, timezone]);
        const row = rows[0] || {}; return json(res, 200, { date, revenue: Number(row.revenue || 0), employeeView: true });
      } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
    }
    if (repositories?.pool) {
      try {
        const client = await repositories.pool.connect();
        try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const ledger = await financeDateLedger(client, venueDbId, date, timezone);
        const pending = await client.query(`
          SELECT COUNT(*)::int AS count FROM discounts d JOIN orders o ON o.id=d.order_id
          WHERE o.venue_id=$1 AND d.status='requested'`, [venueDbId]);
        const pendingTotals = await client.query(`WITH ${orderPricingSqlCtes}, paid_totals AS (SELECT order_id, COALESCE(SUM(amount) FILTER (WHERE status IN ('paid','partially_paid')),0) AS paid FROM payments GROUP BY order_id) SELECT COUNT(*)::int AS pending_orders, COALESCE(SUM(GREATEST(0, GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0))-COALESCE(p.paid,0))),0) AS pending_revenue FROM orders o LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN discount_totals d ON d.order_id=o.id LEFT JOIN paid_totals p ON p.order_id=o.id WHERE o.venue_id=$1 AND o.status IN ('open','in_progress','ready')`, [venueDbId]);
        const shiftStats = await client.query(`WITH ${orderPricingSqlCtes}, current_shift AS (SELECT id,venue_id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1), closed_checks AS (SELECT o.id,COALESCE(o.final_total_snapshot,GREATEST(0,GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0)))) AS net FROM orders o JOIN current_shift s ON s.venue_id=o.venue_id LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN discount_totals d ON d.order_id=o.id WHERE o.status='closed' AND o.closed_in_shift_id=s.id) SELECT COALESCE(SUM(net),0) AS check_total,COUNT(*)::int AS orders FROM closed_checks`, [venueDbId]);
        const shiftRow = shiftStats.rows[0] || { check_total: 0, orders: 0 }; const shiftRevenue = Number(shiftRow.check_total || 0); const shiftOrders = Number(shiftRow.orders || 0);
        await client.query('COMMIT');
        const fullSummary = { date, revenue: ledger.sales.net, closedOrders: ledger.sales.orders, paymentCount: ledger.receipts.count, byPaymentMethod: ledger.receipts.byMethod, sales: ledger.sales, receipts: ledger.receipts, payouts: ledger.payouts, currentShiftOrders: shiftOrders, currentShiftAverageCheck: shiftOrders ? shiftRevenue / shiftOrders : 0, pendingOrders: Number(pendingTotals.rows[0]?.pending_orders || 0), pendingRevenue: Number(pendingTotals.rows[0]?.pending_revenue || 0), pendingDiscounts: Number(pending.rows[0]?.count || 0) }; return json(res, 200, employeeFinanceView ? { date, revenue: fullSummary.revenue, employeeView: true } : fullSummary);
        } catch (error) { try { await client.query('ROLLBACK'); } catch (_) {} throw error; } finally { client.release(); }
      } catch (error) {
        return json(res, 503, { error: 'database_unavailable', detail: error.message });
      }
    }
    if (employeeFinanceView) {
      const revenue = orders.filter((order) => String(order.openedBy || order.openedById || '') === String(req.user?.id || ''))
        .flatMap((order) => order.payments || [])
        .filter((payment) => ['paid', 'partially_paid'].includes(payment.status) && payment.createdAt && businessDateKey(payment.createdAt) === date && (payment.method!=='reservation'||orders.find((order)=>order.payments?.includes(payment))?.status==='closed'))
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      return json(res, 200, { date, revenue, employeeView: true });
    }
    const closed = orders.filter((order) => order.status === 'closed' && businessDateKey(order.closedAt || order.createdAt) === date);
    const byType = {}; let revenue = 0; let paymentCount = 0;
    closed.forEach((order) => { const amount = Number(order.finalTotal !== undefined && order.finalTotal !== null ? order.finalTotal : orderNetTotal(order)); if (Number.isFinite(amount)) revenue += amount; });
    const receipts = orders.flatMap((order) => order.payments || []).filter((payment) => ['paid', 'partially_paid'].includes(payment.status) && ['cash', 'card', 'qr'].includes(payment.method) && payment.createdAt && businessDateKey(payment.createdAt) === date);
    receipts.forEach((payment) => { const amount = Number(payment.amount || 0); paymentCount += 1; const key = payment.method; byType[key] = (byType[key] || 0) + amount; });
    const pending = pendingPaymentSummary(); const currentShift = shifts.find((shift) => !shift.closedAt); const shiftClosed = currentShift ? orders.filter((order) => order.status === 'closed' && String(order.closedInShiftId || '') === String(currentShift.id)) : []; const shiftCheckTotal = shiftClosed.reduce((sum, order) => sum + Number(order.finalTotal !== undefined && order.finalTotal !== null ? order.finalTotal : orderNetTotal(order)), 0); const fullSummary = { date, revenue: roundMoney(revenue), closedOrders: closed.length, paymentCount, byPaymentMethod: byType, sales: { net: roundMoney(revenue), orders: closed.length, dateBasis: 'closed_at' }, receipts: { total: roundMoney(receipts.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)), count: paymentCount, byMethod: byType, bySource: receipts.length ? { order_payment: roundMoney(receipts.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)) } : {}, dateBasis: 'created_at', coverage: 'memory_order_payments_only' }, payouts: { total: 0, count: 0, byMethod: {}, bySource: {}, dateBasis: 'created_at', coverage: 'memory_sources_unavailable' }, currentShiftOrders: shiftClosed.length, currentShiftAverageCheck: shiftClosed.length ? shiftCheckTotal / shiftClosed.length : 0, pendingOrders: pending.pendingOrders, pendingRevenue: pending.pendingRevenue, pendingDiscounts: discountRequests.filter((request) => request.status === 'requested').length }; return json(res, 200, employeeFinanceView ? { date, revenue, employeeView: true } : fullSummary);
  }
  if (pathname === '/api/finance/report' && req.method === 'GET') {
    if (process.env.AUTH_REQUIRED === 'true' && !hasPermission(req, 'finance') && !hasPermission(req, 'finance_read')) return json(res, 403, { error: 'forbidden', permission: 'finance_read' });
    const employeeFinanceView = isOperationalEmployee(req); const requestedDate = url.searchParams.get('date') || ''; let date = employeeFinanceView ? today() : (requestedDate || today()); let timezone = businessTimezone;
    if (repositories?.pool) {
      try { const context = await venueBusinessDateContext(repositories.pool, venueDbId); if (!context) return json(res, 503, { error: 'database_unavailable' }); timezone = context.timezone; if (employeeFinanceView || !requestedDate) date = context.date; }
      catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
    }
    const requestedReportType = String(url.searchParams.get('type') || 'x');
    const type = ['x', 'z', 'waiter'].includes(requestedReportType) ? requestedReportType : 'x';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'invalid_finance_date' });
    const reportNumber = `R-${date.replace(/-/g, '')}-${type.toUpperCase()}-${String(Date.now()).slice(-6)}`;
    if (employeeFinanceView && repositories?.pool) {
      try {
        const actorId = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null;
        const { rows } = await repositories.pool.query(`SELECT COALESCE((SELECT SUM(p.amount) FILTER (WHERE p.method<>'reservation' OR o.status='closed') FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.venue_id=$1 AND o.opened_by=$2 AND p.created_at >= ($3::date::timestamp AT TIME ZONE $4) AND p.created_at < (($3::date + 1)::timestamp AT TIME ZONE $4) AND p.status IN ('paid','partially_paid')),0) AS revenue, (SELECT COUNT(*)::int FROM orders o WHERE o.venue_id=$1 AND o.opened_by=$2 AND o.status='closed' AND o.closed_at >= ($3::date::timestamp AT TIME ZONE $4) AND o.closed_at < (($3::date + 1)::timestamp AT TIME ZONE $4)) AS checks_count`, [venueDbId, actorId, date, timezone]);
        const report = { type: 'x', date, generatedAt: new Date().toISOString(), reportNumber, checksCount: Number(rows[0]?.checks_count || 0), revenue: Number(rows[0]?.revenue || 0), employeeView: true };
        recordAudit(req, 'finance.report_generated', 'finance_report', reportNumber, null, { type: 'x', date, checksCount: report.checksCount, revenue: report.revenue });
        return json(res, 200, report);
      } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
    }
    let byPaymentMethod = {}; const byStation = {}; const byStaff = {}; let revenue = 0; let paymentCount = 0; let closedOrders = []; let periodLedger = null;
    const addOrder = (order) => {
      const payments = (order.payments || []).filter((payment) => ['paid', 'partially_paid'].includes(payment.status));
      const paidAmount = payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      let orderRevenue = paidAmount;
      if (employeeFinanceView) { revenue += paidAmount; paymentCount += payments.length; payments.forEach((payment) => { const key = payment.method || 'не указан'; byPaymentMethod[key] = (byPaymentMethod[key] || 0) + Number(payment.amount || 0); }); }
      else { const amount = order.finalTotal !== undefined && order.finalTotal !== null ? Number(order.finalTotal) : Number(orderNetTotal(order)); orderRevenue = Number.isFinite(amount) ? amount : Number(orderTotal(order) || 0); revenue += orderRevenue; }
      const stationAllocations = allocateMoneyByGross(order.items || [], orderRevenue, (item) => item.station || 'other', (item) => Number(item.unitPrice || item.price || 0) * Number(item.quantity || 0));
      stationAllocations.forEach((amount, station) => { byStation[station] = (byStation[station] || 0) + amount; });
      const staffName = order.createdByName || order.waiterName || order.cashierName || 'Не указан'; byStaff[staffName] = (byStaff[staffName] || 0) + orderRevenue;
    };
    if (repositories?.pool) {
      try {
        const client = await repositories.pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const { rows } = await client.query(`WITH ${orderPricingSqlCtes} SELECT o.id,o.created_at AS "createdAt",o.closed_at AS "closedAt",COALESCE(u.full_name,u.login,'Не указан') AS "createdByName",COALESCE(o.final_total_snapshot,GREATEST(0,GREATEST(COALESCE(o.vip_minimum,0),COALESCE(i.subtotal,0)-COALESCE(d.discount,0)))) AS "finalTotal",COALESCE(json_agg(json_build_object('method',p.method,'amount',p.amount,'status',p.status)) FILTER (WHERE p.id IS NOT NULL),'[]') AS payments FROM orders o LEFT JOIN item_totals i ON i.order_id=o.id LEFT JOIN discount_totals d ON d.order_id=o.id LEFT JOIN payments p ON p.order_id=o.id LEFT JOIN users u ON u.id=o.opened_by WHERE o.venue_id=$1 AND o.status='closed' AND o.closed_at >= ($2::date::timestamp AT TIME ZONE $3) AND o.closed_at < (($2::date + 1)::timestamp AT TIME ZONE $3) GROUP BY o.id,u.full_name,u.login,i.subtotal,d.discount ORDER BY o.closed_at`, [venueDbId, date, timezone]);
        closedOrders = rows.map((row) => ({ ...row, payments: row.payments || [], items: [] }));
        const itemRows = await client.query(`
          SELECT sl.order_id AS "orderId",sl.quantity,sl.unit_price AS "unitPrice",COALESCE(sl.product_facts->>'station','other') AS station
          FROM pos_order_pricing_snapshot_lines sl
          JOIN pos_order_pricing_snapshots s ON s.venue_id=sl.venue_id AND s.id=sl.snapshot_id AND s.order_id=sl.order_id
          JOIN orders o ON o.id=sl.order_id AND o.venue_id=sl.venue_id
          WHERE o.venue_id=$1 AND o.status='closed' AND o.closed_at >= ($2::date::timestamp AT TIME ZONE $3) AND o.closed_at < (($2::date + 1)::timestamp AT TIME ZONE $3)
          UNION ALL
          SELECT oi.order_id AS "orderId",oi.quantity,oi.unit_price AS "unitPrice",COALESCE(oi.station,'other') AS station
          FROM order_items oi
          JOIN orders o ON o.id=oi.order_id AND o.venue_id=$1
          WHERE o.venue_id=$1 AND o.status='closed' AND o.closed_at >= ($2::date::timestamp AT TIME ZONE $3) AND o.closed_at < (($2::date + 1)::timestamp AT TIME ZONE $3)
            AND NOT EXISTS (SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.venue_id=o.venue_id AND s.order_id=o.id)
        `, [venueDbId, date, timezone]);
        const itemsByOrder = new Map(); itemRows.rows.forEach((item) => { if (!itemsByOrder.has(item.orderId)) itemsByOrder.set(item.orderId, []); itemsByOrder.get(item.orderId).push(item); }); closedOrders.forEach((order) => { order.items = itemsByOrder.get(order.id) || []; addOrder(order); });
        if (!employeeFinanceView) periodLedger = await financeDateLedger(client, venueDbId, date, timezone);
        await client.query('COMMIT');
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw error;
        } finally { client.release(); }
      } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
    } else {
      closedOrders = orders.filter((order) => order.status === 'closed' && businessDateKey(order.closedAt || order.createdAt) === date && (!employeeFinanceView || String(order.openedBy || order.openedById || '') === String(req.user?.id || ''))); closedOrders.forEach(addOrder);
      if (!employeeFinanceView) {
        const receiptRows = orders.flatMap((order) => order.payments || []).filter((payment) => ['paid','partially_paid'].includes(payment.status) && ['cash','card','qr'].includes(payment.method) && payment.createdAt && businessDateKey(payment.createdAt) === date);
        const byMethod = {}; let total = 0; receiptRows.forEach((payment) => { const amount = Number(payment.amount || 0); byMethod[payment.method] = (byMethod[payment.method] || 0) + amount; total += amount; });
        const sales = closedOrders.reduce((result, order) => { const amount = Number(order.finalTotal !== undefined && order.finalTotal !== null ? order.finalTotal : orderNetTotal(order)); result.net += Number.isFinite(amount) ? amount : 0; result.orders += 1; if (order.finalTotal === undefined || order.finalTotal === null) result.unsnapshottedOrders += 1; return result; }, { net: 0, orders: 0, unsnapshottedOrders: 0 });
        periodLedger = { sales: { ...sales, net: roundMoney(sales.net), dateBasis: 'closed_at' }, receipts: { total: roundMoney(total), count: receiptRows.length, byMethod, bySource: receiptRows.length ? { order_payment: roundMoney(total) } : {}, dateBasis: 'created_at', coverage: 'memory_order_payments_only' }, payouts: { total: 0, count: 0, byMethod: {}, bySource: {}, dateBasis: 'created_at', coverage: 'memory_sources_unavailable' } };
      }
    }
    if (!employeeFinanceView && periodLedger) { byPaymentMethod = periodLedger.receipts.byMethod; paymentCount = periodLedger.receipts.count; revenue = periodLedger.sales.net; }
    const activeShift = repositories?.pool ? null : shifts.find((shift) => !shift.closedAt);
    const report = { type, date, generatedAt: new Date().toISOString(), reportNumber, cashier: req.user?.name || 'Кассир', checksCount: closedOrders.length, closedOrders: closedOrders.length, paymentCount, revenue: Math.round(revenue * 100) / 100, cash: Math.round(Number(byPaymentMethod.cash || 0) * 100) / 100, card: Math.round(Number(byPaymentMethod.card || 0) * 100) / 100, qr: Math.round(Number(byPaymentMethod.qr || 0) * 100) / 100, byPaymentMethod, byStation, byStaff: type === 'waiter' ? byStaff : undefined, ...(!employeeFinanceView && periodLedger ? { sales: periodLedger.sales, receipts: periodLedger.receipts, payouts: periodLedger.payouts, staffAttribution: 'order_opener' } : {}), shift: { id: activeShift?.id || null, status: activeShift ? 'open' : 'closed', isFinal: type === 'z' } };
    recordAudit(req, 'finance.report_generated', 'finance_report', reportNumber, null, { type, date, checksCount: report.checksCount, revenue: report.revenue, ...(report.sales ? { sales: report.sales, receipts: report.receipts, payouts: report.payouts } : {}) });
    return json(res, 200, employeeFinanceView ? { type: 'x', date, generatedAt: report.generatedAt, reportNumber: report.reportNumber, checksCount: report.checksCount, revenue: report.revenue, employeeView: true } : report);
  }
  if (pathname === '/api/deliveries' && req.method === 'GET') {
    if (denyUnless(req, res, 'delivery')) return;
    if (process.env.DATABASE_URL) {
      try {
        const { rows } = await repositories.pool.query(`SELECT id,customer_name AS "customerName",phone,address,comment,total,payment_method AS "paymentMethod",status,courier,created_at AS "createdAt" FROM deliveries WHERE venue_id=$1 ORDER BY created_at DESC,id`, [venueDbId]);
        return json(res, 200, { items: rows.map((row) => ({ ...row, total: Number(row.total) })) });
      } catch (_) { return json(res, 503, { error: 'database_unavailable' }); }
    }
    return json(res, 200, { items: deliveries.filter((entry) => entry.venueId === venueDbId).map(({ venueId, ...entry }) => entry).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
  }
  if (pathname === '/api/deliveries' && req.method === 'POST') {
    if (denyUnless(req, res, 'delivery')) return;
    const input = await body(req); const customerName = String(input.customerName || '').trim(); const phone = String(input.phone || '').trim(); const address = String(input.address || '').trim(); const rawTotal = Number(input.total ?? 0);
    const total = Math.round((rawTotal + Number.EPSILON) * 100) / 100;
    if (!customerName || customerName.length > 120 || !address || address.length > 500) return json(res, 400, { error: 'delivery_contact_required' });
    if (phone && !/^\+7[0-9 ()-]{7,24}$/.test(phone)) return json(res, 400, { error: 'invalid_guest_phone' });
    if (!Number.isFinite(rawTotal) || rawTotal < 0 || !Number.isFinite(total) || total > 999999999999.99) return json(res, 400, { error: 'invalid_delivery_total' });
    const delivery = { id: `delivery-${Date.now()}`, customerName, phone, address, comment: String(input.comment || '').trim().slice(0, 500), total, paymentMethod: ['cash', 'card', 'qr'].includes(input.paymentMethod) ? input.paymentMethod : 'cash', status: 'new', courier: '', createdAt: new Date().toISOString() };
    if (process.env.DATABASE_URL) {
      try {
        const { rows } = await repositories.pool.query(`INSERT INTO deliveries (venue_id,customer_name,phone,address,comment,total,payment_method) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,customer_name AS "customerName",phone,address,comment,total,payment_method AS "paymentMethod",status,courier,created_at AS "createdAt"`, [venueDbId,customerName,phone,address,delivery.comment,total,delivery.paymentMethod]);
        const saved = { ...rows[0], total: Number(rows[0].total) };
        recordAudit(req, 'delivery.created', 'delivery', saved.id, null, saved);
        return json(res, 201, saved);
      } catch (_) { return json(res, 503, { error: 'database_unavailable' }); }
    }
    deliveries.push({ ...delivery, venueId: venueDbId }); recordAudit(req, 'delivery.created', 'delivery', delivery.id, null, delivery); return json(res, 201, delivery);
  }
  const deliveryPath = pathname.match(/^\/api\/deliveries\/([^/]+)$/);
  if (deliveryPath && req.method === 'PATCH') {
    if (denyUnless(req, res, 'delivery')) return;
    const input = await body(req);
    const allowed = ['new', 'confirmed', 'in_delivery', 'delivered', 'cancelled'];
    if (input.status !== undefined && !allowed.includes(input.status)) return json(res, 400, { error: 'invalid_delivery_status' });
    const courier = input.courier === undefined ? null : String(input.courier || '').trim().slice(0, 120);
    if (process.env.DATABASE_URL) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryPath[1])) return json(res, 404, { error: 'delivery_not_found' });
      let client;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        const fields = `id,customer_name AS "customerName",phone,address,comment,total,payment_method AS "paymentMethod",status,courier,created_at AS "createdAt"`;
        const prior = await client.query(`SELECT ${fields} FROM deliveries WHERE id=$1 AND venue_id=$2 FOR UPDATE`, [deliveryPath[1],venueDbId]);
        if (!prior.rows.length) {
          await client.query('ROLLBACK');
          return json(res, 404, { error: 'delivery_not_found' });
        }
        const { rows } = await client.query(`UPDATE deliveries SET status=COALESCE($3,status),courier=COALESCE($4,courier),updated_at=now() WHERE id=$1 AND venue_id=$2 RETURNING ${fields}`, [deliveryPath[1],venueDbId,input.status ?? null,courier]);
        await client.query('COMMIT');
        const saved = { ...rows[0], total: Number(rows[0].total) };
        const before = { ...prior.rows[0], total: Number(prior.rows[0].total) };
        recordAudit(req, 'delivery.updated', 'delivery', saved.id, before, saved);
        return json(res, 200, saved);
      } catch (_) {
        if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
        return json(res, 503, { error: 'database_unavailable' });
      } finally { client?.release(); }
    }
    const delivery = deliveries.find((entry) => entry.id === deliveryPath[1] && entry.venueId === venueDbId);
    if (!delivery) return json(res, 404, { error: 'delivery_not_found' });
    const { venueId, ...before } = delivery;
    if (input.status !== undefined) delivery.status = input.status;
    if (courier !== null) delivery.courier = courier;
    const { venueId: ignoredVenueId, ...saved } = delivery;
    recordAudit(req, 'delivery.updated', 'delivery', delivery.id, before, saved);
    return json(res, 200, saved);
  }
  if (pathname === '/api/tasks' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['orders', 'staff_view'])) return;
    const ownTasksOnly = Boolean(req.user && !hasPermission(req, 'staff_manage') && !hasPermission(req, 'tasks_manage'));
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query(`SELECT t.id,t.title,t.description,t.status,t.priority,t.assignee_id AS "assigneeId",assigned_user.full_name AS "assigneeName",t.due_at AS "dueAt",to_char(t.due_date,'YYYY-MM-DD') AS "dueDate",t.created_at AS "createdAt",t.updated_at AS "updatedAt" FROM tasks t LEFT JOIN users assigned_user ON assigned_user.id=t.assignee_id AND assigned_user.venue_id=t.venue_id WHERE t.venue_id=$1 AND ($2::boolean=false OR t.assignee_id=$3) ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,COALESCE(t.due_at,t.due_date::timestamp AT TIME ZONE COALESCE((SELECT timezone FROM venues WHERE id=t.venue_id),'UTC')) NULLS LAST,t.created_at DESC`, [venueDbId, ownTasksOnly, req.user?.id || null]); return json(res, 200, { items: rows }); } catch (_) { return json(res, 503, { error: 'database_unavailable' }); } }
    const visibleTasks = ownTasksOnly ? tasks.filter((task) => String(task.assigneeId || '') === String(req.user.id)) : tasks;
    return json(res, 200, { items: visibleTasks.map((task) => ({ ...task, assigneeName: staff.find((person) => String(person.id) === String(task.assigneeId))?.name || task.assigneeName || null })) });
  }
  if (pathname === '/api/tasks' && req.method === 'POST') {
    if (denyUnlessAny(req, res, ['staff_manage', 'tasks_manage'])) return;
    const input = await body(req); const title = String(input.title || '').trim(); const description = String(input.description || '').trim(); const status = String(input.status || 'open'); const priority = String(input.priority || 'normal');
    if (!title || title.length > 160 || description.length > 2000 || !['open','in_progress','done','cancelled'].includes(status) || !['low','normal','high','urgent'].includes(priority)) return json(res, 400, { error: 'invalid_task' });
    const deadline = normalizeTaskDeadline(input);
    if (deadline.error) return json(res, 400, { error: deadline.error });
    if (process.env.AUTH_REQUIRED === 'true' && !input.assigneeId) return json(res, 400, { error: 'task_assignee_required' });
    if (repositories?.pool) { try { if (input.assigneeId) { const assignee = await repositories.pool.query('SELECT id FROM users WHERE id=$1 AND venue_id=$2 AND is_active=true AND deleted_at IS NULL', [String(input.assigneeId), venueDbId]); if (!assignee.rows[0]) return json(res, 400, { error: 'task_assignee_not_found' }); } const { rows } = await repositories.pool.query('INSERT INTO tasks (venue_id,title,description,status,priority,assignee_id,due_at,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,title,description,status,priority,assignee_id AS "assigneeId",due_at AS "dueAt",to_char(due_date,\'YYYY-MM-DD\') AS "dueDate",created_at AS "createdAt",updated_at AS "updatedAt"', [venueDbId,title,description,status,priority,input.assigneeId || null,deadline.dueAt || null,deadline.dueDate || null,/^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null]); recordAudit(req, 'task.created', 'task', rows[0].id, null, rows[0]); return json(res, 201, rows[0]); } catch (error) { return json(res, 409, { error: 'task_create_failed', detail: error.message }); } }
    const assignedPerson = input.assigneeId ? staff.find((person) => String(person.id) === String(input.assigneeId) && person.active !== false && !person.deletedAt) : null;
    if (input.assigneeId && process.env.AUTH_REQUIRED === 'true' && !assignedPerson) return json(res, 400, { error: 'task_assignee_not_found' });
    const task = { id: `task-${Date.now()}`, title, description, status, priority, assigneeId: input.assigneeId || null, assigneeName: assignedPerson?.name || null, dueAt: deadline.dueAt || null, dueDate: deadline.dueDate || null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; tasks.push(task); recordAudit(req, 'task.created', 'task', task.id, null, task); return json(res, 201, task);
  }
  const taskPath = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskPath && req.method === 'DELETE') {
    if (denyUnlessAny(req, res, ['staff_manage', 'tasks_manage'])) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(taskPath[1])) {
      try {
        const { rows } = await repositories.pool.query('DELETE FROM tasks WHERE id=$1 AND venue_id=$2 RETURNING id', [taskPath[1], venueDbId]);
        if (!rows[0]) return json(res, 404, { error: 'task_not_found' });
        recordAudit(req, 'task.deleted', 'task', rows[0].id, null, { id: rows[0].id });
        return json(res, 200, { ok: true, id: rows[0].id });
      } catch (error) { return json(res, 409, { error: 'task_delete_failed', detail: error.message }); }
    }
    const index = tasks.findIndex((entry) => entry.id === taskPath[1]);
    if (index < 0) return json(res, 404, { error: 'task_not_found' });
    const [deleted] = tasks.splice(index, 1);
    recordAudit(req, 'task.deleted', 'task', deleted.id, null, deleted);
    return json(res, 200, { ok: true, id: deleted.id });
  }
  if (taskPath && req.method === 'PATCH') {
    if (denyUnlessAny(req, res, ['orders', 'staff_view', 'staff_manage', 'tasks_manage'])) return;
    const input = await body(req); const canManageTasks = hasPermission(req, 'staff_manage') || hasPermission(req, 'tasks_manage'); const allowed = canManageTasks ? ['title','description','status','priority','assigneeId','dueAt','dueDate'] : ['status'];
    const invalidTaskTitle = input.title !== undefined && (!String(input.title).trim() || String(input.title).trim().length > 160);
    const invalidTaskDescription = input.description !== undefined && String(input.description).length > 2000;
    const deadline = normalizeTaskDeadline(input);
    if (invalidTaskTitle) return json(res, 400, { error: 'invalid_task_title' });
    if (invalidTaskDescription) return json(res, 400, { error: 'invalid_task_description' });
    if (deadline.error) return json(res, 400, { error: deadline.error });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(taskPath[1])) { try { const { rows: taskRows } = await repositories.pool.query('SELECT id,assignee_id AS "assigneeId" FROM tasks WHERE id=$1 AND venue_id=$2', [taskPath[1], venueDbId]); const task = taskRows[0]; if (!task) return json(res, 404, { error: 'task_not_found' }); if (!canManageTasks && String(task.assigneeId || '') !== String(req.user?.id || '')) return json(res, 403, { error: 'task_update_forbidden' }); if (!canManageTasks && Object.keys(input).some((key) => !allowed.includes(key))) return json(res, 403, { error: 'task_update_forbidden' }); const fields = []; const values = [taskPath[1], venueDbId]; for (const key of allowed) if (input[key] !== undefined && !['dueAt','dueDate'].includes(key)) { if (key === 'status' && !['open','in_progress','done','cancelled'].includes(String(input[key]))) return json(res, 400, { error: 'invalid_task_status' }); if (key === 'priority' && !['low','normal','high','urgent'].includes(String(input[key]))) return json(res, 400, { error: 'invalid_task_priority' }); if (key === 'assigneeId' && input[key] !== null && input[key] !== '') { const assignee = await repositories.pool.query('SELECT 1 FROM users WHERE id=$1 AND venue_id=$2 AND is_active=true AND deleted_at IS NULL', [String(input[key]), venueDbId]); if (!assignee.rows[0]) return json(res, 400, { error: 'task_assignee_not_found' }); } fields.push(`${key === 'assigneeId' ? 'assignee_id' : key === 'dueAt' ? 'due_at' : key}=$${values.length + 1}`); values.push(key === 'title' || key === 'description' ? String(input[key] || '').trim() : key === 'dueAt' && input[key] === '' || key === 'assigneeId' && input[key] === '' ? null : input[key]); } if (deadline.changed) { fields.push(`due_at=$${values.length + 1}`, `due_date=$${values.length + 2}`); values.push(deadline.dueAt, deadline.dueDate); } if (!fields.length) return json(res, 400, { error: 'task_fields_required' }); fields.push('updated_at=now()'); const { rows } = await repositories.pool.query(`UPDATE tasks SET ${fields.join(',')} WHERE id=$1 AND venue_id=$2 RETURNING id,title,description,status,priority,assignee_id AS "assigneeId",due_at AS "dueAt",to_char(due_date,'YYYY-MM-DD') AS "dueDate",created_at AS "createdAt",updated_at AS "updatedAt"`, values); if (!rows[0]) return json(res, 404, { error: 'task_not_found' }); recordAudit(req, 'task.updated', 'task', rows[0].id, null, rows[0]); return json(res, 200, rows[0]); } catch (error) { return json(res, 409, { error: 'task_update_failed', detail: error.message }); } }
    const task = tasks.find((entry) => entry.id === taskPath[1]); if (!task) return json(res, 404, { error: 'task_not_found' }); if (!canManageTasks && String(task.assigneeId || '') !== String(req.user?.id || '')) return json(res, 403, { error: 'task_update_forbidden' }); if (!canManageTasks && Object.keys(input).some((key) => !allowed.includes(key))) return json(res, 403, { error: 'task_update_forbidden' }); if (input.status !== undefined && !['open','in_progress','done','cancelled'].includes(String(input.status))) return json(res, 400, { error: 'invalid_task_status' }); if (input.priority !== undefined && !['low','normal','high','urgent'].includes(String(input.priority))) return json(res, 400, { error: 'invalid_task_priority' }); if (input.assigneeId && process.env.AUTH_REQUIRED === 'true' && !staff.some((person) => String(person.id) === String(input.assigneeId) && person.active !== false && !person.deletedAt)) return json(res, 400, { error: 'task_assignee_not_found' }); Object.assign(task, input, deadline.changed ? { dueAt: deadline.dueAt, dueDate: deadline.dueDate } : {}, { assigneeId: input.assigneeId === undefined ? task.assigneeId : input.assigneeId === '' ? null : input.assigneeId, updatedAt: new Date().toISOString() }); return json(res, 200, task);
  }
  if (pathname === '/api/reservations' && req.method === 'GET') {
    if (denyUnless(req, res, 'reservations')) return;
    const date = url.searchParams.get('date');
    if (repositories?.reservations) { try { return json(res, 200, { items: await repositories.reservations.list(venueDbId, date) }); } catch (_) {} }
    const venueReservations = reservations.filter((reservation) => reservation.venueId === currentVenueId).map((reservation) => ({ ...reservation, linkedOrderId: orders.find((order)=>order.venueId===currentVenueId&&order.reservationId===reservation.id)?.id || null }));
    return json(res, 200, { items: date ? venueReservations.filter((reservation) => reservation.date === date) : venueReservations });
  }
  if (pathname === '/api/reservations' && req.method === 'POST') {
    if (denyUnless(req, res, 'reservations')) return;
    const input = await body(req);
    if (!input.guestName || !input.date || !input.time || !input.tableId) return json(res, 400, { error: 'guest_date_time_table_required' });
    if (String(input.guestName).trim().length > 120) return json(res, 400, { error: 'guest_name_too_long' });
    if (input.notes !== undefined && String(input.notes).length > 2000) return json(res, 400, { error: 'reservation_notes_too_long' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date)) || !/^\d{2}:\d{2}$/.test(String(input.time)) || Number.isNaN(Date.parse(`${input.date}T${input.time}:00`)) || Date.parse(`${input.date}T${input.time}:00`) <= Date.now()) return json(res, 400, { error: 'invalid_reservation_datetime' });
    if (input.phone && !/^\+7[0-9 ()-]{7,24}$/.test(String(input.phone).trim())) return json(res, 400, { error: 'invalid_guest_phone' });
    if (!Number.isInteger(Number(input.guests || 1)) || Number(input.guests || 1) < 1 || Number(input.guests || 1) > 50) return json(res, 400, { error: 'invalid_guest_count' });
    let tableMinimum = 0;
    let tableMaximum = 50;
    let tableName = input.tableId;
    let zoneName = '';
    let table = null;
    if (repositories?.pool) {
      try {
        const { rows } = await repositories.pool.query('SELECT t.name,t.status,t.capacity,t.max_capacity AS "maxCapacity",z.name AS "zoneName",t.min_order_total AS "minimumOrderTotal" FROM tables t JOIN zones z ON z.id=t.zone_id WHERE t.id=$1 AND z.venue_id=$2 AND t.archived_at IS NULL', [input.tableId, venueDbId]);
        if (!rows[0]) return json(res, 400, { error: 'table_not_found' });
        tableName = rows[0].name;
        zoneName = rows[0].zoneName || '';
        tableMaximum = Number(rows[0].maxCapacity || rows[0].capacity || 50);
        if (rows[0].status === 'blocked') return json(res, 409, { error: 'table_unavailable' });
        tableMinimum = Number(rows[0].minimumOrderTotal || 0);
      } catch (error) { return json(res, 409, { error: 'reservation_table_lookup_failed', detail: error.message }); }
    } else {
      const tableZone = floor.find((zone) => zone.tables.some((entry) => entry.id === input.tableId));
      table = tableZone?.tables.find((entry) => entry.id === input.tableId);
      if (!table) return json(res, 400, { error: 'table_not_found' });
      zoneName = tableZone.name || '';
      tableName = table.name;
      tableMaximum = Number(table.maxCapacity || table.capacity || 50);
      if (table.status === 'blocked') return json(res, 409, { error: 'table_unavailable' });
      tableMinimum = Number(table.minimumOrderTotal || 0);
    }
    if (Number(input.guests || 1) > tableMaximum) return json(res, 400, { error: 'table_capacity_exceeded', maximumGuests: tableMaximum });
    const deposit = Number(input.deposit || 0);
    if (!Number.isFinite(deposit) || deposit < tableMinimum) return json(res, 409, { error: 'vip_deposit_below_minimum', requiredDeposit: tableMinimum, providedDeposit: deposit });
    if (repositories?.pool) {
      try {
        const conflict = await repositories.pool.query(`SELECT r.id FROM reservations r JOIN venues v ON v.id=r.venue_id WHERE r.venue_id=$1 AND r.table_id=$2 AND r.starts_at=($3::timestamp AT TIME ZONE COALESCE(NULLIF(v.timezone,''),'Asia/Yekaterinburg')) AND r.status='confirmed' LIMIT 1`, [venueDbId, input.tableId, `${input.date}T${input.time}:00`]);
        if (conflict.rows[0]) return json(res, 409, { error: 'table_already_reserved', reservationId: conflict.rows[0].id });
      } catch (error) { return json(res, 409, { error: 'reservation_conflict_check_failed', detail: error.message }); }
    } else if (reservations.some((entry) => entry.status === 'confirmed' && entry.tableId === input.tableId && entry.date === input.date && entry.time === input.time)) {
      return json(res, 409, { error: 'table_already_reserved' });
    }
    if (repositories?.pool) { try { const reservation = await repositories.reservations.create({ ...input, tableName, zoneName, deposit, venueId: venueDbId }); recordAudit(req, 'reservation.created', 'reservation', reservation.id, null, reservation); return json(res, 201, reservation); } catch (error) { return json(res, 409, { error: 'reservation_create_failed', detail: error.message }); } }
    const reservation = { id: `res-${Date.now()}`, venueId: currentVenueId, clientId: input.clientId || null, guestName: input.guestName, phone: input.phone || '', date: input.date, time: input.time, tableId: input.tableId, tableName, zoneName, guests: Number(input.guests || 1), status: 'confirmed', deposit, depositRequired: deposit, depositPaid: 0, legacyDepositPaid: 0, verifiedDepositPaid: 0, prepaymentReceipts: [], notes: input.notes || '', createdBy: req.user?.id || null, createdByName: String(input.createdByName || req.user?.name || 'Сотрудник').slice(0, 120), createdByRole: String(input.createdByRole || (req.user?.role === 'owner' ? 'Владелец' : req.user?.role === 'admin' ? 'Администратор' : 'Сотрудник')).slice(0, 40), createdAt: new Date().toISOString() };
    reservations.push(reservation);
    if (input.date === today()) table.status = 'reserved';
    recordAudit(req, 'reservation.created', 'reservation', reservation.id, null, reservation);
    return json(res, 201, reservation);
  }
  const reservationPrePaymentPath = pathname.match(/^\/api\/reservations\/([^/]+)\/deposit-receipts$/);
  if (reservationPrePaymentPath && req.method === 'POST') {
    if (denyUnless(req, res, 'reservations')) return;
    const input = await body(req); const amount = Number(input.amount); const method = String(input.method || 'cash'); const reason = String(input.reason || 'Предоплата по бронированию').trim(); const idempotencyKey = String(input.idempotencyKey || req.headers?.['idempotency-key'] || '').trim();
    if (!validPaymentAmount(amount) || amount > 10000000 || !['cash','card','qr'].includes(method)) return json(res, 400, { error: 'invalid_reservation_pre_payment' });
    if (!reason || reason.length > 500) return json(res, 400, { error: 'reservation_pre_payment_reason_required' });
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) return json(res, 400, { error: 'valid_idempotency_key_required' });
    if (repositories?.pool && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservationPrePaymentPath[1])) {
      let client;
      try {
        client = await repositories.pool.connect(); await client.query('BEGIN');
        const prior = await client.query('SELECT id,reservation_id AS "reservationId",shift_id AS "shiftId",amount,payment_method AS method,reason,created_at AS "createdAt" FROM reservation_pre_payment_receipts WHERE venue_id=$1 AND idempotency_key=$2', [venueDbId, idempotencyKey]);
        if (prior.rows[0]) {
          const receipt = prior.rows[0];
          if (receipt.reservationId !== reservationPrePaymentPath[1] || Number(receipt.amount) !== amount || receipt.method !== method || receipt.reason !== reason) { await client.query('ROLLBACK'); return json(res, 409, { error: 'idempotency_key_reused' }); }
          const balance = await client.query('SELECT deposit_required AS "depositRequired",verified_deposit_paid AS "verifiedDepositPaid" FROM reservations WHERE id=$1 AND venue_id=$2', [receipt.reservationId, venueDbId]);
          if (!balance.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'reservation_not_found' }); }
          await client.query('COMMIT'); return json(res, 200, { ...receipt, amount: Number(receipt.amount), depositRequired: Number(balance.rows[0].depositRequired), verifiedDepositPaid: Number(balance.rows[0].verifiedDepositPaid), remaining: Math.max(0, Number(balance.rows[0].depositRequired) - Number(balance.rows[0].verifiedDepositPaid)), idempotentReplay: true });
        }
        const reservationExists=await client.query('SELECT id FROM reservations WHERE id=$1 AND venue_id=$2',[reservationPrePaymentPath[1],venueDbId]);
        if(!reservationExists.rows[0]){await client.query('ROLLBACK');return json(res,404,{error:'reservation_not_found'});}
        const shift = await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE', [venueDbId]);
        if (!shift.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'open_shift_required' }); }
        const reservation = await client.query('SELECT id,status,deposit_paid AS "legacyDepositPaid",deposit_required AS "depositRequired",verified_deposit_paid AS "verifiedDepositPaid" FROM reservations WHERE id=$1 AND venue_id=$2 FOR UPDATE', [reservationPrePaymentPath[1], venueDbId]);
        if (!reservation.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'reservation_not_found' }); }
        const lockedPrior = await client.query('SELECT id,reservation_id AS "reservationId",shift_id AS "shiftId",amount,payment_method AS method,reason,created_at AS "createdAt" FROM reservation_pre_payment_receipts WHERE venue_id=$1 AND idempotency_key=$2', [venueDbId, idempotencyKey]);
        if (lockedPrior.rows[0]) {
          const receipt = lockedPrior.rows[0];
          if (receipt.reservationId !== reservationPrePaymentPath[1] || Number(receipt.amount) !== amount || receipt.method !== method || receipt.reason !== reason) { await client.query('ROLLBACK'); return json(res, 409, { error: 'idempotency_key_reused' }); }
          const balance = await client.query('SELECT deposit_required AS "depositRequired",verified_deposit_paid AS "verifiedDepositPaid" FROM reservations WHERE id=$1 AND venue_id=$2', [receipt.reservationId, venueDbId]);
          await client.query('COMMIT'); return json(res, 200, { ...receipt, amount: Number(receipt.amount), depositRequired: Number(balance.rows[0].depositRequired), verifiedDepositPaid: Number(balance.rows[0].verifiedDepositPaid), remaining: Math.max(0, Number(balance.rows[0].depositRequired) - Number(balance.rows[0].verifiedDepositPaid)), idempotentReplay: true });
        }
        if (reservation.rows[0].status !== 'confirmed') { await client.query('ROLLBACK'); return json(res, 409, { error: 'reservation_not_confirmed' }); }
        if (Number(reservation.rows[0].legacyDepositPaid || 0) > 0) { await client.query('ROLLBACK'); return json(res, 409, { error: 'reservation_legacy_pre_payment_unreconciled', legacyAmount: Number(reservation.rows[0].legacyDepositPaid) }); }
        const remaining = Math.max(0, Number(reservation.rows[0].depositRequired || 0) - Number(reservation.rows[0].verifiedDepositPaid || 0));
        if (amount > remaining + 0.000001) { await client.query('ROLLBACK'); return json(res, 409, { error: 'reservation_pre_payment_exceeds_required', remaining }); }
        const actorId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.user?.id || '') ? req.user.id : null;
        const { rows } = await client.query('INSERT INTO reservation_pre_payment_receipts (venue_id,reservation_id,shift_id,amount,payment_method,reason,idempotency_key,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,reservation_id AS "reservationId",shift_id AS "shiftId",amount,payment_method AS method,reason,created_at AS "createdAt"', [venueDbId, reservationPrePaymentPath[1], shift.rows[0].id, amount, method, reason, idempotencyKey, actorId]);
        const receipt = rows[0];
        const updated = await client.query('UPDATE reservations SET verified_deposit_paid=verified_deposit_paid+$1 WHERE id=$2 AND venue_id=$3 AND status=\'confirmed\' AND verified_deposit_paid+$1 <= deposit_required RETURNING deposit_required AS "depositRequired",verified_deposit_paid AS "verifiedDepositPaid"', [amount, reservationPrePaymentPath[1], venueDbId]);
        if (!updated.rows[0]) throw Object.assign(new Error('reservation_pre_payment_exceeds_required'), { code: 'reservation_pre_payment_exceeds_required' });
        await client.query("INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,after_data) VALUES ($1,$2,'reservation.prepayment_received','reservation_pre_payment_receipt',$3,$4)", [venueDbId, actorId, receipt.id, { reservationId: receipt.reservationId, amount, method, reason, shiftId: receipt.shiftId, idempotencyKey }]);
        await client.query('COMMIT'); return json(res, 201, { ...receipt, amount: Number(receipt.amount), depositRequired: Number(updated.rows[0].depositRequired), verifiedDepositPaid: Number(updated.rows[0].verifiedDepositPaid), remaining: Math.max(0, Number(updated.rows[0].depositRequired) - Number(updated.rows[0].verifiedDepositPaid)) });
      } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') return json(res, 409, { error: 'idempotency_key_reused' }); if (error.code === 'reservation_pre_payment_exceeds_required') return json(res, 409, { error: error.code }); return json(res, 503, { error: 'reservation_pre_payment_failed', detail: error.message }); }
      finally { client?.release(); }
    }
    const reservation = reservations.find((entry) => entry.id === reservationPrePaymentPath[1] && entry.venueId === currentVenueId);
    if (!reservation) return json(res, 404, { error: 'reservation_not_found' });
    reservation.prepaymentReceipts ||= [];
    const prior = reservations.filter((entry) => entry.venueId === currentVenueId).flatMap((entry) => entry.prepaymentReceipts || []).find((entry) => entry.idempotencyKey === idempotencyKey);
    if (prior) { if (prior.reservationId !== reservation.id || Number(prior.amount) !== amount || prior.method !== method || prior.reason !== reason) return json(res, 409, { error: 'idempotency_key_reused' }); const paid = Number(reservation.verifiedDepositPaid || 0); return json(res, 200, { ...prior, verifiedDepositPaid: paid, depositRequired: Number(reservation.depositRequired || reservation.deposit || 0), remaining: Math.max(0, Number(reservation.depositRequired || reservation.deposit || 0) - paid), idempotentReplay: true }); }
    if (reservation.status !== 'confirmed') return json(res, 409, { error: 'reservation_not_confirmed' });
    if (Number(reservation.depositPaid || 0) > 0) return json(res, 409, { error: 'reservation_legacy_pre_payment_unreconciled', legacyAmount: Number(reservation.depositPaid) });
    const remaining = Math.max(0, Number(reservation.depositRequired ?? reservation.deposit ?? 0) - Number(reservation.verifiedDepositPaid || 0));
    if (amount > remaining + 0.000001) return json(res, 409, { error: 'reservation_pre_payment_exceeds_required', remaining });
    const shift = shifts.find((entry) => entry.venueId === currentVenueId && !entry.closedAt); if (!shift) return json(res, 409, { error: 'open_shift_required' });
    const receipt = { id: `reservation-prepay-${crypto.randomUUID()}`, reservationId: reservation.id, shiftId: shift.id, amount, method, reason, idempotencyKey, actorId: req.user?.id || null, actorName: req.user?.name || 'Сотрудник', createdAt: new Date().toISOString() };
    reservation.verifiedDepositPaid = Number(reservation.verifiedDepositPaid || 0) + amount; reservation.prepaymentReceipts.unshift(receipt);
    recordAudit(req, 'reservation.prepayment_received', 'reservation_pre_payment_receipt', receipt.id, null, receipt);
    return json(res, 201, { ...receipt, depositRequired: Number(reservation.depositRequired ?? reservation.deposit ?? 0), verifiedDepositPaid: reservation.verifiedDepositPaid, remaining: Math.max(0, Number(reservation.depositRequired ?? reservation.deposit ?? 0) - reservation.verifiedDepositPaid) });
  }
  const reservationAllocationReversal = pathname.match(/^\/api\/reservations\/([^/]+)\/prepayment-allocations\/([^/]+)\/reversals$/);
  if (reservationAllocationReversal && req.method === 'POST') {
    if (denyUnless(req, res, 'reservations')) return;
    const [, reservationId, allocationId] = reservationAllocationReversal;
    if (![reservationId, allocationId].every((id) => /^[0-9a-f-]{36}$/i.test(id))) return json(res, 400, { error: 'invalid_reservation_allocation_id' });
    const input = await body(req); const amount = Number(input.amount); const reason = String(input.reason || '').trim(); const idempotencyKey = String(input.idempotencyKey || req.headers?.['idempotency-key'] || '').trim();
    if (!validPaymentAmount(amount) || amount > 10000000) return json(res, 400, { error: 'invalid_reservation_allocation_reversal' });
    if (!reason || reason.length > 500) return json(res, 400, { error: 'reservation_allocation_reversal_reason_required' });
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) return json(res, 400, { error: 'valid_idempotency_key_required' });
    if (!repositories?.pool) return json(res, 503, { error: 'reservation_allocation_reversal_requires_database' });
    let client;
    try {
      client = await repositories.pool.connect(); await client.query('BEGIN');
      const prior = await client.query('SELECT id,reservation_id AS "reservationId",allocation_id AS "allocationId",amount,reason,shift_id AS "shiftId",created_at AS "createdAt" FROM reservation_pre_payment_allocation_reversals WHERE venue_id=$1 AND idempotency_key=$2', [venueDbId,idempotencyKey]);
      if (prior.rows[0]) { const row=prior.rows[0]; if(row.reservationId!==reservationId||row.allocationId!==allocationId||Number(row.amount)!==amount||row.reason!==reason){await client.query('ROLLBACK');return json(res,409,{error:'idempotency_key_reused'});} await client.query('COMMIT'); return json(res,200,{...row,amount:Number(row.amount),idempotentReplay:true}); }
      const allocationKey = await client.query('SELECT order_id AS "orderId" FROM reservation_pre_payment_allocations WHERE id=$1 AND venue_id=$2 AND reservation_id=$3',[allocationId,venueDbId,reservationId]);
      if (!allocationKey.rows[0]) { await client.query('ROLLBACK'); return json(res,404,{error:'reservation_allocation_not_found'}); }
      const orderLock = await client.query('SELECT id FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE',[allocationKey.rows[0].orderId,venueDbId]);
      if (!orderLock.rows[0]) { await client.query('ROLLBACK'); return json(res,404,{error:'order_not_found'}); }
      const shift = await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE',[venueDbId]);
      if (!shift.rows[0]) { await client.query('ROLLBACK'); return json(res,409,{error:'open_shift_required'}); }
      const reservation = await client.query('SELECT id,status FROM reservations WHERE id=$1 AND venue_id=$2 FOR UPDATE',[reservationId,venueDbId]);
      if (!reservation.rows[0]) { await client.query('ROLLBACK'); return json(res,404,{error:'reservation_not_found'}); }
      if (reservation.rows[0].status !== 'confirmed') { await client.query('ROLLBACK'); return json(res,409,{error:'reservation_not_confirmed'}); }
      const lockedPrior=await client.query('SELECT id,reservation_id AS "reservationId",allocation_id AS "allocationId",amount,reason,shift_id AS "shiftId",created_at AS "createdAt" FROM reservation_pre_payment_allocation_reversals WHERE venue_id=$1 AND idempotency_key=$2',[venueDbId,idempotencyKey]);
      if(lockedPrior.rows[0]){const row=lockedPrior.rows[0];if(row.reservationId!==reservationId||row.allocationId!==allocationId||Number(row.amount)!==amount||row.reason!==reason){await client.query('ROLLBACK');return json(res,409,{error:'idempotency_key_reused'});}await client.query('COMMIT');return json(res,200,{...row,amount:Number(row.amount),idempotentReplay:true});}
      const allocation = await client.query(`SELECT a.id,a.amount,a.order_id AS "orderId",a.payment_id AS "paymentId",a.shift_id AS "allocationShiftId",o.status AS "orderStatus",p.status AS "paymentStatus",p.amount AS "paymentAmount",p.method
        FROM reservation_pre_payment_allocations a JOIN orders o ON o.id=a.order_id AND o.venue_id=a.venue_id JOIN payments p ON p.order_id=a.order_id AND p.id=a.payment_id
        WHERE a.id=$1 AND a.venue_id=$2 AND a.reservation_id=$3 FOR UPDATE OF a,p`,[allocationId,venueDbId,reservationId]);
      if (!allocation.rows[0]) { await client.query('ROLLBACK'); return json(res,404,{error:'reservation_allocation_not_found'}); }
      const row=allocation.rows[0];
      if (!['open','in_progress','ready'].includes(row.orderStatus)) { await client.query('ROLLBACK'); return json(res,409,{error:'order_already_final'}); }
      if (row.method !== 'reservation' || row.paymentStatus !== 'paid' || moneyCents(row.amount) !== moneyCents(row.paymentAmount) || moneyCents(amount) !== moneyCents(row.amount)) { await client.query('ROLLBACK'); return json(res,409,{error:'reservation_allocation_not_reversible'}); }
      const actorId=/^[0-9a-f-]{36}$/i.test(req.user?.id||'')?req.user.id:null;
      const reversal=(await client.query(`INSERT INTO reservation_pre_payment_allocation_reversals (venue_id,reservation_id,allocation_id,order_id,payment_id,shift_id,amount,reason,idempotency_key,actor_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,reservation_id AS "reservationId",allocation_id AS "allocationId",order_id AS "orderId",payment_id AS "paymentId",shift_id AS "shiftId",amount,reason,idempotency_key AS "idempotencyKey",created_at AS "createdAt"`,[venueDbId,reservationId,allocationId,row.orderId,row.paymentId,shift.rows[0].id,amount,reason,idempotencyKey,actorId])).rows[0];
      const paymentUpdate=await client.query("UPDATE payments SET status='refunded' WHERE order_id=$1 AND id=$2 AND status='paid' RETURNING id",[row.orderId,row.paymentId]);
      if (!paymentUpdate.rows[0]) throw Object.assign(new Error('reservation_allocation_not_reversible'),{code:'reservation_allocation_not_reversible'});
      await client.query("INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,after_data) VALUES ($1,$2,'reservation.prepayment_allocation_reversed','reservation_pre_payment_allocation_reversal',$3,$4)",[venueDbId,actorId,reversal.id,{...reversal,amount:Number(reversal.amount),method:'reservation',cashImpact:0}]);
      await client.query('COMMIT'); return json(res,201,{...reversal,amount:Number(reversal.amount),cashImpact:0});
    } catch(error) { await client?.query('ROLLBACK').catch(()=>{}); if(error.code==='23505') { try { const prior=await repositories.pool.query('SELECT id,reservation_id AS "reservationId",allocation_id AS "allocationId",amount,reason,shift_id AS "shiftId",created_at AS "createdAt" FROM reservation_pre_payment_allocation_reversals WHERE venue_id=$1 AND idempotency_key=$2',[venueDbId,idempotencyKey]); const row=prior.rows[0]; if(row&&row.reservationId===reservationId&&row.allocationId===allocationId&&Number(row.amount)===amount&&row.reason===reason)return json(res,200,{...row,amount:Number(row.amount),idempotentReplay:true}); } catch {} return json(res,409,{error:'idempotency_key_reused'}); } if(error.code==='reservation_allocation_not_reversible')return json(res,409,{error:error.code}); return json(res,409,{error:'reservation_allocation_reversal_failed',detail:error.message}); }
    finally { client?.release(); }
  }
  const reservationReceiptReversal = pathname.match(/^\/api\/reservations\/([^/]+)\/deposit-receipts\/([^/]+)\/reversals$/);
  if (reservationReceiptReversal && req.method === 'POST') {
    if (!['owner','admin'].includes(req.user?.role) || !hasPermission(req,'finance')) return json(res,403,{error:'external_payout_requires_owner_admin_finance'});
    const [, reservationId, receiptId] = reservationReceiptReversal;
    if (![reservationId,receiptId].every((id)=>/^[0-9a-f-]{36}$/i.test(id))) return json(res,400,{error:'invalid_reservation_receipt_id'});
    const input=await body(req); const amount=Number(input.amount); const method=String(input.method||''); const reason=String(input.reason||'').trim(); const idempotencyKey=String(input.idempotencyKey||req.headers?.['idempotency-key']||'').trim();
    if(!validPaymentAmount(amount)||amount>10000000||!['cash','card','qr'].includes(method))return json(res,400,{error:'invalid_reservation_pre_payment_refund'});
    if(!reason||reason.length>500)return json(res,400,{error:'reservation_pre_payment_refund_reason_required'});
    if(!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey))return json(res,400,{error:'valid_idempotency_key_required'});
    if(!repositories?.pool)return json(res,503,{error:'reservation_pre_payment_refund_requires_database'});
    let client;
    try{
      client=await repositories.pool.connect();await client.query('BEGIN');
      const prior=await client.query('SELECT id,reservation_id AS "reservationId",receipt_id AS "receiptId",shift_id AS "shiftId",amount,payout_method AS method,reason,created_at AS "createdAt" FROM reservation_pre_payment_receipt_reversals WHERE venue_id=$1 AND idempotency_key=$2',[venueDbId,idempotencyKey]);
      if(prior.rows[0]){const row=prior.rows[0];if(row.reservationId!==reservationId||row.receiptId!==receiptId||Number(row.amount)!==amount||row.method!==method||row.reason!==reason){await client.query('ROLLBACK');return json(res,409,{error:'idempotency_key_reused'});}await client.query('COMMIT');return json(res,200,{...row,amount:Number(row.amount),idempotentReplay:true});}
      const shift=await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE',[venueDbId]);
      if(!shift.rows[0]){await client.query('ROLLBACK');return json(res,409,{error:'open_shift_required'});}
      const reservation=await client.query('SELECT id,status,verified_deposit_paid AS "verifiedDepositPaid" FROM reservations WHERE id=$1 AND venue_id=$2 FOR UPDATE',[reservationId,venueDbId]);
      if(!reservation.rows[0]){await client.query('ROLLBACK');return json(res,404,{error:'reservation_not_found'});}
      const lockedPrior=await client.query('SELECT id,reservation_id AS "reservationId",receipt_id AS "receiptId",shift_id AS "shiftId",amount,payout_method AS method,reason,created_at AS "createdAt" FROM reservation_pre_payment_receipt_reversals WHERE venue_id=$1 AND idempotency_key=$2',[venueDbId,idempotencyKey]);
      if(lockedPrior.rows[0]){const row=lockedPrior.rows[0];if(row.reservationId!==reservationId||row.receiptId!==receiptId||Number(row.amount)!==amount||row.method!==method||row.reason!==reason){await client.query('ROLLBACK');return json(res,409,{error:'idempotency_key_reused'});}await client.query('COMMIT');return json(res,200,{...row,amount:Number(row.amount),idempotentReplay:true});}
      const receipt=await client.query('SELECT id,amount FROM reservation_pre_payment_receipts WHERE id=$1 AND venue_id=$2 AND reservation_id=$3 FOR UPDATE',[receiptId,venueDbId,reservationId]);
      if(!receipt.rows[0]){await client.query('ROLLBACK');return json(res,404,{error:'reservation_pre_payment_receipt_not_found'});}
      const activeAllocations=await client.query('SELECT 1 FROM reservation_pre_payment_allocations a LEFT JOIN reservation_pre_payment_allocation_reversals ar ON ar.venue_id=a.venue_id AND ar.allocation_id=a.id WHERE a.venue_id=$1 AND a.receipt_id=$2 AND ar.id IS NULL LIMIT 1',[venueDbId,receiptId]);
      if(activeAllocations.rows[0]){await client.query('ROLLBACK');return json(res,409,{error:'reservation_pre_payment_allocation_reversal_required'});}
      const balances=await client.query(`SELECT
        (SELECT COALESCE(SUM(a.amount),0) FROM reservation_pre_payment_allocations a WHERE a.venue_id=$1 AND a.receipt_id=$2) AS allocated,
        (SELECT COALESCE(SUM(ar.amount),0) FROM reservation_pre_payment_allocation_reversals ar JOIN reservation_pre_payment_allocations a ON a.venue_id=ar.venue_id AND a.id=ar.allocation_id WHERE ar.venue_id=$1 AND a.receipt_id=$2) AS allocation_reversed,
        (SELECT COALESCE(SUM(rr.amount),0) FROM reservation_pre_payment_receipt_reversals rr WHERE rr.venue_id=$1 AND rr.receipt_id=$2) AS refunded`,[venueDbId,receiptId]);
      const b=balances.rows[0]||{};
      const available=roundMoney(Math.max(0,Number(receipt.rows[0].amount)-Number(b.allocated||0)+Number(b.allocation_reversed||0)-Number(b.refunded||0)));
      if(amount>available+0.000001){await client.query('ROLLBACK');return json(res,409,{error:'reservation_pre_payment_refund_exceeds_available',available});}
      const actorId=/^[0-9a-f-]{36}$/i.test(req.user?.id||'')?req.user.id:null;
      const reversal=(await client.query(`INSERT INTO reservation_pre_payment_receipt_reversals (venue_id,reservation_id,receipt_id,shift_id,amount,payout_method,reason,idempotency_key,actor_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,reservation_id AS "reservationId",receipt_id AS "receiptId",shift_id AS "shiftId",amount,payout_method AS method,reason,idempotency_key AS "idempotencyKey",created_at AS "createdAt"`,[venueDbId,reservationId,receiptId,shift.rows[0].id,amount,method,reason,idempotencyKey,actorId])).rows[0];
      const updated=await client.query('UPDATE reservations SET verified_deposit_paid=verified_deposit_paid-$1 WHERE id=$2 AND venue_id=$3 AND verified_deposit_paid >= $1 RETURNING verified_deposit_paid AS "verifiedDepositPaid"',[amount,reservationId,venueDbId]);
      if(!updated.rows[0])throw Object.assign(new Error('reservation_pre_payment_balance_mismatch'),{code:'reservation_pre_payment_balance_mismatch'});
      await client.query("INSERT INTO audit_events (venue_id,actor_id,action,entity_type,entity_id,after_data) VALUES ($1,$2,'reservation.prepayment_refunded','reservation_pre_payment_receipt_reversal',$3,$4)",[venueDbId,actorId,reversal.id,{...reversal,amount:Number(reversal.amount),originalReceiptId:receiptId,method,cashImpact:method==='cash'?-amount:0}]);
      await client.query('COMMIT');return json(res,201,{...reversal,amount:Number(reversal.amount),verifiedDepositPaid:Number(updated.rows[0].verifiedDepositPaid),remainingOnReceipt:roundMoney(available-amount),cashImpact:method==='cash'?-amount:0});
    }catch(error){await client?.query('ROLLBACK').catch(()=>{});if(error.code==='23505'){try{const prior=await repositories.pool.query('SELECT id,reservation_id AS "reservationId",receipt_id AS "receiptId",shift_id AS "shiftId",amount,payout_method AS method,reason,created_at AS "createdAt" FROM reservation_pre_payment_receipt_reversals WHERE venue_id=$1 AND idempotency_key=$2',[venueDbId,idempotencyKey]);const row=prior.rows[0];if(row&&row.reservationId===reservationId&&row.receiptId===receiptId&&Number(row.amount)===amount&&row.method===method&&row.reason===reason)return json(res,200,{...row,amount:Number(row.amount),idempotentReplay:true});}catch{}return json(res,409,{error:'idempotency_key_reused'});}if(error.code==='reservation_pre_payment_balance_mismatch')return json(res,409,{error:error.code});return json(res,409,{error:'reservation_pre_payment_refund_failed',detail:error.message});}
    finally{client?.release();}
  }
  if (pathname.startsWith('/api/reservations/') && req.method === 'POST' && pathname.endsWith('/cancel')) {
    if (denyUnless(req, res, 'reservations')) return;
    const reservationId = pathname.split('/')[3];
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(reservationId)) {
      let client;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        const locked = await client.query('SELECT id FROM reservations WHERE id=$1 AND venue_id=$2 AND status=\'confirmed\' FOR UPDATE',[reservationId,venueDbId]);
        if (!locked.rows[0]) { await client.query('ROLLBACK'); return json(res,404,{error:'reservation_not_found_or_cancelled'}); }
        const applied = await client.query('SELECT 1 FROM reservation_pre_payment_allocations a LEFT JOIN reservation_pre_payment_allocation_reversals ar ON ar.venue_id=a.venue_id AND ar.allocation_id=a.id WHERE a.venue_id=$1 AND a.reservation_id=$2 AND ar.id IS NULL LIMIT 1',[venueDbId,reservationId]);
        if (applied.rows[0]) { await client.query('ROLLBACK'); return json(res,409,{error:'reservation_pre_payment_already_applied'}); }
        const outstanding=await client.query(`SELECT COALESCE(SUM(GREATEST(0,p.amount-COALESCE(a.amount,0)+COALESCE(ar.amount,0)-COALESCE(rr.amount,0))),0) AS amount
          FROM reservation_pre_payment_receipts p
          LEFT JOIN LATERAL (SELECT SUM(x.amount) AS amount FROM reservation_pre_payment_allocations x WHERE x.venue_id=p.venue_id AND x.receipt_id=p.id) a ON true
          LEFT JOIN LATERAL (SELECT SUM(x.amount) AS amount FROM reservation_pre_payment_allocation_reversals x JOIN reservation_pre_payment_allocations ax ON ax.venue_id=x.venue_id AND ax.id=x.allocation_id WHERE x.venue_id=p.venue_id AND ax.receipt_id=p.id) ar ON true
          LEFT JOIN LATERAL (SELECT SUM(x.amount) AS amount FROM reservation_pre_payment_receipt_reversals x WHERE x.venue_id=p.venue_id AND x.receipt_id=p.id) rr ON true
          WHERE p.venue_id=$1 AND p.reservation_id=$2`,[venueDbId,reservationId]);
        if(Number(outstanding.rows[0]?.amount||0)>0.000001){await client.query('ROLLBACK');return json(res,409,{error:'reservation_pre_payment_refund_required',outstanding:Number(outstanding.rows[0].amount)});}
        const { rows } = await client.query(`UPDATE reservations SET status='cancelled' WHERE id=$1 AND venue_id=$2 AND status='confirmed' RETURNING id,table_id AS "tableId",starts_at AS "startsAt",status`, [reservationId, venueDbId]);
        if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'reservation_not_found_or_cancelled' }); }
        await client.query(`UPDATE tables t SET status=CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.table_id=$1 AND o.venue_id=$2 AND o.status IN ('open','in_progress','ready')) THEN 'occupied'::table_status ELSE 'free'::table_status END FROM zones z WHERE t.id=$1 AND t.zone_id=z.id AND z.venue_id=$2 AND t.status <> 'blocked' AND NOT EXISTS (SELECT 1 FROM reservations WHERE table_id=$1 AND venue_id=$2 AND status='confirmed' AND starts_at::date=$3::date)`, [rows[0].tableId, venueDbId, rows[0].startsAt]);
        await client.query('COMMIT');
        recordAudit(req, 'reservation.cancelled', 'reservation', rows[0].id, { status: 'confirmed' }, rows[0]);
        return json(res, 200, rows[0]);
      } catch (error) { await client?.query('ROLLBACK').catch(()=>{}); return json(res, 409, { error: 'reservation_cancel_failed', detail: error.message }); } finally { client?.release(); }
    }
    const reservation = reservations.find((entry) => entry.id === pathname.split('/')[3] && entry.venueId === currentVenueId);
    if (!reservation) return json(res, 404, { error: 'reservation_not_found' });
    if ((reservation.prepaymentAllocations || []).length) return json(res,409,{error:'reservation_pre_payment_already_applied'});
    const memoryPrepaymentOutstanding = Math.max(0, Number(reservation.verifiedDepositPaid || 0) - (reservation.prepaymentRefunds || []).reduce((sum, entry) => sum + Number(entry.amount || 0), 0));
    if (memoryPrepaymentOutstanding > 0) return json(res,409,{error:'reservation_pre_payment_refund_required',outstanding:memoryPrepaymentOutstanding});
    reservation.status = 'cancelled';
    const stillReserved = reservations.some((entry) => entry.id !== reservation.id && entry.status === 'confirmed' && entry.tableId === reservation.tableId && entry.date === reservation.date);
    if (!stillReserved) { const activeOrder = orders.some((order) => order.tableId === reservation.tableId && ['open', 'in_progress', 'ready'].includes(order.status)); setMemoryTableStatus(reservation.tableId, activeOrder ? 'occupied' : 'free'); }
    recordAudit(req, 'reservation.cancelled', 'reservation', reservation.id, { status: 'confirmed' }, reservation);
    return json(res, 200, reservation);
  }
  if (pathname === '/api/orders' && req.method === 'GET') {
    if (denyUnless(req, res, 'orders')) return;
    const requestedDate = url.searchParams.get('date');
    const validDate = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : null;
    const attentionOnly = url.searchParams.get('attention') === '1';
    const needsAttention = (order) => orderAttentionReasons(order).length > 0;
    if (orderRepository) {
      try { const result = await orderRepository.listOpen(venueDbId, url.searchParams.get('scope') === 'all'); const items = (attentionOnly ? result.filter(needsAttention) : result).filter((order) => !validDate || String(order.createdAt || '').slice(0, 10) === validDate).map((order) => ({ ...order, attentionReasons: orderAttentionReasons(order) })); return json(res, 200, { items }); } catch (_) { return json(res, 503, { error: 'database_unavailable' }); }
    }
    const tableNames = new Map(floor.flatMap((zone) => zone.tables || []).map((table) => [table.id, table.name]));
    const withAttention = (order) => {
      const finalTotal = order.finalTotalSnapshot ?? order.finalTotal ?? null;
      const paid = receivedOrderPayments(order);
      const attentionPaymentDue = finalTotal === null || !Number.isFinite(Number(finalTotal))
        ? null : Math.max(0, Math.round((Number(finalTotal) - paid) * 100) / 100);
      const result = { ...order, attentionPaymentDue, tableName: tableNames.get(order.tableId) || order.tableName || null };
      return { ...result, attentionReasons: orderAttentionReasons(result) };
    };
    return json(res, 200, { items: (attentionOnly ? orders.filter((order) => needsAttention(withAttention(order))) : orders).filter((order) => !validDate || String(order.createdAt || '').slice(0, 10) === validDate).map(withAttention) });
  }
  if (pathname === '/api/orders' && req.method === 'POST') {
    if (denyUnless(req, res, 'orders')) return;
    if (await requireOpenShift(req, res)) return;
    const input = await body(req);
    if (input.reservationId && denyUnless(req,res,'reservations')) return;
    if (!input.tableId || typeof input.tableId !== 'string' || input.tableId.length > 80) return json(res, 400, { error: 'table_id_required' });
    const requestedMinimumOrderTotal = Number(input.minimumOrderTotal || 0);
    if (!Number.isFinite(requestedMinimumOrderTotal) || requestedMinimumOrderTotal < 0) return json(res, 400, { error: 'invalid_vip_minimum' });
    if (repositories?.orders) {
      try {
        const openedBy = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : '20000000-0000-0000-0000-000000000001';
        const persisted = await repositories.orders.create({ venueId: venueDbId, tableId: input.tableId, openedBy, reservationId: input.reservationId, guestId: input.guestId, vipMinimum: requestedMinimumOrderTotal, notes: input.notes });
        recordAudit(req, 'order.created', 'order', persisted.id, null, persisted);
        return json(res, 201, { ...persisted, items: [] });
      } catch (error) { if (['reservation_not_found','reservation_not_confirmed','reservation_legacy_pre_payment_unreconciled','reservation_table_mismatch','reservation_guest_mismatch','reservation_already_linked'].includes(error.message)) return json(res, error.message==='reservation_not_found'?404:409,{error:error.message}); return json(res, 409, { error: 'order_create_failed', detail: error.message }); }
    }
    if (input.tableId && orders.some((entry) => entry.tableId === input.tableId && ['open', 'in_progress', 'ready'].includes(entry.status))) return json(res, 409, { error: 'table_has_active_order' });
    const selectedMemoryTable = floor.flatMap((zone) => zone.tables || []).find((table) => table.id === input.tableId);
    if (!selectedMemoryTable || selectedMemoryTable.archivedAt) return json(res, 409, { error: 'table_not_found_or_unavailable' });
    const tableMinimum = selectedMemoryTable.minimumOrderTotal || 0;
    const minimumOrderTotal = Math.max(requestedMinimumOrderTotal, Number(tableMinimum));
    let linkedReservation = null;
    if (input.reservationId) { linkedReservation = reservations.find((entry) => entry.id === input.reservationId && entry.venueId === currentVenueId); if (!linkedReservation) return json(res,404,{error:'reservation_not_found'}); if (linkedReservation.status !== 'confirmed') return json(res,409,{error:'reservation_not_confirmed'}); if (String(linkedReservation.tableId)!==String(input.tableId)) return json(res,409,{error:'reservation_table_mismatch'}); if(input.guestId&&String(input.guestId)!==String(linkedReservation.clientId||''))return json(res,409,{error:'reservation_guest_mismatch'}); if(orders.some((entry)=>entry.reservationId===linkedReservation.id))return json(res,409,{error:'reservation_already_linked'}); }
    const activeRedemptionSettings=loyaltyProgramSettings.get(String(currentVenueId))||{version:0,maxRedemptionPercent:100,minimumRedemptionPoints:1};
    const orderGuest = clients.find((entry) => entry.id === (linkedReservation?.clientId || input.guestId) && entry.venueId === currentVenueId);
    const orderGuestGroup = discountGroups.find((entry) => entry.id === orderGuest?.discountGroupId && entry.venueId === currentVenueId && entry.active);
    const order = { id: `ord-${Date.now()}`, venueId: currentVenueId, tableId: input.tableId || null, reservationId: linkedReservation?.id || null, clientId: linkedReservation?.clientId || orderGuest?.id || null, guestId: linkedReservation?.clientId || orderGuest?.id || null, guestName: linkedReservation?.guestName || orderGuest?.name || '', guestPhone: linkedReservation?.phone || '', groupDiscountGroupId: orderGuestGroup?.id || null, groupDiscountName: orderGuestGroup?.name || null, groupDiscountPercent: orderGuestGroup ? Number(orderGuestGroup.discountPercent || 0) : null, groupDiscountBase: null, groupDiscountAmount: null, status: 'open', orderType: input.orderType || 'regular', minimumOrderTotal, notes: input.notes || '', items: [], createdByName: req.user?.name || 'сотрудник', openedBy: req.user?.id || null, loyaltyRedemptionPolicyVersion:Number(activeRedemptionSettings.version||0),loyaltyRedemptionRate:1,loyaltyRedemptionCapPercent:Number(activeRedemptionSettings.maxRedemptionPercent??100),loyaltyRedemptionMinPoints:Number(activeRedemptionSettings.minimumRedemptionPoints??1),loyaltyRedemptionBase:null,createdAt: new Date().toISOString() };
    orders.push(order);
    setMemoryTableStatus(order.tableId, 'occupied');
    recordAudit(req, 'order.created', 'order', order.id, null, order);
    return json(res, 201, order);
  }
  const orderEdit = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderEdit && req.method === 'PATCH') {
    if (denyUnless(req, res, 'orders')) return;
    if (await requireOpenShift(req, res)) return;
    const input = await body(req); if (input.notes === undefined && input.guestName === undefined && input.phone === undefined && input.clientId === undefined) return json(res, 400, { error: 'supported_fields_required' });
    if (input.clientId !== undefined && input.clientId !== null && String(input.clientId).length > 120) return json(res, 400, { error: 'invalid_client_id' });
    if (input.phone !== undefined && input.phone && !/^\+7[0-9 ()-]{7,24}$/.test(String(input.phone).trim())) return json(res, 400, { error: 'invalid_guest_phone' });
    if (input.guestName !== undefined && String(input.guestName).trim().length > 120) return json(res, 400, { error: 'guest_name_too_long' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(orderEdit[1])) {
      let client;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        const { rows: currentRows } = await client.query('SELECT status,pricing_locked_at AS "pricingLockedAt",guest_id AS "guestId",vip_minimum AS "minimumOrderTotal" FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [orderEdit[1], venueDbId]);
        if (!currentRows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_not_found' }); }
        if (!['open', 'in_progress', 'ready'].includes(currentRows[0].status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_not_editable' }); }
        const { rows: shiftRows } = await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE', [venueDbId]);
        if (!shiftRows[0] && employeeNeedsShift(req)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'active_shift_required', message: 'Откройте смену перед началом работы' }); }
        let guest = null; const guestWasSpecified = input.clientId !== undefined || input.guestName !== undefined || input.phone !== undefined || input.detachGuest === true;
        if (input.clientId !== undefined && input.clientId !== null && String(input.clientId).trim()) {
          const { rows } = await client.query('SELECT id,phone,full_name AS "name" FROM guests WHERE id=$1 AND venue_id=$2', [String(input.clientId), venueDbId]);
          if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'client_not_found' }); }
          guest = rows[0];
        } else if (input.guestName !== undefined || input.phone !== undefined) {
          const { rows } = await client.query(`INSERT INTO guests (venue_id,phone,full_name) VALUES ($1,$2,$3) ON CONFLICT (venue_id,phone) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id,phone,full_name AS "name"`, [venueDbId, String(input.phone || '').trim() || null, String(input.guestName || '').trim() || null]);
          guest = rows[0];
        }
        const nextGuestId = input.detachGuest === true || (input.clientId === null && input.guestName === undefined && input.phone === undefined) ? null : guest?.id ?? currentRows[0].guestId;
        if (guestWasSpecified && String(nextGuestId || '') !== String(currentRows[0].guestId || '')) {
          const existingPricing = await pgOrderPricing(client, orderEdit[1], currentRows[0].minimumOrderTotal);
          if (existingPricing.paid > 0 || currentRows[0].pricingLockedAt) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: currentRows[0].pricingLockedAt || null }); }
          let group = null;
          if (nextGuestId) { const { rows } = await client.query(`SELECT dg.id AS "groupId",dg.name AS "groupName",dg.discount_percent AS "discountPercent" FROM guests g LEFT JOIN guest_discount_groups dg ON dg.id=g.discount_group_id AND dg.venue_id=g.venue_id AND dg.active=true WHERE g.id=$1 AND g.venue_id=$2`, [nextGuestId, venueDbId]); group = rows[0] || null; }
          await client.query('UPDATE orders SET guest_id=$1,group_discount_group_id=$2,group_discount_name=$3,group_discount_percent=$4,group_discount_base=NULL,group_discount_amount=NULL WHERE id=$5 AND venue_id=$6', [nextGuestId, group?.groupId || null, group?.groupName || null, group?.discountPercent ?? null, orderEdit[1], venueDbId]);
          const nextPricing = await pgOrderPricing(client, orderEdit[1], currentRows[0].minimumOrderTotal);
          if (orderBalanceConflict(nextPricing)) { await client.query('ROLLBACK'); return json(res, 409, orderBalanceConflictBody(nextPricing)); }
        }
        if (input.notes !== undefined) await client.query('UPDATE orders SET notes=$1 WHERE id=$2 AND venue_id=$3', [String(input.notes).slice(0, 2000), orderEdit[1], venueDbId]);
        const { rows } = await client.query(`SELECT o.id,o.notes,o.guest_id AS "guestId",g.phone,g.full_name AS "guestName",o.group_discount_group_id AS "groupDiscountGroupId",o.group_discount_name AS "groupDiscountName",o.group_discount_percent AS "groupDiscountPercent" FROM orders o LEFT JOIN guests g ON g.id=o.guest_id WHERE o.id=$1 AND o.venue_id=$2`, [orderEdit[1], venueDbId]);
        const pricing = await pgOrderPricing(client, orderEdit[1], currentRows[0].minimumOrderTotal);
        await client.query('COMMIT');
        const response = { ...rows[0], ...pricing, groupDiscountPercent: rows[0].groupDiscountPercent === null ? null : Number(rows[0].groupDiscountPercent) };
        recordAudit(req, guestWasSpecified ? 'order.guest_updated' : 'order.notes_updated', 'order', rows[0].id, null, response); return json(res, 200, response);
      } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'order_update_failed', detail: error.message }); } finally { client?.release(); }
    }
    const order = orders.find((entry) => entry.id === orderEdit[1]); if (!order) return json(res, 404, { error: 'order_not_found' }); if (!['open', 'in_progress', 'ready'].includes(order.status)) return json(res, 409, { error: 'order_not_editable' });
    const linkedClient = input.clientId !== undefined && input.clientId !== null && String(input.clientId).trim() ? clients.find((entry) => entry.id === String(input.clientId)) : null;
    if (input.clientId !== undefined && input.clientId !== null && String(input.clientId).trim() && !linkedClient) return json(res, 404, { error: 'client_not_found' });
    const guestWasSpecified = input.clientId !== undefined || input.guestName !== undefined || input.phone !== undefined || input.detachGuest === true;
    const nextGuestId = input.detachGuest === true || (input.clientId === null && input.guestName === undefined && input.phone === undefined) || (input.clientId === undefined && (input.guestName !== undefined || input.phone !== undefined)) ? null : linkedClient?.id ?? order.clientId ?? null;
    if (guestWasSpecified && String(nextGuestId || '') !== String(order.clientId || '') && (receivedOrderPayments(order) > 0 || order.pricingLockedAt)) return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: order.pricingLockedAt || null });
    const beforeGuest = { clientId: order.clientId || null, guestName: order.guestName || '', guestPhone: order.guestPhone || '', groupDiscountGroupId: order.groupDiscountGroupId || null, groupDiscountName: order.groupDiscountName || null, groupDiscountPercent: order.groupDiscountPercent ?? null, groupDiscountBase: order.groupDiscountBase ?? null, groupDiscountAmount: order.groupDiscountAmount ?? null };
    if (input.notes !== undefined) order.notes = String(input.notes).slice(0, 2000);
    if (guestWasSpecified) {
      if (linkedClient) { order.clientId = linkedClient.id; order.guestName = linkedClient.name; order.guestPhone = linkedClient.phoneNumbers?.find((phone) => phone.primary)?.number || linkedClient.phoneNumbers?.[0]?.number || ''; }
      else if (input.detachGuest === true || (input.clientId === null && input.guestName === undefined && input.phone === undefined)) { order.clientId = null; order.guestName = ''; order.guestPhone = ''; }
      else if (input.guestName !== undefined || input.phone !== undefined) { order.clientId = null; order.guestName = String(input.guestName || '').trim(); order.guestPhone = String(input.phone || '').trim(); }
      if (String(nextGuestId || '') !== String(beforeGuest.clientId || '')) { const group = discountGroups.find((entry) => entry.id === linkedClient?.discountGroupId && entry.active); order.groupDiscountGroupId = group?.id || null; order.groupDiscountName = group?.name || null; order.groupDiscountPercent = group ? Number(group.discountPercent || 0) : null; order.groupDiscountBase = null; order.groupDiscountAmount = null; }
      const pricing = memoryOrderPricing(order); if (orderBalanceConflict({ due: pricing.due, paid: receivedOrderPayments(order) })) { Object.assign(order, beforeGuest); return json(res, 409, orderBalanceConflictBody({ due: pricing.due, paid: receivedOrderPayments(order) })); }
    }
    const pricing = memoryOrderPricing(order);
    recordAudit(req, guestWasSpecified ? 'order.guest_updated' : 'order.notes_updated', 'order', order.id, null, { notes: order.notes, clientId: order.clientId || null, guestName: order.guestName, guestPhone: order.guestPhone, ...pricing }); return json(res, 200, { ...order, ...pricing });
  }
  const orderDelete = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderDelete && req.method === 'DELETE') {
    if (denyUnless(req, res, 'orders')) return;
    if (await requireOpenShift(req, res)) return;
    const input = await body(req); const comment = String(input.comment || input.reason || '').trim();
    if (!comment || comment.length > 1000) return json(res, 400, { error: 'order_delete_comment_required' });
    if (typeof input.writeoff !== 'boolean') return json(res, 400, { error: 'order_delete_writeoff_required' });
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(orderDelete[1])) {
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: orderRows } = await client.query('SELECT id,status,table_id AS "tableId",notes FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [orderDelete[1], venueDbId]);
        const persisted = orderRows[0]; if (!persisted) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_not_found' }); }
        if (!['open', 'in_progress', 'ready'].includes(persisted.status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_not_deletable', status: persisted.status }); }
        const deleteBalance = await pgOrderBalance(client, orderDelete[1]);
        if (Math.round(deleteBalance.paid * 100) > 0) { await client.query('ROLLBACK'); return json(res, 409, { error: 'paid_order_cannot_cancel', paid: deleteBalance.paid }); }
        const { rows: itemRows } = await client.query('SELECT oi.id,oi.product_id AS "productId",p.name,oi.quantity,oi.unit_price AS "unitPrice" FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 ORDER BY oi.id', [orderDelete[1]]);
        let depletion = { totalCost: 0 };
        if (input.writeoff) depletion = await depleteRecipeForOrder(repositories.pool, orderDelete[1], venueDbId, req.user?.id, client);
        const note = `${String(persisted.notes || '').trim()}${persisted.notes ? '\n' : ''}Удаление: ${comment}`.slice(0, 4000);
        const { rows } = await client.query('UPDATE orders SET status=\'cancelled\',closed_at=COALESCE(closed_at,now()),notes=$1 WHERE id=$2 AND venue_id=$3 AND status IN (\'open\',\'in_progress\',\'ready\') RETURNING id,status,table_id AS "tableId",notes,closed_at AS "closedAt"', [note, orderDelete[1], venueDbId]);
        if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_not_deletable' }); }
        if (persisted.tableId) await client.query(`UPDATE tables t SET status=CASE WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.table_id=$1 AND r.venue_id=$2 AND r.status='confirmed' AND r.starts_at::date=CURRENT_DATE) THEN 'reserved'::table_status ELSE 'free'::table_status END FROM zones z WHERE t.id=$1 AND t.zone_id=z.id AND z.venue_id=$2 AND t.status <> 'blocked' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id=$1 AND o.venue_id=$2 AND o.status IN ('open','in_progress','ready'))`, [persisted.tableId, venueDbId]);
        await client.query('COMMIT');
        const notification = { type: 'order_deleted', orderId: rows[0].id, comment, writeoff: Boolean(input.writeoff), deletedItems: itemRows, totalCost: Number(depletion.totalCost || 0), createdAt: new Date().toISOString(), notificationRecipients: ['owner', 'admin', 'manager'] };
        recordAudit(req, 'order.deleted', 'order', rows[0].id, { status: persisted.status, items: itemRows }, { ...rows[0], ...notification });
        return json(res, 200, { ...rows[0], deleted: true, comment, writeoff: Boolean(input.writeoff), totalCost: Number(depletion.totalCost || 0), notification });
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (['product_inventory_mode_required','product_recipe_required','product_recipe_ambiguous','product_inventory_mode_invalid'].includes(error.code || error.message)) return json(res, 409, { error: error.code || error.message, productId: error.productId, productName: error.productName }); return json(res, 409, { error: error.message === 'insufficient_recipe_stock' ? 'insufficient_recipe_stock' : 'order_delete_failed', missing: error.missing, detail: error.message }); } finally { client.release(); }
    }
    const order = orders.find((entry) => entry.id === orderDelete[1]);
    if (!order) return json(res, 404, { error: 'order_not_found' });
    if (!['open', 'in_progress', 'ready'].includes(order.status)) return json(res, 409, { error: 'order_not_deletable', status: order.status });
    if (Math.round(receivedOrderPayments(order) * 100) > 0) return json(res, 409, { error: 'paid_order_cannot_cancel', paid: receivedOrderPayments(order) });
    let depletion = { totalCost: 0 };
    try { if (input.writeoff) depletion = depleteMemoryOrder(order); } catch (error) { if (['product_inventory_mode_required','product_recipe_required','product_recipe_ambiguous','product_inventory_mode_invalid'].includes(error.code || error.message)) return json(res, 409, { error: error.code || error.message, productId: error.productId, productName: error.productName }); return json(res, 409, { error: error.message === 'insufficient_recipe_stock' ? 'insufficient_recipe_stock' : 'order_delete_failed', missing: error.missing, detail: error.message }); }
    const notification = { type: 'order_deleted', orderId: order.id, comment, writeoff: Boolean(input.writeoff), deletedItems: order.items || [], totalCost: Number(depletion.totalCost || 0), createdAt: new Date().toISOString(), notificationRecipients: ['owner', 'admin', 'manager'] };
    order.status = 'cancelled'; order.notes = `${String(order.notes || '').trim()}${order.notes ? '\n' : ''}Удаление: ${comment}`.slice(0, 4000); order.closedAt = notification.createdAt;
    releaseMemoryTableIfIdle(order.tableId); staffNotifications.push({ id: `order-deleted-${crypto.randomUUID()}`, venueId: notificationVenueScope(req, venueDbId), ...notification }); recordAudit(req, 'order.deleted', 'order', order.id, { status: 'open', items: order.items || [] }, notification);
    return json(res, 200, { ...order, deleted: true, comment, writeoff: Boolean(input.writeoff), totalCost: Number(depletion.totalCost || 0), notification });
  }
  const orderAction = pathname.match(/^\/api\/orders\/([^/]+)\/(status|transfer)$/);
  if (orderAction && req.method === 'POST') {
    if (denyUnless(req, res, 'orders')) return;
    if (await requireOpenShift(req, res)) return;
    const input = await body(req);
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(orderAction[1])) {
      try {
        if (orderAction[2] === 'status') {
          const allowed = ['open', 'in_progress', 'ready', 'closed', 'cancelled'];
          if (!allowed.includes(input.status)) return json(res, 400, { error: 'invalid_order_status' });
          if (input.status === 'closed') return json(res, 409, { error: 'order_close_requires_payment', action: 'POST /api/orders/:id/close' });
            let client;
            try {
              client = await repositories.pool.connect();
              await client.query('BEGIN');
              const { rows: currentRows } = await client.query('SELECT id,status,table_id AS "tableId" FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [orderAction[1], venueDbId]);
              if (!currentRows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_not_found' }); }
              if (!validOrderTransition(currentRows[0].status, input.status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'invalid_order_transition', from: currentRows[0].status, to: input.status }); }
              if (input.status === 'cancelled') { const balance = await pgOrderBalance(client, orderAction[1]); if (Math.round(balance.paid * 100) > 0) { await client.query('ROLLBACK'); return json(res, 409, { error: 'paid_order_cannot_cancel', paid: balance.paid }); } }
              const updateOrderStatusSql = input.status === 'cancelled'
                ? 'UPDATE orders SET status=$1,closed_at=COALESCE(closed_at,now()) WHERE id=$2 AND venue_id=$3 AND status=$4 RETURNING id,status,table_id AS "tableId"'
                : 'UPDATE orders SET status=$1 WHERE id=$2 AND venue_id=$3 AND status=$4 RETURNING id,status,table_id AS "tableId"';
              const { rows } = await client.query(updateOrderStatusSql, [input.status, orderAction[1], venueDbId, currentRows[0].status]);
              if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_state_changed' }); }
              if (['closed', 'cancelled'].includes(input.status) && rows[0].tableId) await client.query(`UPDATE tables t SET status=CASE WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.table_id=$1 AND r.venue_id=$2 AND r.status='confirmed' AND r.starts_at::date=CURRENT_DATE) THEN 'reserved'::table_status ELSE 'free'::table_status END FROM zones z WHERE t.id=$1 AND t.zone_id=z.id AND z.venue_id=$2 AND t.status <> 'blocked' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id=$1 AND o.venue_id=$2 AND o.status IN ('open','in_progress','ready'))`, [rows[0].tableId, venueDbId]);
              await client.query('COMMIT');
              recordAudit(req, 'order.status_changed', 'order', rows[0].id, { status: currentRows[0].status, tableId: rows[0].tableId }, rows[0]); return json(res, 200, rows[0]);
            } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client?.release(); }
        }
        if (typeof input.tableId !== 'string' || !input.tableId.trim() || input.tableId.length > 80) return json(res, 400, { error: 'table_id_required' });
        let client;
        try {
          client = await repositories.pool.connect();
          await client.query('BEGIN');
          const { rows: beforeRows } = await client.query('SELECT id,status,table_id AS "tableId" FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [orderAction[1], venueDbId]);
          if (!beforeRows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_not_found' }); }
          if (!['open', 'in_progress', 'ready'].includes(beforeRows[0].status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_not_transferable' }); }
          const targetTable = await client.query("SELECT t.id FROM tables t JOIN zones z ON z.id=t.zone_id WHERE t.id=$1 AND z.venue_id=$2 AND t.status <> 'blocked' AND t.archived_at IS NULL FOR UPDATE OF t", [input.tableId, venueDbId]);
          if (!targetTable.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'target_table_not_found' }); }
          const occupied = await client.query(`SELECT id FROM orders WHERE venue_id=$1 AND table_id=$2 AND id<>$3 AND status IN ('open','in_progress','ready') LIMIT 1`, [venueDbId, input.tableId, orderAction[1]]);
          if (occupied.rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'target_table_has_active_order' }); }
          const { rows } = await client.query('UPDATE orders SET table_id=$1 WHERE id=$2 AND venue_id=$3 AND status=$4 RETURNING id,status,table_id AS "tableId"', [input.tableId, orderAction[1], venueDbId, beforeRows[0].status]);
          if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_state_changed' }); }
          if (beforeRows[0].tableId && beforeRows[0].tableId !== rows[0].tableId) { await client.query(`UPDATE tables t SET status=CASE WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.table_id=$1 AND r.venue_id=$2 AND r.status='confirmed' AND r.starts_at::date=CURRENT_DATE) THEN 'reserved'::table_status ELSE 'free'::table_status END FROM zones z WHERE t.id=$1 AND t.zone_id=z.id AND z.venue_id=$2 AND t.status <> 'blocked' AND NOT EXISTS (SELECT 1 FROM orders WHERE table_id=$1 AND venue_id=$2 AND status IN ('open','in_progress','ready'))`, [beforeRows[0].tableId, venueDbId]); await client.query(`UPDATE tables t SET status='occupied'::table_status FROM zones z WHERE t.id=$1 AND t.zone_id=z.id AND z.venue_id=$2 AND t.status <> 'blocked'`, [rows[0].tableId, venueDbId]); }
          await client.query('COMMIT');
          recordAudit(req, 'order.transferred', 'order', rows[0].id, beforeRows[0], rows[0]); return json(res, 200, rows[0]);
        } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client?.release(); }
      } catch (error) { return json(res, 409, { error: 'order_action_failed', detail: error.message }); }
    }
    const order = orders.find((entry) => entry.id === orderAction[1]);
    if (!order) return json(res, 404, { error: 'order_not_found' });
    if (orderAction[2] === 'status') {
       if (!['open', 'in_progress', 'ready', 'closed', 'cancelled'].includes(input.status)) return json(res, 400, { error: 'invalid_order_status' });
       if (input.status === 'closed') return json(res, 409, { error: 'order_close_requires_payment', action: 'POST /api/orders/:id/close' });
       if (!validOrderTransition(order.status, input.status)) return json(res, 409, { error: 'invalid_order_transition', from: order.status, to: input.status });
      if (input.status === 'cancelled' && Math.round(receivedOrderPayments(order) * 100) > 0) return json(res, 409, { error: 'paid_order_cannot_cancel', paid: receivedOrderPayments(order) });
      const before = { status: order.status, tableId: order.tableId }; order.status = input.status; if (input.status === 'closed') order.closedAt = new Date().toISOString();
      if (['closed', 'cancelled'].includes(input.status)) releaseMemoryTableIfIdle(order.tableId);
      recordAudit(req, 'order.status_changed', 'order', order.id, before, { status: order.status, tableId: order.tableId }); return json(res, 200, order);
    }
    if (typeof input.tableId !== 'string' || !input.tableId.trim() || input.tableId.length > 80) return json(res, 400, { error: 'table_id_required' });
    if (!['open', 'in_progress', 'ready'].includes(order.status)) return json(res, 409, { error: 'order_not_transferable' });
    const targetTable = floor.flatMap((zone) => zone.tables || []).find((table) => table.id === input.tableId.trim() && table.status !== 'blocked');
    if (!targetTable || targetTable.archivedAt) return json(res, 404, { error: 'target_table_not_found' });
    if (orders.some((entry) => entry.id !== order.id && entry.tableId === input.tableId.trim() && ['open', 'in_progress', 'ready'].includes(entry.status))) return json(res, 409, { error: 'target_table_has_active_order' });
    const before = { tableId: order.tableId }; const previousTable = order.tableId; order.tableId = input.tableId.trim(); setMemoryTableStatus(order.tableId, 'occupied'); releaseMemoryTableIfIdle(previousTable); recordAudit(req, 'order.transferred', 'order', order.id, before, { tableId: order.tableId }); return json(res, 200, order);
  }
  const itemMatch = pathname.match(/^\/api\/orders\/([^/]+)\/items$/);
  if (itemMatch && req.method === 'POST') {
    if (denyUnless(req, res, 'orders')) return;
    if (await requireOpenShift(req, res)) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(itemMatch[1])) {
      const input = await body(req); const quantity = Number(input.quantity || 1); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return json(res, 400, { error: 'quantity_must_be_positive' });
      if (['salesEmployeeId', 'sales_employee_id', 'soldAt', 'sold_at'].some((field) => Object.prototype.hasOwnProperty.call(input, field))) return json(res, 400, { error: 'sales_attribution_server_managed' });
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: orderRows } = await client.query('SELECT id,status,pricing_locked_at AS "pricingLockedAt",vip_minimum AS "minimumOrderTotal" FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [itemMatch[1], venueDbId]);
        if (!orderRows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_not_found' }); }
        if (orderRows[0].pricingLockedAt) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: orderRows[0].pricingLockedAt }); }
        if (!['open', 'in_progress', 'ready'].includes(orderRows[0].status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_not_editable' }); }
        const salesEmployeeId = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : null;
        if (!salesEmployeeId) { await client.query('ROLLBACK'); return json(res, 401, { error: 'sales_employee_session_required' }); }
        let salesEmployeeName = null;
        if (salesEmployeeId) {
          const employee = await client.query(`SELECT u.id,u.full_name FROM users u JOIN venues v ON v.id=$2
            WHERE u.id=$1 AND u.is_active=true AND u.deleted_at IS NULL
              AND (u.venue_id=v.id OR u.organization_id=v.organization_id OR EXISTS (
                SELECT 1 FROM organization_memberships m WHERE m.organization_id=v.organization_id AND m.user_id=u.id AND m.status='active'))`, [salesEmployeeId, venueDbId]);
          if (!employee.rows[0]) { await client.query('ROLLBACK'); return json(res, 403, { error: 'order_item_sales_employee_unavailable' }); }
          salesEmployeeName = employee.rows[0].full_name;
        }
        const { rows: productRows } = await client.query('SELECT id,name,sale_price AS "unitPrice",category AS station FROM products WHERE id=$1 AND venue_id=$2 AND is_active=true FOR UPDATE', [input.productId, venueDbId]);
        const product = productRows[0];
        if (!product) { await client.query('ROLLBACK'); return json(res, 400, { error: 'product_not_found' }); }
        const { rows } = await client.query(`INSERT INTO order_items (order_id,product_id,quantity,unit_price,station,sales_employee_id,sold_at)
          VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END)
          RETURNING id,product_id AS "productId",quantity,unit_price AS "unitPrice",station,sales_employee_id AS "salesEmployeeId",sold_at AS "soldAt"`, [itemMatch[1], product.id, quantity, product.unitPrice, product.station, salesEmployeeId]);
        const result = { ...rows[0], quantity: Number(rows[0].quantity), unitPrice: Number(rows[0].unitPrice), name: product.name, salesEmployeeName };
        const balance = await pgOrderBalance(client, itemMatch[1], orderRows[0].minimumOrderTotal);
        if (orderBalanceConflict(balance)) { await client.query('ROLLBACK'); return json(res, 409, orderBalanceConflictBody(balance)); }
        await client.query('COMMIT');
        recordAudit(req, 'order.item_added', 'order_item', result.id, null, result);
        return json(res, 201, result);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'order_item_create_failed', detail: error.message }); } finally { client.release(); }
    }
    const order = orders.find((entry) => entry.id === itemMatch[1]);
    if (order && !['open', 'in_progress', 'ready'].includes(order.status)) return json(res, 409, { error: 'order_not_editable' });
    if (order?.pricingLockedAt) return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: order.pricingLockedAt });
    const input = await body(req); const quantity = Number(input.quantity || 1);
    if (['salesEmployeeId', 'sales_employee_id', 'soldAt', 'sold_at'].some((field) => Object.prototype.hasOwnProperty.call(input, field))) return json(res, 400, { error: 'sales_attribution_server_managed' });
    const product = products.find((entry) => entry.id === input.productId);
    if (!order) return json(res, 404, { error: 'order_not_found' });
    if (!product) return json(res, 400, { error: 'product_not_found' });
    if (!Number.isFinite(quantity) || quantity < 1) return json(res, 400, { error: 'quantity_must_be_positive' });
    const salesEmployee = req.user?.id ? { salesEmployeeId: req.user.id, salesEmployeeName: req.user.name || req.user.fullName || null } : { salesEmployeeId: null, salesEmployeeName: null };
    if (!salesEmployee.salesEmployeeId) return json(res, 401, { error: 'sales_employee_session_required' });
    const item = { id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, productId: product.id, name: product.name, quantity, unitPrice: product.price, station: product.station, ...salesEmployee, soldAt: salesEmployee.salesEmployeeId ? new Date().toISOString() : null };
    order.items.push(item);
    const balance = memoryOrderBalance(order); if (orderBalanceConflict(balance)) { order.items.pop(); return json(res, 409, orderBalanceConflictBody(balance)); }
    recordAudit(req, 'order.item_added', 'order_item', item.id, null, item);
    return json(res, 201, item);
  }
  const itemAction = pathname.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)$/);
  if (itemAction && (req.method === 'PATCH' || req.method === 'DELETE')) {
    if (denyUnless(req, res, 'orders')) return;
    if (await requireOpenShift(req, res)) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(itemAction[1]) && /^[0-9a-f-]{36}$/i.test(itemAction[2])) {
      let client;
      try {
        const input = req.method === 'PATCH' ? await body(req) : {};
        const quantity = req.method === 'PATCH' ? Number(input.quantity) : null;
        if (req.method === 'PATCH' && (!Number.isInteger(quantity) || quantity < 1 || quantity > 999)) return json(res, 400, { error: 'quantity_must_be_positive' });
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        const { rows: orderRows } = await client.query('SELECT id,status,pricing_locked_at AS "pricingLockedAt",vip_minimum AS "minimumOrderTotal" FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [itemAction[1], venueDbId]);
        if (!orderRows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_not_found' }); }
        if (orderRows[0].pricingLockedAt) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: orderRows[0].pricingLockedAt }); }
        if (!['open', 'in_progress', 'ready'].includes(orderRows[0].status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_not_editable' }); }
        if (req.method === 'PATCH') {
          const { rows: currentRows } = await client.query('SELECT quantity FROM order_items WHERE id=$1 AND order_id=$2 FOR UPDATE', [itemAction[2], itemAction[1]]);
          if (!currentRows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_item_not_found' }); }
          if (quantity > Number(currentRows[0].quantity)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'quantity_increase_requires_new_line' }); }
        }
        const query = req.method === 'DELETE'
          ? await client.query('DELETE FROM order_items WHERE id=$1 AND order_id=$2 RETURNING id,quantity,unit_price AS "unitPrice"', [itemAction[2], itemAction[1]])
          : await client.query('UPDATE order_items SET quantity=$1 WHERE id=$2 AND order_id=$3 RETURNING id,quantity,unit_price AS "unitPrice",sales_employee_id AS "salesEmployeeId",sold_at AS "soldAt"', [quantity, itemAction[2], itemAction[1]]);
        if (!query.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_item_not_found' }); }
        if (req.method === 'PATCH' && query.rows[0].salesEmployeeId) {
          const employee = await client.query(`SELECT u.full_name FROM users u WHERE u.id=$1 AND (u.venue_id=$2 OR u.organization_id=(SELECT organization_id FROM venues WHERE id=$2) OR EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id=(SELECT organization_id FROM venues WHERE id=$2) AND m.user_id=u.id AND m.status='active'))`, [query.rows[0].salesEmployeeId, venueDbId]);
          query.rows[0].salesEmployeeName = employee.rows[0]?.full_name || null;
        } else if (req.method === 'PATCH') query.rows[0].salesEmployeeName = null;
        const balance = await pgOrderBalance(client, itemAction[1], orderRows[0].minimumOrderTotal);
        if (orderBalanceConflict(balance)) { await client.query('ROLLBACK'); return json(res, 409, orderBalanceConflictBody(balance)); }
        await client.query('COMMIT');
        recordAudit(req, req.method === 'DELETE' ? 'order.item_removed' : 'order.item_quantity_changed', 'order_item', query.rows[0].id, null, req.method === 'DELETE' ? null : query.rows[0]);
        return json(res, 200, { ...query.rows[0], quantity: Number(query.rows[0].quantity), unitPrice: Number(query.rows[0].unitPrice) });
      } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'order_item_update_failed', detail: error.message }); } finally { client?.release(); }
    }
    const order = orders.find((entry) => entry.id === itemAction[1]); if (order && !['open', 'in_progress', 'ready'].includes(order.status)) return json(res, 409, { error: 'order_not_editable' }); if (order?.pricingLockedAt) return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: order.pricingLockedAt }); const item = order?.items?.find((entry) => entry.id === itemAction[2]); if (!item) return json(res, 404, { error: 'order_item_not_found' });
    if (req.method === 'DELETE') { const beforeItems = order.items; order.items = order.items.filter((entry) => entry.id !== item.id); const balance = memoryOrderBalance(order); if (orderBalanceConflict(balance)) { order.items = beforeItems; return json(res, 409, orderBalanceConflictBody(balance)); } recordAudit(req, 'order.item_removed', 'order_item', item.id, item, null); return json(res, 200, { id: item.id }); }
    const input = await body(req); const quantity = Number(input.quantity); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return json(res, 400, { error: 'quantity_must_be_positive' }); const beforeQuantity = item.quantity; if (quantity > beforeQuantity) return json(res, 409, { error: 'quantity_increase_requires_new_line' }); item.quantity = quantity; const balance = memoryOrderBalance(order); if (orderBalanceConflict(balance)) { item.quantity = beforeQuantity; return json(res, 409, orderBalanceConflictBody(balance)); } recordAudit(req, 'order.item_quantity_changed', 'order_item', item.id, { quantity: beforeQuantity }, item); return json(res, 200, item);
  }
  const orderRefundsPath = pathname.match(/^\/api\/finance\/orders\/([^/]+)\/refunds$/);
  if (orderRefundsPath && ['GET','POST'].includes(req.method)) {
    if (!repositories?.pool) return json(res,503,{error:'order_refunds_requires_database'});
    const refundOrderId=orderRefundsPath[1].toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(refundOrderId)) return json(res,400,{error:'invalid_order_id'});
    const readAllowed=hasPermission(req,'finance_read')||hasPermission(req,'finance');
    if (req.method==='GET') {
      if (!readAllowed) return json(res,403,{error:'forbidden',permission:'finance_read'});
      try {
        if (!hasPermission(req,'orders')) return json(res,403,{error:'forbidden',permission:'orders'});
        const order=await repositories.pool.query('SELECT id,reservation_id AS "reservationId" FROM orders WHERE id=$1 AND venue_id=$2',[refundOrderId,venueDbId]);
        if(!order.rows[0]) return json(res,404,{error:'order_not_found'});
        if(order.rows[0].reservationId&&!hasPermission(req,'reservations')) return json(res,403,{error:'forbidden',permission:'reservations'});
        const {rows}=await repositories.pool.query(`SELECT r.id,r.order_id AS "orderId",r.amount,r.reason,r.created_at AS "createdAt",r.actor_id AS "actorId",r.shift_id AS "shiftId",r.item_attribution_status AS "itemAttributionStatus",
          COALESCE(t.allocations,'[]'::jsonb) AS allocations,COALESCE(i.item_returns,'[]'::jsonb) AS "itemReturns"
          FROM order_refunds r
          LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('sourcePaymentId',t.source_payment_id,'amount',t.amount,'payoutMethod',t.payout_method) ORDER BY t.created_at,t.id) AS allocations FROM order_refund_tenders t WHERE t.venue_id=r.venue_id AND t.refund_id=r.id) t ON true
          LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('orderItemId',ri.order_item_id,'quantity',ri.returned_quantity,'itemValueMinor',ri.returned_item_value_minor,'producerSequence',ri.producer_sequence,'previousReturnedQuantity',ri.previous_returned_quantity,'cumulativeReturnedQuantity',ri.cumulative_returned_quantity,'previousReturnedItemValueMinor',ri.previous_returned_item_value_minor,'cumulativeReturnedItemValueMinor',ri.cumulative_returned_item_value_minor,'sequenceScope',CASE WHEN ri.producer_sequence IS NULL THEN 'legacy_unsequenced' ELSE 'per_source_post_092' END,'productName',sl.product_facts->>'productName','sellerId',sl.seller_id,'soldAt',sl.sold_at) ORDER BY ri.order_item_id) AS item_returns FROM order_refund_items ri JOIN pos_order_pricing_snapshot_lines sl ON sl.venue_id=ri.venue_id AND sl.snapshot_id=ri.snapshot_id AND sl.order_id=ri.order_id AND sl.order_item_id=ri.order_item_id WHERE ri.venue_id=r.venue_id AND ri.refund_id=r.id) i ON true
          WHERE r.venue_id=$1 AND r.order_id=$2 ORDER BY r.created_at,r.id`,[venueDbId,refundOrderId]);
        const returnable=await repositories.pool.query(`SELECT s.id AS "snapshotId",l.order_item_id AS "orderItemId",l.quantity AS "soldQuantity",l.unit_price AS "unitPrice",l.gross_minor AS "grossMinor",l.discount_minor AS "discountMinor",l.net_minor AS "netMinor",l.seller_id AS "sellerId",l.sold_at AS "soldAt",l.product_facts AS "productFacts",b.returned_quantity AS "returnedQuantity",b.returned_item_value_minor AS "returnedItemValueMinor"
          FROM pos_order_pricing_snapshots s JOIN pos_order_pricing_snapshot_lines l ON l.venue_id=s.venue_id AND l.snapshot_id=s.id AND l.order_id=s.order_id
          JOIN pos_order_item_return_balances b ON b.venue_id=l.venue_id AND b.snapshot_id=l.snapshot_id AND b.order_id=l.order_id AND b.order_item_id=l.order_item_id
          WHERE s.venue_id=$1 AND s.order_id=$2 ORDER BY l.order_item_id`,[venueDbId,refundOrderId]);
        const hasSnapshot=returnable.rows.length>0 || (await repositories.pool.query('SELECT 1 FROM pos_order_pricing_snapshots WHERE venue_id=$1 AND order_id=$2',[venueDbId,refundOrderId])).rowCount>0;
        return json(res,200,{items:rows,returnableItems:returnable.rows,lineSnapshotStatus:hasSnapshot?'complete':'unknown',coverage:{source:'postgres_order_refunds',itemAttribution:'per_refund',legacyPaymentStatusRefunded:'unknown_not_reconstructed'}});
      } catch(error) { return json(res,503,{error:'order_refunds_unavailable'}); }
    }
    if (!hasPermission(req,'finance')) return json(res,403,{error:'forbidden',permission:'finance'});
    if (!/^[0-9a-f-]{36}$/i.test(String(req.user?.id||''))) return json(res,401,{error:'authentication_required'});
    const input=await body(req); const reason=String(input.reason||'').trim(); const key=String(input.idempotencyKey||'').trim();
    const decimalCents=(value)=>{const raw=typeof value==='number'?String(value):String(value??'').trim();if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw))return null;const [whole,frac='']=raw.split('.');const cents=Number(whole)*100+Number((frac+'00').slice(0,2));return Number.isSafeInteger(cents)?cents:null;};
    const totalCents=decimalCents(input.amount); const rawAllocations=Array.isArray(input.allocations)?input.allocations:[];
    const allocations=rawAllocations.map((item)=>({sourcePaymentId:String(item?.sourcePaymentId||'').trim().toLowerCase(),amountCents:decimalCents(item?.amount),payoutMethod:String(item?.payoutMethod||'').trim()}));
    const quantityMilli=(value)=>{const raw=typeof value==='number'?String(value):String(value??'').trim();if(!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw))return null;const [whole,fraction='']=raw.split('.');const milli=Number(whole)*1000+Number((fraction+'000').slice(0,3));return Number.isSafeInteger(milli)&&milli>0&&milli<=999999999999?milli:null;};
    const rawItems=Array.isArray(input.items)?input.items:[];
    const itemReturns=rawItems.map((item)=>({orderItemId:String(item?.orderItemId||'').trim().toLowerCase(),quantityMilli:quantityMilli(item?.quantity)}));
    const noItemReturn=input.noItemReturn===true;
    if(totalCents===null||totalCents<=0||!reason||reason.length>500||key.length<8||key.length>120||!allocations.length||allocations.some((a)=>! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a.sourcePaymentId)||a.amountCents===null||a.amountCents<=0||!['cash','card','qr'].includes(a.payoutMethod))||allocations.reduce((s,a)=>s+(a.amountCents||0),0)!==totalCents||new Set(allocations.map((a)=>a.sourcePaymentId)).size!==allocations.length||input.items!==undefined&&!Array.isArray(input.items)||itemReturns.some((item)=>! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.orderItemId)||item.quantityMilli===null)||new Set(itemReturns.map((item)=>item.orderItemId)).size!==itemReturns.length||noItemReturn&&itemReturns.length>0||input.noItemReturn!==undefined&&typeof input.noItemReturn!=='boolean') return json(res,400,{error:'invalid_order_refund'});
    allocations.sort((a,b)=>a.sourcePaymentId.localeCompare(b.sourcePaymentId));
    itemReturns.sort((a,b)=>a.orderItemId.localeCompare(b.orderItemId));
    const canonical=JSON.stringify({amountCents:totalCents,reason,allocations:allocations.map(({sourcePaymentId,amountCents,payoutMethod})=>({sourcePaymentId,amountCents,payoutMethod})),items:itemReturns,noItemReturn});
    let client;
    try {
      client=await repositories.pool.connect(); await client.query('BEGIN');
      const orderResult=await client.query("SELECT id,status FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE",[refundOrderId,venueDbId]);
      if(!orderResult.rows[0]){await client.query('ROLLBACK');return json(res,404,{error:'order_not_found'});}
      const pricingSnapshot=await client.query('SELECT id FROM pos_order_pricing_snapshots WHERE venue_id=$1 AND order_id=$2',[venueDbId,refundOrderId]);
      const prior=await client.query('SELECT id,order_id AS "orderId",amount,reason,shift_id AS "shiftId",created_at AS "createdAt",actor_id AS "actorId",item_attribution_status AS "itemAttributionStatus" FROM order_refunds WHERE venue_id=$1 AND idempotency_key=$2',[venueDbId,key]);
      if(prior.rows[0]){
        const priorTenders=await client.query("SELECT source_payment_id AS \"sourcePaymentId\",amount,payout_method AS \"payoutMethod\" FROM order_refund_tenders WHERE venue_id=$1 AND refund_id=$2 ORDER BY source_payment_id",[venueDbId,prior.rows[0].id]);
        const priorItems=await client.query("SELECT order_item_id AS \"orderItemId\",round(returned_quantity*1000)::bigint AS \"quantityMilli\" FROM order_refund_items WHERE venue_id=$1 AND refund_id=$2 ORDER BY order_item_id",[venueDbId,prior.rows[0].id]);
        const priorBody=JSON.stringify({amountCents:decimalCents(prior.rows[0].amount),reason:prior.rows[0].reason,allocations:priorTenders.rows.map((a)=>({sourcePaymentId:a.sourcePaymentId,amountCents:decimalCents(a.amount),payoutMethod:a.payoutMethod})),items:priorItems.rows.map((item)=>({orderItemId:item.orderItemId,quantityMilli:Number(item.quantityMilli)})),noItemReturn:prior.rows[0].itemAttributionStatus==='not_applicable'});
        if(prior.rows[0].orderId!==refundOrderId||priorBody!==canonical){await client.query('ROLLBACK');return json(res,409,{error:'idempotency_key_reused'});}
        const priorDetails=await client.query(`SELECT ri.order_item_id AS "orderItemId",ri.returned_quantity AS quantity,ri.returned_item_value_minor AS "itemValueMinor",ri.producer_sequence AS "producerSequence",ri.previous_returned_quantity AS "previousReturnedQuantity",ri.cumulative_returned_quantity AS "cumulativeReturnedQuantity",ri.previous_returned_item_value_minor AS "previousReturnedItemValueMinor",ri.cumulative_returned_item_value_minor AS "cumulativeReturnedItemValueMinor",CASE WHEN ri.producer_sequence IS NULL THEN 'legacy_unsequenced' ELSE 'per_source_post_092' END AS "sequenceScope",ri.created_at AS "createdAt",sl.product_facts->>'productName' AS "productName",sl.seller_id AS "sellerId",sl.sold_at AS "soldAt" FROM order_refund_items ri JOIN pos_order_pricing_snapshot_lines sl ON sl.venue_id=ri.venue_id AND sl.snapshot_id=ri.snapshot_id AND sl.order_id=ri.order_id AND sl.order_item_id=ri.order_item_id WHERE ri.venue_id=$1 AND ri.refund_id=$2 ORDER BY ri.order_item_id`,[venueDbId,prior.rows[0].id]);
        const response=prior.rows[0]; response.allocations=priorTenders.rows; response.itemReturns=priorDetails.rows; response.idempotentReplay=true; await client.query('COMMIT'); return json(res,200,response);
      }
      if(orderResult.rows[0].status!=='closed'){await client.query('ROLLBACK');return json(res,409,{error:'order_must_be_closed'});}
      if(itemReturns.length&&!pricingSnapshot.rows[0]){await client.query('ROLLBACK');return json(res,409,{error:'refund_item_snapshot_unavailable'});}
      if(noItemReturn&&!pricingSnapshot.rows[0]){await client.query('ROLLBACK');return json(res,409,{error:'refund_item_snapshot_unavailable'});}
      let lockedLines=[];
      if(itemReturns.length){
        const lineResult=await client.query(`SELECT l.order_item_id AS "orderItemId",l.quantity AS "soldQuantity",l.net_minor AS "netMinor",l.seller_id AS "sellerId",l.sold_at AS "soldAt",l.product_facts->>'productName' AS "productName",b.returned_quantity AS "returnedQuantity",b.returned_item_value_minor AS "returnedItemValueMinor"
          FROM pos_order_pricing_snapshot_lines l JOIN pos_order_item_return_balances b ON b.venue_id=l.venue_id AND b.snapshot_id=l.snapshot_id AND b.order_id=l.order_id AND b.order_item_id=l.order_item_id
          WHERE l.venue_id=$1 AND l.snapshot_id=$2 AND l.order_id=$3 AND l.order_item_id=ANY($4::uuid[])
          ORDER BY l.order_item_id FOR UPDATE OF l,b`,[venueDbId,pricingSnapshot.rows[0].id,refundOrderId,itemReturns.map((item)=>item.orderItemId)]);
        if(lineResult.rows.length!==itemReturns.length){await client.query('ROLLBACK');return json(res,409,{error:'refund_item_source_unavailable'});}
        lockedLines=lineResult.rows;
        for(const requested of itemReturns){const line=lockedLines.find((row)=>row.orderItemId===requested.orderItemId);if(!line||requested.quantityMilli+Math.round(Number(line.returnedQuantity)*1000)>Math.round(Number(line.soldQuantity)*1000)){await client.query('ROLLBACK');return json(res,409,{error:'refund_item_quantity_exceeds_remaining'});}}
      }
      const payIds=allocations.map(a=>a.sourcePaymentId);
      const payments=await client.query("SELECT id,amount,method,status FROM payments WHERE order_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",[refundOrderId,payIds]);
      if(payments.rows.length!==allocations.length||payments.rows.some(p=>!['cash','card','qr'].includes(p.method)||!['paid','partially_paid'].includes(p.status))){await client.query('ROLLBACK');return json(res,409,{error:'refund_source_payment_unavailable'});}
      for(const allocation of allocations){
        const payment=payments.rows.find(p=>p.id===allocation.sourcePaymentId); const cap=decimalCents(payment.amount);
        const used=await client.query('SELECT COALESCE(SUM(amount),0)::numeric AS amount FROM order_refund_tenders WHERE venue_id=$1 AND order_id=$2 AND source_payment_id=$3',[venueDbId,refundOrderId,allocation.sourcePaymentId]);
        if(cap===null||allocation.amountCents+decimalCents(used.rows[0].amount)>cap){await client.query('ROLLBACK');return json(res,409,{error:'refund_exceeds_payment_balance'});}
      }
      const shifts=await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE',[venueDbId]);
      if(!shifts.rows[0]){await client.query('ROLLBACK');return json(res,409,{error:'open_shift_required'});}
      const itemAttributionStatus=itemReturns.length?'complete':noItemReturn?'not_applicable':'unattributed';
      const inserted=await client.query(`INSERT INTO order_refunds(venue_id,order_id,shift_id,amount,reason,idempotency_key,actor_id,item_attribution_status) VALUES($1,$2,$3,$4::numeric/100,$5,$6,$7,$8) RETURNING id,order_id AS "orderId",amount,reason,shift_id AS "shiftId",created_at AS "createdAt",actor_id AS "actorId",item_attribution_status AS "itemAttributionStatus"`,[venueDbId,refundOrderId,shifts.rows[0].id,totalCents,reason,key,req.user.id,itemAttributionStatus]);
      const refund=inserted.rows[0];
      for(const allocation of allocations) await client.query('INSERT INTO order_refund_tenders(venue_id,refund_id,order_id,source_payment_id,amount,payout_method) VALUES($1,$2,$3,$4,$5::numeric/100,$6)',[venueDbId,refund.id,refundOrderId,allocation.sourcePaymentId,allocation.amountCents,allocation.payoutMethod]);
      const returnedItems=[];
      for(const requested of itemReturns){const line=lockedLines.find((row)=>row.orderItemId===requested.orderItemId);const insertedItem=await client.query('INSERT INTO order_refund_items(venue_id,refund_id,order_id,snapshot_id,order_item_id,returned_quantity,returned_item_value_minor) VALUES($1,$2,$3,$4,$5,$6::numeric/1000,NULL) RETURNING order_item_id AS "orderItemId",returned_quantity AS quantity,returned_item_value_minor AS "itemValueMinor",producer_sequence AS "producerSequence",previous_returned_quantity AS "previousReturnedQuantity",cumulative_returned_quantity AS "cumulativeReturnedQuantity",previous_returned_item_value_minor AS "previousReturnedItemValueMinor",cumulative_returned_item_value_minor AS "cumulativeReturnedItemValueMinor",\'per_source_post_092\'::text AS "sequenceScope",created_at AS "createdAt"',[venueDbId,refund.id,refundOrderId,pricingSnapshot.rows[0].id,requested.orderItemId,requested.quantityMilli]);returnedItems.push({...insertedItem.rows[0],productName:line.productName,sellerId:line.sellerId,soldAt:line.soldAt});}
      await client.query('INSERT INTO audit_events(venue_id,actor_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,$4,$5,$6)',[venueDbId,req.user.id,'order.refunded','order_refund',refund.id,{...refund,allocations:allocations.map(a=>({sourcePaymentId:a.sourcePaymentId,amount:a.amountCents/100,payoutMethod:a.payoutMethod})),itemReturns:returnedItems}]);
      refund.allocations=allocations.map(a=>({sourcePaymentId:a.sourcePaymentId,amount:a.amountCents/100,payoutMethod:a.payoutMethod})); refund.itemReturns=returnedItems; await client.query('COMMIT'); return json(res,201,refund);
    } catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});if(error.code==='23505')return json(res,409,{error:'idempotency_key_reused'});if(error.code==='23514')return json(res,409,{error:error.message});return json(res,503,{error:'order_refund_failed'});} finally{client?.release();}
  }
  const paymentPath = pathname.match(/^\/api\/orders\/([^/]+)\/payments$/);
  if (paymentPath && (req.method === 'GET' || req.method === 'POST')) {
    if (denyUnless(req, res, 'orders')) return;
    const allocationInput = req.method === 'POST' ? await body(req) : null;
    if (req.method === 'POST' && allocationInput?.method === 'reservation' && denyUnless(req,res,'reservations')) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(paymentPath[1])) {
      if (req.method === 'GET') {
        try {
        const { rows: orderRows } = await repositories.pool.query('SELECT id,status,pricing_locked_at AS "pricingLockedAt",guest_id AS "guestId",reservation_id AS "reservationId",vip_minimum AS "minimumOrderTotal",loyalty_bonus_percent AS "loyaltyBonusPercent",loyalty_bonus_base AS "loyaltyBonusBase",loyalty_bonus_earned AS "loyaltyBonusEarned",loyalty_redemption_policy_version AS "redemptionPolicyVersion",loyalty_redemption_rate AS "redemptionRate",loyalty_redemption_cap_percent AS "redemptionCapPercent",loyalty_redemption_min_points AS "redemptionMinPoints",loyalty_redemption_base AS "redemptionBase" FROM orders WHERE id=$1 AND venue_id=$2', [paymentPath[1], venueDbId]);
          const persisted = orderRows[0]; if (!persisted) return json(res, 404, { error: 'order_not_found' });
          if (persisted.reservationId && denyUnless(req,res,'reservations')) return;
          const pricing = await pgOrderPricing(repositories.pool, paymentPath[1], persisted.minimumOrderTotal);
          const { rows } = await repositories.pool.query('SELECT id,method,amount,status,idempotency_key AS "idempotencyKey",created_at AS "createdAt" FROM payments WHERE order_id=$1 ORDER BY created_at', [paymentPath[1]]);
          const reservationPrepayment = await pgReservationPrepaymentState(repositories.pool,venueDbId,persisted.reservationId);
          let guestAccount = null; if (persisted.guestId) { const { rows: guestRows } = await repositories.pool.query('SELECT g.loyalty_points AS "bonusBalance",g.deposit_balance AS "depositBalance",COALESCE(dg.bonus_percent,0) AS "bonusPercent" FROM guests g LEFT JOIN guest_discount_groups dg ON dg.id=g.discount_group_id AND dg.venue_id=g.venue_id AND dg.active=true WHERE g.id=$1 AND g.venue_id=$2', [persisted.guestId, venueDbId]); if (guestRows[0]) guestAccount = { guestId: persisted.guestId, bonusBalance: Number(guestRows[0].bonusBalance || 0), depositBalance: Number(guestRows[0].depositBalance || 0), bonusPercent:Number(guestRows[0].bonusPercent||0), conversionRate: 1 }; }
          const redemptionPolicy = persisted.redemptionPolicyVersion !== null ? { version:Number(persisted.redemptionPolicyVersion), maxRedemptionPercent:Number(persisted.redemptionCapPercent), minimumRedemptionPoints:Number(persisted.redemptionMinPoints), base:Number(persisted.redemptionBase??pricing.due) } : { version:0, maxRedemptionPercent:100, minimumRedemptionPoints:1, base:Number(pricing.due) };
          const redeemed = rows.filter((row)=>row.method==='bonus'&&['paid','partially_paid'].includes(row.status)).reduce((sum,row)=>sum+Number(row.amount||0),0);
          const bonusRedemptionRemaining = Math.max(0,Math.floor(moneyCents(redemptionPolicy.base*redemptionPolicy.maxRedemptionPercent/100)-moneyCents(redeemed))/100);
          return json(res, 200, { items: rows, closed:persisted.status==='closed', pricingLocked:Boolean(persisted.pricingLockedAt), pricingLockedAt:persisted.pricingLockedAt||null, guestAccount, reservationId: persisted.reservationId, reservationPrepaymentAvailable: reservationPrepayment.available, reservationPrepaymentReceipts: reservationPrepayment.receipts, bonusRedemptionRemaining, bonusRedemptionPolicy: { version:redemptionPolicy.version, maxRedemptionPercent:redemptionPolicy.maxRedemptionPercent, minimumRedemptionPoints:redemptionPolicy.minimumRedemptionPoints, base:redemptionPolicy.base }, ...pricing, remaining: Math.max(0, pricing.due - pricing.paid), loyaltyBonusPercent: persisted.loyaltyBonusPercent === null ? null : Number(persisted.loyaltyBonusPercent), loyaltyBonusBase: persisted.loyaltyBonusBase === null ? null : Number(persisted.loyaltyBonusBase), loyaltyBonusEarned: persisted.loyaltyBonusEarned === null ? null : Number(persisted.loyaltyBonusEarned) });
        } catch (error) { return json(res, 409, { error: 'payment_create_failed', detail: error.message }); }
      }

      const input = allocationInput || await body(req); const amount = Number(input.amount); const method = String(input.method || 'cash'); const idempotencyKey = String(input.idempotencyKey || req.headers['idempotency-key'] || '').trim();
      const receiptId = String(input.receiptId || '').trim();
      if (!validPaymentAmount(amount) || !['cash', 'card', 'qr', 'bonus', 'deposit', 'reservation'].includes(method)) return json(res, 400, { error: 'valid_method_and_amount_required' });
      if (method === 'bonus' && (!Number.isInteger(amount) || amount <= 0)) return json(res, 400, { error: 'invalid_bonus_points' });
      if ((['bonus','deposit','reservation'].includes(method) && !idempotencyKey) || (method === 'reservation' && !/^[0-9a-f-]{36}$/i.test(receiptId)) || (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 120))) return json(res, 400, { error: 'valid_idempotency_key_required' });
      let client;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        // Serialize concurrent payments and close requests using the same order lock.
        const { rows: orderRows } = await client.query('SELECT id,status,pricing_locked_at AS "pricingLockedAt",pricing_version AS "pricingVersion",table_id AS "tableId",guest_id AS "guestId",reservation_id AS "reservationId",vip_minimum AS "minimumOrderTotal",loyalty_redemption_policy_version AS "redemptionPolicyVersion",loyalty_redemption_rate AS "redemptionRate",loyalty_redemption_cap_percent AS "redemptionCapPercent",loyalty_redemption_min_points AS "redemptionMinPoints",loyalty_redemption_base AS "redemptionBase" FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [paymentPath[1], venueDbId]);
        const persisted = orderRows[0];
        if (!persisted) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_not_found' }); }
        let reservationShiftId=null;
        if (method==='reservation') { const shiftGuard=await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE',[venueDbId]); reservationShiftId=shiftGuard.rows[0]?.id||null; if(!reservationShiftId){await client.query('ROLLBACK');return json(res,409,{error:'open_shift_required'});} }
        if (idempotencyKey) { const { rows: priorRows } = await client.query('SELECT id,method,amount,status,shift_id AS "shiftId",created_at AS "createdAt" FROM payments WHERE order_id=$1 AND idempotency_key=$2', [paymentPath[1], idempotencyKey]); if (priorRows[0]) { const prior=priorRows[0]; if (prior.method!==method || Number(prior.amount)!==amount) { await client.query('ROLLBACK'); return json(res,409,{error:'idempotency_key_reused'}); } if(method==='reservation'){const allocation=await client.query('SELECT receipt_id AS "receiptId" FROM reservation_pre_payment_allocations WHERE venue_id=$1 AND payment_id=$2',[venueDbId,prior.id]);if(!allocation.rows[0]||allocation.rows[0].receiptId!==receiptId){await client.query('ROLLBACK');return json(res,409,{error:'idempotency_key_reused'});}} const current=await pgOrderPricing(client,paymentPath[1]); let guestAccount=null;if(persisted.guestId){const {rows}=await client.query('SELECT loyalty_points AS "bonusBalance",deposit_balance AS "depositBalance" FROM guests WHERE id=$1 AND venue_id=$2',[persisted.guestId,venueDbId]);if(rows[0])guestAccount={guestId:persisted.guestId,bonusBalance:Number(rows[0].bonusBalance||0),depositBalance:Number(rows[0].depositBalance||0),conversionRate:1};}await client.query('COMMIT');return json(res,200,{...prior,due:current.due,paid:current.paid,remaining:Math.max(0,current.due-current.paid),closed:persisted.status==='closed',guestAccount,idempotentReplay:true}); } }
        if (method==='reservation' && idempotencyKey) { const priorAllocation=await client.query('SELECT order_id FROM reservation_pre_payment_allocations WHERE venue_id=$1 AND idempotency_key=$2',[venueDbId,idempotencyKey]); if(priorAllocation.rows[0]){await client.query('ROLLBACK');return json(res,409,{error:'idempotency_key_reused'});} }
        if (persisted.status === 'closed' || persisted.status === 'cancelled') { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_already_final' }); }
        if (persisted.pricingLockedAt && !persisted.pricingVersion) { await client.query('ROLLBACK'); return json(res, 409, { error: 'legacy_paid_order_requires_reconciliation' }); }
        const { rows: shiftRows } = method==='reservation' ? { rows: [{id:reservationShiftId}] } : await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE', [venueDbId]);
        const activeShiftId = shiftRows[0]?.id;
        if (!activeShiftId) { await client.query('ROLLBACK'); return json(res, 409, { error: 'open_shift_required' }); }
        await client.query("SELECT pg_advisory_xact_lock(hashtext('loyalty_promotions_venue'),hashtext($1::text))", [venueDbId]);
        const pricing = await pgOrderPricing(client, paymentPath[1], persisted.minimumOrderTotal);
        const { subtotal, discount, net, due, paid } = pricing;
        let redemptionPolicy = null;
        if (method === 'bonus') {
          if (persisted.redemptionPolicyVersion !== null) redemptionPolicy = { version:Number(persisted.redemptionPolicyVersion), rate:Number(persisted.redemptionRate), capPercent:Number(persisted.redemptionCapPercent), minimumPoints:Number(persisted.redemptionMinPoints), base:Number(persisted.redemptionBase??due) };
          else redemptionPolicy={version:0,rate:1,capPercent:100,minimumPoints:1,base:Number(due)};
          const {rows}=await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM payments WHERE order_id=$1 AND method='bonus' AND status IN ('paid','partially_paid')",[paymentPath[1]]);
          const alreadyRedeemed=Number(rows[0]?.amount||0); const remainingCap=Math.max(0,Math.floor(moneyCents(redemptionPolicy.base*redemptionPolicy.capPercent/100)-moneyCents(alreadyRedeemed))/100);
          if ((alreadyRedeemed === 0 && amount < redemptionPolicy.minimumPoints) || amount > remainingCap + 0.000001) { await client.query('ROLLBACK'); return json(res,409,{error:alreadyRedeemed === 0 && amount < redemptionPolicy.minimumPoints?'bonus_redemption_below_minimum':'bonus_redemption_limit_exceeded',available:remainingCap,minimumPoints:redemptionPolicy.minimumPoints,maxRedemptionPercent:redemptionPolicy.capPercent}); }
          if (persisted.redemptionPolicyVersion === null || persisted.redemptionBase === null) await client.query('UPDATE orders SET loyalty_redemption_policy_version=$3,loyalty_redemption_rate=$4,loyalty_redemption_cap_percent=$5,loyalty_redemption_min_points=$6,loyalty_redemption_base=$7 WHERE id=$1 AND venue_id=$2',[paymentPath[1],venueDbId,redemptionPolicy.version,redemptionPolicy.rate,redemptionPolicy.capPercent,redemptionPolicy.minimumPoints,redemptionPolicy.base]);
        }
        let reservationReceipt = null;
        if (method === 'reservation') {
          if (!persisted.reservationId) { await client.query('ROLLBACK'); return json(res,409,{error:'order_has_no_reservation'}); }
          const { rows: reservationRows } = await client.query("SELECT id,status FROM reservations WHERE id=$1 AND venue_id=$2 FOR UPDATE",[persisted.reservationId,venueDbId]);
          if (!reservationRows[0] || reservationRows[0].status!=='confirmed') { await client.query('ROLLBACK'); return json(res,409,{error:'reservation_not_confirmed'}); }
          const { rows: receiptRows } = await client.query('SELECT id,amount FROM reservation_pre_payment_receipts WHERE id=$1 AND venue_id=$2 AND reservation_id=$3 FOR UPDATE',[receiptId,venueDbId,persisted.reservationId]);
          reservationReceipt = receiptRows[0];
          if (!reservationReceipt) { await client.query('ROLLBACK'); return json(res,404,{error:'reservation_pre_payment_receipt_not_found'}); }
          const { rows: allocationRows } = await client.query(`SELECT
            (SELECT COALESCE(SUM(a.amount),0) FROM reservation_pre_payment_allocations a WHERE a.venue_id=$1 AND a.receipt_id=$2) AS allocated,
            (SELECT COALESCE(SUM(ar.amount),0) FROM reservation_pre_payment_allocation_reversals ar JOIN reservation_pre_payment_allocations a ON a.venue_id=ar.venue_id AND a.id=ar.allocation_id WHERE ar.venue_id=$1 AND a.receipt_id=$2) AS reversed,
            (SELECT COALESCE(SUM(rr.amount),0) FROM reservation_pre_payment_receipt_reversals rr WHERE rr.venue_id=$1 AND rr.receipt_id=$2) AS refunded`,[venueDbId,receiptId]);
          const balance=allocationRows[0]||{};
          const available = roundMoney(Number(reservationReceipt.amount)-Number(balance.allocated||0)+Number(balance.reversed||0)-Number(balance.refunded||0));
          if (amount>available+0.000001) { await client.query('ROLLBACK'); return json(res,409,{error:'reservation_pre_payment_insufficient',available}); }
        }
        let accountGuest=null; if(['bonus','deposit'].includes(method)){if(!persisted.guestId){await client.query('ROLLBACK');return json(res,409,{error:'guest_required_for_account_tender'});}const {rows}=await client.query('SELECT id,loyalty_points AS "bonusBalance",deposit_balance AS "depositBalance" FROM guests WHERE id=$1 AND venue_id=$2 FOR UPDATE',[persisted.guestId,venueDbId]);accountGuest=rows[0];if(!accountGuest){await client.query('ROLLBACK');return json(res,409,{error:'guest_account_unavailable'});}const available=Number(method==='bonus'?accountGuest.bonusBalance:accountGuest.depositBalance);if(available<amount){await client.query('ROLLBACK');return json(res,409,{error:method==='bonus'?'insufficient_bonus_balance':'insufficient_deposit_balance',available});}}
        if (orderBalanceConflict({ due, paid: paid + amount })) { await client.query('ROLLBACK'); return json(res, 409, { error: 'payment_exceeds_due', remaining: Math.max(0, due - paid) }); }
        if (!persisted.pricingLockedAt) {
          const promotion = pricing.selectedPromotion;
          await client.query('UPDATE orders SET pricing_locked_at=now(),group_discount_base=$3,group_discount_amount=$4,effective_discount_source=$5,subtotal_snapshot=$6,discount_total_snapshot=$7,minimum_adjustment_snapshot=$8,final_total_snapshot=$9,pricing_version=1,pricing_offers_snapshot=$10,selected_promotion_id=$11,selected_promotion_version=$12,selected_promotion_name=$13,selected_promotion_benefit_kind=$14,selected_promotion_benefit_value=$15,selected_promotion_basis=$16,selected_promotion_amount=$17 WHERE id=$1 AND venue_id=$2 AND pricing_locked_at IS NULL', [paymentPath[1], venueDbId, pricing.groupDiscountBase, pricing.groupDiscountAmount, pricing.source, subtotal, discount, pricing.minimumAdjustment, due, JSON.stringify(pricing.offers || []), promotion?.promotionId || null, promotion?.version || null, promotion?.label || null, promotion?.benefitKind || null, promotion?.benefitValue ?? null, promotion?.eligibleBasis ?? null, promotion?.amount ?? null]);
        }
        await writePosOrderPricingSnapshot(client,{venueId:venueDbId,orderId:paymentPath[1],pricing});
        const { rows } = await client.query('INSERT INTO payments (order_id,method,amount,status,shift_id,idempotency_key) VALUES ($1,$2,$3,\'paid\',$4,$5) RETURNING id,method,amount,status,shift_id AS "shiftId",idempotency_key AS "idempotencyKey",created_at AS "createdAt"', [paymentPath[1], method, amount, activeShiftId, idempotencyKey||null]);
        if (method === 'reservation') {
          await client.query('INSERT INTO reservation_pre_payment_allocations (venue_id,reservation_id,receipt_id,order_id,payment_id,shift_id,amount,idempotency_key,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[venueDbId,persisted.reservationId,receiptId,paymentPath[1],rows[0].id,activeShiftId,amount,idempotencyKey,req.user?.id||null]);
        }
        let accountBalances=null; if(['bonus','deposit'].includes(method)){const isBonus=method==='bonus';const accountType=isBonus?'bonus':'deposit';const column=isBonus?'loyalty_points':'deposit_balance';const label=isBonus?'бонусов':'денег со счёта';await client.query(`INSERT INTO guest_account_entries (venue_id,guest_id,account_type,amount,reason,source_type,source_id,source_key,actor_id) VALUES ($1,$2,$3,$4,$5,'order',$6,$7,$8)`,[venueDbId,persisted.guestId,accountType,-amount,`Списание ${label} в оплату заказа`,paymentPath[1],`order:${paymentPath[1]}:${accountType}-redeem:${idempotencyKey}`,req.user?.id||null]);const {rows:balanceRows}=await client.query(`UPDATE guests SET ${column}=${column}-$1 WHERE id=$2 AND venue_id=$3 AND ${column} >= $1 RETURNING loyalty_points AS "bonusBalance",deposit_balance AS "depositBalance"`,[amount,persisted.guestId,venueDbId]);if(!balanceRows[0])throw Object.assign(new Error(isBonus?'insufficient_bonus_balance':'insufficient_deposit_balance'),{code:isBonus?'insufficient_bonus_balance':'insufficient_deposit_balance'});accountBalances={bonusBalance:Number(balanceRows[0].bonusBalance||0),depositBalance:Number(balanceRows[0].depositBalance||0)};}
        const nextPaid = paid + amount;
        const closed = moneyCents(nextPaid) >= moneyCents(due);
        let loyaltyAccrual = { base: 0, percent: 0, earned: 0, balance: null };
        const finalMeta = closed ? { finalTotal: due, discountTotal: discount, minimumAdjustment: pricing.minimumAdjustment, paymentMethod: paid > 0 ? 'mixed' : method, effectiveDiscountSource: pricing.source, groupDiscountGroupId: pricing.groupDiscountGroupId, groupDiscountName: pricing.groupDiscountName, groupDiscountPercent: pricing.groupDiscountPercent, groupDiscountBase: pricing.groupDiscountBase, groupDiscountAmount: pricing.groupDiscountAmount, subtotalSnapshot: subtotal, discountTotalSnapshot: discount, minimumAdjustmentSnapshot: pricing.minimumAdjustment, finalTotalSnapshot: due, pricingVersion: 1 } : {};
        if (closed) {
          const depletion = await depleteRecipeForOrder(repositories.pool, paymentPath[1], venueDbId, req.user?.id, client);
          const redeemedRows = await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM payments WHERE order_id=$1 AND method='bonus' AND status IN ('paid','partially_paid')", [paymentPath[1]]);
          loyaltyAccrual = await accrueGuestOrderBonus(client, { venueId: venueDbId, guestId: persisted.guestId, orderId: paymentPath[1], eligibleBase: Math.max(0, net - Number(redeemedRows.rows[0]?.amount || 0)), actorId: req.user?.id });
          const promotion = pricing.selectedPromotion;
          const { rows: closedRows } = await client.query('UPDATE orders SET status=\'closed\',closed_at=now(),closed_in_shift_id=$3,loyalty_bonus_percent=$4,loyalty_bonus_base=$5,loyalty_bonus_earned=$6,group_discount_base=$7,group_discount_amount=$8,effective_discount_source=$9,subtotal_snapshot=$10,discount_total_snapshot=$11,minimum_adjustment_snapshot=$12,final_total_snapshot=$13,pricing_version=1,pricing_offers_snapshot=$14,selected_promotion_id=$15,selected_promotion_version=$16,selected_promotion_name=$17,selected_promotion_benefit_kind=$18,selected_promotion_benefit_value=$19,selected_promotion_basis=$20,selected_promotion_amount=$21,pricing_locked_at=COALESCE(pricing_locked_at,now()) WHERE id=$1 AND venue_id=$2 AND status NOT IN (\'closed\',\'cancelled\') RETURNING id', [paymentPath[1], venueDbId, activeShiftId, loyaltyAccrual.percent, loyaltyAccrual.base, loyaltyAccrual.earned, pricing.groupDiscountBase, pricing.groupDiscountAmount, pricing.source, subtotal, discount, pricing.minimumAdjustment, due, JSON.stringify(pricing.offers || []), promotion?.promotionId || null, promotion?.version || null, promotion?.label || null, promotion?.benefitKind || null, promotion?.benefitValue ?? null, promotion?.eligibleBasis ?? null, promotion?.amount ?? null]);
          if (!closedRows[0]) throw Object.assign(new Error('order_already_final'), { code: 'order_already_final' });
          await client.query('INSERT INTO order_costs (venue_id,order_id,cost) VALUES ($1,$2,$3) ON CONFLICT (order_id) DO UPDATE SET cost=EXCLUDED.cost', [venueDbId, paymentPath[1], depletion.totalCost]);
          if (persisted.tableId) await client.query(`UPDATE tables t SET status=CASE WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.table_id=$1 AND r.venue_id=$2 AND r.status=\'confirmed\' AND r.starts_at::date=CURRENT_DATE) THEN \'reserved\'::table_status ELSE \'free\'::table_status END FROM zones z WHERE t.id=$1 AND t.zone_id=z.id AND z.venue_id=$2 AND t.status <> \'blocked\'::table_status AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id=$1 AND o.venue_id=$2 AND o.status IN (\'open\',\'in_progress\',\'ready\'))`, [persisted.tableId, venueDbId]);
        }
        await repositories.audit.record({venueId:venueDbId,actorId:/^[0-9a-f-]{36}$/i.test(req.user?.id||'')?req.user.id:null,action:'order.payment_added',entityType:'payment',entityId:rows[0].id,afterData:{...rows[0],orderId:paymentPath[1],...(method==='reservation'?{receiptId,reservationId:persisted.reservationId}:{}),paid:nextPaid,due,closed}},client);
        const response = { ...rows[0], guestAccount: accountGuest ? { guestId: persisted.guestId, bonusBalance: accountBalances?.bonusBalance ?? Number(accountGuest.bonusBalance||0), depositBalance: accountBalances?.depositBalance ?? Number(accountGuest.depositBalance||0), conversionRate: 1 } : undefined, due, paid: nextPaid, remaining: Math.max(0, due - nextPaid), closed, ...finalMeta, ...(closed ? { loyaltyBonusPercent: loyaltyAccrual.percent, loyaltyBonusBase: loyaltyAccrual.base, loyaltyBonusEarned: loyaltyAccrual.earned, loyaltyBonusBalance: loyaltyAccrual.balance } : {}) };
        await client.query('COMMIT');
        return json(res, 201, response);
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (error.message === 'expired_premix_stock') return json(res, 409, { error: 'expired_premix_stock' }); if (error.message === 'insufficient_recipe_stock') return json(res, 409, { error: 'insufficient_recipe_stock', missing: error.missing });
        if (['product_inventory_mode_required','product_recipe_required','product_recipe_ambiguous','product_inventory_mode_invalid'].includes(error.code || error.message)) return json(res, 409, { error: error.code || error.message, productId: error.productId, productName: error.productName });
        if (['recipe_invalid', 'recipe_ingredient_not_found', 'recipe_ingredient_unit_mismatch', 'invalid_recipe_quantity'].includes(error.code || error.message)) return json(res, 409, { error: error.code || error.message, ingredient: error.ingredient, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit });
        if (error.code === 'order_already_final') return json(res, 409, { error: 'order_already_final' });
        if (error.code === 'insufficient_bonus_balance') return json(res,409,{error:'insufficient_bonus_balance'});
        if (error.code === '23505' && error.constraint === 'reservation_pre_payment_allocations_venue_id_idempotency_key_key') return json(res,409,{error:'idempotency_key_reused'});
        return json(res, 409, { error: 'payment_create_failed', detail: error.message });
      } finally {
        client?.release();
      }
    }
    const order = orders.find((entry) => entry.id === paymentPath[1] && entry.venueId === currentVenueId); if (!order) return json(res, 404, { error: 'order_not_found' }); order.payments ||= []; const pricing = memoryOrderPricing(order); const { subtotal, discount, due } = pricing; const paid = receivedOrderPayments(order); const linkedGuest=clients.find((entry)=>entry.id===(order.clientId||order.guestId));
    const memoryReservationPrepayment = () => { const reservation = reservations.find((entry)=>entry.id===order.reservationId&&entry.venueId===currentVenueId); const allocations=reservation?.prepaymentAllocations||[]; const receipts=(reservation?.prepaymentReceipts||[]).map((receipt)=>({...receipt,available:roundMoney(Math.max(0,Number(receipt.amount||0)-allocations.filter((allocation)=>allocation.receiptId===receipt.id).reduce((sum,allocation)=>sum+Number(allocation.amount||0),0)))})).filter((receipt)=>Number(receipt.available)>0); return {available:roundMoney(receipts.reduce((sum,receipt)=>sum+Number(receipt.available),0)),receipts}; };
    const localPolicyStored={version:Number(order.loyaltyRedemptionPolicyVersion??0),bonusRublesPerPoint:Number(order.loyaltyRedemptionRate||1),maxRedemptionPercent:Number(order.loyaltyRedemptionCapPercent??100),minimumRedemptionPoints:Number(order.loyaltyRedemptionMinPoints??1),bonusExpirationDays:null}; const localRedemptionPolicy={version:localPolicyStored.version,rate:localPolicyStored.bonusRublesPerPoint,capPercent:localPolicyStored.maxRedemptionPercent,minimumPoints:localPolicyStored.minimumRedemptionPoints,base:Number(order.loyaltyRedemptionBase??due)}; const localBonusRedeemed=order.payments.filter((entry)=>entry.method==='bonus'&&['paid','partially_paid'].includes(entry.status)).reduce((sum,entry)=>sum+Number(entry.amount||0),0); const localBonusRedemptionRemaining=Math.max(0,Math.floor(moneyCents(localRedemptionPolicy.base*localRedemptionPolicy.capPercent/100)-moneyCents(localBonusRedeemed))/100);
    if (req.method === 'GET') { if(order.reservationId&&denyUnless(req,res,'reservations'))return; const prepayment=memoryReservationPrepayment(); return json(res, 200, { items: order.payments, closed:order.status==='closed', pricingLocked:Boolean(order.pricingLockedAt), pricingLockedAt:order.pricingLockedAt||null, guestAccount:linkedGuest?{guestId:linkedGuest.id,bonusBalance:Number(linkedGuest.loyaltyPoints??linkedGuest.bonusBalance??0),depositBalance:Number(linkedGuest.depositBalance||0),bonusPercent:Number(discountGroups.find((group)=>group.id===linkedGuest.discountGroupId&&group.venueId===currentVenueId)?.bonusPercent||0),conversionRate:1}:null, reservationId:order.reservationId||null, reservationPrepaymentAvailable:prepayment.available, reservationPrepaymentReceipts:prepayment.receipts, bonusRedemptionRemaining:localBonusRedemptionRemaining, bonusRedemptionPolicy:{version:localRedemptionPolicy.version,maxRedemptionPercent:localRedemptionPolicy.capPercent,minimumRedemptionPoints:localRedemptionPolicy.minimumPoints,base:localRedemptionPolicy.base}, ...pricing, paid, remaining: Math.max(0, due - paid), loyaltyBonusPercent: order.loyaltyBonusPercent ?? null, loyaltyBonusBase: order.loyaltyBonusBase ?? null, loyaltyBonusEarned: order.loyaltyBonusEarned ?? null }); }
    const input = allocationInput || await body(req); const amount = Number(input.amount); const method = String(input.method || 'cash'); const receiptId=String(input.receiptId||''); const idempotencyKey=String(input.idempotencyKey||'').trim(); if(idempotencyKey){const prior=order.payments.find((entry)=>entry.idempotencyKey===idempotencyKey);if(prior){if(prior.method!==method||Number(prior.amount)!==amount||(method==='reservation'&&prior.receiptId!==receiptId))return json(res,409,{error:'idempotency_key_reused'});const current=memoryOrderPricing(order);const guest=clients.find((entry)=>entry.id===(order.clientId||order.guestId));return json(res,200,{...prior,due:current.due,paid:receivedOrderPayments(order),remaining:Math.max(0,current.due-receivedOrderPayments(order)),closed:order.status==='closed',guestAccount:guest?{guestId:guest.id,bonusBalance:Number(guest.loyaltyPoints||guest.bonusBalance||0),depositBalance:Number(guest.depositBalance||0),conversionRate:1}:null,idempotentReplay:true});}} if(method==='reservation'&&idempotencyKey&&reservations.some((entry)=>entry.venueId===currentVenueId&&(entry.prepaymentAllocations||[]).some((allocation)=>allocation.idempotencyKey===idempotencyKey)))return json(res,409,{error:'idempotency_key_reused'}); if(order.status==='closed'||order.status==='cancelled')return json(res,409,{error:'order_already_final'}); if(await requireOpenShift(req,res))return; if(idempotencyKey&&(idempotencyKey.length<8||idempotencyKey.length>120))return json(res,400,{error:'valid_idempotency_key_required'}); if (!validPaymentAmount(amount) || !['cash', 'card', 'qr', 'bonus', 'deposit','reservation'].includes(method) || (['bonus','deposit','reservation'].includes(method)&&(!idempotencyKey||(method==='bonus'&&!Number.isInteger(amount))))) return json(res, 400, { error: 'valid_method_and_amount_required' }); if(['bonus','deposit'].includes(method)){const guest=clients.find((entry)=>entry.id===(order.clientId||order.guestId));if(!guest)return json(res,409,{error:'guest_required_for_account_tender'});const balance=Number(method==='bonus'?(guest.loyaltyPoints??guest.bonusBalance??0):(guest.depositBalance||0));if(balance<amount)return json(res,409,{error:method==='bonus'?'insufficient_bonus_balance':'insufficient_deposit_balance',available:balance});} let reservationReceipt=null,reservationForReceipt=null; if(method==='reservation'){reservationForReceipt=reservations.find((entry)=>entry.id===order.reservationId&&entry.venueId===currentVenueId&&entry.status==='confirmed');if(!reservationForReceipt)return json(res,409,{error:order.reservationId?'reservation_not_confirmed':'order_has_no_reservation'});reservationForReceipt.prepaymentAllocations||=[];reservationReceipt=reservationForReceipt.prepaymentReceipts?.find((receipt)=>receipt.id===receiptId);if(!reservationReceipt)return json(res,404,{error:'reservation_pre_payment_receipt_not_found'});const available=roundMoney(Number(reservationReceipt.amount)-reservationForReceipt.prepaymentAllocations.filter((allocation)=>allocation.receiptId===receiptId).reduce((sum,allocation)=>sum+Number(allocation.amount||0),0));if(amount>available+0.000001)return json(res,409,{error:'reservation_pre_payment_insufficient',available});} if(method==='bonus'){if(localBonusRedeemed===0&&amount<localRedemptionPolicy.minimumPoints)return json(res,409,{error:'bonus_redemption_below_minimum',minimumPoints:localRedemptionPolicy.minimumPoints});if(amount>localBonusRedemptionRemaining+0.000001)return json(res,409,{error:'bonus_redemption_limit_exceeded',available:localBonusRedemptionRemaining,maxRedemptionPercent:localRedemptionPolicy.capPercent});} if (orderBalanceConflict({ due, paid: paid + amount })) return json(res, 409, { error: 'payment_exceeds_due', remaining: Math.max(0, due - paid) }); const activeShift = shifts.find((shift) => !shift.closedAt); if (!activeShift) return json(res, 409, { error: 'open_shift_required' }); const nextPaid = paid + amount; const closed = moneyCents(nextPaid) >= moneyCents(due); let depletion = null; if (closed) { try { depletion = depleteMemoryOrder(order); } catch (error) { if (error.message === 'expired_premix_stock') return json(res, 409, { error: 'expired_premix_stock' }); if (error.message === 'insufficient_recipe_stock') return json(res, 409, { error: 'insufficient_recipe_stock', missing: error.missing }); if (['product_inventory_mode_required','product_recipe_required','product_recipe_ambiguous','product_inventory_mode_invalid'].includes(error.code || error.message)) return json(res, 409, { error: error.code || error.message, productId: error.productId, productName: error.productName }); if (['recipe_invalid', 'recipe_ingredient_not_found', 'recipe_ingredient_unit_mismatch', 'invalid_recipe_quantity'].includes(error.code || error.message)) return json(res, 409, { error: error.code || error.message, ingredient: error.ingredient, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit }); return json(res, 409, { error: 'recipe_depletion_failed', detail: error.message }); } } if(method==='bonus'&&order.loyaltyRedemptionPolicyVersion==null){order.loyaltyRedemptionPolicyVersion=localRedemptionPolicy.version;order.loyaltyRedemptionRate=localRedemptionPolicy.rate;order.loyaltyRedemptionCapPercent=localRedemptionPolicy.capPercent;order.loyaltyRedemptionMinPoints=localRedemptionPolicy.minimumPoints;order.loyaltyRedemptionBase=localRedemptionPolicy.base;} if (!order.pricingLockedAt) { order.pricingLockedAt=new Date().toISOString(); order.groupDiscountBase=pricing.groupDiscountBase; order.groupDiscountAmount=pricing.groupDiscountAmount; order.effectiveDiscountSource=pricing.source; order.subtotalSnapshot=subtotal; order.discountTotalSnapshot=discount; order.minimumAdjustmentSnapshot=pricing.minimumAdjustment; order.finalTotalSnapshot=due; order.pricingVersion=1; order.selectedPromotionSnapshot=pricing.selectedPromotion||null; order.pricingOffersSnapshot=pricing.offers||[]; } const payment = { id: `pay-${Date.now()}`, method, amount, status: 'paid', shiftId: activeShift.id, idempotencyKey:idempotencyKey||null, ...(method==='reservation'?{receiptId}:{}), createdAt: new Date().toISOString() }; order.payments.push(payment); if(method==='bonus'&&order.loyaltyRedemptionPolicyVersion==null){order.loyaltyRedemptionPolicyVersion=localRedemptionPolicy.version;order.loyaltyRedemptionRate=localRedemptionPolicy.rate;order.loyaltyRedemptionCapPercent=localRedemptionPolicy.capPercent;order.loyaltyRedemptionMinPoints=localRedemptionPolicy.minimumPoints;order.loyaltyRedemptionBase=localRedemptionPolicy.base;} if(reservationReceipt){reservationReceipt.allocatedAmount=Number(reservationReceipt.allocatedAmount||0)+amount;reservationForReceipt.prepaymentAllocations.push({receiptId,orderId:order.id,paymentId:payment.id,shiftId:activeShift.id,amount,idempotencyKey,createdAt:payment.createdAt,actorId:req.user?.id||null});} let accountBalances=null;if(['bonus','deposit'].includes(method)){const guest=clients.find((entry)=>entry.id===(order.clientId||order.guestId));const isBonus=method==='bonus';const accountType=isBonus?'bonus':'deposit';const available=Number(isBonus?(guest.loyaltyPoints??guest.bonusBalance??0):(guest.depositBalance||0));if(isBonus){guest.loyaltyPoints=guest.bonusBalance=available-amount;}else guest.depositBalance=available-amount;guest.accountEntries ||= [];guest.accountEntries.unshift({id:`account-${crypto.randomUUID()}`,accountType,amount:-amount,reason:isBonus?'Списание бонусов в оплату заказа':'Списание денег со счёта в оплату заказа',sourceType:'order',sourceId:order.id,sourceKey:`order:${order.id}:${accountType}-redeem:${idempotencyKey}`,createdAt:payment.createdAt,actorName:req.user?.name||'Система'});accountBalances={bonusBalance:Number(guest.loyaltyPoints??guest.bonusBalance??0),depositBalance:Number(guest.depositBalance||0)};} let loyaltyAccrual = { base: 0, percent: 0, earned: 0, balance: null }; if (closed) { loyaltyAccrual = accrueMemoryOrderBonus(order, Math.max(0,pricing.net-(order.payments||[]).filter((entry)=>entry.method==='bonus'&&['paid','partially_paid'].includes(entry.status)).reduce((sum,entry)=>sum+Number(entry.amount||0),0)), req.user?.name); order.loyaltyBonusPercent = loyaltyAccrual.percent; order.loyaltyBonusBase = loyaltyAccrual.base; order.loyaltyBonusEarned = loyaltyAccrual.earned; order.status = 'closed'; order.closedAt = payment.createdAt; order.closedInShiftId = activeShift.id; order.subtotal = subtotal; order.discountTotal = discount; order.finalTotal = due; order.minimumAdjustment = pricing.minimumAdjustment; order.paymentMethod = order.payments.length === 1 ? method : 'mixed'; order.paid = nextPaid; order.remaining = 0; order.costOfGoods = Number(depletion?.totalCost || 0); order.groupDiscountBase = pricing.groupDiscountBase; order.groupDiscountAmount = pricing.groupDiscountAmount; order.effectiveDiscountSource = pricing.source; order.subtotalSnapshot = subtotal; order.discountTotalSnapshot = discount; order.minimumAdjustmentSnapshot = pricing.minimumAdjustment; order.finalTotalSnapshot = due; order.pricingVersion = 1; order.selectedPromotionSnapshot = pricing.selectedPromotion || null; order.pricingOffersSnapshot = pricing.offers || []; releaseMemoryTableIfIdle(order.tableId); } recordAudit(req, 'order.payment_added', 'payment', payment.id, null, { ...payment, orderId: order.id, ...(method==='reservation'?{reservationId:order.reservationId}:{}), paid: nextPaid, due, closed, loyaltyBonusEarned: loyaltyAccrual.earned, costOfGoods: closed ? order.costOfGoods : undefined }); return json(res, 201, { ...payment, guestAccount:accountBalances?{guestId:order.clientId||order.guestId,...accountBalances,conversionRate:1}:undefined, due, paid: nextPaid, remaining: Math.max(0, due - nextPaid), closed, ...(closed ? { finalTotal: order.finalTotal, discountTotal: order.discountTotal, minimumAdjustment: order.minimumAdjustment, paymentMethod: order.paymentMethod, costOfGoods: order.costOfGoods, effectiveDiscountSource: pricing.source, groupDiscountGroupId: pricing.groupDiscountGroupId, groupDiscountName: pricing.groupDiscountName, groupDiscountPercent: pricing.groupDiscountPercent, groupDiscountBase: pricing.groupDiscountBase, groupDiscountAmount: pricing.groupDiscountAmount, subtotalSnapshot: subtotal, discountTotalSnapshot: discount, minimumAdjustmentSnapshot: pricing.minimumAdjustment, finalTotalSnapshot: due, pricingVersion: 1, loyaltyBonusPercent: loyaltyAccrual.percent, loyaltyBonusBase: loyaltyAccrual.base, loyaltyBonusEarned: loyaltyAccrual.earned, loyaltyBonusBalance: loyaltyAccrual.balance } : {}) });
  }
  const orderPath = pathname.match(/^\/api\/orders\/([^/]+)\/(summary|close|split|discount-requests)$/);
  if (orderPath && req.method === 'GET' && orderPath[2] === 'summary') {
    if (denyUnless(req, res, 'orders')) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(orderPath[1])) {
      try {
        const { rows: orderRows } = await repositories.pool.query('SELECT id,vip_minimum AS "minimumOrderTotal" FROM orders WHERE id=$1 AND venue_id=$2', [orderPath[1], venueDbId]);
        if (!orderRows[0]) return json(res, 404, { error: 'order_not_found' });
        const pricing = await pgOrderPricing(repositories.pool, orderPath[1], orderRows[0].minimumOrderTotal);
        const minimum = Number(orderRows[0].minimumOrderTotal || 0);
        return json(res, 200, { orderId: orderRows[0].id, ...pricing, minimum, shortfall: Math.max(0, minimum - pricing.net), minimumApplied: minimum > 0 });
      } catch (error) { return json(res, 503, { error: 'database_unavailable', detail: error.message }); }
    }
    const order = orders.find((entry) => entry.id === orderPath[1]);
    return order ? json(res, 200, vipSummary(order)) : json(res, 404, { error: 'order_not_found' });
  }
  if (orderPath && req.method === 'POST' && orderPath[2] === 'close') {
    if (denyUnless(req, res, 'orders')) return;
    if (await requireOpenShift(req, res)) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(orderPath[1])) {
      const input = await body(req); const paymentMethod = String(input.paymentMethod || 'cash'); if (!['cash', 'card', 'qr'].includes(paymentMethod)) return json(res, 400, { error: 'valid_payment_method_required' });
      let client;
      let result;
      try {
        client = await repositories.pool.connect();
        await client.query('BEGIN');
        // Serialize concurrent close attempts before reading totals or depleting stock.
        const { rows: orderRows } = await client.query('SELECT id,status,table_id AS "tableId",guest_id AS "guestId",vip_minimum AS "minimumOrderTotal" FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [orderPath[1], venueDbId]);
        const persisted = orderRows[0];
        if (!persisted) {
          await client.query('ROLLBACK');
          return json(res, 404, { error: 'order_not_found' });
        }
        if (['closed', 'cancelled'].includes(persisted.status)) {
          await client.query('ROLLBACK');
          return json(res, 409, { error: 'order_already_final' });
        }

        const { rows: shiftRows } = await client.query('SELECT id FROM shifts WHERE venue_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE', [venueDbId]);
        const activeShiftId = shiftRows[0]?.id;
        if (!activeShiftId) { await client.query('ROLLBACK'); return json(res, 409, { error: 'open_shift_required' }); }

        await client.query("SELECT pg_advisory_xact_lock(hashtext('loyalty_promotions_venue'),hashtext($1::text))", [venueDbId]);
        const pricing = await pgOrderPricing(client, orderPath[1], persisted.minimumOrderTotal);
        const { subtotal, discount, net } = pricing;
        const minimum = Number(persisted.minimumOrderTotal || 0);
        const finalTotal = pricing.due;
        const paid = pricing.paid;
        if (orderBalanceConflict({ due: finalTotal, paid })) { await client.query('ROLLBACK'); return json(res, 409, orderBalanceConflictBody({ due: finalTotal, paid })); }
        const remaining = Math.max(0, finalTotal - paid);

        await writePosOrderPricingSnapshot(client,{venueId:venueDbId,orderId:orderPath[1],pricing});

        const depletion = await depleteRecipeForOrder(repositories.pool, orderPath[1], venueDbId, req.user?.id, client);
        const redeemedRows = await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM payments WHERE order_id=$1 AND method='bonus' AND status IN ('paid','partially_paid')", [orderPath[1]]);
        const loyaltyAccrual = await accrueGuestOrderBonus(client, { venueId: venueDbId, guestId: persisted.guestId, orderId: orderPath[1], eligibleBase: Math.max(0, net - Number(redeemedRows.rows[0]?.amount || 0)), actorId: req.user?.id });
        const promotion = pricing.selectedPromotion;
        const { rows } = await client.query('UPDATE orders SET status=$1,closed_at=now(),closed_in_shift_id=$4,loyalty_bonus_percent=$5,loyalty_bonus_base=$6,loyalty_bonus_earned=$7,group_discount_base=$8,group_discount_amount=$9,effective_discount_source=$10,subtotal_snapshot=$11,discount_total_snapshot=$12,minimum_adjustment_snapshot=$13,final_total_snapshot=$14,pricing_version=1,pricing_offers_snapshot=$15,selected_promotion_id=$16,selected_promotion_version=$17,selected_promotion_name=$18,selected_promotion_benefit_kind=$19,selected_promotion_benefit_value=$20,selected_promotion_basis=$21,selected_promotion_amount=$22,pricing_locked_at=COALESCE(pricing_locked_at,now()) WHERE id=$2 AND venue_id=$3 AND status NOT IN (\'closed\',\'cancelled\') RETURNING *', ['closed', orderPath[1], venueDbId, activeShiftId, loyaltyAccrual.percent, loyaltyAccrual.base, loyaltyAccrual.earned, pricing.groupDiscountBase, pricing.groupDiscountAmount, pricing.source, subtotal, discount, pricing.minimumAdjustment, finalTotal, JSON.stringify(pricing.offers || []), promotion?.promotionId || null, promotion?.version || null, promotion?.label || null, promotion?.benefitKind || null, promotion?.benefitValue ?? null, promotion?.eligibleBasis ?? null, promotion?.amount ?? null]);
        if (!rows[0]) throw Object.assign(new Error('order_already_final'), { code: 'order_already_final' });
        await client.query('INSERT INTO order_costs (venue_id,order_id,cost) VALUES ($1,$2,$3) ON CONFLICT (order_id) DO UPDATE SET cost=EXCLUDED.cost', [venueDbId, orderPath[1], depletion.totalCost]);
        if (remaining > 0) await client.query('INSERT INTO payments (order_id,method,amount,status,shift_id) VALUES ($1,$2,$3,$4,$5)', [orderPath[1], paymentMethod, remaining, 'paid', activeShiftId]);
        if (persisted.tableId) await client.query(`UPDATE tables t SET status=CASE WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.table_id=$1 AND r.venue_id=$2 AND r.status=\'confirmed\' AND r.starts_at::date=CURRENT_DATE) THEN \'reserved\'::table_status ELSE \'free\'::table_status END FROM zones z WHERE t.id=$1 AND t.zone_id=z.id AND z.venue_id=$2 AND t.status <> \'blocked\'::table_status AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id=$1 AND o.venue_id=$2 AND o.status IN (\'open\',\'in_progress\',\'ready\'))`, [persisted.tableId, venueDbId]);
        result = { ...rows[0], ...pricing, subtotal, discountTotal: discount, finalTotal, paid: paid + remaining, remaining: 0, minimumAdjustment: pricing.minimumAdjustment, paymentMethod, loyaltyBonusPercent: loyaltyAccrual.percent, loyaltyBonusBase: loyaltyAccrual.base, loyaltyBonusEarned: loyaltyAccrual.earned, loyaltyBonusBalance: loyaltyAccrual.balance };
        await client.query('COMMIT');
        // Audit is intentionally emitted after commit so it never describes a rolled-back close.
        recordAudit(req, 'order.closed', 'order', orderPath[1], { status: persisted.status }, result);
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (error.message === 'expired_premix_stock') return json(res, 409, { error: 'expired_premix_stock' }); if (error.message === 'insufficient_recipe_stock') {
          return json(res, 409, { error: 'insufficient_recipe_stock', missing: error.missing });
        }
        if (['product_inventory_mode_required','product_recipe_required','product_recipe_ambiguous','product_inventory_mode_invalid'].includes(error.code || error.message)) return json(res, 409, { error: error.code || error.message, productId: error.productId, productName: error.productName });
        if (['recipe_invalid', 'recipe_ingredient_not_found', 'recipe_ingredient_unit_mismatch', 'invalid_recipe_quantity'].includes(error.code || error.message)) {
          return json(res, 409, { error: error.code || error.message, ingredient: error.ingredient, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit });
        }
        if (error.code === 'order_already_final') {
          return json(res, 409, { error: 'order_already_final' });
        }
        return json(res, 409, { error: 'order_close_failed', detail: error.message });
      } finally {
        client?.release();
      }
      return json(res, 200, result);
    }
    const order = orders.find((entry) => entry.id === orderPath[1]);
    if (!order) return json(res, 404, { error: 'order_not_found' });
    if (['closed', 'cancelled'].includes(order.status)) return json(res, 409, { error: 'order_already_final' });
    const input = await body(req); const paymentMethod = String(input.paymentMethod || 'cash'); if (!['cash', 'card', 'qr'].includes(paymentMethod)) return json(res, 400, { error: 'valid_payment_method_required' });
    const pricing = memoryOrderPricing(order); const total = pricing.subtotal; const discount = pricing.discount; const minimum = Number(order.minimumOrderTotal || 0);
    const activeShift = shifts.find((shift) => !shift.closedAt); if (!activeShift) return json(res, 409, { error: 'open_shift_required' });
    const closeBalance = memoryOrderBalance(order); if (orderBalanceConflict(closeBalance)) return json(res, 409, orderBalanceConflictBody(closeBalance));
    let depletion; try { depletion = depleteMemoryOrder(order); } catch (error) { if (error.message === 'expired_premix_stock') return json(res, 409, { error: 'expired_premix_stock' }); if (error.message === 'insufficient_recipe_stock') return json(res, 409, { error: 'insufficient_recipe_stock', missing: error.missing }); if (['product_inventory_mode_required','product_recipe_required','product_recipe_ambiguous','product_inventory_mode_invalid'].includes(error.code || error.message)) return json(res, 409, { error: error.code || error.message, productId: error.productId, productName: error.productName }); if (['recipe_invalid', 'recipe_ingredient_not_found', 'recipe_ingredient_unit_mismatch', 'invalid_recipe_quantity'].includes(error.code || error.message)) return json(res, 409, { error: error.code || error.message, ingredient: error.ingredient, sourceUnit: error.sourceUnit, targetUnit: error.targetUnit }); return json(res, 409, { error: 'recipe_depletion_failed', detail: error.message }); }
    const loyaltyAccrual = accrueMemoryOrderBonus(order, Math.max(0,pricing.net-(order.payments||[]).filter((entry)=>entry.method==='bonus'&&['paid','partially_paid'].includes(entry.status)).reduce((sum,entry)=>sum+Number(entry.amount||0),0)), req.user?.name); order.loyaltyBonusPercent = loyaltyAccrual.percent; order.loyaltyBonusBase = loyaltyAccrual.base; order.loyaltyBonusEarned = loyaltyAccrual.earned;
    order.status = 'closed'; order.closedAt = new Date().toISOString(); order.closedInShiftId = activeShift.id; releaseMemoryTableIfIdle(order.tableId); order.subtotal = total; order.discountTotal = discount; order.finalTotal = pricing.due; order.payments ||= []; const alreadyPaid = receivedOrderPayments(order); const remaining = Math.max(0, order.finalTotal - alreadyPaid); if (remaining > 0) order.payments.push({ id: `pay-${Date.now()}`, method: paymentMethod, amount: remaining, status: 'paid', shiftId: activeShift.id, createdAt: order.closedAt }); order.paid = alreadyPaid + remaining; order.remaining = 0; order.minimumAdjustment = pricing.minimumAdjustment; order.paymentMethod = paymentMethod; order.costOfGoods = Number(depletion?.totalCost || 0);
    order.groupDiscountBase = pricing.groupDiscountBase; order.groupDiscountAmount = pricing.groupDiscountAmount; order.effectiveDiscountSource = pricing.source; order.subtotalSnapshot = total; order.discountTotalSnapshot = discount; order.minimumAdjustmentSnapshot = order.minimumAdjustment; order.finalTotalSnapshot = pricing.due; order.pricingVersion = 1; order.selectedPromotionSnapshot = pricing.selectedPromotion || null; order.pricingOffersSnapshot = pricing.offers || [];
    recordAudit(req, 'order.closed', 'order', order.id, { status: 'open' }, { status: order.status, subtotal: order.subtotal, discountTotal: order.discountTotal, finalTotal: order.finalTotal, minimumAdjustment: order.minimumAdjustment, paymentMethod: order.paymentMethod, loyaltyBonusEarned: loyaltyAccrual.earned });
    return json(res, 200, { ...order, ...pricing, loyaltyBonusBalance: loyaltyAccrual.balance });
  }
  if (orderPath && req.method === 'POST' && orderPath[2] === 'split') {
    if (denyUnless(req, res, 'orders')) return;
    if (await requireOpenShift(req, res)) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(orderPath[1])) {
      const input = await body(req); const ids = Array.isArray(input.itemIds) ? input.itemIds : [];
      if (!ids.length) return json(res, 400, { error: 'item_ids_required' });
      if (ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) || new Set(ids).size !== ids.length) return json(res, 400, { error: 'invalid_item_ids' });
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: sourceRows } = await client.query('SELECT id,venue_id,table_id,reservation_id,guest_id,notes,opened_by,vip_minimum,status,pricing_locked_at AS "pricingLockedAt",loyalty_redemption_policy_version,loyalty_redemption_rate,loyalty_redemption_cap_percent,loyalty_redemption_min_points,loyalty_redemption_base FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [orderPath[1], venueDbId]);
        const source = sourceRows[0]; if (!source) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_not_found' }); }
        if (source.pricingLockedAt) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: source.pricingLockedAt }); }
        if (!['open', 'in_progress', 'ready'].includes(source.status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_not_editable' }); }
        const { rows: moved } = await client.query('SELECT oi.id,oi.product_id AS "productId",p.name,oi.quantity,oi.unit_price AS "unitPrice",oi.station,oi.status,oi.guest_number AS "guestNumber" FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 AND oi.id=ANY($2::uuid[]) FOR UPDATE OF oi', [source.id, ids]);
        if (moved.length !== ids.length) { await client.query('ROLLBACK'); return json(res, 409, { error: 'item_ids_not_in_order' }); }
        const { rows: countRows } = await client.query('SELECT count(*)::int AS count FROM order_items WHERE order_id=$1', [source.id]);
        const { rows: targetRows } = await client.query('INSERT INTO orders (venue_id,table_id,reservation_id,guest_id,notes,opened_by,vip_minimum,status,loyalty_redemption_policy_version,loyalty_redemption_rate,loyalty_redemption_cap_percent,loyalty_redemption_min_points,loyalty_redemption_base) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,venue_id AS "venueId",table_id AS "tableId",reservation_id AS "reservationId",guest_id AS "guestId",notes,status,vip_minimum AS "minimumOrderTotal",loyalty_redemption_policy_version AS "redemptionPolicyVersion",loyalty_redemption_rate AS "redemptionRate",loyalty_redemption_cap_percent AS "redemptionCapPercent",loyalty_redemption_min_points AS "redemptionMinPoints",loyalty_redemption_base AS "redemptionBase",created_at AS "createdAt"', [source.venue_id, source.table_id, source.reservation_id, source.guest_id, source.notes, source.opened_by, 0, 'open',source.loyalty_redemption_policy_version,source.loyalty_redemption_rate,source.loyalty_redemption_cap_percent,source.loyalty_redemption_min_points,source.loyalty_redemption_base]);
        const target = targetRows[0]; await client.query('UPDATE order_items SET order_id=$1 WHERE id=ANY($2::uuid[]) AND order_id=$3', [target.id, ids, source.id]);
        const balance = await pgOrderBalance(client, source.id, source.vip_minimum);
        if (orderBalanceConflict(balance)) { await client.query('ROLLBACK'); return json(res, 409, orderBalanceConflictBody(balance)); }
        if (moved.length >= countRows[0].count) { await client.query('ROLLBACK'); return json(res, 409, { error: 'split_requires_remaining_item' }); }
        await client.query('COMMIT');
        const result = { ...target, items: moved, splitFrom: source.id }; recordAudit(req, 'order.split', 'order', source.id, { itemCount: moved.length }, { itemCount: moved.length, newOrderId: target.id }); return json(res, 201, result);
      } catch (error) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_split_failed', detail: error.message }); } finally { client.release(); }
    }
    const source = orders.find((entry) => entry.id === orderPath[1]);
    if (!source) return json(res, 404, { error: 'order_not_found' });
    if (source.pricingLockedAt) return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: source.pricingLockedAt });
    if (!['open', 'in_progress', 'ready'].includes(source.status)) return json(res, 409, { error: 'order_not_editable' });
    const input = await body(req); const requested = Array.isArray(input.itemIds) ? input.itemIds : [];
    if (!requested.length) return json(res, 400, { error: 'item_ids_required' });
    if (requested.some((id) => typeof id !== 'string' || !id.trim()) || new Set(requested).size !== requested.length) return json(res, 400, { error: 'invalid_item_ids' });
    const ids = new Set(requested); const moved = source.items.filter((item) => ids.has(item.id));
    if (moved.length !== requested.length) return json(res, 409, { error: 'item_ids_not_in_order' });
    const beforeItems = source.items; source.items = source.items.filter((item) => !ids.has(item.id));
    const balance = memoryOrderBalance(source); if (orderBalanceConflict(balance)) { source.items = beforeItems; return json(res, 409, orderBalanceConflictBody(balance)); }
    if (moved.length >= beforeItems.length) { source.items = beforeItems; return json(res, 409, { error: 'split_requires_remaining_item' }); }
    const target = { id: `ord-${Date.now()}`, tableId: source.tableId, status: 'open', items: moved, clientId: source.clientId || null, guestName: source.guestName || null, guestPhone: source.guestPhone || null, notes: source.notes || '', openedBy: source.openedBy || source.openedById || null, loyaltyRedemptionPolicyVersion:source.loyaltyRedemptionPolicyVersion??0,loyaltyRedemptionRate:source.loyaltyRedemptionRate||1,loyaltyRedemptionCapPercent:source.loyaltyRedemptionCapPercent??100,loyaltyRedemptionMinPoints:source.loyaltyRedemptionMinPoints??1,loyaltyRedemptionBase:source.loyaltyRedemptionBase??null,splitFrom: source.id, createdAt: new Date().toISOString() };
    orders.push(target); recordAudit(req, 'order.split', 'order', source.id, { itemCount: source.items.length + moved.length }, { itemCount: source.items.length, newOrderId: target.id }); return json(res, 201, target);
  }
  if (orderPath && req.method === 'POST' && orderPath[2] === 'discount-requests') {
    if (denyUnless(req, res, 'orders')) return;
    if (await requireOpenShift(req, res)) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(orderPath[1])) {
      const input = await body(req); const type = String(input.type || 'percent'); const value = Number(input.value); const reason = String(input.reason || '').trim(); if (!reason || !Number.isFinite(value) || value <= 0 || type !== 'percent' || value > 100 || reason.length > 500) return json(res, 400, { error: 'invalid_discount_request' });
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: stateRows } = await client.query('SELECT status FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [orderPath[1], venueDbId]);
        if (!stateRows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'order_not_found' }); }
        if (['closed', 'cancelled'].includes(stateRows[0].status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_already_final' }); }
        const { rows: duplicateRows } = await client.query("SELECT id FROM discounts WHERE order_id=$1 AND status='requested' LIMIT 1", [orderPath[1]]);
        if (duplicateRows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'discount_request_pending' }); }
        const requestedBy = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : '20000000-0000-0000-0000-000000000001';
        const { rows } = await client.query("INSERT INTO discounts (order_id,requested_by,type,value,reason,status,approved_by,decided_at) VALUES ($1,$2,$3,$4,$5,'requested',NULL,NULL) RETURNING id,order_id AS \"orderId\",type,value,reason,status,requested_by AS \"requestedBy\",approved_by AS \"approvedBy\",created_at AS \"createdAt\",decided_at AS \"decidedAt\"", [orderPath[1], requestedBy, type, value, reason]);
        await client.query('COMMIT');
        recordAudit(req, 'discount.applied_by_staff', 'discount', rows[0].id, null, { ...rows[0], notificationRecipients: ['owner', 'admin'] });
        return json(res, 201, { ...rows[0], notificationRecipients: ['owner', 'admin'] });
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'discount_create_failed', detail: error.message }); } finally { client.release(); }
    }
    const order = orders.find((entry) => entry.id === orderPath[1]); const input = await body(req);
    if (!order) return json(res, 404, { error: 'order_not_found' }); if (['closed', 'cancelled'].includes(order.status)) return json(res, 409, { error: 'order_already_final' });
    const type = String(input.type || 'percent'); const value = Number(input.value); const reason = String(input.reason || '').trim(); if (!reason || !Number.isFinite(value) || value <= 0 || type !== 'percent' || value > 100 || reason.length > 500) return json(res, 400, { error: 'invalid_discount_request' }); if (discountRequests.some((entry) => entry.orderId === order.id && entry.status === 'requested')) return json(res, 409, { error: 'discount_request_pending' });
    const request = { id: `disc-${crypto.randomUUID()}`, venueId: notificationVenueScope(req, venueDbId), orderId: order.id, type, value, reason, guestName: order.guestName || null, guestPhone: order.guestPhone || null, status: 'requested', requestedBy: req.user?.id || req.user?.name || 'unknown', createdAt: new Date().toISOString(), notificationRecipients: ['owner', 'admin'] };
    discountRequests.push(request); recordAudit(req, 'discount.applied_by_staff', 'discount', request.id, null, request); return json(res, 201, request);
  }
  if (pathname === '/api/discount-requests' && req.method === 'GET') {
    if (denyUnlessAny(req, res, ['finance', 'finance_read'])) return;
    if (repositories?.pool) { try { const { rows } = await repositories.pool.query('SELECT d.id,d.order_id AS "orderId",d.type,d.value,d.reason,d.status,d.requested_by AS "requestedBy",d.approved_by AS "approvedBy",d.created_at AS "createdAt",d.decided_at AS "decidedAt",g.full_name AS "guestName",g.phone AS "guestPhone" FROM discounts d JOIN orders o ON o.id=d.order_id LEFT JOIN guests g ON g.id=o.guest_id WHERE o.venue_id=$1 ORDER BY d.created_at DESC', [venueDbId]); return json(res, 200, { items: rows }); } catch (error) { return json(res, 503, { error: 'database_unavailable' }); } }
    return json(res, 200, { items: discountRequests });
  }
  const decision = pathname.match(/^\/api\/discount-requests\/([^/]+)\/(approve|reject)$/);
  if (decision && req.method === 'POST') {
    if (denyUnless(req, res, 'finance')) return;
    if (repositories?.pool && /^[0-9a-f-]{36}$/i.test(decision[1])) {
      const input = await body(req); const status = decision[2] === 'approve' ? 'approved' : 'rejected'; const decidedBy = /^[0-9a-f-]{36}$/i.test(req.user?.id || '') ? req.user.id : '20000000-0000-0000-0000-000000000001';
      const client = await repositories.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: discountRows } = await client.query('SELECT order_id FROM discounts WHERE id=$1', [decision[1]]);
        if (!discountRows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'discount_not_found_or_decided' }); }
        const { rows: orderRows } = await client.query('SELECT id,status,pricing_locked_at AS "pricingLockedAt",vip_minimum AS "minimumOrderTotal" FROM orders WHERE id=$1 AND venue_id=$2 FOR UPDATE', [discountRows[0].order_id, venueDbId]);
        if (!orderRows[0] || ['closed', 'cancelled'].includes(orderRows[0].status)) { await client.query('ROLLBACK'); return json(res, 409, { error: 'discount_not_found_or_decided' }); }
        if (status === 'approved' && orderRows[0].pricingLockedAt) { await client.query('ROLLBACK'); return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: orderRows[0].pricingLockedAt }); }
        if (status === 'approved') { const { rows: existingRows } = await client.query("SELECT id FROM discounts WHERE order_id=$1 AND status='approved' AND id<>$2 LIMIT 1", [orderRows[0].id, decision[1]]); if (existingRows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'approved_discount_exists' }); } }
        const { rows } = await client.query(`UPDATE discounts SET status=$1,approved_by=$2,decided_at=now() WHERE id=$3 AND status=$4 AND order_id=$5 RETURNING id,order_id AS "orderId",type,value,reason,status,requested_by AS "requestedBy",approved_by AS "approvedBy",created_at AS "createdAt",decided_at AS "decidedAt"`, [status, decidedBy, decision[1], 'requested', orderRows[0].id]);
        if (!rows[0]) { await client.query('ROLLBACK'); return json(res, 409, { error: 'discount_not_found_or_decided' }); }
        if (status === 'approved') { const balance = await pgOrderBalance(client, orderRows[0].id, orderRows[0].minimumOrderTotal); if (orderBalanceConflict(balance)) { await client.query('ROLLBACK'); return json(res, 409, orderBalanceConflictBody(balance)); } }
        await client.query('COMMIT');
        recordAudit(req, `discount.${status}`, 'discount', rows[0].id, { status: 'requested' }, rows[0]); return json(res, 200, rows[0]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); return json(res, 409, { error: 'discount_decision_failed', detail: error.message }); } finally { client.release(); }
    }
    const request = discountRequests.find((entry) => entry.id === decision[1]);
    if (!request) return json(res, 404, { error: 'discount_not_found' });
    if (request.status !== 'requested') return json(res, 409, { error: 'already_decided' });
    const input = await body(req); const before = { ...request }; request.status = decision[2] === 'approve' ? 'approved' : 'rejected';
    const targetOrder = orders.find((entry) => entry.id === request.orderId);
    if (!targetOrder || ['closed', 'cancelled'].includes(targetOrder.status)) { request.status = before.status; return json(res, 409, { error: 'discount_not_found_or_decided' }); }
    if (request.status === 'approved' && targetOrder.pricingLockedAt) { request.status = before.status; return json(res, 409, { error: 'order_pricing_locked', pricingLockedAt: targetOrder.pricingLockedAt }); }
    if (request.status === 'approved' && discountRequests.some((entry) => entry.orderId === request.orderId && entry.id !== request.id && entry.status === 'approved')) { request.status = before.status; return json(res, 409, { error: 'approved_discount_exists' }); }
    if (request.status === 'approved') { const balance = memoryOrderBalance(targetOrder); if (orderBalanceConflict(balance)) { request.status = before.status; return json(res, 409, orderBalanceConflictBody(balance)); } }
    request.decidedBy = req.user?.id || req.user?.name || 'unknown'; request.decidedAt = new Date().toISOString(); recordAudit(req, `discount.${request.status}`, 'discount', request.id, before, request);
    return json(res, 200, request);
  }
  return null;
}

function staticFile(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');
  let requestPath = requestUrl.pathname;
  const routePath = requestPath.length > 1 ? requestPath.replace(/\/+$/, '') : requestPath;
  const aliases = { '/': '/index.html', '/admin': '/admin.html', '/login': '/login.html', '/inventory': '/inventory.html', '/finance': '/finance.html', '/finance/categories': '/finance-categories.html', '/finance/report': '/finance-report.html', '/reservations': '/reservations.html', '/clients': '/clients.html', '/orders': '/orders.html', '/integrations': '/integrations.html', '/network': '/network.html', '/delivery': '/delivery.html', '/platform': '/platform.html' };
  const canonicalByFile = Object.fromEntries(Object.entries(aliases).map(([canonical, file]) => [file, canonical]));
  // Keep one public URL per page. Direct HTML filenames are implementation
  // details and redirect to the canonical tree so links, history and analytics
  // never split across duplicate addresses.
  if (canonicalByFile[routePath] && routePath !== canonicalByFile[routePath]) {
    const canonical = canonicalByFile[routePath];
    const location = `${canonical}${requestUrl.search}`;
    res.writeHead(308, { Location: location, 'Cache-Control': 'no-store' });
    return res.end();
  }
  requestPath = aliases[routePath] || requestPath;
  // Only browser runtime files are public. Never expose the project directory.
  const publicFiles = new Set([
    '/phone-format.js',
    ...Object.values(aliases), '/style.css', '/platform.css', '/app.js', '/portal.js', '/header-shell.js', '/admin.js',
    '/login.js', '/platform.js', '/catalog-seed.js', '/lock.js', '/staff-profile.js', '/staff-audit.js', '/shift-close-contract.js',
    '/staff-phone-fields.js', '/staff-sensitive-fields.js', '/staff-admin-card.js',
    '/purchase-document-validation.js', '/notification-center.js', '/audit-privacy.js', '/staff-identity.js',
    '/staff-telegram-link.js', '/vip-deposit.js', '/vip-deposit-ui.js', '/payroll-scheme-ui.js',
    '/assets/tabler-icons.svg', '/assets/login-hookah-reference.jpg', '/assets/login-smoke-ambient.png', '/assets/login-smoke-ambient.mp4', '/auth-smoke.css', '/auth-smoke.js',
    '/assets/brand/hookah-pos-lockup.svg', '/assets/brand/hookah-pos-symbol.svg',
    ...[400, 500, 600, 700, 800].map(weight => `/assets/fonts/manrope-${weight}.ttf`)
  ]);
  const isBrandAsset = requestPath.startsWith('/assets/brand/');
  if (!publicFiles.has(requestPath) && !isBrandAsset) { res.writeHead(404); return res.end('Not found'); }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  const localPreviewFiles = {};
  const file = path.resolve(root, localPreviewFiles[requestPath] || `.${requestPath}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(404); return res.end('Not found'); }
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.ttf': 'font/ttf' };
  const isVideo = path.extname(file) === '.mp4';
  const headers = { 'Content-Type': isVideo ? 'video/mp4' : `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
  if (isVideo) {
    const size = fs.statSync(file).size;
    headers['Accept-Ranges'] = 'bytes';
    headers['Content-Length'] = String(size);
    const range = req.headers.range;
    if (range && req.method === 'GET') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        res.writeHead(416, { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      const last = Math.min(end, size - 1);
      headers['Content-Range'] = `bytes ${start}-${last}/${size}`;
      headers['Content-Length'] = String(last - start + 1);
      res.writeHead(206, headers);
      return fs.createReadStream(file, { start, end: last }).pipe(res);
    }
  }
  // The login document contains the initial setup form as a hidden alternative;
  // never let a browser keep an older first-run document after a local release.
  if (requestPath === '/login.html') headers['Cache-Control'] = 'no-store';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  let content = fs.readFileSync(file);
  if (requestPath === '/finance.html' && !content.includes('/payroll-scheme-ui.js')) {
    content = Buffer.from(content.toString('utf8').replace('</body>', '<script src="/payroll-scheme-ui.js?rev=1"></script></body>'));
  }
  return res.end(content);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) { const result = await api(req, res); if (result !== null) return result; }
    return staticFile(req, res);
  } catch (error) { return json(res, 500, { error: 'internal_error', message: error.message }); }
});
server.listen(process.env.PORT || 3000, process.env.HOST || undefined, () => console.log(`CRM running on http://localhost:${server.address().port}`));
