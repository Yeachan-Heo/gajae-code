import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FileLockOptions, withFileLock } from "../config/file-lock";
import type { ActiveSubskillEntry, SkillActiveEntry, SkillActiveState } from "../skill-state/active-state";
import {
	type AuditEntry,
	buildWorkflowStateReceipt,
	type CanonicalGjcWorkflowSkill,
	type WorkflowStateMutationOwner,
	type WorkflowStateReceipt,
} from "../skill-state/workflow-state-contract";
import {
	activeEntryPath as layoutActiveEntryPath,
	activeSnapshotPath as layoutActiveSnapshotPath,
	activeStateDir as layoutActiveStateDir,
	auditPath as layoutAuditPath,
	transactionJournalPath as layoutTransactionJournalPath,
} from "./session-layout";
import { RequiredOnWriteEnvelopeSchema } from "./state-schema";

/**
 * Sole sanctioned project `.gjc/**` writer module (gate G1).
 *
 * All native `.gjc/**` filesystem mutations must route through these primitives.
 * The primitives validate project `.gjc/**` ownership, create parent directories,
 * and emit workflow receipts or audit entries where applicable by the caller's
 * supplied mutation context. No lockfiles are used; isolation is by atomic rename,
 * append, O_EXCL creates, conditional deletes, per-entry active-state files,
 * and derived active-state snapshots.
 * Transaction journals are per mutation id under the session state transactions directory;
 * they are recovery evidence only, never global locks or waiters, so stale
 * journals do not block unrelated state reads or writes.
 */

export type WriterCategory =
	| "state"
	| "artifact"
	| "ledger"
	| "log"
	| "report"
	| "agents"
	| "prune"
	| "force"
	| "transaction";

export interface StateWriterReceiptContext {
	cwd?: string;
	skill: CanonicalGjcWorkflowSkill;
	owner: WorkflowStateMutationOwner;
	command: string;
	sessionId: string;
	mutationId?: string;
	nowIso?: string;
	verb?: string;
	fromPhase?: string;
	toPhase?: string;
	forced?: boolean;
}

export interface StateWriterAuditContext {
	cwd?: string;
	sessionId?: string;
	category: WriterCategory;
	verb: string;
	owner: WorkflowStateMutationOwner;
	skill?: CanonicalGjcWorkflowSkill | string;
	mutationId?: string;
	fromPhase?: string;
	toPhase?: string;
	forced?: boolean;
}

export interface WorkflowEnvelopeIntegrityMismatch {
	path: string;
	expected: string;
	actual: string;
}

export interface WorkflowTransactionJournal {
	version: 1;
	mutation_id: string;
	status: "pending" | "committed";
	created_at: string;
	updated_at: string;
	caller?: CanonicalGjcWorkflowSkill;
	callee?: CanonicalGjcWorkflowSkill;
	paths: string[];
	steps: string[];
}

export type StateWritePolicy = "source" | "cache";

export interface GuardedStateWriterOptions extends StateWriterOptions {
	policy: StateWritePolicy;
	expectedRevision?: number;
	sourceRevision?: number;
}

export type GuardedWriteResult =
	| { path: string; written: true; revision: number; stamped: unknown }
	| { path: string; written: false; reason: "stale-skip"; revision: number };

export interface StateWriterOptions {
	cwd?: string;
	receipt?: StateWriterReceiptContext;
	audit?: StateWriterAuditContext;
	sourceRevision?: number;
	/**
	 * Cross-process lock tuning for read-modify-write paths that route through
	 * `withWorkflowStateLock` / `updateJsonAtomic`. Omit for the hardened
	 * `withFileLock` defaults.
	 */
	lock?: FileLockOptions;
}

export class StateWriteConflictError extends Error {
	constructor(
		public readonly path: string,
		public readonly expectedRevision: number,
		public readonly persistedRevision: number,
	) {
		super(
			`state write conflict at ${path}: expected revision ${expectedRevision}, persisted revision ${persistedRevision}`,
		);
		this.name = "StateWriteConflictError";
	}
}

export interface DeleteIfOwnedOptions extends StateWriterOptions {
	predicate?: (current: unknown) => boolean | Promise<boolean>;
}

export interface DeleteResult {
	path: string;
	deleted: boolean;
}

export interface ActiveSessionScope {
	sessionId?: string;
}

export interface ActiveEntryWriteResult {
	entryPath: string;
	snapshotPath: string;
}

export interface HardPruneSelectorContext {
	path: string;
	value: unknown;
}

export interface GenericHardPruneTarget {
	path: string;
	category: WriterCategory | string;
}

export interface GenericHardPruneSelectorContext {
	path: string;
	category: WriterCategory | string;
	stat: Stats;
	readJson: () => Promise<unknown>;
}

export type GenericHardPruneSelector = (context: GenericHardPruneSelectorContext) => boolean | Promise<boolean>;

export interface ForceOverwriteOptions extends StateWriterOptions {
	raw?: boolean;
}

export type HardPruneSelector = (context: HardPruneSelectorContext) => boolean | Promise<boolean>;

export class AlreadyExistsError extends Error {
	constructor(public readonly path: string) {
		super(`file already exists: ${path}`);
		this.name = "AlreadyExistsError";
	}
}

