/**
 * Typed ralplan review conflicts and dispositions (#2902).
 *
 * Architect and Critic findings remain free-form in their stage markdown, but
 * the join/revision path can record machine-checkable findings against stable
 * plan targets. Incompatible actions on the same target produce open conflicts
 * that block a clean join until an explicit disposition is recorded.
 */

export const RALPLAN_REVIEW_CONFLICTS_SCHEMA = "ralplan.review_conflicts.v1" as const;

export type ReviewAction = "add" | "remove" | "change" | "clarify";
export type ReviewRole = "architect" | "critic";
export type ReviewSeverity = "info" | "watch" | "block";
export type DispositionChoice = "accept_architect" | "accept_critic" | "synthesize" | "defer_user" | "reject_both";

export interface ReviewSourceReceipt {
	stage: "architect" | "critic";
	stageN: number;
	path: string;
	sha256: string;
}

export interface ReviewFinding {
	findingId: string;
	targetId: string;
	action: ReviewAction;
	severity: ReviewSeverity;
	evidence: string;
	sourceRole: ReviewRole;
	sourceReceipt: ReviewSourceReceipt;
	proposedOwner?: string;
}

export interface ReviewConflict {
	conflictId: string;
	targetId: string;
	findingIds: [string, string];
	actions: [ReviewAction, ReviewAction];
	sourceRoles: [ReviewRole, ReviewRole];
	status: "open" | "dispositioned";
}

export interface ConflictDisposition {
	conflictId: string;
	choice: DispositionChoice;
	rationale: string;
	decisionOwner: string;
	affectedSections: string[];
	dispositionedAt?: string;
}

export interface ReviewConflictDocument {
	schema: typeof RALPLAN_REVIEW_CONFLICTS_SCHEMA;
	plannerStageN: number;
	findings: ReviewFinding[];
	conflicts: ReviewConflict[];
	dispositions: ConflictDisposition[];
}

export interface JoinGateResult {
	ok: boolean;
	openConflictIds: string[];
	missingDispositionIds: string[];
	orphanDispositionIds: string[];
	message: string;
}

const ACTIONS = new Set<ReviewAction>(["add", "remove", "change", "clarify"]);
const ROLES = new Set<ReviewRole>(["architect", "critic"]);
const SEVERITIES = new Set<ReviewSeverity>(["info", "watch", "block"]);
const DISPOSITIONS = new Set<DispositionChoice>([
	"accept_architect",
	"accept_critic",
	"synthesize",
	"defer_user",
	"reject_both",
]);

/** Pairs of actions that cannot both stand for the same plan target. */
const INCOMPATIBLE_ACTION_PAIRS = new Set<string>([
	pairKey("add", "remove"),
	pairKey("remove", "add"),
	pairKey("remove", "change"),
	pairKey("change", "remove"),
]);

function pairKey(left: ReviewAction, right: ReviewAction): string {
	return `${left}\u0000${right}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value.trim();
}

function positiveInt(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${field} must be an integer >= 1`);
	}
	return value;
}

function parseAction(value: unknown, field: string): ReviewAction {
	const action = nonEmptyString(value, field);
	if (!ACTIONS.has(action as ReviewAction)) {
		throw new Error(`${field} must be one of: ${[...ACTIONS].join(", ")}`);
	}
	return action as ReviewAction;
}

function parseRole(value: unknown, field: string): ReviewRole {
	const role = nonEmptyString(value, field);
	if (!ROLES.has(role as ReviewRole)) {
		throw new Error(`${field} must be one of: ${[...ROLES].join(", ")}`);
	}
	return role as ReviewRole;
}

function parseSeverity(value: unknown, field: string): ReviewSeverity {
	const severity = nonEmptyString(value, field);
	if (!SEVERITIES.has(severity as ReviewSeverity)) {
		throw new Error(`${field} must be one of: ${[...SEVERITIES].join(", ")}`);
	}
	return severity as ReviewSeverity;
}

function parseDispositionChoice(value: unknown, field: string): DispositionChoice {
	const choice = nonEmptyString(value, field);
	if (!DISPOSITIONS.has(choice as DispositionChoice)) {
		throw new Error(`${field} must be one of: ${[...DISPOSITIONS].join(", ")}`);
	}
	return choice as DispositionChoice;
}

function parseSourceReceipt(value: unknown, field: string): ReviewSourceReceipt {
	if (!isObject(value)) throw new Error(`${field} must be an object`);
	const stage = nonEmptyString(value.stage, `${field}.stage`);
	if (stage !== "architect" && stage !== "critic") {
		throw new Error(`${field}.stage must be architect or critic`);
	}
	return {
		stage,
		stageN: positiveInt(value.stageN ?? value.stage_n, `${field}.stageN`),
		path: nonEmptyString(value.path, `${field}.path`),
		sha256: nonEmptyString(value.sha256, `${field}.sha256`),
	};
}

