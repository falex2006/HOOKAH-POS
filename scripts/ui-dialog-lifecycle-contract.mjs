import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Execute the shipped shared module. This deliberately models DOM mechanics only;
// actual browser focus, native top layer, pixels and API persistence are separate QA.
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('ui-dialog.js', root), 'utf8');
const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key]);

function fixture() {
  let document;
  const observers = new Set(), timers = new Map();
  let timerSequence = 0;
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.children = [];
      this.listeners = new Map(); this.style = {}; this.dataset = {}; this.parentNode = null;
      this.disabled = false; this.checked = false; this._value = ''; this._text = ''; this.inert = false;
      this.rect = { x: 0, y: 0, width: 400, height: 40 };
      this.classList = {
        contains: value => this.className.split(/\s+/).includes(value),
        add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...values])].join(' '); },
        remove: (...values) => { this.className = this.className.split(/\s+/).filter(value => !values.includes(value)).join(' '); },
        toggle: (value, force) => { const enabled = force === undefined ? !this.classList.contains(value) : Boolean(force); if (enabled) this.classList.add(value); else this.classList.remove(value); return enabled; }
      };
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get tabIndex() { return this.hasAttribute('tabindex') ? Number(this.getAttribute('tabindex')) : ['BUTTON','INPUT','SELECT','TEXTAREA','A'].includes(this.tagName) ? 0 : -1; }
    set tabIndex(value) { this.setAttribute('tabindex', value); }
    get type() { return this.getAttribute('type') || (this.tagName === 'BUTTON' ? 'submit' : 'text'); }
    get name() { return this.getAttribute('name') || ''; }
    get value() {
      if (this.tagName === 'SELECT') return this._selectedValue ?? (this.children.find(child => child.hasAttribute('selected')) || this.children[0])?.value ?? '';
      return this._value;
    }
    set value(value) { this._value = String(value); if (this.tagName === 'SELECT') this._selectedValue = String(value); }
    get isConnected() { return this === document.body || this === document.head || Boolean(this.parentNode?.isConnected); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
    set innerHTML(html) {
      this.textContent = ''; const stack = [this];
      const pieces = String(html).match(/<[^>]+>|[^<]+/g) || [];
      for (const piece of pieces) {
        if (piece.startsWith('</')) { stack.pop(); continue; }
        if (!piece.startsWith('<')) { const parent = stack.at(-1); parent._text += decode(piece); if (parent.tagName === 'TEXTAREA') parent._value += decode(piece); continue; }
        const tag = /^<([a-z][\w-]*)/i.exec(piece)?.[1]; if (!tag) continue;
        const child = new Node(tag); const attrs = piece.slice(tag.length + 1, -1);
        for (const match of attrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? ''));
        stack.at(-1).append(child); if (!['INPUT','BR','IMG','LINK','META','HR'].includes(child.tagName)) stack.push(child);
      }
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'value') this._value = String(value); if (name === 'checked') this.checked = true; if (name === 'disabled') this.disabled = true; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    matches(selector) {
      return selector.split(',').some(part => {
        const value = part.trim(); if (!value) return false;
        if (value === ':invalid') return !this.valid;
        const tag = /^[a-z][\w-]*/i.exec(value)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
        for (const match of value.matchAll(/#([\w-]+)/g)) if (this.id !== match[1]) return false;
        for (const match of value.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(match[1])) return false;
        for (const match of value.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
          const name = match[1]; const present = name === 'inert' ? this.inert : this.hasAttribute(name);
          if (!present || (match[2] !== undefined && this.getAttribute(name) !== match[2])) return false;
        }
        return true;
      });
    }
    closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) {
      const parts = selector.split(',').map(part => part.trim()); const found = [];
      const visit = node => { for (const child of node.children) {
        if (parts.some(part => { const chain = part.split(/\s+/); const last = chain.pop(); return child.matches(last) && (!chain.length || Boolean(child.parentNode?.closest(chain.join(' ')))); })) found.push(child);
        visit(child);
      } }; visit(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() { return this.closest('[hidden]') ? { ...this.rect, width: 0, height: 0 } : this.rect; }
    focus() { if (!this.isConnected || this.disabled || this.closest('[hidden],[inert]')) return; document.activeElement = this; document.dispatch('focusin', { target: this }); }
    addEventListener(type, callback, options = false) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); const capture = typeof options === 'boolean' ? options : Boolean(options?.capture); this.listeners.get(type).add({ callback, capture }); }
    removeEventListener(type, callback, options = false) { const capture = typeof options === 'boolean' ? options : Boolean(options?.capture); for (const listener of this.listeners.get(type) || []) if (listener.callback === callback && listener.capture === capture) this.listeners.get(type).delete(listener); }
    dispatch(type, extra = {}) {
      const event = { type, target: this, key: '', shiftKey: false, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() { this.stopped = true; }, ...extra };
      const results = [];
      for (const { callback } of this.listeners.get(type) || []) { results.push(callback(event)); if (event.stopped) break; }
      return { event, results };
    }
    get elements() { return { namedItem: name => this.querySelectorAll('input,select,textarea').find(control => control.name === name) || null }; }
    get valid() {
      if (!['INPUT','SELECT','TEXTAREA'].includes(this.tagName) || this.disabled) return true;
      if (this.hasAttribute('required') && (this.type === 'checkbox' ? !this.checked : !this.value)) return false;
      if (this.type === 'number' && this.value !== '') {
        const value = Number(this.value); if (!Number.isFinite(value)) return false;
        if (this.hasAttribute('min') && value < Number(this.getAttribute('min'))) return false;
        if (this.hasAttribute('max') && value > Number(this.getAttribute('max'))) return false;
      }
      return true;
    }
    get validationMessage() { return this.valid ? '' : 'Проверьте значение поля'; }
    checkValidity() {
      const invalid = this.querySelectorAll('input,select,textarea').filter(control => !control.valid);
      for (const control of invalid) this.dispatch('invalid', { target: control });
      return invalid.length === 0;
    }
  }
  document = new Node('document'); document.body = new Node('body'); document.head = new Node('head');
  document.body.parentNode = document; document.head.parentNode = document; document.children = [document.head, document.body];
  document.createElement = tag => new Node(tag); document.getElementById = id => document.querySelector('#' + id);
  const main = new Node('main'); main.id = 'page-content'; const heading = new Node('h1'); heading.textContent = 'Рабочий экран'; main.append(heading);
  const trigger = new Node('button'); trigger.textContent = 'Открыть'; main.append(trigger); document.body.append(main);
  const previouslyInert = new Node('aside'); previouslyInert.inert = true; document.body.append(previouslyInert);
  const lock = new Node('div'); lock.className = 'screen-lock-overlay'; const pin = new Node('input'); pin.id = 'screen-lock-pin'; lock.append(pin); document.body.append(lock);
  const settings = new Node('dialog'); settings.className = 'lock-settings-dialog'; const settingInput = new Node('input'); settings.append(settingInput); document.body.append(settings);
  document.body.style.overflow = 'scroll'; document.activeElement = trigger;
  class Data {
    constructor(form) { this.form = form; }
    entries() { return this.form.querySelectorAll('input,select,textarea').filter(control => control.name && !control.disabled && (control.type !== 'checkbox' || control.checked)).map(control => [control.name, control.value || (control.type === 'checkbox' ? 'on' : '')]); }
  }
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const context = vm.createContext({ window: {}, document, FormData: Data, MutationObserver: Observer,
    getComputedStyle: node => ({ visibility: node.visibility || 'visible' }),
    setTimeout: (callback, duration) => { const id = ++timerSequence; timers.set(id, { callback, duration }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context, { filename: 'ui-dialog.js' });
  return { Node, document, main, heading, trigger, previouslyInert, lock, pin, settings, settingInput, timers, observers, context,
    ui: context.window.HOOKAH_UI, flush: () => { for (const observer of [...observers]) observer.callback(); } };
}

const defaults = { title: 'Название окна', description: 'Описание', draftPolicy: 'discard', pendingClosePolicy: 'block', fields: [{ name: 'name', label: 'Имя', value: 'Тест' }] };
const open = (f, options = {}) => f.ui.open({ ...defaults, ...options });
const keys = (f, key, extra = {}) => f.document.dispatch('keydown', { key, ...extra }).event;
const submit = async handle => { const result = handle.form.dispatch('submit'); await Promise.all(result.results); return result.event; };
const input = (handle, name, value) => { const control = handle.form.elements.namedItem(name); control.value = value; handle.form.dispatch('input', { target: control }); return control; };
const plain = value => JSON.parse(JSON.stringify(value));
let count = 0;
const failures = [];
async function test(name, run) { try { await run(); count++; } catch (error) { failures.push(`${name}: ${error.message.slice(0, 400)}`); } }

await test('singleton initialization', () => { const f = fixture(), ui = f.ui; vm.runInContext(source, f.context); assert.equal(f.ui, ui); assert.equal(f.ui.version, 1); assert.ok(Object.isFrozen(ui)); });
await test('explicit draft policy required', () => { const f = fixture(); assert.throws(() => open(f, { draftPolicy: undefined }), /Explicit/); });
await test('explicit pending policy required', () => { const f = fixture(); assert.throws(() => open(f, { pendingClosePolicy: 'allow' }), /Explicit/); });
await test('unknown adapter rejected', () => { const f = fixture(); assert.throws(() => open(f, { adapter: 'unknown' }), /Unknown/); });
await test('blank title rejected', () => { const f = fixture(); assert.throws(() => open(f, { title: ' ' }), /title/); });
await test('portal required default preserved', () => { const f = fixture(); assert.equal(f.ui.adapters.portal.required({}), true); assert.equal(f.ui.adapters.portal.required({ required: false }), false); });
await test('staff optional default preserved', () => { const f = fixture(); assert.equal(f.ui.adapters.staff.required({}), false); assert.equal(f.ui.adapters.staff.required({ required: true }), true); });
await test('portal checkbox payload boolean', () => { const f = fixture(), h = open(f, { fields: [{ name: 'yes', label: 'Да', type: 'checkbox', value: true, required: false }, { name: 'no', label: 'Нет', type: 'checkbox', required: false }] }); assert.deepEqual(plain(f.ui.adapters.portal.read(h.form, [{ name: 'yes', type: 'checkbox' }, { name: 'no', type: 'checkbox' }])), { yes: true, no: false }); h.close(); });
await test('staff checkbox checked property and raw payload preserved', () => { const f = fixture(), h = open(f, { adapter: 'staff', fields: [{ name: 'yes', label: 'Да', type: 'checkbox', checked: true }, { name: 'no', label: 'Нет', type: 'checkbox', checked: false }] }); assert.equal(h.form.elements.namedItem('yes').checked, true); assert.deepEqual(plain(f.ui.adapters.staff.read(h.form)), { yes: 'on' }); h.close(); });
await test('staff checkbox value cannot invent checked', () => { const f = fixture(), h = open(f, { adapter: 'staff', fields: [{ name: 'flag', label: 'Нет', type: 'checkbox', value: true, checked: false }] }); assert.equal(h.form.elements.namedItem('flag').checked, false); h.close(); });
await test('string values unchanged', () => { const f = fixture(), h = open(f, { fields: [{ name: 'n', label: 'Число', type: 'number', value: 12 }, { name: 's', label: 'Выбор', type: 'select', value: 'x', options: [{ value: 'x', label: 'Выбор' }] }] }); assert.deepEqual(plain(f.ui.adapters.portal.read(h.form, [])), { n: '12', s: 'x' }); h.close(); });
await test('escaped names labels values', () => { const f = fixture(), h = open(f, { title: '<script>x</script>', fields: [{ name: 'note', label: '<b>Имя</b>', value: '<img src=x>' }] }); assert.equal(h.element.querySelector('h2').textContent, '<script>x</script>'); assert.equal(h.element.querySelectorAll('script,img').length, 0); assert.equal(h.form.elements.namedItem('note').value, '<img src=x>'); h.close(); });
await test('accessible name description', () => { const f = fixture(), h = open(f); assert.equal(h.element.getAttribute('role'), 'dialog'); assert.equal(h.element.getAttribute('aria-modal'), 'true'); assert.equal(f.document.getElementById(h.element.getAttribute('aria-labelledby')).textContent, defaults.title); assert.equal(f.document.getElementById(h.element.getAttribute('aria-describedby')).textContent, defaults.description); h.close(); });
await test('title and description field IDs cannot collide with window semantics', () => {
  const f = fixture(), h = open(f, { fields: [{ name: 'title', label: 'Название задачи', value: 'Тест' }, { name: 'description', label: 'Описание задачи', type: 'textarea', value: 'Текст', required: false }] });
  const ids = h.element.querySelectorAll('[id]').map(node => node.id); assert.equal(new Set(ids).size, ids.length);
  const name = f.document.getElementById(h.element.getAttribute('aria-labelledby')), description = f.document.getElementById(h.element.getAttribute('aria-describedby'));
  assert.equal(name.tagName, 'H2'); assert.equal(name.textContent, defaults.title); assert.equal(description.tagName, 'P'); assert.equal(description.textContent, defaults.description);
  for (const fieldName of ['title','description']) { const control = h.form.elements.namedItem(fieldName); assert.notEqual(control.id, name.id); assert.notEqual(control.id, description.id); assert.equal(h.element.querySelector(`label[for="${control.id}"]`).getAttribute('for'), control.id); assert.equal(f.document.getElementById(control.id + '-error').tagName, 'SMALL'); }
  h.close();
});
await test('first field initial focus', () => { const f = fixture(), h = open(f); assert.equal(f.document.activeElement, h.form.elements.namedItem('name')); h.close(); });
await test('explicit initial focus callback', () => { const f = fixture(), h = open(f, { initialFocus: form => form.querySelector('[data-ui-cancel]') }); assert.equal(f.document.activeElement, h.element.querySelector('[data-ui-cancel]')); h.close(); });
await test('Tab wraps last to first', () => { const f = fixture(), h = open(f); const nodes = h.element.querySelectorAll('button,input,select,textarea').filter(node => !node.closest('[hidden]')); nodes.at(-1).focus(); assert.equal(keys(f, 'Tab').defaultPrevented, true); assert.equal(f.document.activeElement, nodes[0]); h.close(); });
await test('Shift Tab wraps first to last', () => { const f = fixture(), h = open(f); const nodes = h.element.querySelectorAll('button,input,select,textarea').filter(node => !node.closest('[hidden]')); nodes[0].focus(); keys(f, 'Tab', { shiftKey: true }); assert.equal(f.document.activeElement, nodes.at(-1)); h.close(); });
await test('outside focus redirected inside', () => { const f = fixture(), h = open(f); const outsider = new f.Node('button'); f.document.body.append(outsider); outsider.focus(); assert.equal(h.element.contains(f.document.activeElement), true); h.close(); });
await test('consumed Escape ignored', () => { const f = fixture(), h = open(f); keys(f, 'Escape', { defaultPrevented: true }); assert.equal(h.element.isConnected, true); h.close(); });
await test('Escape dismisses clean window', async () => { const f = fixture(), h = open(f); keys(f, 'Escape'); assert.equal((await h.promise).reason, 'escape'); });
await test('dropdown consumes first Escape', () => { const f = fixture(), h = open(f); const dropdown = new f.Node('div'); dropdown.className = 'custom-select is-open'; const trigger = new f.Node('button'); trigger.className = 'custom-select-trigger'; trigger.setAttribute('aria-expanded', 'true'); dropdown.append(trigger); h.form.append(dropdown); keys(f, 'Escape'); assert.equal(dropdown.classList.contains('is-open'), false); assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(h.element.isConnected, true); keys(f, 'Escape'); assert.equal(h.element.isConnected, false); });
await test('background inert and scroll lock', () => { const f = fixture(), h = open(f); assert.equal(f.main.inert, true); assert.equal(f.document.body.style.overflow, 'hidden'); assert.equal(f.lock.inert, false); assert.equal(f.settings.inert, false); h.close(); });
await test('exact previous inert and overflow restored', () => { const f = fixture(), h = open(f); h.close(); assert.equal(f.main.inert, false); assert.equal(f.previouslyInert.inert, true); assert.equal(f.document.body.style.overflow, 'scroll'); });
await test('late background leased', () => { const f = fixture(), h = open(f); const late = new f.Node('section'); f.document.body.append(late); f.flush(); assert.equal(late.inert, true); h.close(); assert.equal(late.inert, false); });
await test('drag from card to backdrop ignored', () => { const f = fixture(), h = open(f); h.element.dispatch('pointerdown', { target: h.form }); h.element.dispatch('pointerup'); h.element.dispatch('click', { target: h.element }); assert.equal(h.element.isConnected, true); h.close(); });
await test('drag from backdrop into card ignored', () => { const f = fixture(), h = open(f); h.element.dispatch('pointerdown'); h.element.dispatch('pointerup', { target: h.form }); h.element.dispatch('click', { target: h.element }); assert.equal(h.element.isConnected, true); h.close(); });
await test('cancelled pointer cannot dismiss backdrop', () => { const f = fixture(), h = open(f); h.element.dispatch('pointerdown'); h.element.dispatch('pointerup'); h.element.dispatch('pointercancel'); h.element.dispatch('click'); assert.equal(h.element.isConnected, true); h.close(); });
await test('true backdrop pointer click dismisses', async () => { const f = fixture(), h = open(f); h.element.dispatch('pointerdown'); h.element.dispatch('pointerup'); h.element.dispatch('click'); assert.equal((await h.promise).reason, 'backdrop'); });
await test('restore connected opener', () => { const f = fixture(), h = open(f); h.close(); assert.equal(f.document.activeElement, f.trigger); });
await test('removed opener fallback tabindex lasts until blur', () => { const f = fixture(), h = open(f); f.trigger.remove(); h.close(); assert.equal(f.document.activeElement, f.main); assert.equal(f.main.tabIndex, -1); f.main.dispatch('blur'); assert.equal(f.main.hasAttribute('tabindex'), false); });
await test('disabled opener fallback', () => { const f = fixture(), h = open(f); f.trigger.disabled = true; h.close(); assert.equal(f.document.activeElement, f.main); });
await test('hidden opener fallback', () => { const f = fixture(), h = open(f); f.trigger.hidden = true; h.close(); assert.equal(f.document.activeElement, f.main); });
await test('fallback existing tabindex restored', () => { const f = fixture(); f.main.tabIndex = 3; const h = open(f); f.trigger.remove(); h.close(); assert.equal(f.main.tabIndex, 3); });
await test('close once listener and observer disposal', async () => { const f = fixture(); let closes = 0; const h = open(f, { onClose: () => closes++ }); h.close(); h.close(); assert.equal(closes, 1); assert.equal(f.observers.size, 0); assert.equal(f.document.listeners.get('keydown').size, 0); assert.equal(f.document.listeners.get('focusin').size, 0); assert.equal((await h.promise).reason, 'cancel'); });
await test('confirm-discard dirty close requires consent', async () => { const f = fixture(), h = open(f, { draftPolicy: 'confirm-discard' }); input(h, 'name', 'Правка'); assert.equal(h.close(), false); assert.equal(h.element.querySelector('[data-ui-discard]').hidden, false); h.element.querySelector('[data-ui-discard-confirm]').dispatch('click'); assert.equal((await h.promise).reason, 'discard-confirmed'); });
await test('keep draft after discard prompt', () => { const f = fixture(), h = open(f, { draftPolicy: 'confirm-discard' }); input(h, 'name', 'Правка'); h.close(); h.element.querySelector('[data-ui-keep]').dispatch('click'); assert.equal(h.element.querySelector('[data-ui-discard]').hidden, true); assert.equal(h.form.elements.namedItem('name').value, 'Правка'); h.close('discard-confirmed'); });
await test('Escape from discard prompt retains input focus', () => { const f = fixture(), h = open(f, { draftPolicy: 'confirm-discard' }); const control = input(h, 'name', 'Правка'); control.focus(); h.close(); keys(f, 'Escape'); assert.equal(h.element.querySelector('[data-ui-discard]').hidden, true); assert.equal(f.document.activeElement, control); h.close('discard-confirmed'); });
await test('preserve policy returns draft only via onClose', async () => { const f = fixture(); let close; const h = open(f, { draftPolicy: 'preserve', onClose: value => close = value }); input(h, 'name', 'Черновик'); h.close(); assert.equal(close.values.name, 'Черновик'); assert.equal(close.draftPolicy, 'preserve'); assert.equal((await h.promise).values, null); });
await test('native required error links local field', async () => { const f = fixture(), h = open(f); const control = input(h, 'name', ''); await submit(h); assert.equal(h.element.isConnected, true); assert.equal(control.getAttribute('aria-invalid'), 'true'); const error = f.document.getElementById(control.id + '-error'); assert.equal(error.hidden, false); assert.equal(control.getAttribute('aria-describedby'), error.id); h.close(); });
await test('editing clears field invalid state', async () => { const f = fixture(), h = open(f); input(h, 'name', ''); await submit(h); const control = input(h, 'name', 'Исправлено'); assert.equal(control.hasAttribute('aria-invalid'), false); assert.equal(f.document.getElementById(control.id + '-error').hidden, true); h.close(); });
await test('field error preserves existing description links', () => { const f = fixture(), h = open(f); const control = h.form.elements.namedItem('name'); control.setAttribute('aria-describedby', 'existing-help'); f.ui.fieldError(control, 'Ошибка'); assert.equal(control.getAttribute('aria-describedby'), 'existing-help ' + control.id + '-error'); f.ui.fieldError(control, ''); assert.equal(control.getAttribute('aria-describedby'), 'existing-help ' + control.id + '-error'); h.close(); });
await test('custom select trigger gets error association', () => { const f = fixture(), h = open(f, { fields: [{ name: 'choice', label: 'Выбор', type: 'select', options: [{ value: '', label: 'Выберите' }] }] }); const select = h.form.elements.namedItem('choice'), wrapper = new f.Node('div'), trigger = new f.Node('button'); wrapper.className = 'custom-select'; trigger.className = 'custom-select-trigger'; select.parentNode.append(wrapper); wrapper.append(select, trigger); f.ui.fieldError(select, 'Нужен выбор'); assert.equal(trigger.getAttribute('aria-invalid'), 'true'); assert.equal(trigger.getAttribute('aria-describedby'), select.id + '-error'); h.close(); });
await test('custom validation retains draft and field focus', async () => { const f = fixture(), h = open(f, { validate: () => ({ field: 'name', message: 'Имя занято' }) }); await submit(h); assert.equal(h.form.elements.namedItem('name').getAttribute('aria-invalid'), 'true'); assert.equal(f.document.activeElement, h.form.elements.namedItem('name')); assert.equal(h.element.isConnected, true); h.close(); });
await test('global custom validation alert', async () => { const f = fixture(), h = open(f, { validate: () => 'Проверьте данные' }); await submit(h); assert.equal(h.element.querySelector('.ui-modal-message').hidden, false); assert.equal(h.element.querySelector('.ui-modal-message').textContent, 'Проверьте данные'); h.close(); });
await test('pending blocks close Escape backdrop and duplicate submit', async () => { const f = fixture(); let done, calls = 0; const h = open(f, { onSubmit: () => { calls++; return new Promise(resolve => done = resolve); } }); const pendingSubmit = submit(h); assert.equal(h.pending, true); assert.equal(h.form.getAttribute('aria-busy'), 'true'); assert.equal(h.close(), false); keys(f, 'Escape'); h.element.dispatch('pointerdown'); h.element.dispatch('pointerup'); h.element.dispatch('click'); await submit(h); assert.equal(calls, 1); assert.equal(h.element.isConnected, true); done({ saved: true }); await pendingSubmit; assert.equal((await h.promise).reason, 'success'); });
await test('pending restores originally disabled controls on failure', async () => { const f = fixture(), h = open(f, { onSubmit: async () => { throw Error('offline'); } }); const cancel = h.element.querySelector('[data-ui-cancel]'); cancel.disabled = true; await submit(h); assert.equal(cancel.disabled, true); assert.equal(h.form.elements.namedItem('name').disabled, false); assert.equal(h.pending, false); h.close(); });
await test('error remains in window and retry succeeds', async () => { const f = fixture(); let calls = 0; const h = open(f, { onSubmit: async () => { if (++calls === 1) throw Error('offline'); return 'ok'; }, errorMessage: () => 'Нет связи' }); await submit(h); const message = h.element.querySelector('.ui-modal-message'); assert.equal(message.textContent, 'Нет связи'); assert.equal(message.hidden, false); assert.equal(h.form.elements.namedItem('name').value, 'Тест'); await submit(h); assert.equal(calls, 2); assert.equal((await h.promise).result, 'ok'); });
await test('context change before submit rejects without request', async () => { const f = fixture(); let context = 'A', calls = 0; const h = open(f, { context: () => context, onSubmit: () => calls++ }); context = 'B'; await submit(h); assert.equal(calls, 0); assert.equal((await h.promise).reason, 'context-changed'); });
await test('context change on refresh strips draft', async () => { const f = fixture(); let context = 'A', close; const h = open(f, { context: () => context, onClose: value => close = value }); context = 'B'; h.refresh(); assert.equal(close.values, null); assert.equal((await h.promise).reason, 'context-changed'); });
await test('stale pending success cannot claim success', async () => { const f = fixture(); let context = 'A', done; const h = open(f, { context: () => context, onSubmit: () => new Promise(resolve => done = resolve) }); const pendingSubmit = submit(h); context = 'B'; h.refresh(); assert.equal(h.pending, true); done('persisted elsewhere'); await pendingSubmit; assert.equal((await h.promise).reason, 'context-changed'); });
await test('stale pending error cannot show current error', async () => { const f = fixture(); let current = true, reject; const h = open(f, { isCurrent: () => current, onSubmit: () => new Promise((_, bad) => reject = bad) }); const pendingSubmit = submit(h); current = false; reject(Error('offline')); await pendingSubmit; assert.equal((await h.promise).reason, 'context-changed'); });
await test('lock synchronous focus immediately yields', () => { const f = fixture(), h = open(f); f.document.body.classList.add('screen-locked'); f.pin.focus(); assert.equal(f.document.activeElement, f.pin); f.flush(); assert.equal(h.element.inert, true); assert.equal(h.element.getAttribute('aria-hidden'), 'true'); f.document.body.classList.remove('screen-locked'); f.flush(); assert.equal(h.element.inert, false); h.close(); });
await test('lock synchronous Escape cannot dismiss', () => { const f = fixture(), h = open(f); f.document.body.classList.add('screen-locked'); keys(f, 'Escape'); assert.equal(h.element.isConnected, true); f.document.body.classList.remove('screen-locked'); f.flush(); h.close(); });
await test('native settings focus and keys yield then resume', () => { const f = fixture(), h = open(f); f.settings.setAttribute('open', ''); f.settingInput.focus(); assert.equal(f.document.activeElement, f.settingInput); keys(f, 'Escape'); assert.equal(h.element.isConnected, true); f.flush(); assert.equal(h.element.inert, true); assert.equal(f.settings.inert, false); f.settings.removeAttribute('open'); f.flush(); assert.equal(h.element.inert, false); h.close(); });
await test('generic open native root remains operable', () => { const f = fixture(), h = open(f); const native = new f.Node('dialog'); native.setAttribute('open', ''); const control = new f.Node('input'); native.append(control); f.document.body.append(native); f.flush(); assert.equal(native.inert, false); assert.equal(h.element.inert, true); control.focus(); assert.equal(f.document.activeElement, control); native.removeAttribute('open'); f.flush(); h.close(); });
await test('no restore focus behind lock on stale context close', async () => { const f = fixture(); let current = true; const h = open(f, { isCurrent: () => current }); f.document.body.classList.add('screen-locked'); f.pin.focus(); current = false; h.refresh(); assert.equal((await h.promise).reason, 'context-changed'); assert.equal(f.document.activeElement, f.pin); });
await test('second shared window rejected without corrupting first', () => { const f = fixture(), first = open(f); assert.throws(() => open(f, { title: 'Второе' }), /already open/); assert.equal(first.element.isConnected, true); assert.equal(f.main.inert, true); assert.equal(f.document.body.style.overflow, 'hidden'); first.close(); assert.equal(f.main.inert, false); assert.equal(f.document.body.style.overflow, 'scroll'); });
await test('throwing onClose cannot strand promise', async () => { const f = fixture(), h = open(f, { onClose: () => { throw Error('caller'); } }); h.close(); assert.equal((await h.promise).reason, 'cancel'); assert.equal(f.main.inert, false); assert.equal(f.observers.size, 0); });
await test('feedback success polite and bounded duration', () => { const f = fixture(), node = f.ui.feedback('Готово', 'success', { duration: 100 }); assert.equal(node.getAttribute('role'), 'status'); assert.equal(node.getAttribute('aria-live'), 'polite'); assert.equal([...f.timers.values()][0].duration, 4000); });
await test('feedback upper duration clamped', () => { const f = fixture(); f.ui.feedback('Готово', 'info', { duration: 12000 }); assert.equal([...f.timers.values()][0].duration, 6000); });
await test('staff legacy long pending warning preserves twelve seconds', () => { const f = fixture(); f.ui.feedback('Сервер сохраняет…', 'info', { duration: 12000, preserveLegacyDuration: true }); assert.equal([...f.timers.values()][0].duration, 12000); });
await test('staff legacy long message preserves eight seconds', () => { const f = fixture(); f.ui.feedback('Не удалось открыть смену', 'info', { duration: 8000, preserveLegacyDuration: true }); assert.equal([...f.timers.values()][0].duration, 8000); });
await test('staff legacy short default gets four readable seconds', () => { const f = fixture(); f.ui.feedback('Готово', 'info', { duration: 2400, preserveLegacyDuration: true }); assert.equal([...f.timers.values()][0].duration, 4000); });
await test('staff explicit error remains sticky despite long duration option', () => { const f = fixture(); f.ui.feedback('Ошибка', 'error', { duration: 12000, preserveLegacyDuration: true }); assert.equal(f.timers.size, 0); });
await test('feedback error alert does not expire', () => { const f = fixture(), node = f.ui.feedback('Ошибка', 'error'); assert.equal(node.getAttribute('role'), 'alert'); assert.equal(node.getAttribute('aria-live'), 'assertive'); assert.equal(node.getAttribute('aria-atomic'), 'true'); assert.equal(f.timers.size, 0); assert.equal(node.isConnected, true); });
await test('feedback replacement cancels old timer', () => { const f = fixture(), old = f.ui.feedback('Готово', 'success'); f.ui.feedback('Ошибка', 'error'); assert.equal(f.document.getElementById('ui-notice'), old); assert.equal(old.textContent, 'Ошибка'); assert.equal(f.timers.size, 0); });
await test('feedback explicit legacy host reused', () => { const f = fixture(), node = f.ui.feedback('Портал', 'info', { id: 'portal-notice', className: 'portal-notice' }); assert.equal(node.id, 'portal-notice'); assert.equal(node.className, 'portal-notice'); assert.equal([...f.timers.values()][0].duration, 4200); });
await test('feedback timer removes only its live host', () => { const f = fixture(), node = f.ui.feedback('Готово'); [...f.timers.values()][0].callback(); assert.equal(node.isConnected, false); });
await test('success close resolves original strings and result', async () => { const f = fixture(), h = open(f, { onSubmit: async values => ({ name: values.name }) }); await submit(h); assert.deepEqual(plain(await h.promise), { reason: 'success', values: { name: 'Тест' }, result: { name: 'Тест' } }); });
await test('repeat open has no old draft under discard', () => { const f = fixture(), first = open(f); input(first, 'name', 'Несохранённое'); first.close(); const second = open(f); assert.equal(second.form.elements.namedItem('name').value, 'Тест'); second.close(); });

// Static delivery checks use the production handler source, not the preview proxy.
await test('new common runtime explicitly public', () => { const server = fs.readFileSync(new URL('server.js', root), 'utf8'); const start = server.indexOf('const publicFiles = new Set(['); assert.ok(start > 0); assert.ok(server.slice(start, server.indexOf(']);', start)).includes("'/ui-dialog.js'"), 'actual server runtime whitelist must include /ui-dialog.js'); });
await test('root dist shared module byte parity', () => assert.equal(source, fs.readFileSync(new URL('dist/ui-dialog.js', root), 'utf8')));
await test('actual static handler serves common runtime and keeps method/asset guards', async () => {
  const serverSource = fs.readFileSync(new URL('server.js', root), 'utf8');
  const start = serverSource.indexOf('function staticFile(req, res) {'), end = serverSource.indexOf('\nconst server = http.createServer(', start);
  assert.ok(start > 0 && end > start, 'actual static handler extraction');
  const staticFile = new Function('fs', 'path', 'root', `${serverSource.slice(start, end)}; return staticFile;`)(fs, path, fileURLToPath(root));
  const server = http.createServer((request, response) => { try { staticFile(request, response); } catch (_) { response.writeHead(500); response.end(); } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = await fetch(url + '/ui-dialog.js?rev=1'); assert.equal(get.status, 200); assert.equal(await get.text(), source); assert.match(get.headers.get('content-type'), /javascript/); assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
    const head = await fetch(url + '/ui-dialog.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const post = await fetch(url + '/ui-dialog.js', { method: 'POST' }); assert.equal(post.status, 405); assert.equal(post.headers.get('allow'), 'GET, HEAD');
    const privateFile = await fetch(url + '/AGENTS.md'); assert.equal(privateFile.status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

if (failures.length) { console.error(`UI-04.1 lifecycle contract FAIL (${count} checks passed, ${failures.length} failed):\n${failures.join('\n')}`); process.exitCode = 1; }
else console.log(`UI-04.1 actual-source dialog lifecycle contract PASS (${count} checks; isolated VM DOM, not actual browser/API/top-layer proof).`);