export type StrictMutationReadResult =
	| { kind: "absent" }
	| { kind: "corrupt"; error: string }
	| { kind: "valid"; value: Record<string, unknown> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function readExistingStateForMutation(filePath: string): Promise<StrictMutationReadResult> {
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (isPlainObject(parsed)) return { kind: "valid", value: parsed };
		return { kind: "corrupt", error: "state file must contain a JSON object" };
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { kind: "absent" };
		return { kind: "corrupt", error: err.message };
	}
}
function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function cwdForOptions(options?: StateWriterOptions): string {
	return path.resolve(options?.cwd ?? process.cwd());
}

function resolveGjcTarget(targetPath: string, cwd = process.cwd()): string {
	if (!targetPath.trim()) throw new Error("targetPath is required");
	const projectRoot = path.resolve(cwd);
	const gjcRoot = path.join(projectRoot, ".gjc");
	const resolved = path.resolve(projectRoot, targetPath);
	const relative = path.relative(gjcRoot, resolved);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`target path must be within project .gjc/**: ${targetPath}`);
	}
	return resolved;
}

function tempPathFor(filePath: string): string {
	return `${filePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
}

function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeJson);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const v = (value as Record<string, unknown>)[key];
		if (v !== undefined) out[key] = canonicalizeJson(v);
	}
	return out;
}

function withoutReceiptChecksum(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const clone: Record<string, unknown> = { ...(value as Record<string, unknown>) };
	if (clone.receipt && typeof clone.receipt === "object" && !Array.isArray(clone.receipt)) {
		const receipt = { ...(clone.receipt as Record<string, unknown>) };
		delete receipt.content_sha256;
		clone.receipt = receipt;
	}
	return clone;
}

export function workflowEnvelopeContentSha256(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalizeJson(withoutReceiptChecksum(value))))
		.digest("hex");
}

export function stampWorkflowEnvelopeChecksum<T>(value: T, filePath: string, computedAt = new Date().toISOString()): T {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const envelope = { ...(value as Record<string, unknown>) };
	const receipt =
		envelope.receipt && typeof envelope.receipt === "object" && !Array.isArray(envelope.receipt)
			? { ...(envelope.receipt as Record<string, unknown>) }
			: {};
	envelope.receipt = {
		...receipt,
		content_sha256: {
			algorithm: "sha256",
			value: workflowEnvelopeContentSha256(envelope),
			covered_path: path.resolve(filePath),
			computed_at: computedAt,
		},
	};
	return envelope as T;
}

export async function detectWorkflowEnvelopeIntegrityMismatch(
	filePath: string,
): Promise<WorkflowEnvelopeIntegrityMismatch | undefined> {
	const current = await readJsonIfPresent(filePath);
	if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
	const receipt = (current as Record<string, unknown>).receipt;
	if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
	const checksum = (receipt as Record<string, unknown>).content_sha256;
	if (!checksum || typeof checksum !== "object" || Array.isArray(checksum)) return undefined;
	const expected = (checksum as Record<string, unknown>).value;
	if (typeof expected !== "string" || !expected) return undefined;
	const actual = workflowEnvelopeContentSha256(current);
	return actual === expected ? undefined : { path: filePath, expected, actual };
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function requireSessionId(sessionScope: string | ActiveSessionScope | undefined, source: string): string {
	const sessionId = typeof sessionScope === "string" ? sessionScope : sessionScope?.sessionId;
	const normalizedSessionId = safeString(sessionId).trim();
	if (!normalizedSessionId) throw new Error(`a non-empty GJC session id is required (${source})`);
	return normalizedSessionId;
}

function activeStateDir(cwd: string, sessionScope?: string | ActiveSessionScope): string {
	return layoutActiveStateDir(cwd, requireSessionId(sessionScope, "activeStateDir"));
}

type ActiveStateCacheInvalidator = (cwd?: string, sessionId?: string) => void;
var activeStateCacheInvalidator: ActiveStateCacheInvalidator | undefined;

export function setActiveStateCacheInvalidator(invalidator: ActiveStateCacheInvalidator): void {
	activeStateCacheInvalidator = invalidator;
}

function invalidateActiveStateCacheForScope(cwd: string, sessionScope?: string | ActiveSessionScope): void {
	const sessionId = typeof sessionScope === "string" ? sessionScope : sessionScope?.sessionId;
	activeStateCacheInvalidator?.(cwd, sessionId);
}

function activeSnapshotPath(cwd: string, sessionScope?: string | ActiveSessionScope): string {
	return layoutActiveSnapshotPath(cwd, requireSessionId(sessionScope, "activeSnapshotPath"));
}

function activeEntryPath(cwd: string, sessionScope: string | ActiveSessionScope | undefined, skill: string): string {
	return layoutActiveEntryPath(cwd, requireSessionId(sessionScope, "activeEntryPath"), skill);
}

function activeSubskillKey(entry: ActiveSubskillEntry): string {
	return `${entry.parent}::${entry.phase}::${entry.activationArg}`;
}

function flattenActiveSubskills(entries: SkillActiveEntry[]): ActiveSubskillEntry[] {
	const deduped = new Map<string, ActiveSubskillEntry>();
	for (const entry of entries) {
		if (entry.active === false || !Array.isArray(entry.active_subskills)) continue;
		for (const subskill of entry.active_subskills) {
			deduped.set(activeSubskillKey(subskill), subskill);
		}
	}
	return [...deduped.values()];
}

const CANONICAL_PIPELINE_RANK = new Map<string, number>([
	["deep-interview", 0],
	["ralplan", 1],
	["ultragoal", 2],
]);

function canonicalPipelineRank(skill: string): number | undefined {
	return CANONICAL_PIPELINE_RANK.get(skill);
}

function compareActiveEntryPrimary(a: SkillActiveEntry, b: SkillActiveEntry): number {
	const aRank = canonicalPipelineRank(a.skill);
	const bRank = canonicalPipelineRank(b.skill);
	if (aRank !== undefined || bRank !== undefined) return (bRank ?? -1) - (aRank ?? -1);
	const aTime = Date.parse(safeString(a.updated_at));
	const bTime = Date.parse(safeString(b.updated_at));
	if (Number.isFinite(aTime) || Number.isFinite(bTime)) return (bTime || 0) - (aTime || 0);
	return 0;
}

function buildActiveSnapshot(entries: SkillActiveEntry[]): SkillActiveState {
	const visible = entries.filter(entry => entry.active !== false).toSorted(compareActiveEntryPrimary);
	const primary = visible[0];
	return {
		version: 1,
		active: visible.length > 0,
		skill: primary?.skill ?? "",
		phase: primary?.phase ?? "",
		updated_at: primary?.updated_at ?? "",
		session_id: primary?.session_id,
		thread_id: primary?.thread_id,
		turn_id: primary?.turn_id,
		active_skills: entries,
		active_subskills: flattenActiveSubskills(visible),
	};
}

async function atomicRemove(filePath: string): Promise<boolean> {
	const tmpPath = tempPathFor(filePath);
	try {
		await fs.rename(filePath, tmpPath);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return false;
		throw error;
	}
	await fs.rm(tmpPath, { force: true });
	return true;
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf-8"));
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}

// Corrupt-tolerant variant for the guarded writers' revision computation: a prior
// file that is unparseable has no usable revision, so treat it as absent (revision 0)
// rather than throwing. This lets an authoritative/forced write overwrite corrupt
// state and a derived cache write overwrite (not stale-skip) corrupt cache.
async function readJsonIfPresentTolerant(filePath: string): Promise<unknown | undefined> {
	try {
		return await readJsonIfPresent(filePath);
	} catch {
		return undefined;
	}
}

export function persistedStateRevision(value: unknown): number {
	if (!isPlainObject(value)) return 0;
	const revision = value.state_revision;
	return typeof revision === "number" && Number.isFinite(revision) ? revision : 0;
}

function persistedSourceRevision(value: unknown): number {
	if (!isPlainObject(value)) return 0;
	const revision = value.source_state_revision;
	return typeof revision === "number" && Number.isFinite(revision) ? revision : persistedStateRevision(value);
}

function withoutCandidateRevision(value: unknown): unknown {
	if (!isPlainObject(value)) return value;
	const next = { ...value };
	delete next.state_revision;
	return next;
}

function stampStateRevision(value: unknown, stateRevision: number, sourceRevision?: number): unknown {
	if (!isPlainObject(value)) return value;
	const next = withoutCandidateRevision(value) as Record<string, unknown>;
	return {
		...next,
		...(sourceRevision === undefined ? {} : { source_state_revision: sourceRevision }),
		state_revision: stateRevision,
	};
}

function withWorkflowReceipt(value: unknown, receipt: WorkflowStateReceipt | undefined): unknown {
	if (!receipt || !value || typeof value !== "object" || Array.isArray(value)) return value;
	return { ...(value as Record<string, unknown>), receipt };
}

function stampWorkflowEnvelopeRevisionAndChecksum(
	value: unknown,
	filePath: string,
	stateRevision: number,
	sourceRevision: number | undefined,
	options: StateWriterOptions | undefined,
): unknown {
	return stampWorkflowEnvelopeChecksum(
		stampStateRevision(withWorkflowReceipt(value, buildReceipt(options)), stateRevision, sourceRevision),
		filePath,
	);
}

function buildReceipt(options: StateWriterOptions | undefined): WorkflowStateReceipt | undefined {
	if (!options?.receipt) return undefined;
	const receipt = buildWorkflowStateReceipt({
		cwd: path.resolve(options.receipt.cwd ?? options.cwd ?? process.cwd()),
		skill: options.receipt.skill,
		owner: options.receipt.owner,
		command: options.receipt.command,
		sessionId: options.receipt.sessionId,
		nowIso: options.receipt.nowIso,
		mutationId: options.receipt.mutationId,
	});
	receipt.verb = options.receipt.verb;
	receipt.from_phase = options.receipt.fromPhase;
	receipt.to_phase = options.receipt.toPhase;
	receipt.forced = options.receipt.forced;
	return receipt;
}

async function maybeAudit(mutatedPath: string, options?: StateWriterOptions): Promise<void> {
	if (!options?.audit) return;
	const audit = options.audit;
	const cwd = path.resolve(audit.cwd ?? options.cwd ?? process.cwd());
	await appendAuditEntry(cwd, options?.audit?.sessionId ?? "", {
		ts: new Date().toISOString(),
		skill: audit.skill,
		category: audit.category,
		verb: audit.verb,
		owner: audit.owner,
		mutation_id: audit.mutationId ?? randomUUID(),
		from_phase: audit.fromPhase,
		to_phase: audit.toPhase,
		forced: audit.forced ?? false,
		paths: [mutatedPath],
	});
}

async function atomicWrite(filePath: string, content: string): Promise<string> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = tempPathFor(filePath);
	try {
		await fs.writeFile(tmpPath, content, "utf-8");
		await fs.rename(tmpPath, filePath);
	} catch (error) {
		await fs.rm(tmpPath, { force: true }).catch(() => undefined);
		throw error;
	}
	return filePath;
}

async function writeGuardedResolvedJsonAtomic(
	filePath: string,
	value: unknown,
	options: GuardedStateWriterOptions,
): Promise<GuardedWriteResult> {
	return lockResolvedWorkflowTarget(
		filePath,
		async () => {
			const current = await readJsonIfPresentTolerant(filePath);
			const currentRevision = persistedStateRevision(current);

			if (options.policy === "source") {
				if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
					throw new StateWriteConflictError(filePath, options.expectedRevision, currentRevision);
				}
				const next = stampStateRevision(withWorkflowReceipt(value, buildReceipt(options)), currentRevision + 1);
				await atomicWrite(filePath, jsonText(next));
				await maybeAudit(filePath, options);
				return { path: filePath, written: true, revision: currentRevision + 1, stamped: next };
			}

			const incomingSourceRevision =
				options.sourceRevision ?? (isPlainObject(value) ? persistedStateRevision(value) : 0);
			if (current !== undefined && incomingSourceRevision <= persistedSourceRevision(current)) {
				return { path: filePath, written: false, reason: "stale-skip", revision: currentRevision };
			}
			const next = stampStateRevision(
				withWorkflowReceipt(value, buildReceipt(options)),
				currentRevision + 1,
				incomingSourceRevision,
			);
			await atomicWrite(filePath, jsonText(next));
			await maybeAudit(filePath, options);
			return { path: filePath, written: true, revision: currentRevision + 1, stamped: next };
		},
		options.lock,
	);
}

export async function writeGuardedJsonAtomic(
	targetPath: string,
	value: unknown,
	options: GuardedStateWriterOptions,
): Promise<GuardedWriteResult> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	return writeGuardedResolvedJsonAtomic(filePath, value, options);
}

export async function writeGuardedWorkflowEnvelopeAtomic(
	targetPath: string,
	value: unknown,
	options: GuardedStateWriterOptions,
): Promise<GuardedWriteResult> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	return lockResolvedWorkflowTarget(
		filePath,
		async () => {
			const current = await readJsonIfPresentTolerant(filePath);
			const currentRevision = persistedStateRevision(current);

			if (options.policy === "source") {
				if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
					throw new StateWriteConflictError(filePath, options.expectedRevision, currentRevision);
				}
				const next = stampWorkflowEnvelopeRevisionAndChecksum(
					value,
					filePath,
					currentRevision + 1,
					undefined,
					options,
				);
				const parsed = RequiredOnWriteEnvelopeSchema.safeParse(next);
				if (!parsed.success) {
					throw new Error(
						`Refusing to write invalid workflow state envelope to ${filePath}: ${parsed.error.issues
							.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
							.join("; ")}`,
					);
				}
				await atomicWrite(filePath, jsonText(next));
				await maybeAudit(filePath, options);
				return { path: filePath, written: true, revision: currentRevision + 1, stamped: next };
			}

			const incomingSourceRevision =
				options.sourceRevision ?? (isPlainObject(value) ? persistedStateRevision(value) : 0);
			if (current !== undefined && incomingSourceRevision <= persistedSourceRevision(current)) {
				return { path: filePath, written: false, reason: "stale-skip", revision: currentRevision };
			}
			const next = stampWorkflowEnvelopeRevisionAndChecksum(
				value,
				filePath,
				currentRevision + 1,
				incomingSourceRevision,
				options,
			);
			const parsed = RequiredOnWriteEnvelopeSchema.safeParse(next);
			if (!parsed.success) {
				throw new Error(
					`Refusing to write invalid workflow state envelope to ${filePath}: ${parsed.error.issues
						.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
						.join("; ")}`,
				);
			}
			await atomicWrite(filePath, jsonText(next));
			await maybeAudit(filePath, options);
			return { path: filePath, written: true, revision: currentRevision + 1, stamped: next };
		},
		options.lock,
	);
}

export async function writeJsonAtomic(
	targetPath: string,
	value: unknown,
	options?: StateWriterOptions,
): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	await atomicWrite(filePath, jsonText(withWorkflowReceipt(value, buildReceipt(options))));
	await maybeAudit(filePath, options);
	return filePath;
}

async function readPersistedPhase(filePath: string): Promise<string | undefined> {
	try {
		const existing = await readJsonIfPresent(filePath);
		if (!isPlainObject(existing)) return undefined;
		// Only an *active* prior envelope is a transition source. A cleared / handed-off
		// envelope (`active: false`, terminal phase such as `complete` / `handoff`) is outside
		// active workflow progression, so reactivation from it (e.g. a fresh kickoff) must not
		// be reported as an invalid transition.
		if (existing.active !== true) return undefined;
		const phase = existing.current_phase;
		return typeof phase === "string" ? phase : undefined;
	} catch {
		// Best-effort diagnostic read: a corrupt/unreadable prior envelope simply yields no
		// `from` phase, so the transition invariant degrades to a no-op rather than failing
		// the sanctioned write it is observing.
		return undefined;
	}
}

async function recordInvalidWorkflowTransition(args: {
	filePath: string;
	skill: CanonicalGjcWorkflowSkill;
	fromPhase: string;
	toPhase: string;
	options?: StateWriterOptions;
}): Promise<void> {
	const { filePath, skill, fromPhase, toPhase, options } = args;
	// Audit-only diagnostic: a successful sanctioned write must NOT emit to stderr — callers
	// may treat any stderr output as failure or parse stdout/stderr as machine output. The
	// `invalid_transition_detected` audit entry is the durable, non-intrusive evidence that an
	// internal write skipped a manifest edge.
	const cwd = path.resolve(options?.audit?.cwd ?? options?.cwd ?? process.cwd());
	try {
		await appendAuditEntry(cwd, options?.audit?.sessionId ?? "", {
			ts: new Date().toISOString(),
			skill,
			category: "state",
			verb: "invalid_transition_detected",
			owner: options?.audit?.owner ?? "gjc-runtime",
			mutation_id: options?.audit?.mutationId ?? `${skill}:invalid-transition:${new Date().toISOString()}`,
			from_phase: fromPhase,
			to_phase: toPhase,
			forced: false,
			paths: [filePath],
		});
	} catch {
		// Audit logging is best-effort diagnostics; never fail a sanctioned write because the
		// audit append failed (e.g. cwd is not a writable project root).
	}
}

export async function writeWorkflowEnvelopeAtomic(
	targetPath: string,
	value: unknown,
	options?: StateWriterOptions,
): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	const withReceipt = withWorkflowReceipt(value, buildReceipt(options));
	const stamped = stampWorkflowEnvelopeChecksum(withReceipt, filePath);
	const parsed = RequiredOnWriteEnvelopeSchema.safeParse(stamped);
	if (!parsed.success) {
		throw new Error(
			`Refusing to write invalid workflow state envelope to ${filePath}: ${parsed.error.issues
				.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	// #658: internal runtime writers (ralplan/ultragoal/deep-interview/team) persist
	// envelopes directly, bypassing the `gjc state` CLI transition gate (`isValidTransition`,
	// historically the sole call site in state-runtime.ts). Re-assert that gate on every
	// sanctioned envelope write so internal writes cannot persist invalid state-machine phase
	// transitions silently. Forced writes (`gjc state ... --force`, reconcile repairs) carry
	// `audit.forced` and bypass, mirroring the CLI's `use --force to bypass`.
	//
	// The gate governs ACTIVE workflow progression only. Deactivation/teardown writes
	// (`active: false`, e.g. `gjc state clear`, which persists the universal `complete`
	// sentinel that is not a per-skill manifest state) leave the transition graph and are
	// intentionally exempt.
	if (options?.audit?.forced !== true && parsed.data.active === true) {
		const toPhase = parsed.data.current_phase.trim();
		if (toPhase) {
			// Lazy import: workflow-manifest dereferences CANONICAL_GJC_WORKFLOW_SKILLS at
			// module load, and active-state -> state-writer -> workflow-manifest -> active-state
			// is a load-time cycle. Importing at call time (after init) avoids the TDZ.
			const { isKnownWorkflowState, isValidTransition } = await import("./workflow-manifest");
			const skill = parsed.data.skill;
			// Structural invariant (hard): a `current_phase` absent from the skill's manifest is
			// never a legitimate internal write, matching the CLI/reconcile unknown-phase gate.
			if (!isKnownWorkflowState(skill, toPhase)) {
				throw new Error(
					`Refusing to write unknown ${skill} phase "${toPhase}" to ${filePath}: not a known ${skill} manifest state (forced writes bypass via audit.forced)`,
				);
			}
			// Transition invariant (#658, diagnostic-only safety net): resolve the prior phase
			// (caller-supplied `audit.fromPhase`, else the active persisted envelope on disk) and
			// flag edges the manifest does not define. Intentionally NON-blocking and audit-only
			// — the CLI path already hard-fails invalid edges before reaching here, and legitimate
			// internal repairs / ralplan short-mode stage skips move between valid states without a
			// direct manifest edge. It records an `invalid_transition_detected` audit entry (no
			// stderr) so such transitions are non-silent without breaking those flows.
			const fromPhase = (options?.audit?.fromPhase ?? (await readPersistedPhase(filePath)))?.trim();
			if (
				fromPhase &&
				fromPhase !== toPhase &&
				isKnownWorkflowState(skill, fromPhase) &&
				!isValidTransition(skill, fromPhase, toPhase)
			) {
				await recordInvalidWorkflowTransition({ filePath, skill, fromPhase, toPhase, options });
			}
		}
	}
	await atomicWrite(filePath, jsonText(stamped));
	await maybeAudit(filePath, options);
	return filePath;
}

export async function writeTextAtomic(targetPath: string, text: string, options?: StateWriterOptions): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	await atomicWrite(filePath, text);
	await maybeAudit(filePath, options);
	return filePath;
}

