import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const platform = fs.readFileSync(new URL('../platform.js', import.meta.url), 'utf8');
const platformHtml = fs.readFileSync(new URL('../platform.html', import.meta.url), 'utf8');
let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'Actual-source markers: ' + startMarker);
  return source.slice(start, end);
}
function element(textContent, href) {
  const classes = new Set(['active']);
  const attributes = new Map([['aria-current', 'page']]);
  const handlers = new Map();
  return { textContent, href, classes, attributes, handlers,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, force) => force ? classes.add(name) : classes.delete(name) },
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
    addEventListener: (name, callback) => handlers.set(name, callback) };
}
const route = slice(app, 'const preserveWorkspaceRoute=', '\n');
const sidebarHandler = slice(app, "document.querySelectorAll('aside nav button').forEach((button)=>button.addEventListener", 'let staffShiftActionPending=');
for (const search of ['', '?venue=venue-a&venueId=123&workspace=desk&mode=legacy&operator=old']) {
  const buttons = ['Рабочий зал','Заказы','Задачи','Бронирования','Склад','Финансы'].map(text => element(text));
  const queues = [], notices = [], scrolls = [];
  const location = { origin: 'http://127.0.0.1:31932', href: '/' };
  const context = { URL, location, queryParams: new URLSearchParams(search), window: { location },
    document: {
      querySelectorAll: selector => { assert.equal(selector, 'aside nav button'); return buttons; },
      querySelector: selector => ({ scrollIntoView: options => scrolls.push({ selector, options }) }),
    }, drawQueue: value => queues.push(value), notice: text => notices.push(text) };
  vm.runInNewContext(route + '\n' + sidebarHandler, context);
  buttons[2].handlers.get('click')();
  const next = new URL(location.href, location.origin);
  check(next.pathname, '/admin', 'Tasks opens the real tasks workspace');
  check(next.hash, '#tasks', 'Tasks selects the tasks section');
  check(queues.length, 0, 'Tasks does not alias the ready-order queue');
  check(scrolls.length, 0, 'Tasks navigates without scrolling the queue');
  check(notices.length, 0, 'Tasks does not announce completed order tasks');
  check(buttons.map(button => button.classes.has('active')), [false,false,true,false,false,false], 'Exactly the clicked task navigation item is active');
  check(buttons.map(button => button.attributes.get('aria-current') || null), [null,null,'page',null,null,null], 'Task aria-current remains unique');
  check(next.searchParams.has('mode') || next.searchParams.has('operator'), false, 'Legacy staff mode is excluded');
  for (const key of ['venue','venueId','workspace']) check(next.searchParams.get(key), new URLSearchParams(search).get(key), 'Workspace parameter preserved: ' + key);
  buttons[1].handlers.get('click')();
  check(queues, ['all'], 'Orders retains the active order queue');
  check(scrolls.map(entry => entry.selector), ['.queue'], 'Orders scrolls its queue');
  for (const [index, expected] of [[3,'/reservations'],[4,'/inventory'],[5,'/finance']]) {
    buttons[index].handlers.get('click')();
    check(new URL(location.href, location.origin).pathname, expected, 'Existing route preserved: ' + expected);
  }
  buttons[0].handlers.get('click')();
  check(scrolls.at(-1).selector, '.tables', 'Working floor retains its own scroll target');
}

// SaaS platform navigation is audited in its own workspace. This local POS
// contract intentionally stops at the POS sidebar and launcher boundaries.
// Execute the real local launcher with an in-memory private-config fixture.
// Special characters must remain credential characters, never URL target delimiters.
const launcher = fs.readFileSync(new URL('./local-full-qa-server.cjs', import.meta.url), 'utf8');
const fixture = { database: 'hookah_local_qa', dbPort: 31930, appPort: 31932,
  dbUser: 'qa@/?#user', dbPassword: 'synthetic@/?#password', password: 'synthetic-owner-only',
  appKey: 'synthetic-key-only', platformLogin: 'launcher@example.invalid' };
function runLauncher(config) {
  const env = {}, required = [];
  const fsMock = {
    readFileSync: filename => { assert.ok(filename.endsWith(path.join('full-local-qa','runtime.json'))); return JSON.stringify(config); },
    existsSync: () => false,
  };
  vm.runInNewContext(launcher, { __dirname: path.resolve('scripts'), process: { env },
    require: name => {
      if (name === 'node:fs') return fsMock;
      if (name === 'node:path') return path;
      assert.equal(name, '../server.js'); required.push(name); return {};
    },
  }, { timeout: 1000 });
  return { env, required };
}
const launched = runLauncher(fixture);
const launchedUrl = new URL(launched.env.DATABASE_URL);
check(decodeURIComponent(launchedUrl.username), fixture.dbUser, 'Actual launcher escapes username delimiters');
check(decodeURIComponent(launchedUrl.password), fixture.dbPassword, 'Actual launcher escapes password delimiters');
check([launchedUrl.hostname, launchedUrl.port, launchedUrl.pathname, launchedUrl.search, launchedUrl.hash], ['127.0.0.1','31930','/hookah_local_qa','',''], 'Credentials cannot alter the local database target');
check(launched.required, ['../server.js'], 'Validated launcher loads only the intended server');
check([launched.env.HOST,launched.env.PORT,launched.env.AUTH_REQUIRED,launched.env.DEMO_MODE], ['127.0.0.1','31932','true','false'], 'Actual launcher uses only the authorized local authenticated app');
for (const overrides of [{ dbUser: '' }, { dbPassword: '' }, { dbPort: 5432 }, { appPort: 80 }, { database: 'production' }]) {
  assert.throws(() => runLauncher({ ...fixture, ...overrides }), /dedicated local QA config/); checks++;
}
console.log(`LOCAL NAVIGATION/LAUNCHER ACTUAL SOURCE: PASS (${checks} cases; VM only, no browser/database writes)`);
