const staffIcon=(name)=>`<svg class="icon" aria-hidden="true"><use href="/assets/tabler-icons.svg?rev=6#${name}"></use></svg>`; const pluralRu=(value,one,few,many)=>{const n=Math.abs(Number(value)||0),last10=n%10,last100=n%100;return last10===1&&last100!==11?one:last10>=2&&last10<=4&&(last100<12||last100>14)?few:many;};
const displayProductName=(value)=>String(value??'').trim().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu,(_,prefix,letter)=>prefix+letter.toLocaleUpperCase('ru-RU'));
const updateStaffHeaderClock=()=>{const node=document.querySelector('.staff-header-date');if(!node)return;const now=new Date();const date=new Intl.DateTimeFormat('ru-RU',{weekday:'short',day:'numeric',month:'short'}).format(now);const time=new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit',hour12:false}).format(now);node.textContent=`${date} · ${time}`;};updateStaffHeaderClock();window.setInterval(updateStaffHeaderClock,30000);
document.addEventListener('click', (event) => { const link = event.target.closest('a[href]'); if (!link) return; const target = new URL(link.href, location.href); if (target.origin === location.origin && target.pathname === '/admin' && !target.searchParams.has('mode')) { event.preventDefault(); location.assign(target.pathname + target.search + target.hash); } }, true);
if(!localStorage.getItem('crm_session_token')){window.location.replace('/login');throw new Error('authentication_required');}
document.addEventListener('click', async (event) => { const button = event.target.closest('#logout'); if (!button || button.disabled) return; button.disabled = true; try { if(!String(localStorage.getItem('crm_session_token')||'').startsWith('demo-static-')){const response=await fetch('/api/logout', { method: 'POST', headers: typeof sessionHeaders === 'function' ? sessionHeaders() : {} });if(!response.ok&&response.status!==401)throw new Error('logout_unavailable');} } catch (_) {button.disabled=false;notice('Не удалось завершить сессию. Повторите выход.');return;} window.__broadcastSessionEnd?.();staffNotificationCenter?.dispose();localStorage.removeItem('crm_session_token'); localStorage.removeItem('crm_session_user'); localStorage.removeItem('crm_workspace_mode'); window.location.replace('/login'); });
const queryParams=new URLSearchParams(location.search); if(queryParams.has('mode')||queryParams.has('operator')){queryParams.delete('mode');queryParams.delete('operator');const cleanSearch=queryParams.toString();history.replaceState(null,'',location.pathname+(cleanSearch?'?'+cleanSearch:'')+location.hash);} const preserveWorkspaceRoute=(href)=>{const next=new URL(href,location.origin);for(const key of ['venue','venueId','workspace']){if(!next.searchParams.has(key)&&queryParams.has(key))next.searchParams.set(key,queryParams.get(key));}next.searchParams.delete('mode');next.searchParams.delete('operator');return next.pathname+next.search+next.hash;};
function notice(text,duration=2400){let el=document.querySelector('#staff-notice');if(!el){el=document.createElement('div');el.id='staff-notice';el.className='staff-notice';document.body.append(el);}el.textContent=text;el.classList.add('show');clearTimeout(el._timer);el._timer=setTimeout(()=>el.classList.remove('show'),duration);}
const sessionHeaders=()=>{const token=localStorage.getItem('crm_session_token');return token?{Authorization:'Bearer '+token}:{};};
const staticStaffDemo=()=>String(localStorage.getItem('crm_session_token')||'').startsWith('demo-static-');
const mountStaffSidebarDrawer=()=>{
  const sidebar=document.querySelector('.staff-theme .portal-sidebar');
  if(!sidebar||document.querySelector('.staff-theme .sidebar-mobile-toggle'))return;
  sidebar.id=sidebar.id||'staff-primary-navigation';
  const toggle=document.createElement('button');
  toggle.type='button';toggle.className='sidebar-mobile-toggle';toggle.setAttribute('aria-controls',sidebar.id);toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Открыть меню');
  toggle.innerHTML=`${staffIcon('menu-2')}<span>Меню</span>`;
  sidebar.parentElement?.insertBefore(toggle,sidebar);
  const backdrop=document.createElement('div');backdrop.className='sidebar-backdrop';backdrop.hidden=true;backdrop.setAttribute('aria-hidden','true');document.body.append(backdrop);
  const isDrawer=()=>window.matchMedia('(max-width: 900px)').matches;
  const focusable=()=>[toggle,...sidebar.querySelectorAll('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')].filter((node)=>!node.hidden&&node.getClientRects().length);
  const sync=(expanded,{restoreFocus=false}={})=>{
    sidebar.classList.toggle('is-expanded',expanded);toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-label',expanded?'Закрыть меню':'Открыть меню');toggle.innerHTML=`${staffIcon(expanded?'x':'menu-2')}<span>Меню</span>`;
    const modalOpen=expanded&&isDrawer();backdrop.hidden=!modalOpen;document.body.classList.toggle('sidebar-drawer-open',modalOpen);document.querySelector('.staff-theme main')?.toggleAttribute('inert',modalOpen);sidebar.inert=isDrawer()&&!expanded;
    if(sidebar.inert)sidebar.setAttribute('aria-hidden','true');else sidebar.removeAttribute('aria-hidden');
    if(!expanded&&restoreFocus)toggle.focus({preventScroll:true});
  };
  toggle.addEventListener('click',()=>{const opening=!sidebar.classList.contains('is-expanded');sync(opening);if(opening&&isDrawer())requestAnimationFrame(()=>focusable()[1]?.focus({preventScroll:true}));});
  backdrop.addEventListener('click',()=>sync(false,{restoreFocus:true}));
  document.addEventListener('keydown',(event)=>{if(!sidebar.classList.contains('is-expanded'))return;if(event.key==='Escape'){event.preventDefault();sync(false,{restoreFocus:true});return;}if(event.key!=='Tab'||!isDrawer())return;const nodes=focusable();if(!nodes.length){event.preventDefault();toggle.focus();return;}const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}});
  sidebar.addEventListener('click',(event)=>{if(event.target.closest('.portal-nav button,.staff-admin-nav-link')&&isDrawer())sync(false);});
  window.addEventListener('resize',()=>{if(!isDrawer()&&sidebar.classList.contains('is-expanded'))sync(false,{restoreFocus:true});},{passive:true});
  sync(false);
};
mountStaffSidebarDrawer();
let staffSessionVerified=staticStaffDemo();
let staffSessionRequest=null;
const staffFetchJson=async(url,options={})=>{
  const controller=new AbortController();
  const readOnly=['GET','HEAD'].includes(String(options.method||'GET').toUpperCase());
  // Aborting a mutation cannot prove that the server did not save it. Keep its
  // caller pending until the response arrives, so a delayed write is not retried.
  const timer=window.setTimeout(()=>{if(readOnly)controller.abort();else notice('Сервер ещё сохраняет действие. Дождитесь результата; не повторяйте его.',12000);},8000);
  try{
    const response=await fetch(url,{...options,signal:controller.signal,headers:{...sessionHeaders(),...(options.headers||{})}});
    const payload=await response.json();
    if(!response.ok){const error=new Error(payload.error||`HTTP ${response.status}`);error.payload=payload;error.status=response.status;throw error;}
    return payload;
  }catch(error){if(error?.name==='AbortError')throw new Error('request_timeout');throw error;}
  finally{window.clearTimeout(timer);}
};
const staffRoleLabels={owner:'Владелец',admin:'Администратор',manager:'Управляющий',senior_bartender:'Старший бармен',senior_hookah_master:'Старший кальянщик',bartender:'Бармен',hookah_master:'Кальянщик',developer:'Разработчик'};
const escapeStaffHtml=(value)=>String(value??'').replace(/[&<>\"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
const applyStaffHeader=(user)=>{const name=String(user?.name||'Сотрудник').trim();const role=staffRoleLabels[user?.role]||'Персонал';document.querySelectorAll('[data-staff-header-name]').forEach((node)=>{node.textContent=name;});document.querySelectorAll('[data-staff-header-role]').forEach((node)=>{node.textContent=role;});document.querySelectorAll('[data-staff-header-avatar]').forEach((node)=>{node.textContent=(name.split(/\s+/).filter(Boolean).slice(0,2).map((part)=>part[0]).join('')||'С').toLocaleUpperCase('ru-RU');if(user?.avatarUrl){const image=document.createElement('img');image.src=user.avatarUrl;image.alt=name;node.replaceChildren(image);}});};
const staffPermissionAliases={inventory_read:'inventory',finance_read:'finance'};
const hasStaffPermission=(required,permissions)=>permissions.has(required)||Boolean(staffPermissionAliases[required]&&permissions.has(staffPermissionAliases[required]));
let staffShiftReadable=false,staffShiftManageable=false,staffNotificationCenter=null;
const applyStaffSession=(s)=>{if(!s?.user)return;const actor=s.user;applyStaffHeader(actor);const permissions=new Set(Array.isArray(s.permissions)?s.permissions:[]);staffNotificationCenter?.dispose();staffNotificationCenter=window.mountCrmNotifications({user:actor,permissions,api:(url,options)=>staticStaffDemo()?staticShiftNotificationsApi(url,options):staffFetchJson(url,options),bellHost:document.querySelector('.staff-header-user')});staffNotificationCenter.refresh();staffShiftReadable=['floor','orders','finance_read','finance'].some(p=>permissions.has(p));staffShiftManageable=['floor','orders'].some(p=>permissions.has(p));const shiftControl=document.querySelector('#shift-toggle');if(shiftControl)shiftControl.hidden=!staffShiftReadable;const navItems=[...document.querySelectorAll('.portal-sidebar .portal-nav [data-permission]')];navItems.forEach((item)=>{item.hidden=!hasStaffPermission(item.dataset.permission,permissions);});document.querySelectorAll('.portal-sidebar .portal-nav:not(.staff-admin-nav)').forEach((nav)=>{const hasVisibleItem=[...nav.querySelectorAll('[data-permission]')].some((item)=>!item.hidden);nav.hidden=!hasVisibleItem;const label=nav.previousElementSibling;if(label?.classList.contains('side-label'))label.hidden=!hasVisibleItem;});document.querySelectorAll('.portal-sidebar .portal-nav:not([hidden])').forEach((nav)=>nav.removeAttribute('aria-busy'));document.querySelectorAll('.portal-sidebar .portal-nav').forEach((nav)=>nav.removeAttribute('data-session-pending'));
const canOpenAdmin=['owner','admin','manager','developer'].includes(actor.role);const ensureAdminPanelLink=()=>{if(!canOpenAdmin)return;const sidebar=document.querySelector('.portal-sidebar');const operationNav=sidebar?.querySelector('.portal-nav');if(!sidebar||!operationNav||sidebar.querySelector('a.staff-admin-nav-link'))return;const label=document.createElement('div');label.className='side-label staff-admin-nav-label';label.textContent=actor.role==='manager'?'УПРАВЛЕНИЕ':'АДМИНИСТРИРОВАНИЕ';const nav=document.createElement('nav');nav.className='portal-nav staff-admin-nav';const link=document.createElement('a');link.className='staff-admin-nav-link';link.href=preserveWorkspaceRoute('/admin');link.title=actor.role==='manager'?'Открыть панель управления':'Открыть панель администратора';link.innerHTML='<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6-6 6 6 6M4 12h16"></path></svg><span><strong>'+(actor.role==='manager'?'Панель управления':'Панель администратора')+'</strong></span>';nav.append(link);const footer=sidebar.querySelector('.sidebar-footer,.user,.logout-button');if(footer){sidebar.insertBefore(label,footer);sidebar.insertBefore(nav,footer);}else sidebar.append(label,nav);};ensureAdminPanelLink();document.querySelector('#staff-loyalty-link')?.addEventListener('click',()=>{window.location.href=preserveWorkspaceRoute('/admin#loyalty');});document.querySelector('#staff-guests-link')?.addEventListener('click',()=>{window.location.href=preserveWorkspaceRoute('/clients');});const user=document.querySelector('.user');if(user){user.innerHTML='<label class="staff-self-avatar" title="Изменить свой аватар"><span aria-hidden="true">'+(String(actor.name||'Сотрудник').split(/\s+/).filter(Boolean).slice(0,2).map((part)=>part[0]).join('')||'С').toLocaleUpperCase('ru-RU')+'</span><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Изменить свой аватар"></label><div class="staff-self-identity"><b>'+escapeStaffHtml(actor.name||'Сотрудник')+'</b><small>'+escapeStaffHtml(staffRoleLabels[actor.role]||'Персонал')+'</small></div><button class="staff-logout" id="logout" type="button">'+staffIcon('logout')+'<span>Выйти</span></button>';applyStaffHeader(actor);const picker=user.querySelector('.staff-self-avatar input');picker?.addEventListener('change',()=>{const file=picker.files?.[0];if(!file)return;if(!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)||file.size>1500000){notice('Аватар: PNG, JPG или WebP до 1.5 МБ');picker.value='';return;}const reader=new FileReader();reader.onerror=()=>notice('Не удалось прочитать аватар');reader.onload=()=>fetch('/api/staff/'+encodeURIComponent(actor.id)+'/avatar',{method:'POST',headers:{...sessionHeaders(),'Content-Type':'application/json'},body:JSON.stringify({imageData:reader.result})}).then((response)=>response.ok?response.json():Promise.reject(new Error('avatar_failed'))).then((person)=>{actor.avatarUrl=person.avatarUrl||reader.result;localStorage.setItem('crm_session_user',JSON.stringify(actor));applyStaffSession(s);notice('Аватар обновлён');}).catch(()=>notice('Не удалось обновить аватар'));reader.readAsDataURL(file);});}};
const resolveStaticStaffPermissions=(role)=>({owner:['floor','orders','reservations','inventory','finance','loyalty'],admin:['floor','orders','reservations','inventory','finance','loyalty'],manager:['floor','orders','reservations','inventory_read','finance_read','loyalty'],senior_bartender:['floor','orders','finance_read'],senior_hookah_master:['floor','orders','finance_read'],bartender:['floor','orders','finance_read'],hookah_master:['floor','orders','finance_read'],cleaner:[],security:[],technician:[],other_staff:[],developer:['floor','orders','reservations','inventory_read','finance_read']})[role]||[];
if(staticStaffDemo()){try{const localUser=JSON.parse(localStorage.getItem('crm_session_user')||'{}');if(localUser.role)applyStaffSession({user:localUser,permissions:resolveStaticStaffPermissions(localUser.role)});}catch(_){}}
const verifyStaffSession=()=>{
  if(staffSessionRequest)return staffSessionRequest;
  const status=document.querySelector('#staff-session-status');
  if(status){status.textContent='Проверяем доступ к рабочему месту…';status.setAttribute('role','status');}
  staffSessionRequest=staffFetchJson('/api/session').then((session)=>{
    if(!session?.user||!Array.isArray(session.permissions))throw new Error('session_invalid_response');
    applyStaffSession(session);
    staffSessionVerified=true;
    localStorage.setItem('crm_session_user',JSON.stringify(session.user));
    mountStaffExtensions();
    document.querySelector('.order')?.removeAttribute('inert');
    if(status)status.hidden=true;
    refreshFloor();loadProducts();if(staffSessionVerified)refreshShift();
    return true;
  }).catch((error)=>{
    staffSessionVerified=false;
    if(error.status===401){localStorage.removeItem('crm_session_token');localStorage.removeItem('crm_session_user');window.location.replace('/login');return false;}
    document.querySelectorAll('.portal-sidebar .portal-nav').forEach((nav)=>{nav.hidden=true;nav.removeAttribute('aria-busy');});
    if(status){status.hidden=false;status.setAttribute('role','alert');status.innerHTML='<p>Не удалось проверить доступ. Повторите проверку или войдите снова.</p><button type="button" data-staff-session-retry>Повторить проверку</button><a href="/login">Войти снова</a>';}
    showFloorUnavailable('Доступ к рабочему месту пока не подтверждён');
    return false;
  }).finally(()=>{staffSessionRequest=null;});
  return staffSessionRequest;
};
document.addEventListener('click',(event)=>{if(event.target.closest('[data-staff-session-retry]'))verifyStaffSession();});
if(!staticStaffDemo())Promise.resolve().then(verifyStaffSession);
const tables=document.querySelector('#tables'); tables.innerHTML='<div class="queue-empty">Загрузка схемы зала…</div>';
let openOrders=[];
let currentOrder=null;
let floorVenueId='';
let floorReady=false;
let ordersRequestRevision=0;
let orderPricingRevision=0;
const normalizeTableId=(value)=>{const raw=String(value||'').trim();return raw.startsWith('table-')?raw:(/^\d+$/.test(raw)?`table-${raw}`:raw);};
let serverZones=[];
const escapeFloorText=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const floorTableFor=(id)=>{const raw=String(id??'').trim();return serverZones.flatMap((zone)=>zone.tables||[]).find((table)=>String(table.id)===raw||normalizeTableId(table.id)===normalizeTableId(raw));};
const floorTableLabel=(id)=>{const raw=String(id??'').trim();const table=floorTableFor(raw);return table?.name||({'vip-room-1':'VIP-комната 1','vip-room-2':'VIP-комната 2'}[raw]||`Стол ${raw.replace(/^table-/,'')||'—'}`);};
const readDemoVipMinimums=()=>{
  try{
    const raw=localStorage.getItem('territory_crm_demo_state');
    const venue=raw?JSON.parse(raw)?.venue:null;
    const configured=venue?.vipRoomMinimums||{};
    return {
      'vip-room-1':Number(configured['vip-room-1']??configured.vipRoom1??1500),
      'vip-room-2':Number(configured['vip-room-2']??configured.vipRoom2??2500)
    };
  }catch(_){return {'vip-room-1':1500,'vip-room-2':2500};}
};
const tableMinimums=readDemoVipMinimums();
const orderHeaders=()=>({...sessionHeaders(),'Content-Type':'application/json'});
const localOrders=()=>{try{return JSON.parse(localStorage.getItem('territory_crm_staff_orders')||'[]');}catch(_){return[];}};
const localStaffClients=()=>{try{const direct=JSON.parse(localStorage.getItem('crm_demo_clients')||'[]');if(Array.isArray(direct)&&direct.length)return direct;const state=JSON.parse(localStorage.getItem('territory_crm_demo_state')||'{}');return Array.isArray(state.clients)?state.clients:[];}catch(_){return[];}};
const saveLocalOrders=(items)=>localStorage.setItem('territory_crm_staff_orders',JSON.stringify(items));
const localApprovedDiscountTotal=(orderId,subtotal)=>{let requests=[];try{requests=JSON.parse(localStorage.getItem('territory_crm_discount_requests')||'[]');}catch(_){requests=[];}return Math.min(localMoneyCents(subtotal),localMoneyCents(requests.filter((request)=>request.orderId===orderId&&request.status==='approved'&&request.type==='percent').reduce((sum,request)=>sum+Math.round(subtotal*Math.min(100,Math.max(0,Number(request.value||0)))/100*100)/100,0)))/100;};
const localMoneyCents=(value)=>Math.round(Number(value||0)*100);
const localReceivedPayments=(order)=>(order.payments||[]).filter((payment)=>['paid','partially_paid'].includes(payment.status)).reduce((sum,payment)=>sum+Number(payment.amount||0),0);
const localOrderSubtotal=(items)=>(items||[]).reduce((sum,item)=>sum+Number(item.unitPrice||0)*Number(item.quantity||0),0);
const localOrderPricing=(order,items=order.items)=>{if(order.status==='closed'&&order.pricingVersion&&order.finalTotalSnapshot!=null)return{subtotal:Number(order.subtotalSnapshot||0),discount:Number(order.discountTotalSnapshot||0),net:Math.max(0,Number(order.subtotalSnapshot||0)-Number(order.discountTotalSnapshot||0)),due:Number(order.finalTotalSnapshot||0),minimumAdjustment:Number(order.minimumAdjustmentSnapshot||0),source:order.effectiveDiscountSource||'none',groupDiscountAmount:order.groupDiscountAmount??null};const subtotal=Math.round(localOrderSubtotal(items)*100)/100;const manual=localApprovedDiscountTotal(order.id,subtotal);const candidate=Math.min(localMoneyCents(subtotal),Math.round(subtotal*Math.min(100,Math.max(0,Number(order.groupDiscountPercent||0)))/100*100))/100;const useGroup=Boolean(order.groupDiscountGroupId)&&candidate>=manual;const discount=useGroup?candidate:manual;const net=Math.max(0,subtotal-discount);const minimum=Number(order.minimumOrderTotal||0);return{subtotal,discount,net,due:Math.max(net,minimum),minimumAdjustment:Math.max(0,minimum-net),source:discount<=0?'none':useGroup?'guest_group':'manual',groupDiscountAmount:order.groupDiscountGroupId?(useGroup?candidate:0):null};};
const localOrderDue=(order,items=order.items)=>localOrderPricing(order,items).due;
const localAssertPaidCovered=(order,items=order.items)=>{const paid=localReceivedPayments(order),due=localOrderDue(order,items);if(localMoneyCents(paid)>localMoneyCents(due)){const error=new Error('order_total_below_paid');error.payload={error:'order_total_below_paid',paid,proposedDue:due};throw error;}};
const staticAuditEvent=(action,entityId,details={})=>{if(!staticStaffDemo())return;let events=[];try{events=JSON.parse(localStorage.getItem('territory_crm_demo_audits')||'[]');}catch(_){events=[];}const user=JSON.parse(localStorage.getItem('crm_session_user')||'{}');events.push({id:`local-audit-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,action,entity:'order',entityType:'order',entityId,actor:user.name||'сотрудник',createdAt:new Date().toISOString(),details});localStorage.setItem('territory_crm_demo_audits',JSON.stringify(events.slice(-300)));};
const localOrderStatusTransitions={open:['open','in_progress','cancelled'],in_progress:['in_progress','ready','open','cancelled'],ready:['ready','closed','in_progress','cancelled'],closed:['closed'],cancelled:['cancelled']};
const staticOrderApi=async(url,options={})=>{const path=new URL(url,location.origin).pathname;const method=options.method||'GET';const input=options.body?JSON.parse(options.body):{};let list=localOrders();const orderEdit=path.match(/^\/api\/orders\/([^/]+)$/);if(orderEdit&&method==='PATCH'){const order=list.find(x=>x.id===orderEdit[1]);if(!order)throw new Error('HTTP 404');if(input.notes!==undefined)order.notes=String(input.notes||'').slice(0,2000);if(input.clientId===null||input.detachGuest===true){order.clientId=null;order.guestName='';order.guestPhone='';}else if(input.clientId!==undefined&&String(input.clientId).trim()){const clients=localStaffClients();const client=clients.find(x=>x.id===String(input.clientId));if(!client)throw new Error('client_not_found');order.clientId=client.id;order.guestName=client.name;order.guestPhone=(client.phoneNumbers||[]).find(x=>x.primary)?.number||(client.phoneNumbers||[])[0]?.number||'';}else if(input.guestName!==undefined||input.phone!==undefined){const phone=String(input.phone||'').trim();if(phone&&!/^\+7[0-9 ()-]{7,24}$/.test(phone))throw new Error('invalid_guest_phone');order.clientId=null;order.guestName=String(input.guestName||'').trim().slice(0,120);order.guestPhone=phone;}saveLocalOrders(list);return {...order,guestName:order.guestName,phone:order.guestPhone};}if(path==='/api/orders'&&method==='GET')return{items:list};if(path==='/api/orders'&&method==='POST'){const minimumOrderTotal=Number(input.minimumOrderTotal||0);const tableId=normalizeTableId(input.tableId);if(!tableId||tableId.length>80)throw new Error('table_id_required');if(!Number.isFinite(minimumOrderTotal)||minimumOrderTotal<0)throw new Error('invalid_vip_minimum');const duplicate=list.find((candidate)=>normalizeTableId(candidate.tableId)===tableId&&!['closed','cancelled'].includes(candidate.status));if(duplicate)throw new Error('table_has_active_order');const order={id:`local-order-${Date.now()}`,tableId,minimumOrderTotal,status:'open',items:[]};list.push(order);staticAuditEvent('order.created',order.id,{tableId:order.tableId,minimumOrderTotal:order.minimumOrderTotal});saveLocalOrders(list);return order;}if(orderEdit&&method==='DELETE'){
const order=list.find(x=>x.id===orderEdit[1]);
const comment=String(input.comment||'').trim();
if(!order)throw new Error('HTTP 404');
if(!comment||comment.length>1000)throw new Error('order_delete_comment_required');
if(typeof input.writeoff!=='boolean')throw new Error('order_delete_writeoff_required');
if(['closed','cancelled'].includes(order.status))throw new Error('order_not_deletable');if(localMoneyCents(localReceivedPayments(order))>0)throw new Error('paid_order_cannot_cancel');
const before={status:order.status,items:order.items||[]};
order.status='cancelled';order.notes=[order.notes,`Удалён заказ: ${comment}`].filter(Boolean).join(' · ');
staticAuditEvent('order.deleted',order.id,{comment,writeoff:Boolean(input.writeoff),deletedItems:order.items||[],notificationRecipients:['owner','admin','manager']});
let notifications=[];try{notifications=JSON.parse(localStorage.getItem('territory_crm_staff_notifications')||'[]');}catch(_){}
notifications.push({id:`local-order-deleted-${Date.now()}`,venueId:floorVenueId,type:'order_deleted',orderId:order.id,comment,writeoff:Boolean(input.writeoff),deletedItems:order.items||[],createdAt:new Date().toISOString(),notificationRecipients:['owner','admin','manager']});
localStorage.setItem('territory_crm_staff_notifications',JSON.stringify(notifications.slice(-100)));
saveLocalOrders(list);return {...order,deleted:true,before};
}
const item=path.match(/^\/api\/orders\/([^/]+)\/items(?:\/([^/]+))?$/);if(item&&method==='POST'){const order=list.find(x=>x.id===item[1]);if(!order||['closed','cancelled'].includes(order.status))throw new Error('order_not_editable');const quantity=Number(input.quantity||1);if(!Number.isInteger(quantity)||quantity<1||quantity>999)throw new Error('invalid_quantity');const product=products.find(x=>x[4]===input.productId||x[0]===input.productId);if(!product)throw new Error('product_not_found');if(['salesEmployeeId','sales_employee_id','soldAt','sold_at'].some((field)=>Object.prototype.hasOwnProperty.call(input,field)))throw new Error('sales_attribution_server_managed');let user={};try{user=JSON.parse(localStorage.getItem('crm_session_user')||'{}');}catch(_){}if(!user.id)throw new Error('sales_employee_session_required');const added={id:'local-item-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),productId:input.productId,name:product?.[0]||input.productId,quantity,unitPrice:Number(product?.[1]||0),salesEmployeeId:user.id,salesEmployeeName:user.name||user.fullName||null,soldAt:new Date().toISOString(),salesAttributionStatus:'demo_unverified'};order.items.push(added);try{localAssertPaidCovered(order);}catch(error){order.items.pop();throw error;}staticAuditEvent('order.item_added',order.id,{itemId:added.id,salesEmployeeId:added.salesEmployeeId,soldAt:added.soldAt});saveLocalOrders(list);return added;}if(item&&(method==='PATCH'||method==='DELETE')){const order=list.find(x=>x.id===item[1]);if(!order||['closed','cancelled'].includes(order.status))throw new Error('order_not_editable');const entry=order.items?.find(x=>x.id===item[2]);if(!entry)throw new Error('HTTP 404');if(method==='DELETE'){const proposedItems=order.items.filter(x=>x.id!==entry.id);localAssertPaidCovered(order,proposedItems);order.items=proposedItems;staticAuditEvent('order.item_removed',order.id,{itemId:entry.id});saveLocalOrders(list);return{id:entry.id};}const quantity=Number(input.quantity);if(!Number.isInteger(quantity)||quantity<1||quantity>999)throw new Error('invalid_quantity');const before=entry.quantity;entry.quantity=quantity;try{localAssertPaidCovered(order);}catch(error){entry.quantity=before;throw error;}staticAuditEvent('order.item_quantity_changed',order.id,{itemId:entry.id,from:before,to:quantity});saveLocalOrders(list);return entry;}const action=path.match(/^\/api\/orders\/([^/]+)\/(status|transfer|close|payments|discount-requests)$/);if(action){const order=list.find(x=>x.id===action[1]);if(!order)throw new Error('HTTP 404');if(action[2]==='discount-requests'){if(['closed','cancelled'].includes(order.status))throw new Error('order_already_final');const type=String(input.type||'percent');const value=Number(input.value);const reason=String(input.reason||'').trim();if(type!=='percent'||!Number.isFinite(value)||value<=0||value>100||!reason||reason.length>500)throw new Error('invalid_discount_request');const key='territory_crm_discount_requests';let requests=[];try{requests=JSON.parse(localStorage.getItem(key)||'[]');}catch(_){requests=[];}if(requests.some((entry)=>entry.orderId===order.id&&entry.status==='requested'))throw new Error('discount_request_pending');const sessionUser=JSON.parse(localStorage.getItem('crm_session_user')||'{}');const request={id:`local-discount-${Date.now()}`,venueId:String(floorVenueId),orderId:order.id,type,value,reason,guestName:order.guestName||null,guestPhone:order.guestPhone||null,status:'requested',requestedBy:sessionUser.name||'сотрудник',createdAt:new Date().toISOString(),notificationRecipients:['owner','admin']};requests.push(request);localStorage.setItem(key,JSON.stringify(requests));staticAuditEvent('discount.applied_by_staff',order.id,{requestId:request.id,type:request.type,value:request.value,reason:request.reason,notificationRecipients:request.notificationRecipients});return request;}if(action[2]==='status'){if(!localOrderStatusTransitions[order.status]?.includes(input.status))throw new Error('invalid_order_transition');if(input.status==='cancelled'&&localMoneyCents(localReceivedPayments(order))>0)throw new Error('paid_order_cannot_cancel');const before=order.status;order.status=input.status;staticAuditEvent('order.status_changed',order.id,{from:before,to:input.status});}if(action[2]==='transfer'){const tableId=String(input.tableId||'').trim();if(!tableId||tableId.length>80)throw new Error('table_id_required');const before=order.tableId;order.tableId=tableId;staticAuditEvent('order.transferred',order.id,{from:before,to:input.tableId});}if(action[2]==='close'){if(!['open','in_progress','ready'].includes(order.status))throw new Error('invalid_order_transition');if(!['cash','card','qr'].includes(String(input.paymentMethod||'cash')))throw new Error('valid_payment_method_required');const subtotal=localOrderSubtotal(order.items);const pricing=localOrderPricing(order);const discount=pricing.discount;const finalTotal=pricing.due;const alreadyPaid=localReceivedPayments(order);if(localMoneyCents(alreadyPaid)>localMoneyCents(finalTotal))throw new Error('order_total_below_paid');order.status='closed';order.closedAt=new Date().toISOString();order.subtotal=subtotal;order.discountTotal=discount;order.finalTotal=finalTotal;order.payments ||= [];const remaining=Math.max(0,finalTotal-alreadyPaid);if(remaining>0)order.payments.push({id:`local-pay-${Date.now()}`,method:input.paymentMethod||'cash',amount:remaining,status:'paid',createdAt:new Date().toISOString()});order.paid=alreadyPaid+remaining;order.remaining=0;order.minimumAdjustment=pricing.minimumAdjustment;order.paymentMethod=input.paymentMethod||'cash';order.effectiveDiscountSource=pricing.source;order.groupDiscountBase=pricing.groupDiscountBase;order.groupDiscountAmount=pricing.groupDiscountAmount;order.subtotalSnapshot=subtotal;order.discountTotalSnapshot=discount;order.minimumAdjustmentSnapshot=pricing.minimumAdjustment;order.finalTotalSnapshot=finalTotal;order.pricingVersion=1;staticAuditEvent('order.closed',order.id,{finalTotal:order.finalTotal,discountTotal:discount,minimumAdjustment:order.minimumAdjustment,paymentMethod:order.paymentMethod});}if(action[2]==='payments'){if(['closed','cancelled'].includes(order.status)&&method==='POST')throw new Error('order_already_final');order.payments ||= [];const subtotal=(order.items||[]).reduce((s,x)=>s+x.unitPrice*x.quantity,0);const pricing=localOrderPricing(order);const due=pricing.due;const paid=localReceivedPayments(order);const guest=localStaffClients().find((entry)=>entry.id===(order.clientId||order.guestId));if(method==='GET')return{items:order.payments,...pricing,guestAccount:guest?{guestId:guest.id,bonusBalance:Number(guest.loyaltyPoints??guest.bonusBalance??0),conversionRate:1}:null,paid,remaining:Math.max(0,due-paid)};const amount=Number(input.amount);const tender=String(input.method||'cash');const idempotencyKey=String(input.idempotencyKey||'').trim();const prior=idempotencyKey&&order.payments.find((entry)=>entry.idempotencyKey===idempotencyKey);if(prior){if(prior.method!==tender||Number(prior.amount)!==amount)throw new Error('idempotency_key_reused');return{...prior,due,paid:localReceivedPayments(order),remaining:Math.max(0,due-localReceivedPayments(order)),closed:order.status==='closed',idempotentReplay:true};}if(!['cash','card','qr','bonus'].includes(tender)||!Number.isFinite(amount)||localMoneyCents(amount)<=0||Math.abs(amount*100-localMoneyCents(amount))>1e-7||localMoneyCents(paid)+localMoneyCents(amount)>localMoneyCents(due)||(tender==='bonus'&&(!Number.isInteger(amount)||!idempotencyKey||!guest||Number(guest.loyaltyPoints??guest.bonusBalance??0)<amount)))throw new Error(tender==='bonus'&&!guest?'guest_required_for_bonus':tender==='bonus'&&guest&&Number(guest.loyaltyPoints??guest.bonusBalance??0)<amount?'insufficient_bonus_balance':'HTTP 409');const payment={id:`local-pay-${Date.now()}`,method:tender,amount,status:'paid',idempotencyKey:idempotencyKey||null,createdAt:new Date().toISOString()};order.payments.push(payment);let bonusBalance=null;if(tender==='bonus'){guest.loyaltyPoints=Number(guest.loyaltyPoints??guest.bonusBalance??0)-amount;guest.bonusBalance=guest.loyaltyPoints;guest.accountEntries||=[];guest.accountEntries.unshift({id:`local-account-${Date.now()}`,accountType:'bonus',amount:-amount,reason:'Списание бонусов в оплату заказа',sourceType:'order',sourceId:order.id,sourceKey:`order:${order.id}:bonus-redeem:${idempotencyKey}`,createdAt:payment.createdAt});localStorage.setItem('crm_demo_clients',JSON.stringify(localStaffClients()));}const nextPaid=paid+amount;const closed=localMoneyCents(nextPaid)>=localMoneyCents(due);if(closed){order.status='closed';order.closedAt=payment.createdAt;order.subtotal=subtotal;order.discountTotal=pricing.discount;order.finalTotal=due;order.minimumAdjustment=pricing.minimumAdjustment;order.effectiveDiscountSource=pricing.source;order.groupDiscountBase=pricing.groupDiscountBase;order.groupDiscountAmount=pricing.groupDiscountAmount;order.subtotalSnapshot=subtotal;order.discountTotalSnapshot=pricing.discount;order.minimumAdjustmentSnapshot=pricing.minimumAdjustment;order.finalTotalSnapshot=due;order.pricingVersion=1;order.paymentMethod=order.payments.length===1?payment.method:'mixed';order.paid=nextPaid;order.remaining=0;}staticAuditEvent('order.payment_added',order.id,{paymentId:payment.id,method:payment.method,amount:payment.amount,paid:nextPaid,remaining:Math.max(0,due-nextPaid),closed});saveLocalOrders(list);return{...payment,guestAccount:tender==='bonus'?{guestId:guest.id,bonusBalance,conversionRate:1}:undefined,due,paid:nextPaid,remaining:Math.max(0,due-nextPaid),closed,...(closed?{finalTotal:order.finalTotal,discountTotal:order.discountTotal,minimumAdjustment:order.minimumAdjustment,paymentMethod:order.paymentMethod}:{})};}saveLocalOrders(list);return order;}return{};};
const staticSplitApi=async(url,options={})=>{const path=new URL(url,location.origin).pathname;const match=path.match(/^\/api\/orders\/([^/]+)\/split$/);if(!match)return null;const input=options.body?JSON.parse(options.body):{};const list=localOrders();const source=list.find((x)=>x.id===match[1]);if(!source)throw new Error('HTTP 404');if(!['open','in_progress','ready'].includes(source.status))throw new Error('invalid_order_transition');const requested=Array.isArray(input.itemIds)?input.itemIds:[];if(!requested.length)throw new Error('item_ids_required');if(requested.some((id)=>typeof id!=='string'||!id.trim())||new Set(requested).size!==requested.length)throw new Error('invalid_item_ids');const ids=new Set(requested);const moved=(source.items||[]).filter((x)=>ids.has(x.id));if(moved.length!==requested.length)throw new Error('item_ids_not_in_order');const remainingItems=(source.items||[]).filter((x)=>!ids.has(x.id));localAssertPaidCovered(source,remainingItems);if(moved.length>=(source.items||[]).length)throw new Error('split_requires_remaining_item');source.items=remainingItems;const target={id:`local-order-${Date.now()}`,tableId:source.tableId,status:'open',minimumOrderTotal:0,clientId:source.clientId||null,guestName:source.guestName||null,guestPhone:source.guestPhone||null,notes:source.notes||'',items:moved,splitFrom:source.id};list.push(target);staticAuditEvent('order.split',source.id,{targetOrderId:target.id,itemIds:[...ids],movedCount:moved.length});saveLocalOrders(list);return target;};
const apiJson=async(url,options={})=>{if(!staffSessionVerified)throw new Error('session_unverified');if(url.includes('/discount-requests')&&options.body){try{if(JSON.parse(options.body).type==='fixed')throw new Error('invalid_discount_request');}catch(error){if(error.message==='invalid_discount_request')throw error;}}if(!staticStaffDemo())return staffFetchJson(url,options);const method=options.method||'GET';const path=new URL(url,location.origin).pathname;const summary=path.match(/^\/api\/orders\/([^/]+)\/summary$/);if(summary&&method==='GET'){const order=localOrders().find((entry)=>entry.id===summary[1]);if(!order)throw new Error('HTTP 404');const pricing=localOrderPricing(order);return{orderId:order.id,...pricing,minimum:Number(order.minimumOrderTotal||0),shortfall:pricing.minimumAdjustment,minimumApplied:Number(order.minimumOrderTotal||0)>0};}const edit=path.match(/^\/api\/orders\/([^/]+)$/);if(edit&&method==='PATCH'){const before=localOrders().find((entry)=>entry.id===edit[1]);const priorGuest=before?.clientId||null;const body=options.body?JSON.parse(options.body):{};const saved=await staticOrderApi(url,options);const list=localOrders();const order=list.find((entry)=>entry.id===edit[1]);if(order&&(body.clientId!==undefined||body.guestName!==undefined||body.phone!==undefined||body.detachGuest)){if(order.clientId!==priorGuest){const guest=localStaffClients().find((entry)=>entry.id===order.clientId);order.groupDiscountGroupId=guest?.discountGroupId||null;order.groupDiscountName=guest?.discountGroupName||null;order.groupDiscountPercent=order.groupDiscountGroupId?Number(guest?.discountPercent||0):null;order.groupDiscountBase=null;order.groupDiscountAmount=null;}const pricing=localOrderPricing(order);if(localMoneyCents(localReceivedPayments(order))>localMoneyCents(pricing.due))throw new Error('paid_order_total_conflict');saveLocalOrders(list);return{...saved,...pricing,guestId:order.clientId||null,groupDiscountGroupId:order.groupDiscountGroupId||null,groupDiscountName:order.groupDiscountName||null,groupDiscountPercent:order.groupDiscountPercent??null};}return saved;}return method==='POST'&&path.endsWith('/split')?staticSplitApi(url,options):staticOrderApi(url,options);};
let currentShift=null;
const staticShiftNotificationsApi=async(url,options={})=>{
  const user=JSON.parse(localStorage.getItem('crm_session_user')||'{}');const venueId=user.venueId||'venue-territory';const readKey=`territory_crm_notification_reads:${user.id||user.login||user.role}:${venueId}`;
  let events=[],reads={};try{events=JSON.parse(localStorage.getItem('territory_crm_shift_events')||'[]');reads=JSON.parse(localStorage.getItem(readKey)||'{}');}catch(_){}
  const items=events.filter(e=>e.venueId===venueId&&['shift.opened','shift.closed'].includes(e.action)).map(e=>({id:`${e.action.replace('.','_')}:${e.id}`,type:e.action.replace('.','_'),title:e.action==='shift.opened'?'Смена открыта':'Смена закрыта',summary:'Состояние рабочей смены изменилось',createdAt:e.createdAt,shiftId:e.entityId,href:'/admin#shift-control',requiresAction:false,readAt:reads[`${e.action.replace('.','_')}:${e.id}`]||null})).reverse();
  const unreadCount=()=>items.filter(e=>!reads[e.id]).length;
  if(options.method==='POST'){const readAt=new Date().toISOString();items.forEach(e=>reads[e.id]=readAt);localStorage.setItem(readKey,JSON.stringify(reads));return {unreadCount:0};}
  if(options.method==='PUT'){const id=decodeURIComponent(url.match(/^\/api\/notifications\/([^/]+)\/read$/)?.[1]||'');if(!items.some(e=>e.id===id))throw Error('notification_not_found');reads[id]=new Date().toISOString();localStorage.setItem(readKey,JSON.stringify(reads));return {id,readAt:reads[id],unreadCount:unreadCount()};}
  const query=new URL(url,location.origin).searchParams;const selected=items.filter(e=>query.get('filter')!=='unread'||!e.readAt);return {items:selected.slice(0,20),unreadCount:unreadCount(),hasMore:selected.length>20};
};
const validStaticShiftCash=(value)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100000000&&Math.abs(value*100-Math.round(value*100))<1e-7;
const saveStaticShiftEvent=(shift,action)=>{let events=[];try{events=JSON.parse(localStorage.getItem('territory_crm_shift_events')||'[]');}catch(_){}let user={};try{user=JSON.parse(localStorage.getItem('crm_session_user')||'{}');}catch(_){}events.push({id:`shift-event-${Date.now()}-${events.length}`,action,entityId:shift.id,venueId:shift.venueId||user.venueId||'venue-territory',createdAt:new Date().toISOString()});localStorage.setItem('territory_crm_shift_events',JSON.stringify(events));};
const shiftApi=(options={})=>{
  if(staticStaffDemo()){
    let saved;try{saved=JSON.parse(localStorage.getItem('territory_crm_shift')||'null');}catch(_){saved=null;}
    const snapshotPath=String(options.url||'').match(/^\/api\/shifts\/([^/]+)\/close-snapshot$/);
    if(options.method==='GET'&&snapshotPath){if(!saved||saved.id!==snapshotPath[1]||!saved.closeSnapshot)return Promise.reject(new Error('shift_close_snapshot_not_found'));return Promise.resolve(saved.closeSnapshot);}
    if(!options.method)return Promise.resolve({items:saved?[saved]:[],current:saved&&!saved.closedAt?saved:null});
    const input=JSON.parse(options.body||'{}');
    if(options.method==='POST'&&options.url?.endsWith('/close')){
      if(!saved||saved.closedAt||options.url!==`/api/shifts/${saved.id}/close`)return Promise.reject(new Error('shift_not_found_or_closed'));
      if(!window.HOOKAH_SHIFT_CLOSE?.validateChecklist(input.checklist))return Promise.reject(new Error('shift_checklist_required'));
      if(!validStaticShiftCash(input.closingCash))return Promise.reject(new Error('closing_cash_required'));
      saved.closedAt=new Date().toISOString();saved.closedById=JSON.parse(localStorage.getItem('crm_session_user')||'{}').id||null;saved.closingCash=input.closingCash;saved.expectedCash=Number(saved.openingCash||0);saved.cashVariance=saved.closingCash-saved.expectedCash;saved.closeSnapshot={id:`local-close-${Date.now()}`,venueId:saved.venueId,shiftId:saved.id,schemaVersion:1,checklistVersion:input.checklist.version,capturedAt:saved.closedAt,closedBy:saved.closedById,sha256:null,payload:{kind:'internal_pos_shift_close',reportLabel:'Внутренний снимок закрытия смены HOOKAH POS',fiscalDocument:false,fiscalNote:'Демонстрационный снимок в браузере; не является фискальным Z-отчётом.',schemaVersion:1,currency:'RUB',venueId:saved.venueId,shift:{id:saved.id,openedAt:saved.openedAt,closedAt:saved.closedAt,closedBy:saved.closedById},checklist:window.HOOKAH_SHIFT_CLOSE.freezeChecklist(input.checklist,saved.closedById,saved.closedAt),cashReconciliation:{openingCash:Number(saved.openingCash||0),expectedCash:saved.expectedCash,actualCash:saved.closingCash,variance:saved.cashVariance},ledger:{coverage:'browser_demo_unverified'}}};localStorage.setItem('territory_crm_shift',JSON.stringify(saved));saveStaticShiftEvent(saved,'shift.closed');return Promise.resolve(saved);
    }
    if(!validStaticShiftCash(input.openingCash))return Promise.reject(new Error('opening_cash_required'));
    if(saved&&!saved.closedAt)return Promise.reject(new Error('shift_already_open'));
    let user={};try{user=JSON.parse(localStorage.getItem('crm_session_user')||'{}');}catch(_){}
    saved={id:`local-shift-${Date.now()}`,venueId:user.venueId||'venue-territory',openedAt:new Date().toISOString(),closedAt:null,openingCash:input.openingCash};localStorage.setItem('territory_crm_shift',JSON.stringify(saved));saveStaticShiftEvent(saved,'shift.opened');return Promise.resolve(saved);
  }
  if(!staffSessionVerified)return Promise.reject(new Error('session_unverified'));
  return staffFetchJson(options.url||'/api/shifts',options).catch(error=>{error.code=error.payload?.error;throw error;});
};
const shiftCloseFailureMessage=(error)=>{if(error?.code!=='shift_cash_attribution_unresolved')return 'Не удалось закрыть смену';const details=error.payload||{};const count=Number(details.count);const amount=Number(details.amount);const countText=Number.isFinite(count)&&count>=0?String(Math.floor(count)):'неизвестно';const amountText=Number.isFinite(amount)&&amount>=0?`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(amount)} ₽`:'неизвестна';return `Смена осталась открытой. Платежей без привязки: ${countText}; сумма: ${amountText}. Попросите управляющего сверить эти платежи, затем повторите закрытие.`;};
const shiftCashCloseDescription=(shift)=>{const format=(value)=>`${new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value)} ₽`;const unresolved=Number(shift?.unresolvedLegacyCashCount||0);if(unresolved>0)return `Ожидаемую кассу нельзя рассчитать: ${unresolved} наличных платежа на ${format(Number(shift.unresolvedLegacyCashAmount||0))} без привязки к смене. Запрос закрытия будет отклонён, пока управляющий не сверит эти платежи.`;if(shift?.expectedCash!==null&&shift?.expectedCash!==undefined&&Number.isFinite(Number(shift.expectedCash)))return `Ожидаемая наличность по данным системы: ${format(Number(shift.expectedCash))}. Введите фактический остаток; при закрытии сервер пересчитает сумму с учётом новых операций.`;return 'Ожидаемая наличность сейчас недоступна. Проверьте соединение и обновите состояние смены перед закрытием.';};
const shiftCloseResultMessage=(result)=>{const format=(value)=>`${new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value||0))} ₽`;if(result?.expectedCash===undefined||result?.closingCash===undefined||result?.cashVariance===undefined)return 'Смена закрыта';const variance=Number(result.cashVariance);const sign=variance>0?'+':'';return `Смена закрыта. Ожидалось: ${format(result.expectedCash)}; фактически: ${format(result.closingCash)}; разница: ${sign}${format(variance)}.`;};
const renderStaffShiftControl=(state)=>{
  const button=document.querySelector('#shift-toggle');if(!button)return;
  const view={loading:['Проверяем смену…','Проверка','Проверяем смену'],closed:['Смена закрыта','Открыть','Открыть смену'],open:['Смена открыта','Закрыть','Закрыть смену'],error:['Смена недоступна','Повтор','Повторить проверку смены'],saving:['Сохраняем смену…','Ждите','Сохраняем смену']}[state];
  button.dataset.shiftState=state;button.disabled=!staffShiftManageable||state==='loading'||state==='saving';button.setAttribute('aria-busy',String(state==='loading'||state==='saving'));button.setAttribute('aria-label',staffShiftManageable?view[2]:view[0]);button.title=staffShiftManageable?view[2]:view[0];
  button.innerHTML=`${staffIcon(state==='open'?'circle-check':'clock')}<span class="shift-state-label">${view[0]}</span><span class="shift-action-label">${staffShiftManageable?view[1]:view[0]}</span>`;
};
let shiftRefreshPending=null;
const refreshShift=({silent=false}={})=>{
  if(!staffShiftReadable)return Promise.resolve();
  if(shiftRefreshPending)return shiftRefreshPending;if(!silent)renderStaffShiftControl('loading');
  shiftRefreshPending=shiftApi().then((result)=>{currentShift=result.current||null;renderStaffShiftControl(currentShift?'open':'closed');}).catch(()=>{renderStaffShiftControl('error');if(!silent)notice('Не удалось проверить состояние смены. Повторите проверку.');}).finally(()=>{shiftRefreshPending=null;});return shiftRefreshPending;
};
if(staffSessionVerified)refreshShift();
const orderRows=document.querySelector('.items');
(()=>{const order=document.querySelector('.order');if(!order||order.querySelector('.order-more'))return;const ids=['discount-request','split-order','split-payment','transfer-order','print-receipt','order-delete'];const buttons=ids.map((id)=>document.getElementById(id)).filter(Boolean);if(!buttons.length)return;const details=document.createElement('details');details.className='order-more';details.innerHTML='<summary>Ещё действия</summary>';const body=document.createElement('div');body.className='order-more-list';buttons.forEach((button)=>body.append(button));details.append(body);const close=order.querySelector('.close');(close||order.lastElementChild)?.insertAdjacentElement('beforebegin',details);})();
const tableContextActions=(()=>{const existing=document.querySelector('#table-context-actions');if(existing)return existing;const meta=document.querySelector('.order .meta');if(!meta)return null;const node=document.createElement('div');node.id='table-context-actions';node.className='table-context-actions';node.setAttribute('aria-label','Быстрые действия со столом');meta.insertAdjacentElement('afterend',node);return node;})();
const drawTableContextActions=(table,order)=>{if(!tableContextActions)return;const status=table?.status||'free';const tableId=table?.id||order?.tableId||'';const disabled=table?.status==='blocked';if(!tableId){tableContextActions.replaceChildren();return;}const buttons=[['secondary','Закрыть карточку','close-panel']];if(status==='free'&&!disabled){buttons.push(['primary','Новый заказ','new-order']);buttons.push(['secondary','Забронировать','reserve']);}else if(status==='occupied'||order?.id){buttons.push(['primary','Добавить позицию','add-position']);buttons.push(['secondary','Перенести','transfer']);}else if(status==='reserved'){buttons.push(['primary','Открыть бронь','open-reservation']);buttons.push(['secondary','Гость пришёл','seat-guest']);}else if(status==='awaiting_payment'){buttons.push(['primary','Открыть оплату','open-payment']);}tableContextActions.innerHTML=buttons.map(([kind,label,action])=>`<button type="button" class="${kind}" data-table-action="${action}">${staffIcon(action==='reserve'||action==='open-reservation'?'calendar-event':action==='transfer'?'arrows-right':action==='close-panel'?'x':action==='open-payment'?'cash':'plus')}<span>${label}</span></button>`).join('');};
function drawOrder(order){
  currentOrder=order||null;
  const selectedTable=order?.tableId?floorTableFor(order.tableId):document.querySelector('.table.sel')?floorTableFor(document.querySelector('.table.sel').dataset.table):null;
  drawTableContextActions(selectedTable,order);
  const title=document.querySelector('.order h2');
  const tableLabel=order?.tableName || (order?.tableId ? floorTableLabel(order.tableId) : order?.id ? 'Заказ без стола' : 'Стол не выбран');
  if(title) title.textContent=tableLabel;
  if(!orderRows)return;
  const items=order?.items||[];
  const orderEditable=Boolean(order?.id)&&!['closed','cancelled'].includes(order?.status);
  orderRows.innerHTML=items.length?items.map(item=>`<div class="order-item-row" data-item-id="${escapeFloorText(item.id)}"><span><span>${escapeFloorText(displayProductName(item.name||item.productName||'Позиция'))}</span><small class="order-item-attribution" style="display:block;color:var(--muted);font-size:11px">${(staticStaffDemo()||item.salesAttributionStatus==='demo_unverified')?'ДЕМО · не подтверждено · ':''}${item.salesEmployeeName?escapeFloorText(item.salesEmployeeName):'Автор продажи не зафиксирован'}${item.soldAt?` · ${(staticStaffDemo()||item.salesAttributionStatus==='demo_unverified')?'локально · ':''}${escapeFloorText(new Date(item.soldAt).toLocaleString())}`:''}</small></span><span class="quantity-control"><button type="button" class="qty-minus" data-item="${escapeFloorText(item.id)}" aria-label="Уменьшить" ${orderEditable?'':'disabled title="Закрытый заказ нельзя изменить"'}>${staffIcon('minus')}</button><b>${Number(item.quantity||1)}</b><button type="button" class="qty-plus" data-item="${escapeFloorText(item.id)}" aria-label="Увеличить" ${orderEditable?'':'disabled title="Закрытый заказ нельзя изменить"'}>${staffIcon('plus')}</button></span><b data-line-total="${Number(item.unitPrice??item.price??0)*Number(item.quantity||1)}">${Number(item.unitPrice??item.price??0)*Number(item.quantity||1)} ₽</b></div>`).join(''):'<div class="empty-order">Позиции пока не добавлены</div>';
  const meta=document.querySelector('.meta'); if(meta){const guests=Number(order?.guests);const guestMeta=Number.isInteger(guests)&&guests>0?`👥 ${guests} ${pluralRu(guests,'гость','гостя','гостей')}`:'';meta.textContent=order?.tableId?[guestMeta,order?.guestName,order?.guestPhone?'☎ '+order.guestPhone:'','⏱ обслуживание'].filter(Boolean).join(' · '):'Выберите стол, чтобы начать заказ';}
  const editable=orderEditable&&Boolean((order?.items||[]).length);const addPosition=document.querySelector('.order > .primary');if(addPosition){addPosition.disabled=!order?.tableId||Boolean(order?.id)&&!orderEditable;addPosition.title=!order?.tableId?'Сначала выберите стол':addPosition.disabled?'Закрытый заказ нельзя изменить':'';}document.querySelectorAll('.order-tabs button,.actions button,#discount-request,#split-order,#split-payment,#transfer-order,#print-receipt,.close').forEach((button)=>{button.disabled=!order?.tableId||!orderEditable||(!button.closest('.order-tabs')&&!editable);button.title=order?.tableId?(editable?'':'Сначала откройте активный заказ с позициями'):'Сначала выберите стол';});const printButton=document.querySelector('#print-receipt');if(printButton){printButton.disabled=!order?.id||!(order.items||[]).length||order.status==='cancelled';printButton.title=printButton.disabled?'Для печати нужен действующий или закрытый заказ с позициями':'Печать чека';}const deleteButton=document.querySelector('#order-delete');if(deleteButton){deleteButton.disabled=!order?.tableId||!orderEditable;deleteButton.title=!order?.tableId?'Сначала выберите стол':orderEditable?'Удалить заказ с обязательной причиной':'Закрытый заказ нельзя удалить';}
  const status=document.querySelector('.status');if(status)status.innerHTML=!order?.tableId?`${staffIcon('layout-dashboard')} Нет стола`:order?.status==='ready'?`${staffIcon('circle-check')} Готово`:order?.status==='in_progress'?`${staffIcon('package')} Готовится`:order?.status==='closed'?`${staffIcon('circle-check')} Закрыт`:order?.status==='cancelled'?`${staffIcon('alert-triangle')} Отменён`:`${staffIcon('layout-dashboard')} Открыт`;
  recalc();
  if(['closed','cancelled'].includes(order?.status)){const historyMeta=document.querySelector('.meta');if(historyMeta)historyMeta.textContent=['Просмотр истории',order.guestName,order.closedAt?'Закрыт '+new Date(order.closedAt).toLocaleString('ru-RU'):order.createdAt?'Создан '+new Date(order.createdAt).toLocaleString('ru-RU'):'',order.notes].filter(Boolean).join(' · ');}
  if(order?.status==='closed'&&order.finalTotal!=null){const totalNode=document.querySelector('#order-total');if(totalNode)totalNode.textContent=Number(order.finalTotal).toLocaleString('ru-RU')+' ₽';}
  refreshOrderPricingSummary(order);
}
async function refreshOrderPricingSummary(order){const revision=++orderPricingRevision;const id=order?.id;const meta=document.querySelector('.meta');if(!id||!meta)return;try{const pricing=await apiJson(`/api/orders/${encodeURIComponent(id)}/summary`);if(revision!==orderPricingRevision||currentOrder?.id!==id)return;const totalNode=document.querySelector('#order-total');if(totalNode)totalNode.textContent=`${Number(pricing.due??0).toLocaleString('ru-RU')} ₽`;let note=meta.querySelector('[data-order-pricing]');if(!note){note=document.createElement('small');note.dataset.orderPricing='';note.style.cssText='display:block;margin-top:4px;color:#aab2bd';meta.append(note);}const pieces=[];if(Number(pricing.discount||0)>0)pieces.push(pricing.source==='guest_group'?`Группа «${pricing.groupDiscountName||'лояльности'}» ${Number(pricing.groupDiscountPercent||0)}%: −${Number(pricing.discount).toLocaleString('ru-RU')} ₽`:`Одобренная скидка: −${Number(pricing.discount).toLocaleString('ru-RU')} ₽`);if(Number(pricing.minimumAdjustment||0)>0)pieces.push(`доплата до минимума VIP ${Number(pricing.minimumAdjustment).toLocaleString('ru-RU')} ₽`);pieces.push(`К оплате ${Number(pricing.due||0).toLocaleString('ru-RU')} ₽`);note.textContent=pieces.join(' · ');}catch(_){if(revision===orderPricingRevision&&currentOrder?.id===id){const old=meta.querySelector('[data-order-pricing]');if(old)old.remove();}}}
let queueFilter='all';
function drawQueue(filter=queueFilter){queueFilter=filter;const chips=document.querySelectorAll('.chips button');if(chips.length<4)return;const all=openOrders.filter((order)=>order.status!=='closed'&&order.status!=='cancelled').length;const fresh=openOrders.filter((order)=>order.status==='open').length;const cooking=openOrders.filter((order)=>order.status==='in_progress').length;const ready=openOrders.filter((order)=>order.status==='ready').length;[all,fresh,cooking,ready].forEach((value,index)=>{const labels=['Все','Новый заказ','Готовится','Готово'];chips[index].textContent=`${labels[index]} ${value}`;chips[index].classList.toggle('active',chips[index].dataset.filter===queueFilter);chips[index].setAttribute('aria-pressed',String(chips[index].dataset.filter===queueFilter));});const list=document.querySelector('#queue-list');if(!list)return;const visible=openOrders.filter((order)=>{if(order.status==='closed'||order.status==='cancelled')return false;return queueFilter==='all'||order.status===queueFilter;});list.innerHTML=visible.length?visible.map((order)=>{const label=order.status==='ready'?'Готово':order.status==='in_progress'?'Готовится':'Новый заказ';const table=floorTableLabel(order.tableId);const total=(order.items||[]).reduce((sum,item)=>sum+Number(item.unitPrice??item.price??0)*Number(item.quantity||1),0);return `<button type="button" class="queue-card" data-queue-table="${escapeFloorText(order.tableId||'')}" data-queue-order="${escapeFloorText(order.id||'')}"><span><b>${escapeFloorText(table)}</b><small>${(order.items||[]).length} поз. · ${total.toLocaleString('ru-RU')} ₽${order.guestName?` · ${escapeFloorText(order.guestName)}`:''}</small></span><em>${label}</em></button>`;}).join(''):'<div class="queue-empty">В этом разделе пока нет заказов</div>';}

function loadOrders(){
  const requestRevision=++ordersRequestRevision;
  const requestedVenueId=floorVenueId;
  const preservedTable=normalizeTableId(currentOrder?.tableId||document.querySelector('.table.sel')?.dataset.table||'');
  const preservedOrderId=currentOrder?.id;
  const requestedOrderId=new URLSearchParams(location.search).get('order');
  const unavailable=(message)=>{drawOrder({items:[]});const title=document.querySelector('.order h2');if(title)title.textContent=message;const meta=document.querySelector('.meta');if(meta)meta.textContent='Вернитесь в журнал заказов или обновите страницу, чтобы повторить загрузку.';notice(message);};
  return apiJson(requestedOrderId?'/api/orders?scope=all':'/api/orders').then(payload=>{
    if(requestRevision!==ordersRequestRevision||!floorReady||floorVenueId!==requestedVenueId)return;
    const availableOrders=payload.items||[];
    openOrders=availableOrders.filter((order)=>!['closed','cancelled'].includes(order.status));
    drawQueue();
    // A user selecting another order while loading owns the current selection.
    if(currentOrder?.id!==preservedOrderId)return;
    const selected=requestedOrderId?availableOrders.find((o)=>o.id===requestedOrderId):openOrders.find((o)=>o.id===preservedOrderId)||openOrders.find((o)=>preservedTable&&normalizeTableId(o.tableId)===preservedTable);
    if(requestedOrderId&&!selected){unavailable('Заказ не найден или недоступен');return;}
    drawOrder(selected||{items:[]});
  }).catch(()=>{
    if(requestRevision!==ordersRequestRevision||!floorReady||floorVenueId!==requestedVenueId)return;
    drawQueue();
    if(currentOrder?.id!==preservedOrderId)return;
    if(requestedOrderId&&!currentOrder?.id){unavailable('Не удалось загрузить заказ');return;}
    drawOrder(currentOrder||{items:[]});notice('Не удалось обновить заказы');
  });
}
const floorPixelPlacement=(table,index)=>{
  const layout=table?.layout&&typeof table.layout==='object'?table.layout:{};
  const fallback={x:(index%5)*190+12,y:Math.floor(index/5)*125+12,width:160,height:90};
  const value=(candidate,defaultValue,min,max)=>Number.isFinite(Number(candidate))?Math.min(max,Math.max(min,Number(candidate))):defaultValue;
  const pixel=layout.unit==='px'||layout.width!==undefined||layout.height!==undefined||((layout.x!==undefined||layout.y!==undefined)&&layout.w===undefined&&layout.h===undefined);
  const grid=layout.unit==='grid'||(!pixel&&(layout.w!==undefined||layout.h!==undefined));
  const x=grid?(value(layout.x,1,1,60)-1)*80+12:value(layout.x,fallback.x,0,5000);
  const y=grid?(value(layout.y,1,1,100)-1)*45+12:value(layout.y,fallback.y,0,5000);
  const width=grid?value(layout.w,3,1,60)*80-12:value(layout.width,fallback.width,40,5000);
  const height=grid?value(layout.h,2,1,100)*45-12:value(layout.height,fallback.height,40,5000);
  const rotation=value(layout.rotation,0,0,5000);
  return{x,y,width:Math.max(40,width),height:Math.max(40,height),rotation,shape:['rectangle','square','circle','oval','freeform'].includes(layout.shape)?layout.shape:'rectangle'};
};
const floorTabs=document.querySelector('.tabs');
let selectedZoneId='';
let floorRequestRevision=0;
const clearTableMinimums=()=>{for(const key of Object.keys(tableMinimums))delete tableMinimums[key];};
const updateFloorMapMode=()=>{
  const stage=tables.querySelector('.floor-map-stage');
  if(!stage){tables.classList.remove('compact-map');return;}
  tables.classList.remove('compact-map');
  if(window.innerWidth<=1100)return;
  const compact=[...stage.querySelectorAll('.table')].some((table)=>{
    const box=table.getBoundingClientRect();
    if(box.width<110||box.height<64)return true;
    if(table.classList.contains('is-rotated'))return false;
    return[...table.children].some((child)=>{
      const label=child.getBoundingClientRect();
      return label.top<box.top+3||label.bottom>box.bottom-3;
    });
  });
  tables.classList.toggle('compact-map',compact);
};
window.addEventListener('resize',updateFloorMapMode);
const renderZone=(zone)=>{
  tables.classList.toggle('vip-floor',/vip/i.test(String(zone?.name||'')));
  const serverTables=zone?.tables||[];
  if(!serverTables.length){tables.classList.remove('has-map','compact-map');tables.innerHTML='<div class="queue-empty">В этой зоне пока нет столов</div>';return;}
  const placements=serverTables.map((table,index)=>floorPixelPlacement(table,index));
  const bounds=placements.map((place)=>{
    const radians=place.rotation*Math.PI/180;
    const halfWidth=(Math.abs(place.width*Math.cos(radians))+Math.abs(place.height*Math.sin(radians)))/2;
    const halfHeight=(Math.abs(place.width*Math.sin(radians))+Math.abs(place.height*Math.cos(radians)))/2;
    return{left:place.x+place.width/2-halfWidth,top:place.y+place.height/2-halfHeight,right:place.x+place.width/2+halfWidth,bottom:place.y+place.height/2+halfHeight};
  });
  const sceneLeft=Math.min(0,...bounds.map((item)=>item.left));
  const sceneTop=Math.min(0,...bounds.map((item)=>item.top));
  const sceneWidth=Math.max(1000,...bounds.map((item)=>item.right+24))-sceneLeft;
  const sceneHeight=Math.max(560,...bounds.map((item)=>item.bottom+24))-sceneTop;
  tables.classList.add('has-map');
  tables.innerHTML=`<div class="floor-map-stage" style="aspect-ratio:${sceneWidth}/${sceneHeight}" data-scene-width="${sceneWidth}" data-scene-height="${sceneHeight}" data-scene-left="${sceneLeft}" data-scene-top="${sceneTop}">`+serverTables.map((t,index)=>{
    const label=t.status==='occupied'?'Занят':t.status==='reserved'?`Бронь${t.reservation?.createdByName?` · ${t.reservation.createdByName}`:''}`:t.status==='awaiting_payment'?'Ожидает оплату':t.status==='blocked'?'Закрыт':'Свободен';
    const minCapacity=Number(t.minCapacity||t.capacity||2),maxCapacity=Number(t.maxCapacity||t.capacity||4);
    const capacityText=minCapacity===maxCapacity?`${maxCapacity} ${pluralRu(maxCapacity,'гость','гостя','гостей')}`:`${minCapacity}–${maxCapacity} ${pluralRu(maxCapacity,'гость','гостя','гостей')}`;
    const place=placements[index];
    const style=`--floor-left:${(place.x-sceneLeft)/sceneWidth*100}%;--floor-top:${(place.y-sceneTop)/sceneHeight*100}%;--floor-width:${place.width/sceneWidth*100}%;--floor-height:${place.height/sceneHeight*100}%;--table-rotation:${place.rotation}deg;--table-counter-rotation:${-place.rotation}deg`;
    const safeTableName=escapeFloorText(String(t.name||'Стол').replace(/^Стол /,''));
    const safeLabel=escapeFloorText(label);
    const ariaLabel=escapeFloorText(`${t.name||'Стол'}: ${label}`);
    const smallText=t.status==='reserved'&&t.reservation?.createdByRole?`Оформил: ${t.reservation.createdByRole}`:capacityText;
    const amenities=t.layout?.amenities||{};
    const amenityMarkup=(amenities.playstation5||amenities.television)?`<span class="table-amenities" aria-label="Оснащение стола">${amenities.playstation5?'<b class="table-amenity table-amenity--playstation">PS5</b>':''}${amenities.television?'<b class="table-amenity table-amenity--tv">TV</b>':''}</span>`:'';
    return `<button type="button" class="table shape-${place.shape} ${place.rotation%180?'is-rotated':''} ${t.status==='occupied'?'busy':t.status==='reserved'?'reserve':t.status==='awaiting_payment'?'awaiting':t.status==='blocked'?'blocked':'free'} ${String(currentOrder?.tableId||'')===String(t.id)?'sel':''}" style="${style}" data-table="${escapeFloorText(t.id)}" data-status="${escapeFloorText(t.status||'free')}" data-layout-x="${place.x}" data-layout-y="${place.y}" data-layout-width="${place.width}" data-layout-height="${place.height}" aria-label="${ariaLabel}" title="${ariaLabel}" ${t.status==='blocked'?'disabled':''}><strong>${safeTableName}</strong><em>${safeLabel}</em><small>${escapeFloorText(smallText)}</small>${amenityMarkup}</button>`;
  }).join('')+'</div>';
  updateFloorMapMode();
};
const showFloorUnavailable=(message)=>{
  floorReady=false;
  ordersRequestRevision++;
  const orderPanel=document.querySelector('.order');
  if(orderPanel){orderPanel.inert=true;orderPanel.setAttribute('aria-busy','true');}
  floorVenueId='';
  selectedZoneId='';
  serverZones=[];
  clearTableMinimums();
  floorTabs.replaceChildren();
  floorTabs.removeAttribute('aria-busy');
  tables.classList.remove('vip-floor','has-map','compact-map');
  tables.innerHTML=`<div class="staff-floor-unavailable" role="alert"><strong>${escapeFloorText(message)}</strong><button type="button" class="secondary" data-staff-floor-retry>Повторить загрузку</button></div>`;
  currentOrder=null;
  openOrders=[];
  drawOrder({items:[]});
  drawQueue();
};
const applyFloorPayload=(payload)=>{
  if(!Array.isArray(payload?.zones)||!payload?.venueId)throw new Error('floor_payload_invalid');
  const nextVenueId=String(payload.venueId);
  const venueChanged=Boolean(floorVenueId&&floorVenueId!==nextVenueId);
  if(venueChanged){
    selectedZoneId='';
    currentOrder=null;
    openOrders=[];
    drawOrder({items:[]});
    drawQueue();
    ordersRequestRevision++;
  }
  floorVenueId=nextVenueId;
  floorReady=true;
  const orderPanel=document.querySelector('.order');
  if(orderPanel){orderPanel.inert=false;orderPanel.removeAttribute('aria-busy');}
  serverZones=payload.zones;
  clearTableMinimums();
  serverZones.flatMap((zone)=>zone.tables||[]).forEach((table)=>{tableMinimums[table.id]=Number(table.minimumOrderTotal||0);});
  selectedZoneId=serverZones.some((zone)=>String(zone.id)===selectedZoneId)?selectedZoneId:String(serverZones[0]?.id||'');
  floorTabs.innerHTML=serverZones.map((zone)=>`<button type="button" role="tab" data-zone-id="${escapeFloorText(zone.id)}" aria-selected="${String(zone.id)===selectedZoneId}" class="${String(zone.id)===selectedZoneId?'selected':''}">${escapeFloorText(zone.name||'Зал')}</button>`).join('');
  floorTabs.removeAttribute('aria-busy');
  if(!serverZones.length){tables.classList.remove('vip-floor','has-map');tables.innerHTML='<div class="queue-empty">В этой точке пока нет залов. Обратитесь к управляющему для настройки схемы.</div>';}
  else renderZone(serverZones.find((zone)=>String(zone.id)===selectedZoneId));
  drawQueue();
  if(currentOrder?.tableId)drawOrder(currentOrder);
  loadOrders();
  return payload;
};
const refreshFloor=()=>{
  if(!staffSessionVerified)return Promise.resolve(null);
  const revision=++floorRequestRevision;
  const controller=new AbortController();
  const timeout=window.setTimeout(()=>controller.abort(),8000);
  floorReady=false;
  floorTabs.setAttribute('aria-busy','true');
  const orderPanel=document.querySelector('.order');
  if(orderPanel){orderPanel.inert=true;orderPanel.setAttribute('aria-busy','true');}
  tables.querySelectorAll('button.table').forEach((button)=>{button.disabled=true;});
  const read=staticStaffDemo()?Promise.resolve().then(()=>{let state={};try{state=JSON.parse(localStorage.getItem('territory_crm_demo_state')||'{}');}catch(_){}const venueId=state.networkCurrentId||'demo-venue-territory';const floor=venueId==='demo-venue-territory'?state:state.floorByVenue?.[venueId]||{};return{venueId,zones:floor.floorZones||[]};}):fetch('/api/floor',{headers:sessionHeaders(),signal:controller.signal}).then((response)=>response.ok?response.json():Promise.reject(new Error('floor_failed')));
  return read.then((payload)=>revision===floorRequestRevision?applyFloorPayload(payload):null)
    .catch((error)=>{if(revision===floorRequestRevision)showFloorUnavailable(error?.name==='AbortError'?'Схема зала отвечает слишком долго':'Не удалось загрузить схему зала');return null;})
    .finally(()=>window.clearTimeout(timeout));
};
if(staticStaffDemo())refreshFloor();
window.addEventListener('focus',()=>{if(staffSessionVerified&&document.visibilityState==='visible'){refreshFloor();if(!staffShiftActionPending)refreshShift({silent:true});}});
floorTabs.addEventListener('click',(event)=>{
  const button=event.target.closest('[data-zone-id]');
  if(!button||!floorReady)return;
  const zone=serverZones.find((item)=>String(item.id)===button.dataset.zoneId);
  if(!zone)return;
  selectedZoneId=String(zone.id);
  floorTabs.querySelectorAll('[data-zone-id]').forEach((item)=>{const active=item===button;item.classList.toggle('selected',active);item.setAttribute('aria-selected',String(active));});
  renderZone(zone);
  notice(`Зона «${zone.name}» выбрана`);
});
tables.addEventListener('click',(event)=>{
  const retry=event.target.closest('[data-staff-floor-retry]');
  if(retry){if(staffSessionVerified)refreshFloor();else verifyStaffSession();return;}
  const card=event.target.closest('.table');
  if(!card||!floorReady)return;
  if(card.dataset.status==='blocked'){notice('Этот стол закрыт для продаж');return;}
  document.querySelectorAll('.table').forEach((node)=>node.classList.remove('sel'));
  card.classList.add('sel');
  document.querySelector('.staff-theme')?.classList.add('staff-order-open');
  const id=normalizeTableId(card.dataset.table);
  const found=openOrders.find((order)=>String(order.tableId)===id||String(order.tableId)===String(card.dataset.table));
  if(found)drawOrder(found);
  else{currentOrder=null;drawOrder({tableId:id,items:[]});}
  if(window.matchMedia('(max-width:760px)').matches) document.querySelector('.order')?.scrollIntoView({behavior:'smooth',block:'start'});
});
tableContextActions?.addEventListener('click',(event)=>{const button=event.target.closest('[data-table-action]');if(!button)return;const action=button.dataset.tableAction;const tableId=normalizeTableId(currentOrder?.tableId||document.querySelector('.table.sel')?.dataset.table||'');const table=floorTableFor(tableId);if(action==='close-panel'){document.querySelector('.staff-theme')?.classList.remove('staff-order-open');document.querySelectorAll('.table.sel').forEach((node)=>node.classList.remove('sel'));return;}if(!tableId)return;if(action==='new-order'||action==='add-position'){document.querySelector('.order > .primary')?.click();return;}if(action==='open-payment'){document.querySelector('#split-payment')?.click();return;}if(action==='reserve'){const target=new URL('/reservations',location.origin);target.searchParams.set('tableId',tableId);window.location.href=preserveWorkspaceRoute(target.pathname+target.search);return;}if(action==='open-reservation'||action==='seat-guest'){const target=new URL('/reservations',location.origin);target.searchParams.set('tableId',tableId);if(table?.reservation?.id)target.searchParams.set('reservationId',table.reservation.id);if(action==='seat-guest')target.searchParams.set('action','seat');window.location.href=preserveWorkspaceRoute(target.pathname+target.search);return;}if(action==='transfer'){document.querySelector('#transfer-order')?.click();return;}});
const catalog=document.querySelector('#catalog'), grid=document.querySelector('#catalog-grid'), search=document.querySelector('#product-search');
const demoProducts=[['Кальян — Darkside Blueberry',1200,['кальян','darkside','blueberry'],null,'hookah-darkside'],['Лимонад Маракуйя',300,['лимонад','маракуйя','maracuya'],null,'lemonade-maracuya'],['Red Bull',250,['red bull','ред булл','энергетик'],null,'redbull'],['Чай Эрл Грей',300,['чай','earl grey'],null,'tea-earl-grey'],['Чаша глиняная',500,['чаша'],null,'clay-bowl'],['Уголь Coco Nara',600,['уголь','coco nara'],null,'coco-nara'],['Tiger Energy',220,['тигр','энергетик tiger'],'data:image/png;base64,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','energy-tiger'],['Лимонад Лесные ягоды',320,['ягоды','лесные ягоды','лимонад'],'data:image/png;base64,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','lemonade-berry'],['Кальян — Mint Mix',1100,['кальян','мята','mint'],'data:image/png;base64,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','hookah-mint']];
let products=staticStaffDemo()?demoProducts:[];
let catalogState=staticStaffDemo()?'ready':'loading';
let catalogAddPending=false;
const normalizeSearch=(value)=>String(value||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function draw(q=''){if(catalogState==='loading'){grid.innerHTML='<div class="queue-empty catalog-state" role="status">Загружаем каталог…</div>';return;}if(catalogState==='error'){grid.innerHTML='<div class="queue-empty catalog-state" role="alert">Не удалось загрузить каталог.<button type="button" class="button small catalog-retry">Повторить</button></div>';return;}if(!products.length){grid.innerHTML='<div class="queue-empty catalog-state">Каталог пока пуст. Добавьте позиции в панели администратора.</div>';return;}const query=normalizeSearch(q);const visible=products.filter(([name,,aliases=[]])=>normalizeSearch([name,...aliases].join(' ')).includes(query));grid.innerHTML=visible.length?visible.map(([name,price,aliases=[],imageUrl,idValue])=>{const id=idValue||name.toLowerCase().replace(/[^a-z0-9]+/g,'-');return '<button type="button" class="product" '+(catalogAddPending?'disabled ':'')+'data-id="'+escapeFloorText(id)+'" data-name="'+escapeFloorText(name)+'" data-price="'+escapeFloorText(price)+'">'+(imageUrl?'<img src="'+escapeFloorText(imageUrl)+'" alt="">':'<span class="product-placeholder">'+staffIcon('plus')+'</span>')+'<span>'+escapeFloorText(displayProductName(name))+'</span><b>'+escapeFloorText(price)+' ₽ &nbsp;'+staffIcon('plus')+'</b></button>';}).join(''):'<div class="queue-empty">По запросу ничего не найдено</div>';}
async function loadProducts(){if(staticStaffDemo()){products=demoProducts;catalogState='ready';draw(search?.value||'');return;}catalogState='loading';draw(search?.value||'');try{const payload=await staffFetchJson('/api/products');if(!Array.isArray(payload?.items))throw new Error('catalog_invalid_response');products=payload.items.map(item=>[item.name,Number(item.price),item.aliases||[],item.imageUrl||null,item.id]).filter(item=>String(item[0]||'').trim()&&Number.isFinite(item[1])&&item[1]>=0&&String(item[4]||'').trim());catalogState='ready';}catch(_){products=[];catalogState='error';}draw(search?.value||'');}
if(staticStaffDemo())loadProducts();document.querySelector('.primary')?.addEventListener('click',()=>catalog.classList.add('open'));document.querySelector('#catalog-close')?.addEventListener('click',()=>catalog.classList.remove('open'));search?.addEventListener('input',e=>draw(e.target.value));
function recalc(){const total=[...document.querySelectorAll('.items [data-line-total]')].reduce((sum,node)=>sum+Number(node.dataset.lineTotal||0),0); const el=document.querySelector('#order-total'); if(el)el.textContent=total.toLocaleString('ru-RU')+' ₽';}
grid.addEventListener('click',async(e)=>{
  if(e.target.closest('.catalog-retry')){if(!catalogAddPending)loadProducts();return;}
  const item=e.target.closest('.product');if(!item||item.disabled||catalogAddPending)return;
  const selected=document.querySelector('.table.sel');
  const tableId=normalizeTableId(currentOrder?.tableId||selected?.dataset.table||'');
  if(!tableId){notice('Сначала выберите стол');return;}
  const productId=item.dataset.id||item.dataset.name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const productName=item.dataset.name;const catalogPrice=Number(item.dataset.price);
  let order=currentOrder?.id?currentOrder:openOrders.find((entry)=>normalizeTableId(entry.tableId)===tableId);
  let orderCreated=false;
  catalogAddPending=true;catalog.setAttribute('aria-busy','true');grid.querySelectorAll('.product').forEach((button)=>{button.disabled=true;});
  try{
    if(!order){
      order=await apiJson('/api/orders',{method:'POST',headers:orderHeaders(),body:JSON.stringify({tableId,minimumOrderTotal:tableMinimums[tableId]||0})});
      orderCreated=true;openOrders.push(order);drawQueue();
      if(normalizeTableId(document.querySelector('.table.sel')?.dataset.table||currentOrder?.tableId||'')===tableId)drawOrder(order);
    }
    const created=await apiJson(`/api/orders/${order.id}/items`,{method:'POST',headers:orderHeaders(),body:JSON.stringify({productId,quantity:1})});
    const existing=(order.items||[]).find((entry)=>entry.id===created.id);
    const unitPrice=Number(created.unitPrice??catalogPrice);
    if(existing)Object.assign(existing,created,{name:created.name||existing.name,unitPrice});
    else order.items=[...(order.items||[]),{...created,name:created.name||productName,unitPrice}];
    drawQueue();
    if(normalizeTableId(document.querySelector('.table.sel')?.dataset.table||currentOrder?.tableId||'')===tableId)drawOrder(order);
    catalog.classList.remove('open');
    if(orderCreated)refreshFloor();
  }catch(error){
    const code=error.payload?.error||error.message;
    if(orderCreated||code==='table_has_active_order')await loadOrders();
    notice(code==='order_not_editable'?'Заказ уже закрыт':code==='invalid_quantity'?'Достигнут лимит количества позиции':code==='product_not_found'?'Позиция больше недоступна':code==='table_has_active_order'?'Заказ на этом столе уже открыт. Повторите добавление':code==='active_shift_required'?'Сначала откройте смену':code==='forbidden'?'Нет права изменять заказ':orderCreated?'Заказ открыт, но позицию не удалось добавить. Повторите действие':'Не удалось открыть заказ');
  }finally{
    catalogAddPending=false;catalog.setAttribute('aria-busy','false');grid.querySelectorAll('.product').forEach((button)=>{button.disabled=false;});
  }
});
const itemMutationsPending=new Set();
orderRows.addEventListener('click',(event)=>{
  const button=event.target.closest('[data-item]');
  if(!button||!currentOrder?.id||button.disabled)return;
  const orderRef=currentOrder,orderId=orderRef.id,venueId=floorVenueId;
  const item=orderRef.items.find((entry)=>entry.id===button.dataset.item);
  if(!item||itemMutationsPending.has(item.id))return;
  const itemId=item.id,isPlus=button.classList.contains('qty-plus'),next=Number(item.quantity||1)-1;
  itemMutationsPending.add(itemId);
  button.disabled=true;
  const deleted=!isPlus&&next<1;
  const request=isPlus?apiJson(`/api/orders/${orderId}/items`,{method:'POST',headers:orderHeaders(),body:JSON.stringify({productId:item.productId,quantity:1})}):apiJson(`/api/orders/${orderId}/items/${itemId}`,{method:deleted?'DELETE':'PATCH',headers:orderHeaders(),...(!deleted?{body:JSON.stringify({quantity:next})}:{})});
  request.then((saved)=>{
    const applySaved=(order)=>{if(isPlus)order.items=[...(order.items||[]),saved];else if(deleted)order.items=(order.items||[]).filter((entry)=>entry.id!==itemId);else{const row=(order.items||[]).find((entry)=>entry.id===itemId);if(row)row.quantity=Number(saved.quantity??next);}};
    applySaved(orderRef);
    if(floorVenueId===venueId){const active=openOrders.find((order)=>order.id===orderId);if(active&&active!==orderRef)applySaved(active);if(currentOrder?.id===orderId){if(currentOrder!==orderRef&&currentOrder!==active)applySaved(currentOrder);drawOrder(currentOrder);}drawQueue();}
  }).catch((error)=>notice(['order_total_below_paid','paid_order_total_conflict'].includes(error.payload?.error||error.message)?deleted?'Нельзя удалить позицию: полученная оплата превысит сумму заказа':isPlus?'Нельзя добавить позицию: полученная оплата превысит сумму заказа':'Нельзя уменьшить количество: полученная оплата превысит сумму заказа':deleted?'Не удалось удалить позицию':isPlus?'Не удалось добавить позицию':'Не удалось изменить количество')).finally(()=>{itemMutationsPending.delete(itemId);button.disabled=false;});
});
const openGuestBinding=async()=>{
  if(!currentOrder?.id){notice('Сначала откройте заказ');return;}if(['closed','cancelled'].includes(currentOrder.status)){notice('Исторический заказ доступен только для просмотра');return;}
  const orderRef=currentOrder,orderId=orderRef.id,venueId=floorVenueId;
  const stillCurrent=()=>floorReady&&floorVenueId===venueId&&currentOrder?.id===orderId;
  let clients=[];
  try {
    if(staticStaffDemo()) clients=localStaffClients();
    else { const response=await fetch('/api/clients',{headers:sessionHeaders()}); if(response.ok) clients=(await response.json()).items||[]; }
  } catch (_) {}
  if(!stillCurrent()){notice('Заказ изменился. Откройте гостя заново');return;}
  const options=[{value:'',label:'Без привязанного гостя'},...clients.slice(0,80).map((client)=>({value:client.id,label:`${client.name}${client.telegram?` · ${client.telegram}`:''}`}))];
  const choice=await requestStaffAction({title:'Гость заказа',description:'Привяжите постоянного гостя или сохраните разового гостя.',submitLabel:'Сохранить гостя',fields:[{name:'clientId',label:'Гость из базы',type:'select',value:orderRef.clientId||'',options},{name:'guestName',label:'ФИО гостя',placeholder:'Для нового гостя'},{name:'phone',label:'Телефон',placeholder:'+7 ...'},{name:'detachGuest',label:'Действие',type:'select',options:[{value:'keep',label:'Оставить выбранного гостя'},{value:'detach',label:'Снять привязку гостя'}]}]});
  if(!choice)return;
  if(!stillCurrent()){notice('Заказ изменился. Откройте гостя заново');return;}
  const payload=choice.detachGuest==='detach'?{clientId:null}:choice.clientId?{clientId:choice.clientId}:String(choice.guestName||'').trim()?{guestName:String(choice.guestName).trim(),phone:String(choice.phone||'').trim()}:{clientId:null};
  apiJson(`/api/orders/${orderId}`,{method:'PATCH',headers:orderHeaders(),body:JSON.stringify(payload)}).then((saved)=>{Object.assign(orderRef,saved);if(floorVenueId===venueId){const active=openOrders.find((order)=>order.id===orderId);if(active)Object.assign(active,saved);if(currentOrder?.id===orderId)drawOrder(orderRef);drawQueue();}notice(payload.clientId===null?'Привязка гостя снята':payload.clientId?'Гость привязан к заказу':'Разовый гость сохранён');}).catch((error)=>notice(error.payload?.error==='guest_change_after_payment'?'Нельзя менять гостя после внесения оплаты':'Не удалось сохранить гостя'));
};

const requestStaffAction=(config={})=>new Promise((resolve)=>{
  const modal=document.querySelector('#staff-action-modal'),form=document.querySelector('#staff-action-form'),fields=document.querySelector('#staff-action-fields');
  if(!modal||!form){resolve(null);return;}
  const previousFocus=document.activeElement;
  document.querySelector('#staff-action-title').textContent=config.title||'Действие';
  document.querySelector('#staff-action-description').textContent=config.description||'';
  document.querySelector('#staff-action-submit').textContent=config.submitLabel||'Продолжить';
  document.querySelector('#staff-action-message').textContent='';
  fields.innerHTML=(config.fields||[]).map((field)=>{
    const name=escapeFloorText(field.name),label=escapeFloorText(field.label),required=field.required?'required':'';
    if(field.type==='checkbox')return `<label class="action-field action-field-checkbox"><input name="${name}" type="checkbox" ${required}><span>${label}</span></label>`;
    if(field.type==='select')return `<label class="action-field">${label}<select name="${name}" ${required}>${(field.options||[]).map((option)=>`<option value="${escapeFloorText(option.value)}" ${String(option.value)===String(field.value??'')?'selected':''}>${escapeFloorText(option.label)}</option>`).join('')}</select></label>`;
    if(field.type==='textarea')return `<label class="action-field">${label}<textarea name="${name}" ${required} placeholder="${escapeFloorText(field.placeholder||'')}">${escapeFloorText(field.value??'')}</textarea></label>`;
    return `<label class="action-field">${label}<input name="${name}" type="${escapeFloorText(field.type||'text')}" value="${escapeFloorText(field.value??'')}" ${required} ${field.min!==undefined?`min="${field.min}"`:''} ${field.max!==undefined?`max="${field.max}"`:''} ${field.step!==undefined?`step="${field.step}"`:''} placeholder="${escapeFloorText(field.placeholder||'')}"></label>`;
  }).join('');
  form.setAttribute('role','dialog');form.setAttribute('aria-modal','true');form.setAttribute('aria-labelledby','staff-action-title');form.setAttribute('aria-describedby','staff-action-description');form.setAttribute('tabindex','-1');
  modal.classList.add('open');modal.setAttribute('aria-hidden','false');
  const focusable=()=>[...form.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((node)=>node.getClientRects().length&&!node.hidden);
  const finish=(value)=>{modal.classList.remove('open');modal.setAttribute('aria-hidden','true');form.onsubmit=null;modal.removeEventListener('keydown',onDialogKeydown);if(previousFocus?.isConnected&&typeof previousFocus.focus==='function'&&!previousFocus.disabled)previousFocus.focus();else{const fallback=document.querySelector('.workspace, #page-content, main, [role="main"]');if(fallback){if(!fallback.hasAttribute('tabindex'))fallback.setAttribute('tabindex','-1');fallback.focus();}}resolve(value);};
  const onDialogKeydown=(event)=>{if(event.key==='Escape'){event.preventDefault();finish(null);return;}if(event.key!=='Tab')return;const nodes=focusable();if(!nodes.length){event.preventDefault();form.focus();return;}const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===form)){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}};
  modal.addEventListener('keydown',onDialogKeydown);
  form.onsubmit=(event)=>{event.preventDefault();finish(Object.fromEntries(new FormData(form).entries()));};
  document.querySelector('#staff-action-cancel').onclick=()=>finish(null);document.querySelector('#staff-action-close').onclick=()=>finish(null);modal.onclick=(event)=>{if(event.target===modal)finish(null);};
  setTimeout(()=>{if(!modal.classList.contains('open'))return;(fields.querySelector('input,select,textarea')||document.querySelector('#staff-action-close'))?.focus();},0);
});
document.querySelector('#order-delete')?.addEventListener('click',async(event)=>{
const deleteButton=event.currentTarget;
if(!currentOrder?.id){notice('Сначала откройте активный заказ');return;}
if(['closed','cancelled'].includes(currentOrder.status)){notice('Этот заказ уже закрыт или удалён');return;}
const orderRef=currentOrder,orderId=orderRef.id,venueId=floorVenueId;
const restoreButton=()=>{deleteButton.disabled=!floorReady||!currentOrder?.id||['closed','cancelled'].includes(currentOrder.status);};
deleteButton.disabled=true;
const choice=await requestStaffAction({title:'Удалить заказ',description:'Удаление сохраняет запись в журнале. Укажите причину и выберите, списывать ли ингредиенты.',submitLabel:'Удалить заказ',fields:[{name:'comment',label:'Причина удаления',type:'textarea',required:true,placeholder:'Например: ошибка при создании заказа'},{name:'writeoff',label:'Остатки склада',type:'select',options:[{value:'false',label:'Оставить ингредиенты на складе'},{value:'true',label:'Списать ингредиенты по технологической карте'}]}]});
if(!choice){restoreButton();return;}
if(!floorReady||floorVenueId!==venueId||currentOrder?.id!==orderId){notice('Заказ изменился. Откройте удаление заново');restoreButton();return;}
const comment=String(choice.comment||'').trim();if(!comment){notice('Укажите причину удаления');restoreButton();return;}
try{
  await apiJson(`/api/orders/${encodeURIComponent(orderId)}`,{method:'DELETE',headers:orderHeaders(),body:JSON.stringify({comment,writeoff:choice.writeoff==='true'})});
  orderRef.status='cancelled';
  if(floorVenueId===venueId){const active=openOrders.find((order)=>order.id===orderId);if(active)active.status='cancelled';if(currentOrder?.id===orderId){currentOrder=null;drawOrder({items:[]});}drawQueue();}
  notice('Заказ удалён и передан в журнал управляющему');
  await refreshFloor();
  await loadOrders();
}catch(error){const code=error.payload?.error||error.message;const message=code==='paid_order_cannot_cancel'?'Заказ уже оплачен. Сначала оформите возврат':code==='insufficient_recipe_stock'?'Недостаточно ингредиентов для списания':code==='order_delete_comment_required'?'Укажите причину удаления':code==='order_delete_writeoff_required'?'Выберите, что делать с ингредиентами':code==='order_not_deletable'?'Этот заказ уже закрыт или удалён':'Не удалось удалить заказ';notice(message);}
finally{restoreButton();}
});
document.querySelector('.close')?.addEventListener('click',async(event)=>{
  const button=event.currentTarget;
  if(!currentOrder?.id){notice('Сначала добавьте позицию в заказ');return;}
  const orderRef=currentOrder,orderId=orderRef.id,venueId=floorVenueId;
  const restoreButton=()=>{button.disabled=!floorReady||!currentOrder?.id||['closed','cancelled'].includes(currentOrder.status)||!(currentOrder.items||[]).length;};
  button.disabled=true;
  const choice=await requestStaffAction({title:'Закрыть заказ',description:'Выберите способ оплаты для оставшейся суммы.',submitLabel:'Закрыть заказ',fields:[{name:'method',label:'Способ оплаты',type:'select',options:[{value:'cash',label:'Наличные'},{value:'card',label:'Карта'},{value:'qr',label:'QR'}]}]});
  if(!choice){restoreButton();return;}
  if(!floorReady||floorVenueId!==venueId||currentOrder?.id!==orderId){notice('Заказ изменился. Откройте закрытие заново');restoreButton();return;}
  try{
    const result=await apiJson(`/api/orders/${orderId}/close`,{method:'POST',headers:orderHeaders(),body:JSON.stringify({paymentMethod:choice.method})});
    orderRef.status='closed';
    if(floorVenueId===venueId){const closed=openOrders.find((order)=>order.id===orderId);if(closed)closed.status='closed';drawQueue();if(currentOrder?.id===orderId){currentOrder=null;drawOrder({items:[]});}}
    notice(`${result.minimumAdjustment>0 ? `Заказ закрыт на ${Number(result.finalTotal||0).toLocaleString('ru-RU')} ₽ · доплата до минимума заказа VIP ${Number(result.minimumAdjustment).toLocaleString('ru-RU')} ₽` : `Заказ закрыт на ${Number(result.finalTotal||0).toLocaleString('ru-RU')} ₽`}${Number(result.loyaltyBonusEarned||0)>0?` · начислено ${Number(result.loyaltyBonusEarned)} ${pluralRu(Number(result.loyaltyBonusEarned),'бонус','бонуса','бонусов')}`:''}`);
    await refreshFloor();
    await loadOrders();
  }catch(error){const code=error.payload?.error;notice(code==='product_recipe_required'?'Для позиции добавьте техкарту в каталоге товаров':code==='product_recipe_ambiguous'?'Для позиции выберите единственную техкарту':code==='product_inventory_mode_required'?'Для позиции проверьте тип складского учёта':code==='product_inventory_mode_invalid'?'Для позиции проверьте складской режим':code==='recipe_invalid'?'Исправьте состав техкарты':code==='recipe_ingredient_not_found'?'Проверьте ингредиент в техкарте':code==='recipe_ingredient_unit_mismatch'?'Проверьте единицы измерения в техкарте':code==='invalid_recipe_quantity'?'Проверьте количество ингредиента в техкарте':code==='insufficient_recipe_stock'?'Недостаточно ингредиентов на складе':'Не удалось закрыть заказ');}
  finally{restoreButton();}
});
document.querySelector('#order-guest')?.addEventListener('click',openGuestBinding);
const openNotesEditor=async()=>{
  if(!currentOrder?.id){notice('Сначала откройте заказ');return;}if(['closed','cancelled'].includes(currentOrder.status)){notice('Исторический заказ доступен только для просмотра');return;}
  const orderRef=currentOrder,orderId=orderRef.id,venueId=floorVenueId;
  const choice=await requestStaffAction({title:'Заметка к заказу',description:'Комментарий сохранится в заказе и будет виден сотрудникам.',submitLabel:'Сохранить заметку',fields:[{name:'notes',label:'Комментарий',type:'textarea',value:orderRef.notes||'',placeholder:'Например: без льда, гость ждёт счёт',required:false}]});
  if(choice===null)return;
  if(!floorReady||floorVenueId!==venueId||currentOrder?.id!==orderId){notice('Заказ изменился. Откройте заметку заново');return;}
  apiJson(`/api/orders/${orderId}`,{method:'PATCH',headers:orderHeaders(),body:JSON.stringify({notes:String(choice.notes||'').trim()})}).then((saved)=>{Object.assign(orderRef,saved);if(floorVenueId===venueId){const active=openOrders.find((order)=>order.id===orderId);if(active)Object.assign(active,saved);if(currentOrder?.id===orderId)drawOrder(orderRef);}notice('Заметка сохранена');}).catch(()=>notice('Не удалось сохранить заметку'));
};
document.querySelector('#order-notes')?.addEventListener('click',openNotesEditor);
document.querySelector('#discount-request')?.addEventListener('click',async()=>{
  if(!currentOrder?.id){notice('Сначала откройте заказ');return;}
  if(['closed','cancelled'].includes(currentOrder.status)){notice('Исторический заказ доступен только для просмотра');return;}
  const orderId=currentOrder.id,clientId=currentOrder.clientId,venueId=floorVenueId;
  let suggestedDiscount=0,loyaltyReason='Лояльность гостя';
  if(clientId){try{const [clientData,groupData]=await Promise.all([apiJson('/api/clients'),apiJson('/api/discount-groups')]);const client=(clientData.items||[]).find((entry)=>entry.id===clientId);const group=(groupData.items||[]).find((entry)=>entry.id===client?.discountGroupId);if(group){suggestedDiscount=Number(group.discountPercent||0);loyaltyReason=`Программа «${group.name}»`;}}catch(_){}}
  if(!floorReady||floorVenueId!==venueId||currentOrder?.id!==orderId){notice('Заказ изменился. Откройте скидку заново');return;}
  const choice=await requestStaffAction({title:'Применить скидку',description:suggestedDiscount?`Для гостя доступна программа со скидкой ${suggestedDiscount}%. Владелец и администратор получат уведомление.`:'Выберите размер скидки. Владелец и администратор получат уведомление.',submitLabel:'Применить скидку',fields:[{name:'value',label:'Скидка, %',type:'number',min:1,step:1,value:suggestedDiscount||'',placeholder:'10',required:true},{name:'reason',label:'Причина',type:'textarea',value:loyaltyReason,placeholder:'Лояльность гостя',required:true}]});
  if(!choice)return;
  if(!floorReady||floorVenueId!==venueId||currentOrder?.id!==orderId){notice('Заказ изменился. Откройте скидку заново');return;}
  const value=Number(choice.value);
  if(!Number.isFinite(value)||value<=0||value>100){notice('Скидка должна быть от 1 до 100%');return;}
  apiJson(`/api/orders/${orderId}/discount-requests`,{method:'POST',headers:orderHeaders(),body:JSON.stringify({type:'percent',value,reason:String(choice.reason||'').trim()})}).then(()=>notice('Заявка на скидку отправлена. Владелец и администратор уведомлены')).catch(()=>notice('Не удалось отправить заявку'));
});

const setStaffWorkspaceView=(view)=>{const root=document.querySelector('.staff-theme');if(!root)return;root.classList.toggle('staff-orders-view',view==='orders');root.dataset.staffView=view;document.querySelector('.staff-header-title b')?.replaceChildren(document.createTextNode(view==='orders'?'Заказы':'Рабочий зал'));};
// Orders view uses concise operational cards so the hookah master can scan table, guest and wait time at a glance.
function drawQueue(filter=queueFilter){queueFilter=filter;const chips=document.querySelectorAll('.chips button');if(chips.length<4)return;const counts=['all','open','in_progress','ready'].map((status)=>status==='all'?openOrders.filter((order)=>!['closed','cancelled'].includes(order.status)).length:openOrders.filter((order)=>order.status===status).length);const labels=['Все','Новый заказ','Готовится','Готово'];counts.forEach((value,index)=>{chips[index].textContent=`${labels[index]} ${value}`;chips[index].classList.toggle('active',chips[index].dataset.filter===queueFilter);chips[index].setAttribute('aria-pressed',String(chips[index].dataset.filter===queueFilter));});const list=document.querySelector('#queue-list');if(!list)return;const visible=openOrders.filter((order)=>!['closed','cancelled'].includes(order.status)&&(queueFilter==='all'||order.status===queueFilter));const age=(order)=>{const raw=order.createdAt||order.openedAt||order.updatedAt;const time=raw?Date.now()-new Date(raw).getTime():0;return Number.isFinite(time)&&time>0?`${Math.floor(time/60000)} мин`:'';};list.innerHTML=visible.length?visible.map((order)=>{const label=order.status==='ready'?'Готово':order.status==='in_progress'?'Готовится':'Новый заказ';const table=floorTableLabel(order.tableId);const total=(order.items||[]).reduce((sum,item)=>sum+Number(item.unitPrice??item.price??0)*Number(item.quantity||1),0);const items=(order.items||[]).slice(0,3).map((item)=>`${escapeFloorText(item.name||item.title||'Позиция')} × ${Number(item.quantity||1)}`).join(', ');const note=order.note||order.notes||order.guestNote||'';return `<button type="button" class="queue-card" data-queue-table="${escapeFloorText(order.tableId||'')}" data-queue-order="${escapeFloorText(order.id||'')}"><span><b>${escapeFloorText(table)}${order.guestName?` · ${escapeFloorText(order.guestName)}`:''}</b><small>${age(order)?`${age(order)} · `:''}${items||`${(order.items||[]).length} поз.`} · ${total.toLocaleString('ru-RU')} ₽${note?` · ${escapeFloorText(note)}`:''}</small></span><em>${label}</em></button>`;}).join(''):'<div class="queue-empty">В этом разделе пока нет заказов</div>';}
document.querySelectorAll('aside nav button').forEach((button)=>button.addEventListener('click',()=>{
  document.querySelectorAll('aside nav button').forEach((item)=>{item.classList.remove('active');item.removeAttribute('aria-current');}); button.classList.add('active'); button.setAttribute('aria-current','page');
  const label=button.textContent.trim(); if(label.includes('Бронирования')) window.location.href=preserveWorkspaceRoute('/reservations'); else if(label.includes('Склад')) window.location.href=preserveWorkspaceRoute('/inventory'); else if(label.includes('Финансы')) window.location.href=preserveWorkspaceRoute('/finance'); else if(label.includes('Задачи')) window.location.href=preserveWorkspaceRoute('/admin#tasks'); else if(label.includes('Заказы')) { setStaffWorkspaceView('orders'); drawQueue('all'); window.scrollTo({top:0,behavior:'smooth'}); notice('Показаны активные заказы'); } else if(label.includes('Рабочий зал')) { setStaffWorkspaceView('floor'); window.scrollTo({top:0,behavior:'smooth'}); } else document.querySelector('.tables')?.scrollIntoView({behavior:'smooth'});
}));
let staffShiftActionPending=false;
document.querySelector('#shift-toggle')?.addEventListener('click',async()=>{
  const button=document.querySelector('#shift-toggle');if(button?.disabled||staffShiftActionPending)return;
  if(button?.dataset.shiftState==='error'){await refreshShift();return;}
  staffShiftActionPending=true;
  try{
    let closing=Boolean(currentShift);
    if(closing){try{const latest=await shiftApi();currentShift=latest.current||null;renderStaffShiftControl(currentShift?'open':'closed');closing=Boolean(currentShift);}catch(_){await refreshShift({silent:true});notice('Не удалось обновить ожидаемую сумму наличных. Повторите проверку смены.');return;}if(!closing){notice('Смена уже закрыта или недоступна. Состояние обновлено.');return;}}
    const closeChecklistFields=closing?(window.HOOKAH_SHIFT_CLOSE?.checklistItems||[]).map((item)=>({name:item.id,label:item.label,type:'checkbox',required:true})):[];
    const closeDescription=closing?`${shiftCashCloseDescription(currentShift)} Внутренний снимок закрытия сохраняется после подтверждения; он не является фискальным Z-отчётом.`:'Укажите стартовый остаток в кассе.';
    const choice=await requestStaffAction({title:closing?'Закрыть смену':'Открыть смену',description:closeDescription,submitLabel:closing?'Закрыть смену':'Открыть смену',fields:[{name:closing?'closingCash':'openingCash',label:closing?'Фактическая сумма':'Остаток в кассе',type:'number',min:0,step:.01,placeholder:'0',required:true},...closeChecklistFields]});
    if(!choice)return;const key=closing?'closingCash':'openingCash';
    if(choice[key] === '' || choice[key] === undefined){notice('Укажите сумму наличных');return;}
    const amount=Number(choice[key]);if(!Number.isFinite(amount)||amount<0){notice('Сумма должна быть неотрицательной');return;}
    renderStaffShiftControl('saving');
    try{
      let closeResult=null;
      if(closing){const checklist={version:window.HOOKAH_SHIFT_CLOSE?.checklistVersion,items:Object.fromEntries((window.HOOKAH_SHIFT_CLOSE?.checklistItems||[]).map((item)=>[item.id,Object.hasOwn(choice,item.id)]))};closeResult=await shiftApi({url:`/api/shifts/${currentShift.id}/close`,method:'POST',body:JSON.stringify({closingCash:amount,checklist})});currentShift=null;}
      else currentShift=await shiftApi({method:'POST',body:JSON.stringify({openingCash:amount})});
      await refreshShift();staffNotificationCenter?.refresh();notice(closing?shiftCloseResultMessage(closeResult):'Смена открыта');
    }catch(error){await refreshShift({silent:true});notice(closing?shiftCloseFailureMessage(error):'Не удалось открыть смену',8000);}
  }finally{staffShiftActionPending=false;}
});
const refreshVisibleStaffShift=()=>{if(staffSessionVerified&&!staffShiftActionPending&&document.visibilityState==='visible')refreshShift({silent:true});};
window.setInterval(refreshVisibleStaffShift,20000);document.addEventListener('visibilitychange',refreshVisibleStaffShift);window.addEventListener('storage',(event)=>{if(event.key==='territory_crm_shift')refreshVisibleStaffShift();});
document.querySelectorAll('.actions button').forEach((button)=>button.addEventListener('click',()=>{
  if(!currentOrder?.id){notice('Сначала добавьте позицию в заказ');return;}
  const orderRef=currentOrder,orderId=orderRef.id,venueId=floorVenueId;
  const status=button.textContent.includes('бар')?'in_progress':'ready';
  apiJson(`/api/orders/${orderId}/status`,{method:'POST',headers:orderHeaders(),body:JSON.stringify({status})}).then((saved)=>{Object.assign(orderRef,saved);if(floorVenueId===venueId){const active=openOrders.find((order)=>order.id===orderId);if(active)Object.assign(active,saved);if(currentOrder?.id===orderId)drawOrder(orderRef);drawQueue();}notice(status==='in_progress'?'Заказ отправлен на бар':'Задача отправлена кальянщику');}).then(()=>refreshFloor()).catch(()=>notice('Не удалось передать заказ'));
}));
document.querySelector('#transfer-order')?.addEventListener('click',()=>{
  if(!currentOrder?.id){notice('Сначала откройте заказ');return;}if(['closed','cancelled'].includes(currentOrder.status)){notice('Исторический заказ доступен только для просмотра');return;}
  if(!floorReady){notice('Сначала обновите схему зала');return;}
  const orderRef=currentOrder,orderId=orderRef.id,venueId=floorVenueId;
  const options=serverZones.flatMap((zone)=>(zone.tables||[]).filter((table)=>String(table.id)!==String(currentOrder.tableId)&&table.status!=='blocked'&&!openOrders.some((order)=>order.id!==orderId&&String(order.tableId)===String(table.id))).map((table)=>({value:String(table.id),label:`${zone.name} · ${table.name}`})));
  if(!options.length){notice('Нет доступных столов для передачи заказа');return;}
  requestStaffAction({title:'Передать заказ',description:'Выберите стол из текущей схемы зала.',submitLabel:'Передать заказ',fields:[{name:'tableId',label:'Стол',type:'select',options,required:true}]}).then((choice)=>{if(!choice)return;const tableId=String(choice.tableId||'');if(!floorReady||floorVenueId!==venueId||currentOrder?.id!==orderId){notice('Схема или заказ изменились. Откройте передачу заново');return;}if(!options.some((option)=>option.value===tableId)){notice('Выберите стол из списка');return;}apiJson(`/api/orders/${orderId}/transfer`,{method:'POST',headers:orderHeaders(),body:JSON.stringify({tableId})}).then((saved)=>{Object.assign(orderRef,saved,{tableId});if(floorVenueId===venueId){const active=openOrders.find((order)=>order.id===orderId);if(active)Object.assign(active,saved,{tableId});if(currentOrder?.id===orderId)drawOrder(orderRef);drawQueue();}notice('Заказ передан на новый стол');}).then(()=>refreshFloor()).catch((error)=>{const code=error.payload?.error;notice(code==='target_table_has_active_order'?'На выбранном столе уже открыт заказ':code==='target_table_not_found'?'Выбранный стол больше недоступен. Обновите схему':'Не удалось передать заказ');});});
});
document.querySelector('#print-receipt')?.addEventListener('click',()=>{
  if(currentOrder?.status==='cancelled'){notice('Отменённый заказ нельзя распечатать как чек');return;}
  if(!currentOrder?.id || !(currentOrder.items||[]).length){notice('Сначала добавьте позиции в заказ');return;}
  const escapeHtml=(value)=>String(value??'').replace(/[&<>\"]/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[char]));
  const rows=(currentOrder.items||[]).map((item)=>`<tr><td>${escapeHtml(displayProductName(item.name||'Позиция'))}</td><td>${Number(item.quantity||1)}</td><td>${(Number(item.unitPrice||0)*Number(item.quantity||1)).toLocaleString('ru-RU')} ₽</td></tr>`).join('');
  const subtotal=(currentOrder.items||[]).reduce((sum,item)=>sum+Number(item.unitPrice||0)*Number(item.quantity||1),0);
  const total=currentOrder.status==='closed'&&currentOrder.finalTotal!=null?Number(currentOrder.finalTotal):subtotal;
  const receiptDate=currentOrder.status==='closed'?currentOrder.closedAt||currentOrder.createdAt:currentOrder.createdAt;
  const dateLabel=receiptDate?new Date(receiptDate).toLocaleString('ru-RU'):'Дата не указана';
  const popup=window.open('','_blank','width=420,height=640');
  if(!popup){notice('Разрешите всплывающие окна для печати чека');return;}
  popup.opener=null;
  popup.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Чек ${escapeHtml(currentOrder.id)}</title><style>body{font:14px Arial,sans-serif;color:#111;padding:20px}h1{font-size:20px;margin:0 0 8px}p{margin:4px 0 14px;color:#555}table{width:100%;border-collapse:collapse}td{padding:7px 0;border-bottom:1px solid #ddd}td:nth-child(2),td:nth-child(3){text-align:right}.total{font-size:18px;font-weight:700;text-align:right;margin-top:18px}</style></head><body><h1>Территория · чек</h1><p>Заказ ${escapeHtml(currentOrder.id)} · ${escapeHtml(dateLabel)}</p><table>${rows}</table><div class="total">Итого: ${total.toLocaleString('ru-RU')} ₽</div><script>window.onload=()=>window.print();<\/script></body></html>`);
  popup.document.close();
});
document.querySelector('#split-order')?.addEventListener('click',()=>{
  if(!currentOrder?.id || !(currentOrder.items||[]).length){notice('В заказе нет позиций для разделения');return;}
  if(['closed','cancelled'].includes(currentOrder.status)){notice('Закрытый заказ нельзя разделить');return;}
  const source=currentOrder,orderId=source.id,venueId=floorVenueId,items=[...source.items];
  const lines=items.map((item,index)=>`${index+1}. ${displayProductName(item.name||'Позиция')} ×${item.quantity||1}`).join('\n');
  requestStaffAction({title:'Разделить заказ',description:`Выберите номера позиций через запятую.\n${lines}`,submitLabel:'Создать новый заказ',fields:[{name:'items',label:'Номера позиций',type:'text',placeholder:'1, 3',required:true}]}).then((choice)=>{
    if(!choice)return;
    if(!floorReady||floorVenueId!==venueId||currentOrder?.id!==orderId||items.some((item,index)=>currentOrder.items[index]?.id!==item.id)||currentOrder.items.length!==items.length){notice('Заказ изменился. Откройте разделение заново');return;}
    const tokens=String(choice.items||'').split(',').map((value)=>value.trim());
    const indexes=tokens.map((value)=>/^\d+$/.test(value)?Number(value)-1:-1);
    if(indexes.some((index)=>index<0||index>=items.length)||new Set(indexes).size!==indexes.length){notice('Проверьте номера позиций');return;}
    if(indexes.length===items.length){notice('Оставьте хотя бы одну позицию в исходном заказе');return;}
    const itemIds=indexes.map((index)=>items[index].id);
    apiJson(`/api/orders/${orderId}/split`,{method:'POST',headers:orderHeaders(),body:JSON.stringify({itemIds})}).then((target)=>{
      source.items=source.items.filter((item)=>!itemIds.includes(item.id));
      if(!openOrders.some((order)=>order.id===target.id))openOrders.push(target);
      if(currentOrder?.id===orderId)drawOrder(source);
      drawQueue();
      return refreshFloor().then(()=>loadOrders()).then(()=>notice('Новый заказ создан'));
    }).catch((error)=>{const code=error.payload?.error||error.message;notice(['order_total_below_paid','paid_order_total_conflict'].includes(code)?'Сумма заказа после разделения станет меньше уже полученной оплаты':code==='item_ids_not_in_order'?'Состав заказа изменился. Обновите заказ и повторите':code==='split_requires_remaining_item'?'Оставьте хотя бы одну позицию в исходном заказе':'Не удалось разделить заказ');});
  });
});
const paymentModal=document.querySelector('#payment-modal'); const paymentForm=document.querySelector('#payment-form');
const paymentInputs=['cash','card','qr','bonus','deposit','reservation'].map((method)=>document.querySelector(`#payment-${method}`)).filter(Boolean);
let paymentState=null;let paymentLoadRevision=0;const paymentPostsPending=new Set();const paymentAttemptKeys=new Map();
const refreshPaymentRemainder=()=>{const allocated=paymentInputs.reduce((sum,input)=>sum+Math.max(0,Number(input.value||0)),0);const remainder=document.querySelector('#payment-remaining');if(remainder)remainder.textContent=paymentState?`Остаток ${Math.max(0,paymentState.remaining-allocated).toLocaleString('ru-RU')} ₽`:'Загружаем остаток…';};
const loadPaymentState=async(orderId,revision=paymentLoadRevision)=>{const result=await apiJson(`/api/orders/${orderId}/payments`);if(revision!==paymentLoadRevision||!paymentModal?.classList.contains('open')||currentOrder?.id!==orderId)return false;paymentState={orderId,due:Number(result.due??0),paid:Number(result.paid??0),remaining:Number(result.remaining??0),bonusRedemptionRemaining:Number(result.bonusRedemptionRemaining??result.remaining??0),bonusRedemptionPolicy:result.bonusRedemptionPolicy||null,pricingLocked:Boolean(result.pricingLocked),pricingLockedAt:result.pricingLockedAt||null,closed:Boolean(result.closed),guestAccount:result.guestAccount||null,items:result.items||[],pricing:result,reservationPrepaymentReceipts:result.reservationPrepaymentReceipts||[]};const bonusField=document.querySelector('#payment-bonus-field'),bonusInput=document.querySelector('#payment-bonus'),depositField=document.querySelector('#payment-deposit-field'),depositInput=document.querySelector('#payment-deposit'),reservationField=document.querySelector('#payment-reservation-field'),reservationInput=document.querySelector('#payment-reservation'),receiptSelect=document.querySelector('#payment-reservation-receipt');if(bonusField)bonusField.hidden=!paymentState.guestAccount;if(bonusInput){bonusInput.max=String(Math.max(0,Math.floor(Math.min(paymentState.remaining,Number(paymentState.guestAccount?.bonusBalance||0),paymentState.bonusRedemptionRemaining))));bonusInput.disabled=!paymentState.guestAccount||Number(paymentState.guestAccount.bonusBalance||0)<=0||paymentState.bonusRedemptionRemaining<=0;}if(depositField)depositField.hidden=!paymentState.guestAccount;if(depositInput){depositInput.max=String(Math.max(0,Math.min(paymentState.remaining,Number(paymentState.guestAccount?.depositBalance||0))));depositInput.disabled=!paymentState.guestAccount||Number(paymentState.guestAccount.depositBalance||0)<=0;}if(receiptSelect){const prior=receiptSelect.value;receiptSelect.innerHTML=paymentState.reservationPrepaymentReceipts.map((receipt)=>`<option value="${escapeFloorText(receipt.id)}">${Number(receipt.available).toLocaleString('ru-RU')} ₽ · ${receipt.method==='cash'?'наличные':receipt.method==='card'?'карта':'QR'} · ${new Date(receipt.createdAt).toLocaleDateString('ru-RU')}</option>`).join('')||'<option value="">Нет доступной предоплаты</option>';if(paymentState.reservationPrepaymentReceipts.some((receipt)=>receipt.id===prior))receiptSelect.value=prior;}if(reservationField)reservationField.hidden=!paymentState.reservationPrepaymentReceipts.length;if(reservationInput){const receipt=paymentState.reservationPrepaymentReceipts.find((entry)=>entry.id===receiptSelect?.value)||paymentState.reservationPrepaymentReceipts[0];if(receiptSelect&&receipt&&!receiptSelect.value)receiptSelect.value=receipt.id;reservationInput.max=String(Math.max(0,Math.min(paymentState.remaining,Number(receipt?.available||0))));reservationInput.disabled=!receipt;}const dueEl=document.querySelector('#payment-due');if(dueEl)dueEl.textContent=`${paymentState.remaining.toLocaleString('ru-RU')} ₽`;const message=document.querySelector('#payment-message');if(message){const bonusTender=paymentState.items.filter((entry)=>entry.method==='bonus').reduce((sum,entry)=>sum+Number(entry.amount||0),0);const estimateBase=Math.max(0,Number(paymentState.pricing?.net||0)-bonusTender);const estimateRate=Number(paymentState.guestAccount?.bonusPercent||0);const estimate=Math.floor(estimateBase*estimateRate/100);const savedEarned=paymentState.pricing?.loyaltyBonusEarned;const accrualExplanation=paymentState.closed?(savedEarned==null?'Закрытый чек: данные начисления в историческом снимке отсутствуют':`По закрытому чеку начислено ${Number(savedEarned)} бонусов · база ${Number(paymentState.pricing.loyaltyBonusBase||0).toLocaleString('ru-RU')} ₽ · ставка ${Number(paymentState.pricing.loyaltyBonusPercent||0)}%`):`Оценка начисления: ${estimate} бонусов (${estimateBase.toLocaleString('ru-RU')} ₽ после скидки и списания бонусами × ${estimateRate}%, без VIP-доплаты); начислится только после полной оплаты`;const offerExplanation=(paymentState.pricing?.offers||[]).map((offer)=>{const reason={selected:'выбрано',better_offer_selected:'не выбрано: есть более выгодное предложение',draft:'черновик',archived:'архив',not_started:'ещё не началась',expired:'срок завершён',no_matching_items:'нет подходящих позиций',excluded_or_inactive_items:'позиции исключены или неактивны',no_approved_discount:'нет одобренной скидки',no_group_discount:'нет скидки группы'}[offer.reasonCode]||offer.reasonCode;const label=offer.source==='promotion'?`Акция «${offer.label}»`:offer.label;return `${label}: ${reason}${Number(offer.amount||0)>0?` · ${Number(offer.amount).toLocaleString('ru-RU')} ₽`:''}`;});const lines=[...(paymentState.pricingLocked?['Цена зафиксирована первым платежом; условия акций и сумма чека больше не пересчитываются']:[]),...offerExplanation,paymentState.paid?`Уже оплачено ${paymentState.paid.toLocaleString('ru-RU')} ₽ из ${paymentState.due.toLocaleString('ru-RU')} ₽`:'',paymentState.guestAccount?`Счета гостя: ${Number(paymentState.guestAccount.bonusBalance||0).toLocaleString('ru-RU')} бонусов · ${Number(paymentState.guestAccount.depositBalance||0).toLocaleString('ru-RU')} ₽`: '',paymentState.pricing?Number(paymentState.pricing.discount||0)>0?`Скидка: −${Number(paymentState.pricing.discount).toLocaleString('ru-RU')} ₽ — ${paymentState.pricing.source==='guest_group'?`программа «${paymentState.pricing.groupDiscountName||'гостя'}», ${Number(paymentState.pricing.groupDiscountPercent||0)}% от товарной суммы`:paymentState.pricing.source==='manual'?'согласованная ручная скидка':paymentState.pricing.source==='promotion'?`акция «${paymentState.pricing.selectedPromotion?.name||'акция'}», версия ${paymentState.pricing.selectedPromotion?.version||''}`:paymentState.pricing.source}`:'Скидка не применена':'',Number(paymentState.pricing?.minimumAdjustment||0)>0?`VIP: ${Number(paymentState.pricing.minimumAdjustment).toLocaleString('ru-RU')} ₽ доплаты до минимума; бонусы на неё не начисляются`:'',paymentState.guestAccount?accrualExplanation:'',paymentState.bonusRedemptionPolicy?`Лимит списания: до ${Number(paymentState.bonusRedemptionRemaining||0).toLocaleString('ru-RU')} бонусов из ${Number(paymentState.bonusRedemptionPolicy.maxRedemptionPercent||0)}% цены${paymentState.items.some((entry)=>entry.method==='bonus')?'':' · минимум первой операции '+Number(paymentState.bonusRedemptionPolicy.minimumRedemptionPoints||1)+' бонус'}`:'',paymentState.reservationPrepaymentReceipts.length?`Предоплата брони: доступно ${Number(result.reservationPrepaymentAvailable||0).toLocaleString('ru-RU')} ₽ · зачёт не увеличит наличность смены повторно`: ''].filter(Boolean);message.replaceChildren(...lines.map((line)=>{const row=document.createElement('span');row.style.display='block';row.textContent=line;return row;}));}const submit=paymentForm?.querySelector('[type=submit]');if(submit)submit.disabled=paymentState.remaining<=0||paymentPostsPending.has(orderId);refreshPaymentRemainder();return true;};
paymentInputs.forEach((input)=>input.addEventListener('input',refreshPaymentRemainder));
document.querySelector('#payment-reservation-receipt')?.addEventListener('change',()=>{const receipt=document.querySelector('#payment-reservation-receipt'),amount=document.querySelector('#payment-reservation'),selected=paymentState?.reservationPrepaymentReceipts?.find((entry)=>entry.id===receipt.value);if(amount){amount.max=String(Math.max(0,Math.min(paymentState?.remaining||0,Number(selected?.available||0))));amount.disabled=!selected;}refreshPaymentRemainder();});
document.querySelector('#payment-close')?.addEventListener('click',()=>{paymentLoadRevision+=1;paymentModal?.classList.remove('open');});
paymentModal?.addEventListener('click',(event)=>{if(event.target===paymentModal){paymentLoadRevision+=1;paymentModal.classList.remove('open');}});
document.querySelector('#split-payment')?.addEventListener('click',async()=>{
  if(!currentOrder?.id || !(currentOrder.items||[]).length){notice('Сначала добавьте позиции в заказ');return;}
  const orderId=currentOrder.id;const revision=++paymentLoadRevision;paymentState=null;const dueEl=document.querySelector('#payment-due');if(dueEl)dueEl.textContent='…';paymentInputs.forEach((input)=>{input.value='0';});['#payment-bonus-field','#payment-deposit-field','#payment-reservation-field'].forEach((selector)=>{const field=document.querySelector(selector);if(field)field.hidden=true;});const message=document.querySelector('#payment-message');if(message)message.textContent='Загружаем платежи…';const submit=paymentForm?.querySelector('[type=submit]');if(submit)submit.disabled=true;paymentModal?.classList.add('open');refreshPaymentRemainder();paymentInputs[0]?.focus();try{await loadPaymentState(orderId,revision);}catch(_){if(revision===paymentLoadRevision&&currentOrder?.id===orderId&&paymentModal?.classList.contains('open')&&message)message.textContent='Не удалось загрузить платежи. Закройте окно и повторите.';}
});
paymentForm?.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const submit=paymentForm.querySelector('[type=submit]');
  if(submit?.disabled||!paymentState||paymentState.orderId!==currentOrder?.id||paymentPostsPending.has(paymentState.orderId))return;
  const orderId=paymentState.orderId,revision=paymentLoadRevision;
  const isCurrent=()=>revision===paymentLoadRevision&&currentOrder?.id===orderId&&paymentModal?.classList.contains('open');
  submit.disabled=true;
  const entries=['cash','card','qr','bonus','deposit','reservation'].map((method)=>({method,amount:Number(document.querySelector(`#payment-${method}`)?.value||0),...(method==='reservation'?{receiptId:document.querySelector('#payment-reservation-receipt')?.value||''}:{})})).filter((entry)=>entry.amount>0);
  const total=entries.reduce((sum,entry)=>sum+entry.amount,0),message=document.querySelector('#payment-message');
  if(!entries.length||total>paymentState.remaining+0.01||(entries.some((entry)=>entry.method==='bonus')&&(!Number.isInteger(entries.find((entry)=>entry.method==='bonus')?.amount)||entries.find((entry)=>entry.method==='bonus').amount>Math.min(Number(paymentState.guestAccount?.bonusBalance||0),paymentState.bonusRedemptionRemaining)))||(entries.some((entry)=>entry.method==='deposit')&&entries.find((entry)=>entry.method==='deposit').amount>Number(paymentState.guestAccount?.depositBalance||0))){if(message)message.textContent=total>paymentState.remaining?'Сумма платежей больше остатка заказа.':entries.some((entry)=>entry.method==='bonus')?'Списание бонусов должно быть целым числом и укладываться в баланс и лимит чека.':entries.some((entry)=>entry.method==='deposit')?'Сумма со счёта превышает доступный денежный баланс.':'Укажите хотя бы один способ оплаты.';submit.disabled=false;return;}
  paymentPostsPending.add(orderId);
  let closed=false,paid=paymentState.paid,remaining=paymentState.remaining,due=paymentState.due,bonusEarned=0;
  try{
    for(const entry of entries){
      const attemptKey=`${orderId}:${entry.method}:${entry.amount}:${entry.receiptId||''}`;let idempotencyKey=paymentAttemptKeys.get(attemptKey);if(!idempotencyKey){idempotencyKey=crypto.randomUUID();paymentAttemptKeys.set(attemptKey,idempotencyKey);}const result=await apiJson(`/api/orders/${orderId}/payments`,{method:'POST',headers:orderHeaders(),body:JSON.stringify({...entry,idempotencyKey})});paymentAttemptKeys.delete(attemptKey);
      paid=Number(result.paid??paid+entry.amount);remaining=Number(result.remaining??Math.max(0,remaining-entry.amount));due=Number(result.due??due);closed=Boolean(result.closed);bonusEarned=Number(result.loyaltyBonusEarned||0);
      if(!isCurrent()){
        if(closed&&currentOrder?.id===orderId&&paymentModal?.classList.contains('open')){paymentLoadRevision+=1;paymentState=null;paymentModal.classList.remove('open');notice('Заказ оплачен');}
        await loadOrders();if(closed)await refreshFloor();return;
      }
      paymentState={orderId,due,paid,remaining,guestAccount:result.guestAccount||paymentState.guestAccount};currentOrder.paid=paid;currentOrder.remaining=remaining;currentOrder.status=closed?'closed':currentOrder.status;
      const input=document.querySelector(`#payment-${entry.method}`);if(input)input.value='0';if(entry.method==='bonus'&&message)message.textContent=`Списано ${entry.amount} бонусов · остаток ${Number(result.guestAccount?.bonusBalance||0)} бонусов`;if(entry.method==='deposit'&&message)message.textContent=`Списано ${entry.amount.toLocaleString('ru-RU')} ₽ со счёта · остаток ${Number(result.guestAccount?.depositBalance||0).toLocaleString('ru-RU')} ₽`;if(entry.method==='reservation'&&message)message.textContent=`Зачтено ${entry.amount.toLocaleString('ru-RU')} ₽ из квитанции брони · наличность смены не изменяется`;refreshPaymentRemainder();
      if(closed)break;
    }
    if(!isCurrent())return;
    paymentLoadRevision+=1;paymentModal.classList.remove('open');
    if(closed){const active=openOrders.find((order)=>order.id===orderId);if(active)active.status='closed';drawQueue();}
    notice(closed?`Заказ оплачен частями${bonusEarned>0?` · начислено ${bonusEarned} ${pluralRu(bonusEarned,'бонус','бонуса','бонусов')}`:''}`:`Платёж сохранён, остаток ${remaining.toLocaleString('ru-RU')} ₽`);
    if(closed){currentOrder=null;drawOrder({items:[]});await loadOrders();await refreshFloor();}
  }catch(error){
    if(!isCurrent())return;
    paymentInputs.forEach((input)=>{input.value='0';});
    try{
      await loadPaymentState(orderId,revision);
      if(!isCurrent())return;
      if(paymentState?.remaining<=0){paymentLoadRevision+=1;paymentModal.classList.remove('open');await loadOrders();await refreshFloor();notice('Заказ оплачен');return;}
      if(message){const code=error?.payload?.error;message.textContent=code==='insufficient_bonus_balance'?'Бонусов уже недостаточно. Баланс обновлён; проверьте сумму.':code==='guest_required_for_bonus'?'Для списания бонусов привяжите гостя к заказу.':code==='payment_exceeds_due'?'Сумма платежа превышает остаток заказа.':code==='reservation_pre_payment_insufficient'?'В выбранной квитанции осталось меньше. Баланс обновлён; проверьте сумму.':code==='order_has_no_reservation'?'Этот заказ не связан с бронью.':code==='idempotency_key_reused'?'Не удалось сверить повтор платежа. Обновите окно оплаты.':'Не удалось завершить платёж. Остаток обновлён; проверьте сумму.';}
    }catch(_){if(isCurrent()){paymentState=null;if(message)message.textContent='Не удалось сверить платежи. Закройте окно и откройте его снова.';}}
  }finally{
    paymentPostsPending.delete(orderId);
    if(revision!==paymentLoadRevision&&currentOrder?.id===orderId&&paymentModal?.classList.contains('open')){
      const refreshRevision=paymentLoadRevision;
      try{await loadPaymentState(orderId,refreshRevision);}catch(_){if(refreshRevision===paymentLoadRevision&&currentOrder?.id===orderId&&paymentModal?.classList.contains('open')){paymentState=null;if(message)message.textContent='Не удалось сверить платежи. Закройте окно и откройте его снова.';}}
    }
    if(isCurrent()&&submit)submit.disabled=!paymentState||paymentState.remaining<=0;
  }
});
document.querySelectorAll('.chips button').forEach((chip)=>chip.addEventListener('click',()=>{drawQueue(chip.dataset.filter||'all');notice(`Фильтр «${chip.textContent.trim().replace(/\s+\d+$/,'')}» применён`);}));
document.querySelector('#queue-list')?.addEventListener('click',(event)=>{if(!floorReady)return;const card=event.target.closest('[data-queue-table]');if(!card)return;const order=openOrders.find((item)=>item.id===card.dataset.queueOrder);const table=document.querySelector(`.table[data-table="${card.dataset.queueTable}"]`);if(table)table.click();if(order)drawOrder(order);document.querySelector('.workspace')?.scrollIntoView({behavior:'smooth',block:'start'});});