function parseFinding(value: unknown, index: number): ReviewFinding {
	if (!isObject(value)) throw new Error(`findings[${index}] must be an object`);
	const finding: ReviewFinding = {
		findingId: nonEmptyString(value.findingId ?? value.finding_id, `findings[${index}].findingId`),
		targetId: nonEmptyString(value.targetId ?? value.target_id, `findings[${index}].targetId`),
		action: parseAction(value.action, `findings[${index}].action`),
		severity: parseSeverity(value.severity, `findings[${index}].severity`),
		evidence: nonEmptyString(value.evidence, `findings[${index}].evidence`),
		sourceRole: parseRole(value.sourceRole ?? value.source_role, `findings[${index}].sourceRole`),
		sourceReceipt: parseSourceReceipt(
			value.sourceReceipt ?? value.source_receipt,
			`findings[${index}].sourceReceipt`,
		),
	};
	const proposedOwner = value.proposedOwner ?? value.proposed_owner;
	if (proposedOwner !== undefined) {
		finding.proposedOwner = nonEmptyString(proposedOwner, `findings[${index}].proposedOwner`);
	}
	return finding;
}

function parseDisposition(value: unknown, index: number): ConflictDisposition {
	if (!isObject(value)) throw new Error(`dispositions[${index}] must be an object`);
	const affectedRaw = value.affectedSections ?? value.affected_sections;
	if (!Array.isArray(affectedRaw) || affectedRaw.length === 0) {
		throw new Error(`dispositions[${index}].affectedSections must be a non-empty string array`);
	}
	const affectedSections = affectedRaw.map((entry, i) =>
		nonEmptyString(entry, `dispositions[${index}].affectedSections[${i}]`),
	);
	const disposition: ConflictDisposition = {
		conflictId: nonEmptyString(value.conflictId ?? value.conflict_id, `dispositions[${index}].conflictId`),
		choice: parseDispositionChoice(value.choice, `dispositions[${index}].choice`),
		rationale: nonEmptyString(value.rationale, `dispositions[${index}].rationale`),
		decisionOwner: nonEmptyString(
			value.decisionOwner ?? value.decision_owner,
			`dispositions[${index}].decisionOwner`,
		),
		affectedSections,
	};
	const at = value.dispositionedAt ?? value.dispositioned_at;
	if (at !== undefined) {
		disposition.dispositionedAt = nonEmptyString(at, `dispositions[${index}].dispositionedAt`);
	}
	return disposition;
}

/** True when two actions on the same target cannot both remain. */
export function actionsAreIncompatible(left: ReviewAction, right: ReviewAction): boolean {
	if (left === right) return false;
	return INCOMPATIBLE_ACTION_PAIRS.has(pairKey(left, right));
}

/**
 * Derive open conflicts from typed findings. Only cross-role incompatible pairs
 * on the same targetId are conflicts (Architect remove vs Critic add, etc.).
 */
export function detectReviewConflicts(findings: readonly ReviewFinding[]): ReviewConflict[] {
	const byTarget = new Map<string, ReviewFinding[]>();
	for (const finding of findings) {
		const list = byTarget.get(finding.targetId) ?? [];
		list.push(finding);
		byTarget.set(finding.targetId, list);
	}

	const conflicts: ReviewConflict[] = [];
	for (const [targetId, group] of byTarget) {
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const a = group[i]!;
				const b = group[j]!;
				if (a.sourceRole === b.sourceRole) continue;
				if (!actionsAreIncompatible(a.action, b.action)) continue;
				const [left, right] = a.findingId <= b.findingId ? [a, b] : [b, a];
				conflicts.push({
					conflictId: `conflict:${targetId}:${left.findingId}:${right.findingId}`,
					targetId,
					findingIds: [left.findingId, right.findingId],
					actions: [left.action, right.action],
					sourceRoles: [left.sourceRole, right.sourceRole],
					status: "open",
				});
			}
		}
	}
	return conflicts.sort((x, y) => x.conflictId.localeCompare(y.conflictId));
}

/** Mark conflicts dispositioned when a matching disposition exists. */
export function applyDispositions(
	conflicts: readonly ReviewConflict[],
	dispositions: readonly ConflictDisposition[],
): ReviewConflict[] {
	const disposed = new Set(dispositions.map(d => d.conflictId));
	return conflicts.map(conflict =>
		disposed.has(conflict.conflictId) ? { ...conflict, status: "dispositioned" } : { ...conflict, status: "open" },
	);
}

