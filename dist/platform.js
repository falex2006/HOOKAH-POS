(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { companies: [], companiesLoaded: false, loadError: null, health: 'checking', owners: [], ownerEditing: null };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const api = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) { location.href = '/login?next=/platform'; throw new Error('Требуется войти в систему.'); }
    if (response.status === 403) throw new Error('Доступ только владельцу платформы.');
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  };
  const ownerApi = (orgId, ownerId, method, payload) => api(`/api/platform/organizations/${encodeURIComponent(orgId)}/owners${ownerId ? `/${encodeURIComponent(ownerId)}` : ''}`, { method, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const planLabel = (value) => ({ starter: 'Starter', growth: 'Growth', network: 'Network', enterprise: 'Enterprise' }[value] || value || 'Starter');
  const statusLabel = (item) => ({ trialing: 'Пробный период', active: 'Активна', past_due: 'Требует внимания', cancelled: 'Приостановлена' }[item.status] || (item.isActive === false ? 'Приостановлена' : 'Активна'));
  const shell = $('.platform-shell');
  const syncPlatformNav = () => {
    const links = Array.from(document.querySelectorAll('.platform-sidebar .portal-nav a'));
    const active = links.find((link) => link.hash === location.hash) || links[0];
    links.forEach((link) => {
      const selected = link === active;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  window.addEventListener('hashchange', syncPlatformNav);
  syncPlatformNav();
  const denied = () => {
    if (shell) shell.style.display = 'none';
    const main = document.createElement('main'); main.className = 'platform-access-denied';
    const heading = document.createElement('h1'); heading.textContent = 'Нет доступа к панели владельца';
    const message = document.createElement('p'); message.textContent = 'Войти сюда может только владелец платформы.';
    const link = document.createElement('a'); link.href = '/login'; link.textContent = 'Перейти ко входу';
    main.append(heading, message, link); document.body.append(main);
  };
  const verifyRole = async () => {
    try { const session = await api('/api/session'); if (session.user?.role === 'platform_owner') return true; }
    catch (error) { if (error.message.includes('в систему')) throw error; }
    denied(); return false;
  };
  const modal = $('#company-modal'), detailModal = $('#company-detail-modal'), ownerModal = $('#owner-modal');
  const passwordModal = $('#owner-password-modal'), accessModal = $('#owner-access-modal');
  const deleteModal = $('#company-delete-modal'), deleteForm = $('#company-delete-form');
  let loadedDetail = null, detailRequest = 0, deleteTarget = null, deletingCompany = false;
  const ownerForm = $('#owner-form'), passwordForm = $('#owner-password-form');
  let detailOrgId = null, detailLoaded = false, ownerTrigger = null, passwordOwner = null, passwordTrigger = null, accessTrigger = null;
  const setBusy = (button, busy, label) => { if (!button) return; if (busy) { button.dataset.idleLabel = button.textContent; button.disabled = true; button.textContent = label; } else { button.disabled = false; button.textContent = button.dataset.idleLabel || button.textContent; } };
  const modalRoots = [deleteModal, accessModal, passwordModal, ownerModal, detailModal, modal];
  const modalOpeners = new WeakMap();
  const setModal = (element, open) => {
    if (open && element.hidden) modalOpeners.set(element, document.activeElement);
    element.hidden = !open;
    const nestedOwnerDialogOpen = [deleteModal, ownerModal, passwordModal, accessModal].some((item) => item && !item.hidden);
    detailModal.inert = nestedOwnerDialogOpen;
    if (nestedOwnerDialogOpen) detailModal.setAttribute('aria-hidden', 'true'); else detailModal.removeAttribute('aria-hidden');
    const anyModalOpen = modalRoots.some((item) => item && !item.hidden);
    if (shell) {
      shell.inert = anyModalOpen;
      if (anyModalOpen) shell.setAttribute('aria-hidden', 'true'); else shell.removeAttribute('aria-hidden');
    }
    document.body.classList.toggle('modal-open', anyModalOpen);
    if (open) element.querySelector('input,select,button')?.focus();
    else {
      const opener = modalOpeners.get(element);
      modalOpeners.delete(element);
      if (opener?.isConnected && !opener.disabled) opener.focus();
    }
  };
  const activeModal = () => modalRoots.find((item) => item && !item.hidden);
  const renderPlans = (payload) => { const plans = payload.plans || {}; $('#plan-cards').innerHTML = Object.entries(plans).map(([key, plan]) => `<article class="plan-card"><div class="plan-card-top"><b>${escapeHtml(plan.name || planLabel(key))}</b><span>${Number(plan.monthlyPrice || 0)} ₽/мес</span></div><p>${escapeHtml(plan.description || '')}</p><div class="plan-limits"><span>${plan.seatsLimit >= 9999 ? 'Безлимит' : Number(plan.seatsLimit)} мест</span><span>${plan.venuesLimit >= 9999 ? 'Безлимит' : Number(plan.venuesLimit)} завед.</span></div></article>`).join(''); };
  const renderKpis = (overview) => { $('#platform-kpis').innerHTML = `<article><span>Всего компаний</span><strong>${Number(overview.companies) || 0}</strong><small>в реестре платформы</small></article><article><span>Активные</span><strong>${Number(overview.activeCompanies) || 0}</strong><small>по данным сервера</small></article><article><span>Пробный период</span><strong>${Number(overview.trials) || 0}</strong><small>в пробном периоде</small></article><article><span>Состояние</span><strong class="${state.health === 'ok' ? 'good-text' : 'bad-text'}">${state.health === 'ok' ? 'Доступен' : 'Нет связи'}</strong><small>проверка API</small></article>`; };
  const renderHealth = () => { const healthy = state.health === 'ok'; $('.platform-header .live-dot').textContent = healthy ? '● API доступен' : '● API недоступен'; $('.platform-header .live-dot').classList.toggle('offline', !healthy); const card = $('#health'); card.querySelector('.status-dot').classList.toggle('good', healthy); card.querySelector('b').textContent = healthy ? 'Платформа Hookah POS доступна' : 'Нет подтверждения доступности платформы'; card.querySelector('p').textContent = healthy ? 'Приложение и база отвечают. Доступ к данным организаций проверяется отдельно.' : 'Не удалось подтвердить доступность приложения и базы. Повторите проверку после восстановления соединения.'; };
  const renderCompanies = () => {
    const query = String($('#company-search').value || '').trim().toLowerCase();
    const items = state.companies.filter((item) => `${item.name} ${item.city} ${item.slug}`.toLowerCase().includes(query));
    const rows = items.map((item) => { const active = item.status ? item.status === 'active' || item.status === 'trialing' : item.isActive !== false; return `<tr><td><div class="company-name"><span class="company-avatar">${escapeHtml((item.name || 'C').slice(0, 1))}</span><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.slug)}</small></div></div></td><td>${escapeHtml(item.city || '—')}</td><td><select class="plan-select" data-org-plan="${escapeHtml(item.id)}" aria-label="Тариф ${escapeHtml(item.name)}"><option value="starter" ${item.plan === 'starter' ? 'selected' : ''}>Starter</option><option value="growth" ${item.plan === 'growth' ? 'selected' : ''}>Growth</option><option value="network" ${item.plan === 'network' ? 'selected' : ''}>Network</option><option value="enterprise" ${item.plan === 'enterprise' ? 'selected' : ''}>Enterprise</option></select></td><td>${Number(item.venues) || 0}</td><td>${Number(item.seats) || 0}</td><td><span class="state-pill ${active ? 'active' : 'paused'}">${escapeHtml(statusLabel(item))}</span></td><td><button class="table-action" data-org-id="${escapeHtml(item.id)}" type="button">Открыть</button></td></tr>`; }).join('');
    const errorRow = state.loadError ? `<tr><td colspan="7" class="empty-state"><span>${escapeHtml(state.loadError)}</span> <button class="table-action" data-retry-load type="button">Повторить</button></td></tr>` : '';
    const emptyRow = !rows && (!state.loadError || state.companiesLoaded) ? `<tr><td colspan="7" class="empty-state">${query ? 'Компании не найдены' : 'Компаний пока нет'}</td></tr>` : '';
    $('#companies-body').innerHTML = `${errorRow}${rows}${emptyRow}`;
  };
  const renderOnboarding = () => { $('.platform-start-card').hidden = !state.companiesLoaded || state.companies.length > 0; };
  const load = async () => {
    state.loadError = null;
    if (state.companiesLoaded) { renderCompanies(); $('#platform-updated').textContent = 'Обновление…'; }
    else $('#companies-body').innerHTML = '<tr><td colspan="7" class="empty-state">Загрузка компаний…</td></tr>';
    try { const [overview, companies, plans, health] = await Promise.all([api('/api/platform/overview'), api('/api/platform/organizations'), api('/api/platform/plans'), api('/api/health')]); state.companies = companies.items || []; state.companiesLoaded = true; state.health = health.status === 'ok' ? 'ok' : 'offline'; renderKpis(overview); renderCompanies(); renderOnboarding(); renderPlans(plans); renderHealth(); $('#platform-updated').textContent = `Обновлено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`; }
    catch (error) { if (error.message.includes('в систему')) return; state.loadError = error.message; state.health = 'offline'; renderCompanies(); renderHealth(); $('#platform-updated').textContent = 'Не удалось обновить'; }
  };
  const deletionConfirmed = () => Boolean(deleteTarget && deleteForm.elements.confirmation.value === 'Удалить' && deleteForm.elements.slug.value === deleteTarget.slug && deleteForm.elements.acknowledged.checked);
  const syncDelete = () => { $('#confirm-company-delete').disabled = deletingCompany || !deletionConfirmed(); };
  const closeDelete = () => { if (deletingCompany) return; setModal(deleteModal, false); deleteTarget = null; deleteForm.reset(); };
  $('#delete-company').addEventListener('click', () => {
    if (!detailLoaded || !loadedDetail || loadedDetail.id !== detailOrgId) return;
    deleteTarget = { ...loadedDetail };
    deleteForm.reset();
    $('#company-delete-target').textContent = `${deleteTarget.name} · ${deleteTarget.slug}`;
    $('#company-delete-error').textContent = '';
    syncDelete();
    setModal(deleteModal, true);
    deleteForm.elements.confirmation.focus();
  });
  deleteForm.addEventListener('input', syncDelete);
  deleteForm.addEventListener('change', syncDelete);
  deleteModal.querySelectorAll('[data-close-company-delete]').forEach((button) => button.addEventListener('click', closeDelete));
  deleteModal.addEventListener('click', (event) => { if (event.target === deleteModal) closeDelete(); });
  deleteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (deletingCompany || !deletionConfirmed()) return;
    const target = { ...deleteTarget };
    if (!confirm(`Окончательно удалить компанию «${target.name}» (${target.slug})? Это действие нельзя отменить.`)) return;
    deletingCompany = true;
    $('#company-delete-error').textContent = '';
    deleteForm.setAttribute('aria-busy', 'true');
    deleteModal.querySelectorAll('input,button').forEach((element) => { element.disabled = true; });
    let deleted = false;
    try {
      await api(`/api/platform/organizations/${encodeURIComponent(target.id)}`, { method: 'DELETE', body: JSON.stringify({ confirmation: 'Удалить', slug: target.slug, acknowledged: true }) });
      deleted = true;
    } catch (error) {
      $('#company-delete-error').textContent = ({ organization_not_empty: 'В компании уже есть данные. Удаление запрещено. Закройте это окно и установите статус «Приостановлена» в карточке компании.', organization_not_found: 'Компания уже удалена или недоступна. Закройте окно и обновите данные.', organization_delete_confirmation_required: 'Подтверждение не совпало. Проверьте слово и адрес компании.', organization_delete_requires_database: 'Удаление доступно только при подключённой базе данных.', organization_delete_failed: 'Сервер не смог удалить компанию. Попробуйте снова.' }[error.message] || `Не удалось удалить компанию: ${error.message}`);
    } finally {
      deletingCompany = false;
      deleteForm.removeAttribute('aria-busy');
      deleteModal.querySelectorAll('input,button').forEach((element) => { element.disabled = false; });
      syncDelete();
    }
    if (deleted) {
      closeDelete();
      setModal(detailModal, false);
      loadedDetail = null; detailLoaded = false;
      state.companies = state.companies.filter((item) => String(item.id) !== String(target.id));
      renderCompanies();
      $('#company-search').focus();
      await load();
    }
  });
  $('#settings-create-company').addEventListener('click', () => setModal(modal, true));
  $('#settings-refresh').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, 'Обновление…');
    await load();
    $('#settings-result').textContent = state.loadError ? `Не удалось обновить: ${state.loadError}` : 'Данные и состояние платформы обновлены.';
    setBusy(button, false);
  });
  const closeOwner = () => { setModal(ownerModal, false); ownerForm.reset(); $('#owner-form-error').textContent = ''; state.ownerEditing = null; ownerTrigger?.focus(); };
  const openOwner = (owner = null) => { state.ownerEditing = owner; ownerForm.reset(); $('#owner-form-error').textContent = ''; $('#owner-modal-title').textContent = owner ? 'Изменить владельца' : 'Добавить владельца'; ownerForm.elements.name.value = owner?.name || ''; ownerForm.elements.login.value = owner?.login || ''; const passwordLabel = ownerForm.elements.password.closest('label'); passwordLabel.style.display = owner ? 'none' : 'grid'; ownerForm.elements.password.required = !owner; ownerForm.elements.password.value = ''; setModal(ownerModal, true); };
  const closePassword = () => { setModal(passwordModal, false); passwordForm.reset(); $('#owner-password-error').textContent = ''; passwordOwner = null; passwordTrigger?.focus(); };
  const showAccess = (token, trigger) => { accessTrigger = trigger; $('#owner-access-error').textContent = ''; $('#owner-access-link').value = `${location.origin}/login#reset=${encodeURIComponent(token)}`; setModal(accessModal, true); $('#owner-access-link').select(); };
  const closeAccess = () => { setModal(accessModal, false); $('#owner-access-link').value = ''; $('#owner-access-error').textContent = ''; accessTrigger?.focus(); };
  const refreshOwners = async () => { const fresh = await api('/api/platform/organizations'); state.companies = fresh.items || state.companies; state.owners = state.companies.find((entry) => String(entry.id) === String(detailOrgId))?.owners || []; renderCompanies(); renderOwners(); };
  const ownerErrorText = (error) => ({ owner_login_already_exists: 'Эта рабочая почта уже используется.', valid_owner_credentials_required: 'Заполните имя, рабочую почту и пароль не короче 8 символов.', valid_owner_email_required: 'Введите корректную рабочую почту.', password_too_short: 'Пароль должен содержать не менее 8 символов.', organization_venue_required: 'Сначала добавьте заведение организации.', organization_not_found: 'Организация больше не доступна. Обновите список.', owner_id_required: 'Не удалось определить владельца. Обновите список и повторите действие.', owner_not_found: 'Владелец больше не доступен. Обновите список.', owner_create_failed: 'Не удалось создать владельца. Проверьте данные и повторите попытку.', owner_transfer_failed: 'Не удалось передать статус главного владельца. Повторите попытку.', transfer_primary_owner_first: 'Сначала назначьте другого главного владельца.', primary_owner_must_be_transferred_first: 'Сначала передайте статус главного владельца.', inactive_owner_cannot_be_primary: 'Разблокируйте владельца перед назначением главным.', owner_management_requires_database: 'Управление доступом временно недоступно: база данных не подключена.', owner_management_failed: 'Сервер не смог сохранить изменение. Попробуйте снова.' }[error.message] || error.message || 'Неизвестная ошибка. Повторите попытку.');
  const refreshOwnersSafely = async () => { try { await refreshOwners(); } catch (error) { $('#owner-management-error').textContent = `Изменение сохранено, но список не обновился: ${ownerErrorText(error)}`; } };
  const renderOwners = () => {
    const root = $('#company-detail-owner');
    if (!state.owners.length) { root.innerHTML = '<p class="muted">У организации пока нет владельцев.</p>'; return; }
    root.innerHTML = state.owners.map((owner) => {
      const active = owner.active !== false && owner.isActive !== false;
      const status = `${owner.isPrimary ? 'Главный владелец · ' : 'Совладелец · '}${active ? 'Активен' : 'Заблокирован'}`;
      return `<article class="owner-row"><div class="owner-main"><strong>${escapeHtml(owner.name || 'Без имени')}</strong><span>${escapeHtml(owner.login || '')}</span></div><span class="owner-status ${active ? 'is-active' : 'is-blocked'}">${escapeHtml(status)}</span><div class="owner-actions"><button class="table-action" type="button" data-owner-edit="${escapeHtml(owner.id)}">Изменить</button><button class="table-action" type="button" data-owner-password="${escapeHtml(owner.id)}">Сменить пароль</button><button class="table-action" type="button" data-owner-reset="${escapeHtml(owner.id)}">Выдать ссылку</button><button class="table-action" type="button" data-owner-toggle="${escapeHtml(owner.id)}">${active ? 'Заблокировать' : 'Разблокировать'}</button>${!owner.isPrimary ? `<button class="table-action" type="button" data-owner-primary="${escapeHtml(owner.id)}">Назначить главным</button><button class="table-action" type="button" data-owner-delete="${escapeHtml(owner.id)}">Удалить совладельца</button>` : ''}</div></article>`;
    }).join('');
  };
  const openDetail = async (orgId) => { const request = ++detailRequest; loadedDetail = null; $('#delete-company').disabled = true; detailOrgId = orgId; detailLoaded = false; $('#company-detail-error').textContent = ''; $('#owner-management-error').textContent = ''; setModal(detailModal, true); $('#save-company-detail').disabled = true; $('#company-detail-meta').textContent = 'Загрузка…'; $('#company-detail-owner').textContent = 'Загрузка владельцев…';
    try { const item = await api(`/api/platform/organizations/${encodeURIComponent(orgId)}`); if (request !== detailRequest) return; loadedDetail = { id: orgId, name: item.name, slug: item.slug }; $('#delete-company').disabled = false; detailLoaded = true; $('#company-detail-title').textContent = item.name; $('#company-detail-meta').textContent = `${item.slug} · ${item.city || 'Город не указан'} · ${Number(item.venues) || 0} заведений · ${Number(item.seats) || 0} мест`; $('#company-detail-plan').value = item.plan || 'starter'; $('#company-detail-status').value = item.status || (item.isActive === false ? 'cancelled' : 'active'); state.owners = item.owners || []; renderOwners(); $('#save-company-detail').disabled = false; }
    catch (error) { if (request !== detailRequest) return; $('#company-detail-error').textContent = `Не удалось загрузить компанию: ${error.message}`; $('#company-detail-owner').textContent = 'Список владельцев недоступен.'; }
  };
  $('#open-company').addEventListener('click', () => setModal(modal, true)); $('#start-create-company').addEventListener('click', () => setModal(modal, true)); $('#close-company').addEventListener('click', () => setModal(modal, false)); $('#cancel-company').addEventListener('click', () => setModal(modal, false));
  $('#company-search').addEventListener('input', renderCompanies);
  $('#companies-body').addEventListener('click', async (event) => {
    const retryButton = event.target.closest('[data-retry-load]');
    if (retryButton) { retryButton.disabled = true; retryButton.textContent = 'Загрузка…'; await load(); return; }
    const button = event.target.closest('[data-org-id]'); if (button) openDetail(button.dataset.orgId);
  });
  $('#companies-body').addEventListener('change', async (event) => { const select = event.target.closest('[data-org-plan]'); if (!select) return; const old = state.companies.find((item) => String(item.id) === select.dataset.orgPlan)?.plan; select.disabled = true; try { await api(`/api/platform/organizations/${encodeURIComponent(select.dataset.orgPlan)}/subscription`, { method: 'PATCH', body: JSON.stringify({ plan: select.value }) }); await load(); } catch (error) { select.value = old || 'starter'; alert(`Не удалось изменить тариф: ${error.message}`); } finally { select.disabled = false; } });
  $('#add-owner').addEventListener('click', () => { ownerTrigger = document.activeElement; openOwner(); });
  $('#close-owner').addEventListener('click', closeOwner); $('#cancel-owner').addEventListener('click', closeOwner);
  $('#company-detail-owner').addEventListener('click', async (event) => {
    const button = event.target.closest('button'); if (!button || !detailOrgId || button.disabled) return;
    const id = Object.values(button.dataset).find(Boolean); const owner = state.owners.find((entry) => String(entry.id) === String(id)); if (!owner) return;
    const managementError = $('#owner-management-error'); managementError.textContent = '';
    button.disabled = true;
    try {
      if (button.dataset.ownerEdit) { ownerTrigger = button; openOwner(owner); }
      else if (button.dataset.ownerReset) { if (!confirm('Создать новую одноразовую ссылку? Предыдущая ссылка перестанет работать.')) return; const result = await api(`/api/platform/organizations/${encodeURIComponent(detailOrgId)}/owners/${encodeURIComponent(owner.id)}/reset`, { method: 'POST' }); showAccess(result.resetToken, button); }
      else if (button.dataset.ownerPassword) { passwordTrigger = button; passwordOwner = owner; passwordForm.reset(); $('#owner-password-error').textContent = ''; setModal(passwordModal, true); }
      else if (button.dataset.ownerToggle) { if (!confirm(`${owner.active === false || owner.isActive === false ? 'Разблокировать' : 'Заблокировать'} доступ этого владельца?`)) return; await ownerApi(detailOrgId, owner.id, 'PATCH', { active: owner.active === false || owner.isActive === false }); await refreshOwnersSafely(); }
      else if (button.dataset.ownerDelete) { if (!confirm('Удалить доступ этого совладельца?')) return; await ownerApi(detailOrgId, owner.id, 'DELETE'); await refreshOwnersSafely(); }
      else if (button.dataset.ownerPrimary) { if (!confirm('Передать статус главного владельца?')) return; await ownerApi(detailOrgId, owner.id, 'PATCH', { isPrimary: true }); await refreshOwnersSafely(); }
    } catch (error) { managementError.textContent = `Не удалось выполнить действие: ${ownerErrorText(error)}`; }
    finally { button.disabled = false; }
  });
  ownerForm.addEventListener('submit', async (event) => { event.preventDefault(); if (!detailOrgId || ownerForm.dataset.submitting === 'true') return; const submit = ownerForm.querySelector('[type="submit"]'); const data = Object.fromEntries(new FormData(ownerForm).entries()); const payload = { name: data.name, login: data.login }; if (data.password) payload.password = data.password; $('#owner-form-error').textContent = ''; ownerForm.dataset.submitting = 'true'; ownerForm.setAttribute('aria-busy', 'true'); setBusy(submit, true, 'Сохранение…'); try { await ownerApi(detailOrgId, state.ownerEditing?.id, state.ownerEditing ? 'PATCH' : 'POST', payload); closeOwner(); await refreshOwnersSafely(); } catch (error) { $('#owner-form-error').textContent = `Не удалось сохранить владельца: ${ownerErrorText(error)}`; } finally { ownerForm.dataset.submitting = 'false'; ownerForm.removeAttribute('aria-busy'); setBusy(submit, false); } });
  passwordForm.addEventListener('submit', async (event) => { event.preventDefault(); const password = passwordForm.elements.password.value; if (password !== passwordForm.elements.passwordConfirm.value) { $('#owner-password-error').textContent = 'Пароли не совпадают.'; return; } if (!passwordOwner) return; const submit = passwordForm.querySelector('[type="submit"]'); setBusy(submit, true, 'Сохранение…'); $('#owner-password-error').textContent = ''; let saved = false; try { await ownerApi(detailOrgId, passwordOwner.id, 'PATCH', { password }); saved = true; } catch (error) { $('#owner-password-error').textContent = `Не удалось изменить пароль: ${ownerErrorText(error)}`; } finally { setBusy(submit, false); } if (saved) { closePassword(); await refreshOwnersSafely(); } });
  $('[data-close-owner-password]').addEventListener('click', closePassword); $('[data-cancel-owner-password]').addEventListener('click', closePassword);
  document.querySelectorAll('[data-close-owner-access]').forEach((button) => button.addEventListener('click', closeAccess));
  $('#copy-owner-access-link').addEventListener('click', async (event) => { const button = event.currentTarget; const input = $('#owner-access-link'); try { await navigator.clipboard.writeText(input.value); button.textContent = 'Ссылка скопирована'; setTimeout(() => { button.textContent = 'Скопировать ссылку'; }, 1800); } catch { input.focus(); input.select(); $('#owner-access-error').textContent = 'Автокопирование недоступно. Выделите ссылку и скопируйте её вручную.'; } });
  $('#company-detail-modal').addEventListener('click', (event) => { if (event.target === detailModal) setModal(detailModal, false); });
  $('#close-company-detail').addEventListener('click', () => setModal(detailModal, false)); $('#cancel-company-detail').addEventListener('click', () => setModal(detailModal, false));
  $('#save-company-detail').addEventListener('click', async (event) => { if (!detailOrgId || !detailLoaded) return; const button = event.currentTarget; $('#company-detail-error').textContent = ''; setBusy(button, true, 'Сохранение…'); try { await api(`/api/platform/organizations/${encodeURIComponent(detailOrgId)}/subscription`, { method: 'PATCH', body: JSON.stringify({ plan: $('#company-detail-plan').value, status: $('#company-detail-status').value }) }); setModal(detailModal, false); await load(); } catch (error) { $('#company-detail-error').textContent = `Не удалось сохранить изменения: ${error.message}`; } finally { if (!detailModal.hidden) { button.disabled = !detailLoaded; button.textContent = button.dataset.idleLabel || 'Сохранить'; } } });
  document.addEventListener('keydown', (event) => {
    const currentModal = activeModal();
    if (event.key === 'Escape') {
      if (!currentModal) return;
      if (currentModal === deleteModal) { event.preventDefault(); closeDelete(); return; }
      if (currentModal === accessModal) closeAccess(); else if (currentModal === passwordModal) closePassword(); else if (currentModal === ownerModal) closeOwner(); else setModal(currentModal, false);
      return;
    }
    if (event.key !== 'Tab' || !currentModal) return;
    const focusable = Array.from(currentModal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter((item) => !item.hidden && item.getAttribute('aria-hidden') !== 'true' && item.getClientRects().length);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !currentModal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !currentModal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  $('#platform-logout').addEventListener('click', async (event) => { const button = event.currentTarget; setBusy(button, true, 'Выход…'); try { await api('/api/logout', { method: 'POST' }); location.href = '/login'; } catch (error) { alert(`Не удалось выйти: ${error.message}`); setBusy(button, false); } });
  $('#organization-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; if (formElement.dataset.submitting === 'true') return; const submit = formElement.querySelector('[type=submit]'); const payload = Object.fromEntries(new FormData(formElement).entries()); const error = $('#company-error'); error.textContent = ''; formElement.dataset.submitting = 'true'; formElement.setAttribute('aria-busy', 'true'); setBusy(submit, true, 'Создание…'); try { await api('/api/platform/organizations', { method: 'POST', body: JSON.stringify(payload) }); setModal(modal, false); formElement.reset(); await load(); } catch (failure) { error.textContent = failure.message === 'slug_or_owner_login_already_exists' ? 'Такой адрес компании или почта владельца уже заняты.' : failure.message === 'valid_owner_credentials_required' ? 'Проверьте имя, рабочую почту и пароль владельца.' : failure.message === 'invalid_organization_timezone' ? 'Не удалось определить часовой пояс.' : `Не удалось создать компанию: ${failure.message}`; } finally { formElement.dataset.submitting = 'false'; formElement.removeAttribute('aria-busy'); setBusy(submit, false); } });
  (async () => { if (await verifyRole()) await load(); })();
})();
