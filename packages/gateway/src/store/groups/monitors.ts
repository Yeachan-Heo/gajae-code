import {
	type MonitorEventRecovery,
	type MonitorProtocolFailureRecord,
	PROTOCOL_FAILURE_REASONS,
	type ProtocolFailureReason,
} from "@gajae-gateway/protocol";
import type { GroupDb, StoreCore } from "../core";
import type { WriteTx } from "../tx";

/** Durable cron catch-up diagnostics for one monitor (issue #157), stored in `meta`. */
export interface MonitorCronState {
	/** Newest slot refused under policy; the cursor never re-considers it. */
	readonly cursor: string;
	/** Slots refused under policy over the monitor's lifetime. */
	readonly skippedTotal: number;
	readonly lastSkip: {
		readonly count: number;
		readonly oldest: string;
		readonly newest: string;
		readonly recordedAt: string;
	};
}

/** A scheduled cron slot the gateway claimed or fired for one monitor. */
export interface MonitorSlotRow {
	readonly monitor_id: string;
	readonly slot_at: string;
	readonly created_at: string;
}

/** Public-safe dispatch failure evidence (never a raw error body). */
export interface MonitorFailureRow {
	readonly event_id: string;
	readonly code: string;
	readonly detail: string;
	readonly failed_at: string;
	readonly protocol_reason: ProtocolFailureReason | null;
	readonly response_byte_length: number | null;
	readonly response_entry_count: number | null;
}

export interface RecentMonitorFailureRow {
	readonly event_id: string;
	readonly monitor_id: string;
	readonly event_type: string;
	readonly stage: string;
	readonly code: string;
	readonly detail: string;
	readonly failed_at: string;
}

export interface MonitorFailureOptions {
	readonly protocolFailure?: Pick<MonitorProtocolFailureRecord, "reason" | "responseByteLength" | "responseEntryCount">;
}

/**
 * Durable monitor-event stage contract (fail-closed). `eventUpdate` rejects any
 * stage outside this set, so a typo or corrupt write cannot invent a state the
 * recovery logic does not know how to reclaim.
 *
 * - admitted: durable row exists, not yet claimed by a dispatch.
 * - batched: claimed by a dispatch awaiting its authoring turn (a live stage,
 *   minutes at most) or stranded there by a crash mid-dispatch.
 * - dispatched: authoring turn sent, output not yet parsed.
 * - authored: note authored; delivery to the target is pending or settled.
 * - delivered: the batch's ledger delivery was confirmed by the adapter.
 * - authored_no_delivery: terminal — nothing will ever be delivered: the
 *   monitor has no channel target and no owner target is configured, or the
 *   authored note is a silence token. Explicit instead of `authored`-forever
 *   so the operator sees a finished state.
 * - failed_no_retry also covers an authored note whose delivery expired
 *   (`monitor_failures` code `delivery_expired`).
 * - failed: the last dispatch attempt failed; reconcile redispatches.
 * - failed_no_retry: dispatch failed and reconcile will not retry it again
 *   (reclaim budget exhausted); operator-visible terminal state.
 * - skipped: terminal — the monitor's overlap policy is `skip` and an earlier
 *   event of the same monitor was still awaiting authoring when this one
 *   fired (`skipped_by` names it). A scheduling outcome, never a failure.
 * - contract_unmet: terminal — the authored note only restated the contract
 *   and provided no new evidence of work.
 */
export const MONITOR_EVENT_STAGES = [
	"admitted",
	"batched",
	"dispatched",
	"authored",
	"delivered",
	"authored_no_delivery",
	"failed",
	"failed_no_retry",
	"skipped",
	"contract_unmet",
] as const;
export type MonitorEventStage = (typeof MONITOR_EVENT_STAGES)[number];
/** Stages whose rows reconcile() may claim and redispatch. */
export const RECONCILABLE_STAGES: readonly MonitorEventStage[] = ["admitted", "batched", "dispatched", "failed"];
/** Terminal stages: no further transition will ever happen without operator action. */
export const TERMINAL_STAGES: readonly MonitorEventStage[] = [
	"delivered",
	"authored_no_delivery",
	"failed_no_retry",
	"skipped",
	"contract_unmet",
];

/** Minimum wait, measured from the last failure, before reconcile reclaims the next attempt. */
export const MONITOR_EVENT_RETRY_BACKOFF_MS: readonly number[] = [
	0,
	10 * 60_000,
	60 * 60_000,
	4 * 60 * 60_000,
	12 * 60 * 60_000,
];
/** Upper bound on how often a single event may be reclaimed by reconcile. */
export const MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS = MONITOR_EVENT_RETRY_BACKOFF_MS.length;
/** Reap open events unchanged for a full day, measured from their last update. */
export const MONITOR_EVENT_MAX_OPEN_AGE_MS = 24 * 60 * 60_000;

export interface MonitorEventDbRow {
	readonly event_id: string;
	readonly monitor_id: string;
	readonly event_type: string;
	readonly payload_json: string;
	readonly fired_at: string;
	readonly stage: string;
	readonly batch_id: string | null;
	readonly dispatch_attempts: number;
	readonly skipped_by: string | null;
	readonly updated_at: string;
	readonly procedure_json: string | null;
}

const REPLAYABLE_MONITOR =
	"NOT EXISTS (SELECT 1 FROM broker_quarantine q WHERE q.kind = 'monitor' AND q.subject_id = monitor_events.event_id)";
const OPEN_MONITOR_EVENT =
	"stage NOT IN ('delivered','authored_no_delivery','failed_no_retry','skipped','contract_unmet')";
const TERMINAL_MONITOR_EVENT =
	"stage IN ('delivered','authored_no_delivery','failed_no_retry','skipped','contract_unmet')";
const IN_FLIGHT_MONITOR_STAGES = "'admitted','batched','dispatched','failed'";

/** Persistence for monitor definitions, event dispatch, authored output and cron slots. */
export class MonitorsGroup {
	readonly #core: StoreCore;
	readonly #db: GroupDb;

