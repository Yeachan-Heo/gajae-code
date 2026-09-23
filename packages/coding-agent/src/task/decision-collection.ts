import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $credentialEnv, getAgentDir, logger, VERSION } from "@gajae-code/utils";
import { z } from "zod";

export type TaskCollectionMode = "metadata" | "content";
export type TaskDecisionOutcomeStatus = "completed" | "error" | "preflight_exhausted" | "cancelled" | "paused";

export interface TaskDecisionBeginInput {
	decisionId?: string;
	role: string;
	taskId: string;
	sessionIdHash: string;
	runMode: string;
	requestedTier?: string;
	requestedSelectors?: readonly string[];
	requestedEffort?: string;
	repoCwdHash: string;
	assignmentHash: string;
	contextHash?: string;
	assignmentCount?: number;
	contextCount?: number;
	assignment?: string;
	context?: string;
}

export interface TaskDecisionModelInput {
	requestedModel?: string;
	actualModel: string;
	effectiveEffort?: string;
	providerReportedModel?: string;
	provider?: string;
}

export interface TaskDecisionOutcomeInput {
	status: TaskDecisionOutcomeStatus;
	exitCode?: number;
	durationMs?: number;
	tokenUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
	costUsd?: number;
	usageCostComplete?: boolean;
	abortReason?: string;
	routingTerminalCode?: string;
	providerEvidence?: string;
	fallbackEvidence?: string;
}

export type TaskDecisionProvider = "kev" | "jev";
export type TaskDecisionMode = "shadow" | "routing";
export type TaskDecisionTier = "fast" | "balanced" | "strong";

export interface TaskDecisionObservationInput {
	observation_id: string;
	provider: TaskDecisionProvider;
	mode: TaskDecisionMode;
	requested_model: string;
	reported_model?: string;
	candidate_tiers: readonly TaskDecisionTier[];
	recommended_tier?: TaskDecisionTier;
	probabilities?: Record<string, number>;
	confidence?: number;
	latency_ms: number;
	error_code?: string;
	effective_selector?: string;
	effective_effort?: string;
	snapshot_hash?: string;
}

export interface TaskDecisionRecorder {
	recordModel(input: TaskDecisionModelInput): Promise<void>;
	recordDecision(input: TaskDecisionObservationInput): Promise<void>;
	finish(input: TaskDecisionOutcomeInput): Promise<void>;
}

export interface TaskDecisionStoreOptions {
	rootDir?: string;
	mode?: TaskCollectionMode | "off";
	decisionEnabled?: boolean;
}

export interface ExportTaskDecisionOptions {
	rootDir?: string;
	includeContent?: boolean;
}

export interface TaskDecisionEvent {
	schema_version: number;
	event_id: string;
	decision_id: string;
	installation_id: string;
	sequence: number;
	event_type: "begin" | "model" | "outcome" | "decision";
	mode: TaskCollectionMode;
	created_at_ms: number;
	[key: string]: unknown;
}

const SCHEMA_VERSION = 1;
const DB_FILENAME = "task-decisions.db";
const MAX_CONTENT = 4096;
const BUSY_TIMEOUT_MS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const count = z.number().finite().nonnegative();
const text = z.string();
const beginPayloadSchema = z
	.object({
		gjc_version: text,
		role: text,
		task_id: text,
		session_id_hash: text,
		run_mode: z.enum(["initial", "resume", "message"]),
		requested_tier: text.optional(),
		requested_selectors: z.array(text).optional(),
		requested_effort: text.optional(),
		repo_cwd_hash: text,
		assignment_hash: text,
		context_hash: text.optional(),
		assignment_count: count.optional(),
		context_count: count.optional(),
		assignment: text.max(MAX_CONTENT).optional(),
		context: text.max(MAX_CONTENT).optional(),
		assignment_truncated: z.boolean().optional(),
		context_truncated: z.boolean().optional(),
	})
	.strict();
