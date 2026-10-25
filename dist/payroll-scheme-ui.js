(() => {
  'use strict';

  let sessionUser = {};
  try { sessionUser = JSON.parse(localStorage.getItem('crm_session_user') || '{}'); } catch (_) {}
  if (sessionUser.role !== 'owner') return;

  const MAX_PREVIEW_EMPLOYEES = 500;
  const MAX_PREVIEW_SALES = 20000;
  const MAX_PREVIEW_ATTENDANCE = 20000;
  const ATTENDANCE_SHIFTS_PER_PAGE = 100;
  const MAX_RENDERED_EMPLOYEE_DAYS = 2000;
  const MAX_RENDERED_LINES = 2000;
  const MAX_COMPARE_EMPLOYEE_DAYS = 500;
  const MAX_REFUND_REVIEW_EMPLOYEE_DAYS = 500;
  const MAX_COMPARE_LINES = 500;
  const MAX_FULL_NET_CANDIDATE_ROWS = 2000;
  const MAX_FULL_NET_CANDIDATE_EVENTS = 2000;
  const PAYOUT_RISK_ACK_POLICY = 'payroll-own-revenue-ceiling-v1';
  const payrollEditorStateChanged = (baseline, current) => baseline !== null && JSON.stringify(baseline) !== JSON.stringify(current);
  const createPayrollEditorTransitionGate = (confirmDiscard) => {
    let sequence = 0;
    return {
      begin: async (dirty) => { const token = ++sequence; const confirmed = !dirty || await confirmDiscard();
        return confirmed && token === sequence ? token : null; },
      invalidate: () => ++sequence,
      isCurrent: token => token === sequence
    };
  };
  let venueTimezone = String(sessionUser.timezone || '');

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  // Pure structured-editor model. JSON remains canonical; unknown properties
  // are copied unchanged, and empty optional fields remove only their own path.
  const EDITOR_MODES = ['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target'];
  const EDITOR_ROLE_LABELS = { owner:'Владелец', admin:'Администратор', developer:'Разработчик', manager:'Управляющий', bartender:'Бармен', senior_bartender:'Старший бармен', hookah_master:'Кальянный мастер', senior_hookah_master:'Старший кальянный мастер', staff:'Сотрудник', other_staff:'Другая должность', cleaner:'Уборщик', security:'Охрана', technician:'Техник' };
  const editorRoleLabel = (role) => Object.hasOwn(EDITOR_ROLE_LABELS, role) ? EDITOR_ROLE_LABELS[role] : String(role);
  const EDITOR_MILESTONE_POLICIES = ['all_active', 'worked_on_threshold_day'];
  const EDITOR_MILESTONE_LABELS = { all_active: 'Активные сотрудники', worked_on_threshold_day: 'Отработал в день достижения порога' };
  const editorMilestoneEligibilityValue = (text) => {
    if (text === '') return undefined;
    if (typeof text !== 'string' || !EDITOR_MILESTONE_POLICIES.includes(text)) throw new Error('Выберите поддерживаемое условие выплаты премии.');
    return text;
  };
  const editorApplyMilestoneEligibility = (definition, text) => {
    const result = structuredClone(definition), value = editorMilestoneEligibilityValue(text);
    if (value === undefined) delete result.milestoneEligibility; else result.milestoneEligibility = value;
    return result;
  };
  const EDITOR_CHOICE_LABELS = { progressive_daily: 'Оклад + дневные пороги', stable_percent: 'Оклад + стабильный процент', percent_only: 'Только процент', final_month_threshold: 'Оклад + итоговый порог месяца', personal_target: 'Личный план', team_fund: 'Командный фонд', margin_target: 'План от маржи', venue_day: 'Оборот площадки за день', employee_department_day: 'Личный оборот цеха за день', replace_base: 'Заменить базовую ставку сверх плана', add_to_base: 'Добавить к базовой ставке сверх плана', offset_daily_losses: 'Зачесть дневные убытки', net_revenue: 'Чистая выручка строки', approved_minutes: 'По утверждённым минутам', configured_weights: 'По настроенным весам' };
  const editorDecimal = (text, scale = 100) => {
    const value = String(text).trim();
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) throw new Error('Введите неотрицательное число, не более двух знаков после запятой.');
    const [whole, fraction = ''] = value.replace(',', '.').split('.');
    const result = BigInt(whole) * BigInt(scale) + BigInt(fraction.padEnd(2, '0'));
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Число слишком велико.');
    return Number(result);
  };
  const editorFormat = (value) => value === undefined ? '' : Number.isSafeInteger(value) && value >= 0
    ? `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}` : String(value);
  const editorPathKeys = (path) => {
    const keys = path.split('.');
    if (keys.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Недопустимый путь параметра.');
    return keys;
  };
  const editorGet = (object, path) => editorPathKeys(path).reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, object);
  const editorSet = (object, path, value) => {
    const keys = editorPathKeys(path); let current = object;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(current, key) && value === undefined) return;
      if (!Object.hasOwn(current, key) || !current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
      current = current[key];
    }
    if (value === undefined) delete current[keys.at(-1)]; else current[keys.at(-1)] = value;
  };
  const editorDepartmentKey = (text) => {
    if (typeof text !== 'string' || !text || text !== text.trim() || [...text].length > 80
        || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(text)) {
      throw new Error('Код цеха: от 1 до 80 символов, без пробелов по краям и управляющих символов.');
    }
    return text;
  };
  const editorDepartmentPath = path => path === 'department' || path === 'cap.department';
  // Editor and submit-time impact/risk checks must accept the same paths.
  const EDITOR_OVERRIDE_PATH = /^(mode|applyMilestones|milestoneEligibility|department|perShiftCents|stableRateBps|targetCents|teamWeight|baseRateBps|bonusRateBps|excessRatePolicy|lossPolicy|itemRuleBasis|bracketRatesBps\.\d+|cap\.(rateBps|basis|department)|milestoneBonusesCents\.\d+)$/;
  const EDITOR_DEPARTMENT_HELP = 'Для лимита по личному обороту цеха сначала используется «Цех лимита», а если он не задан — «Цех сотрудника». Каждый параметр наследуется отдельно: цех лимита роли имеет приоритет даже над личным цехом сотрудника. Смена цеха может увеличить сумму выплаты при прежнем проценте. Эти настройки не меняют цех проданных строк и не подтверждают работу в смене.';
  const editorValue = (text, type) => {
    if (type === 'milestoneEligibility') return editorMilestoneEligibilityValue(text);
    if (type === 'departmentKey') return text === '' ? undefined : editorDepartmentKey(text);
    if (String(text).trim() === '') return undefined;
    if (type === 'boolean') {
      const value = String(text).trim();
      if (!['true', 'false'].includes(value)) throw new Error('Выберите включение, отключение или наследование премий.');
      return value === 'true';
    }
    if (type === 'money' || type === 'rate') {
      const value = editorDecimal(text);
      if (type === 'rate' && value > 10000) throw new Error('Ставка должна быть от 0 до 100%.');
      return value;
    }
    if (type === 'integer') {
      if (!/^\d+$/.test(String(text).trim())) throw new Error('Вес должен быть целым неотрицательным числом.');
      const value = Number(String(text).trim()); if (!Number.isSafeInteger(value)) throw new Error('Вес слишком велик.'); return value;
    }
    if (type === 'departments') return String(text).split(',').map((id) => id.trim()).filter(Boolean);
    return String(text).trim();
  };
  const editorOverrideType = (path) => /^(perShiftCents|targetCents|milestoneBonusesCents\.\d+)$/.test(path) ? 'money'
    : /^(stableRateBps|baseRateBps|bonusRateBps|bracketRatesBps\.\d+|cap\.rateBps)$/.test(path) ? 'rate'
      : editorDepartmentPath(path) ? 'departmentKey' : path === 'teamWeight' ? 'integer' : path === 'applyMilestones' ? 'boolean' : path === 'milestoneEligibility' ? 'milestoneEligibility' : 'text';
  const editorOverrideValue = (path, text) => {
    const type = editorOverrideType(path);
    if (type === 'boolean') { if (!['true', 'false'].includes(text)) throw new Error('Для applyMilestones укажите true или false.'); return text === 'true'; }
    const value = editorValue(text, type);
    if (value === undefined) throw new Error(type === 'departmentKey' ? 'Укажите код личного цеха или выберите наследование.' : 'Личное значение обязательно; ноль допустим.');
    const allowed = { mode: EDITOR_MODES, excessRatePolicy: ['replace_base', 'add_to_base'], lossPolicy: ['offset_daily_losses'], itemRuleBasis: ['net_revenue'], 'cap.basis': ['venue_day', 'employee_department_day'] };
    if (allowed[path] && !allowed[path].includes(value)) throw new Error('Неподдерживаемое значение параметра.');
    return value;
  };
  const editorApply = (source, fields, overrides, removeOverrides = []) => {
    const result = structuredClone(source);
    if (!result || !result.roleParameters || typeof result.roleParameters !== 'object' || Array.isArray(result.roleParameters)) throw new Error('В JSON нужен объект roleParameters.');
    for (const field of fields) {
      if (!Object.hasOwn(result.roleParameters, field.role)) throw new Error('Роль не найдена в конфигурации.');
      editorSet(result.roleParameters[field.role], field.path, editorValue(field.text, editorDepartmentPath(field.path) ? 'departmentKey' : field.path === 'milestoneEligibility' ? 'milestoneEligibility' : field.type));
    }
    for (const role of Object.values(result.roleParameters)) for (const path of ['cap', 'teamFund', 'bracketRatesBps', 'milestoneBonusesCents']) {
      if (role[path] && typeof role[path] === 'object' && !Array.isArray(role[path]) && !Object.keys(role[path]).length) delete role[path];
    }
    const original = source.employeeOverrides || [];
    if (!Array.isArray(original)) throw new Error('employeeOverrides должен быть списком.');
    result.employeeOverrides = original.map((item) => structuredClone(item));
    for (const edit of overrides) {
      const entry = edit.index === null ? {} : structuredClone(original[edit.index]);
      if (!entry) throw new Error('Переопределение не найдено.');
      if (!edit.employeeId.trim() || !EDITOR_OVERRIDE_PATH.test(edit.path)) throw new Error('Укажите сотрудника и поддерживаемый путь параметра.');
      entry.employeeId = edit.employeeId.trim(); entry.path = edit.path; entry.mode = edit.mode;
      if (/^(bracketRatesBps|milestoneBonusesCents)\.\d+$/.test(entry.path)) {
        const [family,key]=entry.path.split('.'), threshold=Number(key);
        if(!Number.isSafeInteger(threshold)||threshold<(family==='milestoneBonusesCents'?1:0))throw new Error('Порог должен быть безопасным целым числом; порог премии — положительным.');
        const relevant=(result.roleAssignments||[]).filter(row=>row.employeeId===entry.employeeId
          &&(!row.effectiveTo||!edit.effectiveFrom||row.effectiveTo>=edit.effectiveFrom)
          &&(!edit.effectiveTo||row.effectiveFrom<=edit.effectiveTo));
        for(const assignment of relevant){
          const map=result.roleParameters[assignment.roleId]?.[family]||{};
          if(!Object.hasOwn(map,key)&&!/^(0|[1-9]\d*)$/.test(key))throw new Error('Новый личный порог укажите без ведущих нулей.');
          if(entry.mode==='override'&&Object.keys(map).some(other=>other!==key&&Number(other)===threshold))throw new Error('Личный порог совпадает с другим написанием порога роли.');
        }
        if(!relevant.length&&!/^(0|[1-9]\d*)$/.test(key))throw new Error('Новый личный порог укажите без ведущих нулей.');
      }
      if (!['inherit', 'override'].includes(entry.mode)) throw new Error('Выберите наследование или личное значение.');
      if (entry.mode === 'override') entry.value = editorOverrideValue(entry.path, edit.text); else delete entry.value;
      for (const key of ['effectiveFrom', 'effectiveTo']) {
        const value = edit[key];
        if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new Error('Некорректная дата переопределения.');
        if (value) entry[key] = value;
        else if (edit.index !== null && original[edit.index]?.[key] === null) entry[key] = null;
        else delete entry[key];
      }
      if (entry.effectiveTo && entry.effectiveFrom && entry.effectiveTo < entry.effectiveFrom) throw new Error('Конец периода раньше начала.');
      if (edit.index === null) result.employeeOverrides.push(entry); else result.employeeOverrides[edit.index] = entry;
    }
    result.employeeOverrides = result.employeeOverrides.filter((_, index) => !removeOverrides.includes(index));
    const windows = new Map();
    for (const item of result.employeeOverrides) {
      const key = `${item.employeeId}|${item.path}`, from = item.effectiveFrom || result.effectiveFrom || '0000-01-01', to = item.effectiveTo || result.effectiveTo || '9999-12-31';
      if ((windows.get(key) || []).some((other) => from <= other.to && to >= other.from)) throw new Error('Периоды одного личного параметра пересекаются.');
      windows.set(key, [...(windows.get(key) || []), { from, to }]);
    }
    return result;
  };
  const editorRoleOverrideImpact = (definition, roleId, changedPath) => {
    const validDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
    const window = (row, requiredFrom = false) => {
      if ((requiredFrom && !validDate(row.effectiveFrom)) || (row.effectiveFrom !== undefined && row.effectiveFrom !== null && !validDate(row.effectiveFrom))
        || (row.effectiveTo !== undefined && row.effectiveTo !== null && !validDate(row.effectiveTo))) throw new Error('Некорректный период личных параметров или назначения роли.');
      const from = row.effectiveFrom || '0001-01-01', to = row.effectiveTo || '9999-12-31';
      if (from > to) throw new Error('Конец периода раньше начала.');
      return { from, to };
    };
    const idKey = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : id;
    const version = window(definition, true), assignments = definition.roleAssignments || [], overrides = definition.employeeOverrides || [];
    if (!Array.isArray(assignments) || !Array.isArray(overrides)) throw new Error('Назначения и личные параметры должны быть списками.');
    const assigned = assignments.map((row) => ({ ...row, ...window(row, true) }));
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const roleWindows = new Map(), overrideWindows = new Map();
    const addWindow = (groups, key, row) => { const rows = groups.get(key) || []; rows.push(row); groups.set(key, rows); };
    const checkWindows = (groups) => {
      for (const rows of groups.values()) {
        rows.sort((a, b) => compare(a.from, b.from));
        for (let i = 1; i < rows.length; i++) if (rows[i].from <= rows[i-1].to) throw new Error('Периоды назначений или личных параметров пересекаются; влияние определить нельзя.');
      }
    };
    for (const row of assigned) {
      if (typeof row.employeeId !== 'string' || !row.employeeId.trim() || typeof row.roleId !== 'string' || !Object.hasOwn(definition.roleParameters || {}, row.roleId)) throw new Error('Некорректное назначение роли.');
      if (row.from <= version.to && row.to >= version.from) addWindow(roleWindows, idKey(row.employeeId), { ...row, from: [row.from, version.from].sort().at(-1), to: [row.to, version.to].sort()[0] });
    }
    checkWindows(roleWindows);
    for (const item of overrides) {
      const period = window(item);
      if (typeof item.employeeId !== 'string' || !item.employeeId.trim() || typeof item.path !== 'string' || !item.path.trim()) throw new Error('Некорректный личный параметр.');
      addWindow(overrideWindows, JSON.stringify([idKey(item.employeeId), item.path]), period);
    }
    checkWindows(overrideWindows);
    const entries = [];
    for (const item of overrides) {
      const period = window(item);
      if (!['override', 'inherit'].includes(item.mode)) throw new Error('Неизвестный режим личного параметра.');
      if (item.mode !== 'override') continue;
      if (typeof item.employeeId !== 'string' || !item.employeeId.trim() || typeof item.path !== 'string'
        || !EDITOR_OVERRIDE_PATH.test(item.path)
        || !Object.hasOwn(item, 'value')) throw new Error('Некорректный личный параметр.');
      const type = editorOverrideType(item.path);
      if (type === 'departmentKey') editorDepartmentKey(item.value);
      const text = ['money', 'rate'].includes(type) ? editorFormat(item.value) : String(item.value);
      if (editorOverrideValue(item.path, text) !== item.value) throw new Error('Некорректное личное значение.');
      if (changedPath !== undefined && changedPath !== item.path) continue;
      for (const assignment of roleWindows.get(idKey(item.employeeId)) || []) {
        if (roleId !== undefined && assignment.roleId !== roleId) continue;
        const from = [version.from, assignment.from, period.from].sort().at(-1), to = [version.to, assignment.to, period.to].sort()[0];
        if (from <= to) entries.push({ roleId: assignment.roleId, employeeId: item.employeeId, path: item.path, value: item.value, from, to });
      }
    }
    return entries.sort((a, b) => compare(String(idKey(a.employeeId)), String(idKey(b.employeeId))) || compare(a.path, b.path) || compare(a.from, b.from));
  };
  const editorRoleImpactHtml = (entries, changedPath) => {
    const groups = new Map();
    for (const item of entries.slice(0, 200)) { const list = groups.get(item.employeeId) || []; list.push(item); groups.set(item.employeeId, list); }
    const heading = changedPath === undefined ? 'Персональные значения, перекрывающие параметры роли' : `Персональные значения для «${editorParameterLabel(changedPath)}»`;
    if (!entries.length) return `<p>${escapeHtml(changedPath === undefined ? 'Персональных значений этой роли в периоде версии нет.' : 'Персональных значений для этого параметра в периоде версии нет.')}</p>`;
    return `<p>${escapeHtml(heading)}. Изменение роли не заменяет эти личные значения; итог выплаты зависит и от других правил.${entries.length > 200 ? ` Показаны первые 200 из ${entries.length} периодов; полный список — в карточках личных параметров.` : ''}</p><ul>${[...groups].map(([id, items]) => `<li>${escapeHtml(editorEmployeeLabel(id))}<ul>${items.map((item) => `<li>${escapeHtml(editorParameterLabel(item.path))}: ${escapeHtml(['money', 'rate'].includes(editorOverrideType(item.path)) ? editorFormat(item.value) : editorDepartmentPath(item.path) ? editorDepartmentLabel(item.value) : String(item.value))} · ${escapeHtml(item.from)} — ${escapeHtml(item.to === '9999-12-31' ? 'без даты окончания' : item.to)}</li>`).join('')}</ul></li>`).join('')}</ul>`;
  };
  const editorPersonalCapIncreases = (definition) => {
    const normalized = structuredClone(definition);
    for (const row of normalized.employeeOverrides || []) {
      row.effectiveFrom ??= normalized.effectiveFrom;
      row.effectiveTo ??= normalized.effectiveTo;
    }
    return editorRoleOverrideImpact(normalized, undefined, 'cap.rateBps').flatMap((row) => {
    if (definition.roleParameters[row.roleId].cap === undefined) return [];
    const baseline = editorGet(definition.roleParameters[row.roleId], 'cap.rateBps');
    if (!definition.roleParameters[row.roleId].cap || Array.isArray(definition.roleParameters[row.roleId].cap)) throw new Error('У роли не задан корректный исходный лимит.');
    if (!Number.isSafeInteger(baseline) || baseline < 0 || baseline > 10000) throw new Error('У роли не задан корректный исходный лимит.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.employeeId)) throw new Error('Некорректный UUID сотрудника.');
    return row.value <= baseline ? [] : [{ employeeId: row.employeeId.toLowerCase(), roleId: row.roleId, path: 'cap.rateBps',
      effectiveFrom: row.from, effectiveTo: row.to === '9999-12-31' ? null : row.to, roleRateBps: baseline, personalRateBps: row.value }];
  }).sort((a, b) => {
    for (const key of ['employeeId', 'roleId', 'path', 'effectiveFrom', 'effectiveTo']) {
      const left = a[key] ?? '9999-12-31', right = b[key] ?? '9999-12-31';
      if (left !== right) return left < right ? -1 : 1;
    }
    return a.roleRateBps - b.roleRateBps || a.personalRateBps - b.personalRateBps;
    });
  };
  const editorRoleMilestonesDefault = (definition, roleId, editedMode) => {
    if (definition.applyMilestones !== undefined && typeof definition.applyMilestones !== 'boolean') throw new Error('applyMilestones схемы должен быть true или false.');
    const mode = editedMode !== undefined ? editedMode || definition.mode : definition.roleParameters?.[roleId]?.mode || definition.mode;
    if (!EDITOR_MODES.includes(mode)) throw new Error('Для наследования премий нужен поддерживаемый режим расчёта.');
    return definition.applyMilestones ?? mode === 'progressive_daily';
  };
  const editorInheritedParameter = (definition, item, roleEdits = []) => {
    const date=item.effectiveFrom||definition.effectiveFrom;
    const valid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
    if(!valid(date))throw new Error('Укажите корректную дату начала.');
    if(!Array.isArray(definition.roleAssignments||[]))return {date,roleId:null,value:undefined,origin:'invalid_assignment'};
    const employeeAssignments=(definition.roleAssignments||[]).filter(row=>row&&row.employeeId===item.employeeId);
    if(employeeAssignments.some(row=>!valid(row.effectiveFrom)||(row.effectiveTo&&!valid(row.effectiveTo))
      ||(row.effectiveTo&&row.effectiveTo<row.effectiveFrom)||typeof row.roleId!=='string'||!row.roleId))return {date,roleId:null,value:undefined,origin:'invalid_assignment'};
    const assignments=employeeAssignments.filter(row=>row.effectiveFrom<=date&&(!row.effectiveTo||row.effectiveTo>=date));
    if(assignments.length!==1)return {date,roleId:null,value:undefined,origin:assignments.length?'ambiguous':'unassigned'};
    const roleId=assignments[0].roleId,source=definition.roleParameters?.[roleId];
    if(!source||typeof source!=='object'||Array.isArray(source))return {date,roleId,value:undefined,origin:'missing_role'};
    const role=structuredClone(source);
    for(const edit of roleEdits.filter(row=>row.role===roleId&&row.path===item.path))editorSet(role,edit.path,editorValue(edit.text,editorDepartmentPath(edit.path)?'departmentKey':edit.type));
    if(item.path==='applyMilestones'&&role.applyMilestones===undefined&&definition.applyMilestones===undefined){
      for(const edit of roleEdits.filter(row=>row.role===roleId&&row.path==='mode'))editorSet(role,edit.path,editorValue(edit.text,edit.type));
    }
    let value=editorGet(role,item.path||''),origin=value===undefined?'absent':'role';
    if(editorDepartmentPath(item.path)&&value!==undefined)editorDepartmentKey(value);
    if(item.path==='mode'&&value===undefined){value=definition.mode;origin='scheme';}
    if(item.path==='applyMilestones'&&value===undefined){
      if(definition.applyMilestones!==undefined){if(typeof definition.applyMilestones!=='boolean')throw new Error('Проверьте переключатель премий схемы.');value=definition.applyMilestones;origin='scheme';}
      else{const mode=role.mode||definition.mode;if(!EDITOR_MODES.includes(mode))throw new Error('Проверьте режим роли.');value=mode==='progressive_daily';origin='role_mode';}
    }
    if(item.path==='applyMilestones'&&typeof value!=='boolean')throw new Error('Проверьте переключатель премий роли.');
    if(item.path==='milestoneEligibility'){
      if(value===undefined){value=definition.milestoneEligibility===undefined?'all_active':definition.milestoneEligibility;origin=definition.milestoneEligibility===undefined?'legacy_default':'scheme';}
      editorMilestoneEligibilityValue(value);
    }
    return {date,roleId,value,origin};
  };
  const editorInheritedCaption = (definition,item,roleEdits=[]) => {
    try{
      const context=editorInheritedParameter(definition,item,roleEdits);
      if(!context.roleId||['ambiguous','missing_role'].includes(context.origin))return `На ${context.date}: ${context.origin==='ambiguous'?'назначения ролей пересекаются — проверьте даты':'роль не определена'}. Наследуемое значение не определено.`;
      const labels={role:'роль',scheme:'схема',role_mode:'режим роли',legacy_default:'прежнее правило',absent:'не задано'},type=editorOverrideType(item.path||'');
      const value=context.value===undefined?'не задано (при наследовании личный параметр отсутствует)':typeof context.value==='boolean'?(context.value?'начислять':'не начислять')
        :type==='milestoneEligibility'?EDITOR_MILESTONE_LABELS[context.value]:['money','rate'].includes(type)?editorFormat(context.value):type==='departmentKey'?editorDepartmentLabel(context.value):String(context.value);
      return `На ${context.date} · роль: ${editorRoleLabel(context.roleId)} · наследуемое значение: ${value} · источник: ${labels[context.origin]}. ${editorDepartmentPath(item.path)?'Показано наследование именно этого параметра; при расчёте цех лимита имеет приоритет над цехом сотрудника.':'Пустое личное значение не равно нулю.'}`;
    }catch(error){return `Наследование не определено: ${error.message}`;}
  };
  const editorMilestoneThresholds = (definition) => {
    const thresholds = new Set();
    for (const role of Object.values(definition.roleParameters || {})) {
      const bonuses = role.milestoneBonusesCents;
      if (bonuses === undefined) continue;
      if (!bonuses || typeof bonuses !== 'object' || Array.isArray(bonuses)) throw new Error('Пороговые премии роли должны быть объектом.');
      for (const key of Object.keys(bonuses)) {
        if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key))) throw new Error('Порог премии должен быть положительной суммой в пределах точности расчёта, без ведущих нулей.');
        if (!Number.isSafeInteger(bonuses[key]) || bonuses[key] < 0) throw new Error('Сумма премии должна быть неотрицательной и точной.');
        thresholds.add(key);
      }
    }
    return [...thresholds].sort((a, b) => Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : a < b ? -1 : a > b ? 1 : 0);
  };
  const EDITOR_FIELDS = [
    ['mode', 'Способ расчёта', 'select', EDITOR_MODES], ['perShiftCents', 'Оклад за смену', 'money'],
    ['applyMilestones', 'Пороговые премии', 'boolean', ['true', 'false']],
    ['milestoneEligibility', 'Условие выплаты премии', 'select', EDITOR_MILESTONE_POLICIES],
    ['stableRateBps', 'Стабильная ставка, %', 'rate'], ['cap.rateBps', 'Лимит, %', 'rate'], ['cap.basis', 'База лимита', 'select', ['venue_day', 'employee_department_day']],
    ['department', 'Цех сотрудника (если цех лимита не задан)', 'departmentKey'], ['cap.department', 'Цех лимита (приоритетный)', 'departmentKey'],
    ['targetCents', 'Личный ориентир', 'money'], ['baseRateBps', 'Базовая ставка, %', 'rate'], ['bonusRateBps', 'Повышенная ставка, %', 'rate'],
    ['excessRatePolicy', 'Ставка сверх ориентира', 'select', ['replace_base', 'add_to_base']], ['lossPolicy', 'Учёт убытков', 'select', ['offset_daily_losses']], ['itemRuleBasis', 'База позиционной ставки', 'select', ['net_revenue']],
    ['teamWeight', 'Личный вес в фонде', 'integer'], ['teamFund.poolId', 'ID общего фонда', 'text'], ['teamFund.departments', 'Цеха фонда через запятую', 'departments'],
    ['teamFund.targetCents', 'Ориентир фонда', 'money'], ['teamFund.baseRateBps', 'База фонда, %', 'rate'], ['teamFund.bonusRateBps', 'Повышенная ставка фонда, %', 'rate'],
    ['teamFund.excessRatePolicy', 'Ставка фонда сверх ориентира', 'select', ['replace_base', 'add_to_base']], ['teamFund.distributionPolicy', 'Распределение фонда', 'select', ['approved_minutes', 'configured_weights']]
  ];
  const editorStatusLabel = status => ({ draft:'Черновик', active:'Активна', retired:'Заменена новой версией', archived:'В архиве', ready:'Сценарий рассчитан', blocked:'Расчёт заблокирован' })[status] || String(status || '');
  const editorParameterLabel = path => {
    const field = EDITOR_FIELDS.find(row => row[0] === path);
    if (field) return field[1];
    const threshold = /^(bracketRatesBps|milestoneBonusesCents)\.(\d+)$/.exec(path);
    return threshold ? `${threshold[1] === 'bracketRatesBps' ? 'Ставка, %' : 'Премия'} при обороте от ${editorFormat(Number(threshold[2]))}` : `Сохранённый параметр: ${path}`;
  };
  const editorParameterOptions = (definition, current = '') => {
    const paths = new Set(EDITOR_FIELDS.map(row => row[0]).filter(path => EDITOR_OVERRIDE_PATH.test(path)));
    for (const role of Object.values(definition?.roleParameters || {})) {
      for (const group of ['bracketRatesBps', 'milestoneBonusesCents']) {
        for (const key of Object.keys(role[group] || {})) if (/^\d+$/.test(key)) paths.add(`${group}.${key}`);
      }
    }
    if (current) paths.add(current);
    return [...paths].map(value => ({ value, label: editorParameterLabel(value) }));
  };
  const editorEmployeeOptions = (staff, definition, current = '') => {
    const byId = new Map();
    for (const row of staff || []) if (typeof row?.id === 'string' && row.id && !byId.has(row.id)) byId.set(row.id, row);
    const ids = new Set([...byId.keys(), ...(definition?.roleAssignments || []).map(row => row.employeeId), ...(definition?.employeeOverrides || []).map(row => row.employeeId)]);
    if (current) ids.add(current);
    const names = new Map();
    for (const row of byId.values()) { const name = row.name || row.login || row.id; names.set(name, (names.get(name) || 0) + 1); }
    return [...ids].filter(id => typeof id === 'string' && id).map(value => {
      const row = byId.get(value);
      if (!row) return { value, label: `Сотрудник вне справочника · ${value}` };
      const name = row.name || row.login || value;
      const duplicate = names.get(name) > 1 ? ` · ${row.login || value}` : '';
      return { value, label: `${name}${duplicate}${row.role ? ` · ${editorRoleLabel(row.role)}` : ''}${row.active === false ? ' · неактивен' : ''}` };
    });
  };
  const editorDepartmentOptions = (departments, current = '') => {
    const rows = new Map();
    for (const row of departments || []) {
      const key = row?.code ?? row?.id;
      try { editorDepartmentKey(key); } catch (_) { continue; }
      if (!rows.has(key)) rows.set(key, { value:key, label:`${row.name || key} · ${key}${row.active === false ? ' · в архиве' : ''}` });
    }
    if (current && !rows.has(current)) rows.set(current, { value:current, label:`Сохранённый цех · ${current}` });
    return [...rows.values()];
  };
  const editorOptionsHtml = (options, current, placeholder) => `<option value="">${escapeHtml(placeholder)}</option>${options.map(row => `<option value="${escapeHtml(row.value)}"${row.value === current ? ' selected' : ''}>${escapeHtml(row.label)}</option>`).join('')}`;
  let ownerStaff = [], ownerDepartments = [];
  const editorEmployeeLabel = id => editorEmployeeOptions(ownerStaff, null, id).find(row => row.value === id)?.label || id;
  const editorDepartmentLabel = key => editorDepartmentOptions(ownerDepartments, key).find(row => row.value === key)?.label || key;
  const SOURCE_POLICY_SALES = ['line_seller_snapshot', 'order_responsible_snapshot', 'explicit_line_allocation'];
  const SOURCE_POLICY_DISCOUNTS = ['immutable_line_snapshot', 'eligible_gross_proportional_fixed_order'];
  const SOURCE_POLICY_REFUNDS = ['recognized_event_date', 'original_sale_period_correction'];
  const SOURCE_POLICY_V2_EARNINGS = Object.freeze({ refunds: 'remaining_merchandise_original_sale_date_v1',
    venueTurnover: 'canonical_total_less_merchandise_returns_v1', marginCost: 'frozen_sale_depletion_cost_payroll_v1' });
  const applySourcePolicyControls = (definition, controls) => {
    const result = structuredClone(definition);
    if (!controls.enabled) { delete result.sourcePolicies; return result; }
    if (!['1', '2'].includes(controls.schemaVersion)) throw new Error('Явно выберите порядок пересчёта премии после возвратов.');
    const schemaVersion = Number(controls.schemaVersion);
    const reason = String(controls.selectionReason || '').trim();
    if (!SOURCE_POLICY_SALES.includes(controls.saleCredit) || !SOURCE_POLICY_DISCOUNTS.includes(controls.discountAllocation)
        || !SOURCE_POLICY_REFUNDS.includes(controls.refunds)) throw new Error('Явно выберите все правила источников.');
    if (reason.length < 3 || reason.length > 1000) throw new Error('Укажите причину выбора правил: от 3 до 1000 символов.');
    if (schemaVersion === 2 && (controls.saleCredit !== 'line_seller_snapshot'
        || controls.discountAllocation !== 'immutable_line_snapshot' || controls.refunds !== 'recognized_event_date')) {
      throw new Error('Для пересчёта премии выберите продавца из снимка строки, точную скидку из снимка строки и дату признанного события возврата.');
    }
    result.sourcePolicies = { schemaVersion, selectionReason: reason, saleCredit: { kind: controls.saleCredit },
      discountAllocation: controls.discountAllocation === 'immutable_line_snapshot' ? { kind: controls.discountAllocation }
        : { kind: controls.discountAllocation, rounding: 'largest_remainder_code_unit_v1', eligibility: 'pricing_source_snapshot' },
      refunds: { recognition: controls.refunds, closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
        uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
    if (schemaVersion === 2) result.sourcePolicies.earnings = { ...SOURCE_POLICY_V2_EARNINGS };
    return result;
  };
  const sourcePolicyControlValues = (definition) => {
    const policy = definition.sourcePolicies;
    return { enabled: policy !== undefined, schemaVersion: policy === undefined ? '1' : String(policy?.schemaVersion ?? ''),
      saleCredit: policy?.saleCredit?.kind || '', discountAllocation: policy?.discountAllocation?.kind || '',
      refunds: policy?.refunds?.recognition || '', selectionReason: policy?.selectionReason || '' };
  };
  const venueLocalToday = () => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: venueTimezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (_) { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  };
  const request = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }
    if (!response.ok) throw Object.assign(new Error(data.error || `http_${response.status}`), { status: response.status, data });
    return data;
  };
  const mountEmploymentEligibilityPanel = (payrollPanel, settings) => {
    const section = document.createElement('section');
    section.className = 'panel finance-payroll-eligibility';
    section.innerHTML = `
      <style>
        .finance-payroll-eligibility{min-width:0;box-sizing:border-box}
        .finance-payroll-eligibility [data-eligibility-rows]{display:grid;gap:10px}
        .finance-payroll-eligibility [data-eligibility-row]{display:grid;grid-template-columns:minmax(180px,1.5fr) repeat(2,minmax(130px,1fr)) auto;gap:10px;align-items:end;padding:12px;border:1px solid var(--ui-border-control);border-radius:10px}
        .finance-payroll-eligibility [data-eligibility-row] label{min-width:0}
        .finance-payroll-eligibility [data-eligibility-row] input,.finance-payroll-eligibility [data-eligibility-row] select{width:100%;max-width:100%;box-sizing:border-box}
        .finance-payroll-eligibility [data-eligibility-period]{display:grid;gap:6px;padding:10px 0;border-top:1px solid var(--ui-border-control)}
        .finance-payroll-eligibility [data-eligibility-period] span{overflow-wrap:anywhere}
        .finance-payroll-eligibility [data-eligibility-history] li{margin:8px 0;overflow-wrap:anywhere}
        @media(max-width:700px){.finance-payroll-eligibility [data-eligibility-row]{grid-template-columns:minmax(0,1fr)}.finance-payroll-eligibility [data-eligibility-row] .button{width:100%}}
      </style>
      <div class="panel-head"><div><h3>Сотрудники, которых учитывать в зарплате</h3><span class="muted">История по датам для будущих расчётов. Сохранение не создаёт начисление или выплату.</span></div><div class="toolbar-row"><button type="button" class="button small" data-eligibility-reload>Обновить</button><button type="button" class="button small primary" data-eligibility-edit>Настроить список</button></div></div>
      <p class="form-message" data-eligibility-status role="status" aria-live="polite">Загружаем список сотрудников и историю…</p>
      <div data-eligibility-current><div class="empty">Загрузка…</div></div>
      <form class="stack-form" data-eligibility-editor hidden>
        <p class="muted">Укажите все действующие периоды. Сохранение создаст новую версию; предыдущие версии останутся в истории. Неактивных сотрудников можно выбрать для прошлых дат.</p>
        <div data-eligibility-rows></div>
        <button type="button" class="button small" data-eligibility-add>Добавить период</button>
        <label>Причина изменения <span class="required-mark">*</span><textarea data-eligibility-reason rows="2" maxlength="1000" minlength="8" required placeholder="Например: сверили дату приёма и завершения работы"></textarea></label>
        <label data-eligibility-empty-confirm-row hidden><input type="checkbox" data-eligibility-empty-confirm> Подтверждаю пустую версию: ни одного периода допуска к расчёту</label>
        <div class="toolbar-row"><button type="submit" class="button primary" data-eligibility-save>Сохранить новую версию</button><button type="button" class="button" data-eligibility-cancel>Отмена</button></div>
        <p class="form-message" data-eligibility-editor-message role="status" aria-live="polite"></p>
      </form>
      <details data-eligibility-history-details><summary>История изменений</summary><ol data-eligibility-history><li class="muted">Загружаем историю…</li></ol></details>`;
    payrollPanel.insertBefore(section, settings);
    const currentView = section.querySelector('[data-eligibility-current]');
    const historyView = section.querySelector('[data-eligibility-history]');
    const status = section.querySelector('[data-eligibility-status]');
    const editor = section.querySelector('[data-eligibility-editor]');
    const rowsView = section.querySelector('[data-eligibility-rows]');
    const reasonField = section.querySelector('[data-eligibility-reason]');
    const editorMessage = section.querySelector('[data-eligibility-editor-message]');
    const emptyConfirmRow = section.querySelector('[data-eligibility-empty-confirm-row]');
    let roster = null, snapshot = null, editRows = [], editingRevisionId = null, pendingRequestKey = '', pendingIdempotencyKey = '', saving = false;
    const setMessage = (node, message, error = false) => { node.textContent = message; node.className = `form-message${error ? ' error-message' : ''}`; };
    const periodLabel = period => `${escapeHtml(period.employeeName || 'Сотрудник недоступен в справочнике')} · ${escapeHtml(period.effectiveFrom)} — ${escapeHtml(period.effectiveTo || 'без даты окончания')}`;
    const renderRoster = () => {
      const current = snapshot?.current || null;
      if (!current) currentView.innerHTML = '<p class="empty">История ещё не настроена. Пока нет подтверждённых периодов, будущий расчёт зарплаты должен оставаться заблокированным.</p>';
      else if (!current.periods?.length) currentView.innerHTML = '<p class="warning-message">Сохранена пустая версия: ни один сотрудник не включён в расчёт.</p>';
      else currentView.innerHTML = `<p class="muted">Текущая версия ${Number(current.revisionNo)} · ${current.periods.length} ${current.periods.length === 1 ? 'период' : 'периода'}</p><div>${current.periods.map(period => `<div class="finance-payroll-eligibility__period" data-eligibility-period><span>${periodLabel(period)}</span></div>`).join('')}</div>`;
    };
    const renderHistory = () => {
      const history = snapshot?.history || [];
      historyView.innerHTML = history.length ? history.map(revision => `<li><b>Версия ${Number(revision.revisionNo)}</b> · ${escapeHtml(String(revision.createdAt || '').replace('T', ' ').slice(0, 16))} · ${escapeHtml(revision.createdByName || 'Владелец')} · ${Number(revision.periodCount)} периодов<br><span class="muted">${escapeHtml(revision.reason || '')}</span></li>`).join('') : '<li class="muted">Сохранённых версий пока нет.</li>';
    };
    const showError = error => ({
      payroll_employment_eligibility_schema_required: 'Редактор пока недоступен: база данных ещё не обновлена.',
      payroll_scheme_owner_only: 'Историю может настраивать только владелец площадки.',
      payroll_employment_periods_overlap: 'У одного сотрудника пересекаются периоды. Проверьте даты.',
      payroll_employment_revision_conflict: 'История уже изменилась в другой вкладке. Обновите данные и проверьте изменения.',
      payroll_employment_idempotency_conflict: 'Повтор сохранения отличается от исходного запроса. Обновите историю и проверьте изменения.',
      invalid_payroll_employment_periods: 'Проверьте выбранных сотрудников и даты периодов.',
      invalid_payroll_employment_reason: 'Укажите причину изменения (не менее 8 символов).'
    })[error?.message] || 'Не удалось загрузить или сохранить историю. Проверьте соединение и попробуйте ещё раз.';
    const refresh = async () => {
      status.textContent = 'Загружаем список сотрудников и историю…';
      try {
        const [nextRoster, nextSnapshot] = await Promise.all([
          request('/api/payroll/employment-eligibility/employees'), request('/api/payroll/employment-eligibility')
        ]);
        if (!Array.isArray(nextRoster.items) || !Array.isArray(nextSnapshot.history)) throw new Error('payroll_employment_eligibility_unavailable');
        roster = nextRoster.items.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string')
          .map(row => ({ id: row.id, name: row.name, active: row.active === true }));
        snapshot = nextSnapshot;
        setMessage(status, nextSnapshot.current ? `Последнее изменение: версия ${Number(nextSnapshot.current.revisionNo)} · ${nextSnapshot.current.createdByName || 'владелец'}`
          : '');
        renderRoster(); renderHistory();
      } catch (error) {
        status.textContent = showError(error);
        currentView.innerHTML = '<p class="empty">Не удалось подтвердить актуальную историю. Сохранение временно недоступно.</p>';
        historyView.innerHTML = '<li class="muted">История не загружена.</li>';
        throw error;
      }
    };
    const optionHtml = (selected, include) => {
      const currentRows = snapshot?.current?.periods || [];
      const known = new Map(roster.map(row => [row.id, row]));
      for (const period of currentRows) if (!known.has(period.employeeId)) known.set(period.employeeId, {
        id: period.employeeId, name: `${period.employeeName || 'Сотрудник'} (сохранён в истории)`, active: false
      });
      return `<option value="">Выберите сотрудника</option>${[...known.values()].map(row => `<option value="${escapeHtml(row.id)}"${row.id === selected ? ' selected' : ''}>${escapeHtml(row.name)}${row.active ? '' : ' · неактивен'}</option>`).join('')}`;
    };
    const renderRows = () => {
      rowsView.innerHTML = editRows.map((row, index) => `<div data-eligibility-row data-row-index="${index}"><label>Сотрудник <span class="required-mark">*</span><select data-period-employee required>${optionHtml(row.employeeId)}</select></label><label>Учитывать с <span class="required-mark">*</span><input type="date" data-period-from value="${escapeHtml(row.effectiveFrom)}" required></label><label>По дату<input type="date" data-period-to value="${escapeHtml(row.effectiveTo)}"><small class="muted">Пусто — период продолжается</small></label><button type="button" class="button small" data-period-remove aria-label="Удалить период ${index + 1}">Удалить</button></div>`).join('');
      emptyConfirmRow.hidden = editRows.length > 0;
    };
    const openEditor = () => {
      if (!Array.isArray(roster) || !snapshot) { setMessage(editorMessage, 'Сначала загрузите актуальный список сотрудников и историю.', true); editor.hidden = false; return; }
      editingRevisionId = snapshot.current?.id || null;
      editRows = (snapshot.current?.periods || []).map(row => ({ employeeId: row.employeeId, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo || '' }));
      if (!editRows.length && roster.length) editRows = [{ employeeId: '', effectiveFrom: '', effectiveTo: '' }];
      reasonField.value = ''; section.querySelector('[data-eligibility-empty-confirm]').checked = false;
      setMessage(editorMessage, ''); renderRows(); editor.hidden = false; editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    section.querySelector('[data-eligibility-edit]').addEventListener('click', openEditor);
    section.querySelector('[data-eligibility-reload]').addEventListener('click', () => { refresh().catch(() => {}); });
    section.querySelector('[data-eligibility-cancel]').addEventListener('click', () => { editor.hidden = true; editingRevisionId = null; });
    section.querySelector('[data-eligibility-add]').addEventListener('click', () => { editRows.push({ employeeId: '', effectiveFrom: '', effectiveTo: '' }); renderRows(); });
    rowsView.addEventListener('click', event => {
      const remove = event.target.closest('[data-period-remove]');
      if (!remove) return;
      const index = Number(remove.closest('[data-eligibility-row]')?.dataset.rowIndex);
      if (Number.isInteger(index)) { editRows.splice(index, 1); renderRows(); }
    });
    rowsView.addEventListener('change', event => {
      const row = event.target.closest('[data-eligibility-row]');
      if (!row) return;
      const model = editRows[Number(row.dataset.rowIndex)];
      if (!model) return;
      if (event.target.matches('[data-period-employee]')) model.employeeId = event.target.value;
      if (event.target.matches('[data-period-from]')) model.effectiveFrom = event.target.value;
      if (event.target.matches('[data-period-to]')) model.effectiveTo = event.target.value;
    });
    editor.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || !editor.reportValidity()) return;
      const periods = [...rowsView.querySelectorAll('[data-eligibility-row]')].map(row => ({
        employeeId: row.querySelector('[data-period-employee]').value,
        effectiveFrom: row.querySelector('[data-period-from]').value,
        effectiveTo: row.querySelector('[data-period-to]').value || null
      }));
      if (!periods.length && !section.querySelector('[data-eligibility-empty-confirm]').checked) {
        setMessage(editorMessage, 'Подтвердите пустую версию, если действительно хотите исключить всех сотрудников.', true); return;
      }
      if (periods.some(row => !row.employeeId || !row.effectiveFrom || (row.effectiveTo && row.effectiveTo < row.effectiveFrom))) {
        setMessage(editorMessage, 'Проверьте сотрудника и даты: конец периода не может быть раньше начала.', true); return;
      }
      const base = { expectedRevisionId: editingRevisionId, periods, reason: reasonField.value.trim() };
      const retryKey = JSON.stringify(base);
      if (retryKey !== pendingRequestKey) {
        pendingRequestKey = retryKey;
        const newKey = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        pendingIdempotencyKey = `payroll-eligibility:${newKey}`;
      }
      const payload = { ...base, idempotencyKey: pendingIdempotencyKey };
      saving = true; const save = section.querySelector('[data-eligibility-save]'); save.disabled = true;
      setMessage(editorMessage, 'Сохраняем новую версию…');
      let committedRevision = null;
      try {
        const result = await request('/api/payroll/employment-eligibility', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        committedRevision = result;
        setMessage(editorMessage, `Версия ${Number(result.revisionNo)} сохранена. Проверяем сохранённую историю…`);
        await refresh();
        if (snapshot?.current?.id === result.id) { editor.hidden = true; editingRevisionId = null; pendingRequestKey = ''; pendingIdempotencyKey = ''; setMessage(editorMessage, `Версия ${Number(result.revisionNo)} сохранена и повторно загружена.`); }
      } catch (error) {
        if (!committedRevision && error?.message === 'payroll_employment_revision_conflict') {
          await refresh().catch(() => {});
          editor.hidden = true;
          editingRevisionId = null;
          pendingRequestKey = ''; pendingIdempotencyKey = '';
          setMessage(status, 'В другой вкладке сохранена новая версия. Ваш вариант не применён. Нажмите «Настроить список», чтобы начать от актуальной истории.', true);
        } else setMessage(editorMessage, committedRevision
          ? `Версия ${Number(committedRevision.revisionNo)} сохранена, но не удалось повторно загрузить историю. Нажмите «Обновить».`
          : showError(error), true);
      }
      finally { saving = false; save.disabled = false; }
    });
    refresh().catch(() => {});
    return section;
  };
  const mountProductDepartmentPanel = (payrollPanel, settings) => {
    const section = document.createElement('section');
    section.className = 'panel finance-payroll-departments';
    section.innerHTML = `
      <style>
        .finance-payroll-departments{min-width:0;box-sizing:border-box}
        .finance-payroll-departments [data-department-rows]{display:grid;gap:10px}
        .finance-payroll-departments [data-department-row]{display:grid;grid-template-columns:minmax(160px,1.5fr) repeat(2,minmax(130px,1fr)) auto;gap:10px;align-items:end;padding:12px;border:1px solid var(--ui-border-control);border-radius:10px}
        .finance-payroll-departments [data-department-row][data-retro=true]{grid-template-columns:minmax(160px,1.3fr) repeat(4,minmax(120px,1fr)) auto}
        .finance-payroll-departments [data-department-row] label{min-width:0}
        .finance-payroll-departments [data-department-row] input,.finance-payroll-departments [data-department-row] select{width:100%;max-width:100%;box-sizing:border-box}
        .finance-payroll-departments [data-department-current] li,.finance-payroll-departments [data-department-history] li{margin:8px 0;overflow-wrap:anywhere}
        @media(max-width:800px){.finance-payroll-departments [data-department-row],.finance-payroll-departments [data-department-row][data-retro=true]{grid-template-columns:minmax(0,1fr)}.finance-payroll-departments [data-department-row] .button{width:100%}}
      </style>
      <div class="panel-head"><div><h3>Подразделения товаров для зарплаты</h3><span class="muted">Отдельная классификация зарплаты. Она не меняет товар, категорию, заказ или финансовую выручку.</span></div><div class="toolbar-row"><button type="button" class="button small" data-department-reload>Обновить</button><button type="button" class="button small primary" data-department-edit>Настроить назначения</button><button type="button" class="button small" data-department-retro>Историческая корректировка</button></div></div>
      <p class="form-message" data-department-status role="status" aria-live="polite">Загружаем зарплатную классификацию…</p>
      <p class="warning-message">Обычная версия начнёт действовать с <b data-department-boundary>—</b> по времени площадки. Прошлые интервалы останутся в каждой сохранённой версии.</p>
      <div data-department-current><p class="empty">Загрузка…</p></div>
      <form class="stack-form" data-department-editor hidden>
        <p class="muted" data-department-editor-caption></p><div data-department-rows></div>
        <button type="button" class="button small" data-department-add>Добавить товар</button>
        <label>Причина изменения <span class="required-mark">*</span><textarea data-department-reason rows="2" minlength="8" maxlength="1000" required></textarea></label>
        <label data-department-retro-date-row hidden>Применить с даты <span class="required-mark">*</span><input type="date" data-department-retro-date></label>
        <label data-department-retro-reason-row hidden>Почему исправляется прошлая классификация <span class="required-mark">*</span><textarea data-department-retro-reason rows="2" minlength="8" maxlength="500"></textarea></label>
        <label data-department-empty-row hidden><input type="checkbox" data-department-empty> Подтверждаю пустую версию: у товаров не будет зарплатного подразделения</label>
        <label data-department-attestation-row hidden><input type="checkbox" data-department-attestation> Подтверждаю отдельную ретроактивную корректировку с указанной даты</label>
        <div class="toolbar-row"><button type="submit" class="button primary" data-department-save>Сохранить версию</button><button type="button" class="button" data-department-cancel>Отмена</button></div>
        <p class="form-message" data-department-editor-message role="status" aria-live="polite"></p>
      </form>
      <details data-department-history-details><summary>Последние 30 версий</summary><ol data-department-history><li class="muted">Загружаем историю…</li></ol></details>
      <details data-department-inspected-details hidden><summary data-department-inspected-title>Снимок версии</summary><div data-department-inspected></div></details>`;
    payrollPanel.insertBefore(section, settings);
    const status = section.querySelector('[data-department-status]'), current = section.querySelector('[data-department-current]');
    const history = section.querySelector('[data-department-history]'), editor = section.querySelector('[data-department-editor]');
    const rows = section.querySelector('[data-department-rows]'), editorMessage = section.querySelector('[data-department-editor-message]');
    const boundary = section.querySelector('[data-department-boundary]'), emptyRow = section.querySelector('[data-department-empty-row]');
    let snapshot = null, editRows = [], mode = 'normal', saving = false, lastRequest = '', idempotencyKey = '';
    const report = (node, text, error = false) => { node.textContent = text; node.className = `form-message${error ? ' error-message' : ''}`; };
    const safeError = error => ({
      payroll_product_department_schema_required:'Хранилище версий пока не готово. Обновите локальную базу данных.',
      payroll_product_department_timezone_invalid:'Не задан часовой пояс площадки. Обычное сохранение заблокировано.',
      payroll_product_department_revision_conflict:'В другой вкладке уже сохранена новая версия. Обновите историю.',
      payroll_product_department_idempotency_conflict:'Ключ повтора уже использован для других данных. Обновите историю.',
      payroll_product_department_product_invalid:'Выбранный товар недоступен в этой площадке.',
      payroll_product_department_mappings_overlap:'У товара пересекаются даты подразделений.',
      invalid_payroll_product_department_revision:'Проверьте поля версии и обязательную причину.',
      invalid_payroll_product_department_retroactive_revision:'Проверьте дату и подтверждение исторической корректировки.'
    })[error?.message] || 'Не удалось загрузить или сохранить классификацию. Повторите попытку.';
    const renderCurrent = () => {
      const assignments = snapshot?.currentAssignments || [];
      const names = new Map((snapshot?.currentRevision?.mappings || []).map(row => [row.productId, row.productName]));
      current.innerHTML = assignments.length ? `<p>Версия ${Number(snapshot.currentRevision?.revisionNo || 0)} · ${assignments.length} назначений</p><ul>${assignments.map(row => `<li><b>${escapeHtml(names.get(row.productId) || 'Товар')}</b> — ${escapeHtml(row.departmentName)} <span class="muted">(${escapeHtml(row.departmentCode)})</span></li>`).join('')}</ul>` : '<p class="empty">На дату следующей версии назначений пока нет.</p>';
      if (snapshot?.productOptionsTruncated) {
        current.insertAdjacentHTML('afterbegin','<p class="warning-message">Каталог содержит больше 10 000 активных товаров. Список обрезан, поэтому редактирование отключено, чтобы не сохранить неполную классификацию.</p>');
        section.querySelector('[data-department-edit]').disabled = true;
        section.querySelector('[data-department-retro]').disabled = true;
      } else {
        section.querySelector('[data-department-edit]').disabled = false;
        section.querySelector('[data-department-retro]').disabled = false;
      }
    };
    const renderHistory = () => {
      history.innerHTML = snapshot?.history?.length ? snapshot.history.map(row => `<li><b>Версия ${Number(row.revisionNo)}</b> · ${escapeHtml(row.effectiveFrom)} · ${escapeHtml(row.createdByName || 'Владелец')}<br><span class="muted">${escapeHtml(row.reason || '')}</span> <button type="button" class="button small" data-department-inspect="${escapeHtml(row.id)}">Открыть снимок</button></li>`).join('') : '<li class="muted">Сохранённых версий пока нет.</li>';
    };
    const refresh = async () => {
      report(status, 'Загружаем зарплатную классификацию…');
      try {
        const next = await request('/api/payroll/product-department-mappings');
        if (!Array.isArray(next.history) || !Array.isArray(next.productOptions) || !Array.isArray(next.currentAssignments)) throw new Error('payroll_product_department_response_invalid');
        snapshot = next; boundary.textContent = next.nextEffectiveFrom || 'не определена';
        report(status, next.currentRevision ? `Последнее изменение: версия ${Number(next.currentRevision.revisionNo)} · ${next.timezone}` : 'Версия ещё не создана.');
        renderCurrent(); renderHistory();
      } catch (error) {
        report(status, safeError(error), true); current.innerHTML = '<p class="empty">Не удалось подтвердить актуальную версию. Сохранение недоступно.</p>';
        history.innerHTML = '<li class="muted">История не загружена.</li>'; throw error;
      }
    };
    const productOptions = selected => {
      const options = new Map((snapshot?.productOptions || []).map(row => [row.id, row.name]));
      for (const row of snapshot?.currentRevision?.mappings || []) if (!options.has(row.productId)) options.set(row.productId, `${row.productName} (сохранён в истории)`);
      if (selected && !options.has(selected)) options.set(selected, `Товар ${selected} (сохранён в истории)`);
      return `<option value="">Выберите товар</option>${[...options].map(([id,name]) => `<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}`;
    };
    const renderRows = () => {
      rows.innerHTML = editRows.map((row,index) => `<div data-department-row data-index="${index}" data-retro="${mode === 'retro'}"><label>Товар <span class="required-mark">*</span><select data-map-product required>${productOptions(row.productId)}</select></label><label>Код подразделения <span class="required-mark">*</span><input data-map-code maxlength="64" required value="${escapeHtml(row.departmentCode)}" placeholder="Например: bar"></label><label>Название подразделения <span class="required-mark">*</span><input data-map-name maxlength="160" required value="${escapeHtml(row.departmentName)}" placeholder="Например: Бар"></label>${mode === 'retro' ? `<label>С даты <input type="date" data-map-from required value="${escapeHtml(row.effectiveFrom || '')}"></label><label>По дату <input type="date" data-map-to value="${escapeHtml(row.effectiveTo || '')}"></label>` : ''}<button type="button" class="button small" data-map-remove aria-label="Удалить товар ${index + 1}">Удалить</button></div>`).join('');
      emptyRow.hidden = editRows.length > 0;
    };
    const openEditor = retro => {
      if (snapshot?.productOptionsTruncated) { report(status,'Редактирование отключено: список товаров неполный. Нужен поиск/постраничная загрузка каталога.',true); return; }
      if (!snapshot?.currentRevision && retro) { report(editorMessage,'Сначала создайте обычную версию, затем корректируйте историю.',true); editor.hidden = false; return; }
      mode = retro ? 'retro' : 'normal';
      editRows = retro ? (snapshot.currentRevision.mappings || []).map(row => ({ productId:row.productId, departmentCode:row.departmentCode, departmentName:row.departmentName, effectiveFrom:row.effectiveFrom, effectiveTo:row.effectiveTo || '' }))
        : (snapshot.currentAssignments || []).map(row => ({ ...row }));
      if (!editRows.length && !retro) editRows = [{ productId:'', departmentCode:'', departmentName:'' }];
      section.querySelector('[data-department-editor-caption]').textContent = retro
        ? 'Создаётся новая историческая версия. Укажите интервалы полностью; прежние версии останутся неизменными.'
        : `Полностью задайте назначения, действующие с ${snapshot.nextEffectiveFrom}. Не включайте удалённые назначения.`;
      section.querySelector('[data-department-retro-date-row]').hidden = !retro;
      section.querySelector('[data-department-retro-reason-row]').hidden = !retro;
      section.querySelector('[data-department-attestation-row]').hidden = !retro;
      section.querySelector('[data-department-retro-date]').value = '';
      section.querySelector('[data-department-retro-reason]').value = '';
      section.querySelector('[data-department-attestation]').checked = false;
      section.querySelector('[data-department-reason]').value = '';
      section.querySelector('[data-department-empty]').checked = false;
      report(editorMessage,''); renderRows(); editor.hidden = false; editor.scrollIntoView({block:'nearest',behavior:'smooth'});
    };
    section.querySelector('[data-department-edit]').addEventListener('click',() => openEditor(false));
    section.querySelector('[data-department-retro]').addEventListener('click',() => openEditor(true));
    section.querySelector('[data-department-reload]').addEventListener('click',() => refresh().catch(() => {}));
    section.querySelector('[data-department-cancel]').addEventListener('click',() => { editor.hidden = true; });
    section.querySelector('[data-department-add]').addEventListener('click',() => { editRows.push({productId:'',departmentCode:'',departmentName:'',effectiveFrom:'',effectiveTo:''}); renderRows(); });
    rows.addEventListener('click',event => {
      if (!event.target.closest('[data-map-remove]')) return;
      const index = Number(event.target.closest('[data-department-row]')?.dataset.index);
      if (Number.isInteger(index)) { editRows.splice(index,1); renderRows(); }
    });
    editor.addEventListener('submit',async event => {
      event.preventDefault(); if (saving || !editor.reportValidity() || !snapshot) return;
      if (snapshot.productOptionsTruncated) { report(editorMessage,'Сохранение отключено: список товаров неполный.',true); return; }
      const mappings = [...rows.querySelectorAll('[data-department-row]')].map(row => ({
        productId:row.querySelector('[data-map-product]').value,
        departmentCode:row.querySelector('[data-map-code]').value.trim().toLowerCase(),
        departmentName:row.querySelector('[data-map-name]').value.trim(),
        ...(mode === 'retro' ? {productName:snapshot.currentRevision?.mappings?.find(item => item.productId === row.querySelector('[data-map-product]').value)?.productName || '',
          effectiveFrom:row.querySelector('[data-map-from]').value,effectiveTo:row.querySelector('[data-map-to]').value || null} : {})
      }));
      if (!mappings.length && !section.querySelector('[data-department-empty]').checked) { report(editorMessage,'Подтвердите пустую версию либо добавьте назначения.',true); return; }
      if (mappings.some(row => !row.productId || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.departmentCode) || !row.departmentName
        || (mode === 'retro' && (!row.productName || !row.effectiveFrom || (row.effectiveTo && row.effectiveTo < row.effectiveFrom))))) {
        report(editorMessage,'Проверьте товар, код и название подразделения, а также даты исторических интервалов.',true); return;
      }
      if (mode === 'retro' && !section.querySelector('[data-department-attestation]').checked) { report(editorMessage,'Для исторической версии требуется отдельное подтверждение.',true); return; }
      const base = {expectedRevisionId:snapshot.currentRevision?.id || null,reason:section.querySelector('[data-department-reason]').value.trim(),mappings};
      const retroFrom = section.querySelector('[data-department-retro-date]').value;
      const retroReason = section.querySelector('[data-department-retro-reason]').value.trim();
      if (mode === 'retro' && (!retroFrom || retroReason.length < 8)) { report(editorMessage,'Укажите историческую дату и отдельное объяснение не короче 8 символов.',true); return; }
      if (mode === 'retro') Object.assign(base,{effectiveFrom:retroFrom,retroactiveReason:retroReason,ownerAttestation:{confirmed:true,action:'retroactive_payroll_product_department_mapping'}});
      if (base.reason.length < 8) { report(editorMessage,'Укажите причину изменения не короче 8 символов.',true); return; }
      const fingerprint = JSON.stringify({mode,...base});
      if (fingerprint !== lastRequest) { lastRequest=fingerprint; idempotencyKey=`payroll-departments:${globalThis.crypto?.randomUUID?.() || Date.now()}`; }
      const payload = {...base,idempotencyKey};
      saving=true; const save=section.querySelector('[data-department-save]'); save.disabled=true; report(editorMessage,'Сохраняем неизменяемую версию…');
      try {
        const result=await request(mode === 'retro' ? '/api/payroll/product-department-mappings/retroactive-revisions' : '/api/payroll/product-department-mappings/revisions',
          {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        report(editorMessage,`Версия ${Number(result.revisionNo)} сохранена. Проверяем чтение из базы…`);
        await refresh();
        const persisted = snapshot?.currentRevision?.id === result.id;
        if (!persisted) throw new Error('payroll_product_department_readback_mismatch');
        editor.hidden=true; lastRequest=''; idempotencyKey=''; report(status,`Версия ${Number(result.revisionNo)} сохранена и повторно загружена.`);
      } catch(error) { report(editorMessage,safeError(error),true); }
      finally { saving=false; save.disabled=false; }
    });
    history.addEventListener('click',async event => {
      const button=event.target.closest('[data-department-inspect]'); if (!button) return;
      try {
        const revision=await request(`/api/payroll/product-department-mappings/revisions/${encodeURIComponent(button.dataset.departmentInspect)}`);
        const details=section.querySelector('[data-department-inspected-details]');
        section.querySelector('[data-department-inspected-title]').textContent=`Снимок версии ${Number(revision.revisionNo)} · действует с ${revision.effectiveFrom}`;
        section.querySelector('[data-department-inspected]').innerHTML=revision.mappings?.length
          ? `<ul>${revision.mappings.map(row=>`<li>${escapeHtml(row.productName)} — ${escapeHtml(row.departmentName)} (${escapeHtml(row.departmentCode)}), ${escapeHtml(row.effectiveFrom)} — ${escapeHtml(row.effectiveTo || 'без окончания')}</li>`).join('')}</ul>`
          : '<p class="empty">В этой версии назначений нет.</p>';
        details.hidden=false; details.open=true;
      } catch(error) { report(status,safeError(error),true); }
    });
    refresh().catch(() => {});
    return section;
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
    return { periodFrom: today, periodTo: today, coverage: { kind: 'month_to_date_complete', from: `${today.slice(0, 7)}-01`, through: today, complete: true, watermark: 'manual-scenario' }, attendanceCoverage: { kind: 'approved_attendance_complete', from: `${today.slice(0, 7)}-01`, through: today, complete: true, watermark: 'manual-attendance-scenario' }, monthClosed: false, employees: [], attendance: [], sales: [] };
  };
  const validatePreview = (input) => {
    if (!input || !Array.isArray(input.employees) || !Array.isArray(input.sales) || !Array.isArray(input.attendance)) throw new Error('В сценарии нужны списки сотрудников, продаж и смен.');
    if (input.employees.length > MAX_PREVIEW_EMPLOYEES || input.sales.length > MAX_PREVIEW_SALES || input.attendance.length > MAX_PREVIEW_ATTENDANCE) throw new Error(`Ограничение сценария: до ${MAX_PREVIEW_EMPLOYEES} сотрудников, ${MAX_PREVIEW_SALES} строк продаж и ${MAX_PREVIEW_ATTENDANCE} строк смен.`);
    return input;
  };
  const money = (value, currency = 'RUB') => {
    if (!Number.isSafeInteger(value)) return '—';
    try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, minimumFractionDigits: 2 }).format(value / 100); }
    catch (_) { return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2 }).format(value / 100)} ${escapeHtml(currency)}`; }
  };
  const blockerLabels = {
    margin_cost_snapshot_required: 'Для строки расчёта от маржи нужен снимок полной себестоимости с ID, версией и валютой.',
    invalid_margin_cost_snapshot: 'Снимок себестоимости содержит некорректную сумму, версию или валюту.',
    margin_cost_currency_mismatch: 'Валюта снимка себестоимости отличается от валюты схемы.',
    invalid_margin_loss_policy: 'Для маржи требуется правило зачёта дневных убытков offset_daily_losses.',
    invalid_margin_item_rule_basis: 'Для позиционных ставок в маржинальной схеме явно укажите базу net_revenue.',
    conflicting_team_pool: 'Общие параметры одного командного фонда различаются у участников.',
    positive_team_fund_requires_weight: 'В командном фонде есть сумма, но нет участников с положительными минутами или весами.',
    invalid_team_weight: 'Проверьте вес сотрудника в командном фонде: нужен целый неотрицательный вес.',
    duplicate_employee_id: 'В составе сценария один сотрудник указан несколько раз.',
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
    attendance_coverage_manifest_required: 'Не подтверждена полнота утверждённой посещаемости за период.',
    invalid_attendance_row: 'Смена отсутствует, не утверждена или содержит неверные фактические/плановые минуты.',
    attendance_outside_employee_active_period: 'Смена попала за кадровые даты работы сотрудника.',
    attendance_employee_unassigned: 'Для смены сотрудника нет назначения роли на эту дату.',
    sales_outside_employee_active_period: 'Строка продажи попала за кадровые даты работы сотрудника.',
    overlapping_employee_override: 'У одного сотрудника пересекаются периоды одного параметра оплаты.',
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
  const sourcePreviewErrorLabels = {
    invalid_payroll_venue_turnover_period: 'Укажите корректный период с начала одного месяца по выбранную дату.',
    payroll_venue_turnover_owner_or_venue_unavailable: 'Не удалось подтвердить владельца или площадку. Обновите вход в систему и повторите.',
    payroll_venue_turnover_closed_at_missing: 'В закрытых заказах площадки есть записи без времени закрытия; сначала разберите эти исходные данные.',
    payroll_venue_turnover_out_of_range: 'Сумма оборота выходит за пределы безопасного расчёта.',
    payroll_venue_turnover_source_incomplete: 'Источник не вернул полный ряд дат. Повторите запрос позже.',
    payroll_venue_turnover_owner_required: 'Предварительный расчёт оборота доступен только владельцу площадки.'
  };
  const approvedAttendancePreviewErrorLabels = {
    payroll_preview_attendance_approval_required: 'Сначала проверьте и утвердите табель за этот период.',
    payroll_preview_attendance_approval_stale: 'Табель изменился после утверждения. Проверьте и утвердите новую ревизию.',
    payroll_preview_attendance_source_incomplete: 'Исходный табель неполный. Исправьте причины блокировки перед сценарием.'
  };
  const attendanceErrorLabels = {
    invalid_payroll_attendance_period: 'Выберите корректный период внутри одного месяца.',
    payroll_attendance_reason_required: 'Укажите причину и основание утверждения табеля.',
    payroll_attendance_source_changed: 'Исходный табель изменился. Обновите данные и проверьте их заново.',
    payroll_attendance_source_incomplete: 'Есть интервалы или плановые смены, которые нужно исправить перед утверждением.',
    payroll_attendance_idempotency_conflict: 'Ключ запроса уже использован для другого периода или содержимого.',
    payroll_attendance_snapshot_incomplete: 'Снимок сохранился не полностью. Обновите период и проверьте источник.',
    payroll_attendance_source_unavailable: 'Не удалось прочитать исходный табель.',
    payroll_attendance_function_context_schema_required: 'Для табеля требуется обновление локальной базы данных.',
    payroll_attendance_approval_unavailable: 'Не удалось сохранить утверждение табеля.',
    payroll_attendance_owner_or_venue_unavailable: 'Площадка или владелец недоступны. Обновите страницу и повторите.',
    payroll_attendance_venue_timezone_invalid: 'У площадки не настроен корректный часовой пояс.'
  };
  const payrollSaveErrorLabels = {
    invalid_personal_parameters: 'Личные параметры неполны для части периода. Проверьте обязательные поля выбранного режима и даты настроек.',
    payroll_milestone_eligibility_schema_required: 'Для сохранения условия премии требуется обновление зарплатного хранилища. Настройка не сохранена.',
    payroll_personal_department_schema_required: 'Для сохранения личного цеха требуется обновление зарплатного хранилища. Настройка не сохранена.',
    invalid_personal_cap: 'Личный лимит неполон для части периода. Задайте процент и базу лимита; для базы по цеху укажите цех лимита или цех сотрудника, лично либо по роли.',
    milestone_cap_policy_required: 'Выберите, включать пороговые премии в лимит или начислять их отдельно.',
    payroll_personal_target_schema_required: 'Сохранение новой зарплатной схемы требует обновления структуры базы данных. Настройки не сохранены.',
    payroll_risk_acknowledgement_required: 'Перед сохранением версии подтвердите, что поняли риск блокировки официального расчёта. Это подтверждение не разрешает выплату выше личной выручки.',
    payroll_personal_cap_increase_acknowledgement_required: 'Отдельно подтвердите повышение личного лимита выше роли. После изменения параметров подтверждение требуется заново.'
  };
  const attendanceReasonLabels = {
    payroll_attendance_scheduled_function_missing: 'Не удалось подтвердить рабочую функцию из календаря.',
    payroll_attendance_employee_identity_missing: 'У сотрудника не указано имя.',
    payroll_attendance_planned_shift_invalid: 'В расписании есть смена без корректных плановых начала/окончания.',
    payroll_attendance_open_or_invalid_work_interval: 'Есть незакрытый или некорректный рабочий интервал.',
    payroll_attendance_work_interval_without_schedule: 'Есть рабочий интервал без плановой смены.',
    payroll_attendance_work_interval_shift_ambiguous: 'Рабочий интервал пересекает несколько плановых смен.',
    payroll_attendance_work_interval_outside_schedule: 'Рабочий интервал выходит за плановую смену; проверьте часы до подтверждения.',
    payroll_attendance_worked_minutes_invalid: 'Фактическое время превышает план или содержит ошибочные значения.',
    payroll_attendance_no_planned_shifts: 'В периоде нет плановых смен: пустое покрытие нельзя утвердить как полный табель.'
  };
  const renderBlockers = (result) => result.status === 'blocked'
    ? `<div class="warning-message"><strong>Расчёт заблокирован</strong><ul>${(result.blockers || []).map((code) => `<li title="${escapeHtml(code)}">${escapeHtml(blockerLabels[code] || `Проверьте входные данные (${code}).`)}</li>`).join('')}</ul></div>`
    : '';
  const renderCriticalErrors = (result, employeeNames, currency) => (result.criticalErrors || []).length
    ? `<div class="warning-message" role="alert"><strong>Критическая проверка сценария: сумма выше приписанного сотруднику оборота</strong><ul>${result.criticalErrors.map((error) => `<li>${escapeHtml(employeeNames.get(error.employeeId) || error.employeeId)} · ${escapeHtml(error.date)}: выплата ${money(error.payoutCents, currency)} выше оборота ${money(error.personalRevenueCents, currency)} на ${money(error.excessCents, currency)}. Сумма не урезана автоматически. Источник личной чистой выручки ещё требует подтверждения.</li>`).join('')}</ul></div>`
    : '';
  const renderDetails = (result, employeeNames, baselineResult = null, renderBudget = { employeeDays: MAX_RENDERED_EMPLOYEE_DAYS, lines: MAX_RENDERED_LINES }) => {
    const currency = result.currency || 'RUB';
    const renderMilestoneDecisions = day => {
      if (!Object.hasOwn(day, 'milestoneDecisions')) return '';
      if (!Array.isArray(day.milestoneDecisions)) return '<p class="warning-message">Некорректные решения по порогам.</p>';
      renderBudget.milestoneDecisions ??= MAX_RENDERED_EMPLOYEE_DAYS;
      renderBudget.milestoneShiftIds ??= MAX_RENDERED_EMPLOYEE_DAYS;
      const shown = day.milestoneDecisions.slice(0, renderBudget.milestoneDecisions);
      renderBudget.milestoneDecisions -= shown.length;
      const policies = { all_active: 'Все активные сотрудники', worked_on_threshold_day: 'Работавшие в день порога' };
      const reasons = { eligible: 'Премия разрешена', milestones_disabled: 'Премии отключены', employee_inactive: 'Сотрудник неактивен', no_approved_positive_work_on_threshold_day: 'Нет утверждённой работы в день порога' };
      const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
      const identity = value => typeof value === 'string' && value.trim().length > 0;
      const rows = shown.map(row => {
        const shapeValid = row && typeof row === 'object' && identity(row.employeeId) && identity(row.roleId)
          && row.date === day.date && Object.hasOwn(policies, row.eligibility) && Object.hasOwn(reasons, row.reason)
          && ['applyMilestones', 'employeeActive', 'eligible'].every(key => typeof row[key] === 'boolean')
          && ['thresholdCents', 'declaredBonusCents', 'previousTurnoverCents', 'cumulativeTurnoverCents', 'approvedWorkedMinutes', 'awardedAmountCents'].every(key => nonnegative(row[key]))
          && row.thresholdCents > 0 && row.declaredBonusCents > 0
          && nonnegative(day.venueTurnoverCents) && nonnegative(day.cumulativeVenueTurnoverCents)
          && row.cumulativeTurnoverCents === day.cumulativeVenueTurnoverCents
          && row.previousTurnoverCents === day.cumulativeVenueTurnoverCents - day.venueTurnoverCents
          && row.previousTurnoverCents < row.thresholdCents && row.thresholdCents <= row.cumulativeTurnoverCents
          && Array.isArray(row.qualifyingShiftIds) && row.qualifyingShiftIds.every(identity)
          && new Set(row.qualifyingShiftIds).size === row.qualifyingShiftIds.length
          && (row.approvedWorkedMinutes > 0) === (row.qualifyingShiftIds.length > 0);
        const eligible = shapeValid && row.applyMilestones && row.employeeActive
          && (row.eligibility === 'all_active' || row.approvedWorkedMinutes > 0);
        const reason = !shapeValid ? null : !row.applyMilestones ? 'milestones_disabled' : !row.employeeActive ? 'employee_inactive'
          : !eligible ? 'no_approved_positive_work_on_threshold_day' : 'eligible';
        if (!shapeValid || row.eligible !== eligible || row.reason !== reason
            || row.awardedAmountCents !== (eligible ? row.declaredBonusCents : 0)) return '<li class="warning-message">Некорректное решение по порогу.</li>';
        const shifts = row.qualifyingShiftIds.slice(0, renderBudget.milestoneShiftIds);
        renderBudget.milestoneShiftIds -= shifts.length;
        const hiddenShifts = row.qualifyingShiftIds.length - shifts.length;
        return `<li data-milestone-decision-row><strong>${escapeHtml(employeeNames.get(row.employeeId) || row.employeeId)}</strong> · ${escapeHtml(editorRoleLabel(row.roleId))} · ${escapeHtml(row.date)}<p>Порог ${money(row.thresholdCents, currency)} · оборот до пересечения ${money(row.previousTurnoverCents, currency)} → ${money(row.cumulativeTurnoverCents, currency)}</p><p>${escapeHtml(policies[row.eligibility])} · ${escapeHtml(reasons[row.reason])} · заявленная премия ${money(row.declaredBonusCents, currency)} · премия сценария до лимитов ${money(row.awardedAmountCents, currency)}</p><p>Утверждённые минуты сценария: ${escapeHtml(row.approvedWorkedMinutes)} · смены: ${shifts.length ? shifts.map(escapeHtml).join(', ') : 'нет'}${hiddenShifts ? ` · Скрыто ${hiddenShifts} ссылок на смены` : ''}</p></li>`;
      }).join('');
      const hidden = day.milestoneDecisions.length - shown.length;
      return `<section data-milestone-decisions><h4>Решения о пороговых премиях</h4><p class="muted">Сценарные суммы до применения лимитов. Источник посещаемости и право на выплату этим объяснением не подтверждены.</p>${rows ? `<ul>${rows}</ul>` : '<p>Нет решений по порогам в пределах отображения.</p>'}${hidden ? `<p>Скрыто ${hidden} решений по общему лимиту отображения.</p>` : ''}</section>`;
    };
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
        const target = row.targetIncentive;
        const margin = row.marginIncentive;
        const marginDetail = margin?.status === 'blocked' ? `<small>Маржа: ${escapeHtml(blockerLabels[margin.blocker] || margin.blocker || 'расчёт заблокирован')}</small>`
          : margin ? `<small>Маржа за день ${money(margin.signedMarginCents, currency)} · зачтённые убытки ${money(margin.lossOffsetCents, currency)} · маржа для ставки ${money(margin.payableMarginCents, currency)} · ориентир ${money(margin.targetCents, currency)} · базовая часть ${money(margin.baseCommissionCents, currency)} · часть сверх ориентира ${money(margin.excessCommissionCents, currency)}</small>` : '';
        const targetDetail = target?.status === 'blocked' ? `<small>Личный дневной план: ${escapeHtml(blockerLabels[target.blocker] || target.blocker || 'расчёт заблокирован')}</small>`
          : target ? `<small>Личный дневной план ${money(target.targetCents, currency)} · комиссионная база ${money(target.basisCents, currency)} · сверх плана ${money(target.excessCents, currency)} · ${target.excessRatePolicy === 'add_to_base' ? 'повышенная ставка добавляется к базовой' : 'повышенная ставка заменяет базовую сверх плана'} · базовая часть ${money(target.baseCommissionCents, currency)} · часть сверх плана ${money(target.excessCommissionCents, currency)}</small>` : '';
        const fundDetail = Number.isSafeInteger(row.teamFundCents) && row.mode === 'team_fund' ? `<small>Доля командного фонда до лимитов: ${money(row.teamFundCents, currency)}</small>` : '';
        return `<tr><td>${escapeHtml(employeeNames.get(row.employeeId) || row.employeeId)}</td><td>${escapeHtml(editorRoleLabel(row.roleId || ''))}</td><td>${money(row.basePayCents, currency)}</td><td>${money(row.commissionCents, currency)}${targetDetail}${marginDetail}</td><td>${money(row.milestoneBonusCents, currency)}</td><td>${money(row.capCents, currency)}</td><td>${money(row.capReductionCents, currency)}</td><td><strong>${money(row.amountCents, currency)}</strong>${fundDetail}</td>${baselineCells}</tr>`;
      }).join('');
      const shifts = employeeShown.flatMap((row) => (row.shiftDetails || []).map((shift) => `<tr><td>${escapeHtml(employeeNames.get(row.employeeId) || row.employeeId)}</td><td>${escapeHtml(shift.shiftId)}</td><td>${escapeHtml(shift.workedMinutes)} / ${escapeHtml(shift.plannedMinutes)} мин</td><td>${money(shift.amountCents, currency)}</td></tr>`)).join('');
      const lineSource = day.lines || [];
      const lineShown = lineSource.slice(0, renderBudget.lines);
      renderBudget.lines -= lineShown.length;
      const lines = lineShown.map((line) => {
        const allocation = line.targetAllocation;
        const rateLabel = allocation ? `Дневной план: до ${money(allocation.belowTargetCents, currency)}, сверх ${money(allocation.excessCents, currency)}`
          : line.marginAllocation ? `Маржа после зачёта убытков: ${money(line.marginAllocation.payableMarginCents, currency)}`
          : line.teamFundSource?.included ? 'Вклад в общий фонд; доля сотрудника показана отдельно'
          : Number.isInteger(line.appliedRateBps) ? `${(line.appliedRateBps / 100).toLocaleString('ru-RU')}%` : '—';
        const costDetail = line.costSnapshot ? `<small>Себестоимость ${money(line.costSnapshot.costCents, currency)} · маржа строки ${money(line.signedMarginCents, currency)} · снимок ${escapeHtml(line.costSnapshot.id)} / ${escapeHtml(line.costSnapshot.version)}${line.marginPoolExcluded ? ' · строка исключена из маржинального плана позиционной ставкой от выручки' : ''}</small>` : '';
        return `<tr><td>${escapeHtml(line.lineId)}</td><td>${escapeHtml(employeeNames.get(line.employeeId) || line.employeeId)}</td><td>${escapeHtml(line.menuItemId || '—')}</td><td>${escapeHtml(editorDepartmentLabel(line.department))}</td><td>${money(line.commissionBaseCents, currency)}${costDetail}</td><td>${escapeHtml(rateLabel)}</td><td>${money(line.commissionCents, currency)}</td></tr>`;
      }).join('');
      const omittedEmployees = employeeSource.length - employeeShown.length;
      const omittedLines = lineSource.length - lineShown.length;
      renderBudget.poolAllocations ??= MAX_RENDERED_EMPLOYEE_DAYS;
      const pools = (day.teamFunds || []).map((pool) => {
        if (pool.status === 'blocked') return `<p class="warning-message">Командный фонд ${escapeHtml(pool.poolId)}: ${escapeHtml(blockerLabels[pool.blocker] || pool.blocker)}</p>`;
        const allocations = (pool.allocations || []).slice(0, renderBudget.poolAllocations);
        renderBudget.poolAllocations -= allocations.length;
        const hidden = (pool.allocations || []).length - allocations.length;
        return `<section><h4>Командный фонд ${escapeHtml(pool.poolId)}</h4><p>Комиссионная база ${money(pool.basisCents, currency)} · дневной ориентир ${money(pool.targetCents, currency)} · фонд до лимитов ${money(pool.fundCents, currency)} · ${pool.distributionPolicy === 'approved_minutes' ? 'по утверждённым минутам' : 'по настроенным весам независимо от выхода'} · ${pool.excessRatePolicy === 'add_to_base' ? 'повышенная ставка добавляется к базовой' : 'повышенная ставка заменяет базовую сверх плана'}. Лимиты сотрудников не перераспределяют остаток фонда.</p><ul>${allocations.map((allocation) => `<li>${escapeHtml(employeeNames.get(allocation.id) || allocation.id)} · вес ${escapeHtml(allocation.weight)} · доля ${money(allocation.amountCents, currency)}</li>`).join('')}</ul>${hidden ? `<p class="muted">Скрыто ${hidden} долей из-за лимита детализации. Общий фонд рассчитан полностью.</p>` : ''}</section>`;
      }).join('');
      const omitted = pools + (omittedEmployees || omittedLines ? `<p class="muted">Детализация ограничена: скрыто ${omittedEmployees} дневных строк сотрудников и ${omittedLines} строк продаж. Общие суммы выше рассчитаны полностью.</p>` : '');
      return `<details class="finance-scheme-day"><summary>${escapeHtml(day.date)} · выручка ${money(day.venueTurnoverCents, currency)} · накопительно ${money(day.cumulativeVenueTurnoverCents, currency)}</summary><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Сотрудник</th><th>Роль</th><th>Оклад</th><th>Комиссия</th><th>Премия</th><th>Лимит</th><th>Срезано</th><th>Итого</th>${baselineResult ? '<th>База</th><th>Δ к базе</th>' : ''}</tr></thead><tbody>${employeeRows || `<tr><td colspan="${baselineResult ? 10 : 8}">Нет начислений за день</td></tr>`}</tbody></table></div>${renderMilestoneDecisions(day)}<h4>Утверждённые смены</h4><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Сотрудник</th><th>ID смены</th><th>Факт / план</th><th>Начислено</th></tr></thead><tbody>${shifts || '<tr><td colspan="4">Подтверждённые смены отсутствуют.</td></tr>'}</tbody></table></div><h4>Строки продаж и комиссия</h4><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>ID строки</th><th>Сотрудник</th><th>Позиция</th><th>Цех</th><th>База комиссии</th><th>Ставка</th><th>Комиссия</th></tr></thead><tbody>${lines || '<tr><td colspan="7">Детализация отсутствует или ограничена общим лимитом отображения.</td></tr>'}</tbody></table></div>${omitted}</details>`;
    }).join('');
    return `${renderBlockers(result)}${renderCriticalErrors(result, employeeNames, currency)}<p><strong>${escapeHtml(result.periodFrom)} — ${escapeHtml(result.periodTo)} · ${escapeHtml(editorStatusLabel(result.status))}</strong> · месячная база ${money(result.monthTurnoverCents, currency)}</p><p class="muted">Сценарная проверка по приписанному обороту сотрудника; это не официальный payroll-run и не подтверждение права на выплату.</p><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Сотрудник</th><th>Смены</th><th>Приписанный оборот</th><th>Оклад</th><th>Комиссия</th><th>Премии</th><th>Уменьшено лимитом</th><th>Итого</th></tr></thead><tbody>${(result.employees || []).map((row) => `<tr><td>${escapeHtml(employeeNames.get(row.employeeId) || row.employeeId)}</td><td>${escapeHtml(row.shifts)}</td><td>${money(row.personalRevenueCents, currency)}</td><td>${money(row.basePayCents, currency)}</td><td>${money(row.commissionCents, currency)}</td><td>${money(row.milestoneBonusCents, currency)}</td><td>${money(row.capReductionCents, currency)}</td><td><strong>${money(row.amountCents, currency)}</strong>${row.teamFundCents ? `<small>Командный фонд за период до лимитов: ${money(row.teamFundCents, currency)}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="8">Нет сотрудников в расчёте</td></tr>'}</tbody></table></div><h4>Детализация по дню и чеку</h4>${daily || '<p class="empty">Нет дневных данных.</p>'}`;
  };
  const renderPreview = (payload, previewInput) => {
    const names = new Map((previewInput.employees || []).filter((employee) => employee && typeof employee === 'object').map((employee) => [employee.id, employee.name || employee.fullName || editorEmployeeLabel(employee.id)]));
    const policyNotice = payload.result?.sourcePolicyEvaluation?.state === 'selected_not_applied'
      ? '<div class="warning-message" role="note" data-source-policy-preview-notice><strong>Выбранные правила источников ещё не применены</strong><p>Расчёт использует входные данные сценария. Источники и выполнение выбранных правил ещё не подтверждены. Результат не является официальным начислением и не сохраняется.</p></div>' : '';
    return `${policyNotice}${renderDetails(payload.result || {}, names)}`;
  };
  const renderVenueTurnoverPreview = (payload, previewInput) => {
    const source = payload.sourceVenueTurnover || {};
    const currency = payload.result?.currency || payload.scheme?.currency || 'RUB';
    const dailyRows = (Array.isArray(source.venueDailyTurnover) ? source.venueDailyTurnover : []).map((row) =>
      `<tr><td>${escapeHtml(row.date)}</td><td>${money(row.turnoverCents, currency)}</td></tr>`).join('');
    const watermark = typeof source.sourceWatermark === 'string' ? source.sourceWatermark.slice(0, 12) : '';
    const notice = `<div class="warning-message" role="note"><strong>Предварительный сценарий, не официальный расчёт зарплаты</strong><p>Дневной оборот площадки получен из закрытых заказов за ${escapeHtml(source.from || '')} — ${escapeHtml(source.through || '')} (${escapeHtml(source.venueTimezone || 'часовой пояс площадки')}) по final_total_snapshot либо тому же legacy fallback, что использует финансовая модель: сохранённые строки и одобренные скидки. Legacy fallback применён к заказам: ${escapeHtml(source.financeFallbackOrderCount ?? 0)}. Сотрудники, авторство строк, база комиссии после скидок и возвратов и посещаемость остаются данными сценария. Результат не сохранён и не создаёт расчётный run, начисление или расход. Watermark ${escapeHtml(watermark || 'не указан')} служит только для обнаружения изменений preview и не подтверждает сверку источников.</p></div>`;
    const turnover = `<h4>Оборот площадки из закрытых чеков</h4><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Дата заведения</th><th>Оборот</th></tr></thead><tbody>${dailyRows || '<tr><td colspan="2">Нет дневных данных.</td></tr>'}</tbody></table></div>`;
    return `${notice}${turnover}${renderPreview(payload, previewInput)}`;
  };
  const renderApprovedAttendancePreview = (payload, previewInput) => {
    const source = payload.sourceAttendanceApproval || {};
    const watermark = typeof source.sourceWatermark === 'string' ? source.sourceWatermark.slice(0, 12) : '';
    const notice = `<div class="warning-message" role="note"><strong>Сценарий с утверждённой посещаемостью, не официальный расчёт</strong><p>Использована payroll-ревизия ${escapeHtml(source.revision ?? '—')} за ${escapeHtml(source.periodFrom || '')} — ${escapeHtml(source.periodTo || '')}; расчётная часть периода ${escapeHtml(previewInput.periodFrom || '')} — ${escapeHtml(previewInput.periodTo || '')}. Утверждённая ревизия подтверждена ${escapeHtml(source.approvedByName || 'владельцем')}. Watermark ${escapeHtml(watermark || '—')}. Данные продаж, авторство строк, скидки/возвраты и оборот остаются входными данными сценария. Результат не сохраняется, начисления и расходы не создаются.</p></div>`;
    const context = Array.isArray(payload.attendanceContext) ? payload.attendanceContext : [];
    const functions = context.slice(0, 500).map((shift) => `<tr><td>${escapeHtml(shift.date)}</td><td>${escapeHtml(shift.employeeName || editorEmployeeLabel(shift.employeeId))}</td><td>${escapeHtml(shift.scheduledFunctionName || 'Не назначена')}</td></tr>`).join('');
    const contextTable = `<section data-payroll-attendance-context><h4>Назначение по календарю</h4><p class="muted">Это сохранённая рабочая функция расписания. Она не определяет POS-цех/станцию и не подтверждает продажи.</p><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Дата</th><th>Сотрудник</th><th>Функция по расписанию</th></tr></thead><tbody>${functions || '<tr><td colspan="3">Нет строк календарного контекста.</td></tr>'}</tbody></table></div>${context.length > 500 ? `<p class="muted">Показано 500 из ${context.length} смен.</p>` : ''}</section>`;
    return `${notice}${contextTable}${renderPreview(payload, previewInput)}`;
  };
  const renderComparison = (payload, previewInput) => {
    const names = new Map((previewInput.employees || []).filter((employee) => employee && typeof employee === 'object').map((employee) => [employee.id, employee.name || employee.fullName || editorEmployeeLabel(employee.id)]));
    const baseline = (payload.results || []).find((entry) => entry.scheme.versionId === payload.baselineVersionId)?.result;
    const currency = payload.currency || payload.results?.[0]?.result?.currency || 'RUB';
    const summaryByVersion = new Map((payload.comparisons || []).map((item) => [item.versionId, item]));
    const summaries = (payload.results || []).map((entry) => { const item = summaryByVersion.get(entry.scheme.versionId) || {}; return `<tr><td>${escapeHtml(entry.scheme.name)}</td><td>${escapeHtml(entry.scheme.versionNo)}</td><td>${escapeHtml(item.status || entry.result.status)}</td><td>${money(item.totalCents, currency)}</td><td>${money(item.deltaToBaselineCents, currency)}</td></tr>`; }).join('');
    const versions = (payload.results || []).map((entry) => {
      const renderBudget = { employeeDays: MAX_COMPARE_EMPLOYEE_DAYS, lines: MAX_COMPARE_LINES };
      return `<details class="finance-scheme-version"><summary>${escapeHtml(entry.scheme.name)} · версия ${escapeHtml(entry.scheme.versionNo)} · ${escapeHtml(editorStatusLabel(entry.result.status))}</summary>${renderDetails(entry.result, names, entry.scheme.versionId === payload.baselineVersionId ? null : baseline, renderBudget)}</details>`;
    }).join('');
    return `<p>Сравнение использует один входной сценарий для всех версий. Валюта: ${escapeHtml(currency)}.</p><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Схема</th><th>Версия</th><th>Статус</th><th>Итого</th><th>Δ к базовой версии</th></tr></thead><tbody>${summaries}</tbody></table></div>${versions}`;
  };

  const readinessLabels = {
    sourcePolicies: 'Правила владельца', approvedAttendance: 'Утверждённый табель', orderObservations: 'Наблюдения заказов',
    refundObservations: 'Зарегистрированные возвраты', canonicalLinePricing: 'Неизменяемые цены строк', payrollSaleCredit: 'Приписывание продаж сотрудникам',
    itemReturnEvidence: 'Проверка возвратов по строкам товаров',
    recognitionManifest: 'Признанные продажи и возвраты (манифест)',
    recognizedLineRefunds: 'Признанные возвраты по строкам', fullEmployeeNetRevenue: 'Чистая стоимость товаров по сотрудникам',
    employeeEligibility: 'Допуск сотрудников к расчёту', employeeRoleCoverage: 'Покрытие сотрудников назначениями ролей',
    immutableDepartmentAttribution: 'Подразделения строк продаж',
    marginCosts: 'Неизменяемая себестоимость', departmentShiftAllocation: 'Распределение по цеху и смене'
  };
  const readinessGroups = [
    { label: 'Настройки и сотрудники', keys: ['sourcePolicies', 'employeeEligibility', 'employeeRoleCoverage'] },
    { label: 'Классификация продаж', keys: ['immutableDepartmentAttribution'] },
    { label: 'Табель и распределение по сменам', keys: ['approvedAttendance', 'departmentShiftAllocation'] },
    { label: 'Продажи, цены и возвраты', keys: ['orderObservations', 'canonicalLinePricing', 'payrollSaleCredit', 'itemReturnEvidence',
      'refundObservations', 'recognitionManifest', 'recognizedLineRefunds', 'fullEmployeeNetRevenue'] },
    { label: 'Себестоимость', keys: ['marginCosts'] }
  ];
  const readinessMetrics = {
    approvedAttendance: { shiftCount: 'Смен в утверждённом снимке' },
    orderObservations: { closedOrderCount: 'Закрытых заказов за период', lockedOrderCount: 'Заказов с зафиксированной ценой',
      missingLockedHeaderCount: 'Заказов без полного снимка цены', observedLineCount: 'Строк в закрытых заказах',
      missingSalesAttributionLineCount: 'Строк без продавца или даты продажи', missingClosedAtCountVenueWide: 'Заказов без даты закрытия во всём заведении' },
    refundObservations: { eventCount: 'Возвратов, зарегистрированных за период', unattributedEventCount: 'Из них без связи с товарами',
      linkedToInspectedOrdersCount: 'Возвратов к заказам этого периода', linkedUnattributedCount: 'Из них без связи с товарами' },
    canonicalLinePricing: { closedOrderCount: 'Закрытых заказов', snapshotOrderCount: 'Заказов с ценовым снимком',
      legacyOrderCount: 'Заказов без ценового снимка', invalidOrderCount: 'Некорректных ценовых снимков' },
    payrollSaleCredit: { closedOrderCount: 'Закрытых заказов', snapshotOrderCount: 'Заказов с ценовым снимком',
      legacyOrderCount: 'Заказов без ценового снимка', invalidOrderCount: 'Некорректных ценовых снимков',
      unknownLineCount: 'Строк с неизвестным продавцом', unsupportedCrossVenueLineCount: 'Строк с неподдерживаемым продавцом другой площадки',
      creditedLineCount: 'Строк с подтверждённым продавцом', grossCents: 'Продажи до скидок · справочно',
      discountCents: 'Скидки по строкам · справочно', merchandiseNetCents: 'Стоимость товаров после скидок · справочно',
      minimumAdjustmentCents: 'Корректировка до минимума заказа · не атрибутирована продавцам', finalTotalCents: 'Итого заказов · справочно' },
    itemReturnEvidence: { scopedRefundCount: 'Возвратов, попавших в проверку', completeHeaderCount: 'Возвратов с полными товарными строками',
      unattributedHeaderCount: 'Возвратов без атрибуции товара', notApplicableHeaderCount: 'Возвратов без возврата товара',
      scopedItemReturnCount: 'Товарных строк возврата в периоде', inspectedSourceItemCount: 'Исходных товарных строк с историей возвратов',
      fullHistoryRowCount: 'Строк истории возвратов, проверенных целиком', validatedItemCount: 'Подтверждённых строк возврата',
      invalidItemCount: 'Некорректных строк возврата', ambiguousItemCount: 'Строк с неоднозначным порядком событий',
      missingSourceCount: 'Строк без исходной цены', unknownHistoryHeaderCount: 'Возвратов с неизвестной историей',
      unknownAttributionItemCount: 'Строк с неизвестным продавцом', unsupportedCrossVenueItemCount: 'Строк с неподдерживаемым продавцом другой площадки',
      sequencedEventCount: 'Событий с сохранённым порядком', legacyUnsequencedEventCount: 'Событий без сохранённого порядка',
      post092ValidatedItemCount: 'Строк, проверенных по последовательности событий', legacyBaselineItemCount: 'Старых строк с подтверждённым итогом истории' },
    recognitionManifest: { recognizedSaleEventCount: 'Признанных событий продажи', recognizedSaleLineCount: 'Признанных строк продажи',
      recognizedRefundEventCount: 'Признанных событий возврата', recognizedRefundLineCount: 'Признанных строк возврата' },
    employeeEligibility: { revisionNo: 'Версия истории допуска', periodCount: 'Периодов допуска сотрудников' },
    employeeRoleCoverage: { activeEmployeeCount: 'Активных сотрудников в периоде', activeEmployeeDayCount: 'Дней сотрудников с допуском',
      coveredEmployeeDayCount: 'Дней с назначенной ролью' }
  };
  const readinessMoneyMetrics = new Set(['grossCents', 'discountCents', 'merchandiseNetCents', 'minimumAdjustmentCents', 'finalTotalCents']);
  const readinessReasons = {
    explicit_owner_source_policy_selection_required:'В сохранённой версии не выбраны правила источников.',
    closed_order_date_missing_venue_wide:'В заведении есть закрытые заказы без даты закрытия; их период неизвестен.',
    locked_order_header_missing:'В части заказов отсутствует полный зафиксированный заголовок цены.',
    order_item_sales_attribution_schema_missing:'Хранение продавца и даты продажи строки ещё не подключено.',
    refund_event_schema_missing:'Хранение зарегистрированных возвратов ещё не подключено.',
    payroll_attendance_source_incomplete:'Исходный табель неполный.', payroll_attendance_approval_required:'Снимок табеля ещё не утверждён.',
    payroll_attendance_function_context_schema_required:'Для табеля требуется обновление локальной базы данных.',
    payroll_attendance_approval_stale:'Утверждённый снимок устарел после изменения источников.', payroll_attendance_snapshot_invalid:'Утверждённый снимок не прошёл проверку.',
    canonical_immutable_line_pricing_not_implemented:'Источник неизменяемых цен и скидок строк ещё не подключён.',
    immutable_payroll_sale_credit_not_implemented:'Неизменяемое приписывание продаж сотрудникам ещё не подключено.',
    recognized_line_refund_lineage_not_implemented:'Связь признанного возврата со строкой продажи ещё не подключена.',
    recognition_source_schema_missing:'Не найдена полная схема источника признания зарплатных продаж и возвратов.',
    full_employee_net_revenue_period_coverage_unproven:'Полнота периода не подтверждена; сумма не рассчитывается.',
    full_employee_net_revenue_source_policy_unsupported:'Сохранённое правило даты возврата не поддерживается этим источником.',
    full_employee_net_revenue_source_context_invalid:'Источник чистой стоимости товаров не прошёл проверку контекста.',
    immutable_margin_cost_source_not_implemented:'Источник неизменяемой себестоимости ещё не подключён.',
    department_shift_allocation_source_not_implemented:'Источник распределения по цеху и смене ещё не подключён.',
    item_return_evidence_schema_missing:'Схема товарных возвратов ещё не подключена.',
    item_return_legacy_unsequenced:'В истории есть старые возвраты без сохранённого порядка событий.',
    item_return_chronology_ambiguous:'Порядок части старых возвратов нельзя подтвердить.',
    item_return_unattributed_history:'Есть возвраты без связи с исходными товарами.',
    item_return_seller_unknown:'Не удалось подтвердить продавца исходной строки.',
    item_return_canonical_source_missing:'Для части возвратов нет подтверждённого снимка исходной цены.',
    item_return_header_classification_invalid:'Заголовок возврата не совпадает с сохранёнными товарными строками.',
    payroll_employment_eligibility_schema_missing:'Хранилище истории допуска сотрудников ещё не подключено.',
    payroll_employment_eligibility_revision_required:'Владелец ещё не сохранил периоды допуска сотрудников.',
    payroll_employment_eligibility_revision_integrity_mismatch:'Сохранённая история допуска не прошла проверку целостности.',
    payroll_employee_role_coverage_eligibility_unavailable:'Сначала требуется подтверждённая история допуска сотрудников.',
    payroll_employee_role_coverage_context_invalid:'Версия схемы, период или площадка не совпадают.',
    payroll_employee_role_coverage_assignments_invalid:'Назначения ролей содержат некорректные данные.',
    payroll_employee_role_coverage_assignment_invalid:'Одно из назначений роли содержит некорректные даты или сотрудника.',
    payroll_employee_role_coverage_assignment_gap:'Для части дней сотрудника не назначено правило оплаты.',
    payroll_employee_role_coverage_assignment_overlap:'На часть дней сотруднику назначено более одного правила оплаты.',
    payroll_employee_role_coverage_roster_invalid:'История допуска сотрудников содержит некорректные периоды.',
    payroll_employee_role_coverage_role_unconfigured:'Для назначенной роли не настроено правило оплаты.',
    payroll_employee_role_coverage_scheme_window_invalid:'Не удалось проверить срок действия версии схемы.',
    payroll_employee_role_coverage_scheme_window_not_covering_active_day:'Версия схемы действует не на все дни допуска сотрудников.',
    payroll_saved_run_source_changed:'После сохранения расчёта изменились исходные данные или их подтверждения.',
    payroll_saved_run_timezone_changed:'Изменился часовой пояс заведения. Проверьте границы расчётного периода.',
    payroll_saved_run_source_unverified:'Не удалось подтвердить полный набор исходных данных.',
    payroll_official_no_refund_coverage_not_proven:'Есть связанные возвраты или не подтверждена полнота их истории. Нужна проверка корректировки расчёта.',
    payroll_refund_aware_common_source_unavailable:'Не удалось подтвердить общие данные продаж, возвратов и сотрудников за выбранный период.',
    payroll_refund_aware_candidate_unavailable:'Не удалось подтвердить расчёт этой схемы. Проверьте исходные данные и сохранённые правила.',
    payroll_refund_aware_cost_source_unavailable:'Для маржинальной схемы нужна подтверждённая стоимость товаров на момент продажи.',
    payroll_refund_aware_department_source_unavailable:'Для этой схемы нужно подтвердить распределение проданных товаров по цехам.',
    payroll_refund_aware_explicit_policy_required:'В сохранённой версии не выбрано правило расчёта с учётом возвратов.',
    payroll_legacy_candidate_unavailable:'Исходная схема не может быть рассчитана по данным выбранного периода.',
    payroll_calculator_signed_refund_input_missing:'Этот способ расчёта пока не поддерживает корректировки по возвратам.'
  };
  const readinessReasonLabel = reason => typeof reason !== 'string' ? 'Источник требует проверки.'
    : readinessReasons[reason]
      || (reason.startsWith('payroll_item_return_') ? 'История товарного возврата содержит сумму, порядок или связь, которую нельзя подтвердить.'
        : reason.startsWith('payroll_employee_role_coverage_') ? 'Покрытие сотрудников назначениями ролей требует проверки.'
          : reason.startsWith('payroll_employment_eligibility_') ? 'История допуска сотрудников требует проверки.'
            : reason.startsWith('payroll_recognition_') ? 'Манифест признанных продаж и возвратов требует проверки.'
              : reason.startsWith('payroll_sale_credit_') ? 'Приписывание продажи сотруднику требует проверки.'
                : reason.startsWith('canonical_pricing_') ? 'Снимок цены заказа или строки требует проверки.'
                  : 'Источник требует проверки. Проверьте данные или обратитесь к администратору.');
  const fullNetCandidateReasons = {
    full_employee_net_revenue_period_coverage_unproven:'Полнота истории за этот период не подтверждена; итоговая сумма неизвестна.',
    full_employee_net_revenue_source_policy_unsupported:'Сохранённое правило учёта возвратов не поддерживается.',
    full_employee_net_revenue_source_context_invalid:'Данные источника не прошли проверку площадки, периода или версии.',
    full_employee_net_revenue_projection_invalid:'Не удалось проверить строки продаж и товарных возвратов.',
    full_employee_net_revenue_sale_invalid:'Найдена строка продажи с некорректными данными.',
    full_employee_net_revenue_refund_invalid:'Найдена строка возврата с некорректными данными.',
    full_employee_net_revenue_refund_lineage_invalid:'Не подтверждена связь возврата с исходной строкой продажи.',
    full_employee_net_revenue_total_overflow:'Итог выходит за безопасный диапазон и требует проверки.',
    full_employee_net_revenue_candidate_missing:'Кандидатные данные источника недоступны.',
    payroll_recognition_refund_history_missing:'Для части возвратов не подтверждена история возврата товара.',
    payroll_recognition_refund_original_sale_attribution_missing:'Не подтверждён сотрудник исходной продажи для части возвратов.',
    payroll_recognition_related_sale_attribution_orphaned:'Не удалось связать часть возвратов с исходными продажами.',
    payroll_recognition_related_sale_history_mismatch:'История возврата не совпадает с исходной продажей.',
    payroll_recognition_manifest_incomplete:'Манифест признанных продаж и возвратов неполон.',
    recognition_source_schema_missing:'Схема источника признанных продаж и возвратов не найдена.',
    closed_order_date_missing_venue_wide:'У части закрытых заказов неизвестна дата закрытия.'
  };
  const renderSourceReadiness = payload => {
    if (payload?.schemaVersion !== 1 || payload.officialReady !== false || !payload.components
        || typeof payload.components !== 'object' || Array.isArray(payload.components)) throw new Error('Некорректный ответ проверки источников.');
    const statuses={available:'Доступен',incomplete:'Нужна проверка',unsupported:'Не подключён',not_required:'Не требуется'};
    const validStatus = value => Object.hasOwn(statuses, value);
    const componentStatus = item => item && typeof item === 'object' && !Array.isArray(item) && validStatus(item.status) ? item.status : null;
    const actualKeys = Object.keys(payload.components);
    const missingKeys = Object.keys(readinessLabels).filter(key => !Object.hasOwn(payload.components, key));
    const unknownKeys = actualKeys.filter(key => !Object.hasOwn(readinessLabels, key));
    const availableCount = actualKeys.filter(key => Object.hasOwn(readinessLabels, key) && componentStatus(payload.components[key]) === 'available').length;
    const incompleteCount = actualKeys.filter(key => Object.hasOwn(readinessLabels, key) && componentStatus(payload.components[key]) === 'incomplete').length;
    const unsupportedCount = actualKeys.filter(key => Object.hasOwn(readinessLabels, key) && componentStatus(payload.components[key]) === 'unsupported').length;
    const reviewCount = unknownKeys.length + missingKeys.length
      + actualKeys.filter(key => Object.hasOwn(readinessLabels, key) && !componentStatus(payload.components[key])).length;
    const renderComponent = (key, label, index, missing = false, unknown = false) => {
      const item = missing ? null : payload.components[key];
      const state = componentStatus(item);
      const safeStatus = unknown ? 'Новый источник — требуется проверка'
        : missing ? 'Источник не получен'
          : state ? statuses[state] : 'Данные не распознаны — нужна проверка';
      const cardId = unknown ? `additional-${index + 1}` : key;
      const metrics = !unknown && state ? Object.entries(readinessMetrics[key] || {}).filter(([field]) => Object.hasOwn(item, field)).map(([field, title]) => {
        const value = item[field];
        const formatted = value === null ? 'Неизвестно'
          : readinessMoneyMetrics.has(field) && Number.isSafeInteger(value) ? money(value, item.currency || 'RUB')
            : Number.isSafeInteger(value) ? new Intl.NumberFormat('ru-RU').format(value)
              : value === true ? 'Да' : value === false ? 'Нет' : null;
        return formatted === null ? '' : `<p>${title}: <strong>${escapeHtml(formatted)}</strong></p>`;
      }).join('') : '';
      const reasons = Array.isArray(item?.reasons) ? item.reasons.map(reason => `<p class="muted">${escapeHtml(readinessReasonLabel(reason))}</p>`).join('') : '';
      const message = unknown ? '<p class="muted">Данные получены, но их назначение ещё не отображается в этой версии интерфейса. Официальный расчёт остаётся заблокированным.</p>'
        : missing ? '<p class="muted">Ответ проверки не содержит этот ожидаемый источник. Обновите экран или обратитесь к администратору.</p>'
          : !state ? '<p class="muted">Формат состояния источника не распознан. Обновите экран или обратитесь к администратору.</p>' : '';
      const labelText = unknown ? `Дополнительный источник ${index + 1}` : label;
      return `<section data-source-readiness-component="${escapeHtml(cardId)}" data-source-readiness-kind="${unknown ? 'unknown' : missing ? 'missing' : 'known'}"${state && !unknown ? ` data-source-readiness-status="${state}"` : ''}><h4>${labelText} · ${safeStatus}</h4>${message}${metrics}${key==='approvedAttendance'&&state==='available'?'<p>Неизменяемый снимок табеля проверен.</p>':''}${reasons}</section>`;
    };
    const groupedKeys = new Set(readinessGroups.flatMap(group => group.keys));
    const groupMarkup = readinessGroups.map(group => {
      const cards = group.keys.map(key => Object.hasOwn(payload.components, key)
        ? renderComponent(key, readinessLabels[key], 0) : renderComponent(key, readinessLabels[key], 0, true));
      return `<section data-source-readiness-group><h4>${group.label}</h4><div data-source-readiness-grid>${cards.join('')}</div></section>`;
    }).join('');
    const unknownCards = unknownKeys.map((key, index) => renderComponent(key, '', index, false, true));
    const ungroupedCards = Object.keys(readinessLabels).filter(key => !groupedKeys.has(key))
      .map(key => Object.hasOwn(payload.components, key) ? renderComponent(key, readinessLabels[key], 0)
        : renderComponent(key, readinessLabels[key], 0, true));
    const additionalCards = [...ungroupedCards, ...unknownCards];
    const additionalGroup = additionalCards.length
      ? `<section data-source-readiness-group><h4>Дополнительные проверки</h4><div data-source-readiness-grid>${additionalCards.join('')}</div></section>` : '';
    return `<style>[data-source-readiness-groups]{display:grid;gap:12px}[data-source-readiness-grid]{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:10px}[data-source-readiness-component]{min-width:0;box-sizing:border-box;padding:12px;border:1px solid var(--ui-border-control);border-radius:10px;overflow-wrap:anywhere}[data-source-readiness-component][data-source-readiness-kind="unknown"],[data-source-readiness-component][data-source-readiness-kind="missing"]{border-color:var(--ui-warning-border,#d9aa52)}</style><p data-source-readiness-official>Официальный расчёт пока недоступен. Эта проверка показывает состояние источников, но не начисляет зарплату и не сохраняет выплаты.</p><p>Период: ${escapeHtml(payload.period?.from)} — ${escapeHtml(payload.period?.to)} · часовой пояс: ${escapeHtml(payload.period?.timezone)}</p><p data-source-readiness-summary>Доступно: ${availableCount} · нужна проверка: ${incompleteCount} · не подключено: ${unsupportedCount} · интерфейс не распознал или не получил: ${reviewCount}</p><div data-source-readiness-groups>${groupMarkup}${additionalGroup}</div><p class="muted">Нулевые значения и полностью доступные отдельные источники сами по себе не разрешают официальный расчёт.</p>`;
  };
  const renderRefundAwareSourcedComparison = (payload, staff = []) => {
    const invalid = () => { throw new Error('Некорректное сравнение зарплатных схем: обновите данные.'); };
    const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const amount = value => Number.isSafeInteger(value) && value >= 0;
    const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;
    if (payload?.schemaVersion !== 2 || payload.comparisonKind !== 'sourced_candidate_v2'
        || payload.candidateOnly !== true || payload.nonPayable !== true || payload.nonAccrual !== true
        || payload.officialReady !== false || payload.payoutEligible !== false || payload.persistence !== 'none'
        || payload.currency !== 'RUB' || typeof payload.venueId !== 'string'
        || !validDate(payload.period?.from) || !validDate(payload.period?.to) || payload.period.from > payload.period.to
        || !(payload.period.timezone === null || (typeof payload.period.timezone === 'string' && payload.period.timezone))
        || !Array.isArray(payload.results) || payload.results.length < 2 || payload.results.length > 8
        || new Set(payload.results.map(row => row?.versionId)).size !== payload.results.length
        || !payload.results.some(row => row?.versionId === payload.baselineVersionId)) invalid();
    const staffNames = new Map((Array.isArray(staff) ? staff : []).filter(row => row && typeof row.id === 'string' && typeof row.name === 'string').map(row => [row.id, row.name]));
    const baseline = payload.results.find(row => row.versionId === payload.baselineVersionId);
    const shared = sha(payload.sharedSourceWatermark);
    if (shared && !payload.period.timezone) invalid();
    const renderMoney = value => value === null ? '—' : money(value, payload.currency);
    const rows = payload.results.map(row => {
      if (!row || typeof row.versionId !== 'string' || !['legacy_v1','refund_aware_v2'].includes(row.policyFamily)
          || !['ready','blocked'].includes(row.status) || !Array.isArray(row.reasons)
          || row.reasons.some(reason => typeof reason !== 'string') || !Array.isArray(row.employees)
          || row.employees.length > 500 || new Set(row.employees.map(employee => employee?.employeeId)).size !== row.employees.length) invalid();
      const ready = row.status === 'ready', evidence = row.candidateEvidence;
      if (ready) {
        if (!shared || !amount(row.amountCents) || !sha(row.inputWatermark) || !evidence
            || evidence.schemaVersion !== (row.policyFamily === 'refund_aware_v2' ? 2 : 1)
            || evidence.venueId !== payload.venueId || evidence.schemeVersionId !== row.versionId
            || evidence.currency !== payload.currency || evidence.period?.from !== payload.period.from
            || evidence.period?.to !== payload.period.to || evidence.sharedSourceWatermark !== payload.sharedSourceWatermark
            || evidence.amountCents !== row.amountCents || evidence.inputWatermark !== row.inputWatermark
            || !sha(evidence.calculationWatermark) || evidence.officialReady !== false
            || evidence.payoutEligible !== false || evidence.persistence !== 'none') invalid();
        let total = 0n;
        for (const employee of row.employees) {
          if (!employee || typeof employee.employeeId !== 'string' || !amount(employee.amountCents)) invalid();
          total += BigInt(employee.amountCents);
        }
        if (total !== BigInt(row.amountCents)) invalid();
      } else if (row.amountCents !== null || row.deltaCents !== null || row.employeeDeltas !== null
          || evidence !== null || row.employees.length) invalid();
      if ((row.deltaCents === null) !== (row.employeeDeltas === null)) invalid();
      if (row.deltaCents !== null) {
        if (!ready || baseline.status !== 'ready' || row.policyFamily !== baseline.policyFamily
            || !Number.isSafeInteger(row.deltaCents) || row.deltaCents !== row.amountCents - baseline.amountCents
            || !Array.isArray(row.employeeDeltas) || row.employeeDeltas.length > 1000) invalid();
        const own = new Map(row.employees.map(employee => [employee.employeeId, employee.amountCents]));
        const base = new Map(baseline.employees.map(employee => [employee.employeeId, employee.amountCents]));
        const ids = new Set([...own.keys(),...base.keys()]);
        if (row.employeeDeltas.length !== ids.size || new Set(row.employeeDeltas.map(item => item?.employeeId)).size !== ids.size) invalid();
        for (const delta of row.employeeDeltas) {
          if (!delta || !ids.has(delta.employeeId) || delta.amountCents !== (own.has(delta.employeeId) ? own.get(delta.employeeId) : null)
              || delta.baselineAmountCents !== (base.has(delta.employeeId) ? base.get(delta.employeeId) : null)) invalid();
          const comparable = own.has(delta.employeeId) && base.has(delta.employeeId);
          if (delta.status !== (comparable ? 'comparable' : 'identity_uncovered')
              || delta.deltaCents !== (comparable ? own.get(delta.employeeId) - base.get(delta.employeeId) : null)) invalid();
        }
      }
      const deltas = new Map((row.employeeDeltas || []).map(item => [item.employeeId,item]));
      const ownEmployees = new Map(row.employees.map(employee => [employee.employeeId, employee]));
      const detailIds = row.employeeDeltas ? row.employeeDeltas.map(item => item.employeeId) : row.employees.map(item => item.employeeId);
      const employees = detailIds.map(employeeId => {
        const employee = ownEmployees.get(employeeId), delta = deltas.get(employeeId);
        return `<tr><th scope="row">${escapeHtml(staffNames.get(employeeId) || employee?.name || employeeId)}${delta?.status === 'identity_uncovered' ? ' · Нет данных в одной из схем' : ''}</th><td>${renderMoney(employee?.amountCents ?? null)}</td><td>${renderMoney(delta?.baselineAmountCents ?? null)}</td><td>${renderMoney(delta?.deltaCents ?? null)}</td></tr>`;
      }).join('');
      const detail = ready ? `<tr><td colspan="5"><details><summary>По сотрудникам: ${detailIds.length}</summary><div role="region" tabindex="0" aria-label="Расчёт по сотрудникам" style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Сотрудник</th><th>Прогноз начисления</th><th>Базовая схема</th><th>Разница</th></tr></thead><tbody>${employees}</tbody></table></div></details>${row.deltaCents === null ? '<p>Разница недоступна: базовая схема не рассчитана или использует другую политику расчёта.</p>' : ''}</td></tr>` : '';
      const reasons = row.reasons.map(reason => `<li>${escapeHtml(readinessReasonLabel(reason))}</li>`).join('');
      return `<tr data-sourced-comparison-status="${ready ? 'scenario_ready' : 'blocked'}"><th scope="row">${escapeHtml(row.name || 'Схема')} · версия ${escapeHtml(row.versionNo ?? '—')}${row.versionId === payload.baselineVersionId ? ' · база' : ''}<small>${row.policyFamily === 'refund_aware_v2' ? 'С учётом возвратов' : 'Исходная политика'}</small></th><td>${ready ? 'Рассчитано' : 'Нужны данные'}</td><td>${ready ? renderMoney(row.amountCents) : 'Не рассчитано'}</td><td>${renderMoney(row.deltaCents)}</td><td>${reasons ? `<ul>${reasons}</ul>` : '—'}</td></tr>${detail}`;
    }).join('');
    return `<h4 tabindex="-1" data-sourced-comparison-heading>Сравнение схем по фактическим данным</h4><p>Период: ${escapeHtml(payload.period.from)} — ${escapeHtml(payload.period.to)}</p><p class="warning-message" data-sourced-comparison-candidate-only>Прогноз начисления до входящих корректировок. Сравнение не создаёт ведомость, расход или выплату и не применяет удержания.</p>${payload.results.some(row => row.mode === 'margin_target') ? '<p>Маржинальная схема использует зафиксированную стоимость при продаже для расчёта премии; это не бухгалтерская себестоимость после возвратов.</p>' : ''}${shared ? `<details><summary>Исходные данные сравнения</summary><code>${escapeHtml(payload.sharedSourceWatermark)}</code></details>` : '<p>Общие исходные данные не подтверждены; суммы недоступны.</p>'}<div role="region" aria-label="Сравнение сохранённых зарплатных схем" tabindex="0" style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Схема</th><th>Состояние</th><th>Прогноз начисления</th><th>Разница с базой</th><th>Причина</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  const renderSourcedComparison = (payload, staff = []) => {
    if (payload?.schemaVersion === 2) return renderRefundAwareSourcedComparison(payload, staff);
    if (payload?.schemaVersion !== 1 || payload.comparisonKind !== 'sourced_candidate' || payload.candidateOnly !== true
        || payload.nonPayable !== true || payload.nonAccrual !== true || payload.payoutEligible !== false
        || payload.officialReady !== false || payload.persistence !== 'none' || !Array.isArray(payload.comparisons)
        || payload.comparisons.length < 2 || !payload.period) throw new Error('Некорректный ответ сравнения зарплатных схем.');
    const comparisonStatus = payload.status === 'scenario_ready' ? 'Сопоставимо по общим исходным данным' : 'Сравнение заблокировано';
    if (!Array.isArray(payload.results) || payload.results.length !== payload.comparisons.length
        || payload.results.some((result, index) => result?.versionId !== payload.comparisons[index]?.versionId)) {
      throw new Error('Сравнение не содержит согласованные снимки версий.');
    }
    const results = new Map(payload.results.map(result => [result.versionId, result]));
    const rows = payload.comparisons.map(item => {
      if (!item || typeof item.versionId !== 'string' || !['scenario_ready', 'blocked'].includes(item.status)
          || (item.status === 'scenario_ready' && (!Number.isSafeInteger(item.amountCents)
            || (item.deltaToBaselineCents !== null && !Number.isSafeInteger(item.deltaToBaselineCents))
            || (item.employeeDeltas !== null && !Array.isArray(item.employeeDeltas))))
          || (item.status === 'scenario_ready' && ((item.deltaToBaselineCents === null) !== (item.employeeDeltas === null)))
          || (item.status === 'blocked' && (item.amountCents !== null || item.deltaToBaselineCents !== null || item.employeeDeltas !== null))) {
        throw new Error('Строка сравнения содержит неизвестный статус или некорректную сумму.');
      }
      const employeeRows = item.status === 'scenario_ready' && Array.isArray(item.employeeDeltas) ? item.employeeDeltas.map(delta => {
        if (!delta || typeof delta.employeeId !== 'string' || !['comparable', 'identity_uncovered'].includes(delta.status)
            || (delta.status === 'comparable' && (!Number.isSafeInteger(delta.amountCents) || !Number.isSafeInteger(delta.baselineAmountCents) || !Number.isSafeInteger(delta.deltaCents)))
            || (delta.status === 'identity_uncovered' && delta.deltaCents !== null)) throw new Error('Некорректная сотрудническая детализация сравнения.');
        return `<tr><th scope="row"><code>${escapeHtml(delta.employeeId)}</code></th><td>${delta.status === 'comparable' ? money(delta.amountCents, payload.currency) : 'Не сопоставлено'}</td><td>${delta.status === 'comparable' ? money(delta.baselineAmountCents, payload.currency) : 'Не сопоставлено'}</td><td>${delta.deltaCents === null ? '—' : money(delta.deltaCents, payload.currency)}</td></tr>`;
      }).join('') : '';
      const reasons = Array.isArray(item.reasons) ? item.reasons.map(reason => `<li>${escapeHtml(readinessReasonLabel(reason))}</li>`).join('') : '';
      const label = `${item.name || 'Схема'} · версия ${item.versionNo ?? '—'} · ${item.mode || 'режим не указан'}`;
      const amount = item.amountCents === null ? 'Не рассчитано' : money(item.amountCents, payload.currency);
      const delta = item.deltaToBaselineCents === null ? (item.status === 'scenario_ready' ? 'База недоступна' : '—') : money(item.deltaToBaselineCents, payload.currency);
      const snapshot = results.get(item.versionId)?.candidateSnapshot;
      if (item.status === 'scenario_ready' && (!snapshot || snapshot.schemeVersionId !== item.versionId
          || snapshot.candidateOnly !== true || snapshot.persistence !== 'none' || snapshot.officialReady !== false
          || snapshot.payoutEligible !== false || snapshot.period?.from !== payload.period.from
          || snapshot.period?.to !== payload.period.to || snapshot.amountCents !== item.amountCents
          || !/^[a-f0-9]{64}$/.test(snapshot.snapshotWatermark || '')
          || !/^[a-f0-9]{64}$/.test(snapshot.candidateResultWatermark || ''))) {
        throw new Error('Снимок сравнения не совпадает с версией и периодом.');
      }
      if (item.status === 'blocked' && snapshot !== null) throw new Error('Для заблокированной версии получен кандидатный снимок.');
      const snapshotRow = snapshot ? `<tr><td colspan="5"><details><summary>Доказательства версии: ${snapshot.lines.length} строк, отпечаток ${escapeHtml(snapshot.snapshotWatermark.slice(0, 12))}…</summary><p>Кандидатный снимок · не начислено и не к выплате · ${escapeHtml(snapshot.lines.length)} строк.</p></details></td></tr>` : '';
      return `<tr data-sourced-comparison-status="${item.status}"><th scope="row">${escapeHtml(label)}${item.versionId === payload.baselineVersionId ? ' · база' : ''}</th><td>${item.status === 'scenario_ready' ? 'Рассчитано' : 'Заблокировано'}</td><td>${escapeHtml(amount)}</td><td>${escapeHtml(delta)}</td><td>${reasons ? `<ul>${reasons}</ul>` : '—'}</td></tr>${snapshotRow}${item.status === 'scenario_ready' && item.employeeDeltas === null ? '<tr><td colspan="5">Разница не рассчитана: базовая версия недоступна.</td></tr>' : employeeRows ? `<tr><td colspan="5"><details><summary>Разница по сотрудникам: ${item.employeeDeltas.length}</summary><div role="region" aria-label="Разница по сотрудникам" tabindex="0" style="max-width:100%;overflow-x:auto"><table><thead><tr><th scope="col">ID сотрудника</th><th scope="col">Эта версия</th><th scope="col">База</th><th scope="col">Разница</th></tr></thead><tbody>${employeeRows}</tbody></table></div></details></td></tr>` : ''}`;
    }).join('');
    const hasValidSharedSourceWatermark = typeof payload.sharedSourceWatermark === 'string' && /^[a-f0-9]{64}$/.test(payload.sharedSourceWatermark);
    const watermark = hasValidSharedSourceWatermark
      ? `<p>Общий отпечаток исходных данных: <code>${escapeHtml(payload.sharedSourceWatermark)}</code></p>`
      : '<p class="warning-message">Общий отпечаток источников не подтверждён; суммы и дельты скрыты.</p>';
    if (!hasValidSharedSourceWatermark && payload.comparisons.some(item => item.amountCents !== null || item.deltaToBaselineCents !== null))
      throw new Error('Ответ сравнения содержит сумму без подтверждённого общего источника.');
    if (!hasValidSharedSourceWatermark && payload.results.some(result => result.candidateSnapshot !== null))
      throw new Error('Ответ сравнения содержит снимок без подтверждённого общего источника.');
    return `<h4 tabindex="-1" data-sourced-comparison-heading>${comparisonStatus}</h4><p>Период: ${escapeHtml(payload.period.from)} — ${escapeHtml(payload.period.to)} · ${escapeHtml(payload.currency)}</p>${watermark}<p class="warning-message" data-sourced-comparison-candidate-only>Это предварительное сравнение по данным системы. Оно не создаёт начисление, расход или выплату.</p><div role="region" aria-label="Сравнение сохранённых зарплатных схем" tabindex="0" style="max-width:100%;overflow-x:auto"><table><caption>Сохранённые версии и разница с базовой версией</caption><thead><tr><th scope="col">Сохранённая версия</th><th scope="col">Статус</th><th scope="col">Сумма</th><th scope="col">Разница с базовой версией</th><th scope="col">Причины блокировки</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  const renderFullEmployeeNetCandidate = payload => {
    if (payload?.candidateOnly !== true || payload.officialReady !== false || payload.calculationStatus !== 'unavailable'
        || payload.amount !== null || !payload.period || !payload.sources?.fullEmployeeNetRevenue) throw new Error('Некорректный ответ кандидатного источника.');
    const series = payload.sources.fullEmployeeNetRevenue;
    const labels = { available: 'Полные данные источника', incomplete: 'Период покрыт не полностью', unsupported: 'Правило источника не поддерживается' };
    if (!Object.hasOwn(labels, series.status) || !Array.isArray(series.reasons) || !Array.isArray(series.daily)) throw new Error('Некорректное состояние кандидатного источника.');
    const description = '<p data-full-net-candidate-warning>Это чистая стоимость товаров после скидок и товарных возвратов по датам признания. Она не является комиссионной базой или суммой зарплаты и не создаёт начислений.</p>';
    const reasons = series.reasons.map(reason => `<p class="muted">${escapeHtml(fullNetCandidateReasons[reason] || readinessReasons[reason]
      || (String(reason).startsWith('payroll_recognition_') ? 'Данные признания продаж или возвратов неполны либо не прошли проверку.' : 'Покрытие или правило источника не подтверждено.'))}</p>`).join('');
    if (series.status !== 'available') return `<section data-full-net-candidate-status="${series.status}"><h4>${labels[series.status]}</h4>${description}<p>Итоговая сумма и дневная детализация скрыты, пока источник не подтверждён.</p>${reasons}</section>`;
    if (!Number.isSafeInteger(series.amount) || typeof series.currency !== 'string' || !/^[A-Z]{3}$/.test(series.currency)) throw new Error('Некорректная сумма кандидатного источника.');
    const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    if (!validDate(payload.period.from) || !validDate(payload.period.to) || payload.period.from > payload.period.to) throw new Error('Некорректный период кандидатного источника.');
    let total = 0n, sourceEventCount = 0;
    const dailyKeys = new Set(), eventKeys = new Set();
    const validatedRows = series.daily.map(row => {
      if (!row || typeof row.employeeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.employeeId)
          || !validDate(row.date) || row.date < payload.period.from || row.date > payload.period.to || !Number.isSafeInteger(row.netMinor)
          || !Array.isArray(row.sourceEvents) || !row.sourceEvents.length) throw new Error('Некорректная строка кандидатного источника.');
      const dailyKey = `${row.employeeId}/${row.date}`;
      if (dailyKeys.has(dailyKey)) throw new Error('Повторяется сотрудник или дата в кандидатном источнике.');
      dailyKeys.add(dailyKey);
      let eventTotal = 0n;
      for (const event of row.sourceEvents) {
        if (!event || !['sale', 'refund'].includes(event.kind) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(event.id || ''))
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(event.eventId || ''))
            || !Number.isSafeInteger(event.amountMinor) || (event.kind === 'sale' ? event.amountMinor < 0 : event.amountMinor > 0)) throw new Error('Некорректное событие кандидатного источника.');
        const eventKey = `${event.kind}/${event.id}`;
        if (eventKeys.has(eventKey)) throw new Error('Повторяется событие кандидатного источника.');
        eventKeys.add(eventKey); eventTotal += BigInt(event.amountMinor); sourceEventCount++;
      }
      if (eventTotal !== BigInt(row.netMinor)) throw new Error('Сумма событий не совпадает с итогом за день.');
      total += BigInt(row.netMinor);
      return row;
    });
    if (total !== BigInt(series.amount)) throw new Error('Сумма дневных строк не совпадает с итогом периода.');
    let eventBudget = MAX_FULL_NET_CANDIDATE_EVENTS, renderedEvents = 0;
    const visibleRows = validatedRows.slice(0, MAX_FULL_NET_CANDIDATE_ROWS).map(row => {
      const employee = ownerStaff.find(item => item.id === row.employeeId)?.name;
      const shownEvents = row.sourceEvents.slice(0, eventBudget);
      eventBudget -= shownEvents.length; renderedEvents += shownEvents.length;
      const events = shownEvents.map(event => {
        return `<li>${event.kind === 'sale' ? 'Продажа' : 'Возврат'} · ${money(event.amountMinor, series.currency)}</li>`;
      }).join('');
      const omitted = row.sourceEvents.length - shownEvents.length;
      return `<tr><td>${escapeHtml(employee || `ID сотрудника ${row.employeeId}`)}</td><td>${escapeHtml(row.date)}</td><td>${money(row.netMinor, series.currency)}</td><td><details><summary>${row.sourceEvents.length} событий</summary><ul>${events}${omitted ? `<li>${omitted} событий скрыто из-за ограничения детализации</li>` : ''}</ul></details></td></tr>`;
    }).join('');
    const hiddenRows = Math.max(0, series.daily.length - MAX_FULL_NET_CANDIDATE_ROWS);
    const hiddenEvents = sourceEventCount - renderedEvents;
    return `<section data-full-net-candidate-status="available"><h4>${labels.available}</h4>${description}<p>Итог за период: <strong data-full-net-candidate-amount>${money(series.amount, series.currency)}</strong>. Валюта: ${escapeHtml(series.currency)}.</p>${series.daily.length ? `<p class="muted">На узком экране таблицу можно прокручивать по горизонтали.</p><div tabindex="0" role="region" aria-label="Чистая стоимость товаров по сотрудникам и датам" style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Сотрудник</th><th>Дата признания</th><th>Чистая стоимость товаров</th><th>Состав суммы</th></tr></thead><tbody>${visibleRows}</tbody></table></div>${hiddenRows || hiddenEvents ? `<p class="muted">Показаны первые ${Math.min(validatedRows.length, MAX_FULL_NET_CANDIDATE_ROWS)} строк и ${Math.min(sourceEventCount, MAX_FULL_NET_CANDIDATE_EVENTS)} событий; скрыто строк: ${hiddenRows}, событий: ${hiddenEvents}. Итоговая сумма учитывает весь период.</p>` : ''}` : '<p data-full-net-candidate-empty>За полностью покрытый период событий нет; подтверждённая сумма равна нулю.</p>'}${reasons}</section>`;
  };
  const renderOrderRevenueReconciliation = payload => {
    const source = payload?.sources?.orderRevenueReconciliation;
    if (!source || source.schemaVersion !== 1 || source.candidateOnly !== true || source.officialReady !== false
        || source.persistence !== 'none' || !['available', 'incomplete', 'unsupported'].includes(source.status)
        || !Array.isArray(source.orders) || !Array.isArray(source.reasons) || !source.coverage
        || !/^[A-Z]{3}$/.test(String(source.currency || ''))
        || source.period?.from !== payload.period?.from || source.period?.to !== payload.period?.to) {
      throw new Error('Некорректная сверка сумм закрытых заказов.');
    }
    const fingerprint = /^[a-f0-9]{64}$/.test(source.sourceWatermark || '')
      ? `<p>Отпечаток сверки: <code>${escapeHtml(source.sourceWatermark)}</code></p>` : '';
    const labels = { available: 'Сверка подтверждена', incomplete: 'Сверка неполная', unsupported: 'Источник сверки недоступен' };
    const explanation = '<p>Сверка закрытых чеков до возвратов. Минимальная корректировка остаётся суммой заведения; остаток не распределяется сотрудникам и не входит в расчёт зарплаты.</p>';
    if (source.status !== 'available') return `<section data-payroll-order-reconciliation-status="${source.status}"><h4>${labels[source.status]}</h4>${explanation}<p>Итоги скрыты, пока покрытие заказов и строк продажи не будет подтверждено.</p>${source.reasons.map(reason => `<p class="muted">${escapeHtml(readinessReasonLabel(reason))}</p>`).join('')}${fingerprint}</section>`;
    const fields = ['closedOrderTotalMinor', 'recognizedLineNetMinor', 'minimumPriceAdjustmentMinor', 'unattributedResidualMinor'];
    if (!source.coverage.complete || !Number.isSafeInteger(source.closedOrderCount) || !Number.isSafeInteger(source.recognizedOrderCount)
        || source.closedOrderCount !== source.orders.length || source.recognizedOrderCount !== source.closedOrderCount
        || fields.some(field => !Number.isSafeInteger(source.totals?.[field]) || source.totals[field] < 0)
        || !/^[A-Z]{3}$/.test(String(source.currency || '')) || !/^[a-f0-9]{64}$/.test(source.sourceWatermark || '')) {
      throw new Error('Подтверждённые итоги сверки не прошли проверку.');
    }
    const differencePercent = (difference, amount) => {
      if (amount === 0n) return 'не рассчитывается';
      const hundredths = (difference * 20000n + amount) / (amount * 2n);
      return `${hundredths / 100n},${String(hundredths % 100n).padStart(2, '0')}%`;
    };
    let total = 0n, lines = 0n, adjustment = 0n, residual = 0n;
    const rows = source.orders.map(row => {
      if (!row || row.status !== 'available' || !/^[0-9a-f-]{36}$/i.test(row.orderId || '')
          || fields.some(field => !Number.isSafeInteger(row[field]) || row[field] < 0)) throw new Error('Строка сверки некорректна.');
      const rowTotal = BigInt(row.closedOrderTotalMinor), rowLines = BigInt(row.recognizedLineNetMinor);
      if (rowTotal !== rowLines + BigInt(row.minimumPriceAdjustmentMinor) + BigInt(row.unattributedResidualMinor)) {
        throw new Error('Сумма чека не совпадает с товарными строками и корректировками.');
      }
      const difference = rowTotal - rowLines;
      total += rowTotal; lines += rowLines;
      adjustment += BigInt(row.minimumPriceAdjustmentMinor); residual += BigInt(row.unattributedResidualMinor);
      return `<tr><td>${escapeHtml(row.closedAt || '—')}</td><td><code>${escapeHtml(row.orderId)}</code></td><td>${money(row.closedOrderTotalMinor, source.currency)}</td><td>${money(row.recognizedLineNetMinor, source.currency)}</td><td>${money(Number(difference), source.currency)} · ${differencePercent(difference, rowTotal)}</td><td>${money(row.minimumPriceAdjustmentMinor, source.currency)}</td><td>${money(row.unattributedResidualMinor, source.currency)}</td></tr>`;
    }).join('');
    if (total !== BigInt(source.totals.closedOrderTotalMinor) || lines !== BigInt(source.totals.recognizedLineNetMinor)
        || adjustment !== BigInt(source.totals.minimumPriceAdjustmentMinor) || residual !== BigInt(source.totals.unattributedResidualMinor)
        || total !== lines + adjustment + residual) throw new Error('Итоги сверки не совпадают со строками заказов.');
    return `<section data-payroll-order-reconciliation-status="available"><h4>${labels.available}</h4>${explanation}<p>Закрытых заказов: ${source.closedOrderCount} · общая сумма ${money(source.totals.closedOrderTotalMinor, source.currency)} · строки товаров ${money(source.totals.recognizedLineNetMinor, source.currency)}.</p><p data-payroll-reconciliation-difference>Разница чека и товарных строк: ${money(Number(total - lines), source.currency)} · ${differencePercent(total - lines, total)}. Процент от общей суммы закрытых чеков.</p><p>В том числе корректировка до минимальной суммы: ${money(source.totals.minimumPriceAdjustmentMinor, source.currency)} · нераспределённый остаток: ${money(source.totals.unattributedResidualMinor, source.currency)}.</p>${source.orders.length ? `<div tabindex="0" role="region" aria-label="Сверка сумм закрытых заказов" style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Закрыт</th><th>Заказ</th><th>Сумма чека</th><th>Товарные строки</th><th>Разница, ₽ и %</th><th>Минимальная корректировка</th><th>Нераспределённый остаток</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Закрытых чеков за этот период нет.</p>'}${fingerprint}</section>`;
  };
  const renderRefundReview = payload => {
    const review = payload?.sources?.refundReview;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    if (!review || review.schemaVersion !== 1 || review.candidateOnly !== true || review.officialReady !== false
        || review.nonPayable !== true || review.nonAccrual !== true || review.payoutEligible !== false
        || !['available', 'incomplete', 'unsupported'].includes(review.status) || review.impactStatus !== 'not_applied' || !Array.isArray(review.rows)
        || !Array.isArray(review.employeeDays) || !Array.isArray(review.reasons)) throw new Error('Некорректный обзор возвратов.');
    const explanation = '<p class="muted">Справка показывает товарную стоимость возвратов по дате признания и исходному продавцу. Суммы не применены к зарплате и не создают долг, удержание или выплату.</p>';
    if (review.status !== 'available') return `<section data-payroll-refund-review-status="${review.status}"><h4>Возвраты требуют проверки источника</h4>${explanation}<p>Сумма и строки скрыты до подтверждения полного покрытия.</p>${review.reasons.map(reason => `<p class="muted">${escapeHtml(readinessReasonLabel(reason))}</p>`).join('')}</section>`;
    if (!/^[A-Z]{3}$/.test(String(review.currency || '')) || !Number.isSafeInteger(review.totalMerchandiseNetRevenueDeltaCents)
        || review.totalMerchandiseNetRevenueDeltaCents > 0 || !/^[a-f0-9]{64}$/.test(review.sourceWatermark || '')
        || !date(review.period?.from) || !date(review.period?.to) || review.period.from > review.period.to
        || review.period.from !== payload.period?.from || review.period.to !== payload.period?.to) throw new Error('Некорректная сумма обзора возвратов.');
    let total = 0n;
    const seen = new Set();
    const rows = review.rows.map(row => {
      if (!row || !uuid.test(String(row.refundItemId || '')) || !uuid.test(String(row.refundEventId || ''))
          || !uuid.test(String(row.originalSaleLineId || '')) || !uuid.test(String(row.orderId || ''))
          || !uuid.test(String(row.orderItemId || '')) || (row.menuItemId !== null && !uuid.test(String(row.menuItemId || '')))
          || !(row.menuItemName === null || (typeof row.menuItemName === 'string' && row.menuItemName.length <= 160))
          || !uuid.test(String(row.employeeId || ''))
          || seen.has(row.refundItemId) || !date(row.refundDate) || row.refundDate < review.period.from
          || row.refundDate > review.period.to || !date(row.originalSaleDate)
          || !Number.isSafeInteger(row.merchandiseNetRevenueDeltaCents) || row.merchandiseNetRevenueDeltaCents > 0 || row.currency !== review.currency) {
        throw new Error('Некорректная строка обзора возвратов.');
      }
      seen.add(row.refundItemId); total += BigInt(row.merchandiseNetRevenueDeltaCents);
      return row;
    });
    if (total !== BigInt(review.totalMerchandiseNetRevenueDeltaCents)) throw new Error('Сумма строк обзора возвратов не сходится.');
    const expectedEmployeeDays = new Map();
    for (const row of rows) {
      const key = `${row.employeeId}|${row.refundDate}`;
      if (!expectedEmployeeDays.has(key)) expectedEmployeeDays.set(key, { employeeId: row.employeeId, recognizedDate: row.refundDate,
        total: 0n, refundItemIds: [], refundEventIds: [], originalSaleLineIds: [] });
      const summary = expectedEmployeeDays.get(key);
      summary.total += BigInt(row.merchandiseNetRevenueDeltaCents);
      summary.refundItemIds.push(row.refundItemId); summary.refundEventIds.push(row.refundEventId);
      summary.originalSaleLineIds.push(row.originalSaleLineId);
    }
    const employeeDayKeys = new Set();
    let employeeDayTotal = 0n;
    for (const row of review.employeeDays) {
      const key = `${row?.employeeId}|${row?.recognizedDate}`;
      const expected = expectedEmployeeDays.get(key);
      const sortedUnique = values => Array.isArray(values) && values.every(value => uuid.test(String(value || '')))
        && new Set(values).size === values.length && values.slice().sort().join('|') === values.join('|');
      if (!uuid.test(String(row?.employeeId || '')) || !date(row?.recognizedDate)
          || row.recognizedDate < review.period.from || row.recognizedDate > review.period.to
          || !Number.isSafeInteger(row?.merchandiseNetRevenueDeltaCents) || row.merchandiseNetRevenueDeltaCents > 0
          || !expected || employeeDayKeys.has(key) || !sortedUnique(row.refundItemIds)
          || !sortedUnique(row.refundEventIds) || !sortedUnique(row.originalSaleLineIds)
          || BigInt(row.merchandiseNetRevenueDeltaCents) !== expected.total
          || row.refundItemIds.join('|') !== [...new Set(expected.refundItemIds)].sort().join('|')
          || row.refundEventIds.join('|') !== [...new Set(expected.refundEventIds)].sort().join('|')
          || row.originalSaleLineIds.join('|') !== [...new Set(expected.originalSaleLineIds)].sort().join('|')) {
        throw new Error('Сводка возвратов по сотруднику и дате не сходится.');
      }
      employeeDayKeys.add(key); employeeDayTotal += BigInt(row.merchandiseNetRevenueDeltaCents);
    }
    if (employeeDayKeys.size !== expectedEmployeeDays.size || employeeDayTotal !== total) {
      throw new Error('Итоги возвратов по сотрудникам и датам не сходятся с исходными строками.');
    }
    const shown = rows.slice(0, 500);
    const body = shown.map(row => `<tr><td>${escapeHtml(ownerStaff.find(item => item.id === row.employeeId)?.name || `ID сотрудника ${row.employeeId}`)}</td><td>${escapeHtml(row.menuItemName || (row.menuItemId ? `Товар ${row.menuItemId.slice(0, 8)}` : `Строка ${row.orderItemId.slice(0, 8)}`))}</td><td>${escapeHtml(row.refundDate)}</td><td>${money(row.merchandiseNetRevenueDeltaCents, review.currency)}</td><td>${escapeHtml(row.originalSaleDate)} · ${escapeHtml(row.originalSaleLineId.slice(0, 8))}</td></tr>`).join('');
    const visibleEmployeeDays = review.employeeDays.slice(0, MAX_REFUND_REVIEW_EMPLOYEE_DAYS);
    const employeeDayRows = visibleEmployeeDays.map(row => `<tr><td>${escapeHtml(ownerStaff.find(item => item.id === row.employeeId)?.name || `ID сотрудника ${row.employeeId}`)}</td><td>${escapeHtml(row.recognizedDate)}</td><td>${money(row.merchandiseNetRevenueDeltaCents, review.currency)}</td><td>${row.refundItemIds.length}</td></tr>`).join('');
    const hiddenEmployeeDays = review.employeeDays.length - visibleEmployeeDays.length;
    return `<section data-payroll-refund-review-status="available"><h4>Товарные возвраты — справка владельцу</h4>${explanation}<p>Сумма изменений стоимости в выбранном периоде: <strong data-payroll-refund-review-total>${money(review.totalMerchandiseNetRevenueDeltaCents, review.currency)}</strong>. Это не сумма зарплаты. Строк возвратов: ${rows.length}.</p>${review.employeeDays.length ? `<h5>По сотруднику и дате признания</h5><div tabindex="0" role="region" aria-label="Изменение стоимости возвратов по сотрудникам и датам" style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Исходный сотрудник</th><th>Дата признания возврата</th><th>Изменение стоимости товаров</th><th>Строк возврата</th></tr></thead><tbody>${employeeDayRows}</tbody></table></div>${hiddenEmployeeDays ? `<p class="muted">Показано ${visibleEmployeeDays.length} из ${review.employeeDays.length} строк сводки; итог учитывает весь период.</p>` : ''}` : ''}${rows.length ? `<h5>Строки возврата</h5><div tabindex="0" role="region" aria-label="Строки товарных возвратов с атрибуцией" style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Исходный сотрудник</th><th>Товар</th><th>Дата возврата</th><th>Изменение стоимости</th><th>Исходная продажа</th></tr></thead><tbody>${body}</tbody></table></div>` : '<p data-payroll-refund-review-empty>Подтверждённых товарных возвратов в периоде нет.</p>'}${rows.length > shown.length ? `<p class="muted">Показано 500 из ${rows.length} строк; итог учитывает все строки.</p>` : ''}</section>`;
  };
  const renderCandidateCalculation = payload => {
    const candidate = payload?.candidateCalculation;
    if (!candidate || candidate.schemaVersion !== 1 || candidate.candidateOnly !== true
        || candidate.nonPayable !== true || candidate.nonAccrual !== true || candidate.officialReady !== false
        || candidate.payoutEligible !== false || !candidate.period || !Array.isArray(candidate.reasons)) {
      throw new Error('Некорректный ответ сценарного расчёта зарплаты.');
    }
    const reasons = candidate.reasons.map(reason => `<p class="muted">${escapeHtml(readinessReasonLabel(reason))}</p>`).join('');
    if (candidate.status !== 'scenario_ready') {
      if (candidate.amountCents !== null || !['blocked'].includes(candidate.status)) throw new Error('Некорректное заблокированное состояние сценария.');
      return `<section data-payroll-candidate-status="blocked"><h3>Сценарный расчёт заблокирован</h3><p>Сумма скрыта: не все источники и условия расчёта подтверждены. Начисление и выплата не создавались.</p>${reasons}</section>`;
    }
    if (!Number.isSafeInteger(candidate.amountCents) || candidate.amountCents < 0
        || !Number.isSafeInteger(candidate.monthTurnoverCents) || candidate.monthTurnoverCents < 0
        || typeof candidate.currency !== 'string' || !/^[A-Z]{3}$/.test(candidate.currency)
        || !EDITOR_MODES.includes(candidate.mode) || !/^[a-f0-9]{64}$/.test(candidate.inputWatermark || '')
        || !Array.isArray(candidate.employees) || !Array.isArray(candidate.daily)
        || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.period.from) || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.period.to)
        || candidate.period.from > candidate.period.to) throw new Error('Некорректные суммы или детализация сценарного расчёта.');
    let employeeTotal = 0n;
    const names = new Map();
    for (const row of candidate.employees) {
      if (!row || typeof row.employeeId !== 'string' || !Number.isSafeInteger(row.amountCents) || row.amountCents < 0) {
        throw new Error('Некорректная строка сотрудника в сценарном расчёте.');
      }
      employeeTotal += BigInt(row.amountCents);
      names.set(row.employeeId, ownerStaff.find(item => item.id === row.employeeId)?.name || `ID сотрудника ${row.employeeId}`);
    }
    if (employeeTotal !== BigInt(candidate.amountCents)) throw new Error('Сумма по сотрудникам не сходится с итогом сценария.');
    const shownEmployees = candidate.employees.slice(0, MAX_COMPARE_EMPLOYEE_DAYS);
    const normalized = { status: 'ready', mode: candidate.mode, currency: candidate.currency,
      periodFrom: candidate.period.from, periodTo: candidate.period.to, monthTurnoverCents: candidate.monthTurnoverCents,
      employees: shownEmployees, daily: candidate.daily.slice(0, MAX_RENDERED_EMPLOYEE_DAYS), blockers: [], criticalErrors: [] };
    const hidden = Math.max(0, candidate.employees.length - shownEmployees.length)
      + Math.max(0, candidate.daily.length - MAX_RENDERED_EMPLOYEE_DAYS);
    return `<section data-payroll-candidate-status="scenario_ready"><div class="warning-message" role="note"><strong>Сценарий рассчитан: ${money(candidate.amountCents, candidate.currency)} · не начислено и не к выплате</strong><p>Предварительный результат по сохранённой версии схемы за ${escapeHtml(candidate.period.from)} — ${escapeHtml(candidate.period.to)}. Он не создаёт payroll-run, начисление или расход и не является подтверждением права на выплату.</p></div>${renderDetails(normalized, names)}${hidden ? `<p class="muted">Детализация ограничена для отображения; скрыто строк сотрудников и дней: ${hidden}. Итог учитывает полный набор данных.</p>` : ''}${reasons}</section>`;
  };
  const renderCandidateSnapshot = payload => {
    const candidate = payload?.candidateCalculation, snapshot = payload?.candidateSnapshot;
    if (candidate?.status !== 'scenario_ready') {
      if (snapshot !== null) throw new Error('Для заблокированного расчёта получен кандидатный снимок.');
      return '';
    }
    if (snapshot === null && payload.candidateSnapshotStatus === 'size_limited') {
      return '<p class="muted" data-candidate-snapshot-limited>Детальный снимок слишком велик для показа целиком. Предварительный расчёт остаётся доступен выше, без снимка для аудита.</p>';
    }
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.snapshotKind !== 'candidate_preview'
        || snapshot.candidateOnly !== true || snapshot.officialReady !== false || snapshot.payoutEligible !== false
        || snapshot.nonPayable !== true || snapshot.nonAccrual !== true || snapshot.persistence !== 'none'
        || !/^[0-9a-f-]{36}$/i.test(snapshot.venueId || '') || snapshot.schemeId !== payload.schemeId
        || snapshot.schemeVersionId !== payload.versionId
        || snapshot.period?.from !== payload.period?.from || snapshot.period?.to !== payload.period?.to
        || snapshot.amountCents !== candidate.amountCents || snapshot.source?.inputWatermark !== candidate.inputWatermark
        || !/^[a-f0-9]{64}$/.test(snapshot.candidateResultWatermark || '')
        || !/^[a-f0-9]{64}$/.test(snapshot.snapshotWatermark || '')
        || !Array.isArray(snapshot.lines) || !Array.isArray(snapshot.days) || !Array.isArray(snapshot.employeeDays)) {
      throw new Error('Кандидатный снимок не совпадает с выбранной версией, периодом или расчётом.');
    }
    const shown = snapshot.lines.slice(0, 500);
    const rows = shown.map(line => {
      if (!line || !/^\d{4}-\d{2}-\d{2}$/.test(line.localDate || '') || typeof line.employeeId !== 'string'
          || !Number.isSafeInteger(line.commissionBaseCents) || !Number.isSafeInteger(line.commissionCents)) {
        throw new Error('Кандидатный снимок содержит некорректную строку.');
      }
      return `<tr><td>${escapeHtml(line.localDate)}</td><td>${escapeHtml(line.employeeName || line.employeeId)}</td><td>${escapeHtml(line.productFacts?.name || line.productId || 'Товар не указан')}</td><td>${escapeHtml(line.department || 'Цех не указан')}</td><td>${money(line.commissionBaseCents, snapshot.currency)}</td><td>${money(line.commissionCents, snapshot.currency)}</td></tr>`;
    }).join('');
    return `<details data-payroll-candidate-snapshot><summary>Основание расчёта: ${snapshot.lines.length} строк · SHA-256 ${escapeHtml(snapshot.snapshotWatermark.slice(0, 12))}…</summary><p>Снимок только для просмотра. Он не начислен, не сохранён и не к выплате. Отпечаток результата: <code>${escapeHtml(snapshot.candidateResultWatermark)}</code></p>${snapshot.lines.length ? `<div role="region" aria-label="Строки кандидатного зарплатного расчёта" tabindex="0" style="max-width:100%;overflow-x:auto"><table><caption>Товарные строки и кандидатное начисление</caption><thead><tr><th scope="col">Дата</th><th scope="col">Сотрудник</th><th scope="col">Товар</th><th scope="col">Цех</th><th scope="col">База</th><th scope="col">Комиссия</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Товарных строк нет; сумма может включать другие компоненты выбранной схемы.</p>'}${snapshot.lines.length > shown.length ? `<p class="muted">Показано ${shown.length} из ${snapshot.lines.length} строк; отпечаток относится ко всему снимку.</p>` : ''}</details>`;
  };
  const sourceReadinessPeriodValid = (from,to) => {
    const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
    return valid(from)&&valid(to)&&from<=to&&from===from.slice(0,7)+'-01'&&from.slice(0,7)===to.slice(0,7);
  };
  // Economic correction controller: exact persisted intent survives lost responses.
  const savedRunCreationEndpoint = version => {
    if (!version || typeof version !== 'object' || Array.isArray(version)) throw new Error('payroll_run_source_policy_unsupported');
    const policy=version?.sourcePolicies;
    if (policy === undefined || policy?.schemaVersion === 1) return '/api/payroll/calculation-runs';
    if (policy?.schemaVersion === 2 && policy.earnings?.refunds === 'remaining_merchandise_original_sale_date_v1'
        && policy.earnings?.venueTurnover === 'canonical_total_less_merchandise_returns_v1'
        && policy.earnings?.marginCost === 'frozen_sale_depletion_cost_payroll_v1') return '/api/payroll/refund-aware-calculation-runs';
    throw new Error('payroll_run_source_policy_unsupported');
  };
  const createReviewedCorrectionController = ({ request, storage, identity, makeKey }) => {
    const scope = identity(), prefix = `payroll-reviewed-correction:v1:${scope}:`;
    const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
    const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const cents = value => Number.isSafeInteger(value) && value >= 0;
    const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const ensure = () => { if (!scope || identity() !== scope) fail('payroll_correction_ui_owner_required'); };
    const previewValid = input => input && Object.keys(input).sort().join(',') === 'operation,originalEntryId,targetEntryId'
      && ['apply','waive'].includes(input.operation) && uuid(input.originalEntryId)
      && (input.operation === 'waive' ? input.targetEntryId === null : uuid(input.targetEntryId) && input.targetEntryId !== input.originalEntryId);
    const periodPolicy = 'reviewed_period_variable_pay_only_v1';
    const modelValid = model => ['line_v1','period_v2'].includes(model);
    const endpoint = model => model === 'period_v2' ? '/api/payroll/refund-aware-corrections' : '/api/payroll/reviewed-corrections';
    const periodPlanValid = (plan,input) => {
      const bounded = value => cents(value) && value <= 999999999999;
      if (!previewValid(input) || plan?.schemaVersion !== 3 || plan.policyCode !== periodPolicy || plan.basisKind !== 'period_variable'
          || plan.operation !== input.operation || plan.originalEntryId !== input.originalEntryId || plan.targetEntryId !== input.targetEntryId
          || !uuid(plan.employeeId) || !uuid(plan.originalRunId) || plan.venueId !== scope.split(':')[1] || plan.currency !== 'RUB'
          || ![plan.planHash,plan.assessmentHash,plan.sourceHash,plan.ledgerHash,plan.originalProvenanceSha256,plan.claimHistoryWatermark].every(sha)
          || !date(plan.originalPeriod?.from) || !date(plan.originalPeriod?.to) || plan.originalPeriod.from > plan.originalPeriod.to
          || !(plan.claimId === null || uuid(plan.claimId)) || ![plan.originalPaidCents,plan.firstAssessedCents,plan.currentPotentialCents,
            plan.highWaterAssessedCents,plan.alreadyDisposedCents,plan.availableReviewCents,plan.positiveEntitlementInformationCents].every(bounded)
          || plan.currentPotentialCents > plan.originalPaidCents || plan.highWaterAssessedCents > plan.originalPaidCents
          || plan.highWaterAssessedCents < Math.max(plan.currentPotentialCents,plan.firstAssessedCents)
          || plan.alreadyDisposedCents > plan.currentPotentialCents || plan.availableReviewCents !== plan.currentPotentialCents-plan.alreadyDisposedCents
          || plan.claimId === null && plan.alreadyDisposedCents !== 0
          || plan.positiveEntitlementAction !== 'none' || plan.ownerDecisionRequired !== true || plan.officialReady !== false
          || plan.payoutEligible !== false || plan.sourceAttested !== false || plan.deltaApplicationEligible !== false
          || plan.financialAction !== 'none' || plan.persistence !== 'none' || !Array.isArray(plan.allocations) || plan.allocations.length !== 1) return false;
      if (plan.originalExpenseId === null
        ? plan.originalPaidCents !== 0 || !uuid(plan.originalSettlementTransitionId)
        : !uuid(plan.originalExpenseId) || plan.originalPaidCents <= 0 || plan.originalSettlementTransitionId !== undefined) return false;
      const line=plan.allocations[0],apply=input.operation==='apply';
      if (!line || line.basisKind !== 'period_variable' || line.claimId !== plan.claimId
          || Object.hasOwn(line,'refundLineEventId') || Object.hasOwn(line,'sourceSnapshotLineId')
          || line.assessedCents !== plan.currentPotentialCents || line.firstAssessedCents !== plan.firstAssessedCents
          || line.highWaterAssessedCents !== plan.highWaterAssessedCents || line.alreadyDisposedCents !== plan.alreadyDisposedCents) return false;
      if (!apply) return bounded(plan.waiveCents) && plan.waiveCents === plan.availableReviewCents && line.waiveCents === plan.waiveCents;
      return uuid(plan.targetRunId) && plan.targetRunId !== plan.originalRunId && sha(plan.targetProvenanceSha256)
        && date(plan.targetPeriod?.from) && date(plan.targetPeriod?.to) && plan.targetPeriod.from > plan.originalPeriod.to
        && plan.targetPeriod.from <= plan.targetPeriod.to && [plan.targetBeforeCents,plan.targetAfterCents,plan.protectedFixedCents,
          plan.availableVariableCents,plan.applyCents,plan.residualReviewCents].every(bounded)
        && plan.targetAfterCents >= plan.protectedFixedCents && plan.targetBeforeCents-plan.applyCents === plan.targetAfterCents
        && plan.targetBeforeCents-plan.protectedFixedCents === plan.availableVariableCents
        && plan.applyCents === Math.min(plan.availableReviewCents,plan.availableVariableCents)
        && plan.residualReviewCents === plan.availableReviewCents-plan.applyCents
        && line.applyCents === plan.applyCents && line.residualReviewCents === plan.residualReviewCents;
    };
    const planValid = (plan, input) => {
      if (plan?.schemaVersion === 3) return periodPlanValid(plan,input);
      if (!previewValid(input) || plan?.schemaVersion !== 1
          || !['owner-reviewed-variable-correction-v1','owner-reviewed-variable-correction-v2'].includes(plan.policyVersion)
          || plan.originalEntryId !== input.originalEntryId || plan.targetEntryId !== input.targetEntryId
          || !uuid(plan.employeeId) || !uuid(plan.originalRunId) || plan.venueId !== scope.split(':')[1] || plan.currency !== 'RUB'
          || !sha(plan.planHash) || !sha(plan.assessmentHash) || !sha(plan.sourceHash) || !sha(plan.ledgerHash)
          || !sha(plan.originalProvenanceSha256) || !cents(plan.originalPaidCents)
          || !date(plan.originalPeriod?.from) || !date(plan.originalPeriod?.to) || plan.originalPeriod.from > plan.originalPeriod.to
          || plan.ownerDecisionRequired !== true || plan.officialReady !== false || plan.payoutEligible !== false
          || plan.persistence !== 'none' || !Array.isArray(plan.allocations) || plan.allocations.length > 20000) return false;
      if (plan.policyVersion === 'owner-reviewed-variable-correction-v2'
        ? plan.originalExpenseId !== null || plan.originalPaidCents !== 0 || !uuid(plan.originalSettlementTransitionId)
        : !uuid(plan.originalExpenseId) || plan.originalSettlementTransitionId !== undefined) return false;
      const apply = input.operation === 'apply';
      if (apply ? !uuid(plan.targetRunId) || plan.targetRunId === plan.originalRunId || !sha(plan.targetProvenanceSha256)
          || !date(plan.targetPeriod?.from) || !date(plan.targetPeriod?.to) || plan.targetPeriod.from <= plan.originalPeriod.to
          || plan.targetPeriod.from > plan.targetPeriod.to || ![plan.targetBeforeCents,plan.targetAfterCents,plan.protectedFixedCents,
            plan.availableVariableCents,plan.applyCents,plan.residualReviewCents].every(cents)
          || plan.targetAfterCents < plan.protectedFixedCents || plan.targetBeforeCents - plan.applyCents !== plan.targetAfterCents
          || plan.targetBeforeCents - plan.protectedFixedCents !== plan.availableVariableCents
        : plan.operation !== 'waive' || !cents(plan.waiveCents)) return false;
      let total = 0n, residual = 0n;
      const seen = new Set();
      for (const line of plan.allocations) {
        if (!line || typeof line !== 'object') return false;
        const amount = apply ? line.applyCents : line.waiveCents;
        if (!uuid(line.refundLineEventId) || !uuid(line.sourceSnapshotLineId) || seen.has(line.refundLineEventId)
            || ![line.assessedCents,line.alreadyDisposedCents,amount].every(cents)
            || line.alreadyDisposedCents > line.assessedCents || amount > line.assessedCents - line.alreadyDisposedCents
            || (apply && (!cents(line.residualReviewCents) || line.residualReviewCents !== line.assessedCents - line.alreadyDisposedCents - amount))
            || (!apply && amount !== line.assessedCents - line.alreadyDisposedCents)) return false;
        seen.add(line.refundLineEventId); total += BigInt(amount); if (apply) residual += BigInt(line.residualReviewCents);
      }
      return total === BigInt(apply ? plan.applyCents : plan.waiveCents) && (!apply || residual === BigInt(plan.residualReviewCents));
    };
    const commandValid = input => input && Object.keys(input).sort().join(',') === 'expectedPlanHash,idempotencyKey,operation,originalEntryId,reason,targetEntryId'
      && previewValid({operation:input.operation,originalEntryId:input.originalEntryId,targetEntryId:input.targetEntryId})
      && sha(input.expectedPlanHash) && typeof input.reason === 'string' && input.reason.trim().length >= 3 && input.reason.length <= 2000
      && typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9_.:-]{8,120}$/.test(input.idempotencyKey);
    const pending = id => {
      ensure(); if (!uuid(id)) fail('payroll_correction_ui_response_invalid');
      let raw; try { raw = storage().getItem(prefix + id); } catch (_) { fail('payroll_correction_ui_storage_unavailable'); }
      if (raw === null) return null;
      let attempt; try { attempt = JSON.parse(raw); } catch (_) { fail('payroll_correction_ui_storage_invalid'); }
      const input = attempt?.command;
      if (!commandValid(input) || input.originalEntryId !== id || !planValid(attempt.plan,
        {operation:input.operation,originalEntryId:id,targetEntryId:input.targetEntryId})
          || attempt.plan.planHash !== input.expectedPlanHash) fail('payroll_correction_ui_storage_invalid');
      return attempt;
    };
    const listPending = () => {
      ensure(); const ids = [];
      try { const saved = storage(); for (let n = 0; n < saved.length; n++) {
        const key = saved.key(n); if (key?.startsWith(prefix) && uuid(key.slice(prefix.length))) ids.push(key.slice(prefix.length));
      } } catch (_) { fail('payroll_correction_ui_storage_unavailable'); }
      return ids.sort().map(pending).filter(Boolean);
    };
    const clear = attempt => {
      try { const current = pending(attempt.command.originalEntryId);
        if (!current || JSON.stringify(current.command) !== JSON.stringify(attempt.command)) return !current;
        storage().removeItem(prefix + attempt.command.originalEntryId);
        return storage().getItem(prefix + attempt.command.originalEntryId) === null;
      } catch (_) { return false; }
    };
    const context = async (id,model='line_v1') => {
      ensure(); if (!uuid(id) || !modelValid(model)) fail('payroll_correction_ui_response_invalid');
      const period=model==='period_v2';
      const data = await request(`/api/payroll/calculation-entries/${id}/${period?'refund-aware-corrections':'corrections'}`); ensure();
      const original = data?.original;
      if (data?.schemaVersion !== (period?3:1) || period && (data.policyCode !== periodPolicy || data.officialReady !== false || data.payoutEligible !== false
            || ![data.currentPotentialCents,data.highWaterAssessedCents,data.positiveEntitlementInformationCents].every(value=>cents(value)&&value<=999999999999)
            || data.remainingCents > data.currentPotentialCents || data.currentPotentialCents > data.highWaterAssessedCents
            || data.highWaterAssessedCents > original?.netCents || data.positiveEntitlementAction !== 'none')
          || data.requiresExplicitTarget !== true || original?.id !== id || original.status !== 'paid'
          || !uuid(original.employeeId) || !uuid(original.runId) || original.venueId !== scope.split(':')[1] || original.currency !== 'RUB'
          || !cents(original.grossCents) || !cents(original.netCents) || original.netCents > original.grossCents
          || !date(original.periodFrom) || !date(original.periodTo) || original.periodFrom > original.periodTo
          || !cents(data.remainingCents) || ![data.assessmentHash,data.sourceHash,data.ledgerHash].every(sha)
          || !Array.isArray(data.targets) || data.targets.length > 200 || !Array.isArray(data.history) || data.history.length > 100000
          || data.targets.some(row=>!row || typeof row!=='object') || data.history.some(row=>!row || typeof row!=='object')
          || new Set(data.targets.map(row=>row.id)).size !== data.targets.length
          || data.targets.some(row=>!uuid(row.id) || !uuid(row.runId) || row.runId === original.runId || row.status !== 'draft'
            || row.requiresFreshPreview !== true || !date(row.periodFrom) || !date(row.periodTo) || row.periodFrom <= original.periodTo
            || row.periodFrom > row.periodTo || !cents(row.grossCents) || !cents(row.amountCents) || row.amountCents > row.grossCents)
          || data.history.some(row=>!uuid(row.id) || row.originalEntryId !== id || row.employeeId !== original.employeeId
            || !['apply','waive','release'].includes(row.kind) || !cents(row.amountCents)
            || period && (row.sourceKind !== 'period_v2' || row.refundLineEventId !== null || !uuid(row.cohortClaimId) || !uuid(row.cohortAssessmentId)))) fail('payroll_correction_ui_response_invalid');
      return data;
    };
    const preview = async (input,model='line_v1') => {
      ensure(); if (!previewValid(input) || !modelValid(model)) fail('payroll_correction_ui_target_required');
      if (pending(input.originalEntryId)) fail('payroll_correction_ui_retry_required');
      const plan = await request(`${endpoint(model)}/preview`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
      ensure(); if (!planValid(plan,input) || plan.schemaVersion !== (model==='period_v2'?3:1)) fail('payroll_correction_ui_response_invalid'); return plan;
    };
    const begin = (plan, operation, reason) => {
      ensure(); const input={operation,originalEntryId:plan?.originalEntryId,targetEntryId:plan?.targetEntryId};
      if (!planValid(plan,input)) fail('payroll_correction_ui_response_invalid');
      if (pending(input.originalEntryId)) fail('payroll_correction_ui_retry_required');
      const command={...input,expectedPlanHash:plan.planHash,reason:typeof reason==='string'?reason.trim():reason,idempotencyKey:makeKey()};
      if (!commandValid(command)) fail('payroll_correction_ui_reason_required');
      if ((operation==='apply'?plan.applyCents:plan.waiveCents) <= 0) fail('payroll_correction_nothing_to_dispose');
      const attempt={command,plan}, raw=JSON.stringify(attempt);
      try {storage().setItem(prefix+input.originalEntryId,raw);if(storage().getItem(prefix+input.originalEntryId)!==raw)throw new Error('readback');}
      catch(_){fail('payroll_correction_ui_storage_unavailable');} return attempt;
    };
    const retry = async id => {
      ensure();const attempt=pending(id);if(!attempt)fail('payroll_correction_ui_retry_missing');
      const {command,plan}=attempt;
      try {
        const period=plan.schemaVersion===3;
        const result=await request(endpoint(period?'period_v2':'line_v1'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});ensure();
        if(result?.schemaVersion!==(period?3:1) || period && (result.policyCode!==periodPolicy || result.officialReady!==false || result.payoutEligible!==false)
            || !uuid(result.batchId) || result.operation!==command.operation
            || result.planHash!==command.expectedPlanHash || result.targetEntryId!==command.targetEntryId
            || result.totalCents!==(command.operation==='apply'?plan.applyCents:plan.waiveCents)
            || result.targetAfterCents!==(command.operation==='apply'?plan.targetAfterCents:null)
            || result.residualReviewCents!==(command.operation==='apply'?plan.residualReviewCents:0)
            || typeof result.replayed!=='boolean')fail('payroll_correction_ui_response_invalid');
        return {...result,retryPending:!clear(attempt),originalRunId:plan.originalRunId,originalEntryId:id};
      }catch(error){
        const code=String(error.data?.error||error.payload?.error||error.code||error.message||'');
        const definitive=([400,409].includes(Number(error.status)) && /^payroll_(?:correction|refund_correction|entry_evidence|refund_review)_/.test(code)
          && !/idempotency|integrity|ui_/.test(code)) || (Number(error.status)===404 && code==='payroll_correction_entry_not_found');
        error.correctionAttemptRetained=!definitive||!clear(attempt);throw error;
      }
    };
    return {context,preview,begin,retry,pending,listPending,planValid};
  };
  // End economic correction controller.
  // Unpaid cohort replacement: persist the exact confirmed intent before POST.
  const createUnpaidSupersessionController = ({ request, storage, identity, makeKey }) => {
    const scope = identity(), prefix = `payroll-unpaid-supersession:v1:${scope}:`;
    const capability = 'employee_attributed_remaining_net_refund_v2';
    const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
    const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 999999999999;
    const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
    const fail = code => { throw Object.assign(new Error(`payroll_unpaid_supersession_ui_${code}`), { code:`payroll_unpaid_supersession_ui_${code}` }); };
    const ensure = () => { if (!scope || identity() !== scope) fail('owner_required'); };
    const planValid = (data, runId) => {
      const plan = data?.plan;
      if (!uuid(runId) || data?.schemaVersion !== 1 || data.originalRunId !== runId || !sha(data.planHash)
          || data.monetaryWrites !== false || data.payoutEligible !== false || plan?.schemaVersion !== 1 || plan.originalRunId !== runId
          || plan.originalCapabilityVersion !== capability || plan.replacementCapabilityVersion !== capability || plan.currency !== 'RUB'
          || ![plan.originalProvenanceSha256,plan.originalInputWatermark,plan.historicalSchemeSha256,plan.replacementInputWatermark].every(sha)
          || !date(plan.periodFrom) || !date(plan.periodTo) || !plan.periodFrom.endsWith('-01')
          || plan.periodFrom > plan.periodTo || plan.periodFrom.slice(0,7) !== plan.periodTo.slice(0,7)
          || !Array.isArray(plan.oldEntries) || !plan.oldEntries.length || plan.oldEntries.length > 10000
          || !Array.isArray(plan.employeeAmounts) || !Array.isArray(data.oldEntries) || !Array.isArray(data.replacementAmounts)
          || [plan.employeeAmounts,data.oldEntries,data.replacementAmounts].some(rows => rows.length !== plan.oldEntries.length)) return false;
      const seenEmployees = new Set(), seenEntries = new Set();
      for (let n = 0; n < plan.oldEntries.length; n++) {
        const old = plan.oldEntries[n], outer = data.oldEntries[n], next = plan.employeeAmounts[n], replacement = data.replacementAmounts[n];
        if (!old || !outer || !next || !replacement || !uuid(old.employeeId) || !uuid(old.entryId)
            || seenEmployees.has(old.employeeId) || seenEntries.has(old.entryId) || !['draft','cancelled'].includes(old.status)
            || !cents(old.grossCents) || !cents(old.amountCents) || old.amountCents > old.grossCents
            || !sha(old.stateHash) || !sha(old.ledgerHash) || !(old.financeCategoryId === null || uuid(old.financeCategoryId))
            || ['employeeId','entryId','status','grossCents','amountCents','stateHash','ledgerHash','financeCategoryId'].some(key => old[key] !== outer[key])
            || next.employeeId !== old.employeeId || !cents(next.amountCents)
            || replacement.employeeId !== next.employeeId || replacement.amountCents !== next.amountCents) return false;
        seenEmployees.add(old.employeeId); seenEntries.add(old.entryId);
      }
      return true;
    };
    const commandValid = command => command && Object.keys(command).sort().join(',') === 'expectedPlanHash,idempotencyKey,reason'
      && sha(command.expectedPlanHash) && typeof command.reason === 'string' && command.reason === command.reason.trim()
      && command.reason.length >= 3 && command.reason.length <= 500
      && typeof command.idempotencyKey === 'string' && /^[A-Za-z0-9_.:-]{8,120}$/.test(command.idempotencyKey);
    const pending = runId => {
      ensure(); if (!uuid(runId)) fail('response_invalid');
      let raw; try { raw = storage().getItem(prefix + runId); } catch (_) { fail('storage_unavailable'); }
      if (raw === null) return null;
      let attempt; try { attempt = JSON.parse(raw); } catch (_) { fail('storage_invalid'); }
      if (!commandValid(attempt?.command) || !planValid(attempt.preview,runId)
          || attempt.command.expectedPlanHash !== attempt.preview.planHash) fail('storage_invalid');
      return attempt;
    };
    const listPending = () => {
      ensure(); const ids = [];
      try { const saved = storage(); for (let n=0;n<saved.length;n++) {
        const key = saved.key(n); if (key?.startsWith(prefix) && uuid(key.slice(prefix.length))) ids.push(key.slice(prefix.length));
      } } catch (_) { fail('storage_unavailable'); }
      return ids.sort().map(pending).filter(Boolean);
    };
    const clear = attempt => {
      const runId = attempt.preview.originalRunId;
      try { const current = pending(runId);
        if (!current || JSON.stringify(current.command) !== JSON.stringify(attempt.command)) return !current;
        storage().removeItem(prefix + runId); return storage().getItem(prefix + runId) === null;
      } catch (_) { return false; }
    };
    const preview = async runId => {
      ensure(); if (!uuid(runId)) fail('response_invalid'); if (pending(runId)) fail('retry_required');
      const data = await request(`/api/payroll/calculation-runs/${runId}/supersession/preview`,
        { method:'POST',headers:{'Content-Type':'application/json'},body:'{}' });
      ensure(); if (!planValid(data,runId)) fail('response_invalid');
      // Saved-run pagination must not hide employees from the confirmation.
      const names = new Map(), cursors = new Set(); let cursor = null;
      do {
        const page = await request(`/api/payroll/calculation-runs/${runId}${cursor ? `?${new URLSearchParams({cursor})}` : ''}`); ensure();
        if (page?.runId !== runId || page.capabilityVersion !== capability || page.period?.from !== data.plan.periodFrom
            || page.period?.to !== data.plan.periodTo || !Array.isArray(page.employees) || !page.employees.length) fail('response_invalid');
        for (const row of page.employees) {
          if (!uuid(row?.employeeId) || names.has(row.employeeId) || typeof row.employeeName !== 'string'
              || !row.employeeName.trim() || names.size >= data.oldEntries.length) fail('response_invalid');
          names.set(row.employeeId,row.employeeName);
        }
        cursor = page.nextCursor;
        if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || cursors.has(cursor))) fail('response_invalid');
        if (cursor !== null) cursors.add(cursor);
      } while (cursor !== null);
      if (names.size !== data.oldEntries.length || data.oldEntries.some(row => !names.has(row.employeeId))) fail('response_invalid');
      return { preview:data, names:Object.fromEntries(names) };
    };
    const begin = (data, reason, confirmed) => {
      ensure(); if (!planValid(data,data?.originalRunId)) fail('response_invalid');
      if (pending(data.originalRunId)) fail('retry_required');
      if (confirmed !== true) fail('confirmation_required');
      const command = { expectedPlanHash:data.planHash, reason:typeof reason === 'string' ? reason.trim() : reason, idempotencyKey:makeKey() };
      if (!commandValid(command)) fail('reason_required');
      const attempt = { command,preview:data }, raw = JSON.stringify(attempt);
      try { storage().setItem(prefix + data.originalRunId,raw); if (storage().getItem(prefix + data.originalRunId) !== raw) throw new Error('readback'); }
      catch (_) { fail('storage_unavailable'); } return attempt;
    };
    const retry = async runId => {
      ensure(); const attempt = pending(runId); if (!attempt) fail('retry_missing');
      try {
        const result = await request(`/api/payroll/calculation-runs/${runId}/supersession`,
          { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(attempt.command) }); ensure();
        if (result?.schemaVersion !== 1 || !uuid(result.journalId) || result.originalRunId !== runId
            || !uuid(result.replacementRunId) || result.replacementRunId === runId || result.planHash !== attempt.command.expectedPlanHash
            || typeof result.replayed !== 'boolean' || !Array.isArray(result.entries)
            || result.entries.length !== attempt.preview.oldEntries.length) fail('response_invalid');
        const seen = new Set(), oldIds = new Set(attempt.preview.oldEntries.map(row => row.entryId));
        for (let n=0;n<result.entries.length;n++) {
          const row = result.entries[n], expected = attempt.preview.replacementAmounts[n], old = attempt.preview.oldEntries[n];
          if (!row || !uuid(row.entryId) || seen.has(row.entryId) || oldIds.has(row.entryId) || row.employeeId !== expected.employeeId
              || row.amountCents !== expected.amountCents || row.financeCategoryId !== old.financeCategoryId) fail('response_invalid');
          seen.add(row.entryId);
        }
        return { ...result,retryPending:!clear(attempt) };
      } catch (error) {
        const code = String(error.data?.error || error.payload?.error || error.code || error.message || '');
        // Only a known rejection before commit permits a new preview. Timeouts,
        // auth loss, integrity errors and idempotency conflicts retain the key.
        const definitive = [400,409].includes(Number(error.status)) && [
          'request_invalid','plan_stale','original_entry_cohort_mismatch','original_entries_not_unpaid_drafts',
          'replacement_employee_cohort_mismatch','original_run_not_v2'
        ].some(suffix => code === `payroll_unpaid_supersession_${suffix}`);
        error.supersessionAttemptRetained = !definitive || !clear(attempt); throw error;
      }
    };
    return { preview,begin,retry,pending,listPending,planValid };
  };
  // End unpaid supersession controller.
  const mountSavedRuns = (section) => {
    const identity = `${sessionUser.id}:${sessionUser.venueId}`;
    const sessionToken = localStorage.getItem('crm_session_token');
    const storagePrefix = `payroll-saved-intent:v1:${identity}:`;
    let loaded = false, loading = false, saving = false, listToken = 0, detailToken = 0;
    let listCursor = null, selectedRunId = null, reviewToken = 0, reviewSaving = false;
    let entriesToken = 0;
    const pendingEntries = new Set();
    const alive = () => {
      let current = {};
      try { current = JSON.parse(localStorage.getItem('crm_session_user') || '{}'); } catch (_) {}
      const valid = section.isConnected && current.role === 'owner'
        && localStorage.getItem('crm_session_token') === sessionToken
        && `${current.id}:${current.venueId}` === identity;
      if (!valid) { listToken++; detailToken++; section.replaceChildren(); }
      return valid && !window.__portalSessionGate?.blocked;
    };
    const savedRequest = async (path, options = {}) => {
      if (!alive()) throw new Error('session_access_unverified');
      const result = await request(path, { ...options, headers: {
        ...options.headers, ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {})
      } });
      if (!alive()) throw new Error('session_access_unverified');
      return result;
    };
    section.innerHTML = `<h3>Сохранённые расчёты</h3>
      <p class="scheme-guidance">Выберите действующую или завершённую версию и прошедший период.
      Расчёт сохранит суммы и их расшифровку. Начисления и выплаты создаются отдельно.</p>
      <form data-saved-run-form><div class="form-row">
        <label>Версия схемы<select data-saved-run-version required><option value="">Загружаем версии…</option></select></label>
        <label>С даты<input type="date" data-saved-run-from required></label>
        <label>По дату<input type="date" data-saved-run-to required></label>
      </div><p class="muted">Сейчас период должен начинаться с первого числа и заканчиваться в том же месяце, раньше сегодняшнего дня.</p>
      <div class="toolbar-row"><button class="button primary" type="submit" data-saved-run-create disabled>Рассчитать и сохранить</button>
        <button class="button" type="button" data-saved-run-reload>Обновить список</button></div></form>
      <div data-saved-run-status role="status" aria-live="polite"></div>
      <section data-correction-pending aria-live="polite"></section>
      <section data-supersession-pending aria-live="polite"></section>
      <div data-saved-run-list></div><button type="button" class="button" data-saved-run-more hidden>Следующие расчёты</button>
      <div data-saved-run-detail aria-live="polite"></div>`;
    const form = section.querySelector('[data-saved-run-form]');
    const version = section.querySelector('[data-saved-run-version]');
    const from = section.querySelector('[data-saved-run-from]'), to = section.querySelector('[data-saved-run-to]');
    const status = section.querySelector('[data-saved-run-status]');
    const list = section.querySelector('[data-saved-run-list]'), detail = section.querySelector('[data-saved-run-detail]');
    const more = section.querySelector('[data-saved-run-more]'), create = section.querySelector('[data-saved-run-create]');
    const supersessionController = createUnpaidSupersessionController({ request:savedRequest,storage:()=>sessionStorage,
      identity:()=>alive()?identity:'',makeKey:()=>crypto.randomUUID() });
    const supersessionBusy = new Set();
    let supersessionPlan = null, supersessionReadToken = 0;
    const supersessionAllowed = runId => selectedRunId === runId
      && detail.dataset.savedRunCapability === 'employee_attributed_remaining_net_refund_v2';
    const supersessionError = error => {
      const code = String(error.data?.error || error.payload?.error || error.code || error.message || '');
      return ({
        payroll_unpaid_supersession_original_entry_cohort_mismatch:'Пересчёт доступен только для полной ведомости: у каждого сотрудника должно быть сохранённое начисление. Сейчас состав неполный.',
        payroll_unpaid_supersession_original_entries_not_unpaid_drafts:'В ведомости есть утверждённое или выплаченное начисление. Пересчёт всей неоплаченной ведомости недоступен.',
        payroll_unpaid_supersession_replacement_employee_cohort_mismatch:'Состав сотрудников изменился. Пересчёт требует совпадения полного состава ведомости.',
        payroll_unpaid_supersession_run_already_superseded:'Для этой ведомости уже сохранён пересчёт. Исходная ведомость остаётся в истории.',
        payroll_unpaid_supersession_plan_stale:'Данные изменились после проверки. Получите новое сравнение и подтвердите его.',
        payroll_unpaid_supersession_ui_reason_required:'Укажите причину: от 3 до 500 символов.',
        payroll_unpaid_supersession_ui_confirmation_required:'Подтвердите замену всей ведомости после просмотра сумм.',
        payroll_unpaid_supersession_ui_retry_required:'Сначала восстановите результат предыдущего пересчёта в блоке незавершённых операций.',
        payroll_unpaid_supersession_ui_storage_unavailable:'Не удалось сохранить безопасный повтор запроса. Пересчёт не отправлен.',
        payroll_unpaid_supersession_ui_storage_invalid:'Сохранённый запрос повреждён. Новый пересчёт заблокирован до восстановления истории.',
        payroll_unpaid_supersession_ui_response_invalid:'Ответ не прошёл проверку. Пересчёт не подтверждён.',
        payroll_unpaid_supersession_original_run_not_v2:'Для этого расчёта замена неоплаченной ведомости недоступна.'
      })[code] || 'Пересчёт пока недоступен: не удалось подтвердить данные или права владельца. Сохранённые суммы доступны для просмотра.';
    };
    const renderSupersessionPending = () => {
      if (!alive()) return;
      const box = section.querySelector('[data-supersession-pending]');
      try { const pending = supersessionController.listPending();
        box.innerHTML = pending.length ? `<h4>Незавершённые пересчёты</h4><p>Результат ещё не подтверждён. Восстановление повторит исходное решение с тем же ключом.</p>${pending.map(item =>
          `<p>${escapeHtml(item.preview.plan.periodFrom)} — ${escapeHtml(item.preview.plan.periodTo)} · сотрудников: ${item.preview.oldEntries.length}<br><button type="button" class="button" data-supersession-retry="${escapeHtml(item.preview.originalRunId)}" ${supersessionBusy.has(item.preview.originalRunId)?'disabled':''}>Восстановить результат пересчёта</button></p>`).join('')}` : '';
      } catch (error) { box.textContent = supersessionError(error); }
    };
    const previewSupersession = async button => {
      const runId = selectedRunId, box = detail.querySelector('[data-supersession-content]');
      if (!alive() || !supersessionAllowed(runId) || button.disabled || !box || supersessionBusy.has(runId)) return;
      const token = ++supersessionReadToken; supersessionPlan = null; button.disabled = true;
      box.textContent = 'Проверяем всю ведомость и пересчитываем суммы…';
      const current = () => alive() && supersessionAllowed(runId) && token === supersessionReadToken && box.isConnected;
      try {
        const result = await supersessionController.preview(runId); if (!current()) return;
        supersessionPlan = result.preview;
        box.innerHTML = `<p><strong>Все сотрудники: ${result.preview.oldEntries.length}.</strong> Проверьте суммы каждого сотрудника.</p>`
          + table('Сравнение всей ведомости',['Сотрудник','Текущий статус','Было к выплате','После пересчёта','Новый статус'],
            result.preview.oldEntries.map((old,n) => `<tr><td>${escapeHtml(result.names[old.employeeId])}</td><td>${old.status==='draft'?'Черновик':'Отменено'}</td><td>${money(old.amountCents,'RUB')}</td><td>${money(result.preview.replacementAmounts[n].amountCents,'RUB')}</td><td>Черновик</td></tr>`).join(''))
          + `<p>После подтверждения прежние черновики будут отменены, а новая ведомость сохранена целиком с новыми черновиками. Уже отменённые строки останутся в истории. Выплаты не выполняются.</p>
            <label>Причина пересчёта<textarea data-supersession-reason minlength="3" maxlength="500" rows="3" required></textarea></label>
            <label><input type="checkbox" data-supersession-confirm> Я проверил суммы всех сотрудников и подтверждаю замену всей ведомости</label>
            <button type="button" class="button" data-supersession-commit>Подтвердить пересчёт всей ведомости</button><p data-supersession-message role="status"></p>`;
      } catch (error) { if (current()) { supersessionPlan = null; box.textContent = supersessionError(error); } }
      finally { if (current()) { button.disabled = false; try { button.disabled = Boolean(supersessionController.pending(runId)); } catch (_) { button.disabled = true; } } renderSupersessionPending(); }
    };
    const sendSupersession = async (runId, start = false) => {
      if (!alive() || supersessionBusy.has(runId) || (start && !supersessionAllowed(runId))) return;
      const token = detailToken, submittedPlan = supersessionPlan;
      const button = selectedRunId === runId ? detail.querySelector('[data-supersession-commit]') : null;
      const message = selectedRunId === runId ? detail.querySelector('[data-supersession-message]') : null;
      const current = () => alive() && selectedRunId === runId && token === detailToken;
      let confirmed = false;
      try {
        if (start) {
          if (!supersessionPlan || supersessionPlan.originalRunId !== runId) return;
          supersessionController.begin(supersessionPlan,detail.querySelector('[data-supersession-reason]')?.value,
            detail.querySelector('[data-supersession-confirm]')?.checked);
        }
        if (!supersessionController.pending(runId)) return;
        supersessionBusy.add(runId); if (button) button.disabled = true; renderSupersessionPending();
        const result = await supersessionController.retry(runId); confirmed = true;
        if (!alive()) return;
        if (supersessionPlan?.originalRunId === runId) supersessionPlan = null;
        status.innerHTML = `Новая ведомость сохранена. Прежняя доступна в истории. <button type="button" class="button" data-saved-run-open="${escapeHtml(result.replacementRunId)}">Открыть новую ведомость</button>`
          + (result.retryPending ? '<p>Не удалось очистить сохранённый запрос. Восстановление повторно проверит уже записанный результат.</p>' : '');
        if (token === detailToken) await openRun(result.replacementRunId);
      } catch (error) {
        if (!alive()) return;
        const text = confirmed ? 'Пересчёт сохранён, но новую ведомость не удалось загрузить. Откройте её из списка.'
          : error.supersessionAttemptRetained ? 'Результат пересчёта не подтверждён. Нажмите «Восстановить результат пересчёта»: повтор использует то же решение и тот же ключ.' : supersessionError(error);
        status.textContent = text; if (current() && message?.isConnected) message.textContent = text;
        if (error.supersessionAttemptRetained === false && supersessionPlan === submittedPlan) {
          supersessionPlan = null; if (current()) { const box = detail.querySelector('[data-supersession-content]'); if (box) box.textContent = text; }
        }
      } finally {
        supersessionBusy.delete(runId);
        if (current() && button?.isConnected && supersessionPlan === submittedPlan) {
          try { button.disabled = Boolean(supersessionController.pending(runId)); } catch (_) { button.disabled = true; }
        }
        renderSupersessionPending();
      }
    };
    // End mounted unpaid supersession actions.
    const correctionController = createReviewedCorrectionController({ request:savedRequest,storage:()=>localStorage,
      identity:()=>alive()?identity:'',makeKey:()=>crypto.randomUUID() });
    const correctionBusy = new Set();
    let correctionContext = null, correctionPlan = null, correctionReadToken = 0;
    const correctionError = error => {
      const code=String(error.data?.error||error.payload?.error||error.code||error.message||'');
      return ({ payroll_correction_ui_target_required:'Выберите черновик следующего периода.',
        payroll_correction_ui_reason_required:'Укажите причину: от 3 до 2000 символов.',
        payroll_correction_ui_retry_required:'Сначала восстановите результат предыдущего запроса в блоке незавершённых операций.',
        payroll_correction_ui_storage_unavailable:'Не удалось сохранить безопасный повтор. Операция не отправлена.',
        payroll_correction_ui_storage_invalid:'Сохранённый запрос повреждён. Новая операция заблокирована до восстановления истории.',
        payroll_correction_ui_response_invalid:'Ответ не прошёл проверку. Суммы и действие не подтверждены.',
        payroll_correction_plan_stale:'Источники или начисление изменились. Получите новый предварительный расчёт.',
        payroll_correction_nothing_to_dispose:'Подтверждённого остатка для этого действия нет.',
        payroll_correction_target_draft_invalid:'Нужен черновик этого сотрудника за период после исходной выплаты.',
        payroll_correction_assessment_required:'Возвраты или правила расчёта требуют дополнительной проверки. Корректировка недоступна.',
        payroll_correction_assessment_line_invalid:'Влияние возврата на зарплату не подтверждено. Корректировка недоступна.',
        payroll_refund_correction_current_potential_below_dispositions:'Текущая оценка меньше уже принятых решений. Новое удержание заблокировано; прежние решения автоматически не отменяются.',
        payroll_refund_correction_target_draft_invalid:'Выберите черновик этого сотрудника за период после исходной выплаты.',
        payroll_refund_correction_nothing_to_dispose:'Доступного остатка для удержания или отказа от него нет. Новый долг не создаётся.',
        payroll_refund_correction_plan_stale:'Источники или начисление изменились. Получите новый предварительный расчёт.',
        payroll_entry_evidence_source_not_current:'Исходные данные выбранного черновика изменились. Обновите расчёт.',
        payroll_correction_original_paid_basis_required:'Исходная выплата не прошла проверку. Корректировка недоступна.' })[code]
        || 'Не удалось подтвердить операцию. Проверьте данные и повторите запрос.';
    };
    const renderCorrectionPending = () => {
      if(!alive())return;
      const target=section.querySelector('[data-correction-pending]');
      try { const items=correctionController.listPending();
        target.innerHTML=items.length?`<h4>Незавершённые корректировки</h4><p>Результат этих запросов ещё не подтверждён. Повтор отправит то же решение с тем же ключом, даже если сейчас открыт другой расчёт.</p>${items.map(item=>`<p>${item.command.operation==='apply'?'Применение корректировки':'Отказ от удержания'} · исходный период ${escapeHtml(item.plan.originalPeriod.from)} — ${escapeHtml(item.plan.originalPeriod.to)} · ${money(item.command.operation==='apply'?item.plan.applyCents:item.plan.waiveCents,'RUB')}<br><button type="button" class="button" data-correction-retry="${escapeHtml(item.command.originalEntryId)}" ${correctionBusy.has(item.command.originalEntryId)?'disabled':''}>Восстановить результат</button></p>`).join('')}`:'';
      }catch(error){target.textContent=correctionError(error);}
    };
    const invalidateCorrectionPlan = () => {
      correctionReadToken++;correctionPlan=null;
      const target=detail.querySelector('[data-correction-plan]');if(target)target.textContent='Получите предварительный расчёт для выбранного действия.';
    };
    const renderCorrectionEntries = entries => {
      const target=detail.querySelector('[data-correction-content]');if(!target)return;
      correctionContext=null;correctionPlan=null;correctionReadToken++;
      const paid=entries.filter(entry=>entry.status==='paid');
      target.innerHTML=paid.length?`<label>Исходная выплата<select data-correction-original><option value="">Выберите сотрудника и выплату</option>${paid.map(entry=>`<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.employeeName||'Сотрудник')} · ${money(entry.amountCents,'RUB')} · ${escapeHtml(entry.periodFrom)} — ${escapeHtml(entry.periodTo)}</option>`).join('')}</select></label><div data-correction-context role="status"></div>`
        : '<p>Здесь появятся выплаченные начисления этого расчёта. Корректировка может уменьшить только явно выбранный черновик позднейшего периода.</p>';
    };
    const loadCorrectionContext = async originalId => {
      if (!savedRunLifecycleAllowed(selectedRunId)) return;
      const target=detail.querySelector('[data-correction-context]'),runId=selectedRunId,token=++correctionReadToken;
      correctionContext=null;correctionPlan=null;if(!target)return;
      if(!originalId){target.textContent='Выберите исходную выплату.';return;}
      target.textContent='Проверяем исходную выплату, возвраты и историю корректировок…';
      const current=()=>alive()&&target.isConnected&&selectedRunId===runId&&token===correctionReadToken
        &&detail.querySelector('[data-correction-original]')?.value===originalId;
      try {
        const model=detail.dataset?.savedRunCapability==='employee_attributed_remaining_net_refund_v2'?'period_v2':'line_v1';
        const data=await correctionController.context(originalId,model);if(!current())return;
        if(data.original.runId!==runId)throw new Error('payroll_correction_ui_response_invalid');
        correctionContext=data;
        const history=data.history.slice(-100).reverse();
        target.innerHTML=`<p>Исходное начисление: ${money(data.original.grossCents,'RUB')}. Выплачено после корректировок: ${money(data.original.netCents,'RUB')}.</p>
          <p>Подтверждённый остаток для решения: <strong>${money(data.remainingCents,'RUB')}</strong>.</p>
          <p>Исходная выплата сохраняется. Удержание уменьшает только переменную часть выбранного черновика; фиксированная часть защищена. Остаток автоматически не переносится.</p>
          ${data.schemaVersion===3?`<p>Оценка охватывает весь исходный период и учитывает ранее удержанные суммы один раз. Защищённая фиксированная часть и нулевой остаток не превращаются в дополнительный долг.</p>${data.positiveEntitlementInformationCents>0?`<p>Информация о возможном увеличении: ${money(data.positiveEntitlementInformationCents,'RUB')}. Доплата автоматически не создаётся.</p>`:''}`:''}
          <label>Действие<select data-correction-operation><option value="apply">Применить к следующему начислению</option><option value="waive">Отказаться от удержания остатка</option></select></label>
          <label data-correction-target-label>Черновик следующего периода<select data-correction-target><option value="">Выберите черновик явно</option>${data.targets.map(row=>`<option value="${escapeHtml(row.id)}">${escapeHtml(row.employeeName||'Сотрудник')} · ${escapeHtml(row.periodFrom)} — ${escapeHtml(row.periodTo)} · ${money(row.amountCents,'RUB')} · ${escapeHtml(row.schemeName||'Схема')}</option>`).join('')}</select></label>
          ${data.targets.length?'':'<p>Подходящих черновиков нет. Можно создать начисление за позднейший период или отдельно отказаться от удержания остатка.</p>'}
          <button type="button" class="button" data-correction-preview>Проверить и показать сумму</button>
          <div data-correction-plan role="status">Получите предварительный расчёт для выбранного действия.</div>
          <details><summary>История финансовых корректировок (${data.history.length})</summary>${history.map(row=>`<p>${escapeHtml({apply:'Применено',waive:'Отказ от удержания',release:'Освобождено при отмене начисления'}[row.kind])}: ${money(row.amountCents,'RUB')}<br>${escapeHtml(row.reason||'')}<br>${escapeHtml(row.createdByName||'')} ${escapeHtml(row.createdAt||'')}${row.targetEntryId?`<br>Начисление: ${escapeHtml(row.targetEntryId)}`:''}</p>`).join('')||'<p>Финансовых решений пока нет.</p>'}${data.history.length>100?'<p>Показаны последние 100 событий; итог рассчитан по всей истории.</p>':''}</details>
          <details><summary>Подтверждение источника</summary><p>Оценка: ${escapeHtml(data.assessmentHash)}</p><p>Источник: ${escapeHtml(data.sourceHash)}</p><p>Журнал: ${escapeHtml(data.ledgerHash)}</p></details>`;
        if(correctionController.pending(originalId))target.querySelector('[data-correction-preview]').disabled=true;
        renderCorrectionPending();
      }catch(error){if(current())target.textContent=correctionError(error);}
    };
    const previewCorrection = async () => {
      if (!savedRunLifecycleAllowed(selectedRunId)) return;
      const data=correctionContext,target=detail.querySelector('[data-correction-plan]');
      if(!data||!target||!alive())return;
      const operation=detail.querySelector('[data-correction-operation]').value;
      const targetId=operation==='waive'?null:detail.querySelector('[data-correction-target]').value;
      const token=++correctionReadToken,runId=selectedRunId;correctionPlan=null;target.textContent='Проверяем сумму и текущие источники…';
      const current=()=>alive()&&target.isConnected&&token===correctionReadToken&&selectedRunId===runId&&correctionContext===data;
      try {
        const plan=await correctionController.preview({operation,originalEntryId:data.original.id,targetEntryId:targetId},data.schemaVersion===3?'period_v2':'line_v1');if(!current())return;
        if(plan.employeeId!==data.original.employeeId||plan.originalRunId!==data.original.runId)throw new Error('payroll_correction_ui_response_invalid');
        correctionPlan={plan,operation};
        const selected=data.targets.find(row=>row.id===targetId);
        if(operation==='apply'&&!selected)throw new Error('payroll_correction_ui_response_invalid');
        target.innerHTML=`<h5>${operation==='apply'?'Предварительное удержание':'Предварительный отказ от удержания'}</h5>
          ${operation==='apply'?`<p>Начислено по выбранному расчёту: ${money(selected.grossCents,'RUB')}. Текущий остаток до действия: ${money(plan.targetBeforeCents,'RUB')}.</p><p>Защищённая фиксированная часть: ${money(plan.protectedFixedCents,'RUB')}. Доступная переменная часть: ${money(plan.availableVariableCents,'RUB')}.</p><p>Применить: <strong>${money(plan.applyCents,'RUB')}</strong>. К выплате после действия: <strong>${money(plan.targetAfterCents,'RUB')}</strong>.</p><p>Остаток для отдельного решения: ${money(plan.residualReviewCents,'RUB')}.</p>`
            :`<p>Не удерживать подтверждённый остаток: <strong>${money(plan.waiveCents,'RUB')}</strong>. Это самостоятельное финансовое решение; отмена другого начисления его не отменяет.</p>`}
          <p>Это предварительная сумма. При подтверждении сервер повторно проверит источники и журнал.</p>
          ${plan.schemaVersion===3?`<p>Оценка по всему периоду: ${money(plan.currentPotentialCents,'RUB')}. Уже учтено решениями: ${money(plan.alreadyDisposedCents,'RUB')}. Доступно для решения: ${money(plan.availableReviewCents,'RUB')}.</p><p>При нулевом доступном остатке новый долг не создаётся. Сумма к выплате не опускается ниже защищённой фиксированной части.</p>`:''}
          <label>Причина решения<textarea data-correction-reason minlength="3" maxlength="2000" rows="3" required></textarea></label>
          <button type="button" class="button" data-correction-commit ${(operation==='apply'?plan.applyCents:plan.waiveCents)===0?'disabled':''}>${operation==='apply'?'Применить корректировку':'Подтвердить отказ от удержания'}</button><p data-correction-message role="status"></p>`;
      }catch(error){if(current()){correctionPlan=null;target.textContent=correctionError(error);}}
    };
    const sendCorrection = async (originalId, start = false) => {
      if (start && !savedRunLifecycleAllowed(selectedRunId)) return;
      if(!alive()||correctionBusy.has(originalId))return;
      const selectedHere=()=>detail.querySelector('[data-correction-original]')?.value===originalId;
      const submittedPlan=correctionPlan?.plan.originalEntryId===originalId?correctionPlan:null;
      const message=selectedHere()?detail.querySelector('[data-correction-message]'):null;
      const commit=selectedHere()&&submittedPlan?detail.querySelector('[data-correction-commit]'):null;
      const sameCommit=()=>selectedHere()&&commit?.isConnected&&detail.querySelector('[data-correction-commit]')===commit;
      let confirmed=false;
      try {
        if(start){if(!correctionPlan||correctionPlan.plan.originalEntryId!==originalId)return;
          correctionController.begin(correctionPlan.plan,correctionPlan.operation,detail.querySelector('[data-correction-reason]')?.value);}
        const attempt=correctionController.pending(originalId);if(!attempt)return;
        correctionBusy.add(originalId);renderCorrectionPending();
        if(commit)commit.disabled=true;
        if(message)message.textContent='Записываем решение…';
        const result=await correctionController.retry(originalId);
        if(!alive())return;
        confirmed=true;
        status.textContent=result.retryPending?'Решение подтверждено, но браузер не смог удалить ключ повтора. Восстановите результат ещё раз.':'Решение записано. Обновляем актуальные суммы и историю…';
        if(correctionPlan?.plan.originalEntryId===originalId)correctionPlan=null;
        if(result.targetEntryId){
          const current=await savedRequest(`/api/payroll/calculation-runs/${encodeURIComponent(attempt.plan.targetRunId)}/entries`);
          const entry=current.items?.find(row=>row.id===result.targetEntryId);
          if(!savedEntryValid(entry,attempt.plan.targetRunId)||entry.userId!==attempt.plan.employeeId)throw new Error('payroll_correction_ui_response_invalid');
          status.textContent=`Решение записано. Текущий статус начисления: ${{draft:'черновик',approved:'утверждено',paid:'выплачено',cancelled:'отменено'}[entry.status]}. Текущая сумма: ${money(entry.amountCents,'RUB')}.`;
        }else if(!result.retryPending)status.textContent='Отказ от удержания записан. История сохранена.';
        if(selectedRunId===result.originalRunId&&detail.querySelector('[data-correction-original]')?.value===originalId)await loadCorrectionContext(originalId);
        document.dispatchEvent(new CustomEvent('payroll-run-entry-created'));
      }catch(error){
        if(alive()){
          const text=confirmed?'Решение записано, но актуальную сумму или историю загрузить не удалось. Обновите статусы начислений и историю.'
            :error.correctionAttemptRetained?'Результат запроса не подтверждён. Используйте «Восстановить результат»; новый запрос не создаётся.':correctionError(error);
          status.textContent=text;if(selectedHere()&&message?.isConnected&&detail.querySelector('[data-correction-message]')===message)message.textContent=text;
          if(error.correctionAttemptRetained===false&&correctionPlan?.plan.originalEntryId===originalId)invalidateCorrectionPlan();
        }
      }finally{
        correctionBusy.delete(originalId);
        if(alive()&&!confirmed&&sameCommit()&&correctionPlan===submittedPlan){
          try{commit.disabled=Boolean(correctionController.pending(originalId));}catch(_){commit.disabled=true;}
        }
        renderCorrectionPending();
      }
    };
    const today = venueLocalToday(), priorEnd = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    priorEnd.setUTCDate(0);
    to.value = priorEnd.toISOString().slice(0, 10); from.value = `${to.value.slice(0, 7)}-01`;
    const errorText = error => ({
      payroll_saved_run_evidence_invalid: 'Целостность сохранённого расчёта не подтверждена. Суммы скрыты.',
      payroll_saved_run_not_found: 'Расчёт или выбранная расшифровка не найдены.',
      payroll_run_outside_scheme_version: 'Период выходит за даты действия выбранной версии.',
      payroll_run_version_not_available: 'Для сохранения нужна действующая или завершённая версия.',
      payroll_run_retry_required: 'Данные изменялись одновременно. Повторите запрос.',
      payroll_run_idempotency_conflict: 'Этот запрос уже связан с другим расчётом. Обновите список.',
      payroll_run_payout_not_enabled: 'Для начислений из сохранённого расчёта утверждение и выплата пока недоступны.',
      payroll_period_overlap: 'За пересекающийся период уже есть начисление. Проверьте реестр, прежде чем создавать новое.',
      payroll_entry_idempotency_conflict: 'Этот запрос уже связан с другим начислением. Обновите статусы.',
      payroll_entry_existing_category_conflict: 'Начисление уже создано с другой статьёй. Обновите статусы и откройте его в реестре.',
      payroll_entry_calculation_sources_changed: 'Исходные данные изменились или требуют проверки. Проверьте актуальность данных и сохраните новый расчёт перед созданием начисления.',
      payroll_entry_replay_required: 'Не удалось подтвердить повторный расчёт сохранённых сумм. Проверьте воспроизводимость расчёта.',
      payroll_entry_employee_not_in_calculation: 'Сотрудник отсутствует в сохранённом расчёте. Откройте расчёт заново.',
      payroll_run_source_not_ready: 'Исходные данные пока не готовы. Проверьте актуальность данных.',
      payroll_entry_retry_storage_unavailable: 'Не удалось сохранить ключ безопасного повтора в браузере. Черновик не отправлен.',
      payroll_scheme_owner_only: 'Просмотр расчётов доступен владельцу.',
      payroll_run_source_policy_unsupported: 'Правило источников этой версии не поддерживается. Расчёт не отправлен.'
    }[error.message] || 'Не удалось получить данные. Повторите запрос.');
    const table = (caption, headers, rows) => `<div role="region" aria-label="${escapeHtml(caption)}" tabindex="0" style="max-width:100%;overflow-x:auto"><table data-saved-run-table style="min-width:${Math.max(560, headers.length * 110)}px;table-layout:auto"><caption>${escapeHtml(caption)}</caption><thead><tr>${headers.map(h => `<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    const pageButton = (attribute, cursor, label) => cursor
      ? `<button type="button" class="button" ${attribute}="${escapeHtml(cursor)}">${label}</button>` : '';
    const savedEntryValid = (entry, runId) => entry && entry.origin === 'calculation_run'
      && entry.calculationRunId === runId && typeof entry.id === 'string' && entry.id.length > 0
      && typeof entry.userId === 'string' && entry.userId.length > 0
      && ['draft', 'approved', 'paid', 'cancelled'].includes(entry.status)
      && Number.isSafeInteger(entry.amountCents) && entry.amountCents >= 0 && entry.amountCents <= 999999999999
      && entry.currency === 'RUB'
      && (entry.grossCents === undefined || (Number.isSafeInteger(entry.grossCents)
        && entry.grossCents >= entry.amountCents && entry.grossCents <= 999999999999))
      && (entry.transitionStateRequired === true
        ? Number.isSafeInteger(entry.grossCents) && typeof entry.provenanceSha256 === 'string'
          && /^[a-f0-9]{64}$/.test(entry.provenanceSha256)
          && Array.isArray(entry.allowedActions) && entry.allowedActions.length === 0
          && entry.officialReady !== true && entry.payoutEligible !== true
        : entry.transitionStateRequired === undefined && entry.officialReady === false && entry.payoutEligible === false);
    const savedRunLifecycleAllowed = runId => selectedRunId === runId
      && ['employee_attributed_merchandise_net_no_refund_v1','employee_attributed_remaining_net_refund_v2'].includes(detail.dataset.savedRunCapability);
    const savedRunLegacyReviewAllowed = runId => selectedRunId === runId
      && detail.dataset.savedRunCapability === 'employee_attributed_merchandise_net_no_refund_v1';
    const renderSavedEntry = (cell, entry, runId) => {
      if (!savedRunLifecycleAllowed(runId)) { cell.textContent = 'Начисления для этого расчёта пока недоступны.'; return; }
      const employeeId = cell.dataset.savedEntryEmployee;
      if (!entry) {
        cell.innerHTML = `<button type="button" class="button small" data-saved-entry-create="${escapeHtml(employeeId)}" ${pendingEntries.has(`${runId}:${employeeId}`) ? 'disabled' : ''}>Создать черновик начисления</button>`;
        return;
      }
      const label = { draft: 'Черновик создан', approved: 'Утверждено', paid: 'Выплачено', cancelled: 'Черновик отменён' }[entry.status];
      const amounts = Number.isSafeInteger(entry.grossCents)
        ? `Начислено: ${money(entry.grossCents, entry.currency)}<br>Корректировки: ${money(entry.grossCents - entry.amountCents, entry.currency)}<br>К выплате: ${money(entry.amountCents, entry.currency)}`
        : money(entry.amountCents, entry.currency);
      cell.innerHTML = `<strong>${label}</strong><br>${amounts}
        <br><button type="button" class="button small" data-saved-entry-register="${escapeHtml(entry.id)}" data-entry-from="${escapeHtml(entry.periodFrom)}" data-entry-to="${escapeHtml(entry.periodTo)}">Открыть в реестре</button>
        ${entry.status === 'cancelled' ? '<p class="muted">Повторное начисление из этой связи не создаётся.</p>' : ''}`;
    };
    const loadRunEntries = async runId => {
      if (!savedRunLifecycleAllowed(runId)) return;
      const target = detail.querySelector('[data-saved-entry-status]'), token = ++entriesToken;
      if (!alive() || !target || selectedRunId !== runId) return;
      detail.dataset.entriesLoaded = 'false';
      target.textContent = 'Обновляем статусы начислений…';
      detail.querySelectorAll('[data-saved-entry-create]').forEach(button => { button.disabled = true; });
      try {
        const data = await savedRequest(`/api/payroll/calculation-runs/${encodeURIComponent(runId)}/entries`);
        if (!alive() || token !== entriesToken || selectedRunId !== runId || !target.isConnected) return;
        if (!Array.isArray(data.items) || data.items.some(entry => !savedEntryValid(entry, runId))
          || new Set(data.items.map(entry => entry.userId)).size !== data.items.length) throw new Error('invalid_payroll_entries_response');
        detail.dataset.entriesLoaded = 'true';
        detail.querySelectorAll('[data-saved-entry-employee]').forEach(cell => {
          renderSavedEntry(cell, data.items.find(entry => entry.userId === cell.dataset.savedEntryEmployee), runId);
        });
        if (detail.querySelector('[data-correction-content]')) renderCorrectionEntries(data.items);
        target.textContent = data.items.length ? 'Статусы начислений обновлены.' : 'Черновики из этого расчёта ещё не созданы.';
      } catch (error) {
        if (alive() && token === entriesToken && target.isConnected) target.textContent = `Статусы не загружены. ${errorText(error)} Нажмите «Обновить статусы начислений».`;
      }
    };
    const loadEntryCategories = async runId => {
      if (!savedRunLifecycleAllowed(runId)) return;
      const select = detail.querySelector('[data-saved-entry-category]');
      const hint = detail.querySelector('[data-saved-entry-category-hint]');
      try {
        const data = await savedRequest('/api/finance/categories');
        if (!alive() || selectedRunId !== runId || !select?.isConnected) return;
        if (!Array.isArray(data.items)) throw new Error('invalid_finance_categories');
        select.innerHTML = '<option value="">Без статьи</option>' + data.items.filter(item => item.active !== false && item.kind === 'expense')
          .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
        select.disabled = false;
        select._customSelectRefresh?.();
        hint.textContent = 'Статья закрепляется при создании черновика. Изменение выбора относится только к новым черновикам.';
      } catch (_) {
        if (alive() && select?.isConnected) {
          select.innerHTML = '<option value="">Без статьи</option>';
          hint.textContent = 'Статьи не загрузились. Сейчас можно создать черновик без статьи или повторить загрузку.';
        }
      }
    };
    const createRunEntry = async button => {
      const runId = selectedRunId, employeeId = button.dataset.savedEntryCreate;
      if (!savedRunLifecycleAllowed(runId)) return;
      const target = detail.querySelector('[data-saved-entry-status]');
      const pendingKey = `${runId}:${employeeId}`;
      if (!alive() || button.disabled || !target || !runId || pendingEntries.has(pendingKey)) return;
      const financeCategoryId = detail.querySelector('[data-saved-entry-category]')?.value || null;
      const storageKey = `payroll-run-entry:v1:${identity}:${runId}:${employeeId}:${financeCategoryId || ''}`;
      pendingEntries.add(pendingKey); button.disabled = true;
      target.textContent = 'Создаём черновик по сохранённой сумме…';
      try {
        let idempotencyKey;
        try {
          idempotencyKey = sessionStorage.getItem(storageKey) || crypto.randomUUID();
          sessionStorage.setItem(storageKey, idempotencyKey);
          if (sessionStorage.getItem(storageKey) !== idempotencyKey) throw new Error('storage_write_failed');
        } catch (_) { throw new Error('payroll_entry_retry_storage_unavailable'); }
        const data = await savedRequest(`/api/payroll/calculation-runs/${encodeURIComponent(runId)}/entries`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employeeId, financeCategoryId, idempotencyKey })
        });
        const entry = Object.prototype.hasOwnProperty.call(data, 'currentEntry') ? data.currentEntry : data.entry;
        if (data.schemaVersion !== 1 || !savedEntryValid(entry, runId) || entry.userId !== employeeId) throw new Error('invalid_payroll_entry_response');
        try { sessionStorage.removeItem(storageKey); } catch (_) {}
        if (!alive() || selectedRunId !== runId || !target.isConnected) return;
        // An earlier GET must not replace the just-committed entry with its
        // pre-write empty result when its response arrives later.
        entriesToken += 1;
        const cell = button.closest('[data-saved-entry-employee]');
        if (cell?.isConnected) renderSavedEntry(cell, entry, runId);
        target.textContent = entry.status === 'cancelled' ? 'Найдено ранее отменённое начисление. Новый черновик не создан.'
          : data.replayed || data.existing ? 'Найден ранее созданный черновик. Дубликат не создан.'
            : 'Черновик начисления создан. Откройте реестр, проверьте сумму и доступные действия.';
        document.dispatchEvent(new CustomEvent('payroll-run-entry-created'));
      } catch (error) {
        if (alive() && selectedRunId === runId && target.isConnected) {
          const reasons = error.data?.reasons;
          target.textContent = `${errorText(error)}${Array.isArray(reasons) && reasons.length ? ` ${reasons.map(readinessReasonLabel).join(' ')}` : ''} При повторе с той же статьёй используется тот же ключ запроса.`;
        }
      } finally {
        pendingEntries.delete(pendingKey);
        if (alive() && selectedRunId === runId && detail.dataset.entriesLoaded === 'true') detail.querySelectorAll('[data-saved-entry-create]').forEach(control => {
          if (control.dataset.savedEntryCreate === employeeId) control.disabled = false;
        });
      }
    };
    const incentiveDetails = (value, currency) => {
      const labels = { basisCents: 'База', targetCents: 'План', belowTargetCents: 'Часть до плана', excessCents: 'Часть сверх плана',
        baseBasisCents: 'База основной ставки', baseCommissionCents: 'Основная комиссия', excessCommissionCents: 'Комиссия сверх плана',
        additiveCommissionCents: 'Доплата по товару', commissionCents: 'Комиссия', payableBasisCents: 'База распределения',
        signedMarginCents: 'Маржа', payableMarginCents: 'Маржа для расчёта', positiveMarginCents: 'Положительная маржа',
        lossCents: 'Убыток', lossOffsetCents: 'Зачтённый убыток', baseRateBps: 'Основная ставка', bonusRateBps: 'Ставка сверх плана',
        itemRateBps: 'Ставка товара' };
      return Object.entries(labels).filter(([key]) => Number.isSafeInteger(value?.[key])).map(([key, label]) =>
        `<span>${label}: ${key.endsWith('Bps') ? `${value[key] / 100}%` : money(value[key], currency)}</span>`).join(' · ');
    };
    const savedLineRule = (row, currency) => {
      const label = { personal_target: 'Комиссия по личному плану', margin_target: 'Комиссия по плану маржи',
        team_source: 'Участие строки в командном фонде' }[row.commissionKind]
        || (row.commissionKind === 'scalar' && Number.isSafeInteger(row.appliedRateBps) ? `${row.appliedRateBps / 100}%` : 'Сохранённое правило');
      const amount = value => Number.isSafeInteger(value) ? money(value, currency) : 'нет сохранённых данных';
      if (row.commissionKind === 'margin_target') return `${label}<p>Себестоимость: ${amount(row.netCostCents)}. Маржа: ${amount(row.signedMarginCents)}.</p>`;
      if (row.commissionKind === 'team_source') {
        const reason = { item_replacement: 'для товара назначена отдельная комиссия',
          department_outside_pool: 'цех не входит в фонд' }[row.poolExclusionReason];
        const inclusion = row.poolIncluded === true ? 'Включена в фонд' : row.poolIncluded === false
          ? `Не включена в фонд${reason ? `: ${reason}` : ' (причина не распознана)'}` : 'Участие не подтверждено';
        return `${label}<p>${inclusion}. Вклад строки в базу фонда: ${amount(row.poolBasisCents)}.</p><p>Командная выплата показана в итогах сотрудника за день. В колонке «Комиссия» указана только комиссия по товару.</p>`;
      }
      return label;
    };
    const dayDetails = (day, currency) => `<details><summary>Как рассчитано</summary>
      <p>Роль: ${escapeHtml(editorRoleLabel(day.roleId))} · ${escapeHtml(EDITOR_CHOICE_LABELS[day.mode] || day.mode)} · смен: ${escapeHtml(day.shifts)}</p>
      <p>Базовая часть ${money(day.basePayCents, currency)} + комиссия ${money(day.commissionCents, currency)}
        + командная часть ${money(day.teamFundCents, currency)} + премии ${money(day.milestoneBonusCents, currency)}
        + корректировки ${money(day.itemAdjustmentsCents, currency)} = ${money(day.amountBeforeCapCents, currency)} до лимита.</p>
      <p>Лимит: ${day.capCents === null ? 'не задан' : money(day.capCents, currency)}.
        Уменьшение: ${money(day.capReductionCents, currency)}. Итого: ${money(day.amountCents, currency)}.</p>
      <p>${incentiveDetails(day.incentive, currency)}</p>
      ${(day.explanation?.shiftDetails || []).map(shift => `<p>Смена: ${escapeHtml(shift.workedMinutes)} из ${escapeHtml(shift.plannedMinutes)} мин. · ${money(shift.amountCents, currency)}</p>`).join('')}
      ${(day.explanation?.milestoneDecisions || []).map(decision => `<p>Порог ${money(decision.thresholdCents, currency)}:
        ${decision.eligible ? 'условия выполнены' : 'условия не выполнены'} · премия до лимита ${money(decision.awardedAmountCents, currency)}</p>`).join('')}</details>`;
    const loadList = async (cursor = null) => {
      if (!alive()) return;
      const token = ++listToken; more.hidden = true; list.textContent = 'Загружаем расчёты…';
      try {
        const query = new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}) });
        const data = await savedRequest(`/api/payroll/calculation-runs?${query}`);
        if (!alive() || token !== listToken) return;
        listCursor = data.nextCursor;
        list.innerHTML = data.items.length ? table('Сохранённые расчёты', ['Период', 'Схема', 'Сумма', 'Сохранил', 'Действие'],
          data.items.map(row => `<tr><td>${escapeHtml(row.period.from)} — ${escapeHtml(row.period.to)}</td>
          <td>${escapeHtml(row.scheme.name)} · версия ${escapeHtml(row.scheme.versionNo)}</td>
          <td>${money(row.amountCents, row.currency)}</td><td>${escapeHtml(row.createdByName)}<br>${escapeHtml(row.createdAt)}</td>
          <td><button type="button" class="button small" data-saved-run-open="${escapeHtml(row.runId)}">Открыть</button></td></tr>`).join(''))
          : '<p class="empty">Сохранённых расчётов пока нет.</p>';
        more.hidden = !listCursor;
      } catch (error) { if (alive() && token === listToken) list.textContent = errorText(error); }
    };
    const openRun = async (runId, cursor = null) => {
      if (!alive()) return;
      selectedRunId = runId;
      delete detail.dataset.savedRunCapability;
      correctionContext = null; correctionPlan = null; correctionReadToken++;
      supersessionPlan = null; supersessionReadToken++;
      const token = ++detailToken;
      detail.textContent = 'Загружаем сохранённую расшифровку…';
      try {
        const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
        const data = await savedRequest(`/api/payroll/calculation-runs/${encodeURIComponent(runId)}${query}`);
        if (!alive() || token !== detailToken) return;
        if (data.runId !== runId) throw new Error('invalid_saved_run_response');
        detail.dataset.savedRunCapability = data.capabilityVersion || '';
        const lifecycleAllowed = savedRunLifecycleAllowed(runId);
        const legacyReviewAllowed = savedRunLegacyReviewAllowed(runId);
        detail.innerHTML = `<h4>${escapeHtml(data.scheme.name)} · версия ${escapeHtml(data.scheme.versionNo)}</h4>
          <p>${escapeHtml(data.period.from)} — ${escapeHtml(data.period.to)} · ${escapeHtml(data.venueTimezone)}</p>
          <p><strong>Итого: ${money(data.amountCents, data.currency)}</strong></p>
          ${lifecycleAllowed ? '<p>Расчёт сохранён. Для каждого сотрудника можно создать черновик начисления по сохранённой сумме.</p><p class="scheme-guidance">Откройте начисление в реестре: владелец может проверить источники, утвердить сумму и зарегистрировать выплату. Перед каждым действием источники проверяются заново.</p>'
            : '<p class="scheme-guidance" data-saved-run-read-only>Этот расчёт доступен для просмотра и проверки. Создание начислений, выплаты и финансовые корректировки для него пока недоступны.</p>'}
          <p>${data.replayAvailable === true
            ? '<button type="button" class="button" data-saved-run-replay>Проверить воспроизводимость</button>'
            : data.replay?.state === 'engine_unavailable' ? 'Для проверки нужна версия расчётного движка, использованная при сохранении.'
              : 'Этот расчёт сохранён без полного набора данных для повторного вычисления.'}</p>
          <p data-saved-replay-status role="status"></p>
          <p><button type="button" class="button" data-saved-run-freshness>Проверить актуальность данных</button></p>
          <div data-saved-freshness-status role="status">Актуальность исходных данных ещё не проверена.</div>
          <p class="muted">Проверка учитывает изменения после сохранения расчёта. Совпадение данных на момент проверки само по себе не разрешает выплату.</p>
          ${supersessionAllowed(runId) ? `<section aria-label="Пересчёт неоплаченной ведомости"><h4>Пересчёт неоплаченной ведомости</h4>
            <p>Проверим полный состав и покажем новые суммы. Нужны начисления для всех сотрудников: только черновики или уже отменённые строки. Утверждённые и выплаченные ведомости здесь не заменяются.</p>
            <button type="button" class="button" data-supersession-preview>Пересчитать неоплаченную ведомость</button><div data-supersession-content role="status"></div></section>` : ''}
          ${legacyReviewAllowed ? `<section data-refund-review-panel><h4>Возвраты после расчёта</h4>
            <p>Проверьте влияние возвратов на сохранённый расчёт и запишите решение.</p>
            <button type="button" class="button" data-refund-review-check>Проверить возвраты</button>
            <div data-refund-review-content role="status">Загружаем историю проверок…</div>
          </section>` : ''}
          ${lifecycleAllowed ? `<section aria-label="Финансовые корректировки"><h4>Корректировка следующего начисления</h4><p>${legacyReviewAllowed?'Применение удержания и отказ от него записываются отдельно от решений по проверке возвратов выше.':'После выплаты можно оценить изменение премии за весь период, выбрать будущий черновик или отказаться от удержания. Автоматического долга или доплаты нет.'}</p><div data-correction-content>Загружаем выплаченные начисления…</div></section>
          <section aria-label="Черновики начислений"><h4>Создать начисления</h4>
          <label>Статья расхода для новых черновиков<select data-saved-entry-category disabled><option value="">Без статьи</option></select></label>
          <p class="muted" data-saved-entry-category-hint>Загружаем статьи. По умолчанию черновик создаётся без статьи.</p>
          <div class="toolbar-row"><button type="button" class="button" data-saved-entry-reload>Обновить статусы начислений</button>
          <button type="button" class="button" data-saved-entry-categories-reload>Обновить статьи</button></div>
          <p data-saved-entry-status role="status">Загружаем статусы начислений…</p>` : '<section aria-label="Сотрудники расчёта"><h4>Сотрудники</h4>'}
          ${table('Сотрудники', ['Сотрудник', 'Сумма', 'Дней', 'Расшифровка', ...(lifecycleAllowed ? ['Начисление'] : [])], data.employees.map(row => `<tr>
            <td>${escapeHtml(row.employeeName)}</td><td>${money(row.amountCents, data.currency)}</td><td>${escapeHtml(row.dayCount)}</td>
            <td><button type="button" class="button small" data-saved-employee="${escapeHtml(row.employeeId)}">По дням</button></td>
            ${lifecycleAllowed ? `<td data-saved-entry-employee="${escapeHtml(row.employeeId)}">Проверяем начисления…</td>` : ''}</tr>`).join(''))}
          </section>
          ${pageButton('data-saved-employees-next', data.nextCursor, 'Следующие сотрудники')}
          <div data-saved-employee-detail></div>`;
        if (lifecycleAllowed) {
          if (legacyReviewAllowed) void loadRefundReview(runId);
          void loadRunEntries(runId);
          void loadEntryCategories(runId);
        }
      } catch (error) { if (alive() && token === detailToken) detail.textContent = errorText(error); }
    };
    const replayRun = async button => {
      const runId = selectedRunId, target = detail.querySelector('[data-saved-replay-status]');
      if (!alive() || button.disabled || !target || !runId) return;
      button.disabled = true;
      target.textContent = 'Повторяем вычисление по сохранённым данным…';
      try {
        const data = await savedRequest(`/api/payroll/calculation-runs/${encodeURIComponent(runId)}/replay`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        if (!alive() || selectedRunId !== runId || !target.isConnected) return;
        const check = data.verification;
        target.textContent = check?.status === 'matched' && check.matched === true && check.replayVerified === true
          ? 'Повторный расчёт совпал с сохранённым. Суммы не изменены.'
          : check?.status === 'engine_unavailable' ? 'Нужная версия расчётного движка недоступна. Сохранённые суммы не изменены.'
            : check?.status === 'not_recorded' ? 'Данные для повторного вычисления не были сохранены.'
              : 'Проверка не подтвердила совпадение. Сохранённые суммы не изменены.';
      } catch (error) { if (alive() && selectedRunId === runId && target.isConnected) target.textContent = errorText(error); }
      finally { if (button.isConnected) button.disabled = false; }
    };
    const reviewDecisionLabels = { hold_for_review: 'Оставить на проверке',
      close_without_payroll_change: 'Закрыть без изменения зарплаты', acknowledge_no_effect: 'Подтвердить отсутствие влияния' };
    const reviewViews = new WeakMap();
    const reviewReasonLabel = code => ({
      payroll_refund_review_nonlinear_mode_unsupported: 'Для схемы с планом, ступенями или командным фондом требуется отдельный расчёт влияния.',
      payroll_refund_review_nonlinear_components_unsupported: 'Лимиты или премии могут изменить результат. Простого пересчёта процента недостаточно.',
      payroll_refund_review_remaining_personal_ceiling_conflict: 'После возврата остаток личной выручки меньше рассчитанной выплаты. Требуется проверка условий оплаты.',
      payroll_refund_review_source_coverage_incomplete: 'Недостаточно подтверждённых данных о возвратах.',
      payroll_refund_review_all_time_coverage_mismatch: 'Набор возвратов не совпадает с подтверждённой историей.',
      payroll_refund_review_original_line_mismatch: 'Не подтверждена связь продажи с исходной строкой зарплатного расчёта.',
      payroll_refund_review_original_line_coverage_incomplete: 'Не все строки исходного расчёта удалось сверить.',
      payroll_refund_review_replay_unavailable: 'Нужная версия расчётного движка или сохранённые данные недоступны.',
      payroll_refund_review_replay_invalid: 'Повторное вычисление исходного расчёта не подтверждено.',
      payroll_refund_review_refund_item_unavailable: 'Возврат не распределён по товарным строкам.',
      payroll_refund_review_refund_lineage_mismatch: 'Не подтверждена связь возврата с исходной продажей.',
      payroll_refund_review_return_history_mismatch: 'Накопленные возвраты требуют сверки.',
      payroll_refund_review_scalar_lineage_or_amount_unsupported: 'Последовательность возвратов или комиссия по строке требуют проверки.',
      payroll_refund_review_return_amount_invalid: 'Суммы возврата не удалось подтвердить.',
      payroll_refund_review_amount_out_of_range: 'Результат выходит за допустимый диапазон расчёта.'
    }[code] || 'Влияние требует дополнительной проверки данных и правил расчёта.');
    const renderRefundReview = (target, data, visible = 100) => {
      const assessment = data.latestAssessment, payload = assessment?.payload;
      if (data.runId !== selectedRunId || data.basis !== 'saved_calculation_unposted'
          || data.officialReady !== false || data.payoutEligible !== false || !payload
          || payload.officialReady !== false || payload.payoutEligible !== false || !Array.isArray(payload.lines)
          || !Array.isArray(data.decisions) || !Array.isArray(data.assessments)) throw new Error('invalid_refund_review_response');
      const amount = value => Number.isSafeInteger(value) ? money(value, payload.currency) : 'Требуется проверка';
      const decisions = data.decisions.filter(row => row.assessmentHash === assessment.assessmentHash);
      const closed = decisions.some(row => ['close_without_payroll_change', 'acknowledge_no_effect'].includes(row.decision));
      reviewViews.set(target, { data, visible });
      target.innerHTML = `<p><strong>Оценка изменения зарплаты: ${amount(payload.impactCents)}</strong></p>
        <p>Строк возврата: ${escapeHtml(payload.lines.length)}. ${closed ? 'Решение по этой проверке записано.' : data.status === 'hold_for_review' ? 'Оставлено на проверке владельца.' : 'Ожидает решения владельца.'}</p>
        <p class="muted">Это проверка сохранённого расчёта. Решения здесь не создают начисление, удержание или выплату.</p>
        ${(payload.reasons || []).length ? `<details><summary>Что требует проверки</summary><ul>${[...new Set(payload.reasons.map(reviewReasonLabel))].map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></details>` : ''}
        ${payload.lines.length ? table('Возвраты и влияние на зарплату', ['Дата возврата', 'Сотрудник / товар', 'Возврат товаров', 'Изменение зарплаты'], payload.lines.slice(0, visible).map(row => `<tr>
          <td>${escapeHtml(row.refundRecognizedDate || 'Дата не подтверждена')}</td>
          <td>${escapeHtml(row.employeeName || 'Сотрудник требует сверки')}<br>${escapeHtml(row.menuItemName || 'Строка продажи')}
            <details><summary>Источник</summary><p>Возврат: ${escapeHtml(row.refundId || 'не подтверждён')}</p><p>Заказ: ${escapeHtml(row.orderId || 'не подтверждён')}</p></details></td>
          <td>${amount(row.merchandiseDeltaCents)}</td><td>${amount(row.salaryImpactCents)}</td></tr>`).join(''))
          : payload.coverage === 'complete' ? '<p>Возвраты по продажам этого расчёта не найдены.</p>' : '<p>Строк для отображения нет. Полнота данных не подтверждена.</p>'}
        ${payload.lines.length > visible ? `<p>Показано ${visible} из ${payload.lines.length} строк.</p><button class="button" type="button" data-refund-review-more>Показать ещё 100 строк</button>` : ''}
        ${closed ? '' : `<div data-refund-review-decision-fields>
          <label>Решение<select data-refund-review-decision>${Object.entries(reviewDecisionLabels)
            .filter(([key]) => key !== 'acknowledge_no_effect' || (payload.coverage === 'complete' && payload.impactCents === 0))
            .map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join('')}</select></label>
          <label>Причина решения<textarea data-refund-review-reason minlength="3" maxlength="2000" rows="3" required></textarea></label>
          <button class="button" type="button" data-refund-review-decide data-case-id="${escapeHtml(data.caseId)}"
            data-assessment-hash="${escapeHtml(assessment.assessmentHash)}">Записать решение</button>
        </div>`}
        <div data-refund-review-message role="status"></div>
        <details><summary>История решений (${data.decisions.length})</summary>${data.decisions.length ? data.decisions.map(row => `<p>
          <strong>${escapeHtml(reviewDecisionLabels[row.decision] || 'Решение')}</strong> · ${escapeHtml(row.createdByName || '')} · ${escapeHtml(row.createdAt || '')}<br>
          ${escapeHtml(row.reason)}${row.assessmentHash !== assessment.assessmentHash ? '<br>Относится к предыдущей проверке.' : ''}</p>`).join('') : '<p>Решений пока нет.</p>'}</details>
        <p class="muted">${data.historyTruncated?.assessments ? 'Показаны последние' : 'Сохранено проверок:'} ${data.assessments.length}. Новые возвраты требуют новой проверки.</p>
        ${data.historyTruncated?.decisions ? '<p class="muted">Показаны последние 100 решений. Более ранние решения сохранены в журнале.</p>' : ''}`;
    };
    const moreRefundReview = () => {
      const target = detail.querySelector('[data-refund-review-content]'), view = target && reviewViews.get(target);
      if (!alive() || reviewSaving || !view) return;
      const reason = target.querySelector('[data-refund-review-reason]')?.value;
      const decision = target.querySelector('[data-refund-review-decision]')?.value;
      renderRefundReview(target, view.data, view.visible + 100);
      if (reason !== undefined) target.querySelector('[data-refund-review-reason]').value = reason;
      if (decision !== undefined) target.querySelector('[data-refund-review-decision]').value = decision;
    };
    const loadRefundReview = async (runId, caseId = null) => {
      if (!savedRunLegacyReviewAllowed(runId)) return;
      const target = detail.querySelector('[data-refund-review-content]');
      if (!alive() || !target || selectedRunId !== runId) return;
      const token = ++reviewToken;
      try {
        if (!caseId) {
          const list = await savedRequest(`/api/payroll/refund-reviews?${new URLSearchParams({ runId, limit: '1' })}`);
          if (!alive() || selectedRunId !== runId || !target.isConnected || token !== reviewToken) return;
          caseId = list.items?.[0]?.caseId;
          if (!caseId) { target.textContent = 'Сохранённых проверок пока нет.'; return; }
        }
        const data = await savedRequest(`/api/payroll/refund-reviews/${encodeURIComponent(caseId)}`);
        if (!alive() || selectedRunId !== runId || !target.isConnected || token !== reviewToken) return;
        renderRefundReview(target, data);
      } catch (error) { if (alive() && selectedRunId === runId && target.isConnected && token === reviewToken) target.textContent = errorText(error); }
    };
    const mutateRefundReview = async (button, isDecision) => {
      const runId = selectedRunId, target = detail.querySelector('[data-refund-review-content]');
      if (!savedRunLegacyReviewAllowed(runId)) return;
      if (!alive() || button.disabled || reviewSaving || !target || !runId) return;
      const message = isDecision ? target.querySelector('[data-refund-review-message]') : target;
      const input = isDecision ? { decision: target.querySelector('[data-refund-review-decision]').value,
        reason: target.querySelector('[data-refund-review-reason]').value.trim(), expectedAssessmentHash: button.dataset.assessmentHash } : {};
      if (isDecision && input.reason.length < 3) { message.textContent = 'Укажите причину решения: не менее трёх символов.'; return; }
      const storageKey = `payroll-refund-review:${identity}:${runId}:${JSON.stringify(input)}`;
      let requestKey;
      try {
        requestKey = sessionStorage.getItem(storageKey) || crypto.randomUUID();
        sessionStorage.setItem(storageKey, requestKey);
      } catch (_) { message.textContent = 'Не удалось сохранить ключ запроса. Разрешите хранение данных для этого сайта и повторите.'; return; }
      button.disabled = true;
      reviewSaving = true; reviewToken++;
      const fields = [...target.querySelectorAll('select,textarea')];
      fields.forEach(field => { field.disabled = true; });
      message.textContent = isDecision ? 'Записываем решение…' : 'Проверяем возвраты…';
      try {
        const path = isDecision ? `/api/payroll/refund-reviews/${encodeURIComponent(button.dataset.caseId)}/decisions`
          : `/api/payroll/calculation-runs/${encodeURIComponent(runId)}/refund-reviews`;
        const data = await savedRequest(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, idempotencyKey: requestKey }) });
        sessionStorage.removeItem(storageKey);
        if (!alive() || selectedRunId !== runId || !target.isConnected) return;
        await loadRefundReview(runId, data.caseId);
      } catch (error) {
        if (alive() && selectedRunId === runId && target.isConnected) {
          message.textContent = error?.status === 409
            ? 'Данные изменились или решение уже записано. Нажмите «Проверить возвраты», затем сверьте историю и повторите решение.' : errorText(error);
        }
      } finally {
        reviewSaving = false;
        if (button.isConnected) button.disabled = false;
        fields.forEach(field => { if (field.isConnected) field.disabled = false; });
      }
    };
    const checkFreshness = async button => {
      const runId = selectedRunId, target = detail.querySelector('[data-saved-freshness-status]');
      if (!alive() || button.disabled || !target || !runId) return;
      button.disabled = true;
      target.textContent = 'Сверяем продажи, возвраты и подтверждения с сохранённым расчётом…';
      try {
        const data = await savedRequest(`/api/payroll/calculation-runs/${encodeURIComponent(runId)}/freshness`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        if (!alive() || selectedRunId !== runId || !target.isConnected) return;
        if (data.runId !== runId || data.officialReady !== false || data.payoutEligible !== false
            || data.persistence !== 'none' || data.validity !== 'transaction_snapshot_only'
            || !['current', 'stale', 'blocked'].includes(data.status) || !Array.isArray(data.reasons)
            || (data.status === 'current' && (data.sourceChanged !== false || data.reasons.length))) {
          throw new Error('invalid_freshness_response');
        }
        const labels = { current: 'Исходные данные совпадают на момент проверки.',
          stale: 'Исходные данные изменились. Для актуальных сумм нужен новый расчёт.',
          blocked: 'Актуальность расчёта не подтверждена: исходные данные требуют проверки.' };
        const reasons = [...new Set(data.reasons.map(readinessReasonLabel))];
        const at = new Date(data.checkedAt);
        target.innerHTML = `<p>${escapeHtml(labels[data.status])} Сохранённые суммы не изменены.</p>`
          + (reasons.length ? `<details><summary>Причины проверки (${reasons.length})</summary><ul>${reasons
            .map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></details>` : '')
          + (Number.isFinite(at.getTime()) ? `<p class="muted">Проверено: ${escapeHtml(at.toLocaleString('ru-RU'))}.</p>` : '');
      } catch (error) { if (alive() && selectedRunId === runId && target.isConnected) target.textContent = errorText(error); }
      finally { if (button.isConnected) button.disabled = false; }
    };
    const openEmployee = async employeeId => {
      const runId = selectedRunId, token = ++detailToken;
      const target = detail.querySelector('[data-saved-employee-detail]');
      if (!target || !alive()) return;
      target.textContent = 'Загружаем дни…';
      try {
        const data = await savedRequest(`/api/payroll/calculation-runs/${runId}/employees/${encodeURIComponent(employeeId)}`);
        if (!alive() || token !== detailToken) return;
        target.innerHTML = `<h4>${escapeHtml(data.employeeName)} · ${money(data.amountCents, data.currency)}</h4>
          ${table('Расчёт по дням', ['Дата', 'Базовая часть', 'Комиссия', 'Премия', 'Уменьшение по лимиту', 'Итого', 'Расшифровка'],
            data.days.map(day => `<tr><td>${escapeHtml(day.localDate)}</td><td>${money(day.basePayCents, data.currency)}</td>
              <td>${money(day.commissionCents, data.currency)}</td><td>${money(day.milestoneBonusCents, data.currency)}</td>
              <td>${money(day.capReductionCents, data.currency)}</td><td>${money(day.amountCents, data.currency)}</td>
              <td>${dayDetails(day, data.currency)}<button type="button" class="button small" data-saved-day="${escapeHtml(day.snapshotId)}">Строки продажи</button></td></tr>`).join(''))}
          <div data-saved-lines></div>`;
      } catch (error) { if (alive() && token === detailToken) target.textContent = errorText(error); }
    };
    const openLines = async (snapshotId, cursor = null) => {
      const runId = selectedRunId, token = ++detailToken;
      const target = detail.querySelector('[data-saved-lines]');
      if (!target || !alive()) return;
      target.textContent = 'Загружаем строки…';
      try {
        const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
        const data = await savedRequest(`/api/payroll/calculation-runs/${runId}/days/${encodeURIComponent(snapshotId)}/lines${query}`);
        if (!alive() || token !== detailToken) return;
        target.dataset.snapshotId = snapshotId;
        target.innerHTML = table(`Продажи за ${data.localDate}`, ['Товар', 'Кол-во', 'До скидок', 'Скидка', 'Возврат', 'База', 'Правило расчёта', 'Комиссия'],
          data.items.map(row => `<tr><td>${escapeHtml(row.menuItemName)}</td><td>${escapeHtml(row.quantity)}</td>
          <td>${money(row.grossCents, data.currency)}</td><td>${money(row.discountCents, data.currency)}</td>
          <td>${money(row.refundCents, data.currency)}</td><td>${money(row.commissionBaseCents, data.currency)}</td>
          <td>${savedLineRule(row, data.currency)}
            <details><summary>Правило</summary>${incentiveDetails(row.incentive, data.currency)}
            ${row.incentive?.itemRuleMode ? `<p>${escapeHtml({ inherit: 'Ставка роли', replace: 'Ставка товара вместо основной', additive: 'Доплата к основной ставке' }[row.incentive.itemRuleMode] || 'Правило товара')}</p>` : ''}</details></td>
          <td>${money(row.commissionCents, data.currency)}</td></tr>`).join(''))
          + pageButton('data-saved-lines-next', data.nextCursor, 'Следующие строки');
      } catch (error) { if (alive() && token === detailToken) target.textContent = errorText(error); }
    };
    const activate = async () => {
      if (!alive() || loading) return;
      renderCorrectionPending();
      renderSupersessionPending();
      if (loaded) { await loadList(); return; }
      loading = true;
      try {
        const session = await savedRequest('/api/session');
        if (!alive()) return;
        if (session.user?.role !== 'owner' || `${session.user?.id}:${session.user?.venueId}` !== identity) {
          section.textContent = 'Площадка или пользователь изменились. Обновите страницу.'; return;
        }
        const data = await savedRequest('/api/payroll/schemes');
        if (!alive()) return;
        version.innerHTML = '<option value="">Выберите сохранённую версию</option>' + data.items.flatMap(scheme =>
          (scheme.versions || []).filter(v => ['active', 'retired'].includes(v.status)).map(v =>
            `<option value="${escapeHtml(v.id)}">${escapeHtml(scheme.name)} · версия ${escapeHtml(v.versionNo)} (${escapeHtml(v.effectiveFrom)} — ${escapeHtml(v.effectiveTo || 'без окончания')})</option>`)).join('');
        version._customSelectRefresh?.();
        loaded = true; create.disabled = false;
        await loadList();
      } catch (error) { if (alive()) status.textContent = errorText(error); }
      finally { loading = false; }
    };
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!alive() || saving || !loaded) return;
      const input = { schemeVersionId: version.value, periodFrom: from.value, periodTo: to.value };
      if (!input.schemeVersionId || !sourceReadinessPeriodValid(input.periodFrom, input.periodTo)
          || input.periodTo >= venueLocalToday()) {
        status.textContent = 'Выберите версию и прошедший период с первого числа в пределах одного месяца.'; return;
      }
      saving = true;
      const detailAtSubmit = detailToken;
      for (const control of form.elements) control.disabled = true;
      status.textContent = 'Собираем источники и сохраняем расчёт…';
      try {
        const savedVersion=await savedRequest(`/api/payroll/versions/${encodeURIComponent(input.schemeVersionId)}`);
        if (!alive()) return;
        if (savedVersion.versionId!==input.schemeVersionId || !['active','retired'].includes(savedVersion.status)) throw new Error('payroll_run_source_policy_unsupported');
        const endpoint=savedRunCreationEndpoint(savedVersion);
        // Immutable version policy selects both endpoint and retry namespace.
        // Existing v1 keys and request bytes remain unchanged across reloads.
        const storageKey=(endpoint==='/api/payroll/calculation-runs'?storagePrefix:`payroll-saved-intent:refund-aware-v2:${identity}:`)+JSON.stringify(input);
        try {
          input.idempotencyKey=sessionStorage.getItem(storageKey)||crypto.randomUUID();
          sessionStorage.setItem(storageKey,input.idempotencyKey);
          if(sessionStorage.getItem(storageKey)!==input.idempotencyKey)throw new Error('readback');
        } catch (_) {status.textContent='Не удалось сохранить ключ повторного запроса в браузере. Разрешите хранилище и повторите.';return;}
        const result = await savedRequest(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
        });
        if (!alive()) return;
        if (result.status !== 'ready' || !result.runId || result.persistence !== 'snapshots') throw new Error('invalid_response');
        if (endpoint === '/api/payroll/refund-aware-calculation-runs'
            && (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.runId)
              || result.capabilityVersion !== 'employee_attributed_remaining_net_refund_v2'
              || !Number.isSafeInteger(result.amountCents) || result.amountCents < 0 || result.amountCents > 999999999999
              || typeof result.replayed !== 'boolean' || result.officialReady !== false || result.payoutEligible !== false)) throw new Error('invalid_response');
        sessionStorage.removeItem(storageKey);
        status.textContent = result.replayed ? 'Ранее сохранённый расчёт найден. Повторного расчёта не создано.' : 'Расчёт сохранён. Начисления и выплаты ещё не созданы.';
        await loadList();
        if (detailToken === detailAtSubmit) await openRun(result.runId);
      } catch (error) {
        if (!alive()) return;
        if (error.status === 422 && error.data?.status === 'blocked') {
          status.innerHTML = '<p>Расчёт не сохранён. Требуется проверить данные:</p><ul>'
            + (error.data.reasons || []).map(reason => `<li>${escapeHtml(readinessReasonLabel(reason))}</li>`).join('') + '</ul>';
        } else status.textContent = `${errorText(error)} При повторе для этой версии и периода будет использован тот же ключ запроса.`;
      } finally {
        saving = false;
        if (alive()) for (const control of form.elements) control.disabled = false;
      }
    });
    section.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || !alive()) return;
      if (button.hasAttribute('data-saved-run-reload')) { loaded = false; void activate(); }
      else if (button.hasAttribute('data-saved-run-more')) void loadList(listCursor);
      else if (button.dataset.savedRunOpen) void openRun(button.dataset.savedRunOpen);
      else if (button.hasAttribute('data-saved-run-replay')) void replayRun(button);
      else if (button.hasAttribute('data-saved-run-freshness')) void checkFreshness(button);
      else if (button.hasAttribute('data-supersession-preview')) void previewSupersession(button);
      else if (button.hasAttribute('data-supersession-commit')) void sendSupersession(selectedRunId,true);
      else if (button.dataset.supersessionRetry) void sendSupersession(button.dataset.supersessionRetry);
      else if (button.hasAttribute('data-saved-entry-reload')) void loadRunEntries(selectedRunId);
      else if (button.hasAttribute('data-saved-entry-categories-reload')) void loadEntryCategories(selectedRunId);
      else if (button.dataset.savedEntryCreate) void createRunEntry(button);
      else if (button.dataset.savedEntryRegister) document.dispatchEvent(new CustomEvent('payroll-run-entry-open', {
        detail: { entryId: button.dataset.savedEntryRegister, from: button.dataset.entryFrom, to: button.dataset.entryTo }
      }));
      else if (button.hasAttribute('data-refund-review-check')) void mutateRefundReview(button, false);
      else if (button.hasAttribute('data-refund-review-decide')) void mutateRefundReview(button, true);
      else if (button.hasAttribute('data-refund-review-more')) moreRefundReview();
      else if (button.hasAttribute('data-correction-preview')) void previewCorrection();
      else if (button.hasAttribute('data-correction-commit')) void sendCorrection(correctionContext?.original.id,true);
      else if (button.dataset.correctionRetry) void sendCorrection(button.dataset.correctionRetry);
      else if (button.dataset.savedEmployee) void openEmployee(button.dataset.savedEmployee);
      else if (button.dataset.savedDay) void openLines(button.dataset.savedDay);
      else if (button.dataset.savedEmployeesNext) void openRun(selectedRunId, button.dataset.savedEmployeesNext);
      else if (button.dataset.savedLinesNext) void openLines(detail.querySelector('[data-saved-lines]').dataset.snapshotId, button.dataset.savedLinesNext);
    });
    section.addEventListener('change',event=>{
      if(!alive())return;
      if(event.target.matches('[data-correction-original]'))void loadCorrectionContext(event.target.value);
      else if(event.target.matches('[data-correction-target], [data-correction-operation]')){
        invalidateCorrectionPlan();const label=detail.querySelector('[data-correction-target-label]');
        if(label)label.hidden=detail.querySelector('[data-correction-operation]').value==='waive';
      }
    });
    window.addEventListener('storage', event => { if (event.key === null || ['crm_session_user', 'crm_session_token'].includes(event.key)) alive(); });
    return { activate };
  };
  const mount = () => {
    const payrollPanel = document.querySelector('.finance-payroll-panel');
    if (!payrollPanel || payrollPanel.dataset.schemeUiMounted) return;
    payrollPanel.dataset.schemeUiMounted = 'true';
    const panel = document.createElement('section');
    panel.className = 'panel finance-payroll-schemes';
    panel.innerHTML = `
      <style data-payroll-editor-responsive>
        #page-content.finance-workspace details.finance-secondary-details.finance-payroll-settings>summary::after{content:'';display:block;flex:0 0 8px;width:8px;height:8px;border:solid currentColor;border-width:0 2px 2px 0;margin:0 8px 4px;transform:rotate(45deg)}
        #page-content.finance-workspace details.finance-secondary-details.finance-payroll-settings[open]>summary::after{transform:rotate(225deg)}
        .finance-payroll-schemes{min-width:0;max-width:100%;box-sizing:border-box}
        .finance-payroll-schemes fieldset,.finance-payroll-schemes form,.finance-payroll-schemes details,.finance-payroll-schemes section,.finance-payroll-schemes [data-scheme-grid],.finance-payroll-schemes [data-grid-overrides]{min-width:0;min-inline-size:0;max-width:100%;box-sizing:border-box}
        .finance-payroll-schemes .panel-head,.finance-payroll-schemes .panel-head>*,.finance-payroll-schemes .toolbar-row,.finance-payroll-schemes .form-row,.finance-payroll-schemes label{min-width:0;max-width:100%;box-sizing:border-box}
        .finance-payroll-schemes .form-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))}
        .finance-payroll-schemes input,.finance-payroll-schemes select,.finance-payroll-schemes textarea{min-width:0;max-width:100%;box-sizing:border-box}
        .finance-payroll-schemes label>input:not([type=checkbox]),.finance-payroll-schemes label>select,.finance-payroll-schemes label>textarea{width:100%}
        .finance-payroll-schemes p,.finance-payroll-schemes summary,.finance-payroll-schemes span,.finance-payroll-schemes code,.finance-payroll-schemes legend,.finance-payroll-schemes label{overflow-wrap:anywhere}
        .finance-payroll-schemes .toolbar-row{flex-wrap:wrap}
        .finance-payroll-schemes .button{min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere}
        .finance-payroll-schemes [data-saved-run-table] th,.finance-payroll-schemes [data-saved-run-table] td{white-space:nowrap;overflow-wrap:normal;word-break:normal}
        .finance-payroll-schemes [data-saved-run-table] details[open]{width:300px;white-space:normal}
        .finance-payroll-schemes [data-saved-run-table] .button{white-space:nowrap;min-width:90px}
        .finance-payroll-schemes [data-grid-rate-table] input,.finance-payroll-schemes [data-grid-milestone-table] input{min-width:100px}
        .finance-payroll-schemes [data-grid-rate-table],.finance-payroll-schemes [data-grid-milestone-table]{width:max-content;min-width:100%;table-layout:auto}
        .finance-payroll-schemes [data-grid-rate-table] th,.finance-payroll-schemes [data-grid-rate-table] td,.finance-payroll-schemes [data-grid-milestone-table] th,.finance-payroll-schemes [data-grid-milestone-table] td{white-space:nowrap;overflow-wrap:normal;word-break:normal}
        .finance-payroll-schemes [data-grid-rate-table] th:first-child,.finance-payroll-schemes [data-grid-milestone-table] th:first-child{min-width:150px}
        .finance-payroll-schemes [data-grid-rate-table] td,.finance-payroll-schemes [data-grid-milestone-table] td{min-width:140px}
        .finance-payroll-schemes [data-grid-rate-table] caption,.finance-payroll-schemes [data-grid-milestone-table] caption{white-space:normal;overflow-wrap:normal;word-break:normal;text-align:left}
        @media(max-width:600px){
          .finance-payroll-schemes .panel-head{flex-direction:column;align-items:stretch}
          .finance-payroll-schemes .form-row{grid-template-columns:minmax(0,1fr)}
          .finance-payroll-schemes .toolbar-row{width:100%}
          .finance-payroll-schemes fieldset{margin-inline:0;padding-inline:8px}
        }

        .finance-payroll-schemes [data-scheme-pane][hidden]{display:none!important}
        .finance-payroll-schemes .scheme-workspace-nav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
        .finance-payroll-schemes .scheme-workspace-nav [aria-current=step]{background:var(--ui-action-fill);color:var(--ui-text-on-action);border-color:var(--ui-action-fill)}
        .finance-payroll-schemes .scheme-guidance{margin:12px 0;color:var(--ui-text-secondary);line-height:1.5}
        .finance-payroll-schemes .scheme-group{margin:12px 0;border:1px solid var(--ui-border-control);border-radius:12px;padding:0 12px}
        .finance-payroll-schemes .scheme-group>summary{padding:12px 0;min-height:44px;box-sizing:border-box;cursor:pointer;font-weight:600}
        .finance-payroll-schemes .scheme-group[open]>*:last-child{margin-bottom:12px}
        .finance-payroll-schemes .scheme-group .form-row{gap:12px}
        .finance-payroll-schemes [data-grid-role-card]>.form-row{margin-top:12px}
        .finance-payroll-schemes .scheme-role-fields{padding-bottom:12px}
        .finance-payroll-schemes [data-grid-overrides]>section{padding:12px 0;border-top:1px solid var(--ui-border-control)}
        .finance-payroll-schemes [data-scheme-pane]>[data-scheme-editor]{margin:0}
        .finance-payroll-schemes [data-scheme-preview-input]{font-family:monospace}
        .finance-payroll-schemes .scheme-workspace-nav .button{flex:1 1 150px}
      </style>
      <div class="panel-head"><div><h2>Настройка зарплатных схем</h2><span class="muted">Сначала настройте схему, затем проверьте данные и выполните пробный расчёт</span></div><div class="toolbar-row"><button type="button" class="button small" data-scheme-reload>Обновить</button><button type="button" class="button small primary" data-scheme-new>Новая схема</button></div></div>
      <p class="muted">Настройки и суммы доступны только владельцу площадки. Черновик можно редактировать; активация закрепляет версию. Обычный preview использует введённый сценарий. Отдельный preview оборота площадки читает закрытые заказы, но не подтверждает строки продаж, комиссии или посещаемость; оба варианта неофициальны и ничего не сохраняют.</p>
      <p class="form-message" data-scheme-message role="status" aria-live="polite"></p>
      <div class="finance-scheme-list" data-scheme-list><div class="empty">Загрузка схем…</div></div>
      <form class="stack-form" data-scheme-editor hidden>
        <div class="panel-head"><div><h3 data-scheme-editor-title>Новая схема</h3><span class="muted">Основные ставки настраиваются по ролям. Назначения сотрудников и редкие параметры доступны в расширенной конфигурации.</span></div></div>
        <div class="form-row"><label>Название схемы<input data-scheme-name maxlength="120" required></label><label>Описание<textarea data-scheme-description rows="2" maxlength="2000"></textarea></label></div>
        <fieldset data-scheme-grid-fieldset><legend>Ставки по ролям и личные параметры</legend><p class="muted">Суммы — в валюте схемы, проценты — от 0 до 100. Пустое необязательное поле удаляет только этот параметр; ноль остаётся отдельным значением. Смена режима не добавляет ставки автоматически.</p><div data-scheme-grid></div><div class="toolbar-row"><button type="button" class="button" data-scheme-grid-apply>Применить таблицу к черновику</button><button type="button" class="button" data-scheme-grid-rebuild>Обновить таблицу из JSON</button></div><p data-scheme-grid-message role="status" aria-live="polite"></p></fieldset>
        <fieldset data-source-policy-fieldset><legend>Правила будущих источников зарплаты</legend>
          <p class="warning-message">Настройка будущего расчёта; данные источников ещё не подтверждены. Выбор правил не меняет математику сценария и не разрешает официальный расчёт.</p>
          <label><input type="checkbox" data-source-policy-enabled> Явно выбрать и сохранить правила для этой версии</label>
          <label>Пересчёт премии после возвратов<select data-source-policy-version><option value="1">Сохранённые правила источников без нового пересчёта премии</option><option value="2">Пересчитывать премию после возвратов по исходным датам продаж</option></select></label>
          <div data-source-policy-v2-explanation hidden role="note"><p>Для расчёта премии используем стоимость первоначального списания. При возврате выручка уменьшается, эта стоимость не восстанавливается; последующие возвраты запасов её не меняют.</p><p>Выбор применяется ко всей версии схемы, включая разные правила оплаты по ролям. Дата признания события возврата сохраняется; премия пересчитывается по исходным датам продаж. Для этого нужны продавец и точная скидка из снимка строки, а также дата признанного события возврата.</p><p>После активации версии расчёт запускается в сохранённых расчётах. Сервер проверяет источники; утверждение и выплата выполняются отдельно по состоянию начисления.</p></div>
          <div class="form-row"><label>Кому приписывается продажа<select data-source-policy-sale><option value="">Выберите правило</option><option value="line_seller_snapshot">Продавцу из неизменяемого снимка строки</option><option value="order_responsible_snapshot">Ответственному из отдельного неизменяемого снимка заказа (не открывшему заказ)</option><option value="explicit_line_allocation">По явному распределению исполнителей строки</option></select></label>
          <label>Скидка по строкам<select data-source-policy-discount><option value="">Выберите правило</option><option value="immutable_line_snapshot">Точное распределение из неизменяемого снимка строки</option><option value="eligible_gross_proportional_fixed_order">Пропорционально подходящей исходной базе закрытого заказа</option></select></label>
          <label>Когда учитывается возврат<select data-source-policy-refund><option value="">Выберите правило</option><option value="recognized_event_date">На дату признанного события возврата</option><option value="original_sale_period_correction">Корректировкой периода исходной продажи</option></select></label></div>
          <p class="muted">Пропорциональная скидка: подходящие строки фиксирует источник цены; копейки распределяются методом наибольших остатков с устойчивым порядком ID. Закрытый расчёт корректируется в следующем открытом периоде. Оплаченная переменная часть требует проверки владельцем; непокрытый остаток переносится на проверку. Автоматического удержания нет.</p>
          <label>Причина выбора<textarea data-source-policy-reason rows="2" maxlength="1000"></textarea></label><button type="button" class="button" data-source-policy-apply>Применить правила к черновику</button><p data-source-policy-message role="status" aria-live="polite"></p>
        </fieldset>
        <details data-scheme-advanced><summary>Расширенная конфигурация JSON</summary><label>Конфигурация версии <textarea data-scheme-definition rows="18" spellcheck="false" required></textarea></label></details>
        <p class="muted">Обязательные поля: mode, effectiveFrom, roleParameters, roleAssignments, employeeOverrides, itemRules. В расширенной конфигурации используются идентификаторы сотрудников из списка персонала. Денежные суммы задаются в копейках, ставки — в basis points. Явный ноль отличается от наследования.</p>
        <p class="muted">Режим personal_target — личный дневной план. В параметрах роли задайте perShiftCents, targetCents, baseRateBps, bonusRateBps и excessRatePolicy: replace_base заменяет ставку сверх плана, add_to_base добавляет её. План начинается заново каждый день; обе части округляются отдельно до копейки. Позиционная замена исключает строку из плана, добавочная ставка сохраняет её в плане.</p>
        <p class="muted">Режим team_fund — один командный фонд за день. В roleParameters задайте teamFund: poolId, targetCents, baseRateBps, bonusRateBps, excessRatePolicy, departments и distributionPolicy. approved_minutes распределяет по утверждённым минутам; configured_weights — по teamWeight активных сотрудников независимо от выхода в этот день. Общие параметры одного poolId должны совпадать у всех ролей. Лимиты применяются после распределения; срезанная сумма не переходит другим сотрудникам.</p>
        <p class="muted">Режим margin_target — процент от дневной маржи продаж сотрудника: комиссионная база минус полная себестоимость строки. Задайте параметры личного плана, lossPolicy: offset_daily_losses и itemRuleBasis: net_revenue. В каждой строке sales нужен costSnapshot с id, version, currency и costCents — полной первоначальной себестоимостью строки продажи из зафиксированного снимка. При возврате выручка уменьшается, а эта себестоимость сохраняется. Убытки уменьшают общую дневную маржу; текущая себестоимость меню не подставляется. Позиционные ставки явно остаются от выручки: replacement исключает строку из маржинального плана, additive сохраняет её и может платить комиссию даже при отрицательной марже дня.</p>
        <label data-scheme-risk-ack><input type="checkbox" data-scheme-risk-acknowledged required> Я владелец и понимаю: начисление может превысить приписанный оборот, обязательная премия или оклад может сделать официальный расчёт заблокированным; текущий preview не подтверждает личную чистую выручку. Это подтверждение не отменяет дневной лимит и не разрешает выплату сверх личной выручки.</label>
        <div class="toolbar-row"><button class="button primary" type="submit" data-scheme-save>Сохранить черновик</button><button class="button" type="button" data-scheme-editor-cancel>Закрыть</button></div>
        <section data-personal-cap-confirmation hidden><div data-personal-cap-exceptions></div><label><input type="checkbox" data-personal-cap-acknowledged> Я отдельно подтверждаю повышение личного процента лимита выше процента роли для указанных сотрудников и периодов. Это не разрешает выплату сверх полной личной выручки.</label></section>
      </form>
      <div class="finance-scheme-preview" data-scheme-preview hidden>
        <div class="panel-head"><div><h3>Пробный расчёт</h3><span class="muted" data-scheme-selected-label></span></div><div class="toolbar-row"><button type="button" class="button small primary" data-scheme-run-preview>Рассчитать сценарий</button><button type="button" class="button small" data-scheme-run-approved-attendance>Сценарий с утверждённым табелем</button><button type="button" class="button small" data-scheme-run-venue-preview>Сценарий с оборотом чеков</button><button type="button" class="button small" data-scheme-compare>Сравнить сценарии (JSON)</button></div></div>
        <label>Нормализованные входные данные сценария<textarea data-scheme-preview-input rows="12" spellcheck="false"></textarea></label>
        <div data-scheme-preview-result class="finance-scheme-result" hidden></div>
      </div>
      <section class="finance-scheme-preview" data-source-readiness>
        <h3>Проверка источников зарплаты</h3><p>Отчёт по сохранённой версии схемы. Начало периода — первый день месяца; конец — в том же месяце.</p>
        <p data-source-readiness-version>Сначала откройте сохранённую версию.</p><p class="warning-message" data-source-readiness-dirty hidden></p>
        <div class="form-row"><label>С даты<input type="date" data-source-readiness-from></label><label>По дату<input type="date" data-source-readiness-to></label></div>
        <p>Для сравнения отметьте от 2 до 8 сохранённых версий в списке схем. JSON-сценарии сравниваются отдельно в пробном расчёте.</p>
        <label>Базовая версия для сравнения<select data-source-comparison-baseline disabled><option value="">Сначала выберите версии</option></select></label>
        <div class="toolbar-row"><button type="button" class="button small" data-source-readiness-run disabled>Проверить источники</button><button type="button" class="button small" data-source-candidate-run disabled>Посмотреть предварительные данные по продажам</button><button type="button" class="button small" data-source-comparison-run disabled>Сравнить по данным системы</button></div>
        <div data-source-readiness-result class="finance-scheme-result" aria-live="polite"><p class="empty">Выберите версию и период проверки.</p></div>
        <div data-source-candidate-result class="finance-scheme-result" aria-live="polite"><p class="empty">Кандидатные значения ещё не запрошены.</p></div>
        <div data-source-comparison-result class="finance-scheme-result" aria-live="polite"><p class="empty">Выберите версии в списке схем для сравнения.</p></div>
      </section>
      <section class="finance-scheme-preview" data-payroll-entry-diagnostic>
        <h3>Проверка существующих начислений и выплат</h3>
        <p>Только чтение: показывает записи зарплатного реестра и payroll-расходы за период. Проверка не создаёт и не меняет начисления или выплаты.</p>
        <div class="form-row"><label>С даты<input type="date" data-entry-diagnostic-from></label><label>По дату<input type="date" data-entry-diagnostic-to></label></div>
        <div class="toolbar-row"><button type="button" class="button small" data-entry-diagnostic-run>Проверить реестр</button></div>
        <div data-entry-diagnostic-result class="finance-scheme-result" aria-live="polite"><p class="empty">Выберите период и запустите проверку.</p></div>
      </section>
      <section class="finance-scheme-preview" data-attendance-approval>
        <div class="panel-head"><div><h3>Подтверждение табеля</h3><span class="muted">Зафиксирует отдельную неизменяемую payroll-ревизию закрытых интервалов и расписания. Это не создаёт зарплатный расчёт или выплату.</span></div></div>
        <div class="form-row"><label>С даты<input type="date" data-attendance-from required></label><label>По дату<input type="date" data-attendance-to required></label></div>
        <div class="toolbar-row"><button type="button" class="button small" data-attendance-refresh>Проверить табель</button><button type="button" class="button small primary" data-attendance-approve disabled>Утвердить снимок</button></div>
        <label>Основание подтверждения<input type="text" data-attendance-reason minlength="3" maxlength="1000" autocomplete="off" placeholder="Например: табель сверен с ответственными за смены"></label>
        <div data-attendance-result class="finance-scheme-result" aria-live="polite"><p class="empty">Задайте период и проверьте полноту исходного табеля.</p></div>
      </section>`;
    const settings = document.createElement('details');
    settings.className = 'finance-secondary-details finance-payroll-settings';
    const settingsTitle = document.createElement('summary');
    settingsTitle.textContent = 'Настройки схем и проверка расчётов';
    settings.append(settingsTitle, panel);
    payrollPanel.append(settings);
    mountEmploymentEligibilityPanel(payrollPanel, settings);
    mountProductDepartmentPanel(payrollPanel, settings);

    const list = panel.querySelector('[data-scheme-list]');
    const message = panel.querySelector('[data-scheme-message]');
    const editor = panel.querySelector('[data-scheme-editor]');
    const nameField = panel.querySelector('[data-scheme-name]');
    const descriptionField = panel.querySelector('[data-scheme-description]');
    const definitionField = panel.querySelector('[data-scheme-definition]');
    const payoutRiskAcknowledgementField = panel.querySelector('[data-scheme-risk-acknowledged]');
    const payoutRiskAcknowledgementLabel = panel.querySelector('[data-scheme-risk-ack]');
    const personalCapBox = panel.querySelector('[data-personal-cap-confirmation]');
    const personalCapField = panel.querySelector('[data-personal-cap-acknowledged]');
    const personalCapList = panel.querySelector('[data-personal-cap-exceptions]');
    const refreshPersonalCap = (definition) => {
      personalCapField.checked = false;
      personalCapField.disabled = pending || editorAction?.kind === 'inspect';
      try {
        const rows = editorPersonalCapIncreases(definition);
        personalCapBox.hidden = rows.length === 0;
        personalCapBox.dataset.state = 'valid';
        personalCapList.innerHTML = `<p>Личный процент лимита выше роли. При разных базах проценты не определяют сравнение итоговой суммы. Сервер повторно проверит выбор.</p><ul>${rows.slice(0, 200).map((row) => `<li>${escapeHtml(editorEmployeeLabel(row.employeeId))} · ${escapeHtml(editorRoleLabel(row.roleId))} · ${escapeHtml(editorFormat(row.roleRateBps))}% → ${escapeHtml(editorFormat(row.personalRateBps))}% · ${escapeHtml(row.effectiveFrom)} — ${escapeHtml(row.effectiveTo || 'без окончания')}</li>`).join('')}</ul>${rows.length > 200 ? `<p>Всего периодов: ${rows.length}. Остальные перечислены в личных параметрах.</p>` : ''}`;
      } catch (error) {
        personalCapBox.hidden = false; personalCapBox.dataset.state = 'invalid'; personalCapField.disabled = true;
        personalCapList.textContent = `Не удалось проверить личные лимиты: ${error.message}`;
      }
    };
    definitionField.addEventListener('input', () => { payoutRiskAcknowledgementField.checked = false; gridDirty = false; gridStale = true; sourcePolicyDirty = false; sourcePolicyFieldset.disabled = true; sourcePolicyMessage.textContent = 'JSON изменён. Обновите таблицу из JSON, чтобы загрузить правила.'; gridMessage.textContent = 'JSON изменён. Обновите таблицу из JSON перед редактированием таблицы.'; });
    const previewBox = panel.querySelector('[data-scheme-preview]');
    const previewInput = panel.querySelector('[data-scheme-preview-input]');
    const previewResult = panel.querySelector('[data-scheme-preview-result]');
    const attendanceFrom = panel.querySelector('[data-attendance-from]');
    const attendanceTo = panel.querySelector('[data-attendance-to]');
    const attendanceReason = panel.querySelector('[data-attendance-reason]');
    const attendanceResult = panel.querySelector('[data-attendance-result]');
    const attendanceRefresh = panel.querySelector('[data-attendance-refresh]');
    const attendanceApprove = panel.querySelector('[data-attendance-approve]');
    let schemes = [];
    let editorAction = null;
    let selectedVersion = null;
    let editorBaseline = null;
    let selectedVersionIds = [];
    let pending = false;
    const workspaceNav=document.createElement('nav');workspaceNav.className='scheme-workspace-nav';workspaceNav.setAttribute('aria-label','Этапы настройки зарплаты');
    const workspaceLabels={list:'Схемы',configuration:'Настройка',checks:'Проверка данных',trial:'Пробный расчёт',saved:'Сохранённые расчёты'};
    workspaceNav.innerHTML=Object.entries(workspaceLabels).map(([key,label])=>`<button type="button" class="button small" data-scheme-workspace="${key}">${label}</button>`).join('');
    message.before(workspaceNav);
    const workspacePanes={};
    for(const key of Object.keys(workspaceLabels)){const section=document.createElement('section');section.dataset.schemePane=key;section.hidden=key!=='list';workspacePanes[key]=section;panel.append(section);}
    workspacePanes.list.append(list);workspacePanes.configuration.append(editor);workspacePanes.trial.append(previewBox);
    const savedRuns = mountSavedRuns(workspacePanes.saved);
    const disclosure=(node,title)=>{const details=document.createElement('details');details.className='scheme-group';const summary=document.createElement('summary');summary.textContent=title;node.before(details);details.append(summary,node);return details;};
    const attendancePanel=panel.querySelector('[data-attendance-approval]'),readinessPanel=panel.querySelector('[data-source-readiness]'),entryDiagnosticPanel=panel.querySelector('[data-payroll-entry-diagnostic]');
    workspacePanes.checks.append(attendancePanel,readinessPanel,entryDiagnosticPanel);
    const attendanceDetails=disclosure(attendancePanel,'Табель: проверить время и утвердить снимок');attendanceDetails.open=true;
    disclosure(readinessPanel,'Источники: проверить сохранённую версию схемы');
    const checksHint=document.createElement('p');checksHint.className='scheme-guidance';checksHint.textContent='Табель и источники проверяются независимо. Утверждение табеля не означает готовность официального расчёта.';workspacePanes.checks.prepend(checksHint);
    const trialHint=document.createElement('p');trialHint.className='scheme-guidance';trialHint.textContent='Пробный расчёт не создаёт начисления или выплаты. Он использует сохранённую версию; несохранённые правки в него не входят.';workspacePanes.trial.prepend(trialHint);
    const trialEmpty=document.createElement('p');trialEmpty.className='empty';trialEmpty.textContent='Откройте сохранённую версию в списке схем. Для сравнения отметьте от 2 до 8 версий.';workspacePanes.trial.prepend(trialEmpty);
    const configEmpty=document.createElement('p');configEmpty.className='empty';configEmpty.textContent='Откройте существующую версию или создайте новую схему.';workspacePanes.configuration.prepend(configEmpty);
    const footer=document.createElement('div');footer.className='toolbar-row';footer.innerHTML='<button type="button" class="button" data-scheme-workspace="list">К списку схем</button><button type="button" class="button" data-scheme-workspace="checks">Проверить данные</button><button type="button" class="button" data-scheme-workspace="trial">К пробному расчёту</button>';editor.after(footer);
    const checksNext=document.createElement('button');checksNext.type='button';checksNext.className='button';checksNext.dataset.schemeWorkspace='trial';checksNext.textContent='Перейти к пробному расчёту';workspacePanes.checks.append(checksNext);
    const registryHint=document.createElement('p');registryHint.className='scheme-guidance';registryHint.textContent='Фактические начисления ведутся в зарплатном реестре выше. Его модели оплаты выбираются отдельно: сохранение или активация этой схемы не создаёт начисление.';workspacePanes.list.prepend(registryHint);
    const intro=panel.querySelector(':scope > p.muted');if(intro){const help=disclosure(intro,'Как работают версии и пробные расчёты');workspacePanes.list.append(help);}
    const advanced=panel.querySelector('[data-scheme-advanced]');advanced.classList.add('scheme-group');
    while(advanced.nextElementSibling?.matches('p.muted'))advanced.append(advanced.nextElementSibling);
    disclosure(panel.querySelector('[data-source-policy-fieldset]'),'Правила источников — расширенная настройка');
    disclosure(previewInput.closest('label'),'Данные пробного сценария — JSON');
    const selectWorkspace=(key,{focus=false}={})=>{
      if(!workspacePanes[key])return;
      panel.dataset.schemeWorkspace=key;
      for(const [name,node] of Object.entries(workspacePanes))node.hidden=name!==key;
      workspaceNav.querySelectorAll('[data-scheme-workspace]').forEach(button=>{if(button.dataset.schemeWorkspace===key)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');});
      configEmpty.hidden=Boolean(editorAction);
      const savedVersion=Boolean(selectedVersion&&['edit','inspect'].includes(editorAction?.kind));
      const hasComparison=panel.querySelectorAll('[data-scheme-compare-version]:checked').length>=2;
      trialEmpty.hidden=savedVersion||hasComparison;
      if(key==='trial')previewBox.hidden=!savedVersion&&!hasComparison;
      if(key==='saved')void savedRuns.activate();
      if(focus){const target=workspacePanes[key];target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({block:'start',behavior:'smooth'});}
    };
    const revealControl=(node)=>{if(!node)return;if(editor.contains(node))selectWorkspace('configuration');else if(previewBox.contains(node))selectWorkspace('trial');let parent=node.parentElement;while(parent&&parent!==panel){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}node.scrollIntoView({block:'center',behavior:'smooth'});node.focus?.({preventScroll:true});};
    editor.addEventListener('invalid',event=>revealControl(event.target),true);
    editor.addEventListener('input',event=>event.target.setCustomValidity?.(''));
    selectWorkspace('list');
    const grid = panel.querySelector('[data-scheme-grid]');
    const gridFieldset = panel.querySelector('[data-scheme-grid-fieldset]');
    const gridMessage = panel.querySelector('[data-scheme-grid-message]');
    const sourcePolicyFieldset = panel.querySelector('[data-source-policy-fieldset]');
    const sourcePolicyEnabled = panel.querySelector('[data-source-policy-enabled]');
    const sourcePolicyVersion = panel.querySelector('[data-source-policy-version]');
    const sourcePolicyV2Explanation = panel.querySelector('[data-source-policy-v2-explanation]');
    const sourcePolicySale = panel.querySelector('[data-source-policy-sale]');
    const sourcePolicyDiscount = panel.querySelector('[data-source-policy-discount]');
    const sourcePolicyRefund = panel.querySelector('[data-source-policy-refund]');
    const sourcePolicyReason = panel.querySelector('[data-source-policy-reason]');
    const sourcePolicyMessage = panel.querySelector('[data-source-policy-message]');
    let sourcePolicyDirty = false;
    const readinessFrom=panel.querySelector('[data-source-readiness-from]'), readinessTo=panel.querySelector('[data-source-readiness-to]');
    const readinessRun=panel.querySelector('[data-source-readiness-run]'), candidateRun=panel.querySelector('[data-source-candidate-run]'), comparisonRun=panel.querySelector('[data-source-comparison-run]'), comparisonBaseline=panel.querySelector('[data-source-comparison-baseline]'), readinessResult=panel.querySelector('[data-source-readiness-result]'), candidateResult=panel.querySelector('[data-source-candidate-result]'), comparisonResult=panel.querySelector('[data-source-comparison-result]');
    const readinessDirty=panel.querySelector('[data-source-readiness-dirty]'), readinessVersion=panel.querySelector('[data-source-readiness-version]');
    let readinessToken=0, readinessLoading=false;
    const readinessSavedSelection=()=>selectedVersion && ['edit','inspect'].includes(editorAction?.kind);
    const selectedComparisonVersions=()=>[...panel.querySelectorAll('[data-scheme-compare-version]:checked')].map(input=>input.dataset.schemeCompareVersion).filter(id=>typeof id==='string'&&id);
    const refreshComparisonBaseline=()=>{
      const selected=selectedComparisonVersions();
      const versions=schemes.flatMap(scheme=>(scheme.versions||[]).map(version=>({...version,schemeName:scheme.name}))).filter(version=>selected.includes(version.id));
      const previous=comparisonBaseline.value;
      comparisonBaseline.innerHTML=versions.length?versions.map(version=>`<option value="${escapeHtml(version.id)}">${escapeHtml(version.schemeName)} · версия ${escapeHtml(version.versionNo)} · ${escapeHtml(EDITOR_CHOICE_LABELS[version.mode]||version.mode)}</option>`).join(''):'<option value="">Сначала выберите версии</option>';
      comparisonBaseline.disabled=versions.length<2||versions.length>8;
      const preferred=versions.some(version=>version.id===previous)?previous:(versions.find(version=>version.status==='active')||versions[0])?.id;
      comparisonBaseline.value=preferred||'';
      comparisonRun.disabled=readinessLoading||versions.length<2||versions.length>8;
      comparisonRun.title=versions.length>8?'Выберите не более 8 версий':versions.length<2?'Выберите минимум 2 сохранённые версии':'';
    };
    const refreshReadiness=()=>{
      const saved=readinessSavedSelection();
      readinessRun.disabled=!saved||readinessLoading;candidateRun.disabled=!saved||readinessLoading;
      readinessVersion.textContent=saved?`${selectedVersion.name} · сохранённая версия ${selectedVersion.versionNo}`:'Сначала откройте сохранённую версию. Для новой версии проверка доступна после сохранения.';
      const dirty=saved&&(gridDirty||sourcePolicyDirty||definitionField.value!==JSON.stringify(definitionFromVersion(selectedVersion),null,2));
      readinessDirty.hidden=!dirty;
      readinessDirty.textContent=dirty?'Есть несохранённые изменения. Проверка относится к сохранённой версии, изменения редактора в неё не входят.':'';
      refreshComparisonBaseline();
    };
    const invalidateReadiness=()=>{readinessToken++;readinessLoading=false;readinessResult.innerHTML='<p class="empty">Выберите версию и период; затем проверьте источники заново.</p>';candidateResult.innerHTML='<p class="empty">Период или сохранённая версия изменились. Запросите кандидатные данные заново.</p>';comparisonResult.innerHTML='<p class="empty">Период изменился. Запросите сравнение заново.</p>';refreshReadiness();};
    const invalidateSourcedComparison=()=>{comparisonResult.innerHTML='<p class="empty">Выбор версий или базовой версии изменился. Запросите сравнение заново.</p>';};
    const runReadiness=async()=>{
      if(!readinessSavedSelection()||readinessLoading)return;
      const from=readinessFrom.value,to=readinessTo.value,versionId=selectedVersion.versionId;
      invalidateReadiness();
      if(!sourceReadinessPeriodValid(from,to)){readinessResult.textContent='Укажите реальные даты: начало — первый день месяца, конец — в том же месяце и не раньше начала.';return;}
      const token=++readinessToken;readinessLoading=true;refreshReadiness();readinessResult.textContent='Проверяем источники сохранённой версии…';
      const current=()=>token===readinessToken&&readinessSavedSelection()&&selectedVersion.versionId===versionId&&readinessFrom.value===from&&readinessTo.value===to;
      try{
        const payload=await request(`/api/payroll/versions/${encodeURIComponent(versionId)}/source-readiness?${new URLSearchParams({from,to})}`);
        if(!current())return;
        if(payload.versionId!==versionId||payload.period?.from!==from||payload.period?.to!==to)throw new Error('Ответ относится к другой версии или периоду.');
        readinessResult.innerHTML=renderSourceReadiness(payload);
      }catch(error){if(current())readinessResult.textContent=`Не удалось проверить источники: ${error.message}`;}
      finally{if(token===readinessToken){readinessLoading=false;refreshReadiness();}}
    };
    readinessRun.addEventListener('click',runReadiness);
    const diagnosticFrom=panel.querySelector('[data-entry-diagnostic-from]'),diagnosticTo=panel.querySelector('[data-entry-diagnostic-to]'),diagnosticRun=panel.querySelector('[data-entry-diagnostic-run]'),diagnosticResult=panel.querySelector('[data-entry-diagnostic-result]');
    const diagnosticToday=venueLocalToday();diagnosticFrom.value=`${diagnosticToday.slice(0,7)}-01`;diagnosticTo.value=diagnosticToday;
    let diagnosticToken=0;
    const invalidateEntryDiagnostic=()=>{diagnosticToken++;diagnosticRun.disabled=false;diagnosticResult.innerHTML='<p class="empty">Период изменён. Запустите проверку заново.</p>';};
    diagnosticFrom.addEventListener('input',invalidateEntryDiagnostic);diagnosticTo.addEventListener('input',invalidateEntryDiagnostic);
    const renderEntryDiagnostic=payload=>{
      const flagLabels={legacy_without_rule:'старая запись без правила',exact_period_duplicate:'точный дубль периода',overlapping_period_contained:'пересечение периодов',overlapping_period_partial:'частичное пересечение',expense_reference_missing_in_venue:'ссылка на расход не найдена на площадке',paid_without_explicit_expense_link:'выплата без явной ссылки',no_explicit_expense_link:'нет явной ссылки',linked_expense_source_mismatch:'тип расхода отличается от payroll',expense_link_on_nonpaid_entry:'расход связан с не выплаченным начислением',paid_entry_expense_not_payroll_source:'расход выплаченного начисления имеет другой тип',expense_link_reused:'расход связан с несколькими начислениями',amount_mismatch:'суммы отличаются',payment_date_mismatch:'даты отличаются'};
      const statusLabels={draft:'черновик',approved:'утверждено',paid:'выплачено'};
      const rows=payload.entries.map(row=>`<tr><td>${escapeHtml(row.employeeName||row.employeeId)}<br><small>${escapeHtml(row.employeeId)}</small></td><td>${escapeHtml(row.periodFrom)} — ${escapeHtml(row.periodTo)}</td><td>${escapeHtml(row.amount)} ₽</td><td>${escapeHtml(statusLabels[row.status]||row.status)}${row.ruleLinked?'':' · legacy без правила'}</td><td>${escapeHtml(row.expenseLink)}${row.expenseSource?` · ${escapeHtml(row.expenseSource)}`:''}${row.expenseAmount?` · ${escapeHtml(row.expenseAmount)} ₽`:''}</td><td>${escapeHtml(row.flags.map(flag=>flagLabels[flag]||flag).join('; ')||'Замечаний нет')}${row.overlapCount?`<br><small>Пересекающихся записей: ${escapeHtml(row.overlapCount)}</small>`:''}</td></tr>`).join('');
      const expenses=payload.payrollExpenses.map(row=>`<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.expenseDate)}</td><td>${escapeHtml(row.amount)} ₽</td><td>${escapeHtml(row.linkage)} · ссылок: ${escapeHtml(row.entryReferenceCount)}${row.provenance==='unknown'?' · связь с начислением не установлена':''}</td></tr>`).join('');
      return `<div class="warning-message" role="note"><strong>Диагностика только для чтения</strong><p>Происхождение записей расчёта неизвестно. Начисления относятся к P&amp;L, payroll-расходы — к денежным выплатам; не складывайте эти суммы. Связь расхода подтверждается только явным expense_id в пределах площадки.</p></div>${payload.truncated?'<p class="warning-message">Показаны первые 500 строк каждого списка. Уточните период.</p>':''}<h4>Зарплатные начисления: ${payload.entries.length}</h4>${rows?`<div class="table-scroll"><table><thead><tr><th>Сотрудник</th><th>Период начисления</th><th>Сумма</th><th>Статус</th><th>Связь с расходом</th><th>Замечания</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="empty">Начислений за период не найдено.</p>'}<h4>Payroll-расходы по дате расхода: ${payload.payrollExpenses.length}</h4>${expenses?`<div class="table-scroll"><table><thead><tr><th>ID расхода</th><th>Дата расхода</th><th>Сумма</th><th>Связь с начислением</th></tr></thead><tbody>${expenses}</tbody></table></div>`:'<p class="empty">Payroll-расходов за период не найдено.</p>'}`;
    };
    diagnosticRun.addEventListener('click',async()=>{
      const from=diagnosticFrom.value,to=diagnosticTo.value;
      const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
      if(!validDate(from)||!validDate(to)||from>to){diagnosticResult.textContent='Укажите реальные даты и проверьте, что дата окончания не раньше начала.';return;}
      const token=++diagnosticToken;const current=()=>token===diagnosticToken&&diagnosticFrom.value===from&&diagnosticTo.value===to;
      diagnosticRun.disabled=true;diagnosticResult.textContent='Читаем зарплатный реестр и явные связи с расходами…';
      try{const payload=await request(`/api/payroll/entry-overlap-diagnostic?${new URLSearchParams({from,to})}`);
        if(!current())return;
        if(payload.diagnosticOnly!==true||payload.period?.from!==from||payload.period?.to!==to)throw new Error('Ответ относится к другому периоду.');
        diagnosticResult.innerHTML=renderEntryDiagnostic(payload);
      }catch(error){if(current())diagnosticResult.textContent=`Не удалось проверить реестр: ${error.message}`;}
      finally{if(current())diagnosticRun.disabled=false;}
    });
    const runFullNetCandidate=async()=>{
      if(!readinessSavedSelection()||readinessLoading)return;
      const from=readinessFrom.value,to=readinessTo.value,versionId=selectedVersion.versionId;
      invalidateReadiness();
      if(!sourceReadinessPeriodValid(from,to)){candidateResult.textContent='Укажите реальные даты: начало — первый день месяца, конец — в том же месяце и не раньше начала.';return;}
      const token=++readinessToken;readinessLoading=true;refreshReadiness();candidateResult.textContent='Загружаем кандидатные данные сохранённой версии…';
      const current=()=>token===readinessToken&&readinessSavedSelection()&&selectedVersion.versionId===versionId&&readinessFrom.value===from&&readinessTo.value===to;
      try{
        const payload=await request(`/api/payroll/versions/${encodeURIComponent(versionId)}/preview/sourced`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({periodFrom:from,periodTo:to})});
        if(!current())return;
        if(payload.versionId!==versionId||payload.period?.from!==from||payload.period?.to!==to)throw new Error('Ответ относится к другой версии или периоду.');
          candidateResult.innerHTML=`${renderFullEmployeeNetCandidate(payload)}${renderOrderRevenueReconciliation(payload)}${renderRefundReview(payload)}${renderCandidateCalculation(payload)}${renderCandidateSnapshot(payload)}`;
      }catch(error){if(current())candidateResult.textContent=`Не удалось загрузить кандидатные данные: ${error.message}`;}
      finally{if(token===readinessToken){readinessLoading=false;refreshReadiness();}}
    };
    candidateRun.addEventListener('click',runFullNetCandidate);
    const runSourcedComparison=async()=>{
      if(readinessLoading)return;
      const versionIds=selectedComparisonVersions(),baselineVersionId=comparisonBaseline.value,from=readinessFrom.value,to=readinessTo.value;
      if(versionIds.length<2||versionIds.length>8){comparisonResult.textContent='Выберите от 2 до 8 сохранённых версий в списке схем.';return;}
      if(!versionIds.includes(baselineVersionId)){comparisonResult.textContent='Выберите базовую версию из отмеченных.';return;}
      if(!sourceReadinessPeriodValid(from,to)){comparisonResult.textContent='Укажите реальные даты: начало — первый день месяца, конец — в том же месяце и не раньше начала.';return;}
      const token=++readinessToken;readinessLoading=true;refreshReadiness();comparisonResult.setAttribute('aria-busy','true');comparisonResult.textContent='Сравниваем сохранённые версии на общих исходных данных…';
      const current=()=>token===readinessToken&&JSON.stringify(selectedComparisonVersions())===JSON.stringify(versionIds)&&comparisonBaseline.value===baselineVersionId&&readinessFrom.value===from&&readinessTo.value===to;
      try{
        const payload=await request('/api/payroll/compare/sourced',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({versionIds,baselineVersionId,periodFrom:from,periodTo:to})});
        if(!current())return;
        const responseVersions = payload.schemaVersion === 2 ? payload.results : payload.comparisons;
        if(payload.baselineVersionId!==baselineVersionId||payload.period?.from!==from||payload.period?.to!==to||!Array.isArray(responseVersions)||responseVersions.length!==versionIds.length||responseVersions.some((item,index)=>item.versionId!==versionIds[index])) throw new Error('Ответ относится к другим версиям или периоду.');
        comparisonResult.innerHTML=renderSourcedComparison(payload, ownerStaff);
        comparisonResult.querySelector('[data-sourced-comparison-heading]')?.focus({preventScroll:true});
      }catch(error){if(current())comparisonResult.textContent=`Не удалось сравнить версии: ${error.message}`;}
      finally{if(token===readinessToken){comparisonResult.removeAttribute('aria-busy');readinessLoading=false;refreshReadiness();}}
    };
    comparisonRun.addEventListener('click',runSourcedComparison);
    comparisonBaseline.addEventListener('change',invalidateSourcedComparison);
    list.addEventListener('change',event=>{if(event.target.matches('[data-scheme-compare-version]')){invalidateSourcedComparison();refreshReadiness();}});
    for(const field of [readinessFrom,readinessTo]){field.addEventListener('input',invalidateReadiness);field.addEventListener('change',invalidateReadiness);}
    editor.addEventListener('input',refreshReadiness);editor.addEventListener('change',refreshReadiness);
    const sourcePolicyControls = () => ({ enabled: sourcePolicyEnabled.checked, schemaVersion: sourcePolicyVersion.value, saleCredit: sourcePolicySale.value,
      discountAllocation: sourcePolicyDiscount.value, refunds: sourcePolicyRefund.value, selectionReason: sourcePolicyReason.value });
    const refreshSourcePolicyDisabled = () => {
      const disabled = pending || editorAction?.kind === 'inspect' || gridStale;
      sourcePolicyFieldset.disabled = disabled;
      for (const field of [sourcePolicyVersion, sourcePolicySale, sourcePolicyDiscount, sourcePolicyRefund, sourcePolicyReason]) {
        field.disabled = disabled || !sourcePolicyEnabled.checked;
        field._customSelectRefresh?.();
      }
      sourcePolicyV2Explanation.hidden = !sourcePolicyEnabled.checked || sourcePolicyVersion.value !== '2';
    };
    const rebuildSourcePolicy = (definition) => {
      const values = sourcePolicyControlValues(definition);
      sourcePolicyEnabled.checked = values.enabled;
      for (const [field, value] of [[sourcePolicyVersion, values.schemaVersion], [sourcePolicySale, values.saleCredit], [sourcePolicyDiscount, values.discountAllocation], [sourcePolicyRefund, values.refunds]]) {
        field.querySelectorAll('[data-policy-unknown]').forEach((option) => option.remove());
        if (value && ![...field.options].some((option) => option.value === value)) { const option = document.createElement('option'); option.value = String(value); option.textContent = `Неизвестное правило: ${String(value)}`; option.dataset.policyUnknown = 'true'; field.append(option); }
        field.value = String(value);
      }
      sourcePolicyReason.value = typeof values.selectionReason === 'string' ? values.selectionReason : '';
      sourcePolicyDirty = false; refreshSourcePolicyDisabled();
      sourcePolicyMessage.textContent = values.enabled ? 'Выбор сохранён в JSON; источники и выполнение правил ещё не подтверждены.' : 'Правила не выбраны. Сценарий доступен; официальный расчёт требует подтверждённых источников.';
    };
    const markSourcePolicyDirty = () => {
      if (pending || editorAction?.kind === 'inspect' || gridStale) return;
      sourcePolicyDirty = true; payoutRiskAcknowledgementField.checked = false; refreshSourcePolicyDisabled();
      sourcePolicyMessage.textContent = 'Есть неприменённые изменения правил источников.';
    };
    sourcePolicyFieldset.addEventListener('input', markSourcePolicyDirty);
    sourcePolicyFieldset.addEventListener('change', markSourcePolicyDirty);
    let gridSource = null, gridDirty = false, gridStale = false;
    let roleImpactSelection = null;
    const rawGridFields = () => [...grid.querySelectorAll('[data-grid-role]')].map((node) => ({ role: node.dataset.gridRole, path: node.dataset.gridPath, type: node.dataset.gridType, text: node.value }));
    const rawGridOverrides = () => [...grid.querySelectorAll('[data-grid-override]')].map((card) => ({ index: card.dataset.gridOverride === 'new' ? null : Number(card.dataset.gridOverride),
      employeeId: card.querySelector('[data-grid-employee]').value, path: card.querySelector('[data-grid-override-path]').value.trim(), mode: card.querySelector('[data-grid-override-mode]').value,
      text: card.querySelector('[data-grid-override-value]').value, effectiveFrom: card.querySelector('[data-grid-override-from]').value, effectiveTo: card.querySelector('[data-grid-override-to]').value }));
    const currentGridDefinition = () => {
      const control=grid.querySelector('[data-grid-scheme-milestone-eligibility]');
      return control ? editorApplyMilestoneEligibility(gridSource,control.value) : gridSource;
    };
    const refreshRoleImpact = () => {
      const targets = [...grid.querySelectorAll('[data-grid-role-impact]')];
      try {
        if (!gridSource || gridStale) throw new Error('JSON изменён. Обновите таблицу для определения влияния.');
        const definition = editorApply(currentGridDefinition(), rawGridFields(), rawGridOverrides());
        const impacts = editorRoleOverrideImpact(definition);
        refreshPersonalCap(definition);
        for (const node of targets) {
          const path = roleImpactSelection?.role === node.dataset.gridRoleImpact ? roleImpactSelection.path : undefined;
          node.innerHTML = editorRoleImpactHtml(impacts.filter((item) => item.roleId === node.dataset.gridRoleImpact && (path === undefined || path === item.path)), path);
          node.dataset.impactState = 'valid';
        }
      } catch (error) {
        personalCapField.checked = false; personalCapField.disabled = true; personalCapBox.hidden = false;
        personalCapBox.dataset.state = 'invalid'; personalCapList.textContent = `Исправьте конфигурацию для проверки личных лимитов. ${error.message}`;
        for (const node of targets) { node.textContent = `Исправьте личные параметры, чтобы определить влияние. ${error.message}`; node.dataset.impactState = 'invalid'; }
      }
    };
    const gridControl = (role, path, type, value, choices = []) => {
      if (type === 'departmentKey' && value !== undefined) editorDepartmentKey(value);
      const attrs = `data-grid-role="${escapeHtml(role)}" data-grid-path="${escapeHtml(path)}" data-grid-type="${type === 'select' ? 'text' : type}" aria-label="${escapeHtml(`${editorRoleLabel(role)}: ${editorParameterLabel(path)}`)}"`;
      const formatted = ['money', 'rate'].includes(type) ? editorFormat(value) : type === 'departments' && Array.isArray(value) ? value.join(', ') : value ?? '';
      if (path === 'milestoneEligibility') {
        const inherited=gridSource.milestoneEligibility===undefined?'all_active':gridSource.milestoneEligibility;
        editorMilestoneEligibilityValue(inherited); if(value!==undefined)editorMilestoneEligibilityValue(value);
        return `<select ${attrs}><option value="" ${value===undefined?'selected':''}>Наследовать: ${escapeHtml(EDITOR_MILESTONE_LABELS[inherited])} (схема)</option>${EDITOR_MILESTONE_POLICIES.map(policy=>`<option value="${policy}" ${value===policy?'selected':''}>${escapeHtml(EDITOR_MILESTONE_LABELS[policy])}</option>`).join('')}</select>`;
      }
      if (type === 'boolean') {
        if (value !== undefined && typeof value !== 'boolean') throw new Error('Логический параметр роли должен быть true или false.');
        const inherited = editorRoleMilestonesDefault(gridSource, role);
        return `<select ${attrs}><option value="" ${value === undefined ? 'selected' : ''}>Наследовать: ${inherited ? 'начислять' : 'не начислять'} (схема / режим)</option><option value="true" ${value === true ? 'selected' : ''}>Начислять</option><option value="false" ${value === false ? 'selected' : ''}>Не начислять</option></select>`;
      }
      if (type === 'departmentKey') return `<select ${attrs}>${editorOptionsHtml(editorDepartmentOptions(ownerDepartments, formatted), formatted, 'Не задано / наследовать')}</select>`;
      return type === 'select' ? `<select ${attrs}><option value="">${path === 'mode' ? escapeHtml(`По схеме: ${EDITOR_CHOICE_LABELS[gridSource.mode] || gridSource.mode}`) : 'Не задано / наследовать'}</option>${[...new Set([...choices, ...(value && !choices.includes(value) ? [value] : [])])].map((choice) => `<option value="${escapeHtml(choice)}" ${choice === value ? 'selected' : ''}>${escapeHtml(EDITOR_CHOICE_LABELS[choice] || choice)}</option>`).join('')}</select>`
        : `<input ${attrs} value="${escapeHtml(formatted)}" ${['money', 'rate', 'integer'].includes(type) ? 'inputmode="decimal"' : ''}>`;
    };
    const overrideCard = (item = {}, index = null) => {
      const type = editorOverrideType(item.path || '');
      if (type === 'departmentKey' && item.mode === 'override') editorDepartmentKey(item.value);
      const value = item.mode === 'override' ? ['money', 'rate'].includes(type) ? editorFormat(item.value) : String(item.value ?? '') : '';
      const inheritedCaption = editorInheritedCaption(gridSource,item);
      return `<section data-grid-override="${index === null ? 'new' : index}"><p data-grid-inherited-caption>${escapeHtml(inheritedCaption)}</p><div class="form-row"><label>Сотрудник<select data-grid-employee>${editorOptionsHtml(editorEmployeeOptions(ownerStaff, gridSource, item.employeeId), item.employeeId, 'Выберите сотрудника')}</select></label><label>Параметр<select data-grid-override-path>${editorOptionsHtml(editorParameterOptions(gridSource, item.path), item.path, 'Выберите параметр')}</select></label><label>Назначение<select data-grid-override-mode><option value="override" ${item.mode !== 'inherit' ? 'selected' : ''}>Персонально</option><option value="inherit" ${item.mode === 'inherit' ? 'selected' : ''}>По роли</option></select></label><label data-grid-value-label><span>${type === 'departmentKey' ? 'Личный цех' : 'Личное значение (сумма / %)'}</span>${type === 'departmentKey' ? `<select data-grid-override-value>${editorOptionsHtml(editorDepartmentOptions(ownerDepartments, value), value, 'Выберите цех')}</select>` : `<input data-grid-override-value value="${escapeHtml(value)}">`}</label><label>С даты<input type="date" data-grid-override-from value="${escapeHtml(item.effectiveFrom || '')}"></label><label>По дату<input type="date" data-grid-override-to value="${escapeHtml(item.effectiveTo || '')}"></label></div><button type="button" class="button" data-grid-inherit>Вернуть к значению роли для этого периода</button></section>`;
    };
    const organizeGrid=()=>{
      const roles=[...grid.querySelectorAll(':scope > details')];
      const rate=grid.querySelector('[data-grid-rate-table]')?.parentElement;
      if(rate){const next=rate.nextElementSibling;const rates=disclosure(rate,'Диапазоны оборота и процентные ставки');if(next?.matches('.form-row'))rates.append(next);}
      const milestone=grid.querySelector('[data-grid-milestone-table]')?.parentElement;
      if(milestone){const next=milestone.nextElementSibling,help=next?.nextElementSibling;const bonuses=disclosure(milestone,'Пороговые премии: суммы по ролям');if(next)bonuses.append(next);if(help?.tagName==='P')bonuses.append(help);
        const eligibility=grid.querySelector('[data-grid-scheme-milestone-eligibility]')?.closest('.form-row');if(eligibility){const hint=eligibility.nextElementSibling;bonuses.append(eligibility);if(hint?.tagName==='P')bonuses.append(hint);}}
      roles.forEach((role,index)=>{role.classList.add('scheme-group');role.dataset.gridRoleCard='';role.open=index===0;const fields=role.querySelector(':scope > .form-row');
        const groups=[['Основная оплата',path=>['mode','perShiftCents','stableRateBps'].includes(path)],['Премии и личный план',path=>['applyMilestones','milestoneEligibility','targetCents','baseRateBps','bonusRateBps','excessRatePolicy'].includes(path)],['Лимиты и расчёт от маржи',path=>path.startsWith('cap.')||['department','lossPolicy','itemRuleBasis'].includes(path)],['Командный фонд',()=>true]];
        for(const [title,matches] of groups){const labels=[...fields.children].filter(label=>matches(label.querySelector('[data-grid-path]')?.dataset.gridPath||''));if(!labels.length)continue;const row=document.createElement('div');row.className='form-row scheme-role-fields';row.append(...labels);fields.before(row);const grouped=disclosure(row,title);grouped.open=title==='Основная оплата';if(title==='Лимиты и расчёт от маржи'){const help=document.createElement('p');help.className='muted';help.textContent=EDITOR_DEPARTMENT_HELP;grouped.append(help);}}
        fields.remove();const impact=role.querySelector('[data-grid-role-impact]');if(impact)disclosure(impact,'Какие личные условия перекрывают эту роль');
      });
      if(roles.length)grid.prepend(...roles);
      const overrides=grid.querySelector('[data-grid-overrides]');if(overrides){const title=overrides.previousElementSibling?.previousElementSibling;const add=overrides.nextElementSibling;const personal=disclosure(overrides,'Индивидуальные условия сотрудников');if(title?.tagName==='H4')title.remove();const help=document.createElement('p');help.className='muted';help.textContent='Выберите сотрудника, параметр и период действия личных условий. '+EDITOR_DEPARTMENT_HELP;personal.append(help);if(add?.matches('[data-grid-add-override]'))personal.append(add);}
    };
    const rebuildGrid = () => {
      try {
        const definition = JSON.parse(definitionField.value);
        if (!definition?.roleParameters || typeof definition.roleParameters !== 'object' || Array.isArray(definition.roleParameters)) throw new Error('Нужен объект roleParameters.');
        gridSource = definition; gridDirty = false; gridStale = false; roleImpactSelection = null;
        rebuildSourcePolicy(definition);
        const roles = Object.keys(definition.roleParameters);
        const thresholds = [...new Set(roles.flatMap((role) => Object.keys(definition.roleParameters[role].bracketRatesBps || {})))].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
        if (thresholds.some((key) => !/^\d+$/.test(key) || !Number.isSafeInteger(Number(key)))) throw new Error('Некорректный порог оборота.');
        const milestoneThresholds = editorMilestoneThresholds(definition);
        const milestoneCurrency = !definition.currency || definition.currency === 'RUB' ? '₽' : definition.currency;
        const milestoneGrid = `<div style="max-width:100%;overflow-x:auto"><table data-grid-milestone-table><caption>Пороговые премии × роли; суммы в ${escapeHtml(milestoneCurrency)}</caption><thead><tr><th>Оборот от, ${escapeHtml(milestoneCurrency)}</th>${roles.map((role) => `<th>${escapeHtml(editorRoleLabel(role))}</th>`).join('')}</tr></thead><tbody>${milestoneThresholds.map((threshold) => `<tr><th>${escapeHtml(editorFormat(Number(threshold)))}</th>${roles.map((role) => `<td>${gridControl(role, `milestoneBonusesCents.${threshold}`, 'money', definition.roleParameters[role].milestoneBonusesCents?.[threshold])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="form-row"><label>Новый порог премии, ${escapeHtml(milestoneCurrency)}<input data-grid-new-milestone-threshold inputmode="decimal"></label><button type="button" class="button" data-grid-add-milestone-threshold>Добавить порог премии</button></div><p>Пустая сумма удаляет премию роли для этого порога; 0 сохраняет нулевую премию. Начисление зависит от переключателя роли и личных параметров.</p>`;
        grid.innerHTML = `<div style="max-width:100%;overflow-x:auto"><table data-grid-rate-table><caption>Диапазоны оборота × роли; ставки в %</caption><thead><tr><th>Оборот от, ${escapeHtml(milestoneCurrency)}</th>${roles.map((role) => `<th>${escapeHtml(editorRoleLabel(role))}</th>`).join('')}</tr></thead><tbody>${thresholds.map((threshold) => `<tr><th>${escapeHtml(editorFormat(Number(threshold)))}</th>${roles.map((role) => `<td>${gridControl(role, `bracketRatesBps.${threshold}`, 'rate', definition.roleParameters[role].bracketRatesBps?.[threshold])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="form-row"><label>Новый порог оборота, ${escapeHtml(milestoneCurrency)}<input data-grid-new-threshold inputmode="decimal"></label><button type="button" class="button" data-grid-add-threshold>Добавить диапазон</button></div>${milestoneGrid}${roles.map((role) => `<details open><summary>${escapeHtml(editorRoleLabel(role))} · суммы, ${escapeHtml(milestoneCurrency)}</summary><div class="form-row">${EDITOR_FIELDS.map(([path, label, type, choices]) => `<label>${escapeHtml(label)}${gridControl(role, path, type, editorGet(definition.roleParameters[role], path), choices)}</label>`).join('')}</div><div data-grid-role-impact="${escapeHtml(role)}"></div></details>`).join('')}<h4>Карточки личных параметров</h4><datalist id="payroll-grid-employees">${[...new Set((definition.roleAssignments || []).map((row) => row.employeeId))].map((id) => `<option value="${escapeHtml(id)}"></option>`).join('')}</datalist><div data-grid-overrides>${(definition.employeeOverrides || []).map((item, index) => overrideCard(item, index)).join('')}</div><button type="button" class="button" data-grid-add-override>Добавить личный параметр</button>`;
        const schemeEligibility=definition.milestoneEligibility===undefined?'':editorMilestoneEligibilityValue(definition.milestoneEligibility);
        grid.insertAdjacentHTML('afterbegin',`<div class="form-row"><label>Условие выплаты пороговой премии по схеме<select data-grid-scheme-milestone-eligibility aria-label="Условие выплаты пороговой премии по схеме"><option value="" ${schemeEligibility===''?'selected':''}>Прежнее правило: активные сотрудники</option>${EDITOR_MILESTONE_POLICIES.map(policy=>`<option value="${policy}" ${schemeEligibility===policy?'selected':''}>${escapeHtml(EDITOR_MILESTONE_LABELS[policy])}</option>`).join('')}</select></label></div><p>Личное правило имеет приоритет над ролью, роль — над схемой. Премия за работу требует положительных подтверждённых минут в день порога и не переносится на следующий день. Отключённые премии не начисляются.</p>`);
        organizeGrid();
        gridFieldset.disabled = pending || editorAction?.kind === 'inspect'; gridMessage.textContent = 'Таблица соответствует JSON. Изменения таблицы примените перед подтверждением риска.';
        refreshRoleImpact();
      } catch (error) { gridSource = null; grid.innerHTML = ''; sourcePolicyFieldset.disabled = true; gridMessage.textContent = `Таблица недоступна: ${error.message}. Исправьте расширенный JSON.`; panel.querySelector('[data-scheme-advanced]').open = true; }
    };
    const applyGrid = () => {
      if (!gridSource || gridStale) throw new Error('Обновите таблицу из корректного JSON.');
      for(const control of grid.querySelectorAll('[data-grid-role]')){try{editorValue(control.value,control.dataset.gridPath==='milestoneEligibility'?'milestoneEligibility':control.dataset.gridType);}catch(error){control.setCustomValidity(error.message);revealControl(control);control.reportValidity();throw error;}}
      const fields = [...grid.querySelectorAll('[data-grid-role]')].map((node) => ({ role: node.dataset.gridRole, path: node.dataset.gridPath, type: node.dataset.gridType, text: node.value }));
      const overrides = [...grid.querySelectorAll('[data-grid-override]')].map((card) => ({ index: card.dataset.gridOverride === 'new' ? null : Number(card.dataset.gridOverride),
        employeeId: card.querySelector('[data-grid-employee]').value, path: card.querySelector('[data-grid-override-path]').value.trim(), mode: card.querySelector('[data-grid-override-mode]').value,
        text: card.querySelector('[data-grid-override-value]').value, effectiveFrom: card.querySelector('[data-grid-override-from]').value, effectiveTo: card.querySelector('[data-grid-override-to]').value }));
      let definition;
      try { definition = editorApply(currentGridDefinition(), fields, overrides); }
      catch(error){
        // Cross-row validation cannot reliably name one field (for example,
        // overlapping override periods). Reveal the whole review group instead.
        const personalGroup=grid.querySelector('[data-grid-overrides]')?.closest('details');
        if(overrides.length&&personalGroup)revealControl(personalGroup.querySelector('summary'));
        else revealControl(definitionField);
        gridMessage.textContent=`Параметры не применены: ${error.message}`;
        throw error;
      }
      if (sourcePolicyDirty) definition = applySourcePolicyControls(definition, sourcePolicyControls());
      definitionField.value = JSON.stringify(definition, null, 2); payoutRiskAcknowledgementField.checked = false; rebuildGrid();
      gridMessage.textContent = 'Таблица применена к черновику. Подтвердите риск и сохраните версию.';
      revealControl(payoutRiskAcknowledgementField);
    };
    const refreshRoleMilestoneDefaults = () => {
      if (!gridSource || gridStale) return;
      for (const control of grid.querySelectorAll('[data-grid-path="applyMilestones"][data-grid-role]')) {
        const mode = [...grid.querySelectorAll('[data-grid-path="mode"][data-grid-role]')].find(node => node.dataset.gridRole === control.dataset.gridRole)?.value;
        try { control.options[0].textContent = `Наследовать: ${editorRoleMilestonesDefault(gridSource, control.dataset.gridRole, mode) ? 'начислять' : 'не начислять'} (схема / режим)`; }
        catch (_) { control.options[0].textContent = 'Наследование недоступно: проверьте режим и JSON'; }
        control._customSelectRefresh?.();
      }
      for(const control of grid.querySelectorAll('[data-grid-path="milestoneEligibility"][data-grid-role]')){
        try{const value=currentGridDefinition().milestoneEligibility??'all_active';editorMilestoneEligibilityValue(value);control.options[0].textContent=`Наследовать: ${EDITOR_MILESTONE_LABELS[value]} (схема)`;}
        catch(_){control.options[0].textContent='Наследование недоступно: проверьте условие премии';}
        control._customSelectRefresh?.();
      }
    };
    const markGridDirty = (event) => { if (pending || editorAction?.kind === 'inspect' || gridStale) return; gridDirty = true; payoutRiskAcknowledgementField.checked = false; gridMessage.textContent = 'Есть неприменённые изменения таблицы.';
      if (event?.target?.dataset.gridRole) roleImpactSelection = { role: event.target.dataset.gridRole, path: event.target.dataset.gridPath };
      refreshRoleImpact();
      refreshRoleMilestoneDefaults();
    };
    definitionField.addEventListener('input', refreshRoleImpact);
    const resetPersonalCapAcknowledgement = (event) => {
      if (event.target !== personalCapField && event.target !== payoutRiskAcknowledgementField) personalCapField.checked = false;
    };
    editor.addEventListener('input', resetPersonalCapAcknowledgement);
    editor.addEventListener('change', resetPersonalCapAcknowledgement);
    grid.addEventListener('change', event => {
      if (!event.target.matches('[data-grid-override-path]') || editorAction?.kind === 'inspect') return;
      const card = event.target.closest('[data-grid-override]');
      const old = card.querySelector('[data-grid-override-value]'), value = old.value;
      const department = editorDepartmentPath(event.target.value);
      const replacement = document.createElement(department ? 'select' : 'input');
      replacement.dataset.gridOverrideValue = ''; replacement.disabled = old.disabled;
      if (department) replacement.innerHTML = editorOptionsHtml(editorDepartmentOptions(ownerDepartments, value), value, 'Выберите цех');
      else replacement.value = value;
      const wrapper = old.parentElement;
      if (wrapper?.classList.contains('custom-select')) wrapper.replaceWith(replacement);
      else old.replaceWith(replacement);
      card.querySelector('[data-grid-value-label] > span').textContent = department ? 'Личный цех' : 'Личное значение (сумма / %)';
    });
    grid.addEventListener('input', markGridDirty);
    grid.addEventListener('change', markGridDirty);
    const refreshInheritedCaptions = () => {
      const fields=rawGridFields();
      for(const card of grid.querySelectorAll('[data-grid-override]')){
        const label=card.querySelector('[data-grid-inherited-caption]');
        if(gridStale){label.textContent='JSON изменён. Обновите таблицу для проверки наследования.';continue;}
        label.textContent=editorInheritedCaption(currentGridDefinition(),{employeeId:card.querySelector('[data-grid-employee]').value.trim(),
          path:card.querySelector('[data-grid-override-path]').value.trim(),effectiveFrom:card.querySelector('[data-grid-override-from]').value},fields);
      }
    };
    grid.addEventListener('input',refreshInheritedCaptions);
    grid.addEventListener('change',refreshInheritedCaptions);
    definitionField.addEventListener('input',refreshInheritedCaptions);
    const attendanceWatermark = { value: null };
    let attendanceCoverage = null;
    let attendancePage = 0;
    const attendanceVisitedPages = new Set();
    const renderAttendance = (data, page = 0) => {
      attendanceCoverage = data;
      const shiftSource = data?.shifts || [];
      const pageCount = Math.max(1, Math.ceil(shiftSource.length / ATTENDANCE_SHIFTS_PER_PAGE));
      attendancePage = Math.max(0, Math.min(page, pageCount - 1));
      attendanceVisitedPages.add(attendancePage);
      attendanceWatermark.value = data?.sourceWatermark || null;
      const reasons = (data?.reasons || []).map((code) => `<li>${escapeHtml(attendanceReasonLabels[code] || code)}</li>`).join('');
      const pageStart = attendancePage * ATTENDANCE_SHIFTS_PER_PAGE;
      const shifts = shiftSource.slice(pageStart, pageStart + ATTENDANCE_SHIFTS_PER_PAGE).map((shift) => {
        const intervalSource = shift.sourceIntervals || [];
        const intervals = intervalSource.map((interval) => `<li>${escapeHtml(new Date(interval.startedAt).toLocaleString('ru-RU'))} — ${escapeHtml(new Date(interval.endedAt).toLocaleString('ru-RU'))} · ${escapeHtml(interval.source)}</li>`).join('');
        return `<tr><td>${escapeHtml(shift.workDate)}</td><td>${escapeHtml(shift.employeeName)}</td><td>${escapeHtml(shift.scheduledFunctionName || 'Не назначена')}</td><td>${escapeHtml(shift.plannedMinutes)}</td><td>${escapeHtml(shift.workedMinutes)}</td><td><details><summary>${escapeHtml(intervalSource.length)} интервалов</summary><ul>${intervals || '<li>Закрытых интервалов нет.</li>'}</ul></details></td></tr>`;
      }).join('');
      const pageControls = pageCount > 1 ? `<div class="toolbar-row"><button type="button" class="button small" data-attendance-page="${attendancePage - 1}" ${attendancePage === 0 ? 'disabled' : ''}>Предыдущие смены</button><span>Страница ${attendancePage + 1} из ${pageCount}. Просмотрено: ${attendanceVisitedPages.size} из ${pageCount}.</span><button type="button" class="button small" data-attendance-page="${attendancePage + 1}" ${attendancePage >= pageCount - 1 ? 'disabled' : ''}>Следующие смены</button></div>` : '';
      const history = (data?.history || []).map((item) => `<li>Ревизия ${escapeHtml(item.revision)} · ${escapeHtml(item.approvedByName)} · ${escapeHtml(new Date(item.approvedAt).toLocaleString('ru-RU'))} · ${escapeHtml(item.reason)}</li>`).join('');
      const approved = data?.currentApproval;
      const approval = approved ? `<section><strong>Последнее утверждение: ревизия ${escapeHtml(approved.revision)}</strong><p>${data.stale ? 'Источник изменился после утверждения — требуется новая проверка и ревизия.' : 'Источник совпадает с утверждённым снимком.'}</p><p>Утвердил: ${escapeHtml(approved.approvedByName)} · ${escapeHtml(new Date(approved.approvedAt).toLocaleString('ru-RU'))}</p></section>` : '<p>Для этого периода ещё нет утверждённого снимка.</p>';
      attendanceResult.innerHTML = `<p><strong>${data?.complete ? 'Период можно утвердить' : 'Нужно исправить источник перед утверждением'}</strong></p><p>Плановых смен: ${escapeHtml(data?.scheduleCount ?? 0)} · Интервалов: ${escapeHtml(data?.logCount ?? 0)} · SHA-256 источника: <code>${escapeHtml(data?.sourceWatermark || '—')}</code></p><p class="muted">Функция ниже взята из календаря и не является POS-цехом, станцией или подтверждением продажи.</p>${reasons ? `<ul>${reasons}</ul>` : ''}${pageControls}<div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Дата</th><th>Сотрудник</th><th>Функция по расписанию</th><th>План, мин</th><th>Факт, мин</th><th>Исходные интервалы</th></tr></thead><tbody>${shifts || '<tr><td colspan="6">Плановых смен за период нет.</td></tr>'}</tbody></table></div>${pageControls}${data?.stale ? '<p class="warning-message">Последний снимок устарел относительно текущего табеля.</p>' : ''}${approval}${history ? `<details><summary>История утверждений</summary><ul>${history}</ul></details>` : ''}`;
      const allRowsReviewed = attendanceVisitedPages.size === pageCount;
      const canApprove = Boolean(data?.complete && data?.sourceWatermark && allRowsReviewed && (!approved || data.stale));
      attendanceApprove.disabled = !canApprove;
    };
    const refreshAttendance = async () => {
      attendanceApprove.disabled = true;
      attendanceRefresh.disabled = true;
      attendanceVisitedPages.clear();
      attendanceResult.textContent = 'Проверяем расписание и рабочие интервалы…';
      try {
        const params = new URLSearchParams({ from: attendanceFrom.value, to: attendanceTo.value });
        const result = await request(`/api/payroll/attendance/approvals?${params}`);
        renderAttendance(result);
      } catch (error) {
        attendanceCoverage = null; attendanceWatermark.value = null;
        attendanceResult.textContent = attendanceErrorLabels[error.message] || `Не удалось проверить табель: ${error.message}`;
      } finally { attendanceRefresh.disabled = false; }
    };
    const attendanceDate = venueLocalToday();
    attendanceFrom.value = `${attendanceDate.slice(0, 7)}-01`;
    attendanceTo.value = attendanceDate;
    previewInput.value = JSON.stringify(defaultPreview(), null, 2);
    previewInput.addEventListener('input', () => { previewInput.dataset.userEdited = 'true'; });
    const venueTimezonePromise = request('/api/venue').then((venue) => {
      if (typeof venue?.timezone === 'string' && venue.timezone.trim()) venueTimezone = venue.timezone.trim();
      if (!diagnosticFrom.dataset.userEdited && !diagnosticTo.dataset.userEdited) {
        const localToday=venueLocalToday(),nextFrom=`${localToday.slice(0,7)}-01`,nextTo=localToday;
        if(diagnosticFrom.value!==nextFrom||diagnosticTo.value!==nextTo){diagnosticFrom.value=nextFrom;diagnosticTo.value=nextTo;invalidateEntryDiagnostic();}
      }
      if (!previewInput.dataset.userEdited) previewInput.value = JSON.stringify(defaultPreview(), null, 2);
    }).catch(() => null);
    diagnosticFrom.addEventListener('input',()=>{diagnosticFrom.dataset.userEdited='true';});
    diagnosticTo.addEventListener('input',()=>{diagnosticTo.dataset.userEdited='true';});

    const notify = (text, kind = '') => { message.textContent = text; message.className = `form-message${kind ? ` ${kind}-message` : ''}`; };
    const definitionFromVersion = (version) => ({
      mode: version.mode, currency: version.currency, effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo,
      applyMilestones: version.applyMilestones, milestoneCapPolicy: version.milestoneCapPolicy,
      ...(version.milestoneEligibility === undefined ? {} : { milestoneEligibility: version.milestoneEligibility }),
      ...(version.sourcePolicies === undefined ? {} : { sourcePolicies: structuredClone(version.sourcePolicies) }),
      roleParameters: version.roleParameters, roleAssignments: version.roleAssignments,
      employeeOverrides: version.employeeOverrides, itemRules: version.itemRules
    });
    const sortedVersions = (scheme) => [...(scheme.versions || [])].sort((left, right) => Number(right.versionNo) - Number(left.versionNo));
    const editorStateSnapshot = () => ({ name: nameField.value, description: descriptionField.value,
      definition: definitionField.value, grid: JSON.stringify({ roles: rawGridFields(), overrides: rawGridOverrides() }),
      sourcePolicy: JSON.stringify(sourcePolicyControls()), riskAcknowledged: payoutRiskAcknowledgementField.checked,
      personalCapAcknowledged: personalCapField.checked, gridDirty, sourcePolicyDirty });
    const editorHasUnsavedChanges = () => Boolean(editorAction
      && payrollEditorStateChanged(editorBaseline, editorStateSnapshot()));
    const confirmEditorReplacement = async () => {
      if (!editorHasUnsavedChanges()) return true;
      const title = 'Есть несохранённые изменения';
      const description = 'Если открыть другой вариант схемы, текущие изменения редактора будут потеряны.';
      if (typeof portalConfirm === 'function') return await portalConfirm(title, description, 'Открыть другой вариант');
      return window.confirm(`${title}\n\n${description}`);
    };
    const editorTransition = createPayrollEditorTransitionGate(confirmEditorReplacement);
    const beginEditorTransition = () => editorTransition.begin(editorHasUnsavedChanges());
    const allowLoadedEditorReplacement = async (token, stateAtRequest) => {
      if (!editorTransition.isCurrent(token)) return false;
      if (editorHasUnsavedChanges() && payrollEditorStateChanged(stateAtRequest, editorStateSnapshot())
          && !await confirmEditorReplacement()) return false;
      return editorTransition.isCurrent(token);
    };
    const renderList = () => {
      if (!schemes.length) { list.innerHTML = '<div class="empty">Схем пока нет. Создайте схему и сохраните первую черновую версию.</div>'; return; }
      list.innerHTML = schemes.map((scheme) => `<article class="finance-scheme-card"><div class="panel-head"><div><h3>${escapeHtml(scheme.name)}</h3><small class="muted">${escapeHtml(scheme.description || 'Без описания')}</small></div></div><div class="finance-scheme-versions">${sortedVersions(scheme).map((version) => `<div class="payment-row"><label><input type="checkbox" data-scheme-compare-version="${escapeHtml(version.id)}"> Сравнить</label><span>Версия ${escapeHtml(version.versionNo)} · ${escapeHtml(EDITOR_CHOICE_LABELS[version.mode] || version.mode)} · ${escapeHtml(version.effectiveFrom)}${version.effectiveTo ? ` — ${escapeHtml(version.effectiveTo)}` : ''}<small class="muted">${version.payoutRiskAcknowledgement?.configDigest ? `Риск подтверждён владельцем ${escapeHtml(version.payoutRiskAcknowledgement.acknowledgedAt || '')}` : 'Подтверждение риска не сохранено'}</small></span><span class="badge ${version.status === 'active' ? 'success' : version.status === 'draft' ? 'warning' : ''}">${escapeHtml(editorStatusLabel(version.status))}</span><div class="toolbar-row"><button type="button" class="button small" data-scheme-open-version="${escapeHtml(version.id)}">Открыть</button>${version.status === 'draft' ? `<button type="button" class="button small primary" data-scheme-activate="${escapeHtml(version.id)}">Активировать</button>` : ''}<button type="button" class="button small" data-scheme-revisions="${escapeHtml(version.id)}">История</button></div></div>`).join('') || '<div class="empty">Черновых версий нет</div>'}<div class="toolbar-row"><button type="button" class="button small" data-scheme-new-version="${escapeHtml(scheme.id)}">Создать новую версию</button></div></div></article>`).join('');
    };
    const load = async ({ force = false } = {}) => {
      if (pending && !force) return;
      invalidateReadiness();
      notify('Загружаем настройки…');
      list.innerHTML = '<div class="empty">Загрузка схем…</div>';
      try { const data = await request('/api/payroll/schemes'); schemes = Array.isArray(data.items) ? data.items : []; renderList(); notify(schemes.length ? '' : ''); }
      catch (error) { schemes = []; list.innerHTML = `<div class="empty">Не удалось загрузить схемы (${escapeHtml(error.message)}). <button type="button" class="button small" data-scheme-retry>Повторить</button></div>`; notify('Настройки недоступны.', 'error'); }
    };
    const openVersion = async (versionId, transitionToken = null) => {
      const token = transitionToken ?? await beginEditorTransition();
      if (token === null || !editorTransition.isCurrent(token)) return false;
      const stateAtRequest = editorStateSnapshot();
      invalidateReadiness();
      let version;
      try { version = await request(`/api/payroll/versions/${encodeURIComponent(versionId)}`); }
      catch (error) { if (!editorTransition.isCurrent(token)) return false; throw error; }
      if (!editorTransition.isCurrent(token)) return false;
      if (!await allowLoadedEditorReplacement(token, stateAtRequest)) return false;
      selectedVersion = version;
      previewBox.hidden = false;
      if (!previewInput.value.trim()) previewInput.value = JSON.stringify(defaultPreview(), null, 2);
      previewResult.hidden = true;
      panel.querySelector('[data-scheme-selected-label]').textContent = `${version.name} · версия ${version.versionNo} · ${editorStatusLabel(version.status)}`;
      editorAction = version.status === 'draft' ? { kind: 'edit', versionId } : { kind: 'inspect', versionId };
      panel.querySelector('[data-scheme-editor-title]').textContent = version.status === 'draft' ? 'Редактирование черновика' : `${editorStatusLabel(version.status)} (только чтение)`;
      nameField.value = version.name || ''; descriptionField.value = version.description || '';
      definitionField.value = JSON.stringify(definitionFromVersion(version), null, 2);
      nameField.disabled = true; descriptionField.disabled = true; definitionField.readOnly = version.status !== 'draft';
      payoutRiskAcknowledgementField.checked = false;
      payoutRiskAcknowledgementLabel.hidden = version.status !== 'draft';
      payoutRiskAcknowledgementField.disabled = version.status !== 'draft';
      panel.querySelector('[data-scheme-save]').hidden = version.status !== 'draft';
      editor.hidden = false;
      rebuildGrid();
      editorBaseline = editorStateSnapshot();
      refreshReadiness();
      selectWorkspace('configuration',{focus:true});
      notify(version.status === 'draft' ? 'Открыт редактируемый черновик.' : 'Сохранённая версия защищена от редактирования. Создайте новую версию для изменений.');
      return true;
    };
    const showEditor = async (action, { scheme = null, version = null, transitionToken = null } = {}) => {
      const token = transitionToken ?? await beginEditorTransition();
      if (token === null || !editorTransition.isCurrent(token)) return false;
      const stateAtRequest = editorStateSnapshot();
      await venueTimezonePromise;
      if (!editorTransition.isCurrent(token)) return false;
      if (!await allowLoadedEditorReplacement(token, stateAtRequest)) return false;
      selectedVersion=null;invalidateReadiness();
      editorAction = action;
      selectedVersion = version;
      editor.hidden = false;
      panel.querySelector('[data-scheme-save]').hidden = false;
      nameField.disabled = action.kind !== 'create'; descriptionField.disabled = action.kind !== 'create'; definitionField.readOnly = false;
      payoutRiskAcknowledgementField.checked = false;
      payoutRiskAcknowledgementField.disabled = false;
      payoutRiskAcknowledgementLabel.hidden = false;
      panel.querySelector('[data-scheme-editor-title]').textContent = action.kind === 'create' ? 'Новая схема' : action.kind === 'new-version' ? 'Новая версия схемы' : 'Редактирование черновика';
      nameField.value = scheme?.name || '';
      descriptionField.value = scheme?.description || '';
      definitionField.value = JSON.stringify(version ? definitionFromVersion(version) : defaultDefinition(), null, 2);
      rebuildGrid();
      editorBaseline = editorStateSnapshot();
      refreshReadiness();
      selectWorkspace('configuration',{focus:true});
      notify('Проверьте период действия, роли, назначения сотрудников и правила до сохранения.');
      return true;
    };

    panel.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      // Only scheme actions may refresh the editor; custom-select buttons own their focus.
      if (!button || pending || !button.matches('[data-scheme-workspace], [data-scheme-grid-rebuild], [data-source-policy-apply], [data-scheme-grid-apply], [data-grid-add-override], [data-grid-inherit], [data-grid-add-milestone-threshold], [data-grid-add-threshold], [data-attendance-page], [data-attendance-refresh], [data-attendance-approve], [data-scheme-reload], [data-scheme-retry], [data-scheme-new], [data-scheme-editor-cancel], [data-scheme-open-version], [data-scheme-new-version], [data-scheme-activate], [data-scheme-revisions], [data-scheme-run-preview], [data-scheme-run-approved-attendance], [data-scheme-run-venue-preview], [data-scheme-compare]')) return;
      try {
        if(button.matches('[data-scheme-workspace]')){selectWorkspace(button.dataset.schemeWorkspace,{focus:true});return;}
        if (button.matches('[data-scheme-grid-rebuild]')) { rebuildGrid(); return; }
        if (button.matches('[data-source-policy-apply]')) {
          if (editorAction?.kind === 'inspect' || gridStale) return;
          if (gridDirty) { applyGrid(); return; }
          definitionField.value = JSON.stringify(applySourcePolicyControls(JSON.parse(definitionField.value), sourcePolicyControls()), null, 2);
          payoutRiskAcknowledgementField.checked = false; rebuildGrid(); return;
        }
        if (button.matches('[data-scheme-grid-apply]')) { if (editorAction?.kind !== 'inspect') applyGrid(); return; }
        if (button.matches('[data-grid-add-override]')) {
          if (editorAction?.kind === 'inspect' || gridStale || !gridSource) throw new Error('Обновите таблицу перед редактированием.');
          grid.querySelector('[data-grid-overrides]').insertAdjacentHTML('beforeend', overrideCard()); gridDirty = true; payoutRiskAcknowledgementField.checked = false; refreshRoleImpact(); return;
        }
        if (button.matches('[data-grid-inherit]')) {
          if (editorAction?.kind === 'inspect' || gridStale) return;
          const card = button.closest('[data-grid-override]'); const mode = card.querySelector('[data-grid-override-mode]'), value = card.querySelector('[data-grid-override-value]'); mode.value = 'inherit'; mode._customSelectRefresh?.(); value.value = ''; value._customSelectRefresh?.();
          gridDirty = true; payoutRiskAcknowledgementField.checked = false; gridMessage.textContent = 'Для выбранного периода будет использоваться ставка роли. Примените таблицу.'; refreshRoleImpact(); return;
        }
        if (button.matches('[data-grid-add-milestone-threshold]')) {
          if (editorAction?.kind === 'inspect' || gridStale || !gridSource) throw new Error('Обновите таблицу перед редактированием.');
          const threshold = editorDecimal(grid.querySelector('[data-grid-new-milestone-threshold]').value);
          if (threshold <= 0) throw new Error('Порог премии должен быть больше нуля.');
          if ([...grid.querySelectorAll('[data-grid-milestone-table] [data-grid-path]')].some((node) => Number(node.dataset.gridPath.split('.').at(-1)) === threshold)) throw new Error('Такой порог премии уже существует.');
          grid.querySelector('[data-grid-milestone-table] tbody').insertAdjacentHTML('beforeend', `<tr><th>${escapeHtml(editorFormat(threshold))}</th>${Object.keys(gridSource.roleParameters).map((role) => `<td>${gridControl(role, `milestoneBonusesCents.${threshold}`, 'money', undefined)}</td>`).join('')}</tr>`);
          gridDirty = true; payoutRiskAcknowledgementField.checked = false; personalCapField.checked = false;
          refreshRoleImpact(); gridMessage.textContent = 'Заполните премии нового порога. Пустые суммы не добавятся; ноль сохраняется.'; return;
        }
        if (button.matches('[data-grid-add-threshold]')) {
          if (editorAction?.kind === 'inspect' || gridStale || !gridSource) throw new Error('Обновите таблицу перед редактированием.');
          const threshold = editorDecimal(grid.querySelector('[data-grid-new-threshold]').value);
          if ([...grid.querySelectorAll('[data-grid-path]')].some((node) => node.dataset.gridPath === `bracketRatesBps.${threshold}`)) throw new Error('Такой порог уже существует.');
          grid.querySelector('[data-grid-rate-table] tbody').insertAdjacentHTML('beforeend', `<tr><th>${escapeHtml(editorFormat(threshold))}</th>${Object.keys(gridSource.roleParameters).map((role) => `<td>${gridControl(role, `bracketRatesBps.${threshold}`, 'rate', undefined)}</td>`).join('')}</tr>`);
          gridDirty = true; payoutRiskAcknowledgementField.checked = false; gridMessage.textContent = 'Заполните ставки нового диапазона. Пустые ставки не добавятся.'; return;
        }
        if (button.matches('[data-attendance-page]')) {
          if (!attendanceCoverage) throw new Error('Сначала проверьте табель.');
          renderAttendance(attendanceCoverage, Number(button.dataset.attendancePage));
          return;
        }
        if (button.matches('[data-attendance-refresh]')) return await refreshAttendance();
        if (button.matches('[data-attendance-approve]')) {
          if (!attendanceCoverage?.complete || !attendanceWatermark.value) throw new Error('Сначала проверьте полный табель.');
          if (attendanceReason.value.trim().length < 3) throw new Error('Укажите основание утверждения табеля.');
          pending = true; button.disabled = true; attendanceRefresh.disabled = true;
          const result = await request('/api/payroll/attendance/approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ periodFrom: attendanceFrom.value, periodTo: attendanceTo.value, sourceWatermark: attendanceWatermark.value, reason: attendanceReason.value.trim(), idempotencyKey: `payroll-attendance:${crypto.randomUUID()}` }) });
          attendanceResult.innerHTML = `<p class="success-message">Утверждён снимок посещаемости: ревизия ${escapeHtml(result.revision)}. Зарплатные начисления и выплаты не создавались.</p>`;
          await refreshAttendance();
          return;
        }
        if (button.matches('[data-scheme-reload], [data-scheme-retry]')) return await load();
        if (button.matches('[data-scheme-new]')) return await showEditor({ kind: 'create' });
        if (button.matches('[data-scheme-editor-cancel]')) { editorTransition.invalidate(); editorBaseline = null; editor.hidden = true; editorAction = null; selectedVersion = null; invalidateReadiness(); selectWorkspace('list',{focus:true}); return; }
        if (button.matches('[data-scheme-open-version]')) return await openVersion(button.dataset.schemeOpenVersion);
        if (button.matches('[data-scheme-new-version]')) {
          const transitionToken = await beginEditorTransition();
          if (transitionToken === null) return;
          const scheme = schemes.find((item) => item.id === button.dataset.schemeNewVersion);
          if (!scheme) return;
          const latest = sortedVersions(scheme || {})[0];
          const stateAtRequest = editorStateSnapshot();
          let version;
          try { version = latest ? await request(`/api/payroll/versions/${encodeURIComponent(latest.id)}`) : null; }
          catch (error) { if (!editorTransition.isCurrent(transitionToken)) return; throw error; }
          if (!editorTransition.isCurrent(transitionToken)) return;
          if (!await allowLoadedEditorReplacement(transitionToken, stateAtRequest)) return;
          return await showEditor({ kind: 'new-version', schemeId: scheme.id }, { scheme, version, transitionToken });
        }
        if (button.matches('[data-scheme-activate]')) {
          pending = true; button.disabled = true;
          await request(`/api/payroll/versions/${encodeURIComponent(button.dataset.schemeActivate)}/activate`, { method: 'POST' });
          notify('Версия активирована.', 'success'); pending = false; await load({ force: true }); return;
        }
        if (button.matches('[data-scheme-revisions]')) {
          const data = await request(`/api/payroll/versions/${encodeURIComponent(button.dataset.schemeRevisions)}/revisions`);
          selectWorkspace('trial',{focus:true}); previewBox.hidden = false; trialEmpty.hidden=true; previewResult.hidden = false; previewResult.textContent = JSON.stringify(data.items || [], null, 2); notify('История версий загружена.'); return;
        }
        if (button.matches('[data-scheme-run-preview]')) {
          selectWorkspace('trial');
          if (!selectedVersion || !['edit','inspect'].includes(editorAction?.kind)) throw new Error('Сначала откройте сохранённую версию схемы.');
          const preview = validatePreview(JSON.parse(previewInput.value));
          const result = await request(`/api/payroll/versions/${encodeURIComponent(selectedVersion.versionId)}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewInput: preview }) });
          previewResult.hidden = false; previewResult.innerHTML = renderPreview(result, preview); notify('Готов сценарный preview. Он не является официальным расчётом и не сохранён.', 'success'); return;
        }
        if (button.matches('[data-scheme-run-approved-attendance]')) {
          selectWorkspace('trial');
          if (!selectedVersion || !['edit','inspect'].includes(editorAction?.kind)) throw new Error('Сначала откройте сохранённую версию схемы.');
          const preview = validatePreview(JSON.parse(previewInput.value));
          const result = await request(`/api/payroll/versions/${encodeURIComponent(selectedVersion.versionId)}/preview/approved-attendance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewInput: preview }) });
          previewResult.hidden = false; previewResult.innerHTML = renderApprovedAttendancePreview(result, preview);
          notify('Сценарий использует сохранённую payroll-ревизию посещаемости; остальные данные остаются сценарными.', 'success'); return;
        }
        if (button.matches('[data-scheme-run-venue-preview]')) {
          selectWorkspace('trial');
          if (!selectedVersion || !['edit','inspect'].includes(editorAction?.kind)) throw new Error('Сначала откройте сохранённую версию схемы.');
          const preview = validatePreview(JSON.parse(previewInput.value));
          const result = await request(`/api/payroll/versions/${encodeURIComponent(selectedVersion.versionId)}/preview/venue-turnover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewInput: preview }) });
          previewResult.hidden = false; previewResult.innerHTML = renderVenueTurnoverPreview(result, preview);
          const ready = result.result?.status === 'ready';
          notify(ready ? 'Сценарий рассчитан с дневным оборотом закрытых чеков; это не официальный расчёт и он не сохранён.'
            : 'Сценарий с оборотом чеков показан с блокерами; это не официальный расчёт и он не сохранён.', ready ? 'success' : 'error'); return;
        }
        if (button.matches('[data-scheme-compare]')) {
          selectWorkspace('trial');
          const versionIds = [...panel.querySelectorAll('[data-scheme-compare-version]:checked')].map((item) => item.dataset.schemeCompareVersion);
          if (versionIds.length < 2 || versionIds.length > 8) throw new Error('Выберите от 2 до 8 версий для сравнения.');
          const preview = validatePreview(JSON.parse(previewInput.value));
          const result = await request('/api/payroll/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionIds, baselineVersionId: versionIds[0], previewInput: preview }) });
          previewResult.hidden = false; previewResult.innerHTML = renderComparison(result, preview); notify('Сравнение готово. Это сценарные значения без сохранения начислений.', 'success'); return;
        }
      } catch (error) { notify(`Не удалось выполнить действие: ${payrollSaveErrorLabels[error.message] || sourcePreviewErrorLabels[error.message] || approvedAttendancePreviewErrorLabels[error.message] || attendanceErrorLabels[error.message] || error.message}`, 'error'); }
      finally { pending = false; refreshReadiness(); }
    });

    editor.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (pending || !editorAction || editorAction.kind === 'inspect') return;
      if (gridDirty) { notify('Примените изменения таблицы перед сохранением и подтверждением риска.', 'error'); revealControl(panel.querySelector('[data-scheme-grid-apply]')); return; }
      if (sourcePolicyDirty) { notify('Примените правила источников перед сохранением и подтверждением риска.', 'error'); revealControl(panel.querySelector('[data-source-policy-apply]')); return; }
      let definition;
      try { definition = JSON.parse(definitionField.value); }
      catch (error) { notify(`Конфигурация должна быть корректным JSON (${error.message}).`, 'error'); revealControl(definitionField); return; }
      if (!payoutRiskAcknowledgementField.checked) {
        notify('Подтвердите понимание риска. Подтверждение не разрешает проводить выплату сверх личной выручки.', 'error');
        payoutRiskAcknowledgementField.focus(); return;
      }
      const payoutRiskAcknowledgement = { confirmed: true, policyCode: PAYOUT_RISK_ACK_POLICY };
      let capIncreases;
      try { capIncreases = editorPersonalCapIncreases(definition); }
      catch (error) { notify(`Проверьте личные лимиты: ${error.message}`, 'error'); revealControl(definitionField); return; }
      if (capIncreases.length && !personalCapField.checked) {
        notify('Отдельно подтвердите повышение личного лимита выше роли.', 'error'); personalCapField.focus(); return;
      }
      if (capIncreases.length) payoutRiskAcknowledgement.personalCapIncrease = { confirmed: true, policyCode: 'payroll-personal-cap-above-role-v1' };
      pending = true;
      invalidateReadiness();
      personalCapField.disabled = true;
      sourcePolicyFieldset.disabled = true;
      gridFieldset.disabled = true; definitionField.readOnly = true; nameField.disabled = true; descriptionField.disabled = true; payoutRiskAcknowledgementField.disabled = true;
      const save = panel.querySelector('[data-scheme-save]'); save.disabled = true;
      try {
        let result;
        if (editorAction.kind === 'create') {
          result = await request('/api/payroll/schemes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameField.value, description: descriptionField.value, definition, payoutRiskAcknowledgement }) });
          notify('Схема и первая черновая версия сохранены.', 'success');
        } else if (editorAction.kind === 'new-version') {
          result = await request(`/api/payroll/schemes/${encodeURIComponent(editorAction.schemeId)}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition, payoutRiskAcknowledgement }) });
          notify('Новая черновая версия сохранена.', 'success');
        } else {
          result = await request(`/api/payroll/versions/${encodeURIComponent(editorAction.versionId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition, payoutRiskAcknowledgement }) });
          notify('Черновик сохранён; новая ревизия записана в историю.', 'success');
        }
        editor.hidden = true; editorAction = null; await load({ force: true });
        const versionId = result.versionId || result.versions?.[0]?.versionId;
        if (versionId) { await openVersion(versionId); selectWorkspace('checks',{focus:true}); }
      } catch (error) { notify(`Не удалось сохранить схему: ${payrollSaveErrorLabels[error.message] || error.message}`, 'error'); }
      finally { pending = false; save.disabled = false; gridFieldset.disabled = editorAction?.kind === 'inspect'; definitionField.readOnly = editorAction?.kind === 'inspect'; nameField.disabled = editorAction?.kind !== 'create'; descriptionField.disabled = editorAction?.kind !== 'create'; payoutRiskAcknowledgementField.disabled = editorAction?.kind === 'inspect'; personalCapField.disabled = editorAction?.kind === 'inspect' || personalCapBox.dataset.state === 'invalid'; refreshSourcePolicyDisabled(); }
    });
    panel.querySelector('[data-scheme-reload]').addEventListener('click', load);
    attendanceFrom.addEventListener('change', () => { attendanceCoverage = null; attendanceWatermark.value = null; attendanceApprove.disabled = true; attendanceResult.innerHTML = '<p class="empty">Период изменился. Проверьте полноту источника заново.</p>'; });
    attendanceTo.addEventListener('change', () => { attendanceCoverage = null; attendanceWatermark.value = null; attendanceApprove.disabled = true; attendanceResult.innerHTML = '<p class="empty">Период изменился. Проверьте полноту источника заново.</p>'; });
    const lookupMessage = document.createElement('p'); lookupMessage.className = 'muted'; lookupMessage.dataset.gridLookupMessage = '';
    grid.before(lookupMessage);
    lookupMessage.textContent = 'Загружаем имена сотрудников и названия цехов…';
    Promise.allSettled([request('/api/staff'), request('/api/inventory/departments?status=all')]).then(results => {
      const valid = results.map(result => result.status === 'fulfilled' && Array.isArray(result.value?.items));
      ownerStaff = valid[0] ? results[0].value.items.filter(row => row && typeof row === 'object').map(({id,name,login,role,active}) => ({id,name,login,role,active})) : [];
      ownerDepartments = valid[1] ? results[1].value.items.filter(row => row && typeof row === 'object').map(({code,id,name,active}) => ({code,id,name,active})) : [];
      lookupMessage.textContent = [!valid[0] ? 'Список сотрудников недоступен: сохранённые идентификаторы доступны без имён.' : '', !valid[1] ? 'Справочник цехов недоступен: сохранённые коды доступны без названий.' : '', 'Названия цехов служат подсказкой; принадлежность продаж определяется их исходными данными. Новые отсутствующие коды можно указать в расширенной конфигурации.'].filter(Boolean).join(' ');
      // Only refresh labels/options: never rebuild a dirty editor or overwrite a draft.
      for (const control of grid.querySelectorAll('[data-grid-employee]')) {
        const value = control.value;
        control.innerHTML = editorOptionsHtml(editorEmployeeOptions(ownerStaff, gridSource, value), value, 'Выберите сотрудника');
        control._customSelectRefresh?.();
      }
      for (const control of grid.querySelectorAll('select[data-grid-type="departmentKey"], select[data-grid-override-value]')) {
        const value = control.value;
        control.innerHTML = editorOptionsHtml(editorDepartmentOptions(ownerDepartments, value), value, control.hasAttribute('data-grid-role') ? 'Не задано / наследовать' : 'Выберите цех');
        control._customSelectRefresh?.();
      }
      refreshInheritedCaptions();
    });
    refreshAttendance();
    load();
  };

  mount();
  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
