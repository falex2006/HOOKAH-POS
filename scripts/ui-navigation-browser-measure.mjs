import measureShell from './ui-shell-browser-measure.mjs';
// Run only through the documented CUA read-only page API.
export default async function measure(tab) {
 const shell=await measureShell(tab);
 const navigation=await tab.playwright.evaluate(()=>{
  const sidebar=document.querySelector('.portal-sidebar');
  const visible=e=>{if(!e||!e.getClientRects().length)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(p.hidden||s.display==='none'||s.visibility==='hidden'||p.hasAttribute('inert'))return false;if(p.tagName==='DETAILS'&&!p.open&&!p.querySelector('summary')?.contains(e))return false;}return true;};
  return {search:sidebar?.querySelector('#sidebar-menu-search')?.value||'',groups:[...(sidebar?.querySelectorAll('details[data-nav-group]')||[])].map(e=>({key:e.dataset.navGroup,open:e.open,hidden:e.hidden,expanded:e.querySelector('summary')?.getAttribute('aria-expanded'),activeSummary:e.querySelector('summary')?.getAttribute('aria-current'),links:[...e.querySelectorAll('a[href]')].map(a=>({href:a.getAttribute('href'),label:a.getAttribute('aria-label')||a.textContent.trim(),hidden:a.hidden,searchHidden:a.dataset.menuSearchHidden,active:a.classList.contains('active'),current:a.getAttribute('aria-current'),visible:visible(a)}))})),identity:sidebar?.querySelector('.sidebar-profile')?.textContent.trim()||'',heading:document.querySelector('.portal-header')?.textContent.trim()||'',focus:{tag:document.activeElement.tagName,id:document.activeElement.id,label:document.activeElement.getAttribute('aria-label'),focusVisible:document.activeElement.matches(':focus-visible')}};
 });
 return {...shell,navigation};
}
