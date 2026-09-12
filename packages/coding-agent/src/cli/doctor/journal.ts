import { constants, type Dir } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DoctorJournalAuthority, verifyOwnerOnlyFdSecurity } from "@gajae-code/natives";
import { loadNative as loadNativeBindings } from "../../../../natives/native/loader-state.js";
import { isDoctorAction } from "./args";
import { doctorErrno, readDoctorFile } from "./files";
import { isDoctorTargetId } from "./ids";
import type { DoctorCheck } from "./types";

export type DoctorJournalPhase =
	| "created"
	| "before"
	| "prepared"
	| "applying"
	| "applied_unverified"
	| "verified"
	| "failed"
	| "uncertain";
export interface DoctorJournalRecord {
	readonly runId: string;
	readonly repairId: string;
	readonly phase: DoctorJournalPhase;
	readonly targetId: string;
	readonly before?: Record<string, unknown>;
	readonly after?: Record<string, unknown>;
	readonly outcome?: string;
	readonly at: string;
}
export type DoctorJournalReadStatus = "ok" | "missing" | "malformed" | "unreadable" | "unsupported" | "changed";
export interface DoctorJournalReadResult {
	readonly status: DoctorJournalReadStatus;
	readonly records: readonly DoctorJournalRecord[];
	readonly malformedLines: readonly number[];
	readonly error?: string;
}
export type DoctorReconcileOutcome = "not_applied" | "applied_unverified" | "conflict" | "verified" | "unknown";
export interface DoctorReconcileEvidence {
	readonly check: DoctorCheck;
	readonly current: Record<string, unknown>;
}

type JournalBindings = {
	DoctorJournalAuthority: typeof DoctorJournalAuthority;
	verifyOwnerOnlyFdSecurity: typeof verifyOwnerOnlyFdSecurity;
};
const MAX_BYTES = 128 * 1024;
const MAX_RECORDS = 64;
const MAX_UNRESOLVED = 20;
const MAX_HISTORY = 256;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PHASES = new Set<DoctorJournalPhase>([
	"created",
	"before",
	"prepared",
	"applying",
	"applied_unverified",
	"verified",
	"failed",
	"uncertain",
]);
const DECIMAL_KEYS = new Set([
	"dev",
	"ino",
	"uid",
	"gid",
	"nlink",
	"size",
	"mode",
	"parentDev",
	"parentIno",
	"mtimeNs",
]);
const TYPE_VALUES = new Set([
	"file",
	"directory",
	"symlink",
	"missing",
	"present",
	"boolean",
	"null",
	"string",
	"number",
	"object",
	"array",
]);
const OUTCOMES = new Set([
	"created",
	"verified",
	"verified_with_blocker",
	"failed",
	"uncertain",
	"not_applied",
	"not_needed",
	"applied_unverified",
	"conflict",
	"rolled_back",
	"rollback_conflict",
	"cancelled",
]);

function bindings(): JournalBindings {
	return loadNativeBindings() as JournalBindings;
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if ((key === "value" || key === "exists") && (typeof item === "boolean" || item === null)) result[key] = item;
		else if (DECIMAL_KEYS.has(key)) {
			if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) result[key] = item;
			else if (typeof item === "string" && /^-?(?:0|[1-9]\d{0,19})$/.test(item)) {
				const number = BigInt(item);
				if (number >= (key === "mtimeNs" ? -9223372036854775808n : 0n) && number <= 18446744073709551615n)
					result[key] = item;
			}
		} else if (key === "type" && typeof item === "string" && TYPE_VALUES.has(item)) result[key] = item;
		else if (key === "reason" && typeof item === "string" && OUTCOMES.has(item)) result[key] = item;
		else if (
			key === "quarantineName" &&
			typeof item === "string" &&
			/^[A-Za-z0-9._-]{1,128}$/.test(item) &&
			item !== "." &&
			item !== ".."
		)
			result[key] = item;
	}
	return result;
}

function validateRecord(value: unknown): DoctorJournalRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.runId !== "string" ||
		!RUN_ID.test(record.runId) ||
		typeof record.phase !== "string" ||
		!PHASES.has(record.phase as DoctorJournalPhase) ||
		typeof record.at !== "string" ||
		record.at.length > 32
	)
		return undefined;
	const time = Date.parse(record.at);
	if (!Number.isFinite(time) || new Date(time).toISOString() !== record.at) return undefined;
	const header = record.phase === "created" && record.repairId === "" && record.targetId === "";
	if (
		!header &&
		(!isDoctorAction(record.repairId) || typeof record.targetId !== "string" || !isDoctorTargetId(record.targetId))
	)
		return undefined;
	for (const key of ["before", "after"] as const) {
		if (record[key] !== undefined && JSON.stringify(record[key]) !== JSON.stringify(safeRecord(record[key])))
			return undefined;
	}
	if (record.outcome !== undefined && (typeof record.outcome !== "string" || !OUTCOMES.has(record.outcome)))
		return undefined;
	return {
		runId: record.runId,
		repairId: record.repairId as string,
		targetId: record.targetId as string,
		phase: record.phase as DoctorJournalPhase,
		at: record.at,
		...(record.before !== undefined ? { before: safeRecord(record.before) } : {}),
		...(record.after !== undefined ? { after: safeRecord(record.after) } : {}),
		...(typeof record.outcome === "string" ? { outcome: record.outcome } : {}),
	};
}

