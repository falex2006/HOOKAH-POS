import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Current-source regression guard for the confirmed UI-09.1 theme defects.
// Browser cascade, readiness, focus and actual contrast remain separate evidence.
const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
assert.equal(css,readFileSync(new URL('../dist/style.css',import.meta.url),'utf8'),'published CSS must match source');
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const declarations=(selector,source=css)=>{
  const match=source.match(new RegExp(escape(selector)+'\\s*\\{([^}]+)\\}'));
  assert.ok(match,`missing scoped rule: ${selector}`);
  return match[1];
};
const token=(body,property,name)=>assert.match(body,new RegExp('(?:^|;)\\s*'+property+':\\s*var\\(--ui-'+name+'\\)(?:;|$)'),`${property} must use theme role ${name}`);
const controls=declarations('.dashboard-shift-controls input,.dashboard-shift-controls select');
token(controls,'background','input');token(controls,'color','text-primary');
// Border is a composed declaration, so check its theme reference separately.
assert.match(controls,/border:1px solid var\(--ui-border-control\)/);
assert.match(controls,/min-height:44px/,'retain accessible control height');
const cards=declarations('.dashboard-shift-stat,.dashboard-shift-methods');
token(cards,'background','panel');token(cards,'color','text-primary');
assert.match(cards,/border:1px solid var\(--ui-border-control\)/);
token(declarations('.dashboard-shift-stat>strong'),'color','text-primary');
token(declarations('.dashboard-shift-methods>div strong'),'color','text-primary');
for(const selector of ['.dashboard-shift-controls label','.dashboard-shift-context','.dashboard-shift-stat>span,.dashboard-shift-methods>b','.dashboard-shift-stat>small','.dashboard-shift-methods>div'])token(declarations(selector),'color','text-secondary');
const hero=declarations('.dashboard-shift-stat--hero');
assert.match(hero,/linear-gradient/,'retain previously approved hero accent');
assert.ok(hero.includes('var(--ui-panel)')&&hero.includes('var(--ui-border-control)'),'hero accent must blend with theme surface');
for(const body of [controls,cards,hero])assert.doesNotMatch(body,/var\(--(?:surface|border|muted|text-primary)[,)]/,'do not reintroduce legacy dark aliases');

const marker='/* UI-09.1: confirmed desktop light-theme readability regressions. */';
const scopeStart=css.indexOf(marker);assert.ok(scopeStart>=0,'readability remediation scope required');
const scope=css.slice(scopeStart);
assert.equal([...scope.matchAll(/\{/g)].length,3,'readability scope contains only three proven light fixes');
assert.doesNotMatch(scope,/!important|position:|height:|display:|\.portal-header|\.portal-sidebar/,'readability fixes cannot alter shell geometry');
const headerSelector='.portal.light-theme :is(.inventory-stock-panel,.inventory-auto-order-panel) thead th';
for(const panel of ['.inventory-stock-panel','.inventory-auto-order-panel'])assert.ok(headerSelector.includes(panel),`${panel} sticky heading theme coverage`);
const header=declarations(headerSelector,scope);
token(header,'background','raised');token(header,'color','text-secondary');token(header,'border-color','border-control');
const warning=declarations('.portal.light-theme[data-page="orders"] .badge.warning',scope);
token(warning,'background','raised');token(warning,'color','warning');
const close=declarations('.portal.light-theme #shift-close',scope);
token(close,'background','panel');token(close,'color','danger');token(close,'border-color','danger');

// Token-pair contrast checks are deterministic source policy, not rendered contrast.
const light=css.match(/\.portal\.light-theme, \.staff-theme\.light-theme\s*\{([^}]+)\}/)?.[1];
const dark=css.match(/:root\s*\{\s*(--ui-page:[\s\S]*?)\n\}/)?.[1];
assert.ok(light&&dark,'both theme maps required');
const role=(theme,name)=>{const value=theme.match(new RegExp('--ui-'+name+':\\s*(#[a-fA-F0-9]{6});'))?.[1];assert.ok(value,`solid theme role ${name}`);return value;};
const luminance=hex=>{const rgb=hex.slice(1).match(/../g).map(part=>parseInt(part,16)/255).map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
const ratio=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);return(values[0]+.05)/(values[1]+.05);};
for(const theme of [dark,light])for(const [foreground,background]of [['text-primary','panel'],['text-secondary','panel'],['text-primary','input']])assert.ok(ratio(role(theme,foreground),role(theme,background))>=4.5,`${foreground}/${background} theme contrast`);
for(const [foreground,background]of [['text-secondary','raised'],['warning','raised'],['danger','panel']])assert.ok(ratio(role(light,foreground),role(light,background))>=4.5,`${foreground}/${background} light regression contrast`);
console.log('UI-09.1 desktop readability source contract PASS: theme pairs, scoped fixes, shell boundary and CSS mirror; actual browser evidence separate.');