	constructor(core: StoreCore) {
		this.#core = core;
		this.#db = core.groupDb("monitors");
	}

	openCount(): number {
		return (
			(
				this.#db
					.prepare(`SELECT COUNT(*) AS n FROM monitor_events WHERE ${OPEN_MONITOR_EVENT} AND ${REPLAYABLE_MONITOR}`)
					.get() as { n: number } | null
			)?.n ?? 0
		);
	}

	eventStageCounts(): Array<{ stage: string; n: number }> {
		return this.#db.prepare("SELECT stage, COUNT(*) AS n FROM monitor_events GROUP BY stage").all() as Array<{
			stage: string;
			n: number;
		}>;
	}

	unquarantinedEventTypes(): Array<{ monitor_id: string; event_type: string; event_types_json: string | null }> {
		return this.#db
			.prepare(
				"SELECT DISTINCT e.monitor_id, e.event_type, m.event_types_json FROM monitor_events e LEFT JOIN monitors m ON m.monitor_id = e.monitor_id WHERE NOT EXISTS (SELECT 1 FROM broker_quarantine q WHERE q.kind = 'monitor' AND q.subject_id = e.event_id)",
			)
			.all() as Array<{ monitor_id: string; event_type: string; event_types_json: string | null }>;
	}

	authoringLossStreaks(sinceIso: string): Array<{ eventType: string; consecutive: number; lastFiredAt: string }> {
		const rows = this.#db
			.prepare(
				`SELECT event_type, fired_at, (stage = 'failed_no_retry' AND NOT EXISTS (SELECT 1 FROM authored_outputs a WHERE a.event_id = monitor_events.event_id)) AS lost FROM monitor_events WHERE stage IN ('delivered','authored_no_delivery','failed_no_retry','contract_unmet') AND fired_at >= ? AND ${REPLAYABLE_MONITOR} ORDER BY fired_at DESC, rowid DESC`,
			)
			.all(sinceIso) as Array<{ event_type: string; fired_at: string; lost: number }>;
		const streaks = new Map<string, { consecutive: number; lastFiredAt: string; open: boolean }>();
		for (const row of rows) {
			const streak = streaks.get(row.event_type);
			if (!streak) {
				streaks.set(row.event_type, { consecutive: row.lost ? 1 : 0, lastFiredAt: row.fired_at, open: !!row.lost });
			} else if (streak.open) {
				if (row.lost) streak.consecutive++;
				else streak.open = false;
			}
		}
		return [...streaks]
			.filter(([, streak]) => streak.consecutive > 0)
			.map(([eventType, { consecutive, lastFiredAt }]) => ({ eventType, consecutive, lastFiredAt }))
			.sort((a, b) => a.eventType.localeCompare(b.eventType));
	}

	consecutiveTerminalFailures(limit = 100): number {
		const rows = this.#db
			.prepare(
				`SELECT stage FROM monitor_events WHERE stage IN ('delivered','authored_no_delivery','failed_no_retry','contract_unmet') AND ${REPLAYABLE_MONITOR} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
			)
			.all(limit) as Array<{ stage: string }>;
		const streak = rows.findIndex((row) => row.stage !== "failed_no_retry" && row.stage !== "contract_unmet");
		return streak < 0 ? rows.length : streak;
	}

	create(
		tx: WriteTx,
		row: {
			id: string;
			name: string;
			triggerJson: string;
			eventTypesJson: string;
			burstPolicy: string;
			overlap?: string;
			channelTargetJson: string | null;
			enabled: boolean;
			instruction: string | null;
			modelJson: string | null;
			serviceTier: string | null;
			procedureFilesJson?: string | null;
		},
	): void {
		this.#db
			.prepare(
				"INSERT INTO monitors (monitor_id, name, trigger_json, event_types_json, burst_policy, overlap, channel_target_json, enabled, created_at, instruction, model_json, service_tier, procedure_files_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				tx,
				row.id,
				row.name,
				row.triggerJson,
				row.eventTypesJson,
				row.burstPolicy,
				row.overlap ?? "queue",
				row.channelTargetJson,
				row.enabled ? 1 : 0,
				new Date().toISOString(),
				row.instruction,
				row.modelJson,
				row.serviceTier,
				row.procedureFilesJson ?? null,
			);
	}

	rows(): Array<{
		monitor_id: string;
		name: string;
		trigger_json: string;
		event_types_json: string;
		burst_policy: string;
		overlap: string;
		channel_target_json: string | null;
		enabled: number;
		created_at: string;
		instruction: string | null;
		model_json: string | null;
		service_tier: string | null;
		procedure_files_json: string | null;
	}> {
		return this.#db
			.prepare(
				"SELECT monitor_id, name, trigger_json, event_types_json, burst_policy, overlap, channel_target_json, enabled, created_at, instruction, model_json, service_tier, procedure_files_json FROM monitors ORDER BY created_at",
			)
			.all() as Array<{
			monitor_id: string;
			name: string;
			trigger_json: string;
			event_types_json: string;
			burst_policy: string;
			overlap: string;
			channel_target_json: string | null;
			enabled: number;
			created_at: string;
			instruction: string | null;
			model_json: string | null;
			service_tier: string | null;
			procedure_files_json: string | null;
		}>;
	}

	/** The stored channel target JSON; `undefined` when no such monitor exists. */
	channelTargetJson(monitorId: string): string | null | undefined {
		const row = this.#db.prepare("SELECT channel_target_json FROM monitors WHERE monitor_id = ?").get(monitorId) as {
			channel_target_json: string | null;
		} | null;
		return row ? row.channel_target_json : undefined;
	}

	update(
		tx: WriteTx,
		row: {
			id: string;
			name: string;
			triggerJson: string;
			eventTypesJson: string;
			burstPolicy: string;
			channelTargetJson: string | null;
			enabled: boolean;
			instruction: string | null;
			modelJson: string | null;
			serviceTier: string | null;
			procedureFilesJson: string | null;
		},
	): boolean {
		return (
			this.#db
				.prepare(
					"UPDATE monitors SET name = ?, trigger_json = ?, event_types_json = ?, burst_policy = ?, channel_target_json = ?, enabled = ?, instruction = ?, model_json = ?, service_tier = ?, procedure_files_json = ? WHERE monitor_id = ?",
				)
				.run(
					tx,
					row.name,
					row.triggerJson,
					row.eventTypesJson,
					row.burstPolicy,
					row.channelTargetJson,
					row.enabled ? 1 : 0,
					row.instruction,
					row.modelJson,
					row.serviceTier,
					row.procedureFilesJson,
					row.id,
				).changes > 0
		);
	}

	delete(tx: WriteTx, id: string): boolean {
		return this.#db.prepare("DELETE FROM monitors WHERE monitor_id = ?").run(tx, id).changes > 0;
	}

	eventCreate(
		tx: WriteTx,
		row: {
			eventId: string;
			monitorId: string;
			eventType: string;
			payloadJson: string;
			firedAt: string;
			overlap?: "queue" | "skip";
		},
	): string | undefined {
		if (row.overlap === "skip") this.#supersedeFailedPredecessors(tx, row.monitorId, row.eventId);
		const predecessor =
			row.overlap === "skip"
				? `(SELECT event_id FROM monitor_events WHERE monitor_id = ? AND stage IN (${IN_FLIGHT_MONITOR_STAGES}) AND ${REPLAYABLE_MONITOR} ORDER BY fired_at, rowid LIMIT 1)`
				: "NULL";
		const inserted = this.#db
			.prepare(
				`INSERT INTO monitor_events (event_id, monitor_id, event_type, payload_json, fired_at, stage, batch_id, skipped_by, updated_at) SELECT ?, ?, ?, ?, ?, CASE WHEN p.id IS NULL THEN 'admitted' ELSE 'skipped' END, NULL, p.id, ? FROM (SELECT ${predecessor} AS id) AS p RETURNING skipped_by`,
			)
			.getWithWrite(
				tx,
				row.eventId,
				row.monitorId,
				row.eventType,
				row.payloadJson,
				row.firedAt,
				new Date().toISOString(),
				...(row.overlap === "skip" ? [row.monitorId] : []),
			) as { skipped_by: string | null } | null;
		return inserted?.skipped_by ?? undefined;
	}

	#supersedeFailedPredecessors(tx: WriteTx, monitorId: string, successorId: string): void {
		const now = Date.now();
		const nowIso = new Date(now).toISOString();
		const failed = this.#db
			.prepare(
				`SELECT event_id FROM monitor_events WHERE monitor_id = ? AND stage = 'failed' AND ${REPLAYABLE_MONITOR}
				AND NOT EXISTS (SELECT 1 FROM authored_outputs a WHERE a.event_id = monitor_events.event_id)`,
			)
			.all(monitorId) as Array<{ event_id: string }>;
		for (const { event_id } of failed) {
			if (
				this.eventLiveLeaseOwner(event_id, now) ||
				this.#core.metaGet(`monitor_authoring_turn:${event_id}`) !== undefined
			)
				continue;
			const changed = this.#db
				.prepare(
					`UPDATE monitor_events SET stage = 'failed_no_retry', updated_at = ? WHERE event_id = ? AND stage = 'failed' AND NOT EXISTS (
						SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.expires_at > ?
					) AND NOT EXISTS (
						SELECT 1 FROM meta m WHERE m.key = 'monitor_authoring_turn:' || monitor_events.event_id
					) AND NOT EXISTS (
						SELECT 1 FROM authored_outputs a WHERE a.event_id = monitor_events.event_id
					)`,
				)
				.run(tx, nowIso, event_id, nowIso).changes;
			if (changed === 0) continue;
			this.failureRecord(
				tx,
				event_id,
				"superseded",
				`failed event superseded by the next fire ${successorId} under overlap=skip; it is not retried`,
			);
		}
	}

	eventAcquireLease(
		tx: WriteTx,
		eventId: string,
		owner: string,
		leaseId: string,
		ttlMs: number,
		now = Date.now(),
	): boolean {
		this.#core.assertNotQuarantined("monitor", eventId);
		const nowIso = new Date(now).toISOString();
		const expiresIso = new Date(now + ttlMs).toISOString();
		return (
			this.#db
				.prepare(
					`INSERT INTO dispatch_leases (event_id, owner, lease_id, acquired_at, expires_at)
SELECT ?, ?, ?, ?, ? FROM monitor_events
WHERE event_id = ? AND stage IN (${IN_FLIGHT_MONITOR_STAGES})
ON CONFLICT(event_id) DO UPDATE SET owner = excluded.owner, lease_id = excluded.lease_id, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
WHERE excluded.acquired_at IS NOT NULL AND (SELECT expires_at FROM dispatch_leases WHERE event_id = excluded.event_id) <= excluded.acquired_at`,
				)
				.run(tx, eventId, owner, leaseId, nowIso, expiresIso, eventId).changes > 0
		);
	}

	eventReleaseLease(tx: WriteTx, eventId: string, leaseId: string): void {
		this.#db.prepare("DELETE FROM dispatch_leases WHERE event_id = ? AND lease_id = ?").run(tx, eventId, leaseId);
	}

	leaseLiveCount(now = Date.now()): number {
		return (
			(
				this.#db
					.prepare("SELECT COUNT(*) AS n FROM dispatch_leases WHERE expires_at > ?")
					.get(new Date(now).toISOString()) as { n: number } | null
			)?.n ?? 0
		);
	}

	eventLiveLeaseOwner(eventId: string, now = Date.now()): string | undefined {
		const row = this.#db
			.prepare("SELECT lease_id, expires_at FROM dispatch_leases WHERE event_id = ?")
			.get(eventId) as { lease_id: string; expires_at: string } | null;
		if (row && Date.parse(row.expires_at) > now) return row.lease_id;
		return undefined;
	}

	eventRenewLease(tx: WriteTx, eventId: string, leaseId: string, ttlMs: number, now = Date.now()): boolean {
		this.#core.assertNotQuarantined("monitor", eventId);
		const live = this.#db
			.prepare("SELECT lease_id FROM dispatch_leases WHERE event_id = ? AND lease_id = ? AND expires_at > ?")
			.get(eventId, leaseId, new Date(now).toISOString());
		if (!live) return false;
		this.#db
			.prepare("UPDATE dispatch_leases SET expires_at = ? WHERE event_id = ? AND lease_id = ?")
			.run(tx, new Date(now + ttlMs).toISOString(), eventId, leaseId);
		return true;
	}

	eventFencedUpdate(
		tx: WriteTx,
		eventId: string,
		leaseId: string,
		stage: MonitorEventStage,
		batchId: string | null = null,
		now = Date.now(),
	): boolean {
		if (!MONITOR_EVENT_STAGES.includes(stage)) throw new Error(`unknown monitor event stage: ${stage}`);
		return (
			this.#db
				.prepare(
					`UPDATE monitor_events SET stage = ?, batch_id = COALESCE(?, batch_id), updated_at = ?
WHERE event_id = ? AND stage NOT IN ('delivered','authored_no_delivery','failed_no_retry','skipped','contract_unmet') AND EXISTS (
SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.lease_id = ? AND l.expires_at > ?
)`,
				)
				.run(tx, stage, batchId, new Date(now).toISOString(), eventId, leaseId, new Date(now).toISOString()).changes > 0
		);
	}

	/** Fenced authored-output upsert; callers compose memory-intent writes in the same transaction. */
	authorFenced(
		tx: WriteTx,
		eventId: string,
		leaseId: string,
		note: string,
		noDelivery = false,
		now = Date.now(),
	): boolean {
		const leasePredicate =
			leaseId === ""
				? "1=1"
				: "EXISTS (SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.lease_id = ? AND l.expires_at > ?)";
		const leaseParams = leaseId === "" ? [] : [leaseId, new Date(now).toISOString()];
		const changes = this.#db
			.prepare(
				`UPDATE monitor_events SET stage = ?, updated_at = ? WHERE event_id = ? AND stage NOT IN ('delivered','authored_no_delivery','failed_no_retry','skipped','contract_unmet') AND ${leasePredicate}`,
			)
			.run(
				tx,
				noDelivery ? "authored_no_delivery" : "authored",
				new Date(now).toISOString(),
				eventId,
				...leaseParams,
			).changes;
		if (changes === 0) return false;
		this.authoredOutputCreate(tx, eventId, note);
		return true;
	}

	eventFencedFail(
		tx: WriteTx,
		eventId: string,
		leaseId: string,
		batchId: string,
		code: string,
		detail: string,
		now = Date.now(),
		terminal = false,
		options?: MonitorFailureOptions,
	): boolean {
		this.#core.assertNotQuarantined("monitor", eventId);
		const changes = this.#db
			.prepare(
				`UPDATE monitor_events SET stage = ?, batch_id = ?, updated_at = ?
WHERE event_id = ? AND EXISTS (
SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.lease_id = ? AND l.expires_at > ?
) AND stage NOT IN ('delivered','authored_no_delivery','failed_no_retry','skipped','contract_unmet')`,
			)
			.run(
				tx,
				terminal ? "failed_no_retry" : "failed",
				batchId,
				new Date(now).toISOString(),
				eventId,
				leaseId,
				new Date(now).toISOString(),
			).changes;
		if (changes === 0) return false;
		this.failureRecord(tx, eventId, code, detail, options);
		return true;
	}

	eventFencedContractUnmet(
		tx: WriteTx,
		eventId: string,
		leaseId: string,
		batchId: string,
		code: string,
		detail: string,
		now = Date.now(),
	): boolean {
		this.#core.assertNotQuarantined("monitor", eventId);
		const changes = this.#db
			.prepare(
				`UPDATE monitor_events SET stage = 'contract_unmet', batch_id = ?, updated_at = ?
WHERE event_id = ? AND stage = 'authored' AND EXISTS (
SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.lease_id = ? AND l.expires_at > ?
)`,
			)
			.run(tx, batchId, new Date(now).toISOString(), eventId, leaseId, new Date(now).toISOString()).changes;
		if (changes === 0) return false;
		this.failureRecord(tx, eventId, code, detail);
		return true;
	}

	eventTerminalFail(tx: WriteTx, eventId: string, code: string, detail: string): boolean {
		const changes = this.#db
			.prepare(
				"UPDATE monitor_events SET stage = 'failed_no_retry', updated_at = ? WHERE event_id = ? AND stage NOT IN ('delivered', 'authored_no_delivery', 'failed_no_retry', 'contract_unmet')",
			)
			.run(tx, new Date().toISOString(), eventId).changes;
		if (changes === 0) return false;
		this.failureRecord(tx, eventId, code, detail);
		return true;
	}

	eventLeaseHeld(eventId: string, leaseId: string, now = Date.now()): boolean {
		const row = this.#db
			.prepare("SELECT lease_id, expires_at FROM dispatch_leases WHERE event_id = ?")
			.get(eventId) as { lease_id: string; expires_at: string } | null;
		return row?.lease_id === leaseId && Date.parse(row.expires_at) > now;
	}

	eventUpdate(tx: WriteTx, eventId: string, stage: MonitorEventStage, batchId: string | null = null): void {
		if (!MONITOR_EVENT_STAGES.includes(stage)) throw new Error(`unknown monitor event stage: ${stage}`);
		this.#core.assertNotQuarantined("monitor", eventId);
		this.#db
			.prepare(
				"UPDATE monitor_events SET stage = ?, batch_id = COALESCE(?, batch_id), updated_at = ? WHERE event_id = ? AND stage <> 'contract_unmet'",
			)
			.run(tx, stage, batchId, new Date().toISOString(), eventId);
	}

	settleForTurn(tx: WriteTx, turnId: string, stage: "delivered" | "authored"): void {
		const events = this.#db.prepare("SELECT event_id FROM monitor_events WHERE batch_id = ?").all(turnId) as Array<{
			event_id: string;
		}>;
		for (const event of events) this.eventSettle(tx, event.event_id, stage);
	}

	eventSettle(tx: WriteTx, eventId: string, stage: "delivered" | "authored"): boolean {
		if (this.#db.prepare("SELECT 1 FROM broker_quarantine WHERE kind = 'monitor' AND subject_id = ?").get(eventId))
			return false;
		const row = this.#db.prepare("SELECT stage FROM monitor_events WHERE event_id = ?").get(eventId) as {
			stage: string;
		} | null;
		if (!row) return false;
		if (
			stage === "delivered" &&
			(row.stage === "authored" || (row.stage === "failed_no_retry" && this.authoredOutput(eventId) !== undefined))
		) {
			this.eventUpdate(tx, eventId, "delivered");
			return true;
		}
		if (stage === "authored" && row.stage === "authored") return false;
		if (
			stage === "authored" &&
			row.stage !== "delivered" &&
			row.stage !== "authored_no_delivery" &&
			row.stage !== "failed_no_retry" &&
			row.stage !== "contract_unmet"
		) {
			this.eventUpdate(tx, eventId, "authored");
			return true;
		}
		return false;
	}

	/** Reap old, unauthored open events without a live dispatch or saved authoring turn. */
	eventReapStale(tx: WriteTx, cutoff: string, now = Date.now()): MonitorEventDbRow[] {
		const nowIso = new Date(now).toISOString();
		const candidates = this.#db
			.prepare(
				`SELECT * FROM monitor_events WHERE stage IN (${IN_FLIGHT_MONITOR_STAGES}) AND updated_at < ? AND ${REPLAYABLE_MONITOR}
				AND NOT EXISTS (SELECT 1 FROM authored_outputs a WHERE a.event_id = monitor_events.event_id)
				AND NOT EXISTS (SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.expires_at > ?)
				AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = 'monitor_authoring_turn:' || monitor_events.event_id)
				ORDER BY updated_at, rowid`,
			)
			.all(cutoff, nowIso) as MonitorEventDbRow[];
		const reaped: MonitorEventDbRow[] = [];
		for (const row of candidates) {
			const changed = this.#db
				.prepare(
					`UPDATE monitor_events SET stage = 'failed_no_retry', updated_at = ?
					WHERE event_id = ? AND stage IN (${IN_FLIGHT_MONITOR_STAGES}) AND updated_at < ?
					AND NOT EXISTS (SELECT 1 FROM authored_outputs a WHERE a.event_id = monitor_events.event_id)
					AND NOT EXISTS (SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.expires_at > ?)
					AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = 'monitor_authoring_turn:' || monitor_events.event_id)`,
				)
				.run(tx, nowIso, row.event_id, cutoff, nowIso).changes;
			if (changed === 0) continue;
			this.failureRecord(
				tx,
				row.event_id,
				"stale_open_event",
				`event left ${row.stage} after ${row.dispatch_attempts} reclaims, updated ${row.updated_at}; reaped as stale`,
			);
			reaped.push(row);
		}
		return reaped;
	}

	/** Operator settle: terminalize a reconcilable event only when no dispatch lease is live. */
	eventOperatorSettle(
		tx: WriteTx,
		eventId: string,
		now = Date.now(),
	): { settled: true; previousStage: string } | { settled: false; reason: string } {
		const row = this.eventGet(eventId);
		if (!row) return { settled: false, reason: "unknown_event" };
		if (!(RECONCILABLE_STAGES as readonly string[]).includes(row.stage))
			return { settled: false, reason: `stage_${row.stage}` };
		if (this.authoredOutput(eventId) !== undefined) return { settled: false, reason: "already_authored" };
		const nowIso = new Date(now).toISOString();
		const changed = this.#db
			.prepare(
				`UPDATE monitor_events SET stage = 'failed_no_retry', updated_at = ? WHERE event_id = ? AND stage IN (${IN_FLIGHT_MONITOR_STAGES})
				AND NOT EXISTS (SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.expires_at > ?)`,
			)
			.run(tx, nowIso, eventId, nowIso).changes;
		if (changed === 0) return { settled: false, reason: "dispatch_in_flight" };
		this.failureRecord(tx, eventId, "operator_settled", `settled by operator from ${row.stage}`);
		return { settled: true, previousStage: row.stage };
	}

	/** Reset a failed event's reclaim budget without changing its fired time or saved authoring turn. */
	eventOperatorRetry(
		tx: WriteTx,
		eventId: string,
		now = Date.now(),
	): { retried: true; previousStage: string } | { retried: false; reason: string } {
		const row = this.eventGet(eventId);
		if (!row) return { retried: false, reason: "unknown_event" };
		if (row.stage !== "failed" && row.stage !== "failed_no_retry")
			return { retried: false, reason: `stage_${row.stage}` };
		if (this.authoredOutput(eventId) !== undefined) return { retried: false, reason: "already_authored" };
		const nowIso = new Date(now).toISOString();
		const changed = this.#db
			.prepare(
				"UPDATE monitor_events SET stage = 'failed', dispatch_attempts = 0, updated_at = ? WHERE event_id = ? AND stage IN ('failed','failed_no_retry') AND NOT EXISTS (SELECT 1 FROM authored_outputs a WHERE a.event_id = monitor_events.event_id) AND NOT EXISTS (SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.expires_at > ?)",
			)
			.run(tx, nowIso, eventId, nowIso).changes;
		if (changed === 0) {
			if (this.authoredOutput(eventId) !== undefined) return { retried: false, reason: "already_authored" };
			return { retried: false, reason: "dispatch_in_flight" };
		}
		return { retried: true, previousStage: row.stage };
	}

	/**
	 * Reopen a given-up event for late-result recovery: back to `failed` with its
	 * exhausted reclaim budget kept, so reconcile can only resume the saved turn,
	 * never send a fresh prompt.
	 */
	eventReopenGivenUp(tx: WriteTx, eventId: string, now = Date.now()): boolean {
		const nowIso = new Date(now).toISOString();
		return (
			this.#db
				.prepare(
					"UPDATE monitor_events SET stage = 'failed', updated_at = ? WHERE event_id = ? AND stage = 'failed_no_retry' AND NOT EXISTS (SELECT 1 FROM authored_outputs a WHERE a.event_id = monitor_events.event_id) AND NOT EXISTS (SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.expires_at > ?)",
				)
				.run(tx, nowIso, eventId, nowIso).changes > 0
		);
	}

	eventsFailExpiredDelivery(
		tx: WriteTx,
		turnId: string,
		deliveryId: string,
		attempts: number,
		reason: string,
	): string[] {
		const events = this.#db
			.prepare(
				`SELECT event_id FROM monitor_events WHERE batch_id = ? AND stage = 'authored' AND ${REPLAYABLE_MONITOR}`,
			)
			.all(turnId) as Array<{ event_id: string }>;
		for (const { event_id } of events) {
			this.eventUpdate(tx, event_id, "failed_no_retry");
			this.failureRecord(
				tx,
				event_id,
				"delivery_expired",
				`delivery ${deliveryId} expired after ${attempts} attempts: ${reason}`,
			);
		}
		return events.map((row) => row.event_id);
	}

	eventIncrementAttempts(tx: WriteTx, eventId: string): number {
		this.#db
			.prepare("UPDATE monitor_events SET dispatch_attempts = dispatch_attempts + 1, updated_at = ? WHERE event_id = ?")
			.run(tx, new Date().toISOString(), eventId);
		return this.eventDispatchAttempts(eventId);
	}

	eventDispatchAttempts(eventId: string): number {
		return (
			(
				this.#db.prepare("SELECT dispatch_attempts FROM monitor_events WHERE event_id = ?").get(eventId) as {
					dispatch_attempts: number;
				} | null
			)?.dispatch_attempts ?? 0
		);
	}

	eventRows(
		monitorId?: string,
		order: "newest" | "oldest" = "newest",
		includeQuarantined = false,
		limit?: number,
	): MonitorEventDbRow[] {
		const direction = order === "oldest" ? "ASC" : "DESC";
		const terms = [
			monitorId === undefined ? undefined : "monitor_id = ?",
			includeQuarantined ? undefined : REPLAYABLE_MONITOR,
		];
		const where = terms.filter((term) => term !== undefined).join(" AND ") || "1=1";
		const params: Array<string | number> = monitorId === undefined ? [] : [monitorId];
		if (limit !== undefined) params.push(limit);
		return this.#db
			.prepare(
				`SELECT * FROM monitor_events WHERE ${where} ORDER BY fired_at ${direction}, rowid ${direction}${limit === undefined ? "" : " LIMIT ?"}`,
			)
			.all(...params) as MonitorEventDbRow[];
	}

	eventGet(eventId: string, includeQuarantined = false): MonitorEventDbRow | undefined {
		return (
			(this.#db
				.prepare(
					`SELECT * FROM monitor_events WHERE event_id = ?${includeQuarantined ? "" : ` AND ${REPLAYABLE_MONITOR}`}`,
				)
				.get(eventId) as MonitorEventDbRow | null) ?? undefined
		);
	}

	eventsByIds(eventIds: readonly string[]): MonitorEventDbRow[] {
		if (eventIds.length === 0) return [];
		return this.#db
			.prepare(
				`SELECT * FROM monitor_events WHERE event_id IN (SELECT value FROM json_each(?)) AND ${REPLAYABLE_MONITOR} ORDER BY fired_at DESC, rowid DESC`,
			)
			.all(JSON.stringify(eventIds)) as MonitorEventDbRow[];
	}

	eventsByBatch(batchId: string): MonitorEventDbRow[] {
		return this.#db
			.prepare(
				`SELECT * FROM monitor_events WHERE batch_id = ? AND ${REPLAYABLE_MONITOR} ORDER BY fired_at DESC, rowid DESC`,
			)
			.all(batchId) as MonitorEventDbRow[];
	}

	/** Terminal events whose latest failure is `code` and whose saved authoring-turn pointer is still kept. */
	eventsGivenUp(code: string): MonitorEventDbRow[] {
		return this.#db
			.prepare(
				`SELECT * FROM monitor_events WHERE stage = 'failed_no_retry' AND ${REPLAYABLE_MONITOR}
				AND (SELECT f.code FROM monitor_failures f WHERE f.event_id = monitor_events.event_id ORDER BY f.rowid DESC LIMIT 1) = ?
				AND EXISTS (SELECT 1 FROM meta m WHERE m.key = 'monitor_authoring_turn:' || monitor_events.event_id)
				ORDER BY fired_at, rowid`,
			)
			.all(code) as MonitorEventDbRow[];
	}

	eventsOpen(): MonitorEventDbRow[] {
		return this.#db
			.prepare(
				`SELECT * FROM monitor_events WHERE ${OPEN_MONITOR_EVENT} AND ${REPLAYABLE_MONITOR} ORDER BY fired_at, rowid`,
			)
			.all() as MonitorEventDbRow[];
	}

	/**
	 * One monitor's events that are waiting for a dispatcher: admitted, or failed
	 * and due for another attempt. Batched and dispatched events have a turn in
	 * flight and are left to its own terminal disposition.
	 */
	eventsAwaitingDispatch(monitorId: string): MonitorEventDbRow[] {
		return this.#db
			.prepare(
				"SELECT * FROM monitor_events WHERE monitor_id = ? AND stage IN ('admitted','failed') ORDER BY fired_at, rowid",
			)
			.all(monitorId) as MonitorEventDbRow[];
	}

	slotsDelete(tx: WriteTx, monitorId: string): number {
		return this.#db.prepare("DELETE FROM monitor_slots WHERE monitor_id = ?").run(tx, monitorId).changes;
	}

	authoredBatchIds(): string[] {
		return this.#db
			.prepare(
				`SELECT DISTINCT batch_id FROM monitor_events WHERE stage = 'authored' AND batch_id IS NOT NULL AND ${REPLAYABLE_MONITOR}`,
			)
			.all()
			.map((row) => (row as { batch_id: string }).batch_id);
	}

	/** Authored notes for the session-roll digest; `contract_unmet` echoes never seed a fresh session (#369). */
	recentAuthoredNotes(
		monitorId: string,
		limit: number,
	): Array<{ event_id: string; event_type: string; payload_json: string; fired_at: string; note: string }> {
		return this.#db
			.prepare(
				`SELECT monitor_events.event_id AS event_id, monitor_events.event_type AS event_type, monitor_events.payload_json AS payload_json, monitor_events.fired_at AS fired_at, authored_outputs.output_text AS note FROM monitor_events JOIN authored_outputs ON authored_outputs.event_id = monitor_events.event_id WHERE monitor_events.monitor_id = ? AND monitor_events.stage <> 'contract_unmet' AND ${REPLAYABLE_MONITOR} ORDER BY monitor_events.fired_at DESC, monitor_events.rowid DESC LIMIT ?`,
			)
			.all(monitorId, limit) as Array<{
			event_id: string;
			event_type: string;
			payload_json: string;
			fired_at: string;
			note: string;
		}>;
	}

	authoredOutputCreate(tx: WriteTx, eventId: string, outputText: string): void {
		this.#core.assertNotQuarantined("monitor", eventId);
		this.#db
			.prepare(
				"INSERT INTO authored_outputs (event_id, output_text, authored_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET output_text = excluded.output_text, authored_at = excluded.authored_at",
			)
			.run(tx, eventId, outputText, new Date().toISOString());
	}

	eventFencedSetProcedure(
		tx: WriteTx,
		eventId: string,
		leaseId: string,
		procedureJson: string,
		now = Date.now(),
	): boolean {
		this.#core.assertNotQuarantined("monitor", eventId);
		return (
			this.#db
				.prepare(
					`UPDATE monitor_events SET procedure_json = ?
