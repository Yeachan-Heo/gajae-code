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
	removeFileAudited,
	writeGuardedJsonAtomic,
} from "./state-writer";
import { CommandError, flagValue, hasFlag } from "./workflow-cli-common";

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
}

export interface AutoresearchPaths {
	dir: string;
	missionPath: string;
	ledgerPath: string;
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
		sessionId?.trim() ||
		resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const dir = sessionAutoresearchDir(cwd, resolvedSessionId);
	return {
		dir,
		missionPath: path.join(dir, "mission.json"),
		ledgerPath: path.join(dir, "ledger.jsonl"),
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
		return normalizeAutoresearchMission(await Bun.file(getAutoresearchPaths(cwd, resolvedSessionId).missionPath).json());
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

export async function readAutoresearchLedger(cwd: string, sessionId?: string | null): Promise<AutoresearchLedgerEvent[]> {
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
		sessionId?.trim() ||
		resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
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
		expectedRevision:
			existingRead.kind === "valid" ? persistedStateRevision(existingRead.value) : undefined,
		audit: {
			category: "state",
			verb: "write",
			owner: "gjc-runtime",
			skill: "autoresearch",
			sessionId: input.sessionId,
		},
	});
	await writeSessionActivityMarker(input.cwd, input.sessionId, { writer: "autoresearch-runtime", path: paths.missionPath });
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
	};
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
}): Promise<AutoresearchWriteReceipt> {
	const objective = input.objective.trim();
	if (!objective) throw new AutoresearchCommandError(2, "autoresearch mission objective is required");
	const slug = input.slug.trim();
	if (!slug) throw new AutoresearchCommandError(2, "autoresearch mission slug is required");
	// AC-16: hard fail at the write boundary; mode is never inferred.
	assertAutoresearchMode(input.mode, "write intake");
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

/** clear verb: remove the mission artifact and record the kernel clear in the ledger. */
export async function autoresearchClear(cwd: string, sessionId?: string | null): Promise<AutoresearchClearReceipt> {
	const resolvedSessionId =
		sessionId?.trim() ||
		resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const paths = getAutoresearchPaths(cwd, resolvedSessionId);
	const existing = await readAutoresearchMission(cwd, resolvedSessionId);
	const deleted = await removeFileAudited(paths.missionPath, {
		cwd,
		audit: {
			category: "prune",
			verb: "remove",
			owner: "gjc-runtime",
			skill: "autoresearch",
			sessionId: resolvedSessionId,
		},
	});
	const ledgerEvent = await appendAutoresearchLedger(
		cwd,
		{ event: "kernel_cleared", slug: existing?.slug ?? "" },
		resolvedSessionId,
	);
	return { ok: true, cleared: deleted.deleted, missionPath: paths.missionPath, ledgerEvent };
}

/* --------------------------- handoff intake --------------------------- */

const AUTORESEARCH_MODE_DECLARATION_RE = /^(?:[-*]\s+)?autoresearch-mode\s*:\s*(web|mixed|data)\s*$/i;
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
		throw new AutoresearchCommandError(2, "autoresearch handoff intake could not derive a mission slug from the spec");
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
	return appendAutoresearchLedger(
		input.cwd,
		{
			event: "run_logged",
			run_id: runId,
			status,
			description,
			...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
			...(typeof input.metric === "number" && Number.isFinite(input.metric) ? { metric: input.metric } : {}),
		},
		input.sessionId,
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
	const receipt: AutoresearchVerdictReceipt = {
		receiptId: crypto.randomUUID(),
		status: input.status,
		evidence,
		caveats,
		evaluator,
		issuedAt: new Date().toISOString(),
		...(input.criticReceipt ? { criticReceipt: input.criticReceipt } : {}),
	};
	await appendAutoresearchLedger(
		input.cwd,
		{
			event: "verdict_issued",
			...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
			verdictReceipt: receipt,
		},
		input.sessionId,
	);
	return receipt;
}

/* ------------------------------ CLI dispatch ------------------------------ */

function renderAutoresearchHelp(): string {
	return [
		"Run native GJC Autoresearch workflow commands",
		"",
		"USAGE",
		"  $ gjc autoresearch [--spec <path>] [--json] [goal...]",
		"",
		"INTAKE",
		"  --spec=<path>    Handoff intake: read a persisted deep-interview spec and start research",
		"                   with zero clarification questions. The spec must declare its mission",
		"                   mode explicitly (a line like `autoresearch-mode: web`).",
		"  positional goal  Cold intake: signals that goal/constraints/deliverables clarification",
		"                   must run before research begins.",
		"  bare invocation  Cold intake (no goal text).",
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
async function reconcileAutoresearchState(cwd: string, mission: AutoresearchMission, sessionId?: string): Promise<void> {
	const resolvedSessionId =
		sessionId?.trim() ||
		resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	try {
		await syncSkillActiveState({
			cwd,
			skill: "autoresearch",
			active: true,
			phase: "mission",
			sessionId: resolvedSessionId,
			source: "gjc-autoresearch-native",
			hud: {
				version: 1,
				summary: `autoresearch mission ${mission.slug}`,
				chips: [
					{ label: "mode", value: mission.mode },
					{ label: "intake", value: mission.intake },
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