/**
 * Serialize a read-modify-write (or any multi-step mutation) against concurrent
 * writers of the same `.gjc/**` target. Uses the cross-process directory lock
 * from `withFileLock`, keyed on the resolved file path, so separate CLI/agent
 * processes (e.g. team-mode workers) cannot interleave one writer's read with
 * another writer's write and silently drop the first mutation (issue #646).
 *
 * The lock is advisory: it only protects callers that route through it, so every
 * read-modify-write of a given file MUST acquire this lock for the same resolved
 * path. `atomicWrite`'s temp-file + rename crash-atomicity is preserved; this
 * layers concurrency-atomicity on top without weakening it.
 */
export async function withWorkflowStateLock<T>(
	targetPath: string,
	fn: () => Promise<T>,
	options?: StateWriterOptions,
): Promise<T> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	return lockResolvedWorkflowTarget(filePath, fn, options?.lock);
}

async function lockResolvedWorkflowTarget<T>(
	filePath: string,
	fn: () => Promise<T>,
	lockOptions?: FileLockOptions,
): Promise<T> {
	// `withFileLock` creates the lock dir next to the target with a non-recursive
	// mkdir, so the parent directory must exist before the lock is acquired.
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	return withFileLock(filePath, fn, lockOptions);
}

export async function updateJsonAtomic<T = unknown>(
	targetPath: string,
	mutator: (current: T | undefined) => T | Promise<T>,
	options?: StateWriterOptions,
): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	return lockResolvedWorkflowTarget(
		filePath,
		async () => {
			const current = (await readJsonIfPresent(filePath)) as T | undefined;
			const next = await mutator(current);
			await atomicWrite(filePath, jsonText(withWorkflowReceipt(next, buildReceipt(options))));
			await maybeAudit(filePath, options);
			return filePath;
		},
		options?.lock,
	);
}

