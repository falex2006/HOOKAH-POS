import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const calendar = read('../staff-schedule-ui.js');
const planning = read('../staff-schedule-planning-ui.js');
const guide = JSON.parse(read('../help-content.js').match(/const articles = (.*);/)[1]).find(article => article.id === 'staff-schedule').html;
const helpTopic = guide.match(/<section><h3>Прямое назначение, черновик и права доступа<\/h3>[\s\S]*?<\/section>/)?.[0];
assert.ok(helpTopic, 'preparation guidance must remain in the existing schedule help topic');
assert.equal([...guide.matchAll(/<section><h3>/g)].length, 15, 'do not add a schedule help topic');
assert.match(helpTopic, /пустое значение наследует текущее правило заведения/);
assert.match(helpTopic, /0 отключает ранний выход/);
assert.match(helpTopic, /1–240 задаёт минуты/);
assert.match(helpTopic, /слота шаблона переносится в смену при публикации/);
assert.match(helpTopic, /числовой override сохраняется и не меняется при последующей правке шаблона/);
assert.match(helpTopic, /«Команда → Выход на работу» \(доступ выдаётся отдельными правами\)/);
assert.match(helpTopic, /не открывает кассовую смену и не рассчитывает зарплату/);
assert.match(calendar, /name="preparationMinutes" type="number" min="0" max="240" step="1"/,
  'direct shift editor must offer a bounded optional whole-minute override');
assert.match(calendar, /preparationMinutes:\s*\['shift','open_shift'\]\.includes\(data\.get\('kind'\)\)\s*\?\s*\(data\.get\('preparationMinutes'\) === '' \? null : Number\(data\.get\('preparationMinutes'\)\)\)\s*:\s*null/,
  'direct schedule saves must send explicit null/number for shifts and null for absences');
assert.match(calendar, /hasOwnProperty\.call\(slot,'preparationMinutes'\)[\s\S]*?form\.elements\.preparationMinutes\.value=slot\.preparationMinutes==null\?'':String\(slot\.preparationMinutes\)/,
  'template suggestions must copy an explicitly provided value without erasing legacy omissions');
assert.match(planning, /data-slot-preparation/,
  'shared slot editor must expose preparation override for templates, team members, series and range composition');
assert.match(planning, /preparationMinutes=rawPreparation==null\|\|rawPreparation===''\?null:Number\(rawPreparation\)/,
  'slot serialization must preserve blank as null and zero as zero');
assert.match(planning, /\['shift','open_shift'\]\.includes\(kind\)[\s\S]*?preparationMinutes\}:{kind,note,breakMinutes:0,preparationMinutes:null}/,
  'work slots serialize null/override while absence slots serialize null');
assert.match(planning, /normalized=\{schemaVersion:2,mode:'team',pattern,members\}/);
assert.match(planning, /slots:readSlots\(sharedSlots\)/,
  'selected templates serialize the same optional slot field');
assert.match(planning, /\{\.\.\.definition,cycleOffset:Number\(data\.get\('cycleOffset'\)\|\|0\)/,
  'series payload carries the same slot definition');
assert.match(planning, /slot:readSlots\(card\.querySelector\('\[data-ex-slot\]'\)\)\[0\]/,
  'series replacement exceptions serialize the same optional slot field');
assert.match(planning, /slots:readSlots\(card\.querySelector\('\[data-team-slots\]'\)\)/,
  'team-member slots serialize the same optional slot field');

assert.equal(read('../dist/staff-schedule-ui.js'), calendar, 'published calendar UI must match source');
assert.equal(read('../dist/staff-schedule-planning-ui.js'), planning, 'published planning UI must match source');
console.log('STAFF SCHEDULE PREPARATION UI CONTRACT: PASS');
