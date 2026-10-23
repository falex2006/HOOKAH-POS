(function mountStaffPhoneList(){
  const mount=()=>{
    const inputs=[...document.querySelectorAll('input[type="tel"], input[name*="phone" i], input[name*="телефон" i]')];
    inputs.forEach((input)=>{
      const form=input.closest('form')||input.parentElement;
      if(!form||form.dataset.staffPhonesReady==='1') return;
      if(!form.matches('.staff-form,.staff-editor-form')) return;
      form.dataset.staffPhonesReady='1';
      const rows=document.createElement('div');
      rows.className='staff-phone-list';
      rows.innerHTML='<div class="staff-phone-list__header"><strong>Телефоны</strong><button type="button" class="staff-phone-list__add">Добавить номер</button></div><div class="staff-phone-list__rows"></div><input type="hidden" name="phones_json" class="staff-phone-list__value">';
      const contactRow=input.closest('.staff-form-contact-row');
      const secondaryInput=contactRow?.querySelector('input[name="phone_secondary"]');
      const secondaryValue=secondaryInput?.value?.trim()||'';
      if(contactRow){
        contactRow.hidden=true;
        contactRow.after(rows);
      }else{
        input.parentElement?.after(rows);
        input.style.display='none';
      }
      const list=rows.querySelector('.staff-phone-list__rows');
      const hidden=rows.querySelector('.staff-phone-list__value');
      const initial=input.value?{label:'Рабочий',number:input.value,primary:true}:{label:'Рабочий',number:'',primary:true};
      const read=()=>[...list.querySelectorAll('.staff-phone-row')].map((row)=>({label:row.querySelector('select')?.value||'Дополнительный',number:row.querySelector('input[type="tel"]')?.value?.trim()||'',primary:!!row.querySelector('input[type="radio"]')?.checked})).filter((item)=>item.number);
      const sync=()=>{const value=read(); hidden.value=JSON.stringify(value); try{const current=JSON.parse(localStorage.getItem('territory_crm_staff_profile_draft')||'{}');localStorage.setItem('territory_crm_staff_profile_draft',JSON.stringify({...(Array.isArray(current)?{}:current),phones:value}));}catch(_) {}};
      const add=(item={label:'Дополнительный',number:'',primary:false})=>{
        const row=document.createElement('div');
        row.className='staff-phone-row';
        row.innerHTML='<select aria-label="Тип телефона"><option>Рабочий</option><option>Личный</option><option>Резервный</option><option>Дополнительный</option></select><input type="tel" inputmode="tel" placeholder="Номер телефона" aria-label="Номер телефона"><label><input type="radio" name="staff_primary_phone" aria-label="Основной"> основной</label><button type="button" class="staff-phone-row__remove" aria-label="Удалить номер" title="Удалить номер"><svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg#x"></use></svg></button>';
        row.querySelector('select').value=item.label||'Дополнительный';
        row.querySelector('input[type="tel"]').value=item.number||'';
        row.querySelector('input[type="radio"]').checked=!!item.primary;
        row.addEventListener('input',sync); row.addEventListener('change',sync);
        row.querySelector('.staff-phone-row__remove').addEventListener('click',()=>{if(list.children.length>1){row.remove();sync();}});
        list.append(row);
      };
      add(initial);
      if(secondaryValue) add({label:'Дополнительный',number:secondaryValue,primary:false});
      rows.querySelector('.staff-phone-list__add').addEventListener('click',()=>add());
      form.addEventListener('submit',sync); sync();
    });
  };
  mount();
  new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
})();
;(function mountStaffTelegramField(){
  const mount=()=>{
    document.querySelectorAll('form').forEach((form)=>{
      if(form.dataset.staffTelegramReady==='1') return;
      if(!form.matches('.staff-form,.staff-editor-form')) return;
      if(form.querySelector('input[name*="telegram" i]')){form.dataset.staffTelegramReady='1';return;}
      const field=document.createElement('label'); field.className='staff-profile-field staff-telegram-field'; field.textContent='Telegram';
      const input=document.createElement('input'); input.type='text'; input.name='telegram'; input.placeholder='@username или https://t.me/username'; input.autocomplete='off';
      const hint=document.createElement('small'); hint.className='staff-telegram-hint'; field.append(input,hint);
      const validate=()=>{const value=input.value.trim(); const valid=!value||/^(@[A-Za-z0-9_]{5,32}|https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$)/.test(value); hint.textContent=valid?'':'Используйте @username или ссылку https://t.me/username.'; hint.classList.toggle('is-error',!valid); return valid;};
      input.addEventListener('input',validate); input.addEventListener('blur',validate); form.addEventListener('submit',(event)=>{if(!validate())event.preventDefault();});
      const anchor=form.querySelector('input[name*="phone" i], input[type="tel"]'); (anchor?.parentElement||form).after(field); form.dataset.staffTelegramReady='1';
    });
  }; mount(); new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
})();
;(function persistStaffTelegramDraft(){
  const mount=()=>document.querySelectorAll('.staff-telegram-field input[name="telegram"]').forEach((input)=>{
    if(input.dataset.draftReady==='1')return;
    input.dataset.draftReady='1';
    input.addEventListener('input',()=>{try{const draft=JSON.parse(localStorage.getItem('territory_crm_staff_profile_draft')||'{}');draft.telegram=input.value.trim();localStorage.setItem('territory_crm_staff_profile_draft',JSON.stringify(draft));}catch(_){}});
  });
  mount(); new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
})();
;(function normalizeStaffContactDraft(){const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='territory_crm_staff_profile_draft'){try{const parsed=JSON.parse(value);if(Array.isArray(parsed))value=JSON.stringify({phones:parsed});}catch(_){}}return original.call(this,key,value);};})();
;(function validateStaffPhoneRows(){
  const mount=()=>document.querySelectorAll('.staff-phone-list').forEach((list)=>{
    const form=list.closest('form'); if(!form||form.dataset.staffPhoneValidationReady==='1')return;
    form.dataset.staffPhoneValidationReady='1';
    const validate=()=>{let valid=true;list.querySelectorAll('.staff-phone-row').forEach((row)=>{const input=row.querySelector('input[type="tel"]');if(!input)return;const digits=(input.value.match(/\d/g)||[]).length;input.classList.toggle('is-invalid',!!input.value.trim()&&digits<10);if(input.value.trim()&&digits<10)valid=false;});return valid;};
    list.addEventListener('input',validate); form.addEventListener('submit',(event)=>{if(!validate())event.preventDefault();});
  });
  mount(); new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
})();
