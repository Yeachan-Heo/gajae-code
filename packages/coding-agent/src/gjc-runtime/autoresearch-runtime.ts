/**
 * Native implementation of `gjc autoresearch` — the session-scoped mission
 * runtime for the autoresearch workflow skill.
 *
 * Everything the runtime persists lives under
 * `<cwd>/.gjc/_session-{gjcSessionId}/autoresearch/` (`sessionAutoresearchDir`):
 * the mission artifact (`mission.json`) and the append-only ledger
 * (`ledger.jsonl`). The legacy global autoresearch store is intentionally
 * dead: no code path in this module writes there, and every mutation routes
 * through the sanctioned `.gjc/**` state-writer primitives, which structurally
 * refuse targets outside the project `.gjc/` tree.
 *
 * Intake contract (AC-14..AC-16): two entrypoints write the one mission
 * artifact. Handoff intake (`--spec <path>`) consumes a persisted deep-interview
 * spec and asks zero clarification questions; cold intake (positional goal or
 * bare invocation) signals that goal/constraints/deliverables clarification must
 * run before research begins and writes nothing. The mission mode is one of
 * `web` / `mixed` / `data` and is always supplied explicitly — the write
 * boundary REJECTS a missing or invalid mode and never infers one from the
 * presence of a data file.
 *
 * The ledger is append-only and carries the six event kinds: `mission_created`,
 * `mode_set`, `run_logged`, `verdict_issued`, `critic_recorded`,
 * `kernel_cleared`. A mission completes only on a structured best-effort
 * verdict (status, evidence, caveats, evaluator); an optional critic pass
 * records a `critic_receipt` whose evaluator identity is distinct from the
 * mission agent.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AutoresearchDashboardInput, renderExpandedDashboard } from "../autoresearch/dashboard";
import { loadAutoresearchDataContext, type RlmDataContext } from "../autoresearch/data-context";
import { type EnsureAutoresearchBranchResult, ensureAutoresearchBranch } from "../autoresearch/git";
import { type ParsedHarnessOutput, parseHarnessOutput } from "../autoresearch/harness";
import { renderAutoresearchIteratePrompt, renderAutoresearchSetupPrompt } from "../autoresearch/prompts";
import { autoresearchKernelOwnerId } from "../autoresearch/python-tool";
import { extractVerdictFromLedger, synthesizeAutoresearchReport } from "../autoresearch/report";
import {
	AutoresearchRunsStore,
	buildAutoresearchExperimentState,
	createAutoresearchExperimentConfig,
	type MetricDirection,
} from "../autoresearch/runs";
import { createMissionPythonTool, missionArtifactsDir, openMissionNotebook } from "../autoresearch/session";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { syncSkillActiveState } from "../skill-state/active-state";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import { sessionAutoresearchDir } from "./session-layout";
import {
	resolveGjcSessionForRead,
	resolveGjcSessionForWrite,
	SessionResolutionError,
	writeSessionActivityMarker,
} from "./session-resolution";
import {
	appendJsonl,
	persistedStateRevision,
	readExistingStateForMutation,
	writeGuardedJsonAtomic,
} from "./state-writer";
import { assertSafePathComponent, CommandError, flagValue, hasFlag } from "./workflow-cli-common";

export type AutoresearchMode = "web" | "mixed" | "data";
export type AutoresearchIntakeKind = "handoff" | "cold";

export const AUTORESEARCH_MODES = new Set<AutoresearchMode>(["web", "mixed", "data"]);

export const AUTORESEARCH_LEDGER_EVENT_KINDS = [
	"mission_created",
	"mode_set",
	"run_logged",
	"verdict_issued",
	"critic_recorded",
	"kernel_cleared",
] as const;
export type AutoresearchLedgerEventKind = (typeof AUTORESEARCH_LEDGER_EVENT_KINDS)[number];

/** The one mission artifact both intake entrypoints write. */
export interface AutoresearchMission {
	objective: string;
	mode: AutoresearchMode;
	deliverables: string[];
	constraints: string[];
	slug: string;
	intake: AutoresearchIntakeKind;
	createdAt: string;
	updatedAt: string;
	/** Absolute path of the deep-interview spec consumed by handoff intake. */
	specPath?: string;
	handedOffAt?: string;
	/**
	 * Primary metric contract for the mission's harness.
	 *
	 * Optional: a mission that declares none keeps the historical default
	 * (`metric`, lower-is-better). When declared it MUST reach the experiment
	 * config -- otherwise a mission whose research contract is
	 * higher-is-better silently optimizes the wrong direction.
	 */
	primaryMetric?: string;
	metricUnit?: string;
	metricDirection?: MetricDirection;
}

export interface AutoresearchPaths {
	dir: string;
	missionPath: string;
	ledgerPath: string;
	/** Quarantine root for retired missions: `<dir>/retired/<slug>.<timestamp>/`. */
	retiredRoot: string;
}

/** Append-only session ledger row. */
export interface AutoresearchLedgerEvent {
	eventId: string;
	event: AutoresearchLedgerEventKind;
	timestamp: string;
	[field: string]: unknown;
}

/** Optional per-mission critic pass receipt; evaluator is distinct from the mission agent. */
export interface AutoresearchCriticReceipt {
	criticId: string;
	status: Record<string, unknown>;
	evidence: string[];
	caveats: string[];
	evaluator: string;
	recordedAt: string;
}

/** Structured mission verdict: status is open data, not a pinned enum — terminality is deliberately deferred. */
export interface AutoresearchVerdictReceipt {
	receiptId: string;
	status: Record<string, unknown>;
	evidence: string[];
	caveats: string[];
	evaluator: string;
	issuedAt: string;
	criticReceipt?: AutoresearchCriticReceipt;
}

export interface AutoresearchCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
	intake?: AutoresearchIntakeKind;
	missionCreated?: boolean;
}

export interface AutoresearchReadReceipt {
	ok: true;
	exists: boolean;
	mission?: AutoresearchMission;
	ledger: AutoresearchLedgerEvent[];
	paths: AutoresearchPaths;
	/**
	 * GJC session id the mission state was read from. Callers deriving
	 * session-scoped identity (notably the kernel owner id) MUST use this
	 * instead of re-resolving, so every path agrees on one scope.
	 */
	sessionId: string;
}

export interface AutoresearchWriteReceipt {
	ok: true;
	mission: AutoresearchMission;
	missionPath: string;
	intake: AutoresearchIntakeKind;
	ledgerEvent?: AutoresearchLedgerEvent;
}

export interface AutoresearchClearReceipt {
	ok: true;
	cleared: boolean;
	missionPath: string;
	ledgerEvent: AutoresearchLedgerEvent;
	/** Where the retired mission's artifacts were quarantined, when one existed. */
	retiredTo?: string;
}

export interface AutoresearchHandoffReceipt extends AutoresearchWriteReceipt {
	specPath: string;
}

class AutoresearchCommandError extends CommandError {
	constructor(exitStatus: number, message: string) {
		super(exitStatus, message);
		this.name = "AutoresearchCommandError";
	}
}