export async function appendJsonl(targetPath: string, entry: unknown, options?: StateWriterOptions): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
	await maybeAudit(filePath, options);
	return filePath;
}

export interface AppendJsonlIdempotentOptions extends StateWriterOptions {
	/**
	 * Identity key for an entry. Two entries that produce the same non-`undefined`
	 * key are duplicates, so only the first is appended. Return `undefined` to opt a
	 * candidate out of dedup (it is always appended). Use `key` for the common case
	 * where identity reduces to a single string.
	 */
	key?: (entry: unknown) => string | undefined;
	/**
	 * Equivalence predicate: return `true` when `existing` already represents
	 * `candidate`, suppressing the append. Use when identity cannot be reduced to a
	 * single string key. When both `key` and `equals` are supplied, `equals` wins.
	 */
	equals?: (candidate: unknown, existing: unknown) => boolean;
}

export interface AppendJsonlIdempotentResult {
	path: string;
	/** `true` when the entry was written; `false` when an equivalent entry already existed. */
	appended: boolean;
	/** The pre-existing entry that suppressed the append, when `appended` is `false`. */
	duplicate?: unknown;
}

async function readJsonlEntries(filePath: string): Promise<unknown[]> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf-8");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return [];
		throw error;
	}
	const entries: unknown[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// Best-effort: dedup compares parseable rows only. A corrupt line cannot
			// be matched, so it never suppresses a new append.
		}
	}
	return entries;
}

