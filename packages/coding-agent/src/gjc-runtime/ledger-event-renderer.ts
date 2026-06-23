/**
 * Pure parse + summarize for ledger-backed skill observability.
 *
 * Workflow progress for ultragoal/ralplan cannot be observed via subagent tool
 * events (those skills persist through `bash`-backed `gjc` CLI calls whose tool
 * `details` carry no structured payload). The durable source of truth is the
 * append-only ledgers:
 *   - ultragoal: `.gjc/ultragoal/ledger.jsonl`
 *   - ralplan:   `.gjc/plans/ralplan/<run-id>/index.jsonl`
 *
 * This module is I/O-free: callers read the files and pass lines or already-parsed
 * rows. It feeds the compact HUD chip builders in `skill-state/workflow-hud.ts`
 * via the runtime sync paths. Display-string helpers stay theme-free.
 */

/* ------------------------------- ultragoal ------------------------------- */

/** Minimal projection of an ultragoal ledger row used for the HUD chip. */
export interface UltragoalLedgerEventLite {
	/** Normalized from the row's `event` field, or `type` for reconcile rows. */
	event: string;
	goalId?: string;
	status?: string;
	timestamp?: string;
}

/**
 * Coerce an already-parsed ledger row into the lite shape. Accepts both the
 * `event`-keyed vocabulary (plan_created, goal_started, goal_checkpointed,
 * steering_accepted/rejected, review_blockers_recorded) and the `type`-keyed
 * reconcile-failure row (`type: "reconcile_failed"`). Returns undefined when no
 * event/type discriminator is present.
 */
export function coerceUltragoalLedgerEvent(row: Record<string, unknown>): UltragoalLedgerEventLite | undefined {
	const event = typeof row.event === "string" ? row.event : typeof row.type === "string" ? row.type : undefined;
	if (!event) return undefined;
	const lite: UltragoalLedgerEventLite = { event };
	if (typeof row.goalId === "string") lite.goalId = row.goalId;
	if (typeof row.status === "string") lite.status = row.status;
	if (typeof row.timestamp === "string") lite.timestamp = row.timestamp;
	return lite;
}

/** Parse a single ultragoal ledger JSONL line; undefined for blank/malformed lines. */
export function parseUltragoalLedgerLine(line: string): UltragoalLedgerEventLite | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let row: unknown;
	try {
		row = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
	return coerceUltragoalLedgerEvent(row as Record<string, unknown>);
}

/** The most recent event, or undefined when the ledger is empty. */
export function latestUltragoalLedgerEvent(
	events: readonly UltragoalLedgerEventLite[],
): UltragoalLedgerEventLite | undefined {
	return events.length > 0 ? events[events.length - 1] : undefined;
}

/**
 * Best-effort latest event from raw ledger text: parses line-by-line and skips
 * blank/malformed rows so a torn or hand-edited ledger never throws on the HUD
 * path. Strict receipt consumers should keep using the validating reader.
 */
export function latestUltragoalLedgerEventFromText(text: string): UltragoalLedgerEventLite | undefined {
	const events: UltragoalLedgerEventLite[] = [];
	for (const line of text.split(/\r?\n/)) {
		const event = parseUltragoalLedgerLine(line);
		if (event) events.push(event);
	}
	return latestUltragoalLedgerEvent(events);
}

/* -------------------------------- ralplan -------------------------------- */

/** Minimal projection of a ralplan `index.jsonl` row. */
export interface RalplanIndexRow {
	stage: string;
	stageN?: number;
}

/** Stages that open a new consensus iteration when they appear in append order. */
const RALPLAN_ITERATION_OPENERS = new Set(["planner", "revision"]);

const RALPLAN_STAGE_CODES: Record<string, string> = {
	planner: "P",
	revision: "R",
	architect: "A",
	critic: "C",
	adr: "D",
	"post-interview": "I",
	final: "F",
};

const DEFAULT_STAGE_PRESENCE_CAP = 6;

/** Parse a single ralplan index JSONL line; undefined for blank/malformed lines. */
export function parseRalplanIndexLine(line: string): RalplanIndexRow | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let row: unknown;
	try {
		row = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
	const record = row as Record<string, unknown>;
	if (typeof record.stage !== "string") return undefined;
	const out: RalplanIndexRow = { stage: record.stage };
	if (typeof record.stage_n === "number") out.stageN = record.stage_n;
	return out;
}

export interface RalplanIndexSummary {
	/** Number of consensus iterations (planner/revision boundaries), >= 0. */
	iteration: number;
	/** Stage names present in the current (latest) iteration, in append order. */
	currentStages: string[];
}

/**
 * Derive iteration count and current-iteration stage presence from index rows.
 *
 * `stage_n` is NOT used as the iteration key: it is stored verbatim per row and a
 * single planner/architect/critic pass can span multiple stage_n values. Instead,
 * a `planner` or `revision` row opens a new iteration and subsequent rows attach
 * to it. No verdict is derived here (index rows carry none).
 */
export function summarizeRalplanIndex(rows: readonly RalplanIndexRow[]): RalplanIndexSummary {
	let iteration = 0;
	let currentStages: string[] = [];
	for (const row of rows) {
		if (RALPLAN_ITERATION_OPENERS.has(row.stage)) {
			iteration += 1;
			currentStages = [row.stage];
		} else {
			if (iteration === 0) iteration = 1;
			currentStages.push(row.stage);
		}
	}
	return { iteration, currentStages };
}

/**
 * Compact, theme-free presence string for the ralplan `stages` chip, e.g.
 * `P·A·C`. Collapses past `cap` with a "… N more" suffix. Returns undefined when
 * there are no stages.
 */
export function formatRalplanStagePresence(
	stages: readonly string[],
	cap = DEFAULT_STAGE_PRESENCE_CAP,
): string | undefined {
	if (stages.length === 0) return undefined;
	const codes = stages.map(stage => RALPLAN_STAGE_CODES[stage] ?? stage.charAt(0).toUpperCase());
	if (codes.length <= cap) return codes.join("·");
	const shown = codes.slice(0, cap).join("·");
	const remaining = codes.length - cap;
	return `${shown} … ${remaining} more ${remaining === 1 ? "stage" : "stages"}`;
}
