/**
 * Resident-session inventory for master mode: an authoritative, credential-free
 * snapshot of the sessions the SDK broker currently indexes, plus the pure
 * classification helpers the master session's supervision semantics rest on.
 *
 * The broker session index is the only discovery authority — no pane scraping,
 * no process guessing. Rows that cannot prove unique authority (`ambiguous`,
 * `terminalUncertain`) classify as `blocked` and are strictly hands-off.
 */
import { ensureBroker } from "../sdk/broker/ensure";
import { type SdkSessionRowV1, toSessionRowV1 } from "../sdk/cli/rows";
import { SessionRouter } from "../sdk/router";
import { sessionListPageFromResponse, traverseSessionList } from "../sdk/session-list";

/** Broker classification of one resident session, derivable from its row alone. */
export type ResidentSessionClass = "blocked" | "terminal" | "stuck" | "active" | "idle";

/** Default age after which a session reporting an active turn counts as stuck. */
export const MASTER_STUCK_THRESHOLD_MS = 15 * 60 * 1000;

/** Cap on rendered inventory rows so the session-start injection stays bounded. */
export const MASTER_INVENTORY_ROW_LIMIT = 50;

export class MasterInventoryError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "MasterInventoryError";
		this.code = code;
	}
}

/**
 * Classify one broker row. Pure and deterministic: the same row and `now`
 * always produce the same class. `blocked` dominates everything — ambiguous or
 * terminally uncertain authority means no mutating control may target the row.
 */
export function classifyResidentSession(
	row: Pick<SdkSessionRowV1, "live" | "ambiguous" | "terminalUncertain" | "activity" | "lastHeartbeatAt" | "deleted">,
	now: number,
	stuckThresholdMs: number = MASTER_STUCK_THRESHOLD_MS,
): ResidentSessionClass {
	if (row.ambiguous === true || row.terminalUncertain === true) return "blocked";
	if (row.deleted === true || !row.live) return "terminal";
	if (row.activity?.state === "active") {
		const activeAt = row.lastHeartbeatAt ?? row.activity.at;
		if (Number.isFinite(activeAt) && now - activeAt > stuckThresholdMs) return "stuck";
		return "active";
	}
	return "idle";
}

/** Fine-grained per-session probe state, obtained through SDK queries only. */
export interface SupervisionProbe {
	/** goal.list/get reports an active goal/objective. */
	hasGoal: boolean;
	/** workflow.gates.list reports a pending gate. */
	pendingGate: boolean;
	/** A pending ask/question is outstanding for the session. */
	pendingAsk: boolean;
}

export type SupervisionClass = ResidentSessionClass | "idle_no_goal" | "question" | "gate";

/**
 * Combine the broker-row class with authoritative per-session probe results.
 * Blocked stays blocked; active/stuck sessions are never reclassified by
 * probes (their turn owns the session); only idle sessions refine into
 * question/gate/idle_no_goal, which drive answer vs. fresh-prompt decisions.
 */
export function classifySupervisionTarget(row: ResidentSessionClass, probe: SupervisionProbe): SupervisionClass {
	if (row !== "idle") return row;
	if (probe.pendingAsk) return "question";
	if (probe.pendingGate) return "gate";
	if (!probe.hasGoal) return "idle_no_goal";
	return "idle";
}

export interface ResidentSessionInventory {
	fetchedAt: number;
	sessions: SdkSessionRowV1[];
}

