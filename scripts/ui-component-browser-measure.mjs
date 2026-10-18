// Loaded only inside cua_repl. All browser work uses the documented tab API.
export default async function measure(tab) {
  return tab.playwright.evaluate(() => {
    const color = value => {
      const n = value.match(/[\d.]+/g)?.map(Number);
      if (!n || n.length < 3) return null;
      return [...n.slice(0, 3), n[3] ?? 1];
    };
    const over = (fg, bg) => {
      const a = fg[3] + bg[3] * (1 - fg[3]);
      return [0, 1, 2].map(i => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / a).concat(a);
    };
    const backdrop = e => {
      const chain = []; for (let p = e; p; p = p.parentElement) chain.unshift(p);
      let bg = [255, 255, 255, 1];
      for (const p of chain) bg = over(color(getComputedStyle(p).backgroundColor), bg);
      return bg;
    };
    const luminance = rgb => rgb.slice(0, 3).map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0);
    const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const rect = e => { const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
    const targets = [...document.querySelectorAll('.ui-button,.ui-input,.ui-check')].map(e => {
      const s = getComputedStyle(e), bg = backdrop(e), fg = over(color(s.color), bg), outer = backdrop(e.parentElement);
      const input = e.matches('.ui-check') ? e.querySelector('input') : e;
      const indicator = e.matches('.ui-check') ? getComputedStyle(input) : s;
      const boundary = color(indicator.borderTopColor);
      const focusStyle = getComputedStyle(input), focus = color(focusStyle.outlineColor);
      const placeholder = e.matches('input.ui-input,textarea.ui-input') ? getComputedStyle(e, '::placeholder') : null;
      return { id:e.id || input.id || e.textContent.trim(),tag:e.tagName,classes:e.className,label:e.textContent.trim(),rect:rect(e),inputRect:rect(input),disabled:Boolean(input.disabled),readOnly:Boolean(input.readOnly),busy:input.getAttribute('aria-busy'),invalid:input.getAttribute('aria-invalid'),checked:input.checked,indeterminate:input.matches(':indeterminate'),value:input.value,indicatorGlyphContrast:input.checked||input.matches(':indeterminate')?contrast(over(color(indicator.color),backdrop(input)),backdrop(input)):null,
        fg,bg,outer,textContrast:contrast(fg,bg),border:boundary,borderWidth:indicator.borderTopWidth,boundaryContrast:contrast(over(boundary,outer),outer),hover:e.matches(':hover'),active:e.matches(':active'),focusVisible:input.matches(':focus-visible'),outline:focusStyle.outline,outlineOffset:focusStyle.outlineOffset,focusContrast:contrast(over(focus,outer),outer),placeholderContrast:placeholder?contrast(over(color(placeholder.color),bg),bg):null,font:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,transition:s.transitionDuration,backgroundImage:s.backgroundImage,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth };
    });
    const text = [...document.querySelectorAll('.ui-heading,.ui-text,.ui-helper,.ui-error,.ui-label,.ui-number,.ui-badge')].map(e => {
      const s=getComputedStyle(e),bg=backdrop(e),fg=over(color(s.color),bg);
      return {id:e.id,text:e.textContent,classes:e.className,rect:rect(e),color:fg,bg,contrast:contrast(fg,bg),font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,numeric:s.fontVariantNumeric,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,tabindex:e.getAttribute('tabindex')};
    });
    const focus = document.activeElement;
    const paintAssumptions=[...document.querySelectorAll('.ui-components,.ui-components *')].filter(e=>{const s=getComputedStyle(e);return s.opacity!=='1'||s.backgroundImage!=='none';}).map(e=>({id:e.id,classes:e.className,opacity:getComputedStyle(e).opacity,backgroundImage:getComputedStyle(e).backgroundImage}));
    const pseudos=[...document.querySelectorAll('[aria-busy="true"]')].map(e=>{const s=getComputedStyle(e,'::after');return {id:e.id,text:e.textContent,content:s.content,animation:s.animationName,duration:s.animationDuration};});
    return {url:location.href,body:document.body.className,viewport:{width:innerWidth,height:innerHeight,contentWidth:document.documentElement.clientWidth,dpr:devicePixelRatio},scroll:{x:scrollX,y:scrollY},page:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},fontFaces:[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules]).filter(r=>r.type===5).map(r=>({family:r.style.getPropertyValue('font-family'),weight:r.style.getPropertyValue('font-weight'),source:r.style.getPropertyValue('src')})),osReducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches,manualReducedMotion:document.body.classList.contains('ui-motion-reduced'),focus:{id:focus.id,tag:focus.tagName,visible:focus.matches(':focus-visible'),outline:getComputedStyle(focus).outline},paintAssumptions,pseudos,targets,text,spinner:[...document.querySelectorAll('.ui-spinner')].filter(e=>!e.hidden).map(e=>({animation:getComputedStyle(e).animationName,duration:getComputedStyle(e).animationDuration})),status:document.querySelector('#busy-result').textContent};
  });
}