export class DoctorJournalCreateError extends Error {
	constructor(
		readonly reasonCode: string,
		readonly sideEffectStarted: boolean,
	) {
		super("Doctor journal creation failed");
		this.name = "DoctorJournalCreateError";
	}
}

async function checkHistory(root: string): Promise<void> {
	const directory = path.join(root, "doctor", "repairs");
	let handle: Dir;
	try {
		const stat = await fs.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new DoctorJournalCreateError("unsafe_journal_history", false);
		handle = await fs.opendir(directory, { bufferSize: 16 });
	} catch (error) {
		if (doctorErrno(error) === "ENOENT") return;
		if (error instanceof DoctorJournalCreateError) throw error;
		throw new DoctorJournalCreateError("journal_history_unreadable", false);
	}
	let scanned = 0;
	let unresolved = 0;
	for await (const entry of handle) {
		if (++scanned > MAX_HISTORY) throw new DoctorJournalCreateError("journal_history_limit", false);
		if (!entry.isDirectory() || !RUN_ID.test(entry.name))
			throw new DoctorJournalCreateError("unsafe_journal_history", false);
		const read = await DoctorJournal.readDetailed(path.join(directory, entry.name, "journal.ndjson"));
		const last = read.records.at(-1);
		if (read.status !== "ok" || !last || (last.phase !== "verified" && last.phase !== "failed")) unresolved++;
		if (unresolved >= MAX_UNRESOLVED) throw new DoctorJournalCreateError("unresolved_journal_limit", false);
	}
}

export class DoctorJournal {
	readonly path: string;
	readonly #runId: string;
	readonly #native: DoctorJournalAuthority;
	#closed = false;
	#records = 0;
	#selection: string | undefined;

	constructor(pathname: string, runId: string, native: DoctorJournalAuthority) {
		this.path = pathname;
		this.#runId = runId;
		this.#native = native;
	}

	static async create(root: string, runId: string): Promise<DoctorJournal> {
		if (!RUN_ID.test(runId)) throw new DoctorJournalCreateError("invalid_run_id", false);
		await checkHistory(root);
		let native: JournalBindings;
		try {
			native = bindings();
		} catch {
			throw new DoctorJournalCreateError("native_unavailable", false);
		}
		if (typeof native.DoctorJournalAuthority?.createExact !== "function")
			throw new DoctorJournalCreateError("native_unavailable", false);
		const result = native.DoctorJournalAuthority.createExact(path.resolve(root), runId);
		if (!result || typeof result.sideEffectStarted !== "boolean")
			throw new DoctorJournalCreateError("native_contract_unknown", true);
		if (!result.authority)
			throw new DoctorJournalCreateError(result.reasonCode ?? "native_create_failed", result.sideEffectStarted);
		const journal = new DoctorJournal(
			path.join(root, "doctor", "repairs", runId, "journal.ndjson"),
			runId,
			result.authority,
		);
		try {
			await journal.append({ repairId: "", phase: "created", targetId: "", outcome: "created" });
			return journal;
		} catch {
			journal.close();
			throw new DoctorJournalCreateError("journal_initial_append_failed", true);
		}
	}