const modelPayloadSchema = z
	.object({
		requestedModel: text.optional(),
		actualModel: text,
		effectiveEffort: text.optional(),
		providerReportedModel: text.optional(),
		provider: text.optional(),
	})
	.strict();
const outcomePayloadSchema = z
	.object({
		status: z.enum(["completed", "error", "preflight_exhausted", "cancelled", "paused"]),
		exitCode: z.number().int().optional(),
		durationMs: count.optional(),
		tokenUsage: z
			.object({
				input: count.optional(),
				output: count.optional(),
				cacheRead: count.optional(),
				cacheWrite: count.optional(),
				total: count.optional(),
			})
			.strict()
			.optional(),
		costUsd: count.optional(),
		usageCostComplete: z.boolean().optional(),
		abortReason: text.optional(),
		routingTerminalCode: text.optional(),
		providerEvidence: text.optional(),
		fallbackEvidence: text.optional(),
	})
	.strict();
const decisionObservationSchema = z
	.object({
		observation_id: z.string().regex(UUID_RE),
		provider: z.enum(["kev", "jev"]),
		decision_mode: z.enum(["shadow", "routing"]),
		requested_model: z.string().max(256),
		reported_model: z.string().max(256).optional(),
		candidate_tiers: z.array(z.enum(["fast", "balanced", "strong"])).max(3),
		recommended_tier: z.enum(["fast", "balanced", "strong"]).optional(),
		probabilities: z
			.partialRecord(z.enum(["fast", "balanced", "strong"]), z.number().finite().min(0).max(1))
			.optional(),
		confidence: z.number().finite().min(0).max(1).optional(),
		latency_ms: z.number().finite().nonnegative(),
		error_code: z.string().max(128).optional(),
		effective_selector: z.string().max(256).optional(),
		effective_effort: z.string().max(128).optional(),
		snapshot_hash: z.string().max(128).optional(),
	})
	.strict();
const decisionPayloadSchema = decisionObservationSchema.extend({ late: z.boolean() }).superRefine((value, ctx) => {
	if (new Set(value.candidate_tiers).size !== value.candidate_tiers.length) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["candidate_tiers"], message: "duplicate candidate tier" });
	}
	if (value.recommended_tier !== undefined && !value.candidate_tiers.includes(value.recommended_tier)) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recommended_tier"], message: "tier is not a candidate" });
	}
	if (value.recommended_tier !== undefined) {
		if (!value.probabilities) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["probabilities"], message: "probabilities required" });
		} else {
			const keys = Object.keys(value.probabilities).sort();
			const candidates = [...value.candidate_tiers].sort();
			if (keys.join("\0") !== candidates.join("\0")) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["probabilities"], message: "probability set mismatch" });
			}
			const sum = Object.values(value.probabilities).reduce<number>(
				(total, probability) => total + (probability ?? 0),
				0,
			);
			if (Math.abs(sum - 1) > 1e-6) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["probabilities"],
					message: "probabilities must sum to one",
				});
			}
		}
	}
});

function resolveMode(options?: TaskDecisionStoreOptions): TaskCollectionMode | undefined {
	const disabled = $credentialEnv("GJC_DISABLE_TELEMETRY");
	if (/^(?:1|true|yes|on)$/iu.test(disabled ?? "")) return undefined;
	const configured = $credentialEnv("GJC_TASK_COLLECTION");
	if (configured === "metadata" || configured === "content") return configured;
	if (configured !== undefined) return undefined;
	if (options?.mode === "off") return undefined;
	if (options?.mode === "metadata" || options?.mode === "content") return options.mode;
	return undefined;
}

function defaultRoot(): string {
	return path.join(getAgentDir(), "task-decisions");
}

function dbPath(rootDir: string): string {
	return path.join(rootDir, DB_FILENAME);
}