function findJsonlDuplicate(
	existing: readonly unknown[],
	candidate: unknown,
	options: AppendJsonlIdempotentOptions,
): unknown | undefined {
	if (options.equals) {
		const equals = options.equals;
		return existing.find(item => equals(candidate, item));
	}
	const key = options.key;
	if (!key) return undefined;
	const candidateKey = key(candidate);
	if (candidateKey === undefined) return undefined;
	return existing.find(item => key(item) === candidateKey);
}

/**
 * Append `entry` to a JSONL file only when no equivalent entry already exists —
 * the shared idempotent append primitive (issue #660).
 *
 * `appendJsonl` is a pure append with no dedup, so every recurring "duplicate
 * ledger row" bug (#638, #643, #645) had to be patched with bespoke per-call-site
 * guards. This primitive centralizes the read-check-append cycle: a caller
 * declares identity once via `key` or `equals` instead of re-deriving the lookup
 * at each site.
 *
 * The read-then-append is serialized through the same cross-process workflow lock
 * as `updateJsonAtomic`, so two concurrent idempotent appends cannot both observe
 * "no duplicate" and both write (the #646 TOCTOU that a plain `appendJsonl`
 * preceded by a manual existence check is still exposed to).
 *
 * Scope note: this dedups the *append* only. Call sites whose idempotency must
 * also skip a coupled mutation — e.g. the plan/state rewrite in #643/#645 — still
 * need a whole-operation guard; this primitive is the ledger-level half of that.
 */