/**
 * Join gate: clean only when every derived conflict has an explicit disposition
 * with rationale and decision owner, and no orphan dispositions reference unknown
 * conflicts.
 */
export function evaluateReviewJoinGate(
	findings: readonly ReviewFinding[],
	dispositions: readonly ConflictDisposition[],
	precomputedConflicts?: readonly ReviewConflict[],
): JoinGateResult {
	const derived = precomputedConflicts ? precomputedConflicts.map(c => ({ ...c })) : detectReviewConflicts(findings);
	const withStatus = applyDispositions(derived, dispositions);
	const knownIds = new Set(withStatus.map(c => c.conflictId));
	const openConflictIds = withStatus.filter(c => c.status === "open").map(c => c.conflictId);
	const disposedIds = new Set(dispositions.map(d => d.conflictId));
	const missingDispositionIds = openConflictIds.filter(id => !disposedIds.has(id));
	const orphanDispositionIds = dispositions.map(d => d.conflictId).filter(id => !knownIds.has(id));

	const ok = missingDispositionIds.length === 0 && orphanDispositionIds.length === 0;
	let message: string;
	if (ok && withStatus.length === 0) {
		message = "No typed review conflicts; join is clean.";
	} else if (ok) {
		message = `All ${withStatus.length} typed review conflict(s) are dispositioned.`;
	} else if (missingDispositionIds.length > 0) {
		message = `Join blocked: ${missingDispositionIds.length} open conflict(s) lack disposition: ${missingDispositionIds.join(", ")}.`;
	} else {
		message = `Join blocked: disposition(s) reference unknown conflict id(s): ${orphanDispositionIds.join(", ")}.`;
	}

	return { ok, openConflictIds, missingDispositionIds, orphanDispositionIds, message };
}

