import * as crypto from "node:crypto";
import {
	appendLedger,
	collectPipelineBlockerFootprints,
	currentUltragoalSessionId,
	getUltragoalPaths,
	handleIdsFromValue,
	hashPipelineMetadata,
	isSubstantiveEvidence,
	type JsonObject,
	nonEmptyString,
	openPipelineOverlap,
	pipelinePeer,
	readUltragoalLedger,
	readUltragoalPlan,
	requireCoveredHandles,
	requireFreshPipelineMetadata,
	requireJsonObjectOrArrayValue,
	requireJsonObjectValue,
	requireNonEmptyPipelineTargets,
	resultHandleIds,
	stringArray,
	targetsAreDisjoint,
	targetsOverlap,
	type UltragoalGoal,
	type UltragoalLedgerEvent,
	type UltragoalPipelineLedgerEventName,
	type UltragoalPipelineOverlapReceipt,
	type UltragoalPipelineOverlapState,
	type UltragoalPlan,
	validateValidationBatchPipelineExclusion,
	writePlan,
} from "./ultragoal-runtime";

export function requirePipelineStartable(plan: UltragoalPlan, prior: UltragoalGoal, next: UltragoalGoal): void {
	if (plan.gjcGoalMode !== "aggregate")
		throw new Error("pipeline overlap is supported only for aggregate ultragoal mode");
	if (openPipelineOverlap(plan))
		throw new Error("Cannot start pipeline overlap because another overlap is already open");
	if (prior.status !== "active")
		throw new Error(`Prior goal ${prior.id} must be active before pipeline overlap starts`);
	if (next.status !== "pending" && next.status !== "failed")
		throw new Error(`Next goal ${next.id} must be pending or retryable failed`);
	validateValidationBatchPipelineExclusion(prior);
	validateValidationBatchPipelineExclusion(next);
	if (prior.validationBatch || next.validationBatch)
		throw new Error("pipeline overlap cannot start for validation batch goals");
	const priorMetadata = requireFreshPipelineMetadata(prior);
	const nextMetadata = requireFreshPipelineMetadata(next);
	if (!priorMetadata.eligible || !nextMetadata.eligible)
		throw new Error("pipeline overlap requires eligible original-plan metadata on both goals");
	if (!priorMetadata.independentOf.includes(next.id) || !nextMetadata.independentOf.includes(prior.id)) {
		throw new Error("pipeline overlap requires symmetric original independence");
	}
	if (!targetsAreDisjoint(priorMetadata.targets, nextMetadata.targets))
		throw new Error("pipeline overlap requires disjoint files and surfaces");
}

function pipelineEventRefs(prior: UltragoalGoal, next: UltragoalGoal): JsonObject {
	return {
		priorMetadataHash: prior.pipelineMetadata?.metadataHash,
		nextMetadataHash: next.pipelineMetadata?.metadataHash,
		priorTargets: prior.pipelineMetadata?.targets,
		nextTargets: next.pipelineMetadata?.targets,
	};
}

function pipelineReceipt(
	cwd: string,
	event: string,
	overlapId: string,
	prior: UltragoalGoal,
	next: UltragoalGoal,
): UltragoalPipelineOverlapReceipt {
	const paths = getUltragoalPaths(cwd, currentUltragoalSessionId(cwd));
	return {
		ok: true,
		event,
		overlap_id: overlapId,
		prior_goal_id: prior.id,
		next_goal_id: next.id,
		status: next.pipelineMetadata?.overlap,
		next_goal_status: next.status,
		goals_path: paths.goalsPath,
		ledger_path: paths.ledgerPath,
	};
}