export async function appendJsonlIdempotent(
	targetPath: string,
	entry: unknown,
	options: AppendJsonlIdempotentOptions,
): Promise<AppendJsonlIdempotentResult> {
	if (!options.key && !options.equals) {
		throw new Error("appendJsonlIdempotent requires a `key` or `equals` option to detect duplicates");
	}
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	return lockResolvedWorkflowTarget(
		filePath,
		async () => {
			const existing = await readJsonlEntries(filePath);
			const duplicate = findJsonlDuplicate(existing, entry, options);
			if (duplicate !== undefined) {
				return { path: filePath, appended: false, duplicate };
			}
			await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
			await maybeAudit(filePath, options);
			return { path: filePath, appended: true };
		},
		options.lock,
	);
}

export async function appendText(targetPath: string, text: string, options?: StateWriterOptions): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(filePath, text, "utf-8");
	await maybeAudit(filePath, options);
	return filePath;
}

export async function createJsonNoClobber(
	targetPath: string,
	value: unknown,
	options?: StateWriterOptions,
): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(filePath, "wx");
		await handle.writeFile(jsonText(withWorkflowReceipt(value, buildReceipt(options))), "utf-8");
	} catch (error) {
		if (isErrno(error, "EEXIST")) throw new AlreadyExistsError(filePath);
		throw error;
	} finally {
		await handle?.close();
	}
	await maybeAudit(filePath, options);
	return filePath;
}

export async function deleteIfOwned(
	targetPath: string,
	predicateOrOptions?: ((current: unknown) => boolean | Promise<boolean>) | DeleteIfOwnedOptions,
): Promise<DeleteResult> {
	const options = typeof predicateOrOptions === "function" ? undefined : predicateOrOptions;
	const predicate = typeof predicateOrOptions === "function" ? predicateOrOptions : predicateOrOptions?.predicate;
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	const current = await readJsonIfPresent(filePath);
	if (current === undefined) return { path: filePath, deleted: false };
	if (predicate && !(await predicate(current))) return { path: filePath, deleted: false };
	const deleted = await atomicRemove(filePath);
	if (deleted) await maybeAudit(filePath, options);
	return { path: filePath, deleted };
}

