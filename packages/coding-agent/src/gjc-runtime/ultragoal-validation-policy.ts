/**
 * Deterministic Ultragoal validation applicability policy (#4560).
 *
 * The boundary cohort (`cleaner || architect || QA`) and the terminal critic
 * are expensive LLM lanes. They were introduced as unconditional per-boundary
 * ceremony, which inflates token cost and failure surface on low-risk work and
 * makes compaction more likely during long runs (#3473/#3474 moved review from
 * per-subgoal to per-boundary; this policy makes the boundary lanes
 * risk-proportional without removing them for risky work).
 *
 * Selection is runtime-authoritative and deterministic from durable facts
 * (change set, plan shape, ledger receipts) — never free-form model prose.
 * It fails closed: any condition that cannot be proven cheap is treated as
 * high-risk and keeps the full heavyweight cohort. The precedent is
 * `requiresComputerRedTeamSuite`, whose applicability the runtime derives from
 * the computed change set and refuses to let the model self-exempt.
 */
import {
	categorizeComputerChangePath,
	normalizeRepoPath,
	type UltragoalChangeSet,
	type UltragoalChangeSetPath,
} from "./ultragoal-change-set";

export type UltragoalValidationLane = "cleaner" | "architect" | "qa" | "terminal-critic";

export interface UltragoalValidationApplicabilityInput {
	/** Trusted computed change set for the boundary (checkpoint path). */
	changeSet?: UltragoalChangeSet;
	/**
	 * Durable aggregate shape: the number of goals the plan actually requires.
	 * This is a property of the plan, not of how far it has progressed, so the
	 * multi-goal risk signal cannot evaporate at the final goal of a multi-goal
	 * run — which is precisely the aggregate boundary where risk is highest.
	 */
	requiredGoals?: number;
	/** Open review blockers exist (review_blocked goals). */
	hasOpenReviewBlockers?: boolean;
	/** Newest joined cohort sourceHash recorded in the ledger. */
	latestCohortSourceHash?: string;
	/** Current frozen source hash the boundary would review. */
	currentSourceHash?: string;
	/** Runtime-computed digest of the authoritative current source basis. */
	authoritativeSourceHash?: string;
}

export interface UltragoalValidationApplicability {
	/** Lane -> applicability decision with the durable facts that forced it. */
	lanes: Record<UltragoalValidationLane, { applicable: boolean; reasons: string[] }>;
	/** True only when every heavyweight lane is applicable (full cohort). */
	heavyweight: boolean;
	/** Risk classification driving the selection. */
	riskClass: "low" | "high";
	/** True when open review blockers make terminal evidence uncertain. */
	hasOpenReviewBlockers: boolean;
	/** True when an unchanged immutable source basis permits evidence reuse. */
	basisUnchanged: boolean;
	/** Human- and machine-inspectable selection basis, recorded in diagnostics. */
	selection: string[];
}

export interface UltragoalValidationLaneSelection {
	riskClass: "low" | "high";
	reasons: string[];
	omittedLanes: UltragoalValidationLane[];
}

/**
 * Substring markers for security-sensitive surfaces. A hand-maintained prefix
 * list cannot be fail-closed: any new credential/auth file added anywhere in
 * the workspace would silently grade as low-risk until someone remembered to
 * extend the list. These markers classify by what a path *is* rather than
 * where it happens to live.
 */
const SECURITY_SENSITIVE_PATH_MARKERS = [
	"auth-storage",
	"auth-broker",
	"auth-config",
	"oauth",
	"credential",
	"secure-token",
	"api-key",
	"apikey",
	"secret",
	"token-store",
	"keychain",
	"permission",
] as const;

const GENERIC_SECURITY_PATH_PATTERN =
	/(^|\/)(auth|authentication|authorization|security|permission|permissions)(?:[._-]|\/|$)/i;

const HIGH_RISK_PATH_PREFIXES = [
	// Security/auth surfaces
	"packages/coding-agent/src/session/auth-storage.ts",
	"packages/coding-agent/src/session/secure-token-file.ts",
	"packages/coding-agent/src/session/startup-auth-config.ts",
	"packages/coding-agent/src/runtime-api-key.ts",
	"packages/coding-agent/src/runtime-credential-selector.ts",
	"packages/coding-agent/src/secrets",
	"packages/ai/src/auth-storage.ts",
	"packages/natives",
	"packages/coding-agent/src/runtime-mcp/oauth-flow.ts",
	"packages/coding-agent/src/commands/auth-broker.ts",
	"crates/pi-natives/src",
	"crates/git-daemon",
	// Workflow enforcement surfaces must never grade their own weakening as low-risk.
	"packages/coding-agent/src/gjc-runtime",
	"packages/coding-agent/src/session/agent-session.ts",
	// Public contract / SDK surfaces
	"packages/coding-agent/src/sdk",
	"packages/coding-agent/src/extensibility",
	"packages/coding-agent/src/modes/shared/agent-wire",
	// Shared behavior registries (mirrors the computer-suite conservative rule)
	"packages/coding-agent/src/tools/index.ts",
	"packages/coding-agent/src/tools/renderers.ts",
	"packages/coding-agent/src/config/settings-schema.ts",
] as const;

const MIGRATION_PATH_PREFIXES = [
	"packages/coding-agent/src/gjc-runtime/state-migrations.ts",
	"packages/coding-agent/src/session/session-manager.ts",
	"packages/coding-agent/src/session/session-manager-internal.ts",
	"scripts",
] as const;

function changePaths(changeSet: UltragoalChangeSet | undefined): UltragoalChangeSetPath[] {
	return changeSet?.trusted ? changeSet.paths : [];
}

