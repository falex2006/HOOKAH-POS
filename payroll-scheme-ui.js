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
  const MAX_COMPARE_LINES = 500;
  const PAYOUT_RISK_ACK_POLICY = 'payroll-own-revenue-ceiling-v1';
  let venueTimezone = String(sessionUser.timezone || '');

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  // Pure structured-editor model. JSON remains canonical; unknown properties
  // are copied unchanged, and empty optional fields remove only their own path.
  const EDITOR_MODES = ['progressive_daily', 'stable_percent', 'percent_only', 'final_month_threshold', 'personal_target', 'team_fund', 'margin_target'];
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
  const editorValue = (text, type) => {
    if (type === 'milestoneEligibility') return editorMilestoneEligibilityValue(text);
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
      : path === 'teamWeight' ? 'integer' : path === 'applyMilestones' ? 'boolean' : path === 'milestoneEligibility' ? 'milestoneEligibility' : 'text';
  const editorOverrideValue = (path, text) => {
    const type = editorOverrideType(path);
    if (type === 'boolean') { if (!['true', 'false'].includes(text)) throw new Error('Для applyMilestones укажите true или false.'); return text === 'true'; }
    const value = editorValue(text, type);
    if (value === undefined) throw new Error('Личное значение обязательно; ноль допустим.');
    const allowed = { mode: EDITOR_MODES, excessRatePolicy: ['replace_base', 'add_to_base'], lossPolicy: ['offset_daily_losses'], itemRuleBasis: ['net_revenue'], 'cap.basis': ['venue_day', 'employee_department_day'] };
    if (allowed[path] && !allowed[path].includes(value)) throw new Error('Неподдерживаемое значение параметра.');
    return value;
  };
  const editorApply = (source, fields, overrides, removeOverrides = []) => {
    const result = structuredClone(source);
    if (!result || !result.roleParameters || typeof result.roleParameters !== 'object' || Array.isArray(result.roleParameters)) throw new Error('В JSON нужен объект roleParameters.');
    for (const field of fields) {
      if (!Object.hasOwn(result.roleParameters, field.role)) throw new Error('Роль не найдена в конфигурации.');
      editorSet(result.roleParameters[field.role], field.path, editorValue(field.text, field.path === 'milestoneEligibility' ? 'milestoneEligibility' : field.type));
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
      if (!edit.employeeId.trim() || !/^(mode|applyMilestones|milestoneEligibility|perShiftCents|stableRateBps|targetCents|teamWeight|baseRateBps|bonusRateBps|excessRatePolicy|lossPolicy|itemRuleBasis|bracketRatesBps\.\d+|cap\.(rateBps|basis)|milestoneBonusesCents\.\d+)$/.test(edit.path)) throw new Error('Укажите сотрудника и поддерживаемый путь параметра.');
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
        || !/^(mode|applyMilestones|milestoneEligibility|perShiftCents|stableRateBps|targetCents|teamWeight|baseRateBps|bonusRateBps|excessRatePolicy|lossPolicy|itemRuleBasis|bracketRatesBps\.\d+|cap\.(rateBps|basis)|milestoneBonusesCents\.\d+)$/.test(item.path)
        || !Object.hasOwn(item, 'value')) throw new Error('Некорректный личный параметр.');
      const type = editorOverrideType(item.path);
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
    const heading = changedPath === undefined ? 'Персональные значения, перекрывающие параметры роли' : `Персональные значения для ${changedPath}`;
    if (!entries.length) return `<p>${escapeHtml(changedPath === undefined ? 'Персональных значений этой роли в периоде версии нет.' : 'Персональных значений для этого параметра в периоде версии нет.')}</p>`;
    return `<p>${escapeHtml(heading)}. Изменение роли не заменяет эти личные значения; итог выплаты зависит и от других правил.${entries.length > 200 ? ` Показаны первые 200 из ${entries.length} периодов; полный список — в карточках личных параметров.` : ''}</p><ul>${[...groups].map(([id, items]) => `<li>${escapeHtml(id)}<ul>${items.map((item) => `<li>${escapeHtml(item.path)}: ${escapeHtml(['money', 'rate'].includes(editorOverrideType(item.path)) ? editorFormat(item.value) : String(item.value))} · ${escapeHtml(item.from)} — ${escapeHtml(item.to === '9999-12-31' ? 'без даты окончания' : item.to)}</li>`).join('')}</ul></li>`).join('')}</ul>`;
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
    for(const edit of roleEdits.filter(row=>row.role===roleId&&row.path===item.path))editorSet(role,edit.path,editorValue(edit.text,edit.type));
    if(item.path==='applyMilestones'&&role.applyMilestones===undefined&&definition.applyMilestones===undefined){
      for(const edit of roleEdits.filter(row=>row.role===roleId&&row.path==='mode'))editorSet(role,edit.path,editorValue(edit.text,edit.type));
    }
    let value=editorGet(role,item.path||''),origin=value===undefined?'absent':'role';
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
        :type==='milestoneEligibility'?EDITOR_MILESTONE_LABELS[context.value]:['money','rate'].includes(type)?editorFormat(context.value):String(context.value);
      return `На ${context.date} · роль: ${context.roleId} · наследуемое значение: ${value} · источник: ${labels[context.origin]}. Пустое личное значение не равно нулю.`;
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
    ['mode', 'Режим (пусто — схема)', 'select', EDITOR_MODES], ['perShiftCents', 'Оклад за смену', 'money'],
    ['applyMilestones', 'Пороговые премии', 'boolean', ['true', 'false']],
    ['milestoneEligibility', 'Условие выплаты премии', 'select', EDITOR_MILESTONE_POLICIES],
    ['stableRateBps', 'Стабильная ставка, %', 'rate'], ['cap.rateBps', 'Лимит, %', 'rate'], ['cap.basis', 'База лимита', 'select', ['venue_day', 'employee_department_day']], ['cap.department', 'Цех лимита', 'text'],
    ['targetCents', 'Личный ориентир', 'money'], ['baseRateBps', 'Базовая ставка, %', 'rate'], ['bonusRateBps', 'Повышенная ставка, %', 'rate'],
    ['excessRatePolicy', 'Ставка сверх ориентира', 'select', ['replace_base', 'add_to_base']], ['lossPolicy', 'Учёт убытков', 'select', ['offset_daily_losses']], ['itemRuleBasis', 'База позиционной ставки', 'select', ['net_revenue']],
    ['teamWeight', 'Личный вес в фонде', 'integer'], ['teamFund.poolId', 'ID общего фонда', 'text'], ['teamFund.departments', 'Цеха фонда через запятую', 'departments'],
    ['teamFund.targetCents', 'Ориентир фонда', 'money'], ['teamFund.baseRateBps', 'База фонда, %', 'rate'], ['teamFund.bonusRateBps', 'Повышенная ставка фонда, %', 'rate'],
    ['teamFund.excessRatePolicy', 'Ставка фонда сверх ориентира', 'select', ['replace_base', 'add_to_base']], ['teamFund.distributionPolicy', 'Распределение фонда', 'select', ['approved_minutes', 'configured_weights']]
  ];
  const SOURCE_POLICY_SALES = ['line_seller_snapshot', 'order_responsible_snapshot', 'explicit_line_allocation'];
  const SOURCE_POLICY_DISCOUNTS = ['immutable_line_snapshot', 'eligible_gross_proportional_fixed_order'];
  const SOURCE_POLICY_REFUNDS = ['recognized_event_date', 'original_sale_period_correction'];
  const applySourcePolicyControls = (definition, controls) => {
    const result = structuredClone(definition);
    if (!controls.enabled) { delete result.sourcePolicies; return result; }
    const reason = String(controls.selectionReason || '').trim();
    if (!SOURCE_POLICY_SALES.includes(controls.saleCredit) || !SOURCE_POLICY_DISCOUNTS.includes(controls.discountAllocation)
        || !SOURCE_POLICY_REFUNDS.includes(controls.refunds)) throw new Error('Явно выберите все правила источников.');
    if (reason.length < 3 || reason.length > 1000) throw new Error('Укажите причину выбора правил: от 3 до 1000 символов.');
    result.sourcePolicies = { schemaVersion: 1, selectionReason: reason, saleCredit: { kind: controls.saleCredit },
      discountAllocation: controls.discountAllocation === 'immutable_line_snapshot' ? { kind: controls.discountAllocation }
        : { kind: controls.discountAllocation, rounding: 'largest_remainder_code_unit_v1', eligibility: 'pricing_source_snapshot' },
      refunds: { recognition: controls.refunds, closedRunTreatment: 'next_open_run_adjustment', paidAdjustment: 'owner_review_variable_pay_only',
        uncoveredBalance: 'carry_forward_review', clawback: 'no_automatic_clawback' } };
    return result;
  };
  const sourcePolicyControlValues = (definition) => {
    const policy = definition.sourcePolicies;
    return { enabled: policy !== undefined, saleCredit: policy?.saleCredit?.kind || '', discountAllocation: policy?.discountAllocation?.kind || '',
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
    payroll_attendance_approval_unavailable: 'Не удалось сохранить утверждение табеля.',
    payroll_attendance_owner_or_venue_unavailable: 'Площадка или владелец недоступны. Обновите страницу и повторите.',
    payroll_attendance_venue_timezone_invalid: 'У площадки не настроен корректный часовой пояс.'
  };
  const payrollSaveErrorLabels = {
    invalid_personal_parameters: 'Личные параметры неполны для части периода. Проверьте обязательные поля выбранного режима и даты настроек.',
    payroll_milestone_eligibility_schema_required: 'Для сохранения условия премии требуется обновление зарплатного хранилища. Настройка не сохранена.',
    invalid_personal_cap: 'Личный лимит неполон для части периода. Задайте процент и базу лимита; для базы по цеху у роли должен быть указан цех.',
    milestone_cap_policy_required: 'Выберите, включать пороговые премии в лимит или начислять их отдельно.',
    payroll_personal_target_schema_required: 'Сохранение новой зарплатной схемы требует обновления структуры базы данных. Настройки не сохранены.',
    payroll_risk_acknowledgement_required: 'Перед сохранением версии подтвердите, что поняли риск блокировки официального расчёта. Это подтверждение не разрешает выплату выше личной выручки.',
    payroll_personal_cap_increase_acknowledgement_required: 'Отдельно подтвердите повышение личного лимита выше роли. После изменения параметров подтверждение требуется заново.'
  };
  const attendanceReasonLabels = {
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
        return `<li data-milestone-decision-row><strong>${escapeHtml(employeeNames.get(row.employeeId) || row.employeeId)}</strong> · ${escapeHtml(row.roleId)} · ${escapeHtml(row.date)}<p>Порог ${money(row.thresholdCents, currency)} · оборот до пересечения ${money(row.previousTurnoverCents, currency)} → ${money(row.cumulativeTurnoverCents, currency)}</p><p>${escapeHtml(policies[row.eligibility])} · ${escapeHtml(reasons[row.reason])} · заявленная премия ${money(row.declaredBonusCents, currency)} · премия сценария до лимитов ${money(row.awardedAmountCents, currency)}</p><p>Утверждённые минуты сценария: ${escapeHtml(row.approvedWorkedMinutes)} · смены: ${shifts.length ? shifts.map(escapeHtml).join(', ') : 'нет'}${hiddenShifts ? ` · Скрыто ${hiddenShifts} ссылок на смены` : ''}</p></li>`;
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
        return `<tr><td>${escapeHtml(employeeNames.get(row.employeeId) || row.employeeId)}</td><td>${escapeHtml(row.roleId || '')}</td><td>${money(row.basePayCents, currency)}</td><td>${money(row.commissionCents, currency)}${targetDetail}${marginDetail}</td><td>${money(row.milestoneBonusCents, currency)}</td><td>${money(row.capCents, currency)}</td><td>${money(row.capReductionCents, currency)}</td><td><strong>${money(row.amountCents, currency)}</strong>${fundDetail}</td>${baselineCells}</tr>`;
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
        return `<tr><td>${escapeHtml(line.lineId)}</td><td>${escapeHtml(employeeNames.get(line.employeeId) || line.employeeId)}</td><td>${escapeHtml(line.menuItemId || '—')}</td><td>${escapeHtml(line.department)}</td><td>${money(line.commissionBaseCents, currency)}${costDetail}</td><td>${escapeHtml(rateLabel)}</td><td>${money(line.commissionCents, currency)}</td></tr>`;
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
    return `${renderBlockers(result)}${renderCriticalErrors(result, employeeNames, currency)}<p><strong>${escapeHtml(result.periodFrom)} — ${escapeHtml(result.periodTo)} · ${escapeHtml(result.status)}</strong> · месячная база ${money(result.monthTurnoverCents, currency)}</p><p class="muted">Сценарная проверка по приписанному обороту сотрудника; это не официальный payroll-run и не подтверждение права на выплату.</p><div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Сотрудник</th><th>Смены</th><th>Приписанный оборот</th><th>Оклад</th><th>Комиссия</th><th>Премии</th><th>Срезано cap</th><th>Итого</th></tr></thead><tbody>${(result.employees || []).map((row) => `<tr><td>${escapeHtml(employeeNames.get(row.employeeId) || row.employeeId)}</td><td>${escapeHtml(row.shifts)}</td><td>${money(row.personalRevenueCents, currency)}</td><td>${money(row.basePayCents, currency)}</td><td>${money(row.commissionCents, currency)}</td><td>${money(row.milestoneBonusCents, currency)}</td><td>${money(row.capReductionCents, currency)}</td><td><strong>${money(row.amountCents, currency)}</strong>${row.teamFundCents ? `<small>Командный фонд за период до лимитов: ${money(row.teamFundCents, currency)}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="8">Нет сотрудников в расчёте</td></tr>'}</tbody></table></div><h4>Детализация по дню и чеку</h4>${daily || '<p class="empty">Нет дневных данных.</p>'}`;
  };
  const renderPreview = (payload, previewInput) => {
    const names = new Map((previewInput.employees || []).filter((employee) => employee && typeof employee === 'object').map((employee) => [employee.id, employee.name || employee.fullName || employee.id]));
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
    return `${notice}${renderPreview(payload, previewInput)}`;
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

  const readinessLabels = {
    sourcePolicies: 'Правила владельца', approvedAttendance: 'Утверждённый табель', orderObservations: 'Наблюдения заказов',
    refundObservations: 'Зарегистрированные возвраты', canonicalLinePricing: 'Неизменяемые цены строк', payrollSaleCredit: 'Приписывание продаж сотрудникам',
    recognizedLineRefunds: 'Признанные возвраты по строкам', fullEmployeeNetRevenue: 'Полная чистая выручка сотрудника',
    marginCosts: 'Неизменяемая себестоимость', departmentShiftAllocation: 'Распределение по цеху и смене'
  };
  const readinessReasons = {
    explicit_owner_source_policy_selection_required:'В сохранённой версии не выбраны правила источников.',
    closed_order_date_missing_venue_wide:'В заведении есть закрытые заказы без даты закрытия; их период неизвестен.',
    locked_order_header_missing:'В части заказов отсутствует полный зафиксированный заголовок цены.',
    order_item_sales_attribution_schema_missing:'Хранение продавца и даты продажи строки ещё не подключено.',
    refund_event_schema_missing:'Хранение зарегистрированных возвратов ещё не подключено.',
    payroll_attendance_source_incomplete:'Исходный табель неполный.', payroll_attendance_approval_required:'Снимок табеля ещё не утверждён.',
    payroll_attendance_approval_stale:'Утверждённый снимок устарел после изменения источников.', payroll_attendance_snapshot_invalid:'Утверждённый снимок не прошёл проверку.',
    canonical_immutable_line_pricing_not_implemented:'Источник неизменяемых цен и скидок строк ещё не подключён.',
    immutable_payroll_sale_credit_not_implemented:'Неизменяемое приписывание продаж сотрудникам ещё не подключено.',
    recognized_line_refund_lineage_not_implemented:'Связь признанного возврата со строкой продажи ещё не подключена.',
    full_employee_net_revenue_source_not_implemented:'Источник полной чистой выручки сотрудника ещё не подключён.',
    immutable_margin_cost_source_not_implemented:'Источник неизменяемой себестоимости ещё не подключён.',
    department_shift_allocation_source_not_implemented:'Источник распределения по цеху и смене ещё не подключён.'
  };
  const renderSourceReadiness = payload => {
    if (payload?.schemaVersion !== 1 || payload.officialReady !== false || !payload.components) throw new Error('Некорректный ответ проверки источников.');
    const statuses={available:'Данные доступны',incomplete:'Нужна проверка',unsupported:'Источник не подключён'};
    const counts={closedOrderCount:'Закрытых заказов в периоде',lockedOrderCount:'Заказов с зафиксированной ценой',missingLockedHeaderCount:'Без полного заголовка цены',
      observedLineCount:'Текущих строк заказов',missingSalesAttributionLineCount:'Строк без продавца или даты продажи',missingClosedAtCountVenueWide:'Без даты закрытия во всём заведении',
      eventCount:'Событий возврата по дате регистрации в периоде',unattributedEventCount:'Из них без связи со строками',linkedToInspectedOrdersCount:'Возвратов любых дат к заказам периода',
      linkedUnattributedCount:'Из них без связи со строками',shiftCount:'Смен в проверенном снимке'};
    return `<p data-source-readiness-official>Официальный расчёт пока недоступен. Проверка ничего не начисляет и не сохраняет выплаты.</p><p>Период: ${escapeHtml(payload.period?.from)} — ${escapeHtml(payload.period?.to)} · часовой пояс: ${escapeHtml(payload.period?.timezone)}</p>${Object.entries(readinessLabels).map(([key,label])=>{
      const item=payload.components[key]; if(!item || !Object.hasOwn(statuses,item.status)) throw new Error('Некорректное состояние источника.');
      return `<section data-source-readiness-component="${key}"><h4>${label} · ${statuses[item.status]}</h4>${Object.entries(counts).filter(([field])=>Object.hasOwn(item,field)).map(([field,title])=>`<p>${title}: <strong>${item[field]===null?'Неизвестно — источник не подключён':escapeHtml(item[field])}</strong></p>`).join('')}${key==='approvedAttendance'&&item.status==='available'?'<p>Неизменяемый снимок табеля проверен.</p>':''}${(item.reasons||[]).map(reason=>`<p class="muted">${escapeHtml(readinessReasons[reason]||`Источник требует проверки (${reason}).`)}</p>`).join('')}</section>`;
    }).join('')}<p class="muted">Числа заказов и возвратов — наблюдения зарегистрированных данных. Они не подтверждают полноту зарплатных источников; нулевые значения не разрешают официальный расчёт.</p>`;
  };
  const sourceReadinessPeriodValid = (from,to) => {
    const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
    return valid(from)&&valid(to)&&from<=to&&from===from.slice(0,7)+'-01'&&from.slice(0,7)===to.slice(0,7);
  };
  const mount = () => {
    const payrollPanel = document.querySelector('.finance-payroll-panel');
    if (!payrollPanel || payrollPanel.dataset.schemeUiMounted) return;
    payrollPanel.dataset.schemeUiMounted = 'true';
    const panel = document.createElement('section');
    panel.className = 'panel finance-payroll-schemes';
    panel.innerHTML = `
      <style data-payroll-editor-responsive>
        .finance-payroll-schemes{min-width:0;max-width:100%;box-sizing:border-box}
        .finance-payroll-schemes fieldset,.finance-payroll-schemes form,.finance-payroll-schemes details,.finance-payroll-schemes section,.finance-payroll-schemes [data-scheme-grid],.finance-payroll-schemes [data-grid-overrides]{min-width:0;min-inline-size:0;max-width:100%;box-sizing:border-box}
        .finance-payroll-schemes .panel-head,.finance-payroll-schemes .panel-head>*,.finance-payroll-schemes .toolbar-row,.finance-payroll-schemes .form-row,.finance-payroll-schemes label{min-width:0;max-width:100%;box-sizing:border-box}
        .finance-payroll-schemes .form-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))}
        .finance-payroll-schemes input,.finance-payroll-schemes select,.finance-payroll-schemes textarea{min-width:0;max-width:100%;box-sizing:border-box}
        .finance-payroll-schemes label>input:not([type=checkbox]),.finance-payroll-schemes label>select,.finance-payroll-schemes label>textarea{width:100%}
        .finance-payroll-schemes p,.finance-payroll-schemes summary,.finance-payroll-schemes span,.finance-payroll-schemes code,.finance-payroll-schemes legend,.finance-payroll-schemes label{overflow-wrap:anywhere}
        .finance-payroll-schemes .toolbar-row{flex-wrap:wrap}
        .finance-payroll-schemes .button{min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere}
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
      </style>
      <div class="panel-head"><div><h2>Настройка зарплатных схем</h2><span class="muted">Версии, ставки, назначения, персональные overrides и позиционные правила</span></div><div class="toolbar-row"><button type="button" class="button small" data-scheme-reload>Обновить</button><button type="button" class="button small primary" data-scheme-new>Новая схема</button></div></div>
      <p class="muted">Настройки и суммы доступны только владельцу площадки. Черновик можно редактировать; активация закрепляет версию. Обычный preview использует введённый сценарий. Отдельный preview оборота площадки читает закрытые заказы, но не подтверждает строки продаж, комиссии или посещаемость; оба варианта неофициальны и ничего не сохраняют.</p>
      <p class="form-message" data-scheme-message role="status" aria-live="polite"></p>
      <div class="finance-scheme-list" data-scheme-list><div class="empty">Загрузка схем…</div></div>
      <form class="stack-form" data-scheme-editor hidden>
        <div class="panel-head"><div><h3 data-scheme-editor-title>Новая схема</h3><span class="muted">Полный JSON позволяет владельцу задать все поддерживаемые параметры и периоды действия.</span></div></div>
        <div class="form-row"><label>Название схемы<input data-scheme-name maxlength="120" required></label><label>Описание<textarea data-scheme-description rows="2" maxlength="2000"></textarea></label></div>
        <fieldset data-scheme-grid-fieldset><legend>Ставки по ролям и личные параметры</legend><p class="muted">Суммы — в валюте схемы, проценты — от 0 до 100. Пустое необязательное поле удаляет только этот параметр; ноль остаётся отдельным значением. Смена режима не добавляет ставки автоматически.</p><div data-scheme-grid></div><div class="toolbar-row"><button type="button" class="button" data-scheme-grid-apply>Применить таблицу к черновику</button><button type="button" class="button" data-scheme-grid-rebuild>Обновить таблицу из JSON</button></div><p data-scheme-grid-message role="status" aria-live="polite"></p></fieldset>
        <fieldset data-source-policy-fieldset><legend>Правила будущих источников зарплаты</legend>
          <p class="warning-message">Настройка будущего расчёта; данные источников ещё не подтверждены. Выбор правил не меняет математику сценария и не разрешает официальный расчёт.</p>
          <label><input type="checkbox" data-source-policy-enabled> Явно выбрать и сохранить правила для этой версии</label>
          <div class="form-row"><label>Кому приписывается продажа<select data-source-policy-sale><option value="">Выберите правило</option><option value="line_seller_snapshot">Продавцу из неизменяемого снимка строки</option><option value="order_responsible_snapshot">Ответственному из отдельного неизменяемого снимка заказа (не открывшему заказ)</option><option value="explicit_line_allocation">По явному распределению исполнителей строки</option></select></label>
          <label>Скидка по строкам<select data-source-policy-discount><option value="">Выберите правило</option><option value="immutable_line_snapshot">Точное распределение из неизменяемого снимка строки</option><option value="eligible_gross_proportional_fixed_order">Пропорционально подходящей исходной базе закрытого заказа</option></select></label>
          <label>Когда учитывается возврат<select data-source-policy-refund><option value="">Выберите правило</option><option value="recognized_event_date">На дату признанного события возврата</option><option value="original_sale_period_correction">Корректировкой периода исходной продажи</option></select></label></div>
          <p class="muted">Пропорциональная скидка: подходящие строки фиксирует источник цены; копейки распределяются методом наибольших остатков с устойчивым порядком ID. Закрытый расчёт корректируется в следующем открытом периоде. Оплаченная переменная часть требует проверки владельцем; непокрытый остаток переносится на проверку. Автоматического удержания нет.</p>
          <label>Причина выбора<textarea data-source-policy-reason rows="2" maxlength="1000"></textarea></label><button type="button" class="button" data-source-policy-apply>Применить правила к черновику</button><p data-source-policy-message role="status" aria-live="polite"></p>
        </fieldset>
        <details data-scheme-advanced><summary>Расширенная конфигурация JSON</summary><label>Конфигурация версии <textarea data-scheme-definition rows="18" spellcheck="false" required></textarea></label></details>
        <p class="muted">Обязательные поля: mode, effectiveFrom, roleParameters, roleAssignments, employeeOverrides, itemRules. Сотрудников назначайте по UUID из списка персонала. Денежные суммы задаются в копейках, ставки — в basis points. Явный ноль отличается от наследования.</p>
        <p class="muted">Режим personal_target — личный дневной план. В параметрах роли задайте perShiftCents, targetCents, baseRateBps, bonusRateBps и excessRatePolicy: replace_base заменяет ставку сверх плана, add_to_base добавляет её. План начинается заново каждый день; обе части округляются отдельно до копейки. Позиционная замена исключает строку из плана, добавочная ставка сохраняет её в плане.</p>
        <p class="muted">Режим team_fund — один командный фонд за день. В roleParameters задайте teamFund: poolId, targetCents, baseRateBps, bonusRateBps, excessRatePolicy, departments и distributionPolicy. approved_minutes распределяет по утверждённым минутам; configured_weights — по teamWeight активных сотрудников независимо от выхода в этот день. Общие параметры одного poolId должны совпадать у всех ролей. Лимиты применяются после распределения; срезанная сумма не переходит другим сотрудникам.</p>
        <p class="muted">Режим margin_target — процент от дневной маржи продаж сотрудника: комиссионная база минус полная себестоимость строки. Задайте параметры личного плана, lossPolicy: offset_daily_losses и itemRuleBasis: net_revenue. В каждой строке sales нужен costSnapshot с id, version, currency и costCents — полной себестоимостью оставшегося количества после возвратов. Убытки уменьшают общую дневную маржу; текущая себестоимость меню не подставляется. Позиционные ставки явно остаются от выручки: replacement исключает строку из маржинального плана, additive сохраняет её и может платить комиссию даже при отрицательной марже дня.</p>
        <label data-scheme-risk-ack><input type="checkbox" data-scheme-risk-acknowledged required> Я владелец и понимаю: начисление может превысить приписанный оборот, обязательная премия или оклад может сделать официальный расчёт заблокированным; текущий preview не подтверждает личную чистую выручку. Это подтверждение не отменяет дневной лимит и не разрешает выплату сверх личной выручки.</label>
        <div class="toolbar-row"><button class="button primary" type="submit" data-scheme-save>Сохранить черновик</button><button class="button" type="button" data-scheme-editor-cancel>Закрыть</button></div>
        <section data-personal-cap-confirmation hidden><div data-personal-cap-exceptions></div><label><input type="checkbox" data-personal-cap-acknowledged> Я отдельно подтверждаю повышение личного процента лимита выше процента роли для указанных сотрудников и периодов. Это не разрешает выплату сверх полной личной выручки.</label></section>
      </form>
      <div class="finance-scheme-preview" data-scheme-preview hidden>
        <div class="panel-head"><div><h3>Сценарный расчёт</h3><span class="muted" data-scheme-selected-label></span></div><div class="toolbar-row"><button type="button" class="button small primary" data-scheme-run-preview>Рассчитать сценарий</button><button type="button" class="button small" data-scheme-run-approved-attendance>Сценарий с утверждённым табелем</button><button type="button" class="button small" data-scheme-run-venue-preview>Сценарий с оборотом чеков</button><button type="button" class="button small" data-scheme-compare>Сравнить выбранные</button></div></div>
        <label>Нормализованные входные данные сценария<textarea data-scheme-preview-input rows="12" spellcheck="false"></textarea></label>
        <div data-scheme-preview-result class="finance-scheme-result" hidden></div>
      </div>
      <section class="finance-scheme-preview" data-source-readiness>
        <h3>Проверка источников зарплаты</h3><p>Отчёт по сохранённой версии схемы. Начало периода — первый день месяца; конец — в том же месяце.</p>
        <p data-source-readiness-version>Сначала откройте сохранённую версию.</p><p class="warning-message" data-source-readiness-dirty hidden></p>
        <div class="form-row"><label>С даты<input type="date" data-source-readiness-from></label><label>По дату<input type="date" data-source-readiness-to></label></div>
        <button type="button" class="button small" data-source-readiness-run disabled>Проверить источники</button>
        <div data-source-readiness-result class="finance-scheme-result" aria-live="polite"><p class="empty">Выберите версию и период проверки.</p></div>
      </section>
      <section class="finance-scheme-preview" data-attendance-approval>
        <div class="panel-head"><div><h3>Подтверждение табеля</h3><span class="muted">Зафиксирует отдельную неизменяемую payroll-ревизию закрытых интервалов и расписания. Это не создаёт зарплатный расчёт или выплату.</span></div></div>
        <div class="form-row"><label>С даты<input type="date" data-attendance-from required></label><label>По дату<input type="date" data-attendance-to required></label></div>
        <div class="toolbar-row"><button type="button" class="button small" data-attendance-refresh>Проверить табель</button><button type="button" class="button small primary" data-attendance-approve disabled>Утвердить снимок</button></div>
        <label>Основание подтверждения<input type="text" data-attendance-reason minlength="3" maxlength="1000" autocomplete="off" placeholder="Например: табель сверен с ответственными за смены"></label>
        <div data-attendance-result class="finance-scheme-result" aria-live="polite"><p class="empty">Задайте период и проверьте полноту исходного табеля.</p></div>
      </section>`;
    payrollPanel.insertBefore(panel, payrollPanel.firstChild);

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
        personalCapList.innerHTML = `<p>Личный процент лимита выше роли. При разных базах проценты не определяют сравнение итоговой суммы. Сервер повторно проверит выбор.</p><ul>${rows.slice(0, 200).map((row) => `<li>${escapeHtml(row.employeeId)} · ${escapeHtml(row.roleId)} · ${escapeHtml(editorFormat(row.roleRateBps))}% → ${escapeHtml(editorFormat(row.personalRateBps))}% · ${escapeHtml(row.effectiveFrom)} — ${escapeHtml(row.effectiveTo || 'без окончания')}</li>`).join('')}</ul>${rows.length > 200 ? `<p>Всего периодов: ${rows.length}. Остальные перечислены в личных параметрах.</p>` : ''}`;
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
    let selectedVersionIds = [];
    let pending = false;
    const grid = panel.querySelector('[data-scheme-grid]');
    const gridFieldset = panel.querySelector('[data-scheme-grid-fieldset]');
    const gridMessage = panel.querySelector('[data-scheme-grid-message]');
    const sourcePolicyFieldset = panel.querySelector('[data-source-policy-fieldset]');
    const sourcePolicyEnabled = panel.querySelector('[data-source-policy-enabled]');
    const sourcePolicySale = panel.querySelector('[data-source-policy-sale]');
    const sourcePolicyDiscount = panel.querySelector('[data-source-policy-discount]');
    const sourcePolicyRefund = panel.querySelector('[data-source-policy-refund]');
    const sourcePolicyReason = panel.querySelector('[data-source-policy-reason]');
    const sourcePolicyMessage = panel.querySelector('[data-source-policy-message]');
    let sourcePolicyDirty = false;
    const readinessFrom=panel.querySelector('[data-source-readiness-from]'), readinessTo=panel.querySelector('[data-source-readiness-to]');
    const readinessRun=panel.querySelector('[data-source-readiness-run]'), readinessResult=panel.querySelector('[data-source-readiness-result]');
    const readinessDirty=panel.querySelector('[data-source-readiness-dirty]'), readinessVersion=panel.querySelector('[data-source-readiness-version]');
    let readinessToken=0, readinessLoading=false;
    const readinessSavedSelection=()=>selectedVersion && ['edit','inspect'].includes(editorAction?.kind);
    const refreshReadiness=()=>{
      const saved=readinessSavedSelection();
      readinessRun.disabled=!saved||readinessLoading;
      readinessVersion.textContent=saved?`${selectedVersion.name} · сохранённая версия ${selectedVersion.versionNo}`:'Сначала откройте сохранённую версию. Для новой версии проверка доступна после сохранения.';
      const dirty=saved&&(gridDirty||sourcePolicyDirty||definitionField.value!==JSON.stringify(definitionFromVersion(selectedVersion),null,2));
      readinessDirty.hidden=!dirty;
      readinessDirty.textContent=dirty?'Есть несохранённые изменения. Проверка относится к сохранённой версии, изменения редактора в неё не входят.':'';
    };
    const invalidateReadiness=()=>{readinessToken++;readinessLoading=false;readinessResult.innerHTML='<p class="empty">Выберите версию и период; затем проверьте источники заново.</p>';refreshReadiness();};
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
    for(const field of [readinessFrom,readinessTo]){field.addEventListener('input',invalidateReadiness);field.addEventListener('change',invalidateReadiness);}
    editor.addEventListener('input',refreshReadiness);editor.addEventListener('change',refreshReadiness);
    const sourcePolicyControls = () => ({ enabled: sourcePolicyEnabled.checked, saleCredit: sourcePolicySale.value,
      discountAllocation: sourcePolicyDiscount.value, refunds: sourcePolicyRefund.value, selectionReason: sourcePolicyReason.value });
    const refreshSourcePolicyDisabled = () => {
      const disabled = pending || editorAction?.kind === 'inspect' || gridStale;
      sourcePolicyFieldset.disabled = disabled;
      for (const field of [sourcePolicySale, sourcePolicyDiscount, sourcePolicyRefund, sourcePolicyReason]) {
        field.disabled = disabled || !sourcePolicyEnabled.checked;
        field._customSelectRefresh?.();
      }
    };
    const rebuildSourcePolicy = (definition) => {
      const values = sourcePolicyControlValues(definition);
      sourcePolicyEnabled.checked = values.enabled;
      for (const [field, value] of [[sourcePolicySale, values.saleCredit], [sourcePolicyDiscount, values.discountAllocation], [sourcePolicyRefund, values.refunds]]) {
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
      const attrs = `data-grid-role="${escapeHtml(role)}" data-grid-path="${escapeHtml(path)}" data-grid-type="${type === 'select' ? 'text' : type}" aria-label="${escapeHtml(`${role}: ${path}`)}"`;
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
      return type === 'select' ? `<select ${attrs}><option value="">Не задано / наследовать</option>${[...new Set([...choices, ...(value && !choices.includes(value) ? [value] : [])])].map((choice) => `<option value="${escapeHtml(choice)}" ${choice === value ? 'selected' : ''}>${escapeHtml(EDITOR_CHOICE_LABELS[choice] || choice)}</option>`).join('')}</select>`
        : `<input ${attrs} value="${escapeHtml(formatted)}" ${['money', 'rate', 'integer'].includes(type) ? 'inputmode="decimal"' : ''}>`;
    };
    const overrideCard = (item = {}, index = null) => {
      const type = editorOverrideType(item.path || '');
      const value = item.mode === 'override' ? ['money', 'rate'].includes(type) ? editorFormat(item.value) : String(item.value ?? '') : '';
      const inheritedCaption = editorInheritedCaption(gridSource,item);
      return `<section data-grid-override="${index === null ? 'new' : index}"><p data-grid-inherited-caption>${escapeHtml(inheritedCaption)}</p><div class="form-row"><label>UUID сотрудника<input data-grid-employee value="${escapeHtml(item.employeeId || '')}" list="payroll-grid-employees"></label><label>Параметр<input data-grid-override-path value="${escapeHtml(item.path || '')}" placeholder="perShiftCents, bracketRatesBps.0, cap.rateBps"></label><label>Назначение<select data-grid-override-mode><option value="override" ${item.mode !== 'inherit' ? 'selected' : ''}>Персонально</option><option value="inherit" ${item.mode === 'inherit' ? 'selected' : ''}>По роли</option></select></label><label>Личное значение (сумма / %)<input data-grid-override-value value="${escapeHtml(value)}"></label><label>С даты<input type="date" data-grid-override-from value="${escapeHtml(item.effectiveFrom || '')}"></label><label>По дату<input type="date" data-grid-override-to value="${escapeHtml(item.effectiveTo || '')}"></label></div><button type="button" class="button" data-grid-inherit>Вернуть к ставке роли для этого периода</button></section>`;
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
        const milestoneGrid = `<div style="max-width:100%;overflow-x:auto"><table data-grid-milestone-table><caption>Пороговые премии × роли; суммы в ${escapeHtml(milestoneCurrency)}</caption><thead><tr><th>Оборот от, ${escapeHtml(milestoneCurrency)}</th>${roles.map((role) => `<th>${escapeHtml(role)}</th>`).join('')}</tr></thead><tbody>${milestoneThresholds.map((threshold) => `<tr><th>${escapeHtml(editorFormat(Number(threshold)))}</th>${roles.map((role) => `<td>${gridControl(role, `milestoneBonusesCents.${threshold}`, 'money', definition.roleParameters[role].milestoneBonusesCents?.[threshold])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="form-row"><label>Новый порог премии, ${escapeHtml(milestoneCurrency)}<input data-grid-new-milestone-threshold inputmode="decimal"></label><button type="button" class="button" data-grid-add-milestone-threshold>Добавить порог премии</button></div><p>Пустая сумма удаляет премию роли для этого порога; 0 сохраняет нулевую премию. Начисление зависит от переключателя роли и личных параметров.</p>`;
        grid.innerHTML = `<div style="max-width:100%;overflow-x:auto"><table data-grid-rate-table><caption>Диапазоны оборота × роли; ставки в %</caption><thead><tr><th>Оборот от, ${escapeHtml(definition.currency || 'RUB')}</th>${roles.map((role) => `<th>${escapeHtml(role)}</th>`).join('')}</tr></thead><tbody>${thresholds.map((threshold) => `<tr><th>${escapeHtml(editorFormat(Number(threshold)))}</th>${roles.map((role) => `<td>${gridControl(role, `bracketRatesBps.${threshold}`, 'rate', definition.roleParameters[role].bracketRatesBps?.[threshold])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="form-row"><label>Новый порог оборота, ${escapeHtml(definition.currency || 'RUB')}<input data-grid-new-threshold inputmode="decimal"></label><button type="button" class="button" data-grid-add-threshold>Добавить диапазон</button></div>${milestoneGrid}${roles.map((role) => `<details open><summary>Роль ${escapeHtml(role)} · суммы в ${escapeHtml(definition.currency || 'RUB')}</summary><div class="form-row">${EDITOR_FIELDS.map(([path, label, type, choices]) => `<label>${escapeHtml(label)}${gridControl(role, path, type, editorGet(definition.roleParameters[role], path), choices)}</label>`).join('')}</div><div data-grid-role-impact="${escapeHtml(role)}"></div></details>`).join('')}<h4>Карточки личных параметров</h4><datalist id="payroll-grid-employees">${[...new Set((definition.roleAssignments || []).map((row) => row.employeeId))].map((id) => `<option value="${escapeHtml(id)}"></option>`).join('')}</datalist><div data-grid-overrides>${(definition.employeeOverrides || []).map((item, index) => overrideCard(item, index)).join('')}</div><button type="button" class="button" data-grid-add-override>Добавить личный параметр</button>`;
        const schemeEligibility=definition.milestoneEligibility===undefined?'':editorMilestoneEligibilityValue(definition.milestoneEligibility);
        grid.insertAdjacentHTML('afterbegin',`<div class="form-row"><label>Условие выплаты пороговой премии по схеме<select data-grid-scheme-milestone-eligibility aria-label="Условие выплаты пороговой премии по схеме"><option value="" ${schemeEligibility===''?'selected':''}>Прежнее правило: активные сотрудники</option>${EDITOR_MILESTONE_POLICIES.map(policy=>`<option value="${policy}" ${schemeEligibility===policy?'selected':''}>${escapeHtml(EDITOR_MILESTONE_LABELS[policy])}</option>`).join('')}</select></label></div><p>Личное правило имеет приоритет над ролью, роль — над схемой. Премия за работу требует положительных подтверждённых минут в день порога и не переносится на следующий день. Отключённые премии не начисляются.</p>`);
        gridFieldset.disabled = pending || editorAction?.kind === 'inspect'; gridMessage.textContent = 'Таблица соответствует JSON. Изменения таблицы примените перед подтверждением риска.';
        refreshRoleImpact();
      } catch (error) { gridSource = null; grid.innerHTML = ''; sourcePolicyFieldset.disabled = true; gridMessage.textContent = `Таблица недоступна: ${error.message}. Исправьте расширенный JSON.`; panel.querySelector('[data-scheme-advanced]').open = true; }
    };
    const applyGrid = () => {
      if (!gridSource || gridStale) throw new Error('Обновите таблицу из корректного JSON.');
      const fields = [...grid.querySelectorAll('[data-grid-role]')].map((node) => ({ role: node.dataset.gridRole, path: node.dataset.gridPath, type: node.dataset.gridType, text: node.value }));
      const overrides = [...grid.querySelectorAll('[data-grid-override]')].map((card) => ({ index: card.dataset.gridOverride === 'new' ? null : Number(card.dataset.gridOverride),
        employeeId: card.querySelector('[data-grid-employee]').value, path: card.querySelector('[data-grid-override-path]').value.trim(), mode: card.querySelector('[data-grid-override-mode]').value,
        text: card.querySelector('[data-grid-override-value]').value, effectiveFrom: card.querySelector('[data-grid-override-from]').value, effectiveTo: card.querySelector('[data-grid-override-to]').value }));
      let definition = editorApply(currentGridDefinition(), fields, overrides);
      if (sourcePolicyDirty) definition = applySourcePolicyControls(definition, sourcePolicyControls());
      definitionField.value = JSON.stringify(definition, null, 2); payoutRiskAcknowledgementField.checked = false; rebuildGrid();
      gridMessage.textContent = 'Таблица применена к черновику. Подтвердите риск и сохраните версию.';
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
        return `<tr><td>${escapeHtml(shift.workDate)}</td><td>${escapeHtml(shift.employeeName)}</td><td>${escapeHtml(shift.plannedMinutes)}</td><td>${escapeHtml(shift.workedMinutes)}</td><td><details><summary>${escapeHtml(intervalSource.length)} интервалов</summary><ul>${intervals || '<li>Закрытых интервалов нет.</li>'}</ul></details></td></tr>`;
      }).join('');
      const pageControls = pageCount > 1 ? `<div class="toolbar-row"><button type="button" class="button small" data-attendance-page="${attendancePage - 1}" ${attendancePage === 0 ? 'disabled' : ''}>Предыдущие смены</button><span>Страница ${attendancePage + 1} из ${pageCount}. Просмотрено: ${attendanceVisitedPages.size} из ${pageCount}.</span><button type="button" class="button small" data-attendance-page="${attendancePage + 1}" ${attendancePage >= pageCount - 1 ? 'disabled' : ''}>Следующие смены</button></div>` : '';
      const history = (data?.history || []).map((item) => `<li>Ревизия ${escapeHtml(item.revision)} · ${escapeHtml(item.approvedByName)} · ${escapeHtml(new Date(item.approvedAt).toLocaleString('ru-RU'))} · ${escapeHtml(item.reason)}</li>`).join('');
      const approved = data?.currentApproval;
      const approval = approved ? `<section><strong>Последнее утверждение: ревизия ${escapeHtml(approved.revision)}</strong><p>${data.stale ? 'Источник изменился после утверждения — требуется новая проверка и ревизия.' : 'Источник совпадает с утверждённым снимком.'}</p><p>Утвердил: ${escapeHtml(approved.approvedByName)} · ${escapeHtml(new Date(approved.approvedAt).toLocaleString('ru-RU'))}</p></section>` : '<p>Для этого периода ещё нет утверждённого снимка.</p>';
      attendanceResult.innerHTML = `<p><strong>${data?.complete ? 'Период можно утвердить' : 'Нужно исправить источник перед утверждением'}</strong></p><p>Плановых смен: ${escapeHtml(data?.scheduleCount ?? 0)} · Интервалов: ${escapeHtml(data?.logCount ?? 0)} · SHA-256 источника: <code>${escapeHtml(data?.sourceWatermark || '—')}</code></p>${reasons ? `<ul>${reasons}</ul>` : ''}${pageControls}<div style="max-width:100%;overflow-x:auto"><table><thead><tr><th>Дата</th><th>Сотрудник</th><th>План, мин</th><th>Факт, мин</th><th>Исходные интервалы</th></tr></thead><tbody>${shifts || '<tr><td colspan="5">Плановых смен за период нет.</td></tr>'}</tbody></table></div>${pageControls}${data?.stale ? '<p class="warning-message">Последний снимок устарел относительно текущего табеля.</p>' : ''}${approval}${history ? `<details><summary>История утверждений</summary><ul>${history}</ul></details>` : ''}`;
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
      if (!previewInput.dataset.userEdited) previewInput.value = JSON.stringify(defaultPreview(), null, 2);
    }).catch(() => null);

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
    const renderList = () => {
      if (!schemes.length) { list.innerHTML = '<div class="empty">Схем пока нет. Создайте схему и сохраните первую черновую версию.</div>'; return; }
      list.innerHTML = schemes.map((scheme) => `<article class="finance-scheme-card"><div class="panel-head"><div><h3>${escapeHtml(scheme.name)}</h3><small class="muted">${escapeHtml(scheme.description || 'Без описания')}</small></div></div><div class="finance-scheme-versions">${sortedVersions(scheme).map((version) => `<div class="payment-row"><label><input type="checkbox" data-scheme-compare-version="${escapeHtml(version.id)}"> Сравнить</label><span>Версия ${escapeHtml(version.versionNo)} · ${escapeHtml(version.mode)} · ${escapeHtml(version.effectiveFrom)}${version.effectiveTo ? ` — ${escapeHtml(version.effectiveTo)}` : ''}<small class="muted">${version.payoutRiskAcknowledgement?.configDigest ? `Риск подтверждён владельцем ${escapeHtml(version.payoutRiskAcknowledgement.acknowledgedAt || '')}` : 'Подтверждение риска не сохранено'}</small></span><span class="badge ${version.status === 'active' ? 'success' : version.status === 'draft' ? 'warning' : ''}">${escapeHtml(version.status)}</span><div class="toolbar-row"><button type="button" class="button small" data-scheme-open-version="${escapeHtml(version.id)}">Открыть</button>${version.status === 'draft' ? `<button type="button" class="button small primary" data-scheme-activate="${escapeHtml(version.id)}">Активировать</button>` : ''}<button type="button" class="button small" data-scheme-revisions="${escapeHtml(version.id)}">История</button></div></div>`).join('') || '<div class="empty">Черновых версий нет</div>'}<div class="toolbar-row"><button type="button" class="button small" data-scheme-new-version="${escapeHtml(scheme.id)}">Создать новую версию</button></div></div></article>`).join('');
    };
    const load = async ({ force = false } = {}) => {
      if (pending && !force) return;
      invalidateReadiness();
      notify('Загружаем настройки…');
      list.innerHTML = '<div class="empty">Загрузка схем…</div>';
      try { const data = await request('/api/payroll/schemes'); schemes = Array.isArray(data.items) ? data.items : []; renderList(); notify(schemes.length ? '' : ''); }
      catch (error) { schemes = []; list.innerHTML = `<div class="empty">Не удалось загрузить схемы (${escapeHtml(error.message)}). <button type="button" class="button small" data-scheme-retry>Повторить</button></div>`; notify('Настройки недоступны.', 'error'); }
    };
    const openVersion = async (versionId) => {
      selectedVersion=null;invalidateReadiness();
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
      payoutRiskAcknowledgementField.checked = false;
      payoutRiskAcknowledgementLabel.hidden = version.status !== 'draft';
      payoutRiskAcknowledgementField.disabled = version.status !== 'draft';
      panel.querySelector('[data-scheme-save]').hidden = version.status !== 'draft';
      editor.hidden = false;
      rebuildGrid();
      refreshReadiness();
      notify(version.status === 'draft' ? 'Открыт редактируемый черновик.' : 'Активная версия защищена от редактирования. Создайте новую версию для изменений.');
    };
    const showEditor = async (action, { scheme = null, version = null } = {}) => {
      selectedVersion=null;invalidateReadiness();
      await venueTimezonePromise;
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
      refreshReadiness();
      notify('Проверьте период действия, роли, назначения сотрудников и правила до сохранения.');
    };

    panel.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button || pending) return;
      try {
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
          const card = button.closest('[data-grid-override]'); card.querySelector('[data-grid-override-mode]').value = 'inherit'; card.querySelector('[data-grid-override-value]').value = '';
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
        if (button.matches('[data-scheme-editor-cancel]')) { editor.hidden = true; editorAction = null; invalidateReadiness(); return; }
        if (button.matches('[data-scheme-open-version]')) return await openVersion(button.dataset.schemeOpenVersion);
        if (button.matches('[data-scheme-new-version]')) {
          const scheme = schemes.find((item) => item.id === button.dataset.schemeNewVersion);
          const latest = sortedVersions(scheme || {})[0];
          const version = latest ? await request(`/api/payroll/versions/${encodeURIComponent(latest.id)}`) : null;
          return await showEditor({ kind: 'new-version', schemeId: scheme.id }, { scheme, version });
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
        if (button.matches('[data-scheme-run-approved-attendance]')) {
          if (!selectedVersion) throw new Error('Сначала откройте версию схемы.');
          const preview = validatePreview(JSON.parse(previewInput.value));
          const result = await request(`/api/payroll/versions/${encodeURIComponent(selectedVersion.versionId)}/preview/approved-attendance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewInput: preview }) });
          previewResult.hidden = false; previewResult.innerHTML = renderApprovedAttendancePreview(result, preview);
          notify('Сценарий использует сохранённую payroll-ревизию посещаемости; остальные данные остаются сценарными.', 'success'); return;
        }
        if (button.matches('[data-scheme-run-venue-preview]')) {
          if (!selectedVersion) throw new Error('Сначала откройте версию схемы.');
          const preview = validatePreview(JSON.parse(previewInput.value));
          const result = await request(`/api/payroll/versions/${encodeURIComponent(selectedVersion.versionId)}/preview/venue-turnover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewInput: preview }) });
          previewResult.hidden = false; previewResult.innerHTML = renderVenueTurnoverPreview(result, preview);
          const ready = result.result?.status === 'ready';
          notify(ready ? 'Сценарий рассчитан с дневным оборотом закрытых чеков; это не официальный расчёт и он не сохранён.'
            : 'Сценарий с оборотом чеков показан с блокерами; это не официальный расчёт и он не сохранён.', ready ? 'success' : 'error'); return;
        }
        if (button.matches('[data-scheme-compare]')) {
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
      if (gridDirty) { notify('Примените изменения таблицы перед сохранением и подтверждением риска.', 'error'); return; }
      if (sourcePolicyDirty) { notify('Примените правила источников перед сохранением и подтверждением риска.', 'error'); return; }
      let definition;
      try { definition = JSON.parse(definitionField.value); }
      catch (error) { notify(`Конфигурация должна быть корректным JSON (${error.message}).`, 'error'); definitionField.focus(); return; }
      if (!payoutRiskAcknowledgementField.checked) {
        notify('Подтвердите понимание риска. Подтверждение не разрешает проводить выплату сверх личной выручки.', 'error');
        payoutRiskAcknowledgementField.focus(); return;
      }
      const payoutRiskAcknowledgement = { confirmed: true, policyCode: PAYOUT_RISK_ACK_POLICY };
      let capIncreases;
      try { capIncreases = editorPersonalCapIncreases(definition); }
      catch (error) { notify(`Проверьте личные лимиты: ${error.message}`, 'error'); return; }
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
        editor.hidden = true; editorAction = null; pending = false; await load({ force: true });
        const versionId = result.versionId || result.versions?.[0]?.versionId;
        if (versionId) await openVersion(versionId);
      } catch (error) { notify(`Не удалось сохранить схему: ${payrollSaveErrorLabels[error.message] || error.message}`, 'error'); }
      finally { pending = false; save.disabled = false; gridFieldset.disabled = editorAction?.kind === 'inspect'; definitionField.readOnly = editorAction?.kind === 'inspect'; nameField.disabled = editorAction?.kind !== 'create'; descriptionField.disabled = editorAction?.kind !== 'create'; payoutRiskAcknowledgementField.disabled = editorAction?.kind === 'inspect'; personalCapField.disabled = editorAction?.kind === 'inspect' || personalCapBox.dataset.state === 'invalid'; refreshSourcePolicyDisabled(); }
    });
    panel.querySelector('[data-scheme-reload]').addEventListener('click', load);
    attendanceFrom.addEventListener('change', () => { attendanceCoverage = null; attendanceWatermark.value = null; attendanceApprove.disabled = true; attendanceResult.innerHTML = '<p class="empty">Период изменился. Проверьте полноту источника заново.</p>'; });
    attendanceTo.addEventListener('change', () => { attendanceCoverage = null; attendanceWatermark.value = null; attendanceApprove.disabled = true; attendanceResult.innerHTML = '<p class="empty">Период изменился. Проверьте полноту источника заново.</p>'; });
    refreshAttendance();
    load();
  };

  mount();
  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