export async function startUltragoalPipelineOverlap(input: {
	cwd: string;
	priorGoalId: string;
	nextGoalId: string;
	reviewHandles: JsonObject | JsonObject[];
	qaHandles: JsonObject | JsonObject[];
	implementationHandle: JsonObject;
}): Promise<UltragoalPipelineOverlapReceipt> {
	const plan = await readUltragoalPlan(input.cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	const prior = plan.goals.find(goal => goal.id === input.priorGoalId);
	const next = plan.goals.find(goal => goal.id === input.nextGoalId);
	if (!prior || !next) throw new Error("start-pipeline-overlap requires existing prior and next goal ids");
	const reviewHandles = requireJsonObjectOrArrayValue(input.reviewHandles, "review handles");
	const qaHandles = requireJsonObjectOrArrayValue(input.qaHandles, "QA handles");
	requireJsonObjectValue(input.implementationHandle, "implementation handle");
	requirePipelineStartable(plan, prior, next);
	const now = new Date().toISOString();
	const overlapId = `pipeline-${crypto.randomUUID()}`;
	const priorMetadata = requireFreshPipelineMetadata(prior);
	const nextMetadata = requireFreshPipelineMetadata(next);
	const priorOpenMetadata = {
		...priorMetadata,
		overlap: "open" as const,
		overlapId,
		priorGoalId: prior.id,
		nextGoalId: next.id,
	};
	const nextOpenMetadata = {
		...nextMetadata,
		overlap: "open" as const,
		overlapId,
		priorGoalId: prior.id,
		nextGoalId: next.id,
	};
	prior.pipelineMetadata = { ...priorOpenMetadata, metadataHash: hashPipelineMetadata(priorOpenMetadata) };
	next.pipelineMetadata = { ...nextOpenMetadata, metadataHash: hashPipelineMetadata(nextOpenMetadata) };
	prior.updatedAt = now;
	next.updatedAt = now;
	next.status = "active";
	next.startedAt = next.startedAt ?? now;
	plan.updatedAt = now;
	await writePlan(input.cwd, plan);
	const refs = pipelineEventRefs(prior, next);
	const expectedReviewHandleIds = handleIdsFromValue(reviewHandles, "review");
	const expectedQaHandleIds = handleIdsFromValue(qaHandles, "QA");
	await appendLedger(input.cwd, {
		event: "pipeline_overlap_started",
		eventId: crypto.randomUUID(),
		timestamp: now,
		schemaVersion: 1,
		overlapId,
		priorGoalId: prior.id,
		nextGoalId: next.id,
		reviewHandles,
		reviewHandleIds: expectedReviewHandleIds,
		qaHandles,
		qaHandleIds: expectedQaHandleIds,
		implementationHandle: input.implementationHandle,
		...refs,
	});
	await appendLedger(input.cwd, { event: "goal_started", goalId: next.id, pipelineOverlapId: overlapId });
	return pipelineReceipt(input.cwd, "pipeline_overlap_started", overlapId, prior, next);
}

function resultStatus(value: JsonObject, fieldName: string): string {
	const status = nonEmptyString(value.status) ?? nonEmptyString(value.verdict) ?? nonEmptyString(value.result);
	if (!status) throw new Error(`${fieldName} requires status, verdict, or result`);
	return status.toLowerCase();
}

function requireCleanPipelineResult(result: JsonObject, expectedHandleIds: readonly string[], fieldName: string): void {
	const status = resultStatus(result, fieldName);
	if (!["passed", "pass", "approved", "clear"].includes(status)) throw new Error(`${fieldName} did not pass`);
	const evidence = nonEmptyString(result.evidence);
	if (!evidence || !isSubstantiveEvidence(evidence)) throw new Error(`${fieldName} requires substantive evidence`);
	requireCoveredHandles(expectedHandleIds, resultHandleIds(result, fieldName), fieldName);
	if (collectPipelineBlockerFootprints(result, fieldName).length > 0)
		throw new Error(`${fieldName} cannot clean-join with blockers`);
}

function pipelineStartEventHandleIds(
	ledger: UltragoalLedgerEvent[],
	overlapId: string,
): { review: string[]; qa: string[] } {
	const event = ledger.find(row => row.event === "pipeline_overlap_started" && row.overlapId === overlapId) as
		| JsonObject
		| undefined;
	if (!event) throw new Error(`No pipeline_overlap_started event found for ${overlapId}`);
	const review =
		stringArray(event.reviewHandleIds) ??
		handleIdsFromValue(requireJsonObjectOrArrayValue(event.reviewHandles, "review handles"), "review");
	const qa =
		stringArray(event.qaHandleIds) ??
		handleIdsFromValue(requireJsonObjectOrArrayValue(event.qaHandles, "QA handles"), "QA");
	return { review, qa };
}

export async function joinUltragoalPipelineOverlap(input: {
	cwd: string;
	overlapId: string;
	reviewResult: JsonObject;
	qaResult: JsonObject;
}): Promise<UltragoalPipelineOverlapReceipt> {
	const plan = await readUltragoalPlan(input.cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	const overlap = openPipelineOverlap(plan);
	if (!overlap || overlap.overlapId !== input.overlapId)
		throw new Error(`No open pipeline overlap found for ${input.overlapId}`);
	const { prior, next, overlapId } = overlap;
	const nextMetadata = requireFreshPipelineMetadata(next);
	const ledger = await readUltragoalLedger(input.cwd);
	const expectedHandles = pipelineStartEventHandleIds(ledger, overlapId);
	const reviewBlockers = collectPipelineBlockerFootprints(input.reviewResult, "review result");
	const qaBlockers = collectPipelineBlockerFootprints(input.qaResult, "QA result");
	const blockerFootprints = [...reviewBlockers, ...qaBlockers];
	let state: UltragoalPipelineOverlapState;
	let event: UltragoalPipelineLedgerEventName;
	if (blockerFootprints.length === 0) {
		try {
			requireCleanPipelineResult(input.reviewResult, expectedHandles.review, "review result");
			requireCleanPipelineResult(input.qaResult, expectedHandles.qa, "QA result");
			state = "joined_clean";
			event = "pipeline_overlap_joined";
		} catch {
			state = "quarantine_required";
			event = "pipeline_overlap_quarantined";
		}
	} else if (blockerFootprints.every(footprint => !targetsOverlap(footprint, nextMetadata.targets))) {
		state = "blocked_disjoint_continue";
		event = "pipeline_overlap_joined";
	} else {
		state = "quarantine_required";
		event = "pipeline_overlap_quarantined";
	}
	const now = new Date().toISOString();
	for (const goal of [prior, next]) {
		const metadata = requireFreshPipelineMetadata(goal);
		const joinedMetadata = { ...metadata, overlap: state, blockerFootprints };
		goal.pipelineMetadata = { ...joinedMetadata, metadataHash: hashPipelineMetadata(joinedMetadata) };
		goal.updatedAt = now;
	}
	if (state === "quarantine_required") next.status = "blocked";
	plan.updatedAt = now;
	await writePlan(input.cwd, plan);
	await appendLedger(input.cwd, {
		event,
		eventId: crypto.randomUUID(),
		timestamp: now,
		schemaVersion: 1,
		overlapId,
		priorGoalId: prior.id,
		nextGoalId: next.id,
		status: state,
		reviewResult: input.reviewResult,
		qaResult: input.qaResult,
		blockerFootprints,
		...pipelineEventRefs(prior, next),
	});
	return pipelineReceipt(input.cwd, event, overlapId, prior, next);
}

export async function rebaselineUltragoalPipelineOverlap(input: {
	cwd: string;
	overlapId: string;
	goalId: string;
	evidence: string;
	targetState: JsonObject;
}): Promise<UltragoalPipelineOverlapReceipt> {
	const plan = await readUltragoalPlan(input.cwd);
	if (!plan) throw new Error("No ultragoal plan found. Run `gjc ultragoal create-goals --brief ...` first.");
	const goal = plan.goals.find(item => item.id === input.goalId);
	if (!goal) throw new Error(`No ultragoal goal found for ${input.goalId}.`);
	const evidence = input.evidence.trim();
	if (!isSubstantiveEvidence(evidence)) throw new Error("rebaseline-pipeline-overlap requires substantive evidence");
	const targetState = requireNonEmptyPipelineTargets(input.targetState, "target state");
	const metadata = requireFreshPipelineMetadata(goal);
	if (metadata.overlap !== "quarantine_required" || metadata.overlapId !== input.overlapId) {
		throw new Error(`Goal ${goal.id} is not quarantined for overlap ${input.overlapId}`);
	}
	for (const footprint of metadata.blockerFootprints ?? []) {
		if (targetsOverlap(footprint, targetState))
			throw new Error("rebaseline-pipeline-overlap target state overlaps unresolved blocker footprints");
	}
	const now = new Date().toISOString();
	const rebaselinedMetadata = { ...metadata, overlap: "rebaseline_complete" as const, targets: targetState };
	goal.pipelineMetadata = { ...rebaselinedMetadata, metadataHash: hashPipelineMetadata(rebaselinedMetadata) };
	goal.status = "active";
	goal.evidence = evidence;
	goal.updatedAt = now;
	plan.updatedAt = now;
	await writePlan(input.cwd, plan);
	const peer = pipelinePeer(plan, metadata);
	await appendLedger(input.cwd, {
		event: "pipeline_overlap_rebaselined",
		eventId: crypto.randomUUID(),
		timestamp: now,
		schemaVersion: 1,
		overlapId: input.overlapId,
		priorGoalId: metadata.priorGoalId ?? peer?.id ?? "",
		nextGoalId: metadata.nextGoalId ?? goal.id,
		goalId: goal.id,
		evidence,
		targetState,
		metadataHash: goal.pipelineMetadata.metadataHash,
	});
	const paths = getUltragoalPaths(input.cwd, currentUltragoalSessionId(input.cwd));
	return {
		ok: true,
		event: "pipeline_overlap_rebaselined",
		overlap_id: input.overlapId,
		prior_goal_id: metadata.priorGoalId ?? peer?.id ?? "",
		goal_id: goal.id,
		status: goal.pipelineMetadata.overlap,
		goals_path: paths.goalsPath,
		ledger_path: paths.ledgerPath,
	};
}