function mountStaffExtensions(){
if(!window.__staffProfileLoaded){window.__staffProfileLoaded=true;const script=document.createElement('script');script.src='/staff-profile.js?rev=7';document.head.append(script);}
if(!window.__staffAuditLoaded){window.__staffAuditLoaded=true;const script=document.createElement('script');script.src='/staff-audit.js?rev=1';document.head.append(script);}
if(!window.__vipDepositLoaded){window.__vipDepositLoaded=true;const script=document.createElement('script');script.src='/vip-deposit.js?rev=1';document.head.append(script);}
if(!window.__vipDepositUiLoaded){window.__vipDepositUiLoaded=true;const script=document.createElement('script');script.src='/vip-deposit-ui.js?rev=3';document.head.append(script);}
}
if(staffSessionVerified){mountStaffExtensions();document.querySelector('.order')?.removeAttribute('inert');}
drawOrder(null);drawQueue();


/* Global Russian phone formatting */
(function mountRussianPhoneFormat(){
  const isPhone=(input)=>input instanceof HTMLInputElement && !input.disabled && (input.type==='tel'||/phone|телефон|mobile|мобиль/i.test(`${input.id} ${input.name}`)||/^\s*\+?7(?:\s|\(|$)/.test(input.placeholder||''));
  const format=(value)=>{
    const raw=String(value||'');
    let digits=raw.replace(/\D/g,'');
    if (!digits) return raw.trim()==='+7' ? '+7 ' : '';
    if (digits[0]==='8') digits=digits.slice(1);
    else if (digits[0]==='7') digits=digits.slice(1);
    digits=digits.slice(0,10);
    const groups=[digits.slice(0,3),digits.slice(3,6),digits.slice(6,8),digits.slice(8,10)].filter(Boolean);
    let result='+7';
    if(groups[0]) result+=` (${groups[0]}`+(groups[0].length===3?') ':'');
    if(groups[1]) result+=groups[1];
    if(groups[2]) result+=`-${groups[2]}`;
    if(groups[3]) result+=`-${groups[3]}`;
    return result;
  };
  const mount=()=>document.querySelectorAll('input').forEach((input)=>{
    if(!isPhone(input)||input.dataset.ruPhoneReady==='1') return;
    input.dataset.ruPhoneReady='1'; input.inputMode='tel'; input.autocomplete=input.autocomplete||'tel';
    const apply=()=>{const before=input.value;const next=format(before);if(next!==before){const end=input.selectionStart===before.length;input.value=next;if(end)input.setSelectionRange(next.length,next.length);}};
    input.addEventListener('focus',()=>{if(!input.value.trim()) input.value='+7 ';});
    input.addEventListener('input',apply); input.addEventListener('paste',()=>setTimeout(apply,0));
    input.addEventListener('blur',()=>{apply();if(input.value.trim()==='+7')input.value='';}); apply();
  });
  mount(); new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
})();
