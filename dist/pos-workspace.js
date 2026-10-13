(function (global) {
  'use strict';

  const stations = { bar: 'Бар', hookah: 'Кальяны' };
  const activeOrderStates = new Set(['open', 'in_progress', 'ready', 'awaiting_payment']);
  const busyItemStates = new Set(['queued', 'in_progress']);
  const tileDescriptions = new WeakMap();
  let tileSequence = 0;
  let snapshot = {};
  let root = null;
  let toolbar = null;
  let filters = null;
  let selectedStation = 'all';
  let orderGeometryFrame = null;
  let orderGeometryObserver = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('class', 'pos-workspace-icon');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/assets/tabler-icons.svg?rev=3#' + name);
    node.append(use);
    return node;
  }

  function button(className, text) {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  }

  function phase(value) {
    const status = typeof value === 'string' ? value : value?.phase || value?.status;
    if (['ready', 'success', 'loaded'].includes(status)) return 'ready';
    if (['loading', 'pending'].includes(status)) return 'loading';
    if (['error', 'stale', 'denied'].includes(status)) return status;
    return 'unknown';
  }

  function unit(count, one, few, many) {
    const remainder = count % 100;
    if (remainder >= 11 && remainder <= 19) return many;
    const last = count % 10;
    return last === 1 ? one : last >= 2 && last <= 4 ? few : many;
  }

  function allowedStations() {
    if (!snapshot.canReadPreparation) return [];
    const source = Array.isArray(snapshot.allowedStations)
      ? snapshot.allowedStations
      : (snapshot.preparationItems || []).map((item) => item.preparationStation);
    return [...new Set(source.filter((station) => Object.hasOwn(stations, station)))];
  }

  function activeOrders() {
    return (Array.isArray(snapshot.orders) ? snapshot.orders : [])
      .filter((order) => order && activeOrderStates.has(order.status));
  }

  function isReady(order) {
    return Array.isArray(order.items) && order.items.length > 0
      && order.items.every((item) => item.preparationStatus === 'ready');
  }

  function currentView() {
    if (root.classList.contains('staff-orders-view')) return 'orders';
    return root.classList.contains('staff-preparation-view') ? 'preparation' : 'floor';
  }

  function setView(view, orderFilter) {
    if (view === 'preparation' && !snapshot.canReadPreparation) return;
    root.classList.remove('staff-preparation-view');
    if (typeof snapshot.setView === 'function') snapshot.setView(view === 'orders' ? 'orders' : 'floor');
    if (view === 'preparation') root.classList.add('staff-preparation-view');
    if (view === 'orders' && orderFilter) {
      document.querySelector('.queue .chips button[data-filter="' + orderFilter + '"]')?.click();
    }
    renderView();
    applyPreparationFilter();
  }

  function mount() {
    root = document.querySelector('body.staff-theme');
    const main = root?.querySelector('.app > main');
    if (!main) return false;
    root.classList.add('pos-workspace-enabled');
    toolbar = element('section', 'pos-workspace-toolbar ui-components');
    toolbar.id = 'pos-workspace-toolbar';
    toolbar.setAttribute('aria-label', 'Рабочая область сотрудника');

    const switcher = element('div', 'pos-workspace-switch');
    switcher.setAttribute('role', 'group');
    switcher.setAttribute('aria-label', 'Режим рабочей области');
    for (const [view, name, glyph] of [['floor', 'Зал', 'table-layout'], ['preparation', 'Приготовление', 'list-check']]) {
      const control = button('ui-button pos-workspace-view');
      control.append(element('span', 'pos-workspace-view-label', name));
      if (view === 'preparation') {
        const count = element('span', 'pos-workspace-view-count', '—');
        count.setAttribute('aria-hidden', 'true');
        control.append(count);
      }
      control.dataset.posView = view;
      control.prepend(icon(glyph));
      control.setAttribute('aria-pressed', 'false');
      control.setAttribute('aria-controls', view === 'floor' ? 'tables' : 'preparation-queue');
      control.addEventListener('click', () => setView(view));
      switcher.append(control);
    }

    const summary = element('div', 'pos-workspace-summary');
    for (const [key, label, glyph] of [
      ['ready', 'Готовые заказы', 'circle-check'],
      ['open', 'Открытые счета', 'receipt']
    ]) {
      const control = button('pos-workspace-counter pos-workspace-counter--' + key);
      control.dataset.posCounter = key;
      control.append(icon(glyph));
      const labelNode = element('span', 'pos-workspace-counter-label', label);
      const countNode = element('strong', 'pos-workspace-counter-value', '—');
      const unitNode = element('span', 'pos-workspace-counter-unit', 'Нет данных');
      control.append(labelNode, countNode, unitNode);
      control.addEventListener('click', () => setView('orders', key === 'ready' ? 'ready' : 'all'));
      summary.append(control);
    }
    const feedback = element('p', 'pos-workspace-feedback');
    feedback.id = 'pos-workspace-feedback';
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    toolbar.append(switcher, summary, feedback);
    const zoneTabs = main.querySelector(':scope > .tabs');
    if (zoneTabs) zoneTabs.before(toolbar);
    else main.querySelector(':scope > header')?.after(toolbar);

    const queue = main.querySelector(':scope > .queue');
    if (queue && !queue.querySelector('.pos-orders-heading')) {
      const heading = element('div', 'pos-orders-heading');
      const back = button('ui-button pos-orders-back', 'В зал');
      back.prepend(icon('arrow-left'));
      back.addEventListener('click', () => setView('floor'));
      const title = element('h2', '', 'Открытые счета');
      title.id = 'pos-orders-title';
      heading.append(back, title);
      queue.querySelector(':scope > b')?.remove();
      queue.prepend(heading);
    }
    root.querySelector('aside')?.addEventListener('click', (event) => {
      if (!event.target.closest('nav button, nav a')) return;
      root.classList.remove('staff-preparation-view');
    }, true);
    return true;
  }

  function mountFilters() {
    const list = document.querySelector('#preparation-list');
    if (!list) return;
    if (filters?.isConnected) return;
    filters = element('div', 'pos-preparation-filters ui-components');
    filters.id = 'pos-preparation-filters';
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Направление приготовления');
    for (const [station, label] of [['all', 'Все направления'], ['bar', 'Бар'], ['hookah', 'Кальяны']]) {
      const control = button('ui-button', label);
      control.dataset.posStation = station;
      control.setAttribute('aria-pressed', 'false');
      control.addEventListener('click', () => {
        selectedStation = station;
        if (typeof snapshot.onPreparationFilter === 'function') snapshot.onPreparationFilter(station);
        applyPreparationFilter();
      });
      filters.append(control);
    }
    list.before(filters);
    const empty = element('p', 'queue-empty pos-preparation-filter-empty', 'В этом направлении нет ожидающих работ.');
    empty.id = 'pos-preparation-filter-empty';
    empty.setAttribute('role', 'status');
    empty.hidden = true;
    list.after(empty);
  }

  function scheduleOrderGeometry() {
    if (orderGeometryFrame !== null) return;
    orderGeometryFrame = global.requestAnimationFrame(() => {
      orderGeometryFrame = null;
      const order = root?.querySelector('.order');
      if (!order || !order.getClientRects().length || order.dataset.posState === 'unselected') return;
      const height = global.visualViewport?.height || global.innerHeight;
      const top = Math.max(12, order.getBoundingClientRect().top);
      const available = Math.max(180, Math.floor(height - top - 16));
      const value = available + 'px';
      if (order.style.getPropertyValue('--pos-order-height') !== value) order.style.setProperty('--pos-order-height', value);
    });
  }

  function mountOrderLayout() {
    const order = root.querySelector('.order');
    if (!order) return;
    if (!order.querySelector(':scope > .pos-order-body')) {
      const body = element('div', 'pos-order-body');
      const parts = [...order.children].filter((node) => node.matches('.meta,.table-context-actions,.order-next-step,.order-tabs,.items'));
      order.querySelector(':scope > .order-head')?.after(body);
      body.append(...parts);
      order.querySelector(':scope > .order-more')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !event.currentTarget.open) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      });
    }
    const payment = order.querySelector('#split-payment');
    const actions = order.querySelector('.order-main-actions');
    if (payment && actions && payment.parentElement !== actions) actions.prepend(payment);
    if (!orderGeometryObserver && typeof ResizeObserver === 'function') {
      orderGeometryObserver = new ResizeObserver(scheduleOrderGeometry);
      [root.querySelector('.app > main'), toolbar, root.querySelector('.app > main > .tabs')]
        .filter(Boolean).forEach((node) => orderGeometryObserver.observe(node));
      root.querySelector('.app > main')?.addEventListener('scroll', scheduleOrderGeometry, { passive: true });
      global.addEventListener('resize', scheduleOrderGeometry);
      global.visualViewport?.addEventListener('resize', scheduleOrderGeometry);
    }
    scheduleOrderGeometry();
  }

  function renderView() {
    if (!snapshot.canReadPreparation) root.classList.remove('staff-preparation-view');
    const view = currentView();
    toolbar.hidden = view === 'orders';
    const queue = document.querySelector('.app > main > .queue');
    if (queue) queue.hidden = view !== 'orders';
    toolbar.querySelectorAll('[data-pos-view]').forEach((control) => {
      control.hidden = control.dataset.posView === 'preparation' && !snapshot.canReadPreparation;
      control.setAttribute('aria-pressed', String(control.dataset.posView === view));
    });
    const preparation = document.querySelector('#preparation-queue');
    if (preparation) preparation.hidden = !(snapshot.canReadPreparation && view === 'preparation');
    if (filters) filters.hidden = !snapshot.canReadPreparation || allowedStations().length <= 1;
  }

  function renderCounter(key, count, status, accessible) {
    const control = toolbar.querySelector('[data-pos-counter="' + key + '"]');
    const label = control.querySelector('.pos-workspace-counter-label').textContent;
    const ready = status === 'ready';
    const quantityUnit = key === 'ready' ? unit(count, 'заказ', 'заказа', 'заказов') : unit(count, 'счёт', 'счёта', 'счетов');
    const message = status === 'loading' ? 'Загрузка' : status === 'denied' ? 'Нет доступа'
      : status === 'stale' ? 'Данные устарели' : status === 'error' ? 'Нет связи' : 'Нет данных';
    control.hidden = !accessible;
    control.disabled = !ready;
    control.dataset.state = status;
    control.setAttribute('aria-busy', String(status === 'loading'));
    control.querySelector('.pos-workspace-counter-value').textContent = ready ? String(count) : '—';
    control.querySelector('.pos-workspace-counter-unit').textContent = ready ? quantityUnit : message;
    control.setAttribute('aria-label', label + ': ' + (ready ? count + ' ' + quantityUnit : message));
    control.title = ready ? label + ': ' + count + ' ' + quantityUnit : message;
  }

  function applyPreparationFilter() {
    if (!filters) return;
    const allowed = allowedStations();
    if (selectedStation !== 'all' && !allowed.includes(selectedStation)) selectedStation = 'all';
    const busy = (snapshot.preparationItems || []).filter((item) => allowed.includes(item.preparationStation) && busyItemStates.has(item.preparationStatus));
    const ready = phase(snapshot.preparationState) === 'ready';
    filters.querySelectorAll('[data-pos-station]').forEach((control) => {
      const station = control.dataset.posStation;
      const name = station === 'all' ? 'Все направления' : stations[station];
      const count = busy.filter((item) => station === 'all' || item.preparationStation === station).length;
      control.textContent = name + ' · ' + (ready ? count : '—');
      control.setAttribute('aria-label', name + ': ' + (ready ? count + ' ' + unit(count, 'позиция', 'позиции', 'позиций') : 'данные недоступны'));
      control.hidden = control.dataset.posStation !== 'all' && !allowed.includes(control.dataset.posStation);
      control.setAttribute('aria-pressed', String(control.dataset.posStation === selectedStation));
    });
    const items = new Map((snapshot.preparationItems || []).map((item) => [String(item.id), item]));
    let total = 0;
    let visible = 0;
    document.querySelectorAll('#preparation-list .preparation-row').forEach((row) => {
      const itemId = row.querySelector('[data-preparation-item]')?.dataset.preparationItem;
      const station = row.dataset.station || items.get(String(itemId))?.preparationStation;
      row.hidden = selectedStation !== 'all' && station !== selectedStation;
      total++;
      if (!row.hidden) visible++;
    });
    const empty = document.querySelector('#pos-preparation-filter-empty');
    if (empty) empty.hidden = !(currentView() === 'preparation' && phase(snapshot.preparationState) === 'ready' && total > 0 && visible === 0);
  }

  function tableStates(order) {
    if (!Array.isArray(order?.items)) return [];
    const result = [];
    for (const station of ['bar', 'hookah']) {
      const items = order.items.filter((item) => item.preparationStation === station);
      if (!items.length) continue;
      const statuses = items.map((item) => item.preparationStatus || 'new');
      const label = station === 'bar' ? 'Бар' : 'Кальян';
      if (statuses.every((status) => status === 'ready')) result.push({ priority: 0, kind: 'success', text: label + ' готов' });
      else if (statuses.includes('ready')) {
        result.push({ priority: 0, kind: 'success', text: label + ': готово ' + statuses.filter((status) => status === 'ready').length + ' из ' + statuses.length });
        if (statuses.includes('queued')) result.push({ priority: 1, kind: 'warning', text: label + ' ожидает' });
        else if (statuses.includes('in_progress')) result.push({ priority: 2, kind: 'neutral', text: label + ' в работе' });
      }
      else if (statuses.includes('queued')) result.push({ priority: 1, kind: 'warning', text: label + ' ожидает' });
      else if (statuses.includes('in_progress')) result.push({ priority: 2, kind: 'neutral', text: label + ' в работе' });
    }
    return result.sort((left, right) => left.priority - right.priority);
  }

  function renderTableBadges() {
    const readable = snapshot.floorReady && snapshot.canWork
      && phase(snapshot.floorState) === 'ready' && phase(snapshot.ordersState) === 'ready';
    const ordersByTable = new Map();
    if (readable) for (const order of activeOrders()) {
      const tableId = String(order.tableId);
      const aggregate = ordersByTable.get(tableId) || { items: [] };
      if (Array.isArray(order.items)) aggregate.items.push(...order.items);
      ordersByTable.set(tableId, aggregate);
    }
    document.querySelectorAll('#tables .table[data-table]').forEach((tile) => {
      tile.setAttribute('aria-pressed', String(tile.classList.contains('sel')));
      const states = tableStates(ordersByTable.get(tile.dataset.table));
      let record = tileDescriptions.get(tile);
      if (!states.length) {
        if (record) {
          record.badge.remove();
          record.description.remove();
          const references = (tile.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== record.id);
          if (references.length) tile.setAttribute('aria-describedby', references.join(' '));
          else tile.removeAttribute('aria-describedby');
          tileDescriptions.delete(tile);
        }
        tile.classList.remove('pos-table-has-attention');
        return;
      }
      if (!record || !record.badge.isConnected) {
        const id = 'pos-table-preparation-' + (++tileSequence);
        const badge = element('span', 'pos-table-attention');
        badge.setAttribute('aria-hidden', 'true');
        const description = element('span', 'pos-workspace-sr-only');
        description.id = id;
        tile.append(badge, description);
        record = { badge, description, id };
        tileDescriptions.set(tile, record);
      }
      const [primary] = states;
      const detail = states.map((state) => state.text).join('. ');
      record.badge.dataset.kind = primary.kind;
      record.badge.replaceChildren(...states.map((state) => {
        const line = element('span', 'pos-table-station-state', state.text);
        line.dataset.kind = state.kind;
        return line;
      }));
      record.badge.title = detail;
      record.description.textContent = detail;
      const references = (tile.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (!references.includes(record.id)) references.push(record.id);
      tile.setAttribute('aria-describedby', references.join(' '));
      tile.classList.add('pos-table-has-attention');
    });
  }

  function update(next) {
    snapshot = next && typeof next === 'object' ? next : {};
    if (!snapshot.canReadPreparation || phase(snapshot.preparationState) === 'denied') selectedStation = 'all';
    if (!toolbar?.isConnected && !mount()) return;
    mountFilters();
    mountOrderLayout();
    const orders = activeOrders();
    const allowed = allowedStations();
    const preparation = (Array.isArray(snapshot.preparationItems) ? snapshot.preparationItems : [])
      .filter((item) => allowed.includes(item.preparationStation) && busyItemStates.has(item.preparationStatus));
    const orderPhase = phase(snapshot.ordersState);
    const preparationPhase = snapshot.canReadPreparation ? phase(snapshot.preparationState) : 'denied';
    const preparationMode = toolbar.querySelector('[data-pos-view="preparation"]');
    const preparationReady = preparationPhase === 'ready';
    preparationMode.dataset.state = preparationPhase;
    preparationMode.setAttribute('aria-busy', String(preparationPhase === 'loading'));
    preparationMode.querySelector('.pos-workspace-view-count').textContent = preparationReady ? String(preparation.length) : '—';
    const preparationCountLabel = preparationReady
      ? preparation.length + ' ' + unit(preparation.length, 'позиция', 'позиции', 'позиций') + ' в очереди и работе по всем доступным направлениям'
      : preparationPhase === 'loading' ? 'Загрузка' : 'Данные недоступны';
    preparationMode.setAttribute('aria-label', 'Приготовление: ' + preparationCountLabel);
    preparationMode.title = preparationCountLabel;
    renderCounter('ready', orders.filter(isReady).length, orderPhase, orderPhase !== 'denied');
    renderCounter('open', orders.length, orderPhase, orderPhase !== 'denied');
    const message = toolbar.querySelector('#pos-workspace-feedback');
    const warnings = [];
    const floorUnavailable = ['error', 'stale'].includes(phase(snapshot.floorState));
    if (snapshot.offline) warnings.push('Нет связи. Показаны последние данные.');
    if (floorUnavailable) warnings.push(snapshot.floorReady
      ? 'Схема зала не обновлена. Показаны последние данные.'
      : 'Не удалось загрузить схему зала.');
    if (['error', 'stale'].includes(orderPhase)) warnings.push('Заказы не обновлены. Показаны последние данные.');
    if (snapshot.canReadPreparation && ['error', 'stale'].includes(preparationPhase)) warnings.push('Приготовление не обновлено. Показаны последние данные.');
    message.textContent = warnings.join(' ');
    if (warnings.length && typeof snapshot.onFloorRetry === 'function') {
      const retry = button('ui-button', 'Обновить данные');
      retry.dataset.posFloorRetry = '';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try { await snapshot.onFloorRetry(); } finally {
          retry.disabled = false;
          if (!retry.isConnected && document.activeElement === document.body) {
            const target = toolbar.querySelector('[data-pos-floor-retry]')
              || toolbar.querySelector('[data-pos-view="floor"]');
            target?.focus({ preventScroll: true });
          }
        }
      });
      message.append(' ', retry);
    }
    message.hidden = warnings.length === 0;
    renderView();
    applyPreparationFilter();
    renderTableBadges();
  }

  global.HookahPosWorkspace = Object.freeze({ update });
})(window);
