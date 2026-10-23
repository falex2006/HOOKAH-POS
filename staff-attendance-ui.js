(() => {
  'use strict';

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const text = (value, fallback = '—') => value == null || value === '' ? fallback : String(value);
  const modeLabels = { free: 'Свободный выход', warn: 'Выход с пояснением', approval: 'Выход по согласованию' };
  const errorLabels = {
    attendance_reason_required: 'Укажите причину (от 3 до 500 символов).',
    attendance_approval_required: 'Сначала дождитесь решения по запросу на выход.',
    attendance_approval_unavailable: 'Для этого запроса пока нет доступного согласующего.',
    attendance_session_already_open: 'У вас уже есть активная сессия выхода на работу. Обновляем состояние.',
    attendance_already_started: 'У вас уже есть активная сессия выхода на работу. Обновляем состояние.',
    attendance_session_not_open: 'Активная сессия не найдена. Обновите состояние.',
    attendance_version_conflict: 'Данные уже изменились в другом окне. Обновите экран и проверьте актуальное состояние.',
    attendance_policy_version_conflict: 'Настройки уже изменили в другом окне. Загрузите их заново.',
    attendance_policy_conflict: 'Настройки уже изменили в другом окне. Загрузите их заново.',
    attendance_request_version_conflict: 'Запрос уже обработан или изменён. Обновите очередь.',
    attendance_request_conflict: 'Запрос уже обработан или изменён. Обновите очередь.',
    attendance_request_pending: 'У вас уже есть ожидающий или действующий запрос. Обновите список.',
    attendance_grant_conflict: 'Права сотрудника уже изменились. Обновите список перед повторным сохранением.',
    attendance_grant_invalid: 'Проверьте выбранные права доступа.',
    attendance_grant_employee_invalid: 'Выдавать эти полномочия можно только активному администратору или управляющему этого заведения.',
    attendance_idempotency_conflict: 'Состояние действия изменилось. Обновите экран и повторите его.',
    attendance_approval_invalid: 'Срок согласования истёк или запрос уже использован. Отправьте новый запрос.',
    attendance_session_conflict: 'Сессия уже завершена или изменена. Обновите состояние.',
    attendance_own_session_use_end: 'Свою отметку нужно завершить в личной панели.',
    attendance_schedule_invalid: 'В опубликованном графике обнаружены некорректные данные. Обратитесь к управляющему.',
    attendance_forbidden: 'У этой учётной записи нет нужного права.',
    attendance_employee_inactive: 'Выход на работу недоступен: учётная запись неактивна.',
    venue_context_changed: 'Активное заведение изменилось. Обновите страницу.',
    request_key_required: 'Не удалось безопасно подготовить действие. Обновите страницу и повторите.',
    attendance_policy_invalid: 'Проверьте режим и время ранней подготовки.',
    attendance_preparation_invalid: 'Время ранней подготовки должно быть целым числом от 0 до 240 минут.',
    attendance_schedule_unavailable: 'Не удалось проверить опубликованный график. Повторите позже.',
    attendance_start_not_admitted: 'Начало работы пока не разрешено. Проверьте график или запрос на согласование.',
  };
  const errorText = (error) => {
    const code = error?.payload?.error || error?.code || error?.message;
    if (errorLabels[code]) return errorLabels[code];
    if (error?.status === 401 || error?.status === 403) return 'Сессия или права доступа изменились. Обновите страницу.';
    if (error?.status >= 500) return 'Сервис временно недоступен. Проверьте соединение и повторите.';
    return 'Не удалось выполнить действие. Проверьте введённые данные и попробуйте ещё раз.';
  };
  const requestKey = () => {
    if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') throw new Error('request_key_required');
    return globalThis.crypto.randomUUID();
  };
  const dateTime = (value, timezone) => {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Время не определено';
    try { return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, dateStyle: 'medium', timeStyle: 'short' }).format(date); }
    catch (_) { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
  };
  const apiCall = async (api, path, method = 'GET', body) => {
    if (typeof api !== 'function') throw new Error('attendance_api_unavailable');
    const options = method === 'GET' ? { method: 'GET' } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return api(path, options);
  };
  const person = (name, role) => `${escapeHtml(text(name, 'Сотрудник'))}${role ? ` · ${escapeHtml(({ owner: 'Владелец', admin: 'Администратор', manager: 'Управляющий' })[role] || role)}` : ''}`;
  const stateLabel = (state) => ({ pending: 'Ожидает решения', approved: 'Согласован', rejected: 'Отклонён', cancelled: 'Отменён', expired: 'Срок истёк', used: 'Использован' })[state] || text(state, 'Статус не указан');
  const rootCard = (title, subtitle = '') => `<section class="attendance-page"><header class="attendance-heading"><div><p class="attendance-eyebrow">УЧЁТ РАБОЧЕГО ВРЕМЕНИ</p><h1>${escapeHtml(title)}</h1>${subtitle ? `<p class="attendance-subtitle">${escapeHtml(subtitle)}</p>` : ''}</div></header><div class="attendance-feedback" data-attendance-feedback role="status" aria-live="polite" hidden></div><div data-attendance-content><div class="attendance-loading" role="status">Загружаем данные…</div></div></section>`;

  function createView(target, api, kind, options = {}) {
    if (!(target instanceof Element)) throw new TypeError('attendance_target_required');
    document.body.classList.add('attendance-route');
    target.innerHTML = rootCard(kind === 'self' ? 'Выход на работу' : 'Выходы сотрудников', kind === 'self' ? 'Отметьте фактическое начало и окончание своей работы.' : 'Ежедневные отметки команды и запросы на согласование.');
    const content = target.querySelector('[data-attendance-content]');
    const feedback = target.querySelector('[data-attendance-feedback]');
    if (kind === 'management') {
      const helpButton = document.createElement('button');
      helpButton.type = 'button'; helpButton.className = 'attendance-help-toggle management-help-button';
      helpButton.setAttribute('aria-label', 'Справка: выход на работу');
      helpButton.innerHTML = '<span class="management-help-icon" aria-hidden="true">?</span><span class="management-help-label">Справка</span>';
      helpButton.setAttribute('aria-expanded', 'false');
      const help = document.createElement('section'); help.hidden = true; help.className = 'attendance-card attendance-help-guide';
      help.setAttribute('aria-label', 'Справка по выходу на работу');
      help.innerHTML = `<h2>Как настроить выход на работу</h2>
        <p>Сначала выберите правила для заведения. Затем владелец может выдать управляющему или администратору отдельные права на настройку и согласование.</p>
        <details><summary>1. График, фактическая работа и касса — разные действия</summary><p>График задаёт план. «Начать работу» фиксирует фактический приход конкретного сотрудника по времени сервера. Открытие кассовой смены — отдельная общая операция заведения. Личная отметка не открывает кассу и не рассчитывает зарплату.</p></details>
        <details><summary>2. Подготовка до начала смены: пример 09:30 → 10:00</summary><p>Для плана 10:00–18:00 укажите 30 минут ранней подготовки. С 09:30 сотрудник сможет начать работу. При нажатии в 09:34 фактическое начало будет 09:34, план останется 10:00–18:00. В 09:29 действуют правила выхода вне графика. Допуск к подготовке сам по себе не означает её автоматическую оплату.</p><p>Общее значение задаётся в правилах выхода. В поле смены или интервала шаблона пустое значение наследует текущее правило заведения; 0 отключает раннюю подготовку для этой смены; число от 1 до 240 задаёт своё значение. При публикации настройка шаблона копируется в смену и дальше не меняется вместе с шаблоном.</p></details>
        <details><summary>3. Как выбрать режим</summary><p>«Свободный выход» разрешает начало без подходящего графика — это режим по умолчанию. «Выход с пояснением» требует причину вне разрешённого интервала. «Выход по согласованию» требует одобрение уполномоченного руководителя вне интервала. Внутри интервала дополнительный запрос не нужен.</p></details>
        <details><summary>4. Замена коллеги, болезнь или незапланированный выход</summary><p>Для постоянной замены исправьте и опубликуйте график. Для разового исключения сотрудник отправляет запрос с причиной, а руководитель открывает очередь, проверяет сотрудника и время, затем согласовывает или отклоняет запрос. Сотрудник обновляет статус и сам начинает работу по согласованию.</p><p>Разрешение одноразовое, действует два часа с создания запроса. Согласование не начинает работу автоматически и не переносит время фактического прихода назад. Просроченный запрос нужно отправить заново; собственный запрос самостоятельно согласовать нельзя.</p></details>
        <details><summary>5. Опоздание, ночь и окончание работы</summary><p>Опоздавший сотрудник может начать работу до окончания своей назначенной смены. Ночная смена учитывается через полночь. В момент планового окончания новый выход уже находится вне интервала. Начатая работа автоматически не закрывается: сотрудник нажимает «Завершить работу» фактически в конце работы.</p><p>Отмена графика или изменение правил не переписывает уже сохранённые отметки. Черновики, отменённые смены, выходные и неназначенные смены не дают допуска.</p></details>
        <details><summary>6. Кто может менять настройки и согласовывать</summary><p>Владелец отдельно выдаёт права «Настраивать правила», «Согласовывать запросы» и «Завершать чужие отметки». Последнее требует причины и отдельного подтверждения; свою отметку руководитель завершает только в личной панели. Управляющий или администратор получает лишь выбранные полномочия и не может передавать их дальше. Право составлять график само по себе не даёт эти права.</p></details>
        <details><summary>7. Если не сохранилось или данные изменились</summary><p>При ошибке соединения не считайте работу начатой: обновите статус и проверьте отметку. Повтор того же действия защищён от дублей. При сообщении об изменении версии обновите экран перед повторным сохранением. Если график недоступен, система показывает ошибку, а не считает, что смен нет.</p></details>`;
      target.querySelector('.attendance-heading').append(helpButton);
      content.before(help);
      helpButton.onclick = () => { help.hidden = !help.hidden; helpButton.setAttribute('aria-expanded', String(!help.hidden)); };
    }
    let disposed = false;
    let readGeneration = 0;
    let activeManagementTab = 'overview';
    let refreshTimer = null;
    let snapshot = null;
    const pendingKeys = new Map();
    const keyFor = (key, body) => {
      const fingerprint = JSON.stringify(body);
      const current = pendingKeys.get(key);
      if (!current || current.fingerprint !== fingerprint) pendingKeys.set(key, { fingerprint, value: requestKey() });
      return pendingKeys.get(key).value;
    };
    const clearKey = (key) => pendingKeys.delete(key);
    const notifyAttendanceChanged = () => {
      window.dispatchEvent(new CustomEvent('staff-attendance:changed'));
      if (typeof BroadcastChannel === 'function') {
        const channel = new BroadcastChannel('territory-crm-notifications');
        channel.postMessage({ type: 'attendance-changed' });
        channel.close();
      }
    };
    const showFeedback = (message, tone = 'error') => {
      if (!feedback?.isConnected) return;
      feedback.hidden = !message;
      feedback.className = `attendance-feedback${message ? ` is-${tone}` : ''}`;
      feedback.textContent = message || '';
      feedback.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    };
    const showDraftGuard = () => {
      showFeedback('Есть несохранённые данные. Обновление остановлено, чтобы сохранить ввод. Если хотите отменить черновик, используйте кнопку ниже.', 'warning');
      if (!feedback?.isConnected || feedback.querySelector('[data-attendance-discard-draft]')) return;
      const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'button small'; discard.dataset.attendanceDiscardDraft = ''; discard.textContent = 'Отменить черновик и обновить';
      discard.addEventListener('click', () => { if (!window.confirm('Отменить все несохранённые данные и загрузить актуальное состояние?')) return; content.querySelectorAll('[data-attendance-dirty="true"]').forEach(form => delete form.dataset.attendanceDirty); load({ force: true }); });
      feedback.append(discard);
    };
    const busy = (button, value) => { if (button?.isConnected) { button.disabled = value; button.setAttribute('aria-busy', value ? 'true' : 'false'); } };
    const run = async ({ button, key, path, method = 'POST', body = {}, success, refresh = true, dirtyForm }) => {
      busy(button, true); showFeedback('');
      try {
        const result = await apiCall(api, path, method, { ...body, requestKey: keyFor(key, body) });
        clearKey(key);
        if (!content?.isConnected || disposed) return result;
        if (dirtyForm?.isConnected) delete dirtyForm.dataset.attendanceDirty;
        notifyAttendanceChanged();
        if (success) showFeedback(success, 'success');
        if (refresh) await load({ preserveFeedback: true });
        return result;
      } catch (error) {
        if (content?.isConnected && !disposed) showFeedback(errorText(error));
        throw error;
      } finally { busy(button, false); }
    };
    const hasUnsavedInput = () => Boolean(content.querySelector('[data-attendance-dirty="true"]'));
    content.addEventListener('input', event => { const form = event.target.closest('form[data-attendance-policy],form[data-attendance-grant],form[data-attendance-decision],form[data-session-close],form[data-attendance-start-form],form[data-attendance-request-form]'); if (form) form.dataset.attendanceDirty = 'true'; });
    content.addEventListener('change', event => { const form = event.target.closest('form[data-attendance-policy],form[data-attendance-grant],form[data-attendance-decision],form[data-session-close],form[data-attendance-start-form],form[data-attendance-request-form]'); if (form) form.dataset.attendanceDirty = 'true'; });
    async function load({ preserveFeedback = false, force = false, automatic = false } = {}) {
      if (disposed || !content?.isConnected) return;
      const activeElement = document.activeElement;
      const focusedInForm = Boolean(activeElement && [...content.querySelectorAll('form')].some(form => form.contains(activeElement)));
      if (automatic && (focusedInForm || content.querySelector('details[open]') || content.querySelector('[aria-expanded="true"]'))) return;
      if (!force && hasUnsavedInput()) {
        showDraftGuard();
        return;
      }
      const generation = ++readGeneration;
      if (!preserveFeedback) showFeedback('');
      content.innerHTML = '<div class="attendance-loading" role="status">Обновляем данные…</div>';
      try {
        const next = await apiCall(api, kind === 'self' ? '/api/staff/attendance/self' : '/api/staff/attendance/management');
        if (disposed || !content?.isConnected || generation !== readGeneration) return;
        snapshot = next;
        if (!snapshot || typeof snapshot !== 'object') throw new Error('attendance_response_invalid');
        kind === 'self' ? renderSelf() : renderManagement();
      } catch (error) {
        if (disposed || !content?.isConnected || generation !== readGeneration) return;
        content.innerHTML = `<div class="attendance-empty"><h2>Не удалось загрузить данные</h2><p>${escapeHtml(errorText(error))}</p><button class="button" type="button" data-attendance-retry>Повторить</button></div>`;
        content.querySelector('[data-attendance-retry]')?.addEventListener('click', () => load());
      }
    }
    const policy = () => snapshot?.settings || { mode: 'free', preparationMinutes: 0, version: 0 };
    const renderSelf = () => {
      const access = snapshot.access || {};
      if (access.self !== true) { content.innerHTML = '<div class="attendance-empty"><h2>Личный учёт недоступен</h2><p>Попросите владельца проверить доступ и активность учётной записи.</p></div>'; return; }
      const current = snapshot.session && !snapshot.session.endedAt ? snapshot.session : null;
      const admission = snapshot.admission || {};
      const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
      const serverNow = Date.parse(snapshot.serverNow || '');
      const approved = requests.find((entry) => entry.status === 'approved' && !entry.consumedAt
        && entry.id && Number.isFinite(serverNow) && Date.parse(entry.windowStart) <= serverNow && Date.parse(entry.windowEnd) > serverNow);
      // A newer pending request must not hide an existing usable approval.
      const pending = !approved && admission.decision === 'approval_required'
        ? requests.find((entry) => entry.status === 'pending' && Date.parse(entry.windowEnd) > serverNow) : null;
      const status = current ? 'Сейчас вы отмечены как работающий сотрудник.' : pending ? 'Запрос на выход отправлен и ожидает решения.' : 'Активной отметки о начале работы нет.';
      const activeSession = current ? `<div class="attendance-status is-active"><span class="attendance-status-dot" aria-hidden="true"></span><div><b>Работа начата</b><span>Фактическое начало: ${escapeHtml(dateTime(current.startedAt, snapshot.timezone))}</span></div></div><button class="button primary" type="button" data-attendance-end>Завершить работу</button>` : '';
      const latest = snapshot.latestSession?.endedBy ? `<p class="attendance-inline-help">Последнюю открытую отметку завершил руководитель ${escapeHtml(dateTime(snapshot.latestSession.endedAt, snapshot.timezone))}. Причина: ${escapeHtml(text(snapshot.latestSession.endReason, 'не указана'))}.</p>` : '';
      let action = '';
      if (!current && !pending && approved) {
        action = '<button class="button primary" type="button" data-attendance-approved-start>Начать по согласованию</button><p class="attendance-inline-help">Используется ранее одобренный запрос; окончательную допустимость проверит сервер.</p>';
      } else if (!current && !pending) {
        if (admission.decision === 'approval_required') {
          action = `<form class="attendance-action-form" data-attendance-request-form><label>Почему нужен выход вне разрешённого времени?<textarea name="reason" minlength="3" maxlength="500" required rows="3" placeholder="Кратко укажите причину"></textarea></label><button class="button primary" type="submit">Отправить на согласование</button></form>`;
        } else if (admission.decision === 'reason_required') {
          action = `<form class="attendance-action-form" data-attendance-start-form><label>Пояснение к выходу вне графика<textarea name="reason" minlength="3" maxlength="500" required rows="3" placeholder="Кратко укажите причину"></textarea></label><button class="button primary" type="submit">Начать работу</button></form>`;
        } else {
          action = '<button class="button primary" type="button" data-attendance-start>Начать работу</button>';
        }
      }
      const requestRows = requests.length ? `<section class="attendance-section"><div class="attendance-section-title"><div><h2>Мои запросы</h2><p>Здесь видны только ваши запросы на выход вне разрешённого интервала.</p></div></div><div class="attendance-list">${requests.map((item) => `<article class="attendance-row"><div><b>${escapeHtml(stateLabel(item.status))}</b><span>${escapeHtml(text(item.reason, 'Причина не указана'))}</span><small>${escapeHtml(dateTime(item.windowStart, snapshot.timezone))} – ${escapeHtml(dateTime(item.windowEnd, snapshot.timezone))}</small></div><span class="attendance-chip ${item.status === 'approved' ? 'is-success' : item.status === 'rejected' ? 'is-danger' : 'is-warning'}">${escapeHtml(stateLabel(item.status))}</span>${item.status === 'pending' ? `<button class="button small" type="button" data-attendance-cancel="${escapeHtml(item.id)}" data-version="${escapeHtml(item.version)}">Отменить запрос</button>` : ''}</article>`).join('')}</div></section>` : '';
      content.innerHTML = `<div class="attendance-self-grid"><section class="attendance-card attendance-self-card"><div class="attendance-card-head"><div><h2>Моя отметка</h2><p>${escapeHtml(status)}</p></div><span class="attendance-chip ${current ? 'is-success' : pending ? 'is-warning' : 'is-neutral'}">${current ? 'Идёт работа' : pending ? 'На согласовании' : 'Не начата'}</span></div>${activeSession}${latest}${action}<p class="attendance-quiet-note">Это фактическая отметка о работе, не кассовая смена и не расчёт зарплаты.</p></section><aside class="attendance-card attendance-self-help"><h2>Как это работает</h2><p>Нажмите «Начать работу» при фактическом выходе, а в конце нажмите «Завершить работу». Если система просит пояснение или согласование, следуйте подсказке на экране.</p><p class="attendance-quiet-note">Время фиксируется сервером. Исправления и расчёт оплаты выполняются отдельно.</p></aside></div>${requestRows}`;
      const selfCard = content.querySelector('.attendance-self-card');
      content.querySelectorAll('.attendance-list .attendance-row').forEach((row, index) => {
        if (!requests[index]?.decisionNote) return;
        const note = document.createElement('p'); note.className = 'attendance-inline-help';
        note.textContent = `Комментарий руководителя: ${requests[index].decisionNote}`;
        row.firstElementChild?.append(note);
      });
      if (selfCard) {
        const explanation = document.createElement('p'); explanation.className = 'attendance-inline-help';
        explanation.textContent = admission.allowedFrom
          ? `План: ${dateTime(admission.plannedStart, snapshot.timezone)} — ${dateTime(admission.plannedEnd, snapshot.timezone)}. Начать подготовку можно с ${dateTime(admission.allowedFrom, snapshot.timezone)}.`
          : admission.nextAllowedFrom ? `Ближайший выход по графику разрешён с ${dateTime(admission.nextAllowedFrom, snapshot.timezone)}. Вы можете запросить исключение, если оно необходимо.` : '';
        if (explanation.textContent) selfCard.append(explanation);
        const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'button small';
        refresh.textContent = 'Обновить статус'; refresh.onclick = () => load(); selfCard.append(refresh);
      }
      content.querySelector('[data-attendance-start]')?.addEventListener('click', (event) => run({ button: event.currentTarget, key: 'self-start', path: '/api/staff/attendance/start', body: {} , success: 'Начало работы зафиксировано.' }).catch(() => {}));
      content.querySelector('[data-attendance-approved-start]')?.addEventListener('click', (event) => run({ button: event.currentTarget, key: `self-start-approved-${approved.id}`, path: '/api/staff/attendance/start', body: { approvalId: approved.id }, success: 'Начало работы зафиксировано.' }).catch(() => {}));
      content.querySelector('[data-attendance-end]')?.addEventListener('click', (event) => run({ button: event.currentTarget, key: `self-end-${current.id}`, path: '/api/staff/attendance/end', body: { id: current.id, version: current.version }, success: 'Окончание работы зафиксировано.' }).catch(() => {}));
      content.querySelector('[data-attendance-start-form]')?.addEventListener('submit', (event) => { event.preventDefault(); const form = event.currentTarget; run({ dirtyForm: form, button: form.querySelector('button'), key: 'self-start', path: '/api/staff/attendance/start', body: { reason: form.elements.reason.value.trim() }, success: 'Начало работы зафиксировано.' }).catch(() => {}); });
      content.querySelector('[data-attendance-request-form]')?.addEventListener('submit', (event) => { event.preventDefault(); const form = event.currentTarget; run({ dirtyForm: form, button: form.querySelector('button'), key: 'self-request', path: '/api/staff/attendance/requests', body: { reason: form.elements.reason.value.trim() }, success: 'Запрос добавлен в очередь согласования. Решение появится здесь и в уведомлениях.' }).catch(() => {}); });
      content.querySelectorAll('[data-attendance-cancel]').forEach((button) => button.addEventListener('click', (event) => { const node = event.currentTarget; run({ button: node, key: `cancel-${node.dataset.attendanceCancel}`, path: `/api/staff/attendance/requests/${encodeURIComponent(node.dataset.attendanceCancel)}/cancel`, body: { version: Number(node.dataset.version) }, success: 'Запрос отменён.' }).catch(() => {}); }));
    };
    const renderManagement = () => {
      const access = snapshot.access || {};
      const canManage = access.managePolicy === true;
      const canApprove = access.approve === true;
      const canGrant = access.grant === true;
      const canClose = access.closeSessions === true;
      if (!canManage && !canApprove && !canGrant && !canClose) { content.innerHTML = '<div class="attendance-empty"><h2>Нет доступа к управлению выходами</h2><p>Владелец может выдать отдельные полномочия. Для личной отметки используйте кнопку «Выход на работу».</p></div>'; return; }
      if (activeManagementTab === 'settings' && !canManage && !canGrant) activeManagementTab = 'overview';
      const settings = policy();
      const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
      const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
      const activeSessions = sessions.filter(item => !item.endedAt);
      const pendingRequests = requests.filter(item => item.status === 'pending');
      const nowMs = Date.parse(snapshot.serverNow || '');
      const outsideScheduleSessions = canApprove ? sessions.filter(item => item.basis === 'outside_schedule'
        && Number.isFinite(Date.parse(item.startedAt)) && (!Number.isFinite(nowMs) || Date.parse(item.startedAt) >= nowMs - 7 * 24 * 60 * 60 * 1000)) : [];
      const tabs = `<nav class="attendance-tabs" role="tablist" aria-label="Разделы выходов сотрудников"><button type="button" role="tab" aria-selected="${activeManagementTab === 'overview'}" data-attendance-tab="overview">Обзор дня</button>${canManage || canGrant ? `<button type="button" role="tab" aria-selected="${activeManagementTab === 'settings'}" data-attendance-tab="settings">Правила и доступ</button>` : ''}<button type="button" class="button small attendance-refresh" data-attendance-refresh>Обновить</button></nav>`;
      const requestSection = canApprove ? `<section class="attendance-card"><div class="attendance-section-title"><div><h2>Ожидают решения</h2><p>${pendingRequests.length} запросов на согласование</p></div></div>${pendingRequests.length ? `<div class="attendance-list">${pendingRequests.map(item => `<article class="attendance-row attendance-approval-row"><div class="attendance-row-main"><b>${person(item.userName, item.role)}</b><span>${escapeHtml(text(item.reason, 'Причина не указана'))}</span><small>Окно выхода: ${escapeHtml(dateTime(item.windowStart, snapshot.timezone))} – ${escapeHtml(dateTime(item.windowEnd, snapshot.timezone))}</small></div><form class="attendance-decision-form" data-attendance-decision="${escapeHtml(item.id)}" data-version="${escapeHtml(item.version)}"><label class="attendance-note-label">Комментарий, необязательно<input name="note" minlength="3" maxlength="500" placeholder="Комментарий сотруднику"></label><div class="attendance-actions"><button class="button primary" type="submit" data-decision="approved">Согласовать</button><button class="button danger-outline" type="submit" data-decision="rejected">Отклонить</button></div></form></article>`).join('')}</div>` : '<div class="attendance-empty attendance-empty-compact"><p>Ожидающих запросов нет.</p></div>'}</section>` : '';
      const sessionRows = canApprove || canClose ? activeSessions : [];
      const outsideScheduleSection = canApprove ? `<section class="attendance-card"><div class="attendance-section-title"><div><h2>Недавние выходы вне планового окна</h2><p>Сохранённые данные фактической отметки — не оценка сотрудника.</p></div></div>${outsideScheduleSessions.length ? `<div class="attendance-list">${outsideScheduleSessions.map(item => `<article class="attendance-row attendance-outside-row"><div><b>${person(item.userName)}</b><span>Начало: ${escapeHtml(dateTime(item.startedAt, snapshot.timezone))}${item.endedAt ? ` · окончание: ${escapeHtml(dateTime(item.endedAt, snapshot.timezone))}` : ' · отметка открыта'}</span><small>${item.plannedEnd ? `Плановое окончание: ${escapeHtml(dateTime(item.plannedEnd, snapshot.timezone))}` : 'В опубликованном графике не найдено подходящего окна'}${item.startReason ? ` · Пояснение: ${escapeHtml(item.startReason)}` : ''}</small></div><span class="attendance-chip is-warning">Вне графика</span></article>`).join('')}</div>` : '<div class="attendance-empty attendance-empty-compact"><p>За последние 7 дней таких отметок нет.</p></div>'}</section>` : '';
      const sessionsSection = canApprove || canClose ? `<section class="attendance-card"><div class="attendance-section-title"><div><h2>Сейчас отмечены как работающие</h2><p>Фактические личные отметки, не состояние кассы.</p></div></div>${sessionRows.length ? `<div class="attendance-list">${sessionRows.map(item => {
        const isSelf = item.userId && item.userId === String(options.selfUserId || '');
        const overdueAt = item.plannedEnd ? Date.parse(item.plannedEnd) + 60 * 60 * 1000 : Date.parse(item.startedAt) + 16 * 60 * 60 * 1000;
        const overdue = Number.isFinite(overdueAt) && Date.parse(snapshot.serverNow || '') >= overdueAt;
        const basisLabel = ({ scheduled: 'По опубликованному графику', preparation: 'Ранняя подготовка по графику', outside_schedule: 'Вне планового окна', approved_exception: 'По согласованному исключению' })[item.basis] || '';
        const startDetails = [basisLabel, item.plannedEnd ? `Плановое окончание: ${dateTime(item.plannedEnd, snapshot.timezone)}` : '', canApprove && item.startReason ? `Пояснение при начале: ${item.startReason}` : ''].filter(Boolean).map(escapeHtml).join(' · ');
        const action = canClose && !isSelf ? `<details class="attendance-close-details"><summary class="button small">Завершить отметку</summary><form class="attendance-close-form" data-session-close="${escapeHtml(item.id)}" data-version="${escapeHtml(item.version)}"><p class="attendance-inline-help">Время окончания будет установлено по серверным часам. Укажите фактическую причину; сотрудник увидит её в своей отметке.</p><label>Причина завершения<textarea name="reason" minlength="3" maxlength="500" required rows="3" placeholder="Например: сотрудник сообщил, что закончил раньше"></textarea></label><label class="attendance-confirm-label"><input type="checkbox" name="confirm" required>Подтверждаю завершение этой сессии сейчас</label><button class="button danger-outline" type="submit">Подтвердить завершение</button></form></details>` : isSelf ? '<small class="attendance-inline-help">Свою сессию завершайте через личную отметку.</small>' : '';
        return `<article class="attendance-row attendance-session-row"><div><b>${person(item.userName)}</b><span>Начало: ${escapeHtml(dateTime(item.startedAt, snapshot.timezone))}</span>${startDetails ? `<small>${startDetails}</small>` : ''}<small>${overdue ? 'Отметка давно открыта — уточните у сотрудника, продолжается ли работа.' : 'Сотрудник отмечен как работающий.'}</small></div><span class="attendance-chip ${overdue ? 'is-warning' : 'is-success'}">${overdue ? 'Нужна проверка' : 'Работает'}</span>${action}</article>`;
      }).join('')}</div>` : '<div class="attendance-empty attendance-empty-compact"><p>Сейчас нет открытых отметок.</p></div>'}</section>` : '<section class="attendance-card"><div class="attendance-empty attendance-empty-compact"><p>Для просмотра текущих отметок и запросов требуется отдельное право согласования. Обратитесь к владельцу.</p></div></section>';
      const settingsSection = activeManagementTab === 'settings' ? `<div class="attendance-management-grid">${canManage ? `<section class="attendance-card"><div class="attendance-section-title"><div><h2>Правила выхода</h2><p>Применяются к новым отметкам; открытые сессии не меняются.</p></div></div><form class="attendance-policy-form" data-attendance-policy><label>Режим выхода<select name="mode">${Object.entries(modeLabels).map(([value, label]) => `<option value="${value}" ${settings.mode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Разрешить раннюю подготовку, минут<input name="preparationMinutes" type="number" min="0" max="240" step="1" value="${escapeHtml(settings.preparationMinutes ?? 0)}" inputmode="numeric"></label><p class="attendance-inline-help">Окно для опубликованной назначенной смены начинается за указанное число минут до планового начала. В смене пустое значение наследует правило заведения; 0 отключает допуск, 1–240 задаёт своё значение.</p><button class="button primary" type="submit">Сохранить правила</button></form></section>` : ''}${canGrant ? `<section class="attendance-card"><div class="attendance-section-title"><div><h2>Права сотрудников</h2><p>Только владелец выдаёт и отзывает полномочия. Получатель не может передать их дальше.</p></div></div>${renderGrants(snapshot.grants, settings.version)}</section>` : ''}<aside class="attendance-card attendance-management-help"><h2>Справка для руководителя</h2><p>Выдавайте только необходимые права. Завершение чужой отметки доступно лишь с отдельным полномочием и всегда требует причины.</p><details><summary>Режимы, напоминания и завершение</summary><ul><li><b>Свободный:</b> начало разрешено и вне графика.</li><li><b>С пояснением:</b> вне разрешённого окна сотрудник указывает причину.</li><li><b>По согласованию:</b> вне окна начало возможно после решения уполномоченного сотрудника.</li><li>Проверка создаётся через час после планового окончания; если планового окончания нет — через 16 часов после начала. Это просьба уточнить статус, а не обвинение или автозакрытие.</li><li>Руководитель с правом завершения указывает причину и подтверждает действие. Время фиксируется сервером; сотрудник увидит отметку и причину.</li><li>Отметка рабочего времени не открывает общую кассу и сама по себе не рассчитывает зарплату.</li></ul></details></aside></div>` : '';
      const overview = activeManagementTab === 'overview' ? `<div class="attendance-management-grid">${sessionsSection}${requestSection}${outsideScheduleSection}<aside class="attendance-card attendance-management-help"><h2>Ежедневная сводка</h2><p>Проверяйте, кто сейчас отмечен работающим, и просматривайте ожидающие запросы. Напоминание о долго открытой отметке — только повод уточнить статус, не автоматическое завершение и не вывод о нарушении.</p><p class="attendance-quiet-note">Личная отметка, кассовая смена и расчёт оплаты — отдельные процессы.</p></aside></div>` : settingsSection;
      content.innerHTML = `${tabs}<div data-attendance-tabpanel="${activeManagementTab}">${overview}</div>`;
      content.querySelectorAll('[data-attendance-tab]').forEach(button => button.addEventListener('click', () => {
        if (hasUnsavedInput()) { showDraftGuard(); return; }
        activeManagementTab = button.dataset.attendanceTab;
        renderManagement();
      }));
      content.querySelector('[data-attendance-refresh]')?.addEventListener('click', () => load());
      content.querySelector('[data-attendance-policy]')?.addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; const minutes = Number(form.elements.preparationMinutes.value); if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) { showFeedback('Время ранней подготовки должно быть целым числом от 0 до 240 минут.'); return; } run({ dirtyForm: form, button: form.querySelector('button[type="submit"]'), key: 'policy-save', path: '/api/staff/attendance/policy', method: 'PUT', body: { version: Number(settings.version), mode: form.elements.mode.value, preparationMinutes: minutes }, success: 'Правила выхода сохранены.' }).catch(() => {}); });
      content.querySelectorAll('[data-attendance-grant]').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); const node = event.currentTarget; run({ dirtyForm: node, button: node.querySelector('button[type="submit"]'), key: `grant-${node.dataset.userId}`, path: '/api/staff/attendance/grants', method: 'PUT', body: { userId: node.dataset.userId, version: Number(node.dataset.version), managePolicy: node.elements.managePolicy.checked, approve: node.elements.approve.checked, closeSessions: node.elements.closeSessions.checked }, success: 'Права сотрудника обновлены.' }).catch(() => {}); }));
      content.querySelectorAll('[data-attendance-decision]').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); const button = event.submitter; const decision = button?.dataset.decision; if (!['approved', 'rejected'].includes(decision)) return; const id = form.dataset.attendanceDecision; run({ dirtyForm: form, button, key: `decision-${id}`, path: `/api/staff/attendance/requests/${encodeURIComponent(id)}/decision`, body: { version: Number(form.dataset.version), decision, note: form.elements.note.value.trim() || undefined }, success: decision === 'approved' ? 'Запрос согласован.' : 'Запрос отклонён.' }).catch(() => {}); }));
      content.querySelectorAll('[data-session-close]').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); const node = event.currentTarget; const reason = node.elements.reason.value.trim(); if (reason.length < 3 || reason.length > 500 || !node.elements.confirm.checked) { showFeedback('Укажите причину от 3 до 500 символов и подтвердите завершение.'); return; } run({ dirtyForm: node, button: node.querySelector('button[type="submit"]'), key: `close-${node.dataset.sessionClose}`, path: `/api/staff/attendance/sessions/${encodeURIComponent(node.dataset.sessionClose)}/close`, body: { version: Number(node.dataset.version), reason }, success: 'Отметка завершена текущим серверным временем; причина сохранена.' }).catch(() => {}); }));
    };
    function renderGrants(grants, policyVersion) {
      if (!Array.isArray(grants) || grants.length === 0) return '<div class="attendance-empty attendance-empty-compact"><p>Нет активных сотрудников для выдачи этих прав.</p></div>';
      return `<div class="attendance-grants">${grants.map((grant) => `<form class="attendance-grant-row" data-attendance-grant data-user-id="${escapeHtml(grant.userId)}" data-version="${escapeHtml(grant.version ?? policyVersion ?? 0)}"><div><b>${person(grant.name, grant.role)}</b><span>Выберите только необходимые права</span></div><label class="staff-permission-option"><input type="checkbox" name="managePolicy" ${grant.managePolicy === true ? 'checked' : ''}><span>Настраивать правила</span></label><label class="staff-permission-option"><input type="checkbox" name="approve" ${grant.approve === true ? 'checked' : ''}><span>Согласовывать запросы</span></label><label class="staff-permission-option"><input type="checkbox" name="closeSessions" ${grant.closeSessions === true ? 'checked' : ''}><span>Завершать чужие отметки</span></label><button class="button small" type="submit">Сохранить</button></form>`).join('')}</div>`;
    }
    load();
    refreshTimer = window.setInterval(() => { if (document.visibilityState === 'visible') load({ automatic: true }); }, 20000);
    return { refresh: load, openOverview() { if (kind !== 'management') return; if (hasUnsavedInput()) { showDraftGuard(); return; } activeManagementTab = 'overview'; renderManagement(); }, dispose() { disposed = true; if (refreshTimer) window.clearInterval(refreshTimer); pendingKeys.clear(); document.body.classList.remove('attendance-route'); } };
  }

  window.HOOKAH_ATTENDANCE = Object.freeze({
    mountSelf(target, options = {}) { return createView(target, options.api, 'self', options); },
    mountManagement(target, options = {}) { return createView(target, options.api, 'management', options); },
  });
})();