WHERE event_id = ? AND EXISTS (
SELECT 1 FROM dispatch_leases l WHERE l.event_id = monitor_events.event_id AND l.lease_id = ? AND l.expires_at > ?
)`,
				)
				.run(tx, procedureJson, eventId, leaseId, new Date(now).toISOString()).changes > 0
		);
	}

	authoredOutput(eventId: string): string | undefined {
		return (
			this.#db.prepare("SELECT output_text FROM authored_outputs WHERE event_id = ?").get(eventId) as {
				output_text: string;
			} | null
		)?.output_text;
	}

	failure(eventId: string): MonitorFailureRow | undefined {
		return (
			(this.#db
				.prepare(
					"SELECT event_id, code, detail, failed_at, protocol_reason, response_byte_length, response_entry_count FROM monitor_failures WHERE event_id = ? ORDER BY rowid DESC LIMIT 1",
				)
				.get(eventId) as MonitorFailureRow | null) ?? undefined
		);
	}

	recentFailures(limit: number): RecentMonitorFailureRow[] {
		if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100)
			throw new Error("monitor failure limit must be 0..100");
		return this.#db
			.prepare(
				`SELECT monitor_events.event_id, monitor_events.monitor_id, monitor_events.event_type, monitor_events.stage, monitor_failures.code, monitor_failures.detail, monitor_failures.failed_at