function hashValue(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function boundedContent(value: string | undefined): { value?: string; truncated?: boolean } {
	if (value === undefined) return {};
	if (value.length <= MAX_CONTENT) return { value, truncated: false };
	return { value: value.slice(0, MAX_CONTENT), truncated: true };
}

async function ensureSafeRoot(rootDir: string): Promise<void> {
	try {
		const stat = await fs.lstat(rootDir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe storage root");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
	}
	await fs.chmod(rootDir, 0o700);
	const file = dbPath(rootDir);
	for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
		try {
			const stat = await fs.lstat(candidate);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe storage file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function initializeDatabase(db: Database): void {
	db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
	db.run("CREATE TABLE IF NOT EXISTS collection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const version = db.prepare("SELECT value FROM collection_meta WHERE key = 'schema_version'").get() as
		| { value?: string }
		| undefined;
	if (version && Number(version.value) !== SCHEMA_VERSION) throw new Error("task decision schema mismatch");
	db.prepare("INSERT OR IGNORE INTO collection_meta(key, value) VALUES ('schema_version', ?)").run(
		String(SCHEMA_VERSION),
	);
	db.prepare("INSERT OR IGNORE INTO collection_meta(key, value) VALUES ('installation_id', ?)").run(randomUUID());
	db.run(`CREATE TABLE IF NOT EXISTS events (
		event_id TEXT PRIMARY KEY NOT NULL,
		decision_id TEXT NOT NULL,
		installation_id TEXT NOT NULL,
		sequence INTEGER NOT NULL,
		event_type TEXT NOT NULL,
		mode TEXT NOT NULL,
		created_at_ms INTEGER NOT NULL,
		payload_json TEXT NOT NULL,
		UNIQUE(decision_id, sequence)
	)`);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS decision_observation_unique ON events(decision_id, json_extract(payload_json, '$.observation_id')) WHERE event_type = 'decision'",
	);
}

function openDatabase(rootDir: string): { db: Database; installationId: string } {
	const db = new Database(dbPath(rootDir), { create: true, strict: true });
	try {
		initializeDatabase(db);
		fsSync.chmodSync(dbPath(rootDir), 0o600);
		const row = db.prepare("SELECT value FROM collection_meta WHERE key = 'installation_id'").get() as {
			value: string;
		};
		return { db, installationId: row.value };
	} catch (error) {
		try {
			db.close();
		} catch {
			/* best effort */
		}
		throw error;
	}
}

function openExistingDatabase(rootDir: string): { db: Database; installationId: string } {
	const file = dbPath(rootDir);
	const rootStat = fsSync.lstatSync(rootDir);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe storage root");
	const fileStat = fsSync.lstatSync(file);
	if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("unsafe database path");
	for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
		try {
			const sidecarStat = fsSync.lstatSync(sidecar);
			if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) throw new Error("unsafe database sidecar");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const db = new Database(file, { create: false, strict: true });
	try {
		db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		const version = db.prepare("SELECT value FROM collection_meta WHERE key = 'schema_version'").get() as
			| { value?: string }
			| undefined;
		if (!version || Number(version.value) !== SCHEMA_VERSION) throw new Error("task decision schema mismatch");
		const row = db.prepare("SELECT value FROM collection_meta WHERE key = 'installation_id'").get() as
			| { value?: string }
			| undefined;
		if (!row?.value || !UUID_RE.test(row.value)) throw new Error("invalid task decision installation");
		return { db, installationId: row.value };
	} catch (error) {
		try {
			db.close();
		} catch {
			/* best effort */
		}
		throw error;
	}
}

function nextSequence(db: Database, decisionId: string): number {
	const row = db
		.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM events WHERE decision_id = ?")
		.get(decisionId) as {
		next: number;
	};
	return row.next;
}

function appendEvent(
	db: Database,
	installationId: string,
	mode: TaskCollectionMode,
	decisionId: string,
	eventType: TaskDecisionEvent["event_type"],
	payload: Record<string, unknown>,
): void {
	const schema =
		eventType === "begin"
			? beginPayloadSchema
			: eventType === "model"
				? modelPayloadSchema
				: eventType === "outcome"
					? outcomePayloadSchema
					: decisionPayloadSchema;
	const validated = schema.parse(payload);
	db.run("BEGIN IMMEDIATE");
	try {
		const sequence = nextSequence(db, decisionId);
		db.prepare(
			"INSERT INTO events(event_id, decision_id, installation_id, sequence, event_type, mode, created_at_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(randomUUID(), decisionId, installationId, sequence, eventType, mode, Date.now(), JSON.stringify(validated));
		db.run("COMMIT");
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

function warnStorageFailure(error: unknown): void {
	logger.warn("task decision collection storage unavailable", {
		kind: error instanceof Error ? error.name : "unknown",
	});
}

export async function beginTaskDecision(
	input: TaskDecisionBeginInput,
	options?: TaskDecisionStoreOptions,
): Promise<TaskDecisionRecorder | undefined> {
	const mode = resolveMode(options);
	if (!mode) return undefined;
	const rootDir = options?.rootDir ?? defaultRoot();
	let opened: { db: Database; installationId: string } | undefined;
	try {
		await ensureSafeRoot(rootDir);
		opened = openDatabase(rootDir);
		const payload: Record<string, unknown> = {
			gjc_version: VERSION,
			role: input.role,
			task_id: input.taskId,
			session_id_hash: input.sessionIdHash,
			run_mode: input.runMode,
			requested_tier: input.requestedTier,
			requested_selectors: input.requestedSelectors,
			requested_effort: input.requestedEffort,
			repo_cwd_hash: input.repoCwdHash,
			assignment_hash: input.assignmentHash,
			context_hash: input.contextHash,
			assignment_count: input.assignmentCount,
			context_count: input.contextCount,
		};
		if (mode === "content") {
			const assignment = boundedContent(input.assignment);
			const context = boundedContent(input.context);
			payload.assignment = assignment.value;
			payload.assignment_truncated = assignment.truncated ?? false;
			payload.context = context.value;
			payload.context_truncated = context.truncated ?? false;
		}
		const decisionId = input.decisionId && UUID_RE.test(input.decisionId) ? input.decisionId : randomUUID();
		appendEvent(opened.db, opened.installationId, mode, decisionId, "begin", payload);
		const { db, installationId } = opened;
		let finished = false;
		return {
			recordModel: async model => {
				if (finished) return;
				try {
					appendEvent(db, installationId, mode, decisionId, "model", { ...model });
				} catch (error) {
					warnStorageFailure(error);
				}
			},
			recordDecision: async observation => {
				try {
					const { mode: decisionMode, ...fields } = observation;
					const validated = decisionObservationSchema.parse({
						...fields,
						decision_mode: decisionMode,
					});
					try {
						const stat = await fs.lstat(dbPath(rootDir));
						if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe database path");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
						throw error;
					}
					const separate = openExistingDatabase(rootDir);
					try {
						if (separate.installationId !== installationId) return;
						separate.db.run("BEGIN IMMEDIATE");
						const begin = separate.db
							.prepare(
								"SELECT 1 FROM events WHERE decision_id = ? AND installation_id = ? AND event_type = 'begin' LIMIT 1",
							)
							.get(decisionId, installationId);
						if (!begin) {
							separate.db.run("ROLLBACK");
							return;
						}
						const duplicate = separate.db
							.prepare(
								"SELECT 1 FROM events WHERE decision_id = ? AND event_type = 'decision' AND json_extract(payload_json, '$.observation_id') = ? LIMIT 1",
							)
							.get(decisionId, validated.observation_id);
						if (duplicate) {
							separate.db.run("ROLLBACK");
							return;
						}
						const late = Boolean(
							separate.db
								.prepare(
									"SELECT 1 FROM events WHERE decision_id = ? AND installation_id = ? AND event_type = 'outcome' LIMIT 1",
								)
								.get(decisionId, installationId),
						);
						const sequence = nextSequence(separate.db, decisionId);
						const payload = decisionPayloadSchema.parse({ ...validated, late });
						separate.db
							.prepare(
								"INSERT INTO events(event_id, decision_id, installation_id, sequence, event_type, mode, created_at_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
							)
							.run(
								randomUUID(),
								decisionId,
								installationId,
								sequence,
								"decision",
								mode,
								Date.now(),
								JSON.stringify(payload),
							);
						separate.db.run("COMMIT");
					} catch (error) {
						try {
							separate.db.run("ROLLBACK");
						} catch {
							/* best effort */
						}
						throw error;
					} finally {
						separate.db.close();
					}
				} catch (error) {
					warnStorageFailure(error);
				}
			},
			finish: async outcome => {
				if (finished) return;
				finished = true;
				try {
					appendEvent(db, installationId, mode, decisionId, "outcome", { ...outcome });
				} catch (error) {
					warnStorageFailure(error);
				} finally {
					try {
						db.close();
					} catch (error) {
						warnStorageFailure(error);
					}
				}
			},
		};
	} catch (error) {
		warnStorageFailure(error);
		try {
			opened?.db.close();
		} catch {
			// best effort
		}
		return undefined;
	}
}

export async function exportTaskDecisionEvents(options?: ExportTaskDecisionOptions): Promise<TaskDecisionEvent[]> {
	const rootDir = options?.rootDir ?? defaultRoot();
	const file = dbPath(rootDir);
	try {
		const rootStat = await fs.lstat(rootDir);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe storage root");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe database path");
		for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
			try {
				const sidecarStat = await fs.lstat(sidecar);
				if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) throw new Error("unsafe database sidecar");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const db = new Database(file, { readonly: true, strict: true });
	try {
		db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		const version = db.prepare("SELECT value FROM collection_meta WHERE key = 'schema_version'").get() as
			| { value?: string }
			| undefined;
		if (!version || Number(version.value) !== SCHEMA_VERSION) throw new Error("task decision schema mismatch");
		const rows = db
			.prepare(
				"SELECT event_id, decision_id, installation_id, sequence, event_type, mode, created_at_ms, payload_json FROM events ORDER BY rowid ASC",
			)
			.all() as Array<Record<string, unknown>>;
		return rows.map(row => {
			if (
				!UUID_RE.test(String(row.event_id)) ||
				!UUID_RE.test(String(row.decision_id)) ||
				!UUID_RE.test(String(row.installation_id)) ||
				!Number.isInteger(Number(row.sequence)) ||
				Number(row.sequence) < 0 ||
				!["begin", "model", "outcome", "decision"].includes(String(row.event_type)) ||
				!["metadata", "content"].includes(String(row.mode)) ||
				!Number.isFinite(Number(row.created_at_ms))
			) {
				throw new Error("invalid task decision envelope");
			}
			const schema =
				row.event_type === "begin"
					? beginPayloadSchema
					: row.event_type === "model"
						? modelPayloadSchema
						: row.event_type === "outcome"
							? outcomePayloadSchema
							: decisionPayloadSchema;
			const payload: Record<string, unknown> = schema.parse(JSON.parse(String(row.payload_json)));
			if (row.mode === "metadata" && (payload.assignment !== undefined || payload.context !== undefined)) {
				throw new Error("unexpected content in metadata event");
			}
			if (!options?.includeContent) {
				delete payload.assignment;
				delete payload.context;
			}
			return {
				...payload,
				schema_version: SCHEMA_VERSION,
				event_id: String(row.event_id),
				decision_id: String(row.decision_id),
				installation_id: String(row.installation_id),
				sequence: Number(row.sequence),
				event_type: row.event_type as TaskDecisionEvent["event_type"],
				mode: row.mode as TaskCollectionMode,
				created_at_ms: Number(row.created_at_ms),
			};
		});
	} finally {
		db.close();
	}
}

export function hashTaskDecisionValue(value: string): string {
	return hashValue(value);
}

export const TASK_DECISION_DB_FILENAME = DB_FILENAME;
