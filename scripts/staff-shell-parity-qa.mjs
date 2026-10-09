import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const portal = read('portal.js');
const app = read('app.js');
const between = (source, start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source boundaries: ${start}`);
  return source.slice(from, to);
};
const permissionsSource = between(portal, 'const hasPortalPermission =', 'const operationsNav =');
const employeeSource = between(portal, 'const adminNavigationAllowed =', '// Keep the sidebar structure identical');
const linkSource = between(portal, '  const makeLink =', '  if (employeePortalRole)');
assert.match(portal, /if \(employeePortalRole\) \{ normalizeEmployeeSidebar\(sidebar, makeLink\); return; \}/);
assert.ok(portal.indexOf('if (employeePortalRole)') < portal.indexOf('const navs = [...sidebar.querySelectorAll'));

// Small DOM implementing only the selectors used by the extracted production
// employee renderer. Browser layout and management disclosure behavior remain
// covered by the existing contracts and browser acceptance.
function harness(role, grants, route = '/reservations?venue=venue-a&workspace=w') {
  const location = new URL(route, 'https://qa.invalid');
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentElement = null; this.className = ''; this.attributes = {}; this.dataset = {}; this.hidden = false; }
    get classList() {
      const values = () => new Set(this.className.split(/\s+/).filter(Boolean));
      return {
        contains: (name) => values().has(name),
        add: (...names) => { this.className = [...new Set([...values(), ...names])].join(' '); },
        toggle: (name, on) => { const next = values(); const enabled = on ?? !next.has(name); if (enabled) next.add(name); else next.delete(name); this.className = [...next].join(' '); return enabled; },
      };
    }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    before(...nodes) { const parent = this.parentElement; assert.ok(parent); for (const node of nodes) { node.remove(); node.parentElement = parent; parent.children.splice(parent.children.indexOf(this), 0, node); } }
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return name === 'href' ? this._href ?? null : this.attributes[name] ?? null; }
    get href() { return new URL(this._href, location).href; }
    set href(value) { this._href = value; }
    querySelectorAll(selector) {
      const matches = (node, part) => {
        if (part.startsWith('.')) return node.classList.contains(part.slice(1));
        if (part === 'a') return node.tagName === 'a';
        const href = part.match(/^a\[href="([^"]+)"\]$/);
        if (href) return node.tagName === 'a' && node.getAttribute('href') === href[1];
        throw new Error(`Unsupported QA selector: ${part}`);
      };
      const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
      return [...new Set(selector.split(',').flatMap((part) => {
        part = part.trim();
        const direct = part.startsWith(':scope > ');
        return (direct ? this.children : descendants(this)).filter((node) => matches(node, direct ? part.slice(9) : part));
      }))];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const body = new Element('body'), sidebar = new Element('aside'), header = new Element('header');
  for (const className of ['portal-nav', 'side-label', 'sidebar-nav-groups', 'sidebar-nav-group', 'sidebar-menu-search']) {
    const old = new Element('div'); old.className = className; sidebar.append(old);
  }
  const footer = new Element('footer'); footer.className = 'sidebar-footer'; sidebar.append(footer);
  const action = new Element('button'); action.onclick = () => 'existing-handler'; header.append(action);
  let preferenceCalls = 0;
  const document = { body, createElement: (tag) => new Element(tag), querySelector: (selector) => { assert.equal(selector, '.portal-header'); return header; } };
  // The context's global object exposes the renderer without exporting product code.
  const renderContext = vm.createContext({ URL, location, document, sidebar, portalUser: { role }, portalPermissions: new Set(grants), iconMarkup: (name) => `<icon>${name}</icon>`, window: { __applyInterfacePreferences: () => preferenceCalls++ } });
  vm.runInContext(`${permissionsSource}\n${employeeSource}\n${linkSource}\nglobalThis.subject = { employeePortalRole, render: () => normalizeEmployeeSidebar(sidebar, makeLink) };`, renderContext);
  return { subject: renderContext.subject, sidebar, header, footer, action, get preferenceCalls() { return preferenceCalls; }, links: () => sidebar.querySelectorAll('a'), labels: () => sidebar.querySelectorAll('a').map((link) => link.getAttribute('aria-label')) };
}

const workers = ['bartender', 'hookah_master', 'senior_bartender', 'senior_hookah_master', 'cleaner', 'security', 'technician', 'other_staff', 'staff'];
for (const role of workers) assert.equal(harness(role, []).subject.employeePortalRole, true, role);
for (const role of ['owner', 'admin', 'manager', 'developer', 'unknown']) assert.equal(harness(role, ['orders']).subject.employeePortalRole, false, role);

const normal = harness('bartender', ['floor', 'orders', 'reservations', 'finance_read']);
normal.subject.render();
assert.deepEqual(normal.labels(), ['Рабочий зал', 'Заказы', 'Гости', 'Бронирования', 'Задачи', 'Финансы']);
assert.equal(new URL(normal.links().find((link) => link.getAttribute('aria-label') === 'Заказы').href).searchParams.get('view'), 'orders');
assert.deepEqual(normal.links().filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.getAttribute('aria-label')), ['Бронирования']);
for (const link of normal.links()) { assert.equal(new URL(link.href).searchParams.get('venue'), 'venue-a'); assert.equal(new URL(link.href).searchParams.get('workspace'), 'w'); }
const snapshot = () => normal.links().map((link) => [link.href, link.className, link.getAttribute('aria-label'), link.getAttribute('aria-current')]);
const first = snapshot(); normal.subject.render(); assert.deepEqual(snapshot(), first, 'repeat normalization must not duplicate or alter links');
assert.equal(normal.sidebar.querySelectorAll('.employee-nav').length, 2);
assert.equal(normal.sidebar.querySelectorAll('.sidebar-nav-group').length, 0, 'workers have no disclosure groups');
assert.equal(normal.sidebar.children.at(-1), normal.footer, 'profile footer survives');
assert.equal(normal.header.children[0], normal.action, 'existing action node survives');
assert.equal(normal.action.onclick(), 'existing-handler');
assert.equal(normal.preferenceCalls, 2);

const empty = harness('bartender', []); empty.subject.render(); assert.deepEqual(empty.labels(), [], 'base role never restores absent grants');
const floorOnly = harness('bartender', ['floor']); floorOnly.subject.render(); assert.deepEqual(floorOnly.labels(), [], 'floor without orders cannot enter the combined workspace');
const ordersOnly = harness('bartender', ['orders'], '/orders'); ordersOnly.subject.render();
assert.deepEqual(ordersOnly.labels(), ['Заказы', 'Гости', 'Задачи']);
const ordersLink = ordersOnly.links().find((link) => link.getAttribute('aria-label') === 'Заказы');
assert.equal(new URL(ordersLink.href).pathname, '/orders', 'orders without floor must stay on its permitted portal route');
assert.equal(ordersLink.getAttribute('aria-current'), 'page');
const custom = harness('hookah_master', ['inventory_read', 'finance_read', 'loyalty', 'settings'], '/admin#loyalty'); custom.subject.render();
assert.equal(custom.subject.employeePortalRole, true, 'custom grants do not change shell identity');
assert.deepEqual(custom.labels(), ['Склад', 'Финансы', 'Система лояльности', 'Панель администратора']);
assert.deepEqual(custom.links().filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.getAttribute('aria-label')), ['Система лояльности']);
const scoped = harness('staff', ['staff_view'], '/clients'); scoped.subject.render(); assert.deepEqual(scoped.labels(), ['Гости', 'Панель администратора']);

assert.match(app, /setStaffWorkspaceView\(new URLSearchParams\(location.search\).get\('view'\),\{updateUrl:false\}\)/);
assert.match(app, /url.searchParams.set\('view','orders'\)/);
const workspaceSource = between(app, 'const setStaffWorkspaceView=', '// Queue ages share');
const makeNode = (label) => {
  const attributes = new Map(label ? [['aria-label', label]] : []), classes = new Set();
  return { dataset: {}, classes, classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } }, getAttribute: (key) => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: (key) => attributes.delete(key), replaceChildren(value) { this.text = value; } };
};
const root = makeNode(), title = makeNode(), buttons = ['Рабочий зал', 'Заказы', 'Гости'].map(makeNode);
const location = new URL('https://qa.invalid/?view=orders&venue=v1&order=o1');
const events = {}, replacements = [];
const workspaceContext = vm.createContext({
  URL, URLSearchParams, location,
  window: { addEventListener: (name, callback) => { events[name] = callback; } },
  document: {
    querySelector: (selector) => { if (selector === '.staff-theme') return root; assert.equal(selector, '.staff-header-title b'); return title; },
    querySelectorAll: (selector) => { assert.equal(selector, 'aside nav button'); return buttons; },
    createTextNode: (value) => value,
  },
  history: { replaceState(_state, _title, url) { replacements.push(url); location.href = new URL(url, location).href; } },
});
vm.runInContext(`${workspaceSource}\nglobalThis.setView = setStaffWorkspaceView;`, workspaceContext);
assert.equal(root.dataset.staffView, 'orders', 'deep link selects orders at initial load');
assert.equal(title.text, 'Заказы');
assert.equal(replacements.length, 0, 'initial view does not rewrite URL');
assert.deepEqual(buttons.filter((node) => node.getAttribute('aria-current') === 'page'), [buttons[1]]);
workspaceContext.setView('floor');
assert.equal(location.searchParams.has('view'), false);
assert.equal(location.searchParams.get('venue'), 'v1');
assert.equal(location.searchParams.get('order'), 'o1');
workspaceContext.setView('orders');
assert.equal(location.searchParams.get('view'), 'orders');
assert.equal(root.classes.has('staff-orders-view'), true);
location.searchParams.set('view', 'unknown'); events.popstate();
assert.equal(root.dataset.staffView, 'floor', 'unknown/popstate view falls back to floor');
assert.equal(replacements.length, 2, 'popstate never rewrites browser history');
for (const file of ['portal.js', 'app.js', 'style.css']) assert.equal(read(file), read(`dist/${file}`), `${file}: published parity`);
console.log('STAFF SHELL PARITY QA: PASS (worker roles, exact grants, orders/floor-only routes, context, active links, idempotence, preserved actions, workspace deep link/history, published parity)');