const ROUTER_START_TIMEOUT_MS = 10_000;
const ROUTER_STOP_TIMEOUT_MS = 5_000;
const MASTER_INVENTORY_ACTOR_KEY = "gjc-master:session.list";

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new MasterInventoryError("timeout", message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Load the authoritative resident-session inventory from the SDK broker.
 * Rows are projected through the credential-free v1 DTO mapper; this function
 * never exposes endpoint credentials. Broker failures throw MasterInventoryError
 * so callers can fail closed instead of supervising from a partial snapshot.
 */
export async function loadResidentSessionInventory(
	agentDir: string,
	now: () => number = Date.now,
): Promise<ResidentSessionInventory> {
	await bounded(ensureBroker({ agentDir }), ROUTER_START_TIMEOUT_MS, "SDK broker startup timed out.");
	const router = new SessionRouter({ agentDir });
	let actionError: unknown;
	let sessions: SdkSessionRowV1[] = [];
	try {
		await bounded(router.start(), ROUTER_START_TIMEOUT_MS, "SDK session Router startup timed out.");
		const pages = await traverseSessionList(
			{},
			async pageInput => {
				const response = await router.listBrokerSessions(pageInput, MASTER_INVENTORY_ACTOR_KEY);
				if (response?.ok === false) {
					const failure = response.error as { code?: unknown; message?: unknown } | undefined;
					throw new MasterInventoryError(
						typeof failure?.code === "string" ? failure.code : "broker_error",
						typeof failure?.message === "string" ? failure.message : "session.list failed",
					);
				}
				return response;
			},
			response => sessionListPageFromResponse(response),
		);
		try {
			sessions = pages.flatMap(({ page }) => page.sessions.map(toSessionRowV1));
		} catch {
			throw new MasterInventoryError("protocol_error", "session.list returned a malformed session row.");
		}
	} catch (error) {
		actionError = error;
	}
	try {
		await bounded(router.stop(), ROUTER_STOP_TIMEOUT_MS, "SDK session Router shutdown timed out.");
	} catch {
		// Router cleanup failure must not mask the inventory result or its error.
	}
	if (actionError !== undefined) {
		if (actionError instanceof MasterInventoryError) throw actionError;
		throw new MasterInventoryError(
			"unavailable",
			actionError instanceof Error ? actionError.message : "Failed to load the resident-session inventory.",
		);
	}
	return { fetchedAt: now(), sessions };
}

function formatRow(row: SdkSessionRowV1, cls: ResidentSessionClass, selfSessionId: string | undefined): string {
	const parts = [
		`session=${row.sessionId}`,
		`repo=${row.locator.repo}`,
		`class=${cls}`,
		`live=${row.live}`,
		`endpointGeneration=${row.endpointGeneration}`,
	];
	if (row.hostIncarnation !== undefined) parts.push(`hostIncarnation=${row.hostIncarnation}`);
	if (row.activity !== undefined)
		parts.push(`activity=${row.activity.state}@${new Date(row.activity.at).toISOString()}`);
	if (row.sessionId === selfSessionId) parts.push("(this master session — do not supervise yourself)");
	if (cls === "blocked") parts.push("HANDS-OFF: authority is ambiguous/uncertain");
	return `- ${parts.join(" ")}`;
}

/**
 * Render a bounded Markdown inventory for the session-start injection. The
 * output is deterministic for a fixed `now` and never contains credentials.
 */
export function renderInventoryMarkdown(
	inventory: ResidentSessionInventory,
	selfSessionId: string | undefined,
	now: number,
	stuckThresholdMs: number = MASTER_STUCK_THRESHOLD_MS,
): string {
	const lines: string[] = [
		`Snapshot taken at ${new Date(inventory.fetchedAt).toISOString()} from the SDK broker session index.`,
		`Re-run \`gjc sdk session list\` before any mutating action; this snapshot goes stale immediately.`,
		"",
	];
	if (inventory.sessions.length === 0) {
		lines.push("No resident sessions are currently indexed by the broker.");
		return lines.join("\n");
	}
	const rows = inventory.sessions.slice(0, MASTER_INVENTORY_ROW_LIMIT);
	for (const row of rows) {
		lines.push(formatRow(row, classifyResidentSession(row, now, stuckThresholdMs), selfSessionId));
	}
	if (inventory.sessions.length > rows.length) {
		lines.push(
			`- …and ${inventory.sessions.length - rows.length} more; run \`gjc sdk session list\` for the full set.`,
		);
	}
	return lines.join("\n");
}
