(() => {
  'use strict';

  let sessionUser = {};
  try { sessionUser = JSON.parse(localStorage.getItem('crm_session_user') || '{}'); } catch (_) {}
  if (sessionUser.role !== 'owner') return;

  const MAX_PREVIEW_EMPLOYEES = 500;
  const MAX_PREVIEW_SALES = 20000;
  const MAX_RENDERED_EMPLOYEE_DAYS = 2000;
  const MAX_RENDERED_LINES = 2000;
  const MAX_COMPARE_EMPLOYEE_DAYS = 500;
  const MAX_COMPARE_LINES = 500;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const venueLocalToday = () => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: sessionUser.timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (_) { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  };
  const request = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.error || `http_${response.status}`);
    return data;
  };
  const defaultDefinition = () => ({
    mode: 'progressive_daily', currency: 'RUB', effectiveFrom: venueLocalToday(), effectiveTo: null,
    applyMilestones: true, milestoneCapPolicy: 'included_in_cap',
    roleParameters: {
      bartender: { department: 'bar', perShiftCents: 0, bracketRatesBps: { 0: 0 } },
      hookah_master: { department: 'hookah', perShiftCents: 0, bracketRatesBps: { 0: 0 } }
    }, roleAssignments: [], employeeOverrides: [], itemRules: []
  });
  const defaultPreview = () => {
    const today = venueLocalToday();
    return { periodFrom: today, periodTo: today, coverage: { kind: 'month_to_date_complete', from: `${today.slice(0, 7)}-01`, through: today, complete: true, watermark: 'manual-scenario' }, monthClosed: false, employees: [], sales: [] };
  };
  const validatePreview = (input) => {
    if (!input || !Array.isArray(input.employees) || !Array.isArray(input.sales)) throw new Error('В сценарии нужны списки сотрудников и продаж.');
    if (input.employees.length > MAX_PREVIEW_EMPLOYEES || input.sales.length > MAX_PREVIEW_SALES) throw new Error(`Ограничение сценария: до ${MAX_PREVIEW_EMPLOYEES} сотрудников и ${MAX_PREVIEW_SALES} строк продаж.`);
    return input;
  };
  const money = (value, currency = 'RUB') => {
    if (!Number.isSafeInteger(value)) return '—';
    try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, minimumFractionDigits: 2 }).format(value / 100); }
    catch (_) { return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2 }).format(value / 100)} ${escapeHtml(currency)}`; }
  };
  const blockerLabels = {
    sales_coverage_manifest_required: 'Не подтверждён полный состав продаж за выбранный период.',
    sales_coverage_does_not_cover_period: 'Данные о продажах не покрывают весь выбранный период.',
    unattributed_sales_line: 'Для одной или нескольких строк продаж не назначен сотрудник.',
    sales_employee_unassigned: 'У сотрудника строки продажи нет назначения роли на эту дату.',
    role_assignment_gap: 'У сотрудника отсутствует назначение роли на часть активного периода.',
    role_parameters_missing: 'Для назначенной роли не заданы параметры оплаты.',
    invalid_sales_line: 'Одна или несколько строк продаж содержат некорректные суммы или даты.',
    amount_exceeds_safe_integer_cents: 'Сумма слишком велика для безопасного расчёта; проверьте входные данные.',
    invalid_single_month_period: 'Выберите корректный период внутри одного календарного месяца.',
    closed_month_required: 'Для этого режима нужен закрытый месяц и подтверждённые данные за полный месяц.',
    closed_month_mismatch: 'Данные закрытого месяца не совпадают с выбранным периодом.',
    invalid_employee: 'Проверьте даты работы и идентификаторы сотрудников.',
    unknown_sales_employee: 'Строка продаж ссылается на неизвестного сотрудника.',
    input_collections_required: 'Заполните списки сотрудников, назначений ролей и продаж.',
    invalid_role_assignment: 'Проверьте роли сотрудников и даты их назначения.',
    overlapping_role_assignments: 'У сотрудника пересекаются периоды назначения ролей.',
    employee_override_employee_unknown: 'Персональная настройка ссылается на неизвестного сотрудника.',
    employee_override_parameter_missing: 'Персональная настройка задаёт параметр, которого нет в ставке роли.',
    item_rule_scope_unknown: 'Позиционное правило ссылается на неизвестную роль или сотрудника.',
    full_month_period_required: 'Выберите полный календарный месяц.',
    month_to_date_coverage_boundary_mismatch: 'Граница данных с начала месяца не совпадает с периодом.',
    bracket_rates_required: 'Добавьте ставку для начального диапазона выручки.',
    stable_rate_required: 'Задайте процентную ставку для роли.',
    per_shift_rate_required: 'Задайте оплату за смену для роли.',
    cap_department_required: 'Укажите цех, к выручке которого применяется ограничение.'
  };
  const renderBlockers = (result) => result.status === 'blocked'
    ? `<div class="warning-message"><strong>Расчёт заблокирован</strong><ul>${(result.blockers || []).map((code) => `<li title="${escapeHtml(code)}">${escapeHtml(blockerLabels[code] || `Проверьте входные данные (${code}).`)}</li>`).join('')}</ul></div>`
    : '';
  const renderDetails = (result, employeeNames, baselineResult = null, renderBudget = { employeeDays: MAX_RENDERED_EMPLOYEE_DAYS, lines: MAX_RENDERED_LINES }) => {
    const currency = result.currency || 'RUB';
    const baselineValid = baselineResult?.status === 'ready';
    const baselineByDay = new Map((baselineValid ? baselineResult?.daily || [] : []).flatMap((day) => (day.employees || []).map((row) => [`${day.date}|${row.employeeId}`, row.amountCents])));
    const daily = (result.daily || []).map((day) => {
      const employeeSource = day.employees || [];
      const employeeShown = employeeSource.slice(0, renderBudget.employeeDays);
      renderBudget.employeeDays -= employeeShown.length;
      const employeeRows = employeeShown.map((row) => {
        const key = `${day.date}|${row.employeeId}`;
        const previousFound = baselineValid && baselineByDay.has(key);
        const previous = previousFound ? baselineByDay.get(key) : 0;
        const delta = baselineValid && Number.isSafeInteger(row.amountCents) && Number.isSafeInteger(previous) ? row.amountCents - previous : null;
        const baselineCells = baselineResult ? `<td>${baselineValid ? money(previousFound ? previous : 0, currency) : '—'}</td><td>${money(delta, currency)}</td>` : '';
        return `<tr><td>${escapeHtml(employeeNames.get(row.employeeId) || row.employeeId)}</td><td>${escapeHtml(row.roleId || '')}</td><td>${money(row.basePayCents, currency)}</td><td>${money(row.commissionCents, currency)}</td><td>${money(row.milestoneBonusCents, currency)}</td><td>${money(row.capCents, currency)}</td><td>${money(row.capReductionCents, currency)}</td><td><strong>${money(row.amountCents, currency)}</strong></td>${baselineCells}</tr>`;
      }).join('');
      const lineSource = day.lines || [];
      const lineShown = lineSource.slice(0, renderBudget.lines);
      renderBudget.lines -= lineShown.length;
      const lines = lineShown.map((line) => `<tr><td>${escapeHtml(line.lineId)}</td><td>${escapeHtml(employeeNames.get(line.employeeId) || line.employeeId)}</td><td>${escapeHtml(line.menuItemId || '—')}</td><td>${escapeHtml(line.department)}</td><td>${money(line.commissionBaseCents, currency)}</td><td>${escapeHtml((Number(line.appliedRateBps) / 100).toLocaleString('ru-RU'))}%</td><td>${money(line.commissionCents, currency)}</td></tr>`).join('');
      const omittedEmployees = employeeSource.length - employeeShown.length;
      const omittedLines = lineSource.length - lineShown.length;
      const omitted = omittedEmployees || omittedLines ? `<p class="muted">Детализация ограничена: скрыто ${omittedEmployees} дневных строк сотрудников и ${omittedLines} строк продаж. Общие суммы выше рассчитаны полностью.</p>` : '';
      return `<details class="finance-scheme-day"><summary>${escapeHtml(day.date)} · выручка ${money(day.venueTurnoverCents, currency)} · накопительно ${money(day.cumulativeVenueTurnoverCents, currency)}</summary><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Сотрудник</th><th>Роль</th><th>Оклад</th><th>Комиссия</th><th>Премия</th><th>Лимит</th><th>Срезано</th><th>Итого</th>${baselineResult ? '<th>База</th><th>Δ к базе</th>' : ''}</tr></thead><tbody>${employeeRows || `<tr><td colspan="${baselineResult ? 10 : 8}">Нет начислений за день</td></tr>`}</tbody></table></div><h4>Строки продаж и комиссия</h4><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>ID строки</th><th>Сотрудник</th><th>Позиция</th><th>Цех</th><th>База комиссии</th><th>Ставка</th><th>Комиссия</th></tr></thead><tbody>${lines || '<tr><td colspan="7">Детализация отсутствует или ограничена общим лимитом отображения.</td></tr>'}</tbody></table></div>${omitted}</details>`;
    }).join('');
    return `${renderBlockers(result)}<p><strong>${escapeHtml(result.periodFrom)} — ${escapeHtml(result.periodTo)} · ${escapeHtml(result.status)}</strong> · месячная база ${money(result.monthTurnoverCents, currency)}</p><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Сотрудник</th><th>Смены</th><th>Оклад</th><th>Комиссия</th><th>Премии</th><th>Срезано cap</th><th>Итого</th></tr></thead><tbody>${(result.employees || []).map((row) => `<tr><td>${escapeHtml(employeeNames.get(row.employeeId) || row.employeeId)}</td><td>${escapeHtml(row.shifts)}</td><td>${money(row.basePayCents, currency)}</td><td>${money(row.commissionCents, currency)}</td><td>${money(row.milestoneBonusCents, currency)}</td><td>${money(row.capReductionCents, currency)}</td><td><strong>${money(row.amountCents, currency)}</strong></td></tr>`).join('') || '<tr><td colspan="7">Нет сотрудников в расчёте</td></tr>'}</tbody></table></div><h4>Детализация по дню и чеку</h4>${daily || '<p class="empty">Нет дневных данных.</p>'}`;
  };
  const renderPreview = (payload, previewInput) => {
    const names = new Map((previewInput.employees || []).filter((employee) => employee && typeof employee === 'object').map((employee) => [employee.id, employee.name || employee.fullName || employee.id]));
    return renderDetails(payload.result || {}, names);
  };
  const renderComparison = (payload, previewInput) => {
    const names = new Map((previewInput.employees || []).filter((employee) => employee && typeof employee === 'object').map((employee) => [employee.id, employee.name || employee.fullName || employee.id]));
    const baseline = (payload.results || []).find((entry) => entry.scheme.versionId === payload.baselineVersionId)?.result;
    const currency = payload.currency || payload.results?.[0]?.result?.currency || 'RUB';
    const summaryByVersion = new Map((payload.comparisons || []).map((item) => [item.versionId, item]));
    const summaries = (payload.results || []).map((entry) => { const item = summaryByVersion.get(entry.scheme.versionId) || {}; return `<tr><td>${escapeHtml(entry.scheme.name)}</td><td>${escapeHtml(entry.scheme.versionNo)}</td><td>${escapeHtml(item.status || entry.result.status)}</td><td>${money(item.totalCents, currency)}</td><td>${money(item.deltaToBaselineCents, currency)}</td></tr>`; }).join('');
    const versions = (payload.results || []).map((entry) => {
      const renderBudget = { employeeDays: MAX_COMPARE_EMPLOYEE_DAYS, lines: MAX_COMPARE_LINES };
      return `<details class="finance-scheme-version"><summary>${escapeHtml(entry.scheme.name)} · версия ${escapeHtml(entry.scheme.versionNo)} · ${escapeHtml(entry.result.status)}</summary>${renderDetails(entry.result, names, entry.scheme.versionId === payload.baselineVersionId ? null : baseline, renderBudget)}</details>`;
    }).join('');
    return `<p>Сравнение использует один входной сценарий для всех версий. Валюта: ${escapeHtml(currency)}.</p><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Схема</th><th>Версия</th><th>Статус</th><th>Итого</th><th>Δ к базовой версии</th></tr></thead><tbody>${summaries}</tbody></table></div>${versions}`;
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
        <div data-scheme-preview-result class="finance-scheme-result" hidden></div>
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
          previewResult.hidden = false; previewResult.innerHTML = renderPreview(result, preview); notify('Готов сценарный preview. Он не является официальным расчётом и не сохранён.', 'success'); return;
        }
        if (button.matches('[data-scheme-compare]')) {
          const versionIds = [...panel.querySelectorAll('[data-scheme-compare-version]:checked')].map((item) => item.dataset.schemeCompareVersion);
          if (versionIds.length < 2 || versionIds.length > 8) throw new Error('Выберите от 2 до 8 версий для сравнения.');
          const preview = validatePreview(JSON.parse(previewInput.value));
          const result = await request('/api/payroll/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionIds, baselineVersionId: versionIds[0], previewInput: preview }) });
          previewResult.hidden = false; previewResult.innerHTML = renderComparison(result, preview); notify('Сравнение готово. Это сценарные значения без сохранения начислений.', 'success'); return;
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
