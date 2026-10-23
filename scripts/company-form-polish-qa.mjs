import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const distPortal = readFileSync(new URL('../dist/portal.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const distCss = readFileSync(new URL('../dist/style.css', import.meta.url), 'utf8');
const staffProfile = readFileSync(new URL('../staff-profile.js', import.meta.url), 'utf8');
const staffPhoneFields = readFileSync(new URL('../staff-phone-fields.js', import.meta.url), 'utf8');
const distStaffPhoneFields = readFileSync(new URL('../dist/staff-phone-fields.js', import.meta.url), 'utf8');
const staffAdminCard = readFileSync(new URL('../staff-admin-card.js', import.meta.url), 'utf8');
const distStaffAdminCard = readFileSync(new URL('../dist/staff-admin-card.js', import.meta.url), 'utf8');
const company = source.slice(source.indexOf("const companyPanel ="), source.indexOf('  let auditItems ='));
const controls = new Map();
const element = (tag = 'input') => ({ tag, value: '', files: [], textContent: '', hidden: false, disabled: false, dataset: {}, children: [], events: {}, options: [], addEventListener(type, callback) { this.events[type] = callback; }, replaceChildren(...children) { this.children = children; }, append(child) { this.children.push(child); if (this.tag === 'select') this.options.push(child); child.remove = () => { this.children = this.children.filter((item) => item !== child); this.options = this.options.filter((item) => item !== child); }; }, querySelectorAll(selector) { return selector === '[data-saved-timezone]' ? this.options.filter((item) => 'savedTimezone' in item.dataset) : []; } });
for (const id of ['name', 'city', 'address', 'format', 'logo', 'logo-preview', 'logo-name', 'remove-logo', 'add-phone', 'phone-hint']) controls.set('#company-' + id, element());
const timezone = element('select'); const russian = element('option'); russian.value = 'Europe/Moscow'; timezone.append(russian); controls.set('#company-timezone', timezone);
let phones; let status; const readers = [];
const context = vm.createContext({ companyForm: { isConnected: true, querySelector: (selector) => controls.get(selector) }, document: { createElement: element }, renderCompanyPhones: (value) => { phones = value; }, companyStatus: (text) => { status = text; }, FileReader: class { constructor() { readers.push(this); } readAsDataURL() {} } });
const logoCode = company.slice(company.indexOf('  const companyLogoInput ='), company.indexOf('  const reversalPolicyToggle ='));
assert(logoCode.includes('const renderCompanyData'));
vm.runInContext(logoCode + '\n globalThis.render = renderCompanyData;', context);
context.render({ name: 'Venue', city: 'City', address: 'Street', format: 'Lounge', timezone: 'Asia/Dubai', logoUrl: '/saved.png', phoneNumbers: [{ number: '+79990000000', primary: true }] });
assert.equal(timezone.value, 'Asia/Dubai'); assert(timezone.options.some((item) => item.value === 'Asia/Dubai'));
assert.equal(controls.get('#company-logo-preview').children[0].src, '/saved.png');
assert.equal(controls.get('#company-remove-logo').hidden, false); assert.equal(phones[0].number, '+79990000000');
const input = controls.get('#company-logo'); input.files = [{ name: 'chosen.png', type: 'image/png', size: 100 }]; input.events.change(); readers.at(-1).result = 'data:image/png;base64,test'; readers.at(-1).onload();
assert.match(controls.get('#company-logo-name').textContent, /chosen\.png/);
controls.get('#company-remove-logo').events.click(); assert.equal(controls.get('#company-logo-preview').children[0].textContent, 'Нет логотипа');
assert.equal(vm.runInContext('companyLogoRemoved', context), true);
context.render({ name: 'Normalized name', timezone: 'Europe/Moscow', logoUrl: null, phone: '+78880000000' });
assert.equal(controls.get('#company-name').value, 'Normalized name'); assert.equal(timezone.options.length, 1); assert.equal(timezone.value, 'Europe/Moscow'); assert.equal(vm.runInContext('companyLogoRemoved', context), false); assert.equal(phones[0].number, '+78880000000');
input.files = [{ name: 'bad.svg', type: 'image/svg+xml', size: 20 }]; input.events.change(); assert.match(status, /PNG/);
input.files = [{ name: 'old.png', type: 'image/png', size: 100 }]; input.events.change(); const staleReader = readers.at(-1); context.render({ timezone: 'Europe/Moscow', logoUrl: '/fresh.png' }); staleReader.result = 'old'; staleReader.onload(); assert.equal(controls.get('#company-logo-preview').children[0].src, '/fresh.png');
let count = 4; context.companyPhoneRows = () => Array(count).fill({});
vm.runInContext(company.slice(company.indexOf('  let companyControlsDisabled ='), company.indexOf('  const renderCompanyPhones =')) + '\n globalThis.phoneLimit = refreshCompanyPhoneLimit; globalThis.enablePhones = () => { companyControlsDisabled = false; };', context);
context.enablePhones(); context.phoneLimit(); assert.equal(controls.get('#company-add-phone').disabled, false); count = 5; context.phoneLimit(); assert.equal(controls.get('#company-add-phone').disabled, true); count = 4; context.phoneLimit(); assert.equal(controls.get('#company-add-phone').disabled, false);
assert(!company.includes('vipRoomMinimums')); assert(!company.includes('vip-minimum-1')); assert(company.includes('Promise.resolve(companyLogoRemoved ? null : undefined)')); assert(company.includes('renderCompanyData(active)'));
assert(staffProfile.includes('placeholder="Номер"'));
assert(staffProfile.includes('type="tel" inputmode="tel" aria-label="Номер телефона"'));
for (const portal of [source, distPortal]) {
  assert(portal.includes('placeholder="Например, +7 912 345-67-89"'));
  assert(portal.includes('Телефоны<input id="client-phone" type="tel" inputmode="tel" placeholder="Например, +7 912 345-67-89"><small class="muted">Можно указать несколько через точку с запятой</small>'));
  assert(portal.includes('id="reservation-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Например, +7 912 345-67-89"'));
  assert(portal.includes('id="delivery-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Например, +7 912 345-67-89"'));
  assert(portal.includes('Проверьте номер телефона. Например: +7 912 345-67-89.'));
  assert(!portal.includes('+7 (___) ___-__-__'), 'active phone placeholders and validation messages do not show underscore masks');
  assert(portal.includes('id="staff-phone-primary" name="phone_primary" type="tel" inputmode="tel" placeholder="Номер телефона" autocomplete="tel"'));
  assert(!portal.includes('id="staff-phone-primary" name="phone_primary" type="tel" placeholder="+7 (___) ___-__-__"'));
}
for (const fields of [staffPhoneFields, distStaffPhoneFields]) {
  assert(fields.includes('<input type="tel" inputmode="tel" placeholder="Номер телефона" aria-label="Номер телефона">'));
  assert(!fields.includes('placeholder="+7 (___) ___-__-__"'));
}
for (const card of [staffAdminCard, distStaffAdminCard]) {
  assert(card.includes('<input type="tel" inputmode="tel" placeholder="Номер телефона">'));
  assert(!card.includes('placeholder="+7 (___) ___-__-__"'));
}
assert(staffProfile.includes('aria-label="Добавить номер телефона" title="Добавить номер телефона">＋ Добавить</button>'));
for (const guard of ['samePreferenceSession(identity)', 'expectedVenueId', 'companySaving', 'venue_refresh_failed', 'companyReadSequence']) assert(company.includes(guard), guard);
assert(css.includes('animation:company-page-frame-pulse 8s ease-in-out infinite'));
assert(css.includes('pointer-events:none;z-index:-1'));
assert(css.includes('input[type=radio]{appearance:auto;width:18px;height:18px;min-width:18px;min-height:18px'));
assert(css.includes('@media(prefers-reduced-motion:reduce){#page-content.company-page-active::before{animation:none'));
for (const stylesheet of [css, distCss]) {
  assert.match(stylesheet, /\.staff-admin-modal \.staff-admin-add,\.velora-theme \.staff-form \.staff-phone-list__add\{[^}]*min-height:44px[^}]*background:var\(--ui-input\);color:var\(--ui-text-secondary\)/);
  assert.match(stylesheet, /\.staff-admin-modal \.staff-admin-add:hover,\.velora-theme \.staff-form \.staff-phone-list__add:hover\{border-color:var\(--ui-border-control\);background:var\(--ui-raised\);color:var\(--ui-text-primary\)\}/);
  assert.match(stylesheet, /\.velora-theme #company #company-add-phone\{[^}]*background:var\(--ui-input\);color:var\(--ui-text-secondary\)/);
  assert.match(stylesheet, /\.velora-theme #company #company-add-phone:hover\{background:var\(--ui-raised\);color:var\(--ui-text-primary\)\}/);
  assert.match(stylesheet, /\.velora-theme #company #company-add-phone\{[^}]*min-height:44px/);
  assert.match(stylesheet, /\.velora-theme #company #company-add-phone:focus-visible\{outline:2px solid var\(--ui-focus\);outline-offset:2px\}/);
  assert.match(stylesheet, /\.staff-profile-dialog \.staff-profile-phone-add\{[^}]*min-height:44px[^}]*background:var\(--ui-input\);color:var\(--ui-text-secondary\)/);
  assert.match(stylesheet, /\.staff-profile-dialog \.staff-profile-phone-add:hover\{background:var\(--ui-raised\);color:var\(--ui-text-primary\)\}/);
  assert.match(stylesheet, /\.staff-profile-dialog \.staff-profile-phone-add:focus-visible\{outline:2px solid var\(--ui-focus\);outline-offset:2px\}/);
  assert.match(stylesheet, /\.staff-phone-row__remove\{[^}]*color:#ff6e78/);
}
console.log('PASS company form polish: persisted/new/removed logo, stale preview, normalized data, non-Russian timezone, phone limit, payload and scoped visual contracts');