export function isHighRiskChangePath(row: UltragoalChangeSetPath): boolean {
	const candidates = [row.path, row.oldPath]
		.filter((value): value is string => typeof value === "string")
		.map(normalizeRepoPath);
	for (const candidate of candidates) {
		if (GENERIC_SECURITY_PATH_PATTERN.test(candidate)) return true;
		if (/^packages\/natives(?:-|\/|$)/.test(candidate)) return true;
		for (const prefix of HIGH_RISK_PATH_PREFIXES) {
			if (candidate === prefix || candidate.startsWith(`${prefix}/`)) return true;
		}
		const fileName = candidate.slice(candidate.lastIndexOf("/") + 1).toLowerCase();
		if (row.category === "generated-binding") return true;
		if (/(auth|oauth|security|credential|token|secret|permission)/i.test(fileName)) return true;
		for (const marker of SECURITY_SENSITIVE_PATH_MARKERS) {
			if (fileName.includes(marker)) return true;
		}
	}
	return false;
}

export function validationLaneSelectionFor(
	applicability: UltragoalValidationApplicability,
): UltragoalValidationLaneSelection {
	return {
		riskClass: applicability.riskClass,
		reasons: [...applicability.selection],
		omittedLanes: (Object.keys(applicability.lanes) as UltragoalValidationLane[])
			.filter(lane => !applicability.lanes[lane].applicable)
			.sort(),
	};
}

export function isMigrationChangePath(row: UltragoalChangeSetPath): boolean {
	const candidates = [row.path, row.oldPath]
		.filter((value): value is string => typeof value === "string")
		.map(normalizeRepoPath);
	for (const candidate of candidates) {
		for (const prefix of MIGRATION_PATH_PREFIXES) {
			if (candidate === prefix || candidate.startsWith(`${prefix}/`)) return true;
		}
	}
	return false;
}

function isComputerControlSurfaceChangePath(row: UltragoalChangeSetPath): boolean {
	const candidates = [row.path, row.oldPath].filter((value): value is string => typeof value === "string");
	return candidates.some(candidate => {
		const category = categorizeComputerChangePath(candidate);
		return category === "code" || category === "tool" || category === "settings-registry";
	});
}

/**
 * Compute the deterministic validation applicability for a boundary.
 *
 * Low-risk eligibility (the only case where redundant lanes may be omitted):
 * trusted change set, single outstanding goal, no open review blockers, no
 * high-risk/migration/computer/public-contract path, complete capture.
 * Everything else — including a missing/untrusted change set — keeps the full
 * heavyweight cohort exactly as today.
 */
export function resolveUltragoalValidationApplicability(
	input: UltragoalValidationApplicabilityInput,
): UltragoalValidationApplicability {
	const selection: string[] = [];
	const paths = changePaths(input.changeSet);
	const highRiskPaths = paths.filter(isHighRiskChangePath);
	const migrationPaths = paths.filter(isMigrationChangePath);
	const computerPaths = paths.filter(isComputerControlSurfaceChangePath);
	// Derived from the durable aggregate shape, never from remaining progress:
	// a two-goal plan stays multi-goal on its final goal.
	const multiGoal = (input.requiredGoals ?? 0) > 1;
	const reasons: string[] = [];
	if (!input.changeSet?.trusted) reasons.push("change-set-untrusted-or-missing");
	if (input.changeSet?.captureIncomplete) reasons.push("capture-incomplete");
	if (!input.authoritativeSourceHash) reasons.push("source-basis-unverified");
	if (multiGoal) reasons.push("multiple-outstanding-goals");
	if (input.hasOpenReviewBlockers) reasons.push("open-review-blockers");
	if (highRiskPaths.length > 0) reasons.push("high-risk-paths");
	if (migrationPaths.length > 0) reasons.push("migration-paths");
	if (computerPaths.length > 0) reasons.push("computer-control-surface");
	// Low-risk omission requires proof that the plan is genuinely single-goal.
	if (input.requiredGoals === undefined) reasons.push("progress-unknown");
	const highRisk = reasons.length > 0;
	const heavyweight = highRisk;
	const lane = (applicable: boolean, why: string[]): { applicable: boolean; reasons: string[] } => ({
		applicable,
		reasons: why,
	});
	// Unchanged-basis reuse: only when a prior joined cohort verified the exact
	// frozen source hash this boundary would review, and no blockers reopened.
	const basisUnchanged =
		Boolean(input.latestCohortSourceHash) &&
		Boolean(input.authoritativeSourceHash) &&
		input.currentSourceHash === input.latestCohortSourceHash &&
		input.currentSourceHash === input.authoritativeSourceHash &&
		!input.hasOpenReviewBlockers;
	const lanes: UltragoalValidationApplicability["lanes"] = {
		cleaner: lane(heavyweight, heavyweight ? reasons : ["low-risk-single-goal"]),
		architect: lane(heavyweight, heavyweight ? reasons : ["low-risk-single-goal"]),
		// QA/targeted verification always applies at a boundary; risk selection
		// never removes verification, only redundant review ceremony.
		qa: lane(true, ["mandatory-verification"]),
		"terminal-critic": lane(heavyweight, heavyweight ? reasons : ["low-risk-single-goal"]),
	};
	selection.push(`riskClass=${highRisk ? "high" : "low"}`);
	selection.push(`basisUnchanged=${basisUnchanged}`);
	if (reasons.length > 0) selection.push(`heavyweightReasons=${reasons.join(",")}`);
	return {
		lanes,
		heavyweight,
		riskClass: highRisk ? "high" : "low",
		hasOpenReviewBlockers: Boolean(input.hasOpenReviewBlockers),
		basisUnchanged,
		selection,
	};
}
