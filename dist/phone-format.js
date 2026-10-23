(function mountRussianPhoneFormat(){
  const isPhone=(input)=>input instanceof HTMLInputElement && !input.disabled && (input.type==='tel'||/phone|телефон|mobile|мобиль/i.test(`${input.id} ${input.name}`)||/^\s*\+?7(?:\s|\(|$)/.test(input.placeholder||''));
  const format=(value)=>{
    const raw=String(value||'');
    let digits=raw.replace(/\D/g,'');
    if (!digits) return '';
    if (digits[0]==='8'||digits[0]==='7') digits=digits.slice(1);
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
    const apply=()=>{
      const before=input.value, next=format(before);
      if(next===before) return;
      const position=input.selectionStart;
      const digitsBefore=(before.slice(0,position??before.length).match(/\d/g)||[]).length;
      const hasCountry=/^[78]/.test(before.replace(/\D/g,''));
      const targetDigits=digitsBefore+(hasCountry?0:1);
      let caret=position===0?0:next.length;
      if(position!==null&&position>0&&position<before.length){
        let seen=0;
        for(let i=0;i<next.length;i++){if(/\d/.test(next[i]))seen++;if(seen===targetDigits){caret=i+1;break;}}
      }
      input.value=next;
      if(position!==null) input.setSelectionRange(caret,caret);
    };
    // Keep empty focus empty: a pasted full number must not follow an injected country code.
    // Deletion stays editable through mask punctuation; blur normalizes the remaining digits.
    input.addEventListener('input',(event)=>{if(!event.isComposing&&!String(event.inputType||'').startsWith('delete'))apply();});
    input.addEventListener('compositionend',apply);
    input.addEventListener('paste',()=>setTimeout(apply,0));
    input.addEventListener('blur',()=>{apply();if(input.value.trim()==='+7')input.value='';}); apply();
  });
  mount(); new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
})();