export async function removeFileAudited(targetPath: string, options?: StateWriterOptions): Promise<DeleteResult> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	const deleted = await atomicRemove(filePath);
	if (deleted) await maybeAudit(filePath, options);
	return { path: filePath, deleted };
}

/**
 * Active entry files under `.gjc/_session-{id}/state/active/<skill>.json` are authoritative. The
 * adjacent `skill-active-state.json` file is only a derived cache rebuilt from
 * those entries, so concurrent snapshot rebuilds can race without losing any
 * writer's per-skill state.
 */
export async function writeActiveEntry(
	cwd: string,
	sessionScope: string | ActiveSessionScope | undefined,
	skill: string,
	entry: SkillActiveEntry,
	options?: StateWriterOptions,
): Promise<string> {
	const filePath = activeEntryPath(path.resolve(cwd), sessionScope, skill);
	await writeGuardedResolvedJsonAtomic(
		filePath,
		{ ...entry, skill },
		{
			...options,
			policy: "cache",
			sourceRevision:
				persistedSourceRevision(entry) || persistedSourceRevision(await readJsonIfPresent(filePath)) + 1,
		},
	);
	invalidateActiveStateCacheForScope(cwd, sessionScope);
	return filePath;
}

export async function removeActiveEntry(
	cwd: string,
	sessionScope: string | ActiveSessionScope | undefined,
	skill: string,
	options?: StateWriterOptions,
): Promise<DeleteResult> {
	const filePath = activeEntryPath(path.resolve(cwd), sessionScope, skill);
	return lockResolvedWorkflowTarget(
		filePath,
		async () => {
			const current = await readJsonIfPresent(filePath);
			const incomingSourceRevision = options?.sourceRevision;
			if (
				current !== undefined &&
				incomingSourceRevision !== undefined &&
				incomingSourceRevision < persistedSourceRevision(current)
			) {
				return { path: filePath, deleted: false };
			}
			const deleted = await atomicRemove(filePath);
			if (deleted) await maybeAudit(filePath, options);
			if (deleted) invalidateActiveStateCacheForScope(cwd, sessionScope);
			return { path: filePath, deleted };
		},
		options?.lock,
	);
}

export async function readActiveEntries(
	cwd: string,
	sessionScope?: string | ActiveSessionScope,
): Promise<SkillActiveEntry[]> {
	const dir = activeStateDir(path.resolve(cwd), sessionScope);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return [];
		throw error;
	}
	const entries: SkillActiveEntry[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const raw = await readJsonIfPresent(path.join(dir, name));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const skill = safeString((raw as SkillActiveEntry).skill).trim();
		if (!skill) continue;
		entries.push(raw as SkillActiveEntry);
	}
	return entries;
}

export async function rebuildActiveSnapshot(
	cwd: string,
	sessionScope?: string | ActiveSessionScope,
	options?: StateWriterOptions,
): Promise<string> {
	const resolvedCwd = path.resolve(cwd);
	const snapshotPath = activeSnapshotPath(resolvedCwd, sessionScope);
	const entries = await readActiveEntries(resolvedCwd, sessionScope);
	await writeGuardedResolvedJsonAtomic(snapshotPath, buildActiveSnapshot(entries), {
		...options,
		policy: "cache",
		sourceRevision: Math.max(
			persistedSourceRevision(await readJsonIfPresent(snapshotPath)) + 1,
			...entries.map(entry => persistedSourceRevision(entry)),
		),
	});
	invalidateActiveStateCacheForScope(cwd, sessionScope);
	return snapshotPath;
}

export async function mergeActiveState(
	cwd: string,
	sessionScope: string | ActiveSessionScope | undefined,
	skill: string,
	entry: SkillActiveEntry,
	options?: StateWriterOptions,
): Promise<ActiveEntryWriteResult> {
	const entryPath = await writeActiveEntry(cwd, sessionScope, skill, entry, options);
	const snapshotPath = await rebuildActiveSnapshot(cwd, sessionScope, options);
	return { entryPath, snapshotPath };
}

export async function writeArtifact(
	targetPath: string,
	content: string,
	options?: StateWriterOptions,
): Promise<string> {
	return writeTextAtomic(targetPath, content, {
		...options,
		audit: options?.audit ?? { category: "artifact", verb: "write", owner: "gjc-runtime" },
	});
}

export async function writeReport(targetPath: string, content: string, options?: StateWriterOptions): Promise<string> {
	return writeTextAtomic(targetPath, content, {
		...options,
		audit: options?.audit ?? { category: "report", verb: "write", owner: "gjc-runtime" },
	});
}

export async function writeLogJsonl(targetPath: string, entry: unknown, options?: StateWriterOptions): Promise<string> {
	return appendJsonl(targetPath, entry, {
		...options,
		audit: options?.audit ?? { category: "log", verb: "append", owner: "gjc-runtime" },
	});
}

export async function softDelete(
	targetPath: string,
	meta: Record<string, unknown>,
	options?: StateWriterOptions,
): Promise<string> {
	return updateJsonAtomic<Record<string, unknown>>(
		targetPath,
		current => ({
			...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
			archived: true,
			active: false,
			tombstone: { ...meta, archived_at: new Date().toISOString() },
		}),
		{
			...options,
			audit: options?.audit ?? { category: "prune", verb: "soft-delete", owner: "gjc-runtime" },
		},
	);
}

