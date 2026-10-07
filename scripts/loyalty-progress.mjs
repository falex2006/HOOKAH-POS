import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roadmapPath = path.join(root, 'docs', 'requirements', 'LOYALTY_ROADMAP.json');
const roadmap = JSON.parse(await readFile(roadmapPath, 'utf8'));
const validStatuses = new Set(['pending', 'in_progress', 'complete']);
const ids = new Set();
let sawOpenStage = false;
let expectedStageNumber = 1;
for (const [index, stage] of roadmap.stages.entries()) {
  if (!stage.id || ids.has(stage.id) || !validStatuses.has(stage.status) || !Array.isArray(stage.steps) || !stage.steps.length) throw new Error(`Invalid roadmap stage at position ${index + 1}`);
  if (stage.id !== `L${String(expectedStageNumber).padStart(2, '0')}`) throw new Error(`Stage numbering must be sequential: expected L${String(expectedStageNumber).padStart(2, '0')}, got ${stage.id}`);
  expectedStageNumber += 1;
  ids.add(stage.id);
  let expectedStepNumber = 1;
  for (const step of stage.steps) {
    if (step.id !== `${stage.id}.${expectedStepNumber}`) throw new Error(`Substep numbering must be sequential: expected ${stage.id}.${expectedStepNumber}, got ${step.id}`);
    expectedStepNumber += 1;
    if (!step.id || ids.has(step.id) || !validStatuses.has(step.status)) throw new Error(`Invalid or duplicate roadmap step ${step.id || '(missing)'}`);
    ids.add(step.id);
  }
  const allDone = stage.steps.every((step) => step.status === 'complete');
  if ((stage.status === 'complete') !== allDone) throw new Error(`${stage.id} status disagrees with its substeps`);
  if (stage.status === 'complete' && sawOpenStage) throw new Error(`${stage.id} is complete after an unfinished stage; stages must progress in order`);
  if (stage.status !== 'complete') sawOpenStage = true;
  const openSteps = stage.steps.filter((step) => step.status !== 'complete');
  if (stage.status === 'in_progress' && (!openSteps.length || !openSteps.some((step) => step.status === 'in_progress'))) throw new Error(`${stage.id} must have an active substep`);
  if (stage.status === 'pending' && stage.steps.some((step) => step.status === 'in_progress')) throw new Error(`${stage.id} is pending but has an active substep`);
  if (stage.steps.some((step) => step.status === 'in_progress') && stage.steps.filter((step) => step.status === 'in_progress').length > 1) throw new Error(`${stage.id} has multiple active substeps`);
  if (openSteps.filter((step) => step.status === 'in_progress').length && openSteps.find((step) => step.status === 'in_progress') !== openSteps[0]) throw new Error(`${stage.id} must work on the earliest unfinished substep`);
}
const flatSteps = roadmap.stages.flatMap((stage) => stage.steps.map((step) => ({ ...step, stage })));
const doneSteps = flatSteps.filter((step) => step.status === 'complete').length;
const totalSteps = flatSteps.length;
const currentIndex = roadmap.stages.findIndex((stage) => stage.status !== 'complete');
const current = currentIndex < 0 ? null : roadmap.stages[currentIndex];
const activeSubstep = current?.steps.find((step) => step.status === 'in_progress') || current?.steps.find((step) => step.status !== 'complete');
const completeStages = roadmap.stages.filter((stage) => stage.status === 'complete').length;
const percent = Math.floor(doneSteps * 100 / totalSteps);
const remainingStages = roadmap.stages.length - completeStages;
const result = {
  title: roadmap.title,
  currentStage: current ? { number: currentIndex + 1, total: roadmap.stages.length, id: current.id, title: current.title, status: current.status } : null,
  activeSubstep: activeSubstep ? { id: activeSubstep.id, title: activeSubstep.title } : null,
  completeStages,
  remainingStages,
  completedSubsteps: doneSteps,
  totalSubsteps: totalSteps,
  percent,
  stages: roadmap.stages.map((stage, index) => ({ number: index + 1, id: stage.id, title: stage.title, status: stage.status, completedSubsteps: stage.steps.filter((step) => step.status === 'complete').length, totalSubsteps: stage.steps.length }))
};
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`${result.title}`);
  console.log(current ? `Текущий этап ${currentIndex + 1}/${roadmap.stages.length}: ${current.title}` : 'Все этапы завершены');
  if (activeSubstep) console.log(`Текущий подэтап ${activeSubstep.id}: ${activeSubstep.title}`);
  console.log(`Выполнено этапов: ${completeStages}/${roadmap.stages.length}; осталось этапов: ${remainingStages}`);
  console.log(`Выполнено подэтапов: ${doneSteps}/${totalSteps}; прогресс: ${percent}%; осталось подэтапов: ${totalSteps - doneSteps}`);
  for (const stage of result.stages) console.log(`${stage.number}. [${stage.status}] ${stage.title} — ${stage.completedSubsteps}/${stage.totalSubsteps}`);
}
