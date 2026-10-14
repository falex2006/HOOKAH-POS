/* Isolated planning workspace: proposals never mutate the live calendar before publication. */
(() => {
  window.openSchedulePlanning = async ({ api: request, dialog, employees, access, date, local, instant, refresh }) => {
    const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const labels={shift:'Смена',day_off:'Выходной',vacation:'Отпуск',sick:'Больничный',other_absence:'Отсутствие'};
    const states={open:'Черновик',published:'Опубликован',discarded:'Закрыт без публикации'};
    const errors={draft_base_changed:'Действующий график изменился. Создайте новый черновик на актуальной основе; этот сохранён для сравнения.',draft_version_conflict:'Черновик уже изменён. Закройте окно и откройте актуальную версию.',draft_closed:'Черновик уже закрыт.',planning_conflict:'Есть пересечения или недоступные сотрудники. Исправьте предложения и повторите проверку.',planning_preview_changed:'Предпросмотр устарел. Выполните проверку ещё раз.',schedule_publish_forbidden:'Владелец не выдал право публикации.',planning_operations_limit:'Допускается не более 200 изменений. Уменьшите период или число сотрудников.',template_version_conflict:'Шаблон изменился. Откройте актуальную версию.',planning_pattern_invalid:'Проверьте дни повторения, дату начала цикла и его длину.',planning_slot_invalid:'Проверьте время, следующий день и перерыв.',planning_scope_invalid:'Дата или сотрудник вне области черновика.',schedule_range_invalid:'Период должен составлять от 1 до 93 дней.',planning_name_invalid:'Укажите название длиной до 120 символов.',planning_users_invalid:'Выберите от 1 до 100 сотрудников.',planning_timezone_changed:'Часовой пояс изменился. Создайте новый черновик.',schedule_past_reason_required:'Для изменения прошлого периода укажите причину.'};
    Object.assign(errors,{schedule_reason_required:'Укажите причину отмены или изменения прошлого периода.',planning_empty:'В черновике нет изменений для публикации.',schedule_copy_time_ambiguous:'При повторении встретилось неоднозначное или несуществующее местное время из-за перевода часов. Измените время или период.',schedule_overlap:'Пересекающиеся смены или отсутствие',schedule_employee_unavailable:'Сотрудник недоступен для назначения'});
    const api=async(...args)=>{try{return await request(...args);}catch(error){error.message=errors[error.code]||error.message;throw error;}};
    const name=id=>employees.find(p=>p.id===id)?.name||'Сотрудник недоступен';
    const summary=p=>`${name(p.userId)} · ${p.workDate} · ${labels[p.kind]||p.kind}${p.plannedStart&&p.plannedEnd?` · ${local(p.plannedStart,access.timezone).replace('T',' ')} — ${local(p.plannedEnd,access.timezone).replace('T',' ')} · перерыв ${p.breakMinutes||0} мин`:''}`;
    const checkboxUsers=(ids=[])=>`<fieldset class="planning-users"><legend>Сотрудники</legend>${employees.filter(p=>p.active||ids.includes(p.id)).map(p=>`<label class="schedule-check"><input type="checkbox" name="person" value="${esc(p.id)}" ${ids.includes(p.id)?'checked':''}>${esc(p.name)}${!p.active?' · неактивен':''}</label>`).join('')}</fieldset>`;
    const users=form=>[...form.querySelectorAll('[name=person]:checked')].map(el=>el.value);
    const plainDialog=(title,html)=>{const d=dialog(title,html);d.node.classList.add('planning-dialog');d.node.querySelector('[type=submit]').remove();d.node.querySelector('form').onsubmit=e=>e.preventDefault();return d;};
    function submit(d, action) {
      const form=d.node.querySelector('form');let key=crypto.randomUUID();
      form.addEventListener('input',()=>{key=crypto.randomUUID();});form.addEventListener('change',()=>{key=crypto.randomUUID();});
      form.onsubmit=async e=>{e.preventDefault();const data=new FormData(form);d.pending(true);try{await action(form,data,key);d.error('');}catch(error){d.error(error.message);}finally{d.pending(false);}};
    }
    let home;
    async function reloadHome(){
      if(!home?.node.isConnected)return;
      home.pending(true);
      try{
        const result=await api('/drafts');if(!home.node.isConnected)return;
        home.node.querySelector('[data-drafts]').innerHTML=result.items.map(d=>`<button type="button" class="planning-list-item" data-draft="${esc(d.id)}"><strong>${esc(d.name)}</strong><span>${esc(d.from)} — ${esc(d.to)} · ${esc(states[d.state])}</span><small>${d.operations.length} изменений · версия ${d.version}</small></button>`).join('')||'<p>Черновиков пока нет. Создайте план на выбранный период.</p>';
        home.node.querySelectorAll('[data-draft]').forEach(b=>b.onclick=()=>openDraft(b.dataset.draft));
      }catch(error){home.error(error.message);}finally{home.pending(false);}
    }
    function createDraft(){
      const d=dialog('Новый черновик',`<p>Действующий график останется прежним до публикации. Выберите период и сотрудников; после создания область фиксируется.</p><label>Название<input name="name" maxlength="120" required placeholder="Например: следующая неделя"></label><label>С<input name="from" type="date" value="${date}" required></label><label>По<input name="to" type="date" value="${date}" required></label>${checkboxUsers()}`);d.guard();
      submit(d,async(form,data,key)=>{const saved=await api('/drafts','POST',{name:data.get('name'),from:data.get('from'),to:data.get('to'),userIds:users(form),requestKey:key});d.node.close();await reloadHome();await openDraft(saved.id);});
    }
    async function openDraft(id){
      try{
        let draft=await api(`/drafts/${id}`);
        const d=plainDialog(draft.name,'<div data-draft-content></div>');
        const area=d.node.querySelector('[data-draft-content]');
        async function reload(){
          try{draft=await api(`/drafts/${id}`);if(d.node.isConnected){draw();d.error('');}await reloadHome();}
          catch(error){if(!d.node.isConnected)return;area.replaceChildren();d.error('Изменение сохранено, но обновить черновик не удалось. '+error.message);const retry=document.createElement('button');retry.type='button';retry.className='button';retry.dataset.draftRetry='';retry.textContent='Повторить загрузку черновика';retry.onclick=async()=>{d.pending(true);try{await reload();}finally{d.pending(false);}};area.append(retry);}
        }
        function draw(){
          const editable=draft.state==='open';
          area.innerHTML=`<p><strong>${esc(states[draft.state])}</strong> · ${esc(draft.from)} — ${esc(draft.to)} · версия ${draft.version}</p><p class="muted">Изменения ниже — предложения. Неизменённые смены сохраняются. До публикации расчёты используют действующий график.</p>${editable?'<div class="schedule-toolbar"><button type="button" class="button" data-new-op>Добавить смену / отсутствие</button><button type="button" class="button" data-range>Заполнить период</button></div>':''}<h3>Предлагаемые изменения (${draft.operations.length})</h3><div class="planning-operations">${draft.operations.map((op,i)=>`<article><strong>${esc({create:'Добавить',update:'Изменить',cancel:'Отменить'}[op.operation])}</strong><p>${esc(summary(op.payload||draft.baseItems.find(b=>b.id===op.sourceId)||{}))}</p>${op.reason?`<small>${esc(op.reason)}</small>`:''}${editable?`<div class="schedule-toolbar">${op.operation!=='cancel'?`<button type="button" class="button" data-edit-op="${i}">Изменить</button>`:''}<button type="button" class="button" data-remove-op="${i}">Убрать предложение</button></div>`:''}</article>`).join('')||'<p>Изменений ещё нет.</p>'}</div><details><summary>Действующий график при создании (${draft.baseItems.length})</summary>${draft.baseItems.map(p=>`<article><p>${esc(summary(p))}${p.status==='cancelled'?' · отменена':''}</p>${editable&&p.status==='planned'?`<button type="button" class="button" data-edit-base="${esc(p.id)}">Предложить изменение</button><button type="button" class="button" data-cancel-base="${esc(p.id)}">Предложить отмену</button>`:''}</article>`).join('')||'<p>В выбранном периоде нет записей.</p>'}</details>${editable?`<div class="schedule-toolbar planning-footer"><button type="button" class="button primary" data-publish-preview>Проверить перед публикацией</button><button type="button" class="button" data-discard>Закрыть без публикации</button></div>${!draft.capabilities.canPublish?'<p>Публикация доступна владельцу или сотруднику с отдельно выданным правом.</p>':''}`:''}`;
          area.querySelector('[data-new-op]')?.addEventListener('click',()=>editOperation(draft,null,null,reload));
          area.querySelector('[data-range]')?.addEventListener('click',()=>rangeEditor(draft,reload));
          area.querySelectorAll('[data-edit-op]').forEach(b=>b.onclick=()=>editOperation(draft,draft.operations[Number(b.dataset.editOp)],Number(b.dataset.editOp),reload));
          area.querySelectorAll('[data-remove-op]').forEach(b=>b.onclick=async()=>{if(!window.confirm('Убрать это предложение из черновика? Действующий график не изменится.'))return;d.pending(true);try{await api(`/drafts/${id}`,'PATCH',{version:draft.version,requestKey:crypto.randomUUID(),operations:draft.operations.filter((_,i)=>i!==Number(b.dataset.removeOp))});await reload();}catch(error){d.error(error.message);}finally{d.pending(false);}});
          area.querySelectorAll('[data-edit-base]').forEach(b=>b.onclick=()=>{const p=draft.baseItems.find(p=>p.id===b.dataset.editBase),i=draft.operations.findIndex(o=>o.sourceId===p.id);editOperation(draft,i>=0?draft.operations[i]:{operation:'update',sourceId:p.id,sourceVersion:p.version,payload:p},i>=0?i:null,reload);});
          area.querySelectorAll('[data-cancel-base]').forEach(b=>b.onclick=()=>cancelOperation(draft,b.dataset.cancelBase,reload));
          area.querySelector('[data-publish-preview]')?.addEventListener('click',()=>publishEditor(draft,async()=>{await reload();await refresh();}));
          area.querySelector('[data-discard]')?.addEventListener('click',async()=>{if(!window.confirm('Закрыть черновик без публикации? Предложения сохранятся в истории.'))return;d.pending(true);try{await api(`/drafts/${id}/discard`,'POST',{version:draft.version,requestKey:crypto.randomUUID()});await reload();}catch(error){d.error(error.message);}finally{d.pending(false);}});
        }
        draw();
      }catch(error){home.error(error.message);}
    }
    function editOperation(draft,op,index,done){
      const p=op?.payload||(op?.sourceId?draft.baseItems.find(item=>item.id===op.sourceId):null)||{}, day=p.workDate||draft.from;
      const d=dialog('Предложение для черновика',`<label>Сотрудник<select name="userId">${draft.userIds.map(id=>`<option value="${esc(id)}" ${p.userId===id?'selected':''}>${esc(name(id))}</option>`).join('')}</select></label><label>Тип<select name="kind">${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${p.kind===key?'selected':''}>${label}</option>`).join('')}</select></label><label>Дата<input type="date" name="workDate" value="${day}" min="${draft.from}" max="${draft.to}" required></label><fieldset data-times><legend>Местное время заведения</legend><label>Начало<input type="datetime-local" name="start" value="${p.plannedStart?local(p.plannedStart,draft.timezone):day+'T10:00'}"></label><label>Окончание<input type="datetime-local" name="end" value="${p.plannedEnd?local(p.plannedEnd,draft.timezone):day+'T18:00'}"></label><label>Неоплачиваемый перерыв, мин<input type="number" name="breakMinutes" min="0" step="1" value="${p.breakMinutes||0}"></label></fieldset><label>Заметка<textarea name="note" maxlength="500">${esc(p.note)}</textarea></label><label>Причина изменения<textarea name="reason" maxlength="500">${esc(op?.reason)}</textarea></label>`);d.guard();
      const form=d.node.querySelector('form');const sync=()=>{d.node.querySelector('[data-times]').hidden=form.elements.kind.value!=='shift';};form.elements.kind.onchange=sync;sync();
      submit(d,async(form,data,key)=>{const shift=data.get('kind')==='shift',next={operation:op?.sourceId?'update':'create',reason:data.get('reason'),payload:{userId:data.get('userId'),workDate:data.get('workDate'),kind:data.get('kind'),note:data.get('note'),breakMinutes:shift?Number(data.get('breakMinutes')):0,plannedStart:shift?instant(data.get('start'),draft.timezone):null,plannedEnd:shift?instant(data.get('end'),draft.timezone):null}};
        if(op?.sourceId){next.sourceId=op.sourceId;next.sourceVersion=op.sourceVersion;}
        const operations=[...draft.operations];if(index===null)operations.push(next);else operations[index]=next;
        await api(`/drafts/${draft.id}`,'PATCH',{version:draft.version,operations,requestKey:key});d.node.close();await done();});
    }
    function cancelOperation(draft,id,done){
      const p=draft.baseItems.find(p=>p.id===id),d=dialog('Предложить отмену',`<p>${esc(summary(p))}</p><label>Причина отмены<textarea name="reason" required maxlength="500"></textarea></label>`);d.guard();
      submit(d,async(form,data,key)=>{const operations=draft.operations.filter(o=>o.sourceId!==id);operations.push({operation:'cancel',sourceId:id,sourceVersion:p.version,reason:data.get('reason')});await api(`/drafts/${draft.id}`,'PATCH',{version:draft.version,operations,requestKey:key});d.node.close();await done();});
    }
    function conflictsText(conflicts){return conflicts.map(c=>typeof c==='string'?(errors[c]||c):`${errors[c.code]||c.code||'Конфликт'}${c.userId?' · '+name(c.userId):''}${c.workDate?' · '+c.workDate:''}`).join('; ');}
    async function publishEditor(draft,done){
      try{
        const preview=await api(`/drafts/${draft.id}/publish-preview`,'POST',{version:draft.version});
        const d=dialog('Проверка публикации',`<p>Будет применено изменений: ${preview.operations.length}. Неизменённые записи останутся прежними.</p><div class="planning-operations">${preview.operations.map(op=>`<p>${esc({create:'Добавить',update:'Изменить',cancel:'Отменить'}[op.operation])}: ${esc(summary(op.payload||draft.baseItems.find(b=>b.id===op.sourceId)||{}))}</p>`).join('')}</div><p>${preview.conflicts.length?esc(conflictsText(preview.conflicts)):'Пересечений при проверке не найдено. Перед сохранением сервер проверит всё повторно.'}</p><label>Причина публикации (обязательна для прошлого периода)<textarea name="reason" maxlength="500"></textarea></label>`);
        const button=d.node.querySelector('[type=submit]');button.textContent='Опубликовать график';
        if(!preview.canPublish||preview.conflicts.length||!preview.operations.length){button.remove();d.node.querySelector('form').onsubmit=e=>e.preventDefault();d.error(!preview.canPublish?'Нет права публикации. Владелец может выдать его отдельно.':preview.conflicts.length?'Сначала устраните конфликты.':'Нет изменений для публикации.');return;}
        submit(d,async(form,data,key)=>{await api(`/drafts/${draft.id}/publish`,'POST',{version:draft.version,fingerprint:preview.fingerprint,reason:data.get('reason'),requestKey:key});d.node.close();await done();});
      }catch(error){home.error(error.message);window.alert(error.message);}
    }
    const defaultDefinition=()=>({pattern:{type:'weekdays',weekdays:[1,2,3,4,5]},slots:[{kind:'shift',startTime:'10:00',endTime:'18:00',endDayOffset:0,breakMinutes:0,note:''}]});
    function patternFields(def=defaultDefinition()){
      const p=def.pattern;
      return `<label>Повторение<select name="patternType"><option value="weekdays" ${p.type==='weekdays'?'selected':''}>По дням недели</option><option value="cycle" ${p.type==='cycle'?'selected':''}>Цикл (например 2/2)</option></select></label><fieldset data-weekdays><legend>Дни недели</legend>${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map((n,i)=>`<label class="schedule-check"><input type="checkbox" name="weekday" value="${i+1}" ${(p.weekdays||[]).includes(i+1)?'checked':''}>${n}</label>`).join('')}</fieldset><fieldset data-cycle><legend>Дни цикла</legend><label>Первый день цикла<input type="date" name="anchorDate" value="${p.anchorDate||date}"></label><label>Длительность цикла, дней<input type="number" name="cycleDays" min="1" max="93" value="${p.cycleDays||4}"></label><label>Рабочие дни цикла через запятую<input name="dayOffsets" value="${(p.dayOffsets||[0,1]).map(n=>n+1).join(', ')}"></label><small>Для 2/2: цикл 4 дня, рабочие дни 1, 2. Неуказанные дни остаются незапланированными.</small></fieldset><div data-slots>${def.slots.map(slotFields).join('')}</div><button type="button" class="button" data-add-slot>Добавить интервал / отсутствие в день</button>`;
    }
    function slotFields(s){return `<fieldset data-slot><legend>Интервал</legend><label>Тип<select data-slot-kind>${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${s.kind===key?'selected':''}>${label}</option>`).join('')}</select></label><div data-slot-time><label>С<input type="time" data-slot-start value="${s.startTime||'10:00'}"></label><label>До<input type="time" data-slot-end value="${s.endTime||'18:00'}"></label><label>Окончание<select data-slot-offset><option value="0">В тот же день</option><option value="1" ${s.endDayOffset===1?'selected':''}>На следующий день</option></select></label><label>Неоплачиваемый перерыв, мин<input type="number" min="0" step="1" data-slot-break value="${s.breakMinutes||0}"></label></div><label>Заметка<textarea data-slot-note maxlength="500">${esc(s.note)}</textarea></label><button type="button" class="button" data-remove-slot>Убрать интервал</button></fieldset>`;}
    function bindPattern(form){
      const sync=()=>{form.querySelector('[data-weekdays]').hidden=form.elements.patternType.value!=='weekdays';form.querySelector('[data-cycle]').hidden=form.elements.patternType.value!=='cycle';form.querySelectorAll('[data-slot]').forEach(s=>{s.querySelector('[data-slot-time]').hidden=s.querySelector('[data-slot-kind]').value!=='shift';s.querySelector('[data-slot-kind]').onchange=sync;s.querySelector('[data-remove-slot]').onclick=()=>{s.remove();form.dispatchEvent(new Event('input',{bubbles:true}));};});};
      form.elements.patternType.onchange=sync;form.querySelector('[data-add-slot]').onclick=()=>{form.querySelector('[data-slots]').insertAdjacentHTML('beforeend',slotFields(defaultDefinition().slots[0]));sync();form.dispatchEvent(new Event('input',{bubbles:true}));};sync();
    }
    function readDefinition(form){
      const pattern=form.elements.patternType.value==='weekdays'?{type:'weekdays',weekdays:[...form.querySelectorAll('[name=weekday]:checked')].map(el=>Number(el.value))}:{type:'cycle',anchorDate:form.elements.anchorDate.value,cycleDays:Number(form.elements.cycleDays.value),dayOffsets:form.elements.dayOffsets.value.split(',').map(s=>Number(s.trim())-1)};
      const slots=[...form.querySelectorAll('[data-slot]')].map(s=>{const kind=s.querySelector('[data-slot-kind]').value,note=s.querySelector('[data-slot-note]').value;return kind==='shift'?{kind,note,startTime:s.querySelector('[data-slot-start]').value,endTime:s.querySelector('[data-slot-end]').value,endDayOffset:Number(s.querySelector('[data-slot-offset]').value),breakMinutes:Number(s.querySelector('[data-slot-break]').value)}:{kind,note,breakMinutes:0};});
      return {pattern,slots};
    }
    async function templates(){
      const d=plainDialog('Шаблоны графика','<p>Изменение шаблона не меняет уже составленные графики.</p><button type="button" class="button" data-new-template>Создать шаблон</button><div data-templates></div>');
      async function load(){try{const result=await api('/templates');if(!d.node.isConnected)return;d.node.querySelector('[data-templates]').innerHTML=result.items.map(t=>`<button type="button" class="planning-list-item" data-template="${esc(t.id)}"><strong>${esc(t.name)}</strong><span>Версия ${t.version}${t.archived?' · архив':''} · ${t.definition.slots.length} интервалов</span></button>`).join('')||'<p>Шаблонов пока нет.</p>';d.node.querySelectorAll('[data-template]').forEach(b=>b.onclick=()=>editTemplate(result.items.find(t=>t.id===b.dataset.template),load));}catch(error){d.error(error.message);}}
      d.node.querySelector('[data-new-template]').onclick=()=>editTemplate(null,load);await load();
    }
    function editTemplate(t,done){
      const d=dialog(t?'Изменить шаблон':'Новый шаблон',`<label>Название<input name="name" value="${esc(t?.name)}" required maxlength="120"></label>${patternFields(t?.definition)}${t?`<label class="schedule-check"><input type="checkbox" name="archived" ${t.archived?'checked':''}>В архиве (не доступен для применения)</label>`:''}`);d.guard();bindPattern(d.node.querySelector('form'));
      submit(d,async(form,data,key)=>{const payload={name:data.get('name'),definition:readDefinition(form),requestKey:key};if(t){payload.version=t.version;payload.archived=form.elements.archived.checked;}await api(t?`/templates/${t.id}`:'/templates',t?'PATCH':'POST',payload);d.node.close();await done();});
    }
    async function rangeEditor(draft,done){
      try{
        const templates=(await api('/templates')).items.filter(t=>!t.archived);
        const d=dialog('Заполнить период в черновике',`<p>Добавляет предложения, не заменяя существующие смены. Сначала проверьте результат.</p><label>Шаблон<select name="templateId"><option value="">Настроить вручную</option>${templates.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label><label>С<input type="date" name="from" min="${draft.from}" max="${draft.to}" value="${draft.from}" required></label><label>По<input type="date" name="to" min="${draft.from}" max="${draft.to}" value="${draft.to}" required></label>${checkboxUsers(draft.userIds)}<div data-pattern>${patternFields()}</div><button type="button" class="button" data-range-preview>Предпросмотр</button><div data-range-result></div>`);
        const form=d.node.querySelector('form'),area=form.querySelector('[data-range-result]'),button=form.querySelector('[type=submit]');button.textContent='Добавить в черновик';button.disabled=true;
        form.querySelectorAll('[name=person]').forEach(el=>{if(!draft.userIds.includes(el.value))el.closest('label').remove();});
        bindPattern(form);let preview=null,query=null,key=crypto.randomUUID();
        const invalidate=()=>{preview=null;query=null;button.disabled=true;area.textContent='Обновите предпросмотр.';key=crypto.randomUUID();};
        form.addEventListener('input',invalidate);form.addEventListener('change',invalidate);
        form.elements.templateId.onchange=()=>{form.querySelector('[data-pattern]').hidden=!!form.elements.templateId.value;};
        form.querySelector('[data-range-preview]').onclick=async()=>{
          const t=templates.find(t=>t.id===form.elements.templateId.value);
          query={version:draft.version,from:form.elements.from.value,to:form.elements.to.value,userIds:users(form),...(t?{templateId:t.id,templateVersion:t.version}:{definition:readDefinition(form)})};
          d.pending(true);preview=null;try{preview=await api(`/drafts/${draft.id}/range-preview`,'POST',query);area.innerHTML=`<p>Будет добавлено: ${preview.operations.length}</p>${preview.operations.map(op=>`<p>${esc(summary(op.payload))}</p>`).join('')}<p>${preview.conflicts.length?esc(conflictsText(preview.conflicts)):'Конфликтов не найдено.'}</p>`;d.error('Действующий график не изменён.');}catch(error){d.error(error.message);}finally{d.pending(false);button.disabled=!preview||!!preview.conflicts.length||!preview.operations.length;}
        };
        form.onsubmit=async e=>{e.preventDefault();if(!preview||preview.conflicts.length||!query)return;d.pending(true);try{await api(`/drafts/${draft.id}/range-apply`,'POST',{...query,fingerprint:preview.fingerprint,requestKey:key});d.node.close();await done();}catch(error){d.error(error.message);}finally{d.pending(false);button.disabled=!preview||!!preview.conflicts.length||!preview.operations.length;}};
      }catch(error){home.error(error.message);}
    }
    home=plainDialog('Планирование графика','<p>Черновики и шаблоны доступны пользователям с правом управления. Публикация выдаётся отдельно. Прямое редактирование действующего графика сохраняет прежние права.</p><div class="schedule-toolbar"><button type="button" class="button primary" data-new-draft>Новый черновик</button><button type="button" class="button" data-templates-open>Шаблоны</button><button type="button" class="button" data-drafts-refresh>Обновить</button></div><div data-drafts></div>');
    home.node.querySelector('[data-new-draft]').onclick=createDraft;home.node.querySelector('[data-templates-open]').onclick=templates;home.node.querySelector('[data-drafts-refresh]').onclick=reloadHome;await reloadHome();
  };
})();
