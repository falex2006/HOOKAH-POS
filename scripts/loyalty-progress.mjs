import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { advanceRoadmap, summarizeRoadmap, validateRoadmap } from './loyalty-progress-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roadmapPath = path.join(root, 'docs', 'requirements', 'LOYALTY_ROADMAP.json');
let roadmap = JSON.parse(await readFile(roadmapPath, 'utf8'));
validateRoadmap(roadmap);

const completeStepArg = process.argv.indexOf('--complete-step');
if (completeStepArg >= 0) {
  const requestedId = process.argv[completeStepArg + 1];
  roadmap = advanceRoadmap(roadmap, requestedId);
  await writeFile(roadmapPath, `${JSON.stringify(roadmap, null, 2)}\n`, 'utf8');
}

const result = summarizeRoadmap(roadmap);
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  if (completeStepArg >= 0) console.log(`Подэтап ${process.argv[completeStepArg + 1]} закрыт; следующий статус переведён автоматически.`);
  console.log(`${result.title}`);
  console.log(result.currentStage ? `Текущий этап ${result.currentStage.number}/${result.currentStage.total}: ${result.currentStage.title}` : 'Все этапы завершены');
  if (result.activeSubstep) console.log(`Текущий подэтап ${result.activeSubstep.id}: ${result.activeSubstep.title}`);
  console.log(`Выполнено этапов: ${result.completeStages}/${result.stages.length}; осталось этапов: ${result.remainingStages}`);
  console.log(`Пройдено по порядку: ${result.sequentialCompletedSubsteps}/${result.totalSubsteps}; прогресс: ${result.percent}%; незакрыто в очереди: ${result.sequentialRemainingSubsteps}`);
  if (result.deferredVerifiedSubsteps) console.log(`За пределами текущей очереди независимо завершены: ${result.deferredVerifiedSubsteps} подэтапа; всего отмечено завершёнными: ${result.verifiedSubsteps}/${result.totalSubsteps} (${result.verifiedPercent}%).`);
  else console.log(`Отмечено завершёнными: ${result.verifiedSubsteps}/${result.totalSubsteps} (${result.verifiedPercent}%).`);
  for (const stage of result.stages) console.log(`${stage.number}. [${stage.status}] ${stage.title} — ${stage.completedSubsteps}/${stage.totalSubsteps}`);
}
