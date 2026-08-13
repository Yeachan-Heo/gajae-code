/**
 * Resident-session inventory for master mode: an authoritative, credential-free
 * snapshot of the sessions the SDK broker currently indexes, plus the pure
 * classification helpers the master session's supervision semantics rest on.
 *
 * The broker session index is the only discovery authority — no pane scraping,
 * no process guessing. Two fail-closed rules are load-bearing:
 *
 * 1. Only an explicit broker tombstone (`deleted`) proves `terminal`. A
 *    non-live row (missing/stale heartbeat, broker restart, dead host — the
 *    index cannot distinguish them) is `unknown` and strictly hands-off.
 * 2. Turn state (active/idle/stuck) is NEVER derived from liveness heartbeats.
 *    The broker row proves liveness only; turn state requires an authoritative
 *    per-session SDK query, modeled here as an explicit SupervisionProbe.
 */

import { randomUUID } from "node:crypto";
import { ensureBroker } from "../sdk/broker/ensure";
import { type SdkSessionRowV1, toSessionRowV1 } from "../sdk/cli/rows";
import { SessionRouter } from "../sdk/router";
import { sessionListPageFromResponse } from "../sdk/session-list";
import { escapePromptMetadata } from "../session/messages";

/**
 * Broker-row classification of one resident session.
 * - `blocked`: ambiguous or terminal-uncertain authority; hands-off.
 * - `terminal`: explicit broker deletion tombstone; eligible for retirement.
 * - `live`: proven live host; turn state still unknown without a probe.
 * - `unknown`: not proven live and not proven terminal; hands-off.
 */
export type ResidentSessionClass = "blocked" | "terminal" | "live" | "unknown";

/** Cap on loaded and rendered inventory rows so supervision context stays bounded. */
export const MASTER_INVENTORY_ROW_LIMIT = 50;

/** Per-field cap for broker-controlled strings rendered into LLM context. */
export const MASTER_INVENTORY_FIELD_MAX_CHARS = 120;

export class MasterInventoryError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "MasterInventoryError";
		this.code = code;
	}
}

/**
 * Classify one broker row. Pure and deterministic: the same row always
 * produces the same class. No timestamps are consulted — a stale heartbeat is
 * indistinguishable from a broker restart, so non-live rows degrade to
 * `unknown` (hands-off), never to a fabricated `terminal`/`stuck` verdict.
 */
export function classifyResidentSession(
	row: Pick<SdkSessionRowV1, "live" | "ambiguous" | "terminalUncertain" | "deleted"> & { activity?: unknown },
): ResidentSessionClass {
	if (row.ambiguous === true || row.terminalUncertain === true) return "blocked";
	if (row.deleted === true) return "terminal";
	if (
		row.activity !== undefined &&
		(typeof row.activity !== "object" ||
			row.activity === null ||
			!("state" in row.activity) ||
			!(["active", "idle"] as unknown[]).includes(row.activity.state) ||
			!("at" in row.activity) ||
			typeof row.activity.at !== "number" ||
			!Number.isFinite(row.activity.at))
	)
		return "unknown";
	if (row.live === true) return "live";
	return "unknown";
}

/**
 * Fine-grained per-session probe state, obtained only through authoritative
 * per-session SDK queries (goal state, gates, asks, live turn state).
 */
export interface SupervisionProbe {
	/** goal.list/get reports an active goal/objective. */
	hasGoal: boolean;
	/** workflow.gates.list reports a pending gate. */
	pendingGate: boolean;
	/** A pending ask/question is outstanding for the session. */
	pendingAsk: boolean;
	/** Authoritative per-session state reports an in-flight turn. */
	turnActive: boolean;
}

export type SupervisionClass = ResidentSessionClass | "active" | "idle" | "idle_no_goal" | "question" | "gate";

/**
 * Combine the broker-row class with authoritative per-session probe results.
 * Blocked/terminal/unknown rows are never reclassified by probes. Only a
 * proven-live row refines into active/idle/question/gate/idle_no_goal, which
 * drive steer-vs-prompt and answer decisions.
 */
export function classifySupervisionTarget(row: ResidentSessionClass, probe: SupervisionProbe): SupervisionClass {
	if (row !== "live") return row;
	if (probe.turnActive) return "active";
	if (probe.pendingAsk) return "question";
	if (probe.pendingGate) return "gate";
	if (!probe.hasGoal) return "idle_no_goal";
	return "idle";
}

export interface ResidentSessionInventory {
	fetchedAt: number;
	sessions: SdkSessionRowV1[];
	/** True when the broker index holds more rows than the bounded load returned. */
	truncated: boolean;
}