/** AC-16 write-boundary gate: mode must be explicitly supplied and valid. */
function assertAutoresearchMode(value: unknown, source: string): asserts value is AutoresearchMode {
	if (typeof value !== "string" || !AUTORESEARCH_MODES.has(value as AutoresearchMode)) {
		throw new AutoresearchCommandError(
			2,
			`autoresearch mission mode must be one of web, mixed, or data (${source}); received ${JSON.stringify(value)}. ` +
				"Mode is never inferred from the presence of a data file — declare it explicitly at intake.",
		);
	}
}

function assertStructuredStatus(status: unknown, source: string): asserts status is Record<string, unknown> {
	if (!status || typeof status !== "object" || Array.isArray(status)) {
		throw new AutoresearchCommandError(
			2,
			`autoresearch ${source} must be a structured object; received ${JSON.stringify(status)}`,
		);
	}
}

function requireStringArray(value: unknown, fieldName: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		throw new AutoresearchCommandError(2, `autoresearch ${fieldName} must be a string array`);
	}
	return dedupeStrings(value);
}

function dedupeStrings(values: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

export function getAutoresearchPaths(cwd: string, sessionId?: string | null): AutoresearchPaths {
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const dir = sessionAutoresearchDir(cwd, resolvedSessionId);
	return {
		dir,
		missionPath: path.join(dir, "mission.json"),
		ledgerPath: path.join(dir, "ledger.jsonl"),
		retiredRoot: path.join(dir, "retired"),
	};
}

function normalizeAutoresearchMission(value: unknown): AutoresearchMission {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AutoresearchCommandError(2, "autoresearch mission.json must contain a JSON object");
	}
	const record = value as Record<string, unknown>;
	const objective = typeof record.objective === "string" ? record.objective.trim() : "";
	const slug = typeof record.slug === "string" ? record.slug.trim() : "";
	if (!objective) throw new AutoresearchCommandError(2, "autoresearch mission.json is missing objective");
	if (!slug) throw new AutoresearchCommandError(2, "autoresearch mission.json is missing slug");
	assertAutoresearchMode(record.mode, "mission.json");
	const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
	const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : createdAt;
	const intake: AutoresearchIntakeKind = record.intake === "handoff" ? "handoff" : "cold";
	return {
		objective,
		mode: record.mode,
		deliverables: requireStringArray(record.deliverables ?? [], "mission.json deliverables"),
		constraints: requireStringArray(record.constraints ?? [], "mission.json constraints"),
		slug,
		intake,
		createdAt,
		updatedAt,
		...(typeof record.specPath === "string" && record.specPath.trim() !== "" ? { specPath: record.specPath } : {}),
		...(typeof record.handedOffAt === "string" && record.handedOffAt.trim() !== ""
			? { handedOffAt: record.handedOffAt }
			: {}),
		// Preserve the declared metric contract across read/write round-trips;
		// dropping it here would silently reinstate the default direction.
		...(typeof record.primaryMetric === "string" && record.primaryMetric.trim() !== ""
			? { primaryMetric: record.primaryMetric.trim() }
			: {}),
		...(typeof record.metricUnit === "string" && record.metricUnit.trim() !== ""
			? { metricUnit: record.metricUnit.trim() }
			: {}),
		...(record.metricDirection === "higher" || record.metricDirection === "lower"
			? { metricDirection: record.metricDirection }
			: {}),
	};
}