export async function hardPruneJson(
	targetPaths: readonly string[],
	selector: HardPruneSelector,
	options?: StateWriterOptions,
): Promise<string[]> {
	const targets: GenericHardPruneTarget[] = targetPaths.map(targetPath => ({ path: targetPath, category: "prune" }));
	return hardPrune(
		targets,
		async context => {
			const value = await context.readJson();
			return selector({ path: context.path, value });
		},
		options,
	);
}

export async function hardPrune(
	targets: readonly GenericHardPruneTarget[],
	selector: GenericHardPruneSelector,
	options?: StateWriterOptions,
): Promise<string[]> {
	const cwd = cwdForOptions(options);
	const removed: string[] = [];
	for (const target of targets) {
		const filePath = resolveGjcTarget(target.path, cwd);
		let stat: Stats;
		try {
			stat = await fs.stat(filePath);
		} catch (error) {
			if (isErrno(error, "ENOENT")) continue;
			throw error;
		}
		const shouldRemove = await selector({
			path: filePath,
			category: target.category,
			stat,
			readJson: async () => JSON.parse(await fs.readFile(filePath, "utf-8")),
		});
		if (!shouldRemove) continue;
		const deleted = await atomicRemove(filePath);
		if (deleted) removed.push(filePath);
	}
	if (options?.audit && removed.length > 0) {
		const audit = options.audit;
		await appendAuditEntry(path.resolve(audit.cwd ?? options.cwd ?? process.cwd()), audit.sessionId ?? "", {
			ts: new Date().toISOString(),
			skill: audit.skill,
			category: audit.category,
			verb: audit.verb,
			owner: audit.owner,
			mutation_id: audit.mutationId ?? randomUUID(),
			from_phase: audit.fromPhase,
			to_phase: audit.toPhase,
			forced: audit.forced ?? false,
			paths: removed,
		});
	}
	return removed;
}

export async function forceOverwrite(
	targetPath: string,
	rawValue: unknown,
	options?: ForceOverwriteOptions,
): Promise<string> {
	const auditOptions = {
		...options,
		audit: options?.audit ?? { category: "force", verb: "force-overwrite", owner: "gjc-state-cli", forced: true },
	};
	if (options?.raw === true) {
		const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
		await atomicWrite(filePath, jsonText(rawValue));
		await maybeAudit(filePath, auditOptions);
		return filePath;
	}
	return writeJsonAtomic(
		targetPath,
		{
			forced: true,
			forced_at: new Date().toISOString(),
			value: rawValue,
		},
		auditOptions,
	);
}

export async function appendAuditEntry(
	cwd: string,
	sessionIdOrEntry: string | AuditEntry,
	maybeEntry?: AuditEntry,
): Promise<string> {
	const sessionId =
		typeof sessionIdOrEntry === "string"
			? sessionIdOrEntry.trim()
			: safeString((sessionIdOrEntry as AuditEntry & { session_id?: unknown }).session_id).trim();
	if (!sessionId) throw new Error("a non-empty GJC session id is required (appendAuditEntry)");
	const entry = typeof sessionIdOrEntry === "string" ? maybeEntry : sessionIdOrEntry;
	if (!entry) throw new Error("audit entry is required");
	const filePath = resolveGjcTarget(layoutAuditPath(cwd, sessionId), cwd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
	return filePath;
}

function transactionJournalPath(cwd: string, sessionId: string, mutationId: string): string {
	return layoutTransactionJournalPath(path.resolve(cwd), sessionId, mutationId);
}

export async function readWorkflowTransactionJournal(
	cwd: string,
	sessionId: string,
	mutationId: string,
): Promise<WorkflowTransactionJournal | undefined> {
	return (await readJsonIfPresent(transactionJournalPath(cwd, sessionId, mutationId))) as
		| WorkflowTransactionJournal
		| undefined;
}

export async function beginWorkflowTransactionJournal(input: {
	cwd: string;
	sessionId: string;
	mutationId: string;
	caller?: CanonicalGjcWorkflowSkill;
	callee?: CanonicalGjcWorkflowSkill;
	paths: string[];
}): Promise<string> {
	const now = new Date().toISOString();
	const journal: WorkflowTransactionJournal = {
		version: 1,
		mutation_id: input.mutationId,
		status: "pending",
		created_at: now,
		updated_at: now,
		caller: input.caller,
		callee: input.callee,
		paths: input.paths,
		steps: [],
	};
	try {
		return await createJsonNoClobber(transactionJournalPath(input.cwd, input.sessionId, input.mutationId), journal, {
			cwd: input.cwd,
		});
	} catch (error) {
		if (error instanceof AlreadyExistsError) return error.path;
		throw error;
	}
}

export async function updateWorkflowTransactionJournal(
	cwd: string,
	sessionId: string,
	mutationId: string,
	patch: Partial<WorkflowTransactionJournal>,
): Promise<string> {
	const filePath = transactionJournalPath(cwd, sessionId, mutationId);
	const current = ((await readJsonIfPresent(filePath)) ?? {}) as WorkflowTransactionJournal;
	const next = { ...current, ...patch, updated_at: new Date().toISOString() } as WorkflowTransactionJournal;
	await atomicWrite(filePath, jsonText(next));
	return filePath;
}

export async function completeWorkflowTransactionJournal(
	cwd: string,
	sessionId: string,
	mutationId: string,
): Promise<void> {
	await updateWorkflowTransactionJournal(cwd, sessionId, mutationId, { status: "committed" });
	await atomicRemove(transactionJournalPath(cwd, sessionId, mutationId)).catch(() => false);
}
