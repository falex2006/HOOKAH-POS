(() => {
  'use strict';

  let sessionUser = {};
  try { sessionUser = JSON.parse(localStorage.getItem('crm_session_user') || '{}'); } catch (_) {}
  if (sessionUser.role !== 'owner') return;

  const MAX_PREVIEW_EMPLOYEES = 500;
  const MAX_PREVIEW_SALES = 20000;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const request = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.error || `http_${response.status}`);
    return data;
  };
  const defaultDefinition = () => ({
    mode: 'progressive_daily', currency: 'RUB', effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: null,
    applyMilestones: true, milestoneCapPolicy: 'included_in_cap',
    roleParameters: {
      bartender: { department: 'bar', perShiftCents: 0, bracketRatesBps: { 0: 0 } },
      hookah_master: { department: 'hookah', perShiftCents: 0, bracketRatesBps: { 0: 0 } }
    }, roleAssignments: [], employeeOverrides: [], itemRules: []
  });
  const defaultPreview = () => {
    const today = new Date().toISOString().slice(0, 10);
    return { periodFrom: today, periodTo: today, coverage: { kind: 'month_to_date_complete', from: `${today.slice(0, 7)}-01`, through: today, complete: true, watermark: 'manual-scenario' }, monthClosed: false, employees: [], sales: [] };
  };
  const validatePreview = (input) => {
    if (!input || !Array.isArray(input.employees) || !Array.isArray(input.sales)) throw new Error('В сценарии нужны списки сотрудников и продаж.');
    if (input.employees.length > MAX_PREVIEW_EMPLOYEES || input.sales.length > MAX_PREVIEW_SALES) throw new Error(`Ограничение сценария: до ${MAX_PREVIEW_EMPLOYEES} сотрудников и ${MAX_PREVIEW_SALES} строк продаж.`);
    return input;
  };

  const mount = () => {
    const payrollPanel = document.querySelector('.finance-payroll-panel');
    if (!payrollPanel || payrollPanel.dataset.schemeUiMounted) return;
    payrollPanel.dataset.schemeUiMounted = 'true';
    const panel = document.createElement('section');
    panel.className = 'panel finance-payroll-schemes';
    panel.innerHTML = `
      <div class="panel-head"><div><h2>Настройка зарплатных схем</h2><span class="muted">Версии, ставки, назначения, персональные overrides и позиционные правила</span></div><div class="toolbar-row"><button type="button" class="button small" data-scheme-reload>Обновить</button><button type="button" class="button small primary" data-scheme-new>Новая схема</button></div></div>
      <p class="muted">Настройки и суммы доступны только владельцу площадки. Черновик можно редактировать; активация закрепляет версию. Сценарный preview не использует POS-источники, не создаёт расчётный run, начисление или расход.</p>
      <p class="form-message" data-scheme-message role="status" aria-live="polite"></p>
      <div class="finance-scheme-list" data-scheme-list><div class="empty">Загрузка схем…</div></div>
      <form class="stack-form" data-scheme-editor hidden>
        <div class="panel-head"><div><h3 data-scheme-editor-title>Новая схема</h3><span class="muted">Полный JSON позволяет владельцу задать все поддерживаемые параметры и периоды действия.</span></div></div>
        <div class="form-row"><label>Название схемы<input data-scheme-name maxlength="120" required></label><label>Описание<textarea data-scheme-description rows="2" maxlength="2000"></textarea></label></div>
        <label>Конфигурация версии <textarea data-scheme-definition rows="18" spellcheck="false" required></textarea></label>
        <p class="muted">Обязательные поля: mode, effectiveFrom, roleParameters, roleAssignments, employeeOverrides, itemRules. Сотрудников назначайте по UUID из списка персонала. Денежные суммы задаются в копейках, ставки — в basis points. Явный ноль отличается от наследования.</p>
        <div class="toolbar-row"><button class="button primary" type="submit" data-scheme-save>Сохранить черновик</button><button class="button" type="button" data-scheme-editor-cancel>Закрыть</button></div>
      </form>
      <div class="finance-scheme-preview" data-scheme-preview hidden>
        <div class="panel-head"><div><h3>Сценарный расчёт</h3><span class="muted" data-scheme-selected-label></span></div><div class="toolbar-row"><button type="button" class="button small primary" data-scheme-run-preview>Рассчитать preview</button><button type="button" class="button small" data-scheme-compare>Сравнить выбранные</button></div></div>
        <label>Нормализованные входные данные сценария<textarea data-scheme-preview-input rows="12" spellcheck="false"></textarea></label>
        <pre data-scheme-preview-result class="finance-scheme-result" hidden></pre>
      </div>`;
    payrollPanel.insertBefore(panel, payrollPanel.firstChild);

    const list = panel.querySelector('[data-scheme-list]');
    const message = panel.querySelector('[data-scheme-message]');
    const editor = panel.querySelector('[data-scheme-editor]');
    const nameField = panel.querySelector('[data-scheme-name]');
    const descriptionField = panel.querySelector('[data-scheme-description]');
    const definitionField = panel.querySelector('[data-scheme-definition]');
    const previewBox = panel.querySelector('[data-scheme-preview]');
    const previewInput = panel.querySelector('[data-scheme-preview-input]');
    const previewResult = panel.querySelector('[data-scheme-preview-result]');
    let schemes = [];
    let editorAction = null;
    let selectedVersion = null;
    let selectedVersionIds = [];
    let pending = false;
    previewInput.value = JSON.stringify(defaultPreview(), null, 2);

    const notify = (text, kind = '') => { message.textContent = text; message.className = `form-message${kind ? ` ${kind}-message` : ''}`; };
    const definitionFromVersion = (version) => ({
      mode: version.mode, currency: version.currency, effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo,
      applyMilestones: version.applyMilestones, milestoneCapPolicy: version.milestoneCapPolicy,
      roleParameters: version.roleParameters, roleAssignments: version.roleAssignments,
      employeeOverrides: version.employeeOverrides, itemRules: version.itemRules
    });
    const sortedVersions = (scheme) => [...(scheme.versions || [])].sort((left, right) => Number(right.versionNo) - Number(left.versionNo));
    const renderList = () => {
      if (!schemes.length) { list.innerHTML = '<div class="empty">Схем пока нет. Создайте схему и сохраните первую черновую версию.</div>'; return; }
      list.innerHTML = schemes.map((scheme) => `<article class="finance-scheme-card"><div class="panel-head"><div><h3>${escapeHtml(scheme.name)}</h3><small class="muted">${escapeHtml(scheme.description || 'Без описания')}</small></div></div><div class="finance-scheme-versions">${sortedVersions(scheme).map((version) => `<div class="payment-row"><label><input type="checkbox" data-scheme-compare-version="${escapeHtml(version.id)}"> Сравнить</label><span>Версия ${escapeHtml(version.versionNo)} · ${escapeHtml(version.mode)} · ${escapeHtml(version.effectiveFrom)}${version.effectiveTo ? ` — ${escapeHtml(version.effectiveTo)}` : ''}</span><span class="badge ${version.status === 'active' ? 'success' : version.status === 'draft' ? 'warning' : ''}">${escapeHtml(version.status)}</span><div class="toolbar-row"><button type="button" class="button small" data-scheme-open-version="${escapeHtml(version.id)}">Открыть</button>${version.status === 'draft' ? `<button type="button" class="button small primary" data-scheme-activate="${escapeHtml(version.id)}">Активировать</button>` : ''}<button type="button" class="button small" data-scheme-revisions="${escapeHtml(version.id)}">История</button></div></div>`).join('') || '<div class="empty">Черновых версий нет</div>'}<div class="toolbar-row"><button type="button" class="button small" data-scheme-new-version="${escapeHtml(scheme.id)}">Создать новую версию</button></div></div></article>`).join('');
    };
    const load = async ({ force = false } = {}) => {
      if (pending && !force) return;
      notify('Загружаем настройки…');
      list.innerHTML = '<div class="empty">Загрузка схем…</div>';
      try { const data = await request('/api/payroll/schemes'); schemes = Array.isArray(data.items) ? data.items : []; renderList(); notify(schemes.length ? '' : ''); }
      catch (error) { schemes = []; list.innerHTML = `<div class="empty">Не удалось загрузить схемы (${escapeHtml(error.message)}). <button type="button" class="button small" data-scheme-retry>Повторить</button></div>`; notify('Настройки недоступны.', 'error'); }
    };
    const openVersion = async (versionId) => {
      const version = await request(`/api/payroll/versions/${encodeURIComponent(versionId)}`);
      selectedVersion = version;
      previewBox.hidden = false;
      if (!previewInput.value.trim()) previewInput.value = JSON.stringify(defaultPreview(), null, 2);
      previewResult.hidden = true;
      panel.querySelector('[data-scheme-selected-label]').textContent = `${version.name} · версия ${version.versionNo} · ${version.status}`;
      editorAction = version.status === 'draft' ? { kind: 'edit', versionId } : { kind: 'inspect', versionId };
      panel.querySelector('[data-scheme-editor-title]').textContent = version.status === 'draft' ? 'Редактирование черновика' : 'Активная версия (только чтение)';
      nameField.value = version.name || ''; descriptionField.value = version.description || '';
      definitionField.value = JSON.stringify(definitionFromVersion(version), null, 2);
      nameField.disabled = true; descriptionField.disabled = true; definitionField.readOnly = version.status !== 'draft';
      panel.querySelector('[data-scheme-save]').hidden = version.status !== 'draft';
      editor.hidden = false;
      notify(version.status === 'draft' ? 'Открыт редактируемый черновик.' : 'Активная версия защищена от редактирования. Создайте новую версию для изменений.');
    };
    const showEditor = (action, { scheme = null, version = null } = {}) => {
      editorAction = action;
      selectedVersion = version;
      editor.hidden = false;
      panel.querySelector('[data-scheme-save]').hidden = false;
      nameField.disabled = action.kind !== 'create'; descriptionField.disabled = action.kind !== 'create'; definitionField.readOnly = false;
      panel.querySelector('[data-scheme-editor-title]').textContent = action.kind === 'create' ? 'Новая схема' : action.kind === 'new-version' ? 'Новая версия схемы' : 'Редактирование черновика';
      nameField.value = scheme?.name || '';
      descriptionField.value = scheme?.description || '';
      definitionField.value = JSON.stringify(version ? definitionFromVersion(version) : defaultDefinition(), null, 2);
      notify('Проверьте период действия, роли, назначения сотрудников и правила до сохранения.');
    };

    panel.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button || pending) return;
      try {
        if (button.matches('[data-scheme-reload], [data-scheme-retry]')) return await load();
        if (button.matches('[data-scheme-new]')) return showEditor({ kind: 'create' });
        if (button.matches('[data-scheme-editor-cancel]')) { editor.hidden = true; editorAction = null; return; }
        if (button.matches('[data-scheme-open-version]')) return await openVersion(button.dataset.schemeOpenVersion);
        if (button.matches('[data-scheme-new-version]')) {
          const scheme = schemes.find((item) => item.id === button.dataset.schemeNewVersion);
          const latest = sortedVersions(scheme || {})[0];
          const version = latest ? await request(`/api/payroll/versions/${encodeURIComponent(latest.id)}`) : null;
          return showEditor({ kind: 'new-version', schemeId: scheme.id }, { scheme, version });
        }
        if (button.matches('[data-scheme-activate]')) {
          pending = true; button.disabled = true;
          await request(`/api/payroll/versions/${encodeURIComponent(button.dataset.schemeActivate)}/activate`, { method: 'POST' });
          notify('Версия активирована.', 'success'); pending = false; await load({ force: true }); return;
        }
        if (button.matches('[data-scheme-revisions]')) {
          const data = await request(`/api/payroll/versions/${encodeURIComponent(button.dataset.schemeRevisions)}/revisions`);
          previewBox.hidden = false; previewResult.hidden = false; previewResult.textContent = JSON.stringify(data.items || [], null, 2); notify('История версий загружена.'); return;
        }
        if (button.matches('[data-scheme-run-preview]')) {
          if (!selectedVersion) throw new Error('Сначала откройте версию схемы.');
          const preview = validatePreview(JSON.parse(previewInput.value));
          const result = await request(`/api/payroll/versions/${encodeURIComponent(selectedVersion.versionId)}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewInput: preview }) });
          previewResult.hidden = false; previewResult.textContent = JSON.stringify(result, null, 2); notify('Готов сценарный preview. Он не является официальным расчётом и не сохранён.', 'success'); return;
        }
        if (button.matches('[data-scheme-compare]')) {
          const versionIds = [...panel.querySelectorAll('[data-scheme-compare-version]:checked')].map((item) => item.dataset.schemeCompareVersion);
          if (versionIds.length < 2 || versionIds.length > 8) throw new Error('Выберите от 2 до 8 версий для сравнения.');
          const preview = validatePreview(JSON.parse(previewInput.value));
          const result = await request('/api/payroll/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionIds, baselineVersionId: versionIds[0], previewInput: preview }) });
          previewResult.hidden = false; previewResult.textContent = JSON.stringify(result, null, 2); notify('Сравнение готово. Это сценарные значения без сохранения начислений.', 'success'); return;
        }
      } catch (error) { notify(`Не удалось выполнить действие: ${error.message}`, 'error'); }
      finally { pending = false; }
    });

    editor.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (pending || !editorAction || editorAction.kind === 'inspect') return;
      let definition;
      try { definition = JSON.parse(definitionField.value); }
      catch (error) { notify(`Конфигурация должна быть корректным JSON (${error.message}).`, 'error'); definitionField.focus(); return; }
      pending = true;
      const save = panel.querySelector('[data-scheme-save]'); save.disabled = true;
      try {
        let result;
        if (editorAction.kind === 'create') {
          result = await request('/api/payroll/schemes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameField.value, description: descriptionField.value, definition }) });
          notify('Схема и первая черновая версия сохранены.', 'success');
        } else if (editorAction.kind === 'new-version') {
          result = await request(`/api/payroll/schemes/${encodeURIComponent(editorAction.schemeId)}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition }) });
          notify('Новая черновая версия сохранена.', 'success');
        } else {
          result = await request(`/api/payroll/versions/${encodeURIComponent(editorAction.versionId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition }) });
          notify('Черновик сохранён; новая ревизия записана в историю.', 'success');
        }
        editor.hidden = true; editorAction = null; pending = false; await load({ force: true });
        const versionId = result.versionId || result.versions?.[0]?.versionId;
        if (versionId) await openVersion(versionId);
      } catch (error) { notify(`Не удалось сохранить схему: ${error.message}`, 'error'); }
      finally { pending = false; save.disabled = false; }
    });
    panel.querySelector('[data-scheme-reload]').addEventListener('click', load);
    load();
  };

  mount();
  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
