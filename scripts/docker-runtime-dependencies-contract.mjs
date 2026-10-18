import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8').replace(/\\\r?\n/g,' ');
const copies=docker.split(/\r?\n/).filter(line=>/^COPY\s/.test(line)).flatMap(line=>line.trim().split(/\s+/).slice(1,-1));
const copied=file=>copies.some(source=>source===file||file.startsWith(`${source}/`)||(source==='package*.json'&&/^package[^/]*\.json$/.test(file)));
const queue=['server.js'], visited=new Set(), missing=[];
while(queue.length){
  const relative=queue.pop();if(visited.has(relative))continue;visited.add(relative);
  if(!copied(relative))missing.push(relative);
  if(!relative.endsWith('.js'))continue;
  const source=fs.readFileSync(path.join(root,relative),'utf8');
  for(const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)){
    const base=path.resolve(root,path.dirname(relative),match[1]);
    const resolved=[base,`${base}.js`,`${base}.json`,path.join(base,'index.js')].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
    assert.ok(resolved,`Missing local runtime dependency ${relative}: ${match[1]}`);
    const target=path.relative(root,resolved).replaceAll('\\','/');
    assert.ok(!target.startsWith('../'),`Runtime dependency leaves repository: ${target}`);
    queue.push(target);
  }
}
assert.deepEqual([...new Set(missing)].sort(),[],'Docker COPY must include every literal local server dependency');
assert.ok(copied('ui-dialog.js'),'financial dialogs need their shared browser runtime');
console.log(`DOCKER RUNTIME DEPENDENCIES: PASS (${visited.size} server files and shared dialog; literal requires only)`);
