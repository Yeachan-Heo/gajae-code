import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SkillActiveEntry, SkillActiveState } from "../skill-state/active-state";
import {
	type AuditEntry,
	buildWorkflowStateReceipt,
	type CanonicalGjcWorkflowSkill,
	type WorkflowStateMutationOwner,
	type WorkflowStateReceipt,
} from "../skill-state/workflow-state-contract";

/**
 * Sole sanctioned project `.gjc/**` writer module (gate G1).
 *
 * All native `.gjc/**` filesystem mutations must route through these primitives.
 * The primitives validate project `.gjc/**` ownership, create parent directories,
 * and emit workflow receipts or audit entries where applicable by the caller's
 * supplied mutation context. No lockfiles are used; isolation is by atomic rename,
 * append, O_EXCL creates, conditional deletes, per-entry active-state files,
 * and derived active-state snapshots.
 * Transaction journals are per mutation id under `.gjc/state/transactions/`;
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
	sessionId?: string;
	mutationId?: string;
	nowIso?: string;
}

export interface StateWriterAuditContext {
	cwd?: string;
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

export interface StateWriterOptions {
	cwd?: string;
	receipt?: StateWriterReceiptContext;
	audit?: StateWriterAuditContext;
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
	stat: Awaited<ReturnType<typeof fs.stat>>;
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
			covered_path: filePath,
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

function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

function activeStateDir(cwd: string, sessionScope?: string | ActiveSessionScope): string {
	const sessionId = typeof sessionScope === "string" ? sessionScope : sessionScope?.sessionId;
	const normalizedSessionId = safeString(sessionId).trim();
	const stateDir = path.join(cwd, ".gjc", "state");
	return normalizedSessionId
		? path.join(stateDir, "sessions", encodePathSegment(normalizedSessionId), "active")
		: path.join(stateDir, "active");
}

function activeSnapshotPath(cwd: string, sessionScope?: string | ActiveSessionScope): string {
	const sessionId = typeof sessionScope === "string" ? sessionScope : sessionScope?.sessionId;
	const normalizedSessionId = safeString(sessionId).trim();
	const stateDir = path.join(cwd, ".gjc", "state");
	return normalizedSessionId
		? path.join(stateDir, "sessions", encodePathSegment(normalizedSessionId), "skill-active-state.json")
		: path.join(stateDir, "skill-active-state.json");
}

function activeEntryPath(cwd: string, sessionScope: string | ActiveSessionScope | undefined, skill: string): string {
	const normalizedSkill = safeString(skill).trim();
	if (!normalizedSkill) throw new Error("skill is required");
	return path.join(activeStateDir(cwd, sessionScope), `${encodePathSegment(normalizedSkill)}.json`);
}

function buildActiveSnapshot(entries: SkillActiveEntry[]): SkillActiveState {
	const visible = entries.filter(entry => entry.active !== false);
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

function withWorkflowReceipt(value: unknown, receipt: WorkflowStateReceipt | undefined): unknown {
	if (!receipt || !value || typeof value !== "object" || Array.isArray(value)) return value;
	return { ...(value as Record<string, unknown>), receipt };
}

function buildReceipt(options: StateWriterOptions | undefined): WorkflowStateReceipt | undefined {
	if (!options?.receipt) return undefined;
	return buildWorkflowStateReceipt({
		cwd: path.resolve(options.receipt.cwd ?? options.cwd ?? process.cwd()),
		skill: options.receipt.skill,
		owner: options.receipt.owner,
		command: options.receipt.command,
		sessionId: options.receipt.sessionId,
		nowIso: options.receipt.nowIso,
		mutationId: options.receipt.mutationId,
	});
}

async function maybeAudit(mutatedPath: string, options?: StateWriterOptions): Promise<void> {
	if (!options?.audit) return;
	const audit = options.audit;
	const cwd = path.resolve(audit.cwd ?? options.cwd ?? process.cwd());
	await appendAuditEntry(cwd, {
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

export async function writeWorkflowEnvelopeAtomic(
	targetPath: string,
	value: unknown,
	options?: StateWriterOptions,
): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	const withReceipt = withWorkflowReceipt(value, buildReceipt(options));
	await atomicWrite(filePath, jsonText(stampWorkflowEnvelopeChecksum(withReceipt, filePath)));
	await maybeAudit(filePath, options);
	return filePath;
}

export async function writeTextAtomic(targetPath: string, text: string, options?: StateWriterOptions): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	await atomicWrite(filePath, text);
	await maybeAudit(filePath, options);
	return filePath;
}

export async function updateJsonAtomic<T = unknown>(
	targetPath: string,
	mutator: (current: T | undefined) => T | Promise<T>,
	options?: StateWriterOptions,
): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	const current = (await readJsonIfPresent(filePath)) as T | undefined;
	const next = await mutator(current);
	await atomicWrite(filePath, jsonText(withWorkflowReceipt(next, buildReceipt(options))));
	await maybeAudit(filePath, options);
	return filePath;
}

export async function appendJsonl(targetPath: string, entry: unknown, options?: StateWriterOptions): Promise<string> {
	const filePath = resolveGjcTarget(targetPath, cwdForOptions(options));
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
	await maybeAudit(filePath, options);
	return filePath;
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
 * Active entry files under `.gjc/state/active/<skill>.json` and
 * `.gjc/state/sessions/<id>/active/<skill>.json` are authoritative. The
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
	await atomicWrite(filePath, jsonText({ ...entry, skill }));
	await maybeAudit(filePath, options);
	return filePath;
}

export async function removeActiveEntry(
	cwd: string,
	sessionScope: string | ActiveSessionScope | undefined,
	skill: string,
	options?: StateWriterOptions,
): Promise<DeleteResult> {
	const filePath = activeEntryPath(path.resolve(cwd), sessionScope, skill);
	const deleted = await atomicRemove(filePath);
	if (deleted) await maybeAudit(filePath, options);
	return { path: filePath, deleted };
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
	await atomicWrite(snapshotPath, jsonText(buildActiveSnapshot(entries)));
	await maybeAudit(snapshotPath, options);
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
		let stat: Awaited<ReturnType<typeof fs.stat>>;
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
		await appendAuditEntry(path.resolve(audit.cwd ?? options.cwd ?? process.cwd()), {
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

export async function appendAuditEntry(cwd: string, entry: AuditEntry): Promise<string> {
	const filePath = resolveGjcTarget(path.join(".gjc", "state", "audit.jsonl"), cwd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
	return filePath;
}

function transactionJournalPath(cwd: string, mutationId: string): string {
	return path.join(path.resolve(cwd), ".gjc", "state", "transactions", `${encodePathSegment(mutationId)}.json`);
}

export async function readWorkflowTransactionJournal(
	cwd: string,
	mutationId: string,
): Promise<WorkflowTransactionJournal | undefined> {
	return (await readJsonIfPresent(transactionJournalPath(cwd, mutationId))) as WorkflowTransactionJournal | undefined;
}

export async function beginWorkflowTransactionJournal(input: {
	cwd: string;
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
		return await createJsonNoClobber(transactionJournalPath(input.cwd, input.mutationId), journal, {
			cwd: input.cwd,
		});
	} catch (error) {
		if (error instanceof AlreadyExistsError) return error.path;
		throw error;
	}
}

export async function updateWorkflowTransactionJournal(
	cwd: string,
	mutationId: string,
	patch: Partial<WorkflowTransactionJournal>,
): Promise<string> {
	const filePath = transactionJournalPath(cwd, mutationId);
	const current = ((await readJsonIfPresent(filePath)) ?? {}) as WorkflowTransactionJournal;
	const next = { ...current, ...patch, updated_at: new Date().toISOString() } as WorkflowTransactionJournal;
	await atomicWrite(filePath, jsonText(next));
	return filePath;
}

export async function completeWorkflowTransactionJournal(cwd: string, mutationId: string): Promise<void> {
	await updateWorkflowTransactionJournal(cwd, mutationId, { status: "committed" });
	await atomicRemove(transactionJournalPath(cwd, mutationId)).catch(() => false);
}