FROM monitor_failures JOIN monitor_events ON monitor_events.event_id = monitor_failures.event_id
WHERE ${REPLAYABLE_MONITOR}
ORDER BY monitor_failures.rowid DESC LIMIT ?`,
			)
			.all(limit) as RecentMonitorFailureRow[];
	}

	failureRecord(tx: WriteTx, eventId: string, code: string, detail: string, options?: MonitorFailureOptions): void {
		const protocolFailure = options?.protocolFailure;
		if (protocolFailure) {
			if (!(PROTOCOL_FAILURE_REASONS as readonly string[]).includes(protocolFailure.reason))
				throw new Error("invalid monitor protocol failure reason");
			if (!Number.isSafeInteger(protocolFailure.responseByteLength) || protocolFailure.responseByteLength < 0)
				throw new Error("invalid monitor protocol response byte length");
			if (
				protocolFailure.responseEntryCount !== null &&
				(!Number.isSafeInteger(protocolFailure.responseEntryCount) ||
					protocolFailure.responseEntryCount < 0 ||
					protocolFailure.responseEntryCount > protocolFailure.responseByteLength)
			)
				throw new Error("invalid monitor protocol response entry count");
		}
		const failedAt = new Date().toISOString();
		this.#db
			.prepare(
				"INSERT INTO monitor_failures (event_id, code, detail, failed_at, protocol_reason, response_byte_length, response_entry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				tx,
				eventId,
				code,
				detail.slice(0, 500),
				failedAt,
				protocolFailure?.reason ?? null,
				protocolFailure?.responseByteLength ?? null,
				protocolFailure?.responseEntryCount ?? null,
			);
		this.#db
			.prepare(
				"DELETE FROM monitor_failures WHERE event_id = ? AND rowid NOT IN (SELECT rowid FROM monitor_failures WHERE event_id = ? ORDER BY rowid DESC LIMIT 20)",
			)
			.run(tx, eventId, eventId);
	}

	eventRecovery(eventId: string): MonitorEventRecovery | undefined {
		const event = this.#db
			.prepare("SELECT stage, updated_at, dispatch_attempts FROM monitor_events WHERE event_id = ?")
			.get(eventId) as { stage: string; updated_at: string; dispatch_attempts: number } | null;
		if (!event) return undefined;
		const rows = this.#db
			.prepare(
				"SELECT protocol_reason, failed_at, response_byte_length, response_entry_count FROM monitor_failures WHERE event_id = ? AND protocol_reason IS NOT NULL ORDER BY rowid ASC",
			)
			.all(eventId) as Array<{
			protocol_reason: string | null;
			failed_at: string;
			response_byte_length: number | null;
			response_entry_count: number | null;
		}>;
		const protocolFailures: MonitorProtocolFailureRecord[] = [];
		for (const row of rows) {
			if (
				!(PROTOCOL_FAILURE_REASONS as readonly string[]).includes(row.protocol_reason ?? "") ||
				!Number.isSafeInteger(row.response_byte_length) ||
				(row.response_byte_length ?? -1) < 0 ||
				(row.response_entry_count !== null &&
					(!Number.isSafeInteger(row.response_entry_count) ||
						row.response_entry_count < 0 ||
						row.response_entry_count > (row.response_byte_length ?? -1)))
			)
				continue;
			protocolFailures.push({
				reason: row.protocol_reason as ProtocolFailureReason,
				failedAt: row.failed_at,
				responseByteLength: row.response_byte_length as number,
				responseEntryCount: row.response_entry_count,
			});
		}
		const first = protocolFailures[0];
		if (!first) return undefined;
		const deliveredAt = event.stage === "delivered" ? event.updated_at : null;
		const failedAtMs = Date.parse(first.failedAt);
		const deliveredAtMs = deliveredAt === null ? Number.NaN : Date.parse(deliveredAt);
		const latency = deliveredAtMs - failedAtMs;
		return {
			protocolFailures,
			firstFailedAt: first.failedAt,
			deliveredAt,
			recoveryLatencyMs:
				Number.isFinite(failedAtMs) && Number.isFinite(deliveredAtMs) && Number.isSafeInteger(latency) && latency >= 0
					? latency
					: null,
			dispatchAttempts: event.dispatch_attempts + 1,
		};
	}

	failures(eventIds: readonly string[]): Map<string, MonitorFailureRow> {
		const rows = new Map<string, MonitorFailureRow>();
		for (const eventId of eventIds) {
			const row = this.failure(eventId);
			if (row) rows.set(eventId, row);
		}
		return rows;
	}

	slotClaimWithEvent(
		tx: WriteTx,
		row: {
			monitorId: string;
			slotAt: string;
			eventId: string;
			eventType: string;
			payloadJson: string;
			overlap?: "queue" | "skip";
		},
	): { admitted: false } | { admitted: true; skippedBy: string | undefined } {
		const claim = this.#db
			.prepare(
				"INSERT INTO monitor_slots (monitor_id, slot_at, event_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(monitor_id, slot_at) DO NOTHING",
			)
			.run(tx, row.monitorId, row.slotAt, row.eventId, new Date().toISOString()).changes;
		if (claim === 0) return { admitted: false };
		const skippedBy = this.eventCreate(tx, {
			eventId: row.eventId,
			monitorId: row.monitorId,
			eventType: row.eventType,
			payloadJson: row.payloadJson,
			firedAt: row.slotAt,
			...(row.overlap ? { overlap: row.overlap } : {}),
		});
		return { admitted: true, skippedBy };
	}

	setCreatedAt(tx: WriteTx, monitorId: string, createdAt: string): void {
		this.#db.prepare("UPDATE monitors SET created_at = ? WHERE monitor_id = ?").run(tx, createdAt, monitorId);
	}

	slotExists(monitorId: string, slotAt: string): boolean {
		const row = this.#db
			.prepare("SELECT COUNT(*) AS n FROM monitor_slots WHERE monitor_id = ? AND slot_at = ?")
			.get(monitorId, slotAt) as { n: number } | null;
		return (row?.n ?? 0) > 0;
	}

	slotCursor(monitorId: string): string | undefined {
		return (
			(
				this.#db.prepare("SELECT MAX(slot_at) AS slot_at FROM monitor_slots WHERE monitor_id = ?").get(monitorId) as {
					slot_at: string | null;
				} | null
			)?.slot_at ?? undefined
		);
	}

	sweep(tx: WriteTx, cutoffs: { historyCutoff: string; batch: number }): { events: number; slots: number } {
		const events = this.#db
			.prepare(
				`SELECT event_id FROM monitor_events WHERE ${TERMINAL_MONITOR_EVENT} AND updated_at < ? AND ${REPLAYABLE_MONITOR} ORDER BY updated_at LIMIT ?`,
			)
			.all(cutoffs.historyCutoff, cutoffs.batch) as Array<{ event_id: string }>;
		for (const { event_id } of events) {
			this.#db.prepare("DELETE FROM authored_outputs WHERE event_id = ?").run(tx, event_id);
			this.#db.prepare("DELETE FROM monitor_failures WHERE event_id = ?").run(tx, event_id);
			this.#db.prepare("DELETE FROM dispatch_leases WHERE event_id = ?").run(tx, event_id);
			this.#db.prepare("DELETE FROM monitor_events WHERE event_id = ?").run(tx, event_id);
			// A pointer outliving its event can never be recovered or matched again.
			this.#core.metaDelete(`monitor_authoring_turn:${event_id}`);
		}
		const slots = this.#db
			.prepare(
				"DELETE FROM monitor_slots WHERE rowid IN (SELECT t.rowid FROM monitor_slots t WHERE t.slot_at < ? AND t.slot_at < (SELECT MAX(m.slot_at) FROM monitor_slots m WHERE m.monitor_id = t.monitor_id) LIMIT ?)",
			)
			.run(tx, cutoffs.historyCutoff, cutoffs.batch).changes;
		return { events: events.length, slots };
	}
}
