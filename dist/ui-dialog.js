/* UI-04.1: shared presentation lifecycle. Domain APIs, permissions and drafts stay with callers. */
(() => {
  'use strict';
  if (window.HOOKAH_UI) return;
  let sequence = 0;
  const stack = [];
  const scrollLease = window.__hookahModalScrollLease ||= (() => {
    const owners = new Set(); let base;
    return { acquire(owner) { if (owners.has(owner)) return; if (!owners.size) base = document.body.style.overflow; owners.add(owner); document.body.style.overflow = 'hidden'; }, release(owner) { if (!owners.delete(owner)) return; if (!owners.size) document.body.style.overflow = base; } };
  })();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const visible = node => { const r=node.getBoundingClientRect(); return node.isConnected && r.width>0 && r.height>0 && !node.closest('[hidden],[inert]') && getComputedStyle(node).visibility!=='hidden'; };
  const focusable = root => [...root.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(n => !n.disabled && n.tabIndex>=0 && visible(n));
  const adapters = Object.freeze({
    portal: Object.freeze({required: field => field.required!==false, read: (form,fields) => {const data=Object.fromEntries(new FormData(form).entries()); fields.filter(f=>f.type==='checkbox').forEach(f=>{data[f.name]=Boolean(form.elements.namedItem(f.name)?.checked);});return data;}}),
    staff: Object.freeze({required: field => Boolean(field.required), read: form => Object.fromEntries(new FormData(form).entries())})
  });
  function fieldMarkup(field, adapter, prefix) {
    const id=prefix+'-field-'+field.name, required=adapter.required(field)?'required':'', label=escape(field.label), value=escape(field.value??'');
    const attributes=`id="${escape(id)}" name="${escape(field.name)}" ${required} aria-describedby="${escape(id)}-error"`;
    const bounds=['min','max','step','maxlength'].filter(k=>field[k]!==undefined).map(k=>`${k}="${escape(field[k])}"`).join(' ');
    let control;
    if(field.type==='select')control=`<select class="ui-input" ${attributes}>${(field.options||[]).map(o=>`<option value="${escape(o.value)}" ${String(o.value)===String(field.value??'')?'selected':''}>${escape(o.label)}</option>`).join('')}</select>`;
    else if(field.type==='textarea')control=`<textarea class="ui-input ui-input--textarea" rows="3" ${attributes} ${bounds}>${value}</textarea>`;
    else if(field.type==='checkbox')control=`<input class="ui-check-input" type="checkbox" value="${adapter===adapters.portal?'true':'on'}" ${attributes} ${(adapter===adapters.portal?field.value:field.checked)?'checked':''}>`;
    else control=`<input class="ui-input" type="${escape(field.type||'text')}" value="${value}" ${attributes} ${bounds} placeholder="${escape(field.placeholder||'')}">`;
    return `<div class="ui-field"><label class="ui-label ${field.type==='checkbox'?'ui-check':''}" for="${escape(id)}">${field.type==='checkbox'?control:''}<span>${label}</span>${field.type==='checkbox'?'':control}</label><small class="ui-error" id="${escape(id)}-error" hidden></small></div>`;
  }
  function fieldError(control, message) {
    if(!control)return;
    const node=document.getElementById(control.id+'-error');
    if(node){node.textContent=message||'';node.hidden=!message;}
    const trigger=control.closest('.custom-select')?.querySelector('.custom-select-trigger');
    for(const target of [control,trigger].filter(Boolean)){if(message)target.setAttribute('aria-invalid','true');else target.removeAttribute('aria-invalid');if(node){const ids=new Set((target.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));ids.add(node.id);target.setAttribute('aria-describedby',[...ids].join(' '));}}
  }
  function focusControl(control) { const trigger=control?.closest('.custom-select')?.querySelector('.custom-select-trigger');(trigger||control)?.focus({preventScroll:true}); }
  function feedback(text,kind='info',options={}) {
    const id=options.id||'ui-notice';let node=document.getElementById(id);
    if(!node){node=document.createElement('div');node.id=id;document.body.append(node);}
    clearTimeout(node._uiTimer);node.className=options.className||'ui-feedback';node.dataset.kind=kind;
    node.setAttribute('role',kind==='error'?'alert':'status');node.setAttribute('aria-live',kind==='error'?'assertive':'polite');node.setAttribute('aria-atomic','true');node.textContent=text;
    // POS already supplies longer reading times for pending warnings; its adapter preserves them.
    const requested=Number(options.duration)||4200;
    const duration=kind==='error'?0:options.preserveLegacyDuration&&requested>6000?requested:Math.min(6000,Math.max(4000,requested));
    if(duration)node._uiTimer=setTimeout(()=>node.remove(),duration);
    return node;
  }
  function open(options) {
    // Full mixed-window stacking is UI-04.3. One shared form can coexist with PIN/native settings.
    if(stack.length)throw Error('A shared form is already open');
    const {title,description='',fields=[],size='medium',draftPolicy,pendingClosePolicy,initialFocus,returnFocus,onClose,onSubmit,validate,context=()=>true,isCurrent=()=>true}=options;
    if(!String(title||'').trim())throw Error('Accessible dialog title required');
    if(!['preserve','confirm-discard','discard'].includes(draftPolicy)||pendingClosePolicy!=='block')throw Error('Explicit draft and pending policy required');
    const adapter=adapters[options.adapter||'portal'];if(!adapter)throw Error('Unknown field adapter');
    const initialContext=context(),opener=returnFocus||document.activeElement,prefix='ui-dialog-'+(++sequence),leases=new Map(),disabled=new Map();
    const scrollOwner={};
    const modal=document.createElement('div');modal.className='ui-modal ui-components';modal.dataset.uiDialog=prefix;modal.dataset.size=['small','medium','large'].includes(size)?size:'medium';modal.tabIndex=-1;
    modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby',prefix+'-title');if(description)modal.setAttribute('aria-describedby',prefix+'-description');
    modal.innerHTML=`<form class="ui-modal-card ui-modal-form" novalidate><header class="ui-modal-head"><div><h2 class="ui-heading ui-heading--section" id="${prefix}-title">${escape(title)}</h2>${description?`<p class="ui-helper" id="${prefix}-description">${escape(description)}</p>`:''}</div><button type="button" class="ui-button ui-icon-button" data-ui-close aria-label="Закрыть окно">×</button></header><div class="ui-modal-body">${fields.map(f=>fieldMarkup(f,adapter,prefix)).join('')}<p class="ui-error ui-modal-message" role="alert" aria-live="assertive" hidden></p><p class="ui-helper" data-ui-pending role="status" aria-live="polite" hidden>Сохраняем… Дождитесь результата.</p><div data-ui-discard hidden><p class="ui-text">Закрыть окно и удалить введённые данные?</p><button class="ui-button" type="button" data-ui-keep>Продолжить ввод</button><button class="ui-button ui-button--danger" type="button" data-ui-discard-confirm>Удалить ввод и закрыть</button></div></div><footer class="ui-modal-footer"><button class="ui-button" type="button" data-ui-cancel>Отмена</button><button class="ui-button ui-button--primary" type="submit">${escape(options.submitLabel||'Сохранить')}</button></footer></form>`;
    // UI-04.2: a domain wizard may mount its existing form; the default field adapter stays unchanged.
    const mount=options.mount,generatedForm=modal.querySelector('form');
    if(mount && (!mount.form || mount.form.tagName!=='FORM' || !mount.host || !mount.form.querySelector('.ui-modal-body') || !mount.form.querySelector('[data-ui-close]') || !mount.form.querySelector('[data-ui-cancel]')))throw Error('Mounted form requires a parking host, body and close/cancel controls');
    const mountedNodes=mount?[...generatedForm.querySelector('.ui-modal-body').children]:[];
    if(mount){for(const node of mountedNodes)mount.form.querySelector('.ui-modal-body').append(node);generatedForm.remove();modal.append(mount.form);modal.setAttribute('aria-labelledby',mount.titleId);if(mount.descriptionId)modal.setAttribute('aria-describedby',mount.descriptionId);else modal.removeAttribute('aria-describedby');}
    const form=mount?.form||generatedForm,message=modal.querySelector('.ui-modal-message'),discard=modal.querySelector('[data-ui-discard]'),listeners=[];
    const listen=(node,type,handler,capture=false)=>{node.addEventListener(type,handler,capture);listeners.push(()=>node.removeEventListener(type,handler,capture));};
    let pending=false,closed=false,suspended=false,lastFocus=null,discardFocus=null,backdropDown=false,backdropUp=false,dirty=false,resolve;
    const promise=new Promise(done=>{resolve=done;});
    const current=()=>context()===initialContext&&isCurrent();
    const blocked=()=>document.body.classList.contains('screen-locked')||Boolean(document.querySelector('dialog[open]'));
    const top=()=>stack.at(-1)?.element===modal;
    function leaseBackground(){for(const node of document.body.children){if(node===modal||node.matches('script,style,link,dialog,.screen-lock-overlay,.lock-settings-dialog,[data-ui-dialog],.ui-feedback,#portal-notice,#staff-notice'))continue;if(!leases.has(node)){leases.set(node,node.inert);node.inert=true;}}}
    function restoreFocus(){if(blocked())return;const fallback=options.fallbackFocus?.()||document.querySelector('#page-content h1,main h1,#page-content,main');const target=opener?.isConnected&&!opener.disabled&&visible(opener)?opener:fallback;if(!target||!visible(target))return;const old=target.getAttribute('tabindex');if(target.tabIndex<0)target.tabIndex=-1;target.focus({preventScroll:true});if(old===null)target.addEventListener('blur',()=>target.removeAttribute('tabindex'),{once:true});else target.setAttribute('tabindex',old);}
    function finish(reason,result){if(closed)return;const values=adapter.read(form,fields);closed=true;observer.disconnect();document.removeEventListener('keydown',keyDown,true);document.removeEventListener('focusin',focusIn);listeners.forEach(remove=>remove());if(mount){mountedNodes.forEach(node=>node.remove());mount.host.append(form);}stack.splice(stack.findIndex(s=>s.element===modal),1);modal.remove();for(const [node,value] of leases)if(node.isConnected)node.inert=value;scrollLease.release(scrollOwner);
      try{onClose?.({reason,values:reason==='context-changed'?null:values,result,draftPolicy});}catch(_){/* Domain callback cannot strand the closed presentation promise. */}
      finally{resolve({reason,values:reason==='success'?values:null,result});if(blocked()){const deferred=new MutationObserver(()=>{if(!current()){deferred.disconnect();return;}if(!blocked()){deferred.disconnect();restoreFocus();}});deferred.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','open']});}else restoreFocus();stack.at(-1)?.refresh();}
    }
    function keepDraft(){discard.hidden=true;(discardFocus&&!discardFocus.disabled&&visible(discardFocus)?discardFocus:focusable(modal)[0]||modal).focus();}
    function requestClose(reason='cancel'){if(closed||pending||suspended)return false;if(!current()){finish('context-changed');return true;}if(draftPolicy==='confirm-discard'&&dirty&&reason!=='discard-confirmed'){discardFocus=document.activeElement;discard.hidden=false;modal.querySelector('[data-ui-keep]').focus();return false;}finish(reason);return true;}
    function refresh(){if(closed)return;modal.classList.toggle('ui-critical-context-lost',!current()&&pending);if(!current()){if(!pending)finish('context-changed');return;}leaseBackground();const next=blocked()||!top();if(next!==suspended){suspended=next;modal.inert=next;if(next)modal.setAttribute('aria-hidden','true');else{modal.removeAttribute('aria-hidden');(lastFocus&&!lastFocus.disabled&&visible(lastFocus)?lastFocus:focusable(modal)[0]||modal).focus({preventScroll:true});}}}
    function keyDown(event){if(closed)return;if(blocked()){refresh();return;}if(suspended||!top()||event.defaultPrevented)return;if(event.key==='Escape'){const dropdown=modal.querySelector('.custom-select.is-open');if(dropdown){event.preventDefault();dropdown.classList.remove('is-open');const trigger=dropdown.querySelector('.custom-select-trigger');trigger?.setAttribute('aria-expanded','false');trigger?.focus();return;}event.preventDefault();event.stopImmediatePropagation();if(!discard.hidden){keepDraft();return;}requestClose('escape');}else if(event.key==='Tab'){const nodes=focusable(modal),first=nodes[0],last=nodes.at(-1);if(!first){event.preventDefault();modal.focus();}else if(!modal.contains(document.activeElement)||(event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last)){event.preventDefault();(event.shiftKey?last:first).focus();}}}
    function focusIn(event){if(closed)return;if(blocked()){refresh();return;}if(suspended||!top())return;if(modal.contains(event.target))lastFocus=event.target;else (lastFocus&&visible(lastFocus)?lastFocus:focusable(modal)[0]||modal).focus({preventScroll:true});}
    function setPending(value){pending=value;form.setAttribute('aria-busy',String(value));modal.querySelector('[data-ui-pending]').hidden=!value;for(const node of modal.querySelectorAll('button,input,select,textarea')){if(value){disabled.set(node,node.disabled);node.disabled=true;}else{node.disabled=disabled.get(node)||false;}}if(!value)disabled.clear();options.onPending?.(value);for(const control of form.querySelectorAll('select'))control._customSelectRefresh?.();if(value)modal.focus();}
    const observer=new MutationObserver(refresh);
    document.body.append(modal);stack.push({element:modal,refresh});scrollLease.acquire(scrollOwner);leaseBackground();observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','open']});document.addEventListener('keydown',keyDown,true);document.addEventListener('focusin',focusIn);
    listen(modal.querySelector('[data-ui-close]'),'click',()=>requestClose('close-button'));listen(modal.querySelector('[data-ui-cancel]'),'click',()=>requestClose('cancel'));
    modal.querySelector('[data-ui-keep]').addEventListener('click',keepDraft);modal.querySelector('[data-ui-discard-confirm]').addEventListener('click',()=>requestClose('discard-confirmed'));
    modal.addEventListener('pointerdown',e=>{backdropDown=e.target===modal;backdropUp=false;});modal.addEventListener('pointerup',e=>{backdropUp=e.target===modal;});modal.addEventListener('pointercancel',()=>{backdropDown=false;backdropUp=false;});modal.addEventListener('click',e=>{if(e.target===modal&&backdropDown&&backdropUp)requestClose('backdrop');backdropDown=false;backdropUp=false;});
    listen(form,'input',e=>{dirty=true;fieldError(e.target,'');});listen(form,'change',e=>{dirty=true;fieldError(e.target,'');});listen(form,'invalid',e=>{e.preventDefault();fieldError(e.target,e.target.validationMessage);},true);
    listen(form,'submit',async event=>{
      event.preventDefault();event.stopPropagation();if(pending||closed||suspended)return;if(!current()){finish('context-changed');return;}
      message.hidden=true;message.textContent='';if(mount){if(options.validateMounted?.(form)!==true)return;}else if(!form.checkValidity()){focusControl(form.querySelector(':invalid'));return;}
      const values=adapter.read(form,fields),numeric=fields.find(f=>f.type==='number'&&(!Number.isFinite(Number(values[f.name]))||(f.min!==undefined&&Number(values[f.name])<Number(f.min))||(f.max!==undefined&&Number(values[f.name])>Number(f.max))));
      const invalid=numeric?{field:numeric.name,message:`Введите корректное значение: ${numeric.label.toLocaleLowerCase('ru-RU')}`}:validate?.(values);
      if(invalid){const text=typeof invalid==='string'?invalid:invalid.message,control=form.elements.namedItem(typeof invalid==='string'?validate.focusField:invalid.field);if(control){fieldError(control,text);focusControl(control);}else{message.textContent=text;message.hidden=false;}return;}
      setPending(true);try{const result=await onSubmit?.(values);if(!current()){setPending(false);finish('context-changed');return;}setPending(false);finish('success',result);}catch(error){setPending(false);if(!current()){finish('context-changed');return;}message.textContent=options.errorMessage?.(error)||'Не удалось сохранить. Проверьте данные и повторите.';message.hidden=false;message.tabIndex=-1;message.focus({preventScroll:true});}
    });
    (typeof initialFocus==='function'?initialFocus(form):form.elements.namedItem(initialFocus||fields[0]?.name))?.focus({preventScroll:true});if(!modal.contains(document.activeElement))(focusable(modal)[0]||modal).focus();refresh();
    return {element:modal,form,promise,close:requestClose,refresh,get pending(){return pending;}};
  }
  // UI-07.1: retain financial domain DOM/handlers while sharing dismissal and focus policy.
  function critical(options) {
    const element=options.element,card=options.card||element, native=element.tagName==='DIALOG';
    const listeners=[];const listen=(node,type,handler,capture=false)=>{node.addEventListener(type,handler,capture);listeners.push(()=>node.removeEventListener(type,handler,capture));};
    const owner={},leases=new Map(),disabled=new Map();let active=false,initialContext,opener,openingFocus,backdropDown=false,backdropUp=false,wasPending=false;
    const opened=()=>native?element.open:element.classList.contains('open');
    const pending=()=>Boolean(options.isPending?.());
    const current=()=>options.context?.()===initialContext&&options.isCurrent?.()!==false;
    element.classList.add('ui-components','ui-critical-dialog');card.classList.add('ui-modal-card');
    element.dataset.uiDialog='critical';element.dataset.uiSize=options.size||'medium';element.tabIndex=-1;
    element.setAttribute('role','dialog');element.setAttribute('aria-modal','true');
    if(options.titleId)element.setAttribute('aria-labelledby',options.titleId);
    const status=document.createElement('p');status.className='ui-helper ui-critical-pending';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=true;status.textContent='Операция выполняется. Дождитесь результата.';(options.body||card).append(status);
    function release(reason){if(!active)return;active=false;for(const [node,value]of leases)if(node.isConnected)node.inert=value;leases.clear();scrollLease.release(owner);stack.splice(stack.findIndex(s=>s.element===element),1);options.onClose?.(reason);if(opener?.isConnected&&!opener.disabled&&visible(opener)&&!document.body.classList.contains('screen-locked'))opener.focus({preventScroll:true});stack.at(-1)?.refresh();}
    function close(reason='cancel'){if(pending())return false;if(native&&element.open)element.close();else element.classList.remove('open');release(reason);return true;}
    function refresh(){
      if(!element.isConnected){if(!pending())destroy();return;}
      // Native close events are queued after the open-attribute mutation observer.
      if(!opened()&&active&&pending()){if(native)element.showModal();else element.classList.add('open');return;}
      if(!opened()){if(active)release('native-close');return;}
      if(!active){active=true;initialContext=options.context?.();opener=openingFocus||document.activeElement;openingFocus=null;stack.push({element,refresh});scrollLease.acquire(owner);for(const node of document.body.children){if(node===element||node.contains(element)||node.matches('script,style,link,dialog,.screen-lock-overlay,.lock-settings-dialog,[data-ui-dialog],.ui-feedback,#portal-notice,#staff-notice'))continue;leases.set(node,node.inert);node.inert=true;}options.initialFocus?.()?.focus({preventScroll:true});}
      if(!status.isConnected)(options.body||card).append(status);
      const busy=pending();element.classList.toggle('ui-critical-context-lost',!current()&&busy);element.setAttribute('aria-busy',String(busy));status.hidden=!busy;
      if(busy!==wasPending){for(const node of element.querySelectorAll('button,input,select,textarea')){if(busy){disabled.set(node,node.disabled);node.disabled=true;}else if(disabled.has(node)){node.disabled=disabled.get(node);}}if(!busy)disabled.clear();wasPending=busy;}
      if(!current()&&!busy)close('context-changed');
    }
    function key(event){if(!opened()||stack.at(-1)?.element!==element||document.body.classList.contains('screen-locked')||event.defaultPrevented)return;const other=[...document.querySelectorAll('dialog[open]')].some(d=>d!==element);if(other)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();const dropdown=element.querySelector('.custom-select.is-open');if(dropdown){dropdown.classList.remove('is-open');dropdown.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded','false');dropdown.querySelector('.custom-select-trigger')?.focus();return;}close('escape');}else if(event.key==='Tab'){const nodes=focusable(element),first=nodes[0],last=nodes.at(-1);if(!first){event.preventDefault();element.focus();}else if(!element.contains(document.activeElement)||(event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last)){event.preventDefault();(event.shiftKey?last:first).focus();}}}
    listen(element,'cancel',event=>{event.preventDefault();close('native-cancel');});
    listen(element,'close',()=>{if(opened())return;if(pending()){if(!element.open)element.showModal();refresh();}else release('native-close');});
    listen(element,'pointerdown',e=>{backdropDown=e.target===element;backdropUp=false;});listen(element,'pointerup',e=>{backdropUp=e.target===element;});
    listen(element,'click',event=>{if(event.target.closest(options.closeSelector||'[data-ui-close],[data-ui-cancel]')||(event.target===element&&backdropDown&&backdropUp)){event.preventDefault();event.stopImmediatePropagation();close(event.target===element?'backdrop':'cancel');}backdropDown=false;backdropUp=false;},true);
    document.addEventListener('keydown',key,true);
    const observer=new MutationObserver(refresh);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','open']});
    function destroy(){if(pending())return false;close('destroy');observer.disconnect();document.removeEventListener('keydown',key,true);listeners.forEach(remove=>remove());status.remove();return true;}
    return {open(){if(opened()){refresh();return;}openingFocus=document.activeElement;if(native)element.showModal();else element.classList.add('open');refresh();},close,refresh,destroy};
  }
  window.HOOKAH_UI=Object.freeze({open,critical,feedback,fieldError,adapters,version:1});
})();