/** Strip optional markdown fence and parse JSON. */
export function parseReviewConflictJson(raw: string): unknown {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u);
	const body = fenced ? fenced[1]!.trim() : trimmed;
	try {
		return JSON.parse(body);
	} catch (error) {
		throw new Error(`disposition artifact must be JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Authoritative provenance required by `gjc ralplan --write --stage disposition`.
 *
 * Without this, a disposition document can claim arbitrary path/hash strings and
 * join the wrong Architect/Critic pass (#3013 adversarial review).
 */
export interface IndexedReviewArtifact {
	path: string;
	sha256: string;
}

export interface DispositionProvenanceContext {
	/** CLI `--stage_n` for this disposition write; must equal `plannerStageN`. */
	expectedStageN: number;
	/**
	 * Persisted Architect/Critic (and other) stage artifacts from this run's
	 * `index.jsonl`, keyed by `${stage}\u0000${stageN}`.
	 */
	indexedArtifacts: ReadonlyMap<string, IndexedReviewArtifact>;
}

/** Stable map key for a staged artifact identity in the run index. */
export function reviewArtifactIndexKey(stage: string, stageN: number): string {
	return `${stage}\u0000${stageN}`;
}

/**
 * Cross-check every finding's source receipt against the CLI stage number and
 * the run's persisted Architect/Critic artifact index. Fail closed on mismatch
 * or spoofed path/hash attestations.
 */
export function assertDispositionProvenance(
	doc: ReviewConflictDocument,
	provenance: DispositionProvenanceContext,
): void {
	if (doc.plannerStageN !== provenance.expectedStageN) {
		throw new Error(
			`disposition provenance: plannerStageN=${doc.plannerStageN} does not match CLI --stage_n=${provenance.expectedStageN}`,
		);
	}

	for (let i = 0; i < doc.findings.length; i++) {
		const finding = doc.findings[i]!;
		const field = `findings[${i}]`;
		const receipt = finding.sourceReceipt;

		if (receipt.stage !== finding.sourceRole) {
			throw new Error(`${field}.sourceReceipt.stage=${receipt.stage} must equal sourceRole=${finding.sourceRole}`);
		}
		if (receipt.stageN !== doc.plannerStageN) {
			throw new Error(
				`${field}.sourceReceipt.stageN=${receipt.stageN} must equal plannerStageN=${doc.plannerStageN} (same-pass join)`,
			);
		}

		const indexed = provenance.indexedArtifacts.get(reviewArtifactIndexKey(receipt.stage, receipt.stageN));
		if (!indexed) {
			throw new Error(
				`${field}.sourceReceipt: no persisted ${receipt.stage} stage ${receipt.stageN} artifact in run index`,
			);
		}
		if (indexed.path !== receipt.path) {
			throw new Error(
				`${field}.sourceReceipt.path does not match indexed ${receipt.stage} stage ${receipt.stageN} path`,
			);
		}
		if (indexed.sha256 !== receipt.sha256) {
			throw new Error(
				`${field}.sourceReceipt.sha256 does not match indexed ${receipt.stage} stage ${receipt.stageN} sha256`,
			);
		}
	}
}

/**
 * Parse and validate a disposition-stage document. Re-derives conflicts from
 * findings when omitted, then fails closed unless every conflict is dispositioned
 * (or findings produce zero conflicts and dispositions are empty).
 *
 * When `provenance` is provided (CLI write path), also enforces authoritative
 * same-pass receipt checks against the run index.
 */
export function parseReviewConflictDocument(
	raw: string | unknown,
	provenance?: DispositionProvenanceContext,
): ReviewConflictDocument {
	const value = typeof raw === "string" ? parseReviewConflictJson(raw) : raw;
	if (!isObject(value)) throw new Error("disposition document must be a JSON object");

	const schema = nonEmptyString(value.schema, "schema");
	if (schema !== RALPLAN_REVIEW_CONFLICTS_SCHEMA) {
		throw new Error(`schema must be ${RALPLAN_REVIEW_CONFLICTS_SCHEMA}`);
	}

	const plannerStageN = positiveInt(value.plannerStageN ?? value.planner_stage_n, "plannerStageN");
	if (!Array.isArray(value.findings)) throw new Error("findings must be an array");
	const findings = value.findings.map((entry, i) => parseFinding(entry, i));
	const findingIds = new Set(findings.map(f => f.findingId));
	if (findingIds.size !== findings.length) throw new Error("findingId values must be unique");

	// Structural role/stage alignment is always required (even without index).
	for (let i = 0; i < findings.length; i++) {
		const f = findings[i]!;
		if (f.sourceReceipt.stage !== f.sourceRole) {
			throw new Error(
				`findings[${i}].sourceReceipt.stage=${f.sourceReceipt.stage} must equal sourceRole=${f.sourceRole}`,
			);
		}
		if (f.sourceReceipt.stageN !== plannerStageN) {
			throw new Error(
				`findings[${i}].sourceReceipt.stageN=${f.sourceReceipt.stageN} must equal plannerStageN=${plannerStageN}`,
			);
		}
	}

	const dispositions = Array.isArray(value.dispositions)
		? value.dispositions.map((entry, i) => parseDisposition(entry, i))
		: [];
	const dispositionConflictIds = new Set(dispositions.map(d => d.conflictId));
	if (dispositionConflictIds.size !== dispositions.length) {
		throw new Error("disposition conflictId values must be unique");
	}

	const derived = detectReviewConflicts(findings);
	const provided = Array.isArray(value.conflicts) ? value.conflicts : undefined;
	let conflicts: ReviewConflict[];
	if (provided === undefined) {
		conflicts = applyDispositions(derived, dispositions);
	} else {
		// Accept provided conflict ids only when they match derived pairs.
		const derivedById = new Map(derived.map(c => [c.conflictId, c]));
		conflicts = provided.map((entry, i) => {
			if (!isObject(entry)) throw new Error(`conflicts[${i}] must be an object`);
			const conflictId = nonEmptyString(entry.conflictId ?? entry.conflict_id, `conflicts[${i}].conflictId`);
			const derivedConflict = derivedById.get(conflictId);
			if (!derivedConflict) {
				throw new Error(`conflicts[${i}] ${conflictId} is not derived from findings`);
			}
			return derivedConflict;
		});
		// Include any derived conflicts omitted from the payload so join cannot skip them.
		for (const derivedConflict of derived) {
			if (!conflicts.some(c => c.conflictId === derivedConflict.conflictId)) {
				conflicts.push(derivedConflict);
			}
		}
		conflicts = applyDispositions(conflicts, dispositions);
	}

	const gate = evaluateReviewJoinGate(findings, dispositions, conflicts);
	if (!gate.ok) {
		throw new Error(gate.message);
	}

	const doc: ReviewConflictDocument = {
		schema: RALPLAN_REVIEW_CONFLICTS_SCHEMA,
		plannerStageN,
		findings,
		conflicts,
		dispositions,
	};

	if (provenance) {
		assertDispositionProvenance(doc, provenance);
	}

	return doc;
}

/** Canonical JSON serialization for disposition-stage artifacts. */
export function serializeReviewConflictDocument(doc: ReviewConflictDocument): string {
	return `${JSON.stringify(doc, null, 2)}\n`;
}
