const validStatuses = new Set(['pending', 'in_progress', 'complete']);

export const flattenSteps = (roadmap) => roadmap.stages.flatMap((stage) => stage.steps.map((step) => ({ ...step, stage })));

export function validateRoadmap(roadmap) {
  if (!roadmap || !Array.isArray(roadmap.stages) || !roadmap.stages.length) throw new Error('Roadmap must contain stages');
  const ids = new Set();
  let expectedStageNumber = 1;
  let sawOpenStage = false;
  let activeSteps = [];
  let activeStage = null;

  for (const [index, stage] of roadmap.stages.entries()) {
    const expectedStageId = `L${String(expectedStageNumber).padStart(2, '0')}`;
    if (stage.id !== expectedStageId || ids.has(stage.id) || !validStatuses.has(stage.status) || !Array.isArray(stage.steps) || !stage.steps.length) {
      throw new Error(`Invalid roadmap stage at position ${index + 1}; expected ${expectedStageId}`);
    }
    ids.add(stage.id);
    expectedStageNumber += 1;

    let expectedStepNumber = 1;
    for (const step of stage.steps) {
      const expectedStepId = `${stage.id}.${expectedStepNumber}`;
      if (step.id !== expectedStepId || ids.has(step.id) || !validStatuses.has(step.status)) throw new Error(`Invalid or duplicate roadmap step; expected ${expectedStepId}`);
      ids.add(step.id);
      expectedStepNumber += 1;
      if (step.status === 'in_progress') activeSteps.push({ step, stage });
    }

    const allDone = stage.steps.every((step) => step.status === 'complete');
    if ((stage.status === 'complete') !== allDone) throw new Error(`${stage.id} status disagrees with its substeps`);
    if (stage.status === 'complete' && sawOpenStage) throw new Error(`${stage.id} is complete after an unfinished stage; stages must progress in order`);
    if (stage.status !== 'complete') {
      sawOpenStage = true;
      if (!activeStage) activeStage = stage;
    }
    if (stage.status === 'in_progress' && stage.steps.every((step) => step.status !== 'in_progress')) throw new Error(`${stage.id} must contain the single active substep`);
    if (stage.status === 'pending' && stage.steps.some((step) => step.status === 'in_progress')) throw new Error(`${stage.id} is pending but has an active substep`);
  }

  const steps = flattenSteps(roadmap);
  const earliestUnfinished = steps.find(({ status }) => status !== 'complete');
  if (activeSteps.length > 1) throw new Error('Only one roadmap substep may be in progress globally');
  if (earliestUnfinished && activeSteps.length !== 1) throw new Error(`The earliest unfinished substep ${earliestUnfinished.id} must be the only active substep`);
  if (!earliestUnfinished && activeSteps.length) throw new Error('A fully complete roadmap cannot have an active substep');
  if (earliestUnfinished && (activeSteps[0].step.id !== earliestUnfinished.id || activeSteps[0].stage.id !== earliestUnfinished.stage.id)) {
    throw new Error(`Only the earliest unfinished substep ${earliestUnfinished.id} can be active`);
  }
  if (earliestUnfinished && activeStage?.id !== earliestUnfinished.stage.id) throw new Error(`Only ${earliestUnfinished.stage.id} may be the active stage`);
  if (earliestUnfinished && activeStage.status !== 'in_progress') throw new Error(`${activeStage.id} must be the active stage`);
  if (roadmap.stages.some((stage) => stage.status === 'in_progress' && stage.id !== activeStage?.id)) throw new Error('Only the stage containing the earliest unfinished substep may be active');
  return roadmap;
}

export function advanceRoadmap(roadmap, requestedId) {
  const next = structuredClone(roadmap);
  validateRoadmap(next);
  const steps = flattenSteps(next);
  const earliestUnfinished = steps.find(({ status }) => status !== 'complete');
  if (!requestedId || requestedId !== earliestUnfinished?.id) {
    throw new Error(`Only the earliest unfinished substep can be completed; expected ${earliestUnfinished?.id || 'none'}, received ${requestedId || 'none'}`);
  }

  const target = next.stages.flatMap((stage) => stage.steps.map((step) => ({ stage, step }))).find(({ step }) => step.id === requestedId);
  target.step.status = 'complete';
  const following = flattenSteps(next).find(({ status }) => status !== 'complete');
  for (const stage of next.stages) {
    for (const step of stage.steps) if (step.status === 'in_progress') step.status = 'pending';
    stage.status = stage.steps.every((step) => step.status === 'complete') ? 'complete' : 'pending';
  }
  if (following) {
    const nextStage = next.stages.find((stage) => stage.id === following.stage.id);
    const nextStep = nextStage.steps.find((step) => step.id === following.id);
    nextStage.status = 'in_progress';
    nextStep.status = 'in_progress';
  }
  validateRoadmap(next);
  return next;
}

export function summarizeRoadmap(roadmap) {
  validateRoadmap(roadmap);
  const steps = flattenSteps(roadmap);
  const firstOpenIndex = steps.findIndex((step) => step.status !== 'complete');
  const sequentialCompletedSubsteps = firstOpenIndex < 0 ? steps.length : firstOpenIndex;
  const verifiedSubsteps = steps.filter((step) => step.status === 'complete').length;
  const currentStageIndex = roadmap.stages.findIndex((stage) => stage.status !== 'complete');
  const currentStage = currentStageIndex < 0 ? null : roadmap.stages[currentStageIndex];
  const activeSubstep = currentStage?.steps.find((step) => step.status === 'in_progress') || null;
  const completeStages = roadmap.stages.filter((stage) => stage.status === 'complete').length;
  const totalSubsteps = steps.length;
  const percent = Math.floor(sequentialCompletedSubsteps * 100 / totalSubsteps);
  return {
    title: roadmap.title,
    currentStage: currentStage ? { number: currentStageIndex + 1, total: roadmap.stages.length, id: currentStage.id, title: currentStage.title, status: currentStage.status } : null,
    activeSubstep: activeSubstep ? { id: activeSubstep.id, title: activeSubstep.title } : null,
    completeStages,
    remainingStages: roadmap.stages.length - completeStages,
    completedSubsteps: sequentialCompletedSubsteps,
    sequentialCompletedSubsteps,
    verifiedSubsteps,
    deferredVerifiedSubsteps: verifiedSubsteps - sequentialCompletedSubsteps,
    totalSubsteps,
    remainingSubsteps: totalSubsteps - verifiedSubsteps,
    sequentialRemainingSubsteps: totalSubsteps - sequentialCompletedSubsteps,
    percent,
    verifiedPercent: Math.floor(verifiedSubsteps * 100 / totalSubsteps),
    stages: roadmap.stages.map((stage, index) => ({
      number: index + 1,
      id: stage.id,
      title: stage.title,
      status: stage.status,
      completedSubsteps: stage.steps.filter((step) => step.status === 'complete').length,
      totalSubsteps: stage.steps.length,
    })),
  };
}
