import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { advanceRoadmap, summarizeRoadmap, validateRoadmap } from './loyalty-progress-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roadmapPath = path.join(root, 'docs', 'requirements', 'LOYALTY_ROADMAP.json');
const progressPath = path.join(root, 'scripts', 'loyalty-progress.mjs');
const roadmap = JSON.parse(await readFile(roadmapPath, 'utf8'));
validateRoadmap(roadmap);

const summary = summarizeRoadmap(roadmap);
assert.equal(summary.currentStage, null);
assert.equal(summary.activeSubstep, null);
assert.equal(summary.completeStages, 14);
assert.equal(summary.remainingStages, 0);
assert.equal(summary.sequentialCompletedSubsteps, 52);
assert.equal(summary.verifiedSubsteps, 52);
assert.equal(summary.deferredVerifiedSubsteps, 0);
assert.equal(summary.totalSubsteps, 52);
assert.equal(summary.percent, 100);
assert.equal(summary.verifiedPercent, 100);
assert.equal(summary.sequentialRemainingSubsteps, 0);
assert.equal(summary.remainingSubsteps, 0);
assert.equal(roadmap.stages[11].status, 'complete', 'the ordered reconciliation stage is complete');
assert.equal(roadmap.stages[11].steps[3].status, 'complete', 'L12.4 evidence is preserved');
assert.equal(roadmap.stages[12].status, 'complete', 'the final acceptance stage is complete');
assert.equal(roadmap.stages[12].steps[0].status, 'complete', 'L13.1 end-to-end evidence is preserved');
assert.equal(roadmap.stages[12].steps[1].status, 'complete', 'L13.2 evidence is preserved');
assert.equal(roadmap.stages[12].steps[2].status, 'complete', 'L13.3 responsive UI evidence is preserved');
assert.equal(roadmap.stages[13].status, 'complete', 'the line-level loyalty/POS/Finance integration stage is complete');
assert.equal(roadmap.stages[13].steps[2].status, 'complete', 'L14.3 item-return evidence is preserved');

const completedRoadmap = structuredClone(roadmap);
const beforeL123 = structuredClone(roadmap);
beforeL123.stages[11].status = 'in_progress';
beforeL123.stages[11].steps[2].status = 'in_progress';
beforeL123.stages[12].status = 'pending';
beforeL123.stages[12].steps[3].status = 'pending';
beforeL123.stages[13].status = 'pending';
for (const step of beforeL123.stages[13].steps) step.status = 'pending';
validateRoadmap(beforeL123);
const afterL123 = advanceRoadmap(beforeL123, 'L12.3');
assert.equal(afterL123.stages[12].status, 'in_progress');
assert.equal(afterL123.stages[12].steps[3].status, 'in_progress', 'completing L12.3 automatically activates L13.4');
assert.equal(afterL123.stages[12].steps[0].status, 'complete', 'independent downstream acceptance evidence is retained');
assert.throws(() => advanceRoadmap(afterL123, 'L13.1'), /expected L13\.4/);
const afterL134 = advanceRoadmap(afterL123, 'L13.4');
assert.equal(afterL134.stages[12].steps[3].status, 'complete');
assert.equal(afterL134.stages[13].status, 'in_progress', 'closing L13.4 activates the next integration stage');
assert.equal(afterL134.stages[13].steps[0].status, 'in_progress');
assert.equal(afterL134.stages[13].steps[1].status, 'pending');
assert.equal(afterL134.stages[13].steps[2].status, 'pending');
const afterL141 = advanceRoadmap(afterL134, 'L14.1');
assert.equal(afterL141.stages[13].steps[1].status, 'in_progress');
const afterL142 = advanceRoadmap(afterL141, 'L14.2');
assert.equal(afterL142.stages[13].steps[2].status, 'in_progress');
const afterL143 = advanceRoadmap(afterL142, 'L14.3');
assert.deepEqual(afterL143, completedRoadmap, 'closing L14.3 reaches the current all-complete roadmap');
assert.equal(summarizeRoadmap(afterL143).activeSubstep, null, 'all complete roadmap has no active item');

const invalidMultipleActive = structuredClone(roadmap);
invalidMultipleActive.stages[12].status = 'in_progress';
invalidMultipleActive.stages[12].steps[1].status = 'in_progress';
invalidMultipleActive.stages[12].steps[3].status = 'in_progress';
invalidMultipleActive.stages[13].status = 'pending';
for (const step of invalidMultipleActive.stages[13].steps) step.status = 'pending';
assert.throws(() => validateRoadmap(invalidMultipleActive), /Only one roadmap substep/);

const beforeCli = await readFile(roadmapPath, 'utf8');
assert.throws(
  () => execFileSync(process.execPath, [progressPath, '--complete-step', 'L13.4'], { cwd: root, stdio: 'pipe' }),
  (error) => error.status === 1 && error.stderr.toString().includes('expected none'),
  'CLI rejects completion requests after the roadmap is complete',
);
assert.equal(await readFile(roadmapPath, 'utf8'), beforeCli, 'rejected CLI operation writes no partial roadmap state');

console.log('LOYALTY PROGRESS CONTRACT: PASS (single global active step, ordered percent, retained downstream evidence, atomic advance)');