const BROKER_REQUEST_TIMEOUT_MS = 10_000;
const MASTER_INVENTORY_ACTOR_KEY = "gjc-master:session.list";

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	const deferred = Promise.withResolvers<never>();
	let timer: NodeJS.Timeout | undefined;
	try {
		timer = setTimeout(() => deferred.reject(new MasterInventoryError("timeout", message)), timeoutMs);
		return await Promise.race([promise, deferred.promise]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Load a bounded authoritative resident-session inventory from the SDK broker:
 * exactly one `session.list` page capped at MASTER_INVENTORY_ROW_LIMIT + 1 rows
 * (the extra row only detects truncation). Rows are projected through the
 * credential-free v1 DTO mapper; endpoint credentials are never exposed.
 * Broker failures throw MasterInventoryError so callers fail closed instead of
 * supervising from a partial snapshot.
 */
export async function loadResidentSessionInventory(
	agentDir: string,
	now: () => number = Date.now,
): Promise<ResidentSessionInventory> {
	await bounded(ensureBroker({ agentDir }), BROKER_REQUEST_TIMEOUT_MS, "SDK broker startup timed out.");
	const router = new SessionRouter({ agentDir });
	try {
		const response = await bounded(
			router.listBrokerSessions(
				{ limit: MASTER_INVENTORY_ROW_LIMIT },
				`${MASTER_INVENTORY_ACTOR_KEY}:${randomUUID()}`,
			),
			BROKER_REQUEST_TIMEOUT_MS,
			"SDK broker session.list timed out.",
		);
		if (response?.ok === false) {
			const failure = response.error as { code?: unknown; message?: unknown } | undefined;
			throw new MasterInventoryError(
				typeof failure?.code === "string" ? failure.code : "broker_error",
				typeof failure?.message === "string" ? failure.message : "session.list failed",
			);
		}
		const page = sessionListPageFromResponse(response);
		if (!page) throw new MasterInventoryError("protocol_error", "session.list returned a malformed page.");
		let rows: SdkSessionRowV1[];
		try {
			rows = page.sessions.map(toSessionRowV1);
		} catch {
			throw new MasterInventoryError("protocol_error", "session.list returned a malformed session row.");
		}
		return { fetchedAt: now(), sessions: rows, truncated: page.continuationCursor !== undefined };
	} catch (error) {
		if (error instanceof MasterInventoryError) throw error;
		throw new MasterInventoryError(
			"unavailable",
			error instanceof Error ? error.message : "Failed to load the resident-session inventory.",
		);
	}
}

/** Neutralize broker-controlled strings before they enter LLM context. */
function safeField(value: string): string {
	const escaped = escapePromptMetadata(value);
	return escaped.length > MASTER_INVENTORY_FIELD_MAX_CHARS
		? `${escaped.slice(0, MASTER_INVENTORY_FIELD_MAX_CHARS)}…`
		: escaped;
}

function formatRow(row: SdkSessionRowV1, cls: ResidentSessionClass, selfSessionId: string | undefined): string {
	const parts = [
		`session=${safeField(row.sessionId)}`,
		`repo=${safeField(row.locator.repo)}`,
		`class=${cls}`,
		`live=${row.live}`,
		`endpointGeneration=${row.endpointGeneration}`,
	];
	if (row.hostIncarnation !== undefined) parts.push(`hostIncarnation=${safeField(row.hostIncarnation)}`);
	if (row.sessionId === selfSessionId) parts.push("(this master session — do not supervise yourself)");
	if (cls === "blocked") parts.push("HANDS-OFF: authority is ambiguous/uncertain");
	if (cls === "unknown") parts.push("HANDS-OFF: not proven live or terminal");
	return `- ${parts.join(" ")}`;
}

/**
 * Render a bounded Markdown inventory for the session-start injection. The
 * output is deterministic, credential-free, and field-sanitized. Turn state is
 * deliberately absent: it is not knowable from broker rows.
 */
export function renderInventoryMarkdown(
	inventory: ResidentSessionInventory,
	selfSessionId: string | undefined,
): string {
	const lines: string[] = [
		`Snapshot taken at ${new Date(inventory.fetchedAt).toISOString()} from the SDK broker session index.`,
		"Re-run `gjc sdk session list` before any mutating action; this snapshot goes stale immediately.",
		"`live` proves only that the host was reachable; query the session itself (goal state, gates, turn state) before classifying its work.",
		"",
	];
	if (inventory.sessions.length === 0) {
		lines.push("No resident sessions are currently indexed by the broker.");
		return lines.join("\n");
	}
	for (const row of inventory.sessions) {
		lines.push(formatRow(row, classifyResidentSession(row), selfSessionId));
	}
	if (inventory.truncated) {
		lines.push("- …truncated; run `gjc sdk session list` for the full set.");
	}
	return lines.join("\n");
}