	async append(input: Omit<DoctorJournalRecord, "runId" | "at">): Promise<void> {
		if (this.#closed || this.#records >= MAX_RECORDS) throw new Error("journal_not_writable");
		const record: DoctorJournalRecord = {
			runId: this.#runId,
			repairId: input.repairId,
			targetId: input.targetId,
			phase: input.phase,
			at: new Date().toISOString(),
			before: safeRecord(input.before),
			after: safeRecord(input.after),
			...(input.outcome && OUTCOMES.has(input.outcome) ? { outcome: input.outcome } : {}),
		};
		if (!validateRecord(record)) throw new Error("invalid_journal_record");
		if (record.phase === "created" && this.#records !== 0) throw new Error("duplicate_journal_header");
		if (record.phase !== "created") {
			const selection = `${record.repairId}\0${record.targetId}`;
			if (this.#selection !== undefined && this.#selection !== selection)
				throw new Error("journal_selection_changed");
			this.#selection = selection;
		}
		const line = JSON.stringify(record);
		if (Buffer.byteLength(line) + 1 > MAX_BYTES) throw new Error("journal_record_limit");
		this.#native.append(line);
		this.#records++;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#native.close();
	}

	static async read(pathname: string): Promise<DoctorJournalRecord[]> {
		return [...(await DoctorJournal.readDetailed(pathname)).records];
	}

	static async readDetailed(pathname: string): Promise<DoctorJournalReadResult> {
		const empty = { records: [], malformedLines: [] } as const;
		const observation = await readDoctorFile(pathname, MAX_BYTES);
		if (observation.status === "missing") return { ...empty, status: "missing" };
		if (observation.status === "unreadable") return { ...empty, status: "unreadable", error: observation.errno };
		if (observation.status === "changed") return { ...empty, status: "changed" };
		if (observation.status !== "read") return { ...empty, status: "unsupported" };
		const run = path.dirname(pathname);
		const repairs = path.dirname(run);
		const doctor = path.dirname(repairs);
		if (
			path.basename(pathname) !== "journal.ndjson" ||
			path.basename(repairs) !== "repairs" ||
			path.basename(doctor) !== "doctor" ||
			!RUN_ID.test(path.basename(run))
		)
			return { ...empty, status: "unsupported" };
		try {
			const native = bindings();
			for (const directory of [doctor, repairs, run]) {
				const fd = await fs.open(
					directory,
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					if (!native.verifyOwnerOnlyFdSecurity(directory, "directory", fd.fd).ok)
						return { ...empty, status: "unsupported" };
				} finally {
					await fd.close();
				}
			}
			const fd = await fs.open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const stat = await fd.stat({ bigint: true });
				if (
					stat.dev !== observation.exactIdentity.dev ||
					stat.ino !== observation.exactIdentity.ino ||
					!native.verifyOwnerOnlyFdSecurity(pathname, "file", fd.fd).ok
				)
					return { ...empty, status: "changed" };
			} finally {
				await fd.close();
			}
			const after = await readDoctorFile(pathname, MAX_BYTES);
			if (
				after.status !== "read" ||
				after.exactIdentity.dev !== observation.exactIdentity.dev ||
				after.exactIdentity.ino !== observation.exactIdentity.ino ||
				after.exactIdentity.sha256 !== observation.exactIdentity.sha256 ||
				after.exactIdentity.parentDev !== observation.exactIdentity.parentDev ||
				after.exactIdentity.parentIno !== observation.exactIdentity.parentIno
			)
				return { ...empty, status: "changed" };
		} catch (error) {
			return { ...empty, status: "unreadable", error: doctorErrno(error) };
		}
		const records: DoctorJournalRecord[] = [];
		const malformedLines: number[] = [];
		let selection: string | undefined;
		const lines = observation.text.split("\n");
		for (const [index, line] of lines.entries()) {
			if (!line && index === lines.length - 1) continue;
			try {
				const record = validateRecord(JSON.parse(line));
				if (
					!record ||
					record.runId !== path.basename(run) ||
					index >= MAX_RECORDS ||
					(index === 0 ? record.phase !== "created" : record.phase === "created") ||
					index === lines.length - 1
				)
					throw new Error("invalid_record");
				if (record.phase !== "created") {
					const current = `${record.repairId}\0${record.targetId}`;
					if (selection !== undefined && selection !== current) throw new Error("selection_changed");
					selection = current;
				}
				records.push(record);
			} catch {
				malformedLines.push(index + 1);
			}
		}
		return { status: malformedLines.length ? "malformed" : "ok", records, malformedLines };
	}
}

function comparable(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
	return (
		!!value &&
		(typeof value.value === "boolean" ||
			typeof value.mode === "number" ||
			value.exists === false ||
			["dev", "ino", "parentDev", "parentIno"].every(key => typeof value[key] === "string"))
	);
}

/** Classifies fresh selected-target evidence, never the historical phase by itself. */
export function reconcileDoctorEvidence(
	record: DoctorJournalRecord,
	evidence?: DoctorReconcileEvidence,
): DoctorReconcileOutcome {
	if (
		!evidence ||
		evidence.check.targetId !== record.targetId ||
		evidence.check.execution !== "completed" ||
		evidence.check.evidenceLevel !== "observed"
	)
		return "unknown";
	const current = safeRecord(evidence.current);
	if (!comparable(current)) return "unknown";
	if (typeof current.value === "boolean") {
		const field = record.targetId.endsWith(":autoload") ? "autoload" : "enabled";
		if (evidence.check.evidence[field] !== current.value) return "unknown";
	}
	if (typeof current.exists === "boolean" && evidence.check.evidence.present !== current.exists) return "unknown";
	if (
		typeof current.mode === "number" &&
		(evidence.check.evidence.mode !== (current.mode & 0o777) ||
			evidence.check.evidence.aclCoverage !== "verified" ||
			evidence.check.evidence.ownerMatches !== true)
	)
		return "unknown";
	const equal = (expected: Record<string, unknown> | undefined): boolean =>
		comparable(expected) && Object.entries(expected).every(([key, value]) => current[key] === value);
	if (equal(record.after)) return "verified";
	if (equal(record.before)) return "not_applied";
	return comparable(record.before) || comparable(record.after) ? "conflict" : "unknown";
}

export async function reconcileDoctorJournal(
	pathname: string,
	evidence?: DoctorReconcileEvidence,
): Promise<DoctorJournalRecord | undefined> {
	const result = await DoctorJournal.readDetailed(pathname);
	if (result.status !== "ok") return undefined;
	const record = result.records.at(-1);
	return record ? { ...record, outcome: reconcileDoctorEvidence(record, evidence) } : undefined;
}