export async function readAutoresearchMission(
	cwd: string,
	sessionId?: string | null,
): Promise<AutoresearchMission | null> {
	const resolvedSessionId =
		sessionId?.trim() ||
		(await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	try {
		return normalizeAutoresearchMission(
			await Bun.file(getAutoresearchPaths(cwd, resolvedSessionId).missionPath).json(),
		);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

export async function readAutoresearchLedger(
	cwd: string,
	sessionId?: string | null,
): Promise<AutoresearchLedgerEvent[]> {
	const resolvedSessionId =
		sessionId?.trim() ||
		(await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	try {
		const raw = await Bun.file(getAutoresearchPaths(cwd, resolvedSessionId).ledgerPath).text();
		return raw
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line) as AutoresearchLedgerEvent);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function appendAutoresearchLedger(
	cwd: string,
	payload: { event: AutoresearchLedgerEventKind } & Record<string, unknown>,
	sessionId?: string | null,
): Promise<AutoresearchLedgerEvent> {
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const paths = getAutoresearchPaths(cwd, resolvedSessionId);
	const entry: AutoresearchLedgerEvent = {
		eventId: crypto.randomUUID(),
		...payload,
		timestamp: new Date().toISOString(),
	};
	await appendJsonl(paths.ledgerPath, entry, {
		cwd,
		audit: {
			category: "ledger",
			verb: "append",
			owner: "gjc-runtime",
			skill: "autoresearch",
			sessionId: resolvedSessionId,
		},
	});
	await writeSessionActivityMarker(cwd, resolvedSessionId, { writer: "autoresearch-runtime", path: paths.ledgerPath });
	return entry;
}

async function persistAutoresearchMission(input: {
	cwd: string;
	sessionId: string;
	mission: AutoresearchMission;
}): Promise<AutoresearchMission> {
	const paths = getAutoresearchPaths(input.cwd, input.sessionId);
	const existingRead = await readExistingStateForMutation(paths.missionPath);
	if (existingRead.kind === "corrupt") {
		throw new AutoresearchCommandError(
			2,
			`existing autoresearch mission is corrupt or tampered (${existingRead.error}); refusing to overwrite ${paths.missionPath}`,
		);
	}
	await writeGuardedJsonAtomic(paths.missionPath, input.mission, {
		cwd: input.cwd,
		policy: "source",
		expectedRevision: existingRead.kind === "valid" ? persistedStateRevision(existingRead.value) : undefined,
		audit: {
			category: "state",
			verb: "write",
			owner: "gjc-runtime",
			skill: "autoresearch",
			sessionId: input.sessionId,
		},
	});
	await writeSessionActivityMarker(input.cwd, input.sessionId, {
		writer: "autoresearch-runtime",
		path: paths.missionPath,
	});
	return input.mission;
}

/* ------------------------------ verbs ------------------------------ */

/** read verb: current mission + append-only ledger snapshot. */
export async function autoresearchRead(cwd: string, sessionId?: string | null): Promise<AutoresearchReadReceipt> {
	const resolvedSessionId =
		sessionId?.trim() ||
		(await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	const mission = await readAutoresearchMission(cwd, resolvedSessionId);
	const ledger = await readAutoresearchLedger(cwd, resolvedSessionId);
	return {
		ok: true,
		exists: mission !== null,
		...(mission ? { mission } : {}),
		ledger,
		paths: getAutoresearchPaths(cwd, resolvedSessionId),
		sessionId: resolvedSessionId,
	};
}

/**
 * Validate and normalize the optional primary-metric contract.
 *
 * Direction is validated at the write boundary exactly like mode: an
 * unrecognized value is rejected rather than coerced, so a typo can never
 * silently flip the mission to the default direction.
 */
function normalizeMetricContract(
	input: { primaryMetric?: string; metricUnit?: string; metricDirection?: string },
	context: string,
): Pick<AutoresearchMission, "primaryMetric" | "metricUnit" | "metricDirection"> {
	const result: Pick<AutoresearchMission, "primaryMetric" | "metricUnit" | "metricDirection"> = {};
	const primaryMetric = input.primaryMetric?.trim();
	if (primaryMetric) result.primaryMetric = primaryMetric;
	const metricUnit = input.metricUnit?.trim();
	if (metricUnit) result.metricUnit = metricUnit;
	const direction = input.metricDirection?.trim().toLowerCase();
	if (direction !== undefined && direction !== "") {
		if (direction !== "higher" && direction !== "lower") {
			throw new AutoresearchCommandError(
				2,
				`${context} metric direction must be "higher" or "lower"; received ${JSON.stringify(input.metricDirection)}. It is never inferred.`,
			);
		}
		result.metricDirection = direction;
	}
	return result;
}

/** write verb: persist the mission after cold-intake clarification. Mode is required. */
export async function autoresearchWrite(input: {
	cwd: string;
	objective: string;
	mode: AutoresearchMode;
	deliverables?: string[];
	constraints?: string[];
	slug: string;
	sessionId?: string | null;
	primaryMetric?: string;
	metricUnit?: string;
	metricDirection?: string;
}): Promise<AutoresearchWriteReceipt> {
	const objective = input.objective.trim();
	if (!objective) throw new AutoresearchCommandError(2, "autoresearch mission objective is required");
	const slug = input.slug.trim();
	if (!slug) throw new AutoresearchCommandError(2, "autoresearch mission slug is required");
	assertSafePathComponent(slug, "slug");
	// AC-16: hard fail at the write boundary; mode is never inferred.
	assertAutoresearchMode(input.mode, "write intake");
	const metric = normalizeMetricContract(input, "write intake");
	const resolvedSessionId =
		input.sessionId?.trim() ||
		resolveGjcSessionForWrite(input.cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const now = new Date().toISOString();
	const paths = getAutoresearchPaths(input.cwd, resolvedSessionId);
	const existing = await readAutoresearchMission(input.cwd, resolvedSessionId);
	const mission: AutoresearchMission = {
		objective,
		mode: input.mode,
		deliverables: dedupeStrings(input.deliverables ?? []),
		constraints: dedupeStrings(input.constraints ?? []),
		slug,
		intake: "cold",
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		...metric,
	};
	await persistAutoresearchMission({ cwd: input.cwd, sessionId: resolvedSessionId, mission });
	let ledgerEvent: AutoresearchLedgerEvent | undefined;
	if (existing === null) {
		ledgerEvent = await appendAutoresearchLedger(
			input.cwd,
			{ event: "mission_created", slug, mode: mission.mode, objective },
			resolvedSessionId,
		);
	} else if (existing.mode !== mission.mode) {
		ledgerEvent = await appendAutoresearchLedger(
			input.cwd,
			{ event: "mode_set", slug, mode: mission.mode, previousMode: existing.mode },
			resolvedSessionId,
		);
	}
	return { ok: true, mission, missionPath: paths.missionPath, intake: "cold", ledgerEvent };
}

/**
 * Durable per-mission artifacts that live directly under the session
 * autoresearch dir. `clear` must retire ALL of them, not just `mission.json`:
 * leaving `ledger.jsonl` behind let a successor mission inherit the previous
 * mission's `verdict_issued` / `critic_recorded` rows, so
 * `extractVerdictFromLedger` surfaced a prior verdict as if it were the new
 * mission's. `runs.jsonl` and `experiment.json` leaked run history and the
 * metric contract the same way, and `runs/` holds the notebook and report.
 */
const AUTORESEARCH_MISSION_ARTIFACTS = ["mission.json", "ledger.jsonl", "runs.jsonl", "experiment.json"] as const;
const AUTORESEARCH_RUNS_SUBDIR = "runs";

/**
 * clear verb: retire the entire mission working set and record the kernel clear.
 *
 * Artifacts are QUARANTINED to `<dir>/retired/<slug>.<timestamp>/`, never
 * deleted, so a completed mission's evidence stays auditable while the
 * successor mission starts from genuinely empty state. The `kernel_cleared` row
 * is appended to the OUTGOING ledger before it is moved, so the retired ledger
 * is a complete record that ends with its own clear and the successor's ledger
 * starts empty rather than the clear silently vanishing from the audit trail.
 */
export async function autoresearchClear(cwd: string, sessionId?: string | null): Promise<AutoresearchClearReceipt> {
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const paths = getAutoresearchPaths(cwd, resolvedSessionId);
	const existing = await readAutoresearchMission(cwd, resolvedSessionId);
	// Must go through the shared derivation: an inline template here is what
	// drifted from the tool's owner id and left cleared kernels resident.
	if (existing) await disposeKernelSessionsByOwner(autoresearchKernelOwnerId(resolvedSessionId, existing.slug));
	// Close out the outgoing ledger first so the retired copy ends with its clear.
	const ledgerEvent = await appendAutoresearchLedger(
		cwd,
		{ event: "kernel_cleared", slug: existing?.slug ?? "" },
		resolvedSessionId,
	);
	const retiredTo = existing ? await retireAutoresearchMissionArtifacts(paths, existing.slug) : undefined;
	const deleted = existing !== null;
	await reconcileAutoresearchState(cwd, existing, resolvedSessionId, { active: false, phase: "complete" });
	return {
		ok: true,
		cleared: deleted,
		missionPath: paths.missionPath,
		ledgerEvent,
		...(retiredTo ? { retiredTo } : {}),
	};
}

/**
 * Move every durable mission artifact aside into a uniquely-reserved directory.
 *
 * A timestamp alone collides when two clears land in the same millisecond,
 * which would overwrite the earlier mission's evidence, so the directory is
 * reserved with an exclusive mkdir and disambiguated with a counter.
 */
async function retireAutoresearchMissionArtifacts(paths: AutoresearchPaths, slug: string): Promise<string> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	await fs.mkdir(paths.retiredRoot, { recursive: true });
	const base = path.join(paths.retiredRoot, `${slug}.${stamp}`);
	let retiredTo = base;
	for (let attempt = 1; ; attempt += 1) {
		retiredTo = attempt === 1 ? base : `${base}-${attempt}`;
		try {
			await fs.mkdir(retiredTo);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	for (const name of AUTORESEARCH_MISSION_ARTIFACTS) {
		await moveIfPresent(path.join(paths.dir, name), path.join(retiredTo, name));
	}
	await moveIfPresent(path.join(paths.dir, AUTORESEARCH_RUNS_SUBDIR), path.join(retiredTo, AUTORESEARCH_RUNS_SUBDIR));
	return retiredTo;
}

async function moveIfPresent(from: string, to: string): Promise<void> {
	try {
		await fs.rename(from, to);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

/* --------------------------- handoff intake --------------------------- */

const AUTORESEARCH_MODE_DECLARATION_RE = /^(?:[-*]\s+)?autoresearch-mode\s*:\s*(web|mixed|data)\s*$/i;
const AUTORESEARCH_METRIC_DECLARATION_RE = /^(?:[-*]\s+)?autoresearch-metric\s*:\s*(.+?)\s*$/i;
const AUTORESEARCH_METRIC_UNIT_DECLARATION_RE = /^(?:[-*]\s+)?autoresearch-metric-unit\s*:\s*(.+?)\s*$/i;
const AUTORESEARCH_METRIC_DIRECTION_DECLARATION_RE = /^(?:[-*]\s+)?autoresearch-metric-direction\s*:\s*(.+?)\s*$/i;
const HEADING_RE = /^#{1,6}\s+(.+)$/;
const BULLET_RE = /^[-*]\s+(.+)$/;
const ACCEPTANCE_CRITERIA_DELIVERABLE_RE = /^[-*]\s+\[[ xX]\]\s+(.+)$/;
const INTERVIEW_ID_RE = /^[-*]\s*Interview ID:\s*(.+)$/i;

interface ParsedAutoresearchSpec {
	objective: string;
	mode: AutoresearchMode;
	deliverables: string[];
	constraints: string[];
	slug: string;
	primaryMetric?: string;
	metricUnit?: string;
	metricDirection?: MetricDirection;
}

function sectionBullets(lines: string[], sectionNames: readonly string[]): string[] {
	const wanted = new Set(sectionNames.map(name => name.toLowerCase()));
	let current: string | null = null;
	const bullets: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		const heading = HEADING_RE.exec(trimmed);
		if (heading) {
			current = heading[1]!.trim().toLowerCase();
			continue;
		}
		if (current === null || !wanted.has(current)) continue;
		const bullet = BULLET_RE.exec(trimmed);
		if (!bullet) continue;
		const text = bullet[1]!.trim();
		if (text) bullets.push(text);
	}
	return dedupeStrings(bullets);
}

function sanitizeSpecSlug(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (normalized === "") {
		throw new AutoresearchCommandError(
			2,
			"autoresearch handoff intake could not derive a mission slug from the spec",
		);
	}
	return normalized;
}

/**
 * Parse a persisted deep-interview spec into the mission fields. The spec MUST
 * declare its mission mode explicitly with a line like `autoresearch-mode: web`
 * (one of web, mixed, data); a missing or invalid declaration is a hard fail —
 * mode is never inferred from spec structure or incidental files.
 */
function parseAutoresearchSpec(specText: string, specPath: string): ParsedAutoresearchSpec {
	const lines = specText.split(/\r?\n/);
	let mode: AutoresearchMode | undefined;
	for (const line of lines) {
		const match = AUTORESEARCH_MODE_DECLARATION_RE.exec(line.trim());
		if (match) {
			mode = match[1]!.toLowerCase() as AutoresearchMode;
			break;
		}
	}
	if (!mode) {
		throw new AutoresearchCommandError(
			2,
			`autoresearch handoff intake requires the spec to declare its mission mode explicitly with a line like "autoresearch-mode: web" (one of web, mixed, data) at ${specPath}. ` +
				"Mode is never inferred from the presence of a data file.",
		);
	}
	// Optional metric contract. Same declaration style as the mode line; the
	// direction is validated rather than coerced.
	const firstMatch = (re: RegExp): string | undefined => {
		for (const line of lines) {
			const found = re.exec(line.trim());
			if (found) return found[1];
		}
		return undefined;
	};
	const metric = normalizeMetricContract(
		{
			primaryMetric: firstMatch(AUTORESEARCH_METRIC_DECLARATION_RE),
			metricUnit: firstMatch(AUTORESEARCH_METRIC_UNIT_DECLARATION_RE),
			metricDirection: firstMatch(AUTORESEARCH_METRIC_DIRECTION_DECLARATION_RE),
		},
		`autoresearch handoff intake at ${specPath}`,
	);

	const h1 = lines.find(line => /^#\s+\S/.test(line.trim()));
	const objective =
		(h1 ?? lines.find(line => line.trim() !== ""))?.trim().replace(/^#\s+/, "") ?? path.basename(specPath);
	const deliverables = sectionBullets(lines, ["deliverables"]);
	const acceptanceCriteria = sectionBullets(lines, ["acceptance criteria"]);
	const finalDeliverables =
		deliverables.length > 0
			? deliverables
			: acceptanceCriteria.map(text => ACCEPTANCE_CRITERIA_DELIVERABLE_RE.exec(text)?.[1]?.trim() ?? text);
	const constraints = sectionBullets(lines, ["constraints"]);
	const interviewIdLine = lines.find(line => INTERVIEW_ID_RE.test(line.trim()));
	const interviewId = interviewIdLine ? INTERVIEW_ID_RE.exec(interviewIdLine.trim())?.[1]?.trim() : undefined;
	const slug = sanitizeSpecSlug(interviewId ?? path.basename(specPath, path.extname(specPath)));
	return {
		objective,
		mode,
		deliverables: finalDeliverables,
		constraints,
		slug,
		...metric,
	};
}

/** handoff verb: `--spec` intake — read the spec, write the mission, ask zero questions. */
export async function autoresearchHandoff(input: {
	cwd: string;
	specPath: string;
	sessionId?: string | null;
}): Promise<AutoresearchHandoffReceipt> {
	const resolvedSpecPath = path.resolve(input.cwd, input.specPath);
	let specText: string;
	try {
		specText = await fs.readFile(resolvedSpecPath, "utf-8");
	} catch (error) {
		throw new AutoresearchCommandError(
			2,
			`autoresearch handoff intake could not read spec at ${resolvedSpecPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const parsed = parseAutoresearchSpec(specText, resolvedSpecPath);
	const resolvedSessionId =
		input.sessionId?.trim() ||
		resolveGjcSessionForWrite(input.cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const now = new Date().toISOString();
	const paths = getAutoresearchPaths(input.cwd, resolvedSessionId);
	const existing = await readAutoresearchMission(input.cwd, resolvedSessionId);
	const mission: AutoresearchMission = {
		objective: parsed.objective,
		mode: parsed.mode,
		deliverables: parsed.deliverables,
		constraints: parsed.constraints,
		slug: parsed.slug,
		intake: "handoff",
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		specPath: resolvedSpecPath,
		handedOffAt: now,
		...(parsed.primaryMetric === undefined ? {} : { primaryMetric: parsed.primaryMetric }),
		...(parsed.metricUnit === undefined ? {} : { metricUnit: parsed.metricUnit }),
		...(parsed.metricDirection === undefined ? {} : { metricDirection: parsed.metricDirection }),
	};
	await persistAutoresearchMission({ cwd: input.cwd, sessionId: resolvedSessionId, mission });
	let ledgerEvent: AutoresearchLedgerEvent | undefined;
	if (existing === null) {
		ledgerEvent = await appendAutoresearchLedger(
			input.cwd,
			{
				event: "mission_created",
				slug: mission.slug,
				mode: mission.mode,
				objective: mission.objective,
				specPath: resolvedSpecPath,
			},
			resolvedSessionId,
		);
	} else if (existing.mode !== mission.mode) {
		ledgerEvent = await appendAutoresearchLedger(
			input.cwd,
			{ event: "mode_set", slug: mission.slug, mode: mission.mode, previousMode: existing.mode },
			resolvedSessionId,
		);
	}
	return {
		ok: true,
		mission,
		missionPath: paths.missionPath,
		intake: "handoff",
		specPath: resolvedSpecPath,
		ledgerEvent,
	};
}

/* ------------------------------ run/verdict ------------------------------ */

/** Record one experiment run in the ledger. */
export async function autoresearchLogRun(input: {
	cwd: string;
	runId: string;
	status: string;
	description: string;
	metric?: number;
	slug?: string;
	sessionId?: string | null;
}): Promise<AutoresearchLedgerEvent> {
	const runId = input.runId.trim();
	if (!runId) throw new AutoresearchCommandError(2, "autoresearch run_id is required");
	const status = input.status.trim();
	if (!status) throw new AutoresearchCommandError(2, "autoresearch run status is required");
	const description = input.description.trim();
	if (!description) throw new AutoresearchCommandError(2, "autoresearch run description is required");
	if (status !== "keep" && status !== "discard" && status !== "crash" && status !== "checks_failed") {
		throw new AutoresearchCommandError(2, "autoresearch run status must be keep, discard, crash, or checks_failed");
	}
	const sessionId =
		input.sessionId?.trim() ||
		resolveGjcSessionForWrite(input.cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const store = await autoresearchRunsStore(input.cwd, sessionId);
	if (!store.config) throw new AutoresearchCommandError(2, "autoresearch run logging requires an active mission");
	// Reuse the caller-supplied pending run identity when it exists so runs.jsonl and
	// the ledger reference the same run; otherwise synthesize one record.
	const existing = store.listRuns().find(run => run.runId === runId);
	let targetRunId: string;
	if (existing && existing.status === null && existing.abandonedAt === null) {
		targetRunId = existing.runId;
	} else {
		const started = await store.startRun({ command: "research observation" });
		targetRunId = started.runId;
	}
	await store.completeRun(targetRunId, {
		exitCode: status === "crash" || status === "checks_failed" ? 1 : 0,
		timedOut: false,
	});
	await store.logRun(targetRunId, {
		status,
		description,
		...(input.metric === undefined ? {} : { metric: input.metric }),
	});
	return await appendAutoresearchLedger(
		input.cwd,
		{
			event: "run_logged",
			run_id: targetRunId,
			status,
			description,
			...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
			...(typeof input.metric === "number" && Number.isFinite(input.metric) ? { metric: input.metric } : {}),
		},
		sessionId,
	);
}

/** Record the optional per-mission critic pass; its evaluator is distinct from the mission agent. */
export async function autoresearchRecordCritic(input: {
	cwd: string;
	status: Record<string, unknown>;
	evidence: string[];
	caveats: string[];
	evaluator: string;
	slug?: string;
	sessionId?: string | null;
}): Promise<AutoresearchCriticReceipt> {
	assertStructuredStatus(input.status, "critic status");
	const evidence = requireStringArray(input.evidence, "critic evidence");
	const caveats = requireStringArray(input.caveats, "critic caveats");
	const evaluator = input.evaluator.trim();
	if (!evaluator) throw new AutoresearchCommandError(2, "autoresearch critic evaluator is required");
	const receipt: AutoresearchCriticReceipt = {
		criticId: crypto.randomUUID(),
		status: input.status,
		evidence,
		caveats,
		evaluator,
		recordedAt: new Date().toISOString(),
	};
	await appendAutoresearchLedger(
		input.cwd,
		{
			event: "critic_recorded",
			...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
			criticReceipt: receipt,
		},
		input.sessionId,
	);
	return receipt;
}

/** Issue the mission verdict; an optional critic receipt rides along with its own evaluator identity. */
export async function autoresearchIssueVerdict(input: {
	cwd: string;
	status: Record<string, unknown>;
	evidence: string[];
	caveats: string[];
	evaluator: string;
	criticReceipt?: AutoresearchCriticReceipt;
	slug?: string;
	sessionId?: string | null;
}): Promise<AutoresearchVerdictReceipt> {
	assertStructuredStatus(input.status, "verdict status");
	const evidence = requireStringArray(input.evidence, "verdict evidence");
	const caveats = requireStringArray(input.caveats, "verdict caveats");
	const evaluator = input.evaluator.trim();
	if (!evaluator) throw new AutoresearchCommandError(2, "autoresearch verdict evaluator is required");
	const sessionId =
		input.sessionId?.trim() ||
		resolveGjcSessionForWrite(input.cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const ledger = await readAutoresearchLedger(input.cwd, sessionId);
	const latestCritic = [...ledger].reverse().find(event => event.event === "critic_recorded" && event.criticReceipt)
		?.criticReceipt as AutoresearchCriticReceipt | undefined;
	const receipt: AutoresearchVerdictReceipt = {
		receiptId: crypto.randomUUID(),
		status: input.status,
		evidence,
		caveats,
		evaluator,
		issuedAt: new Date().toISOString(),
		...((input.criticReceipt ?? latestCritic) ? { criticReceipt: input.criticReceipt ?? latestCritic } : {}),
	};
	await appendAutoresearchLedger(
		input.cwd,
		{
			event: "verdict_issued",
			...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
			verdictReceipt: receipt,
		},
		sessionId,
	);
	const mission = await readAutoresearchMission(input.cwd, sessionId);
	if (mission) await reconcileAutoresearchState(input.cwd, mission, sessionId, { phase: "verdict" });
	return receipt;
}

/* ------------------------------ CLI dispatch ------------------------------ */

function renderAutoresearchHelp(): string {
	return [
		"Run native GJC Autoresearch workflow commands",
		"",
		"USAGE",
		"  $ gjc autoresearch [--spec <path>] [--json] [goal...]",
		"  $ gjc autoresearch read [--json]",
		"  $ gjc autoresearch clear [--json]",
		"  $ gjc autoresearch write --goal <goal> --mode <web|mixed|data> --slug <slug> [--deliverable <text>] [--constraint <text>] [--json]",
		"  $ gjc autoresearch log-run --run-id <id> --status <status> --description <text> [--metric <number>] [--json]",
		"  $ gjc autoresearch verdict --status-json <object> --evidence <text> --evaluator <id> [--caveat <text>] [--json]",
		"  $ gjc autoresearch critic --status-json <object> --evidence <text> --evaluator <id> [--caveat <text>] [--json]",
		"  $ gjc autoresearch report [--summary <text>] [--json]",
		"",
		"INTAKE",
		"  --spec=<path>    Handoff intake: read a persisted deep-interview spec and start research",
		"                   with zero clarification questions. The spec must declare its mission",
		"                   mode explicitly (a line like `autoresearch-mode: web`).",
		"  positional goal  Cold intake: signals that goal/constraints/deliverables clarification",
		"                   must run before research begins.",
		"  bare invocation  Cold intake (no goal text).",
		"  write            Persist a clarified cold-intake mission. Mode and slug are required.",
		"  read             Read the current mission and append-only ledger.",
		"  clear            Dispose the mission kernel and clear the mission artifact.",
		"  log-run          Append one research run receipt to the mission ledger.",
		"  verdict          Append the structured mission verdict receipt.",
		"  critic           Append an optional structured critic receipt.",
		"  report           Synthesize the mission report from the notebook and ledger.",
		"      --json       Output a machine-readable receipt.",
		"",
		"STATE",
		"  Mission/ledger/verdict state persists under .gjc/_session-{sessionid}/autoresearch/.",
		"  The global autoresearch store is not written.",
		"",
		"EXAMPLES",
		"  $ gjc autoresearch --spec .gjc/_session-abc/specs/deep-interview-my-mission.md --json",
		'  $ gjc autoresearch "Optimize the tokenizer throughput"',
		"  $ gjc autoresearch",
		"",
	].join("\n");
}

function repeatedFlagValues(args: readonly string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== flag) continue;
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new AutoresearchCommandError(2, `${flag} requires a non-empty value`);
		values.push(value);
		index += 1;
	}
	return values;
}

function assertOnlyAutoresearchFlags(args: readonly string[], allowed: readonly string[]): void {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (!arg.startsWith("--")) continue;
		if (!allowed.includes(arg)) throw new AutoresearchCommandError(2, `unknown flag for gjc autoresearch: ${arg}`);
		if (arg !== "--json") index += 1;
	}
}

function requiredFlagValue(args: readonly string[], flag: string): string {
	const value = flagValue(args, flag)?.trim();
	if (!value) throw new AutoresearchCommandError(2, `${flag} requires a non-empty value`);
	return value;
}

function jsonObjectFlag(args: readonly string[], flag: string): Record<string, unknown> {
	const raw = requiredFlagValue(args, flag);
	try {
		const value = JSON.parse(raw) as unknown;
		assertStructuredStatus(value, flag);
		return value;
	} catch (error) {
		if (error instanceof AutoresearchCommandError) throw error;
		throw new AutoresearchCommandError(2, `${flag} must be a JSON object`);
	}
}

function extractPositionalGoal(args: readonly string[]): string {
	const parts: string[] = [];
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (arg === "--spec") {
			skipNext = true;
			continue;
		}
		if (arg === "--json") continue;
		if (arg.startsWith("-")) {
			throw new AutoresearchCommandError(2, `unknown flag for gjc autoresearch: ${arg}`);
		}
		parts.push(arg);
	}
	return parts.join(" ").trim();
}

function renderHandoffIntakeText(receipt: AutoresearchHandoffReceipt): string {
	return [
		`autoresearch intake=handoff slug=${receipt.mission.slug}`,
		`mode=${receipt.mission.mode}`,
		`objective=${receipt.mission.objective}`,
		`spec_path=${receipt.specPath}`,
		`mission_path=${receipt.missionPath}`,
		"research may begin; zero clarification questions.",
		"",
	].join("\n");
}

function renderColdIntakeText(goal: string): string {
	return [
		"autoresearch intake=cold clarification_required=true",
		...(goal ? [`goal=${goal}`] : []),
		"next=run goal, constraints, and deliverables clarification before research begins",
		"",
	].join("\n");
}

/**
 * Reconcile the session-scoped active-state/HUD row after a mission write
 * (skill "autoresearch" is a plain active-state skill until the canonical slot
 * swap; the entry and snapshot are the generic per-skill machinery).
 * Best-effort: a HUD sync failure never changes command semantics.
 */
async function reconcileAutoresearchState(
	cwd: string,
	mission: AutoresearchMission | null,
	sessionId?: string,
	options: { active?: boolean; phase?: "intake" | "research" | "verdict" | "complete" } = {},
): Promise<void> {
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	try {
		await syncSkillActiveState({
			cwd,
			skill: "autoresearch",
			active: options.active ?? true,
			phase: options.phase ?? "research",
			sessionId: resolvedSessionId,
			source: "gjc-autoresearch-native",
			hud: {
				version: 1,
				summary: mission ? `autoresearch mission ${mission.slug}` : "autoresearch mission cleared",
				chips: [
					...(mission ? [{ label: "mode", value: mission.mode }] : []),
					...(mission ? [{ label: "intake", value: mission.intake }] : []),
				],
				updated_at: new Date().toISOString(),
			},
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

export async function runNativeAutoresearchCommand(
	args: string[],
	cwd = process.cwd(),
): Promise<AutoresearchCommandResult> {
	try {
		if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
			return { status: 0, stdout: renderAutoresearchHelp() };
		}
		const verb = args[0];
		if (verb === "read") {
			assertOnlyAutoresearchFlags(args.slice(1), ["--json"]);
			const receipt = await autoresearchRead(cwd);
			return {
				status: 0,
				stdout: hasFlag(args, "--json")
					? renderCliWriteReceipt({
							ok: receipt.ok,
							exists: receipt.exists,
							...(receipt.mission ? { mission: receipt.mission } : {}),
							ledger: receipt.ledger,
							paths: receipt.paths,
						})
					: `autoresearch exists=${receipt.exists}\nmission_path=${receipt.paths.missionPath}\nledger_path=${receipt.paths.ledgerPath}\n`,
			};
		}
		if (verb === "clear") {
			assertOnlyAutoresearchFlags(args.slice(1), ["--json"]);
			const receipt = await autoresearchClear(cwd);
			return {
				status: 0,
				stdout: hasFlag(args, "--json")
					? renderCliWriteReceipt({
							ok: true,
							cleared: receipt.cleared,
							mission_path: receipt.missionPath,
							...(receipt.retiredTo ? { retired_to: receipt.retiredTo } : {}),
							ledger_event: receipt.ledgerEvent.event,
						})
					: `autoresearch cleared=${receipt.cleared}\nmission_path=${receipt.missionPath}\n${
							receipt.retiredTo ? `retired_to=${receipt.retiredTo}\n` : ""
						}`,
			};
		}
		if (verb === "write") {
			assertOnlyAutoresearchFlags(args.slice(1), [
				"--goal",
				"--mode",
				"--slug",
				"--deliverable",
				"--constraint",
				"--primary-metric",
				"--metric-unit",
				"--metric-direction",
				"--json",
			]);
			const objective = flagValue(args, "--goal");
			const mode = flagValue(args, "--mode");
			const slug = flagValue(args, "--slug");
			if (objective === undefined || mode === undefined || slug === undefined) {
				throw new AutoresearchCommandError(2, "write requires --goal, --mode, and --slug");
			}
			const receipt = await autoresearchWrite({
				cwd,
				objective,
				mode: mode as AutoresearchMode,
				slug,
				deliverables: repeatedFlagValues(args, "--deliverable"),
				constraints: repeatedFlagValues(args, "--constraint"),
				primaryMetric: flagValue(args, "--primary-metric"),
				metricUnit: flagValue(args, "--metric-unit"),
				metricDirection: flagValue(args, "--metric-direction"),
			});
			await reconcileAutoresearchState(cwd, receipt.mission);
			return {
				status: 0,
				intake: "cold",
				missionCreated: true,
				stdout: hasFlag(args, "--json")
					? renderCliWriteReceipt({
							ok: true,
							intake: receipt.intake,
							mission: receipt.mission,
							mission_path: receipt.missionPath,
							ledger_event: receipt.ledgerEvent?.event,
						})
					: `autoresearch intake=cold slug=${receipt.mission.slug}\nmode=${receipt.mission.mode}\nmission_path=${receipt.missionPath}\n`,
			};
		}
		if (verb === "log-run") {
			assertOnlyAutoresearchFlags(args.slice(1), [
				"--run-id",
				"--status",
				"--description",
				"--metric",
				"--slug",
				"--json",
			]);
			const metricRaw = flagValue(args, "--metric");
			const metric = metricRaw === undefined ? undefined : Number(metricRaw);
			if (metricRaw !== undefined && !Number.isFinite(metric)) {
				throw new AutoresearchCommandError(2, "--metric must be a finite number");
			}
			const event = await autoresearchLogRun({
				cwd,
				runId: requiredFlagValue(args, "--run-id"),
				status: requiredFlagValue(args, "--status"),
				description: requiredFlagValue(args, "--description"),
				metric,
				slug: flagValue(args, "--slug"),
			});
			return { status: 0, stdout: renderCliWriteReceipt({ ok: true, ledger_event: event }) };
		}
		if (verb === "critic" || verb === "verdict") {
			assertOnlyAutoresearchFlags(args.slice(1), [
				"--status-json",
				"--evidence",
				"--caveat",
				"--evaluator",
				"--slug",
				"--json",
			]);
			const input = {
				cwd,
				status: jsonObjectFlag(args, "--status-json"),
				evidence: repeatedFlagValues(args, "--evidence"),
				caveats: repeatedFlagValues(args, "--caveat"),
				evaluator: requiredFlagValue(args, "--evaluator"),
				slug: flagValue(args, "--slug"),
			};
			const receipt =
				verb === "critic" ? await autoresearchRecordCritic(input) : await autoresearchIssueVerdict(input);
			return { status: 0, stdout: renderCliWriteReceipt({ ok: true, receipt }) };
		}
		if (verb === "report") {
			assertOnlyAutoresearchFlags(args.slice(1), ["--summary", "--json"]);
			const reportPath = await autoresearchMissionReport(cwd, flagValue(args, "--summary"));
			return {
				status: 0,
				stdout: hasFlag(args, "--json")
					? renderCliWriteReceipt({ ok: true, report_path: reportPath })
					: `autoresearch report_path=${reportPath}\n`,
			};
		}
		const specPath = flagValue(args, "--spec");
		if (specPath !== undefined) {
			if (specPath.trim() === "") {
				return { status: 2, stderr: "--spec requires a non-empty path\n" };
			}
			const json = hasFlag(args, "--json");
			const receipt = await autoresearchHandoff({ cwd, specPath: specPath.trim() });
			await reconcileAutoresearchState(cwd, receipt.mission);
			return {
				status: 0,
				intake: "handoff",
				missionCreated: true,
				stdout: json
					? renderCliWriteReceipt({
							ok: true,
							intake: "handoff",
							mission: receipt.mission,
							mission_path: receipt.missionPath,
							spec_path: receipt.specPath,
							ledger_event: receipt.ledgerEvent?.event,
						})
					: renderHandoffIntakeText(receipt),
			};
		}
		const goal = extractPositionalGoal(args);
		const json = hasFlag(args, "--json");
		const payload: Record<string, unknown> = {
			ok: true,
			intake: "cold",
			clarification_required: true,
			...(goal ? { goal } : {}),
			next: "run goal, constraints, and deliverables clarification before research begins",
		};
		return {
			status: 0,
			intake: "cold",
			stdout: json ? renderCliWriteReceipt(payload) : renderColdIntakeText(goal),
		};
	} catch (error) {
		if (error instanceof CommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		if (error instanceof SessionResolutionError) return { status: 1, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}

/* ------------------------------ capability surface ------------------------------ */

/**
 * Rebuilt autoresearch capability surface. Each of the eight capabilities is
 * reachable from the runtime through a thin, mission-state-aware wrapper. All
 * of them are read-only with respect to the ledger — none append events; the
 * verbs above remain the only writers.
 */

/** 1. Branch isolation: ensure the worktree is on an `autoresearch/*` branch. */
export function autoresearchBranchIsolation(cwd: string, goal: string): Promise<EnsureAutoresearchBranchResult> {
	return ensureAutoresearchBranch(cwd, goal);
}

/** 2. Harness contract: parse `METRIC`/`ASI` lines out of captured harness output. */
export function autoresearchHarnessOutput(output: string, primaryMetricName?: string): ParsedHarnessOutput {
	return parseHarnessOutput(output, primaryMetricName);
}

/**
 * 3. Durable run storage: open the session-scoped JSONL run store, seeding an
 * in-memory experiment config from the mission when none is persisted yet.
 */
export async function autoresearchRunsStore(cwd: string, sessionId?: string | null): Promise<AutoresearchRunsStore> {
	const store = await AutoresearchRunsStore.open(cwd, sessionId);
	if (store.config === null) {
		const mission = await readAutoresearchMission(cwd, sessionId);
		if (mission) {
			store.setInMemoryConfig(
				createAutoresearchExperimentConfig({
					name: mission.slug,
					goal: mission.objective,
					// A declared metric contract must win over the default, or a
					// higher-is-better mission optimizes backwards.
					primaryMetric: mission.primaryMetric ?? "metric",
					...(mission.metricUnit === undefined ? {} : { metricUnit: mission.metricUnit }),
					...(mission.metricDirection === undefined ? {} : { direction: mission.metricDirection }),
					branch: null,
				}),
			);
		}
	}
	return store;
}

/** 4. TUI dashboard: render the run table (collapsed + expanded) from persisted state. */
export async function autoresearchDashboardText(cwd: string, sessionId?: string | null, width = 120): Promise<string> {
	const store = await autoresearchRunsStore(cwd, sessionId);
	const mission = await readAutoresearchMission(cwd, sessionId);
	if (!store.config) return "autoresearch: no experiment config yet";
	const state = buildAutoresearchExperimentState(store.config, store.listLoggedRuns());
	const pendingRun = store.getPendingRun();
	const input: AutoresearchDashboardInput = {
		state,
		runtime: {
			modeOn: mission !== null,
			running: null,
			pendingRun: pendingRun
				? {
						runNumber: pendingRun.runNumber,
						passed: pendingRun.exitCode === 0 && !pendingRun.timedOut,
						parsedPrimary: pendingRun.metric,
					}
				: null,
		},
	};
	return renderExpandedDashboard(input, width);
}

/** 5. Persistent kernel + notebook: build the mission `python` tool bound to the mission. */
export async function autoresearchMissionPythonTool(cwd: string, sessionId?: string | null) {
	const mission = await readAutoresearchMission(cwd, sessionId);
	if (!mission) return null;
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const { writer, paths } = await openMissionNotebook(cwd, mission, resolvedSessionId);
	const tool = createMissionPythonTool({
		cwd,
		mission,
		artifactsDir: missionArtifactsDir(cwd, mission, resolvedSessionId),
		notebook: writer,
		registerSessionCleanup: () => {},
		sessionId: resolvedSessionId,
	});
	return { tool, notebook: writer, paths, mission };
}

/** 6. Synthesized report: notebook cells + final summary, carrying the mission verdict. */
export async function autoresearchMissionReport(
	cwd: string,
	summary?: string,
	sessionId?: string | null,
): Promise<string> {
	const mission = await readAutoresearchMission(cwd, sessionId);
	if (!mission) throw new AutoresearchCommandError(2, "autoresearch report requires an active mission");
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const { writer, paths } = await openMissionNotebook(cwd, mission, resolvedSessionId);
	const ledger = await readAutoresearchLedger(cwd, sessionId);
	const verdict = extractVerdictFromLedger(ledger);
	await synthesizeAutoresearchReport({
		paths,
		notebook: writer,
		mission,
		summary,
		verdict,
	});
	return paths.reportPath;
}

export async function autoresearchDataContext(
	cwd: string,
	dataFlag?: string,
	sessionId?: string | null,
): Promise<RlmDataContext | null> {
	const mission = await readAutoresearchMission(cwd, sessionId);
	if (!mission) return null;
	return loadAutoresearchDataContext({
		cwd,
		mode: mission.mode,
		dataFlag,
	});
}

/** 8. Two-phase prompts: Phase 1 (harness setup) rendered from mission/branch state. */
export async function autoresearchSetupPrompt(
	baseSystemPrompt: string,
	cwd: string,
	goal?: string,
	sessionId?: string | null,
): Promise<string> {
	const mission = await readAutoresearchMission(cwd, sessionId);
	const branch = await ensureAutoresearchBranch(cwd, goal ?? mission?.objective ?? "").then(result =>
		result.ok ? result.branchName : null,
	);
	return renderAutoresearchSetupPrompt({
		baseSystemPrompt,
		goal: goal ?? mission?.objective ?? "",
		workingDir: cwd,
		branch,
		baselineWarning: null,
	});
}

/** 8. Two-phase prompts: Phase 2 (iterate) rendered from the persisted experiment state. */
export async function autoresearchIteratePrompt(
	baseSystemPrompt: string,
	cwd: string,
	sessionId?: string | null,
): Promise<string> {
	const store = await autoresearchRunsStore(cwd, sessionId);
	const mission = await readAutoresearchMission(cwd, sessionId);
	if (!store.config) {
		return renderAutoresearchIteratePrompt({
			baseSystemPrompt,
			goal: mission?.objective ?? "",
			workingDir: cwd,
			branch: null,
			baselineCommit: null,
			metricName: "metric",
			metricUnit: "",
			notes: "",
			currentSegment: 1,
			currentSegmentRunCount: 0,
			baselineMetric: null,
			bestMetric: null,
			bestRunNumber: null,
			recentRuns: [],
			unjustifiedRuns: [],
			pendingRun: null,
		});
	}
	const state = buildAutoresearchExperimentState(store.config, store.listLoggedRuns());
	const current = state.results.filter(result => result.segment === state.currentSegment);
	const recentRuns = current.slice(-3).map(result => {
		const asiSummary = summarizePromptAsi(result.asi);
		return {
			run_number: result.runNumber,
			status: result.status,
			metric_display: formatPromptMetricValue(result.metric, state.metricUnit),
			description: result.description,
			has_asi_summary: Boolean(asiSummary),
			asi_summary: asiSummary ?? "",
			has_deviations: result.scopeDeviations.length > 0,
			deviations: result.scopeDeviations.join(", "),
			justified: Boolean(result.justification),
			flagged: result.flagged,
			flagged_reason: result.flaggedReason ?? "",
		};
	});
	const unjustifiedRuns = current
		.filter(
			result =>
				result.status === "keep" && !result.flagged && result.scopeDeviations.length > 0 && !result.justification,
		)
		.slice(-3)
		.map(result => ({ run_number: result.runNumber, paths: result.scopeDeviations.join(", ") }));
	const pendingRun = store.getPendingRun();
	const bestRun = findPromptBestRun(state);
	return renderAutoresearchIteratePrompt({
		baseSystemPrompt,
		goal: store.config.goal ?? mission?.objective ?? "",
		workingDir: cwd,
		branch: store.config.branch,
		baselineCommit: store.config.baselineCommit,
		metricName: state.metricName,
		metricUnit: state.metricUnit,
		notes: state.notes,
		currentSegment: state.currentSegment + 1,
		currentSegmentRunCount: current.length,
		baselineMetric: state.bestMetric,
		bestMetric: bestRun?.metric ?? state.bestMetric,
		bestRunNumber: bestRun?.runNumber ?? null,
		recentRuns,
		unjustifiedRuns,
		pendingRun: pendingRun
			? {
					runNumber: pendingRun.runNumber,
					command: pendingRun.command,
					parsedPrimary: pendingRun.metric,
					passed: pendingRun.exitCode === 0 && !pendingRun.timedOut,
				}
			: null,
	});
}

function summarizePromptAsi(asi: unknown): string | null {
	if (!asi || typeof asi !== "object") return null;
	const record = asi as Record<string, unknown>;
	const hypothesis = typeof record.hypothesis === "string" ? record.hypothesis.trim() : "";
	const rollback = typeof record.rollback_reason === "string" ? record.rollback_reason.trim() : "";
	const next = typeof record.next_action_hint === "string" ? record.next_action_hint.trim() : "";
	const summary = [hypothesis, rollback, next].filter(part => part.length > 0).join(" | ");
	return summary.length > 0 ? summary.slice(0, 220) : null;
}

function formatPromptMetricValue(value: number | null, unit: string): string {
	if (value === null) return `n/a${unit ? ` ${unit}` : ""}`;
	if (Number.isInteger(value)) return `${value}${unit}`;
	return `${value.toFixed(2)}${unit}`;
}

function findPromptBestRun(state: {
	results: Array<{ segment: number; status: string; metric: number | null; flagged: boolean; runNumber: number }>;
	currentSegment: number;
	bestDirection: "lower" | "higher";
}): { metric: number; runNumber: number } | null {
	let best: { metric: number; runNumber: number } | null = null;
	for (const result of state.results) {
		if (result.segment !== state.currentSegment || result.status !== "keep" || result.flagged) continue;
		if (result.metric === null) continue;
		if (!best || (state.bestDirection === "lower" ? result.metric < best.metric : result.metric > best.metric)) {
			best = { metric: result.metric, runNumber: result.runNumber };
		}
	}
	return best;
}
