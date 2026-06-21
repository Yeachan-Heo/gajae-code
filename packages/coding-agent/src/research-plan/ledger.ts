export type ResearchPlanConfidence = "low" | "medium" | "high";

export type ResearchEvidenceVerdict = "support" | "contradict" | "uncertain";

export interface ResearchPlanItem {
	claim: string;
	confidence: ResearchPlanConfidence;
	unknowns: string[];
	evidenceNeeded: string[];
	counterexampleQueries: string[];
	sourceConflictPolicy: string;
	dropCondition: string;
	verifierChecks: string[];
}

export interface ResearchEvidenceEntry {
	claim: string;
	source: string;
	confidence: ResearchPlanConfidence;
	verdict: ResearchEvidenceVerdict;
	notes?: string;
}

export interface ResearchLedgerVerdict {
	claim: string;
	finalVerdict: "accepted" | "rejected" | "uncertain";
	survivingSources: ResearchEvidenceEntry[];
	rejectReason?: string;
	unresolvedUnknowns: string[];
}

export interface ResearchPlanValidationResult {
	valid: boolean;
	errors: string[];
}

const CONFIDENCE_VALUES = new Set<ResearchPlanConfidence>(["low", "medium", "high"]);
const EVIDENCE_VERDICTS = new Set<ResearchEvidenceVerdict>(["support", "contradict", "uncertain"]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateStringArray(value: unknown, field: string, minLength = 1): string[] {
	if (!Array.isArray(value)) return [`${field} must be an array`];
	if (value.length < minLength) return [`${field} must contain at least ${minLength} item(s)`];
	return value.flatMap((item, index) =>
		isNonEmptyString(item) ? [] : [`${field}[${index}] must be a non-empty string`],
	);
}

export function validateResearchPlanItem(item: Partial<ResearchPlanItem>): ResearchPlanValidationResult {
	const errors: string[] = [];
	if (!isNonEmptyString(item.claim)) errors.push("claim must be a non-empty string");
	if (!item.confidence || !CONFIDENCE_VALUES.has(item.confidence)) {
		errors.push("confidence must be one of: low, medium, high");
	}
	errors.push(...validateStringArray(item.unknowns, "unknowns", 0));
	errors.push(...validateStringArray(item.evidenceNeeded, "evidenceNeeded"));
	errors.push(...validateStringArray(item.counterexampleQueries, "counterexampleQueries"));
	if (!isNonEmptyString(item.sourceConflictPolicy)) errors.push("sourceConflictPolicy must be a non-empty string");
	if (!isNonEmptyString(item.dropCondition)) errors.push("dropCondition must be a non-empty string");
	errors.push(...validateStringArray(item.verifierChecks, "verifierChecks"));
	return { valid: errors.length === 0, errors };
}

export function validateResearchEvidenceEntry(entry: Partial<ResearchEvidenceEntry>): ResearchPlanValidationResult {
	const errors: string[] = [];
	if (!isNonEmptyString(entry.claim)) errors.push("claim must be a non-empty string");
	if (!isNonEmptyString(entry.source)) errors.push("source must be a non-empty string");
	if (!entry.confidence || !CONFIDENCE_VALUES.has(entry.confidence)) {
		errors.push("confidence must be one of: low, medium, high");
	}
	if (!entry.verdict || !EVIDENCE_VERDICTS.has(entry.verdict)) {
		errors.push("verdict must be one of: support, contradict, uncertain");
	}
	return { valid: errors.length === 0, errors };
}

function lower(value: string): string {
	return value.toLowerCase();
}

function matchesDropCondition(item: ResearchPlanItem, evidence: ResearchEvidenceEntry[]): string | undefined {
	const condition = lower(item.dropCondition);
	const contradiction = evidence.find(entry => entry.verdict === "contradict");
	if (contradiction && /(counterexample|contradict|conflict|falsif)/.test(condition)) {
		return `dropCondition matched by contradictory source: ${contradiction.source}`;
	}
	const unresolved = evidence.find(entry => entry.verdict === "uncertain");
	if (unresolved && /(unknown|unresolved|uncertain)/.test(condition)) {
		return `dropCondition matched by unresolved evidence: ${unresolved.source}`;
	}
	return undefined;
}

function sourceConflictReason(item: ResearchPlanItem, evidence: ResearchEvidenceEntry[]): string | undefined {
	const supporting = evidence.filter(entry => entry.verdict === "support");
	const contradicting = evidence.filter(entry => entry.verdict === "contradict");
	if (supporting.length === 0 || contradicting.length === 0) return undefined;
	const policy = lower(item.sourceConflictPolicy);
	if (/(reject|drop|do not accept|prefer contradiction|requires resolution)/.test(policy)) {
		return `sourceConflictPolicy rejected mixed support/contradiction (${supporting.length} support, ${contradicting.length} contradict)`;
	}
	return "source conflict remains unresolved";
}

export function evaluateResearchLedger(
	item: ResearchPlanItem,
	evidence: readonly ResearchEvidenceEntry[],
): ResearchLedgerVerdict {
	const relevantEvidence = evidence.filter(entry => entry.claim === item.claim);
	const invalidItem = validateResearchPlanItem(item);
	if (!invalidItem.valid) {
		return {
			claim: item.claim,
			finalVerdict: "rejected",
			survivingSources: [],
			rejectReason: `invalid research plan item: ${invalidItem.errors.join("; ")}`,
			unresolvedUnknowns: item.unknowns,
		};
	}
	const invalidEvidence = relevantEvidence.flatMap(entry => validateResearchEvidenceEntry(entry).errors);
	if (invalidEvidence.length > 0) {
		return {
			claim: item.claim,
			finalVerdict: "rejected",
			survivingSources: [],
			rejectReason: `invalid evidence entry: ${invalidEvidence.join("; ")}`,
			unresolvedUnknowns: item.unknowns,
		};
	}
	if (relevantEvidence.length === 0) {
		return {
			claim: item.claim,
			finalVerdict: "uncertain",
			survivingSources: [],
			rejectReason: "no evidence collected for claim",
			unresolvedUnknowns: item.unknowns,
		};
	}
	const supporting = relevantEvidence.filter(entry => entry.verdict === "support");
	const firstContradiction = relevantEvidence.find(entry => entry.verdict === "contradict");
	let dropReason = matchesDropCondition(item, relevantEvidence) ?? sourceConflictReason(item, relevantEvidence);
	// A counterexample with no surviving support falsifies the claim regardless of how the
	// dropCondition / sourceConflictPolicy prose is worded. Without this, a purely contradicted
	// claim would slip through as "uncertain" and reopen the hallucination survival path the
	// evidence ledger exists to close (a contested claim already rejects via sourceConflictReason).
	if (!dropReason && firstContradiction && supporting.length === 0) {
		dropReason = `claim contradicted by counterexample with no supporting evidence: ${firstContradiction.source}`;
	}
	if (dropReason) {
		return {
			claim: item.claim,
			finalVerdict: "rejected",
			survivingSources: supporting,
			rejectReason: dropReason,
			unresolvedUnknowns: item.unknowns,
		};
	}
	const uncertain = relevantEvidence.some(entry => entry.verdict === "uncertain");
	if (uncertain || supporting.length === 0) {
		return {
			claim: item.claim,
			finalVerdict: "uncertain",
			survivingSources: supporting,
			rejectReason: uncertain ? "unresolved uncertainty remains" : "no supporting evidence survived verification",
			unresolvedUnknowns: item.unknowns,
		};
	}
	return {
		claim: item.claim,
		finalVerdict: "accepted",
		survivingSources: supporting,
		unresolvedUnknowns: [],
	};
}
