/**
 * Unattended-mode audit trail (#320).
 *
 * Append-only JSONL log of every auto-answered gate, budget breach, and
 * scope/action denial in an unattended run. Records are deduped exactly-once by a
 * stable `dedupe_key`, carry `schema_version`, and are queryable/exportable after
 * the run by run/session/actor/gate/outcome and a time window.
 *
 * Answer policy: gate-response records store the full `answer` plus an
 * `answer_hash` by default; when a redaction policy is enabled the raw answer is
 * dropped and only the hash + a short summary is retained.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import * as path from "node:path";
import type { RpcBudgetExceeded, RpcWorkflowGateKind, RpcWorkflowStage } from "../../rpc/rpc-types";
import { answerHashOf } from "./workflow-gate-schema";

export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_CATEGORY = "unattended_lifecycle";

export type AuditOutcome = "accepted" | "rejected" | "denied" | "exceeded" | "aborted" | "info";

export interface AuditRecord {
	event_id: string;
	schema_version: number;
	category: typeof AUDIT_CATEGORY;
	run_id: string;
	session_id?: string;
	actor?: string;
	timestamp: string;
	event: string;
	outcome: AuditOutcome;
	dedupe_key: string;
	gate_id?: string;
	stage?: RpcWorkflowStage;
	kind?: RpcWorkflowGateKind;
	scope?: string;
	action?: string;
	budget?: RpcBudgetExceeded;
	/** Full answer (omitted when redaction is enabled). */
	answer?: unknown;
	answer_hash?: string;
	error?: unknown;
}

export interface AuditQuery {
	run_id?: string;
	session_id?: string;
	actor?: string;
	gate_id?: string;
	outcome?: AuditOutcome;
	event?: string;
	since?: string;
	until?: string;
}

export interface AuditLogOptions {
	/** When true, gate answers are stored as hash + summary only. */
	redactAnswers?: boolean;
	/** Injectable id/clock for deterministic tests. */
	now?(): number;
	nextId?(): string;
}

let idCounter = 0;

function defaultId(): string {
	idCounter += 1;
	return `ae_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function defaultAuditPath(runId: string, root = process.cwd()): string {
	const safe = runId.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return path.join(root, ".gjc", "audit", "unattended", `${safe}.jsonl`);
}

/** Append-only audit log writer + reader for one unattended run. */
export class UnattendedAuditLog {
	private readonly seen = new Set<string>();
	private readonly now: () => number;
	private readonly nextId: () => string;
	private readonly redactAnswers: boolean;

	constructor(
		private readonly filePath: string,
		options: AuditLogOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.nextId = options.nextId ?? defaultId;
		this.redactAnswers = options.redactAnswers ?? false;
		mkdirSync(path.dirname(filePath), { recursive: true });
		// Seed dedupe set from any existing records so restarts stay exactly-once.
		for (const rec of this.readAll()) this.seen.add(rec.dedupe_key);
	}

	/**
	 * Append a record. Returns the written record, or `null` if a record with the
	 * same dedupe_key was already written (exactly-once).
	 */
	record(input: Omit<AuditRecord, "event_id" | "schema_version" | "category" | "timestamp">): AuditRecord | null {
		if (this.seen.has(input.dedupe_key)) return null;
		const record: AuditRecord = {
			event_id: this.nextId(),
			schema_version: AUDIT_SCHEMA_VERSION,
			category: AUDIT_CATEGORY,
			timestamp: new Date(this.now()).toISOString(),
			...input,
		};
		if (this.redactAnswers && "answer" in record) {
			record.answer = undefined;
		}
		// Durably append BEFORE recording the key as seen, so a failed write does not
		// poison the dedupe set (which would wrongly skip a later retry of this event).
		this.appendDurable(`${JSON.stringify(record)}\n`);
		this.seen.add(record.dedupe_key);
		return record;
	}

	/** Append one line and fsync it for crash durability. */
	private appendDurable(line: string): void {
		const fd = openSync(this.filePath, "a");
		try {
			writeSync(fd, line);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	/** Read every record (fail-closed: a corrupt line throws rather than silently dropping). */
	readAll(): AuditRecord[] {
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const out: AuditRecord[] = [];
		const lines = raw.split("\n").filter(l => l.trim() !== "");
		for (const [i, line] of lines.entries()) {
			try {
				out.push(JSON.parse(line) as AuditRecord);
			} catch (err) {
				throw new Error(`corrupt audit record at ${this.filePath}:${i + 1}: ${(err as Error).message}`);
			}
		}
		return out;
	}

	/** Query records with filters (run/session/actor/gate/outcome/event + time window). */
	query(filter: AuditQuery = {}): AuditRecord[] {
		return this.readAll().filter(r => {
			if (filter.run_id !== undefined && r.run_id !== filter.run_id) return false;
			if (filter.session_id !== undefined && r.session_id !== filter.session_id) return false;
			if (filter.actor !== undefined && r.actor !== filter.actor) return false;
			if (filter.gate_id !== undefined && r.gate_id !== filter.gate_id) return false;
			if (filter.outcome !== undefined && r.outcome !== filter.outcome) return false;
			if (filter.event !== undefined && r.event !== filter.event) return false;
			if (filter.since !== undefined && r.timestamp < filter.since) return false;
			if (filter.until !== undefined && r.timestamp > filter.until) return false;
			return true;
		});
	}

	/** Export the full trail as an array (for `get_unattended_audit`). */
	export(filter: AuditQuery = {}): AuditRecord[] {
		return this.query(filter);
	}
}

/** SHA-256 of the canonical JSON of an answer (matches the gate broker's hash). */
export function answerHash(answer: unknown): string {
	return answerHashOf(answer);
}
