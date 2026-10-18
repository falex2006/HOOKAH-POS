/* UI-04.1 local reference: no API, storage, authentication or PIN setup. */
(()=>{
  'use strict';
  const ui=window.HOOKAH_UI,main=document.querySelector('#reference-main'),report=document.querySelector('#reference-report');
  const lock=document.querySelector('#reference-lock'),pin=document.querySelector('#screen-lock-pin'),settings=document.querySelector('#reference-settings');
  const drafts=new Map(),removedOpeners=new Map(),events=[];
  let active=null,activeKey='',draftVersion=0,callbackCount=0,lastValues=null,lastResult=null,contextVersion=1;
  const describe=node=>node?`${node.tagName.toLowerCase()}${node.id?'#'+node.id:''}`:null;
  function record(type,extra={}){events.push({type,...extra});if(events.length>18)events.shift();render();}
  function render(){const modal=active?.element,card=modal?.querySelector('.ui-modal-card');const snapshot={module:ui?.version,fixture:'local-no-api-no-storage-no-auth',theme:document.body.classList.contains('light-theme')?'light':'dark',activeKey,open:Boolean(modal?.isConnected),pending:active?.pending||false,focus:describe(document.activeElement),modalInert:modal?.inert??null,modalAriaHidden:modal?.getAttribute('aria-hidden')??null,mainInert:main.inert,overflow:document.body.style.overflow,pinVisible:lock.getAttribute('aria-hidden')==='false',nativeSettingsOpen:settings.open,draftVersion,callbackCount,contextVersion,lastValues,lastResult,geometry:card?{width:card.getBoundingClientRect().width,height:card.getBoundingClientRect().height}:null,events};report.textContent=JSON.stringify(snapshot,null,2);}
  const laterRender=()=>requestAnimationFrame(render);
  function addAction(container,text,id,run){const button=document.createElement('button');button.type='button';button.className='ui-button';button.id=id;button.textContent=text;button.addEventListener('click',run);container.append(button);return button;}
  function open(kind,button){
    if(active?.element.isConnected)return;
    activeKey=kind;lastResult=null;
    const isStaff=kind==='staff',isLong=kind==='long',isSmall=kind==='small',policy=kind==='discard'?'confirm-discard':'preserve';
    const base=[{name:'title',label:'Название',required:isStaff?true:undefined,value:'',maxlength:120},{name:'note',label:'Описание / черновик',type:'textarea',required:false,value:''},{name:'amount',label:'Число (не финансовое, только проверка адаптера)',type:'number',required:false,min:0,max:100,step:1,value:''},{name:'optional',label:'Необязательный флажок',type:'checkbox',required:false,value:false,checked:false}];
    if(!isStaff)base.splice(1,0,{name:'assignee',label:'Ответственный',type:'select',options:[{value:'',label:'Выберите сотрудника'},{value:'local-person',label:'Сотрудник с длинным именем — локальный эталон, не серверная запись'}]});
    if(isStaff)base.push({name:'defaultOptional',label:'Staff поле без required (необязательное)',value:''});
    if(isLong){base.length=0;for(let i=1;i<=40;i++)base.push({name:'long'+i,label:`Поле ${i} — длинная рабочая подпись для проверки переноса в форме`,required:false,value:`Тестовое значение ${i}`});}
    if(isSmall){base.length=0;base.push({name:'short',label:'Короткое значение',required:false,value:'440px — локальный эталон'});}
    const saved=drafts.get(kind);if(saved)for(const field of base){if(field.type==='checkbox'){field.value=Boolean(saved[field.name]);field.checked=Boolean(saved[field.name]);}else if(saved[field.name]!==undefined)field.value=saved[field.name];}
    const ownedContext=contextVersion;
    active=ui.open({title:isLong?'Длинный составной редактор':isSmall?'Короткое окно':isStaff?'Staff адаптер — локальный эталон':kind==='discard'?'Подтверждение удаления ввода':'Portal форма — локальный эталон',description:'Локальный callback. Никаких API, storage и авторизации.',fields:base,size:isLong?'large':isSmall?'small':'medium',adapter:isStaff?'staff':'portal',draftPolicy:policy,pendingClosePolicy:'block',returnFocus:button,fallbackFocus:()=>document.querySelector('#reference-heading'),context:()=>contextVersion,isCurrent:()=>contextVersion===ownedContext,
      onSubmit:async values=>{callbackCount++;lastValues={...values};record('callback-start',{call:callbackCount});const delay=Number(document.querySelector('#reference-delay').value),result=document.querySelector('#reference-result').value;await new Promise(resolve=>setTimeout(resolve,delay));if(result==='error'){record('callback-error');throw Error('local_fixture_error');}lastResult={fixture:'success',call:callbackCount};record('callback-success');return lastResult;},
      errorMessage:()=> 'Локальный тест: сохранение не выполнено. Значения остаются в форме.',
      onClose:({reason,values})=>{if(reason==='success'||reason==='discard-confirmed'||reason==='context-changed')drafts.delete(kind);else if(policy==='preserve'&&values)drafts.set(kind,{...values});draftVersion++;record('close',{reason,values});}
    });
    const actions=document.createElement('div');actions.className='reference-actions';active.element.querySelector('.ui-modal-body').append(actions);
    addAction(actions,'Удалить инициатор','reference-remove-opener',()=>{if(button.isConnected){removedOpeners.set(button.id,{node:button,parent:button.parentNode,next:button.nextSibling});button.remove();record('opener-removed',{id:button.id});}});
    addAction(actions,'Показать статический PIN','reference-show-pin',()=>{lock.setAttribute('aria-hidden','false');document.body.classList.add('screen-locked');pin.value='';pin.focus();record('static-pin-show');laterRender();});
    addAction(actions,'Открыть native настройки','reference-show-settings',()=>{settings.showModal();document.querySelector('#reference-settings-input').focus();record('native-settings-show');laterRender();});
    addAction(actions,'Сменить локальный контекст','reference-change-context',()=>{contextVersion++;active.refresh();record('context-changed');laterRender();});
    active.promise.then(result=>{record('resolved',{reason:result.reason});if(result.reason==='success')ui.feedback('Локальный callback завершён. Ничего не сохранено на сервере.','success');laterRender();});
    record('open',{kind,policy});laterRender();
  }
  document.querySelector('#reference-dark').addEventListener('click',()=>{document.body.classList.remove('light-theme');render();});
  document.querySelector('#reference-light').addEventListener('click',()=>{document.body.classList.add('light-theme');render();});
  for(const [id,kind]of [['reference-open-portal','portal'],['reference-open-staff','staff'],['reference-open-small','small'],['reference-open-long','long'],['reference-open-discard','discard']]){const button=document.getElementById(id);button.addEventListener('click',()=>open(kind,button));}
  document.querySelector('#reference-feedback-success').addEventListener('click',()=>{ui.feedback('Локальный тест: успешное сообщение 4,2 секунды.','success');record('feedback-success');});
  document.querySelector('#reference-feedback-error').addEventListener('click',()=>{ui.feedback('Локальный тест: ошибка остаётся до следующего явного сообщения.','error');record('feedback-error');});
  document.querySelector('#reference-restore-openers').addEventListener('click',()=>{for(const {node,parent,next}of removedOpeners.values())if(!node.isConnected&&parent.isConnected)parent.insertBefore(node,next?.isConnected?next:null);removedOpeners.clear();record('openers-restored');});
  document.querySelector('#reference-lock-end').addEventListener('click',()=>{lock.setAttribute('aria-hidden','true');document.body.classList.remove('screen-locked');pin.value='';record('static-pin-end');laterRender();});
  document.querySelector('#reference-lock-settings').addEventListener('click',()=>{settings.showModal();document.querySelector('#reference-settings-input').focus();record('native-settings-show-from-pin');laterRender();});
  document.querySelector('#reference-settings-close').addEventListener('click',()=>{settings.close();if(lock.getAttribute('aria-hidden')==='false')pin.focus();record('native-settings-close');laterRender();});
  settings.addEventListener('cancel',()=>laterRender());
  document.addEventListener('focusin',laterRender);document.addEventListener('input',laterRender);document.addEventListener('change',laterRender);
  new MutationObserver(records=>{if(records.some(entry=>entry.target!==report&&!report.contains(entry.target)))laterRender();}).observe(document.body,{childList:true,attributes:true,subtree:true,attributeFilter:['class','aria-hidden','aria-busy','inert','open']});
  render();
})();
