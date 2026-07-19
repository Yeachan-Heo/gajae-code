import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import { withFileLock } from "./file-lock";

export interface AtomicYamlExpectedPrecondition {
	path: string;
	hash: string;
}

export interface AtomicYamlSetPatch {
	path: string;
	op: "set";
	value: unknown;
	expected?: AtomicYamlExpectedPrecondition;
}

export interface AtomicYamlUnsetPatch {
	path: string;
	op: "unset";
	expected?: AtomicYamlExpectedPrecondition;
}

export type AtomicYamlPatch = AtomicYamlSetPatch | AtomicYamlUnsetPatch;

/** Raised when a compare-and-swap precondition no longer matches durable YAML. */
export class AtomicYamlConflictError extends Error {
	readonly code = "ATOMIC_YAML_CONFLICT";

	constructor(
		readonly path: string,
		readonly expectedHash: string,
		readonly actualHash: string,
	) {
		super(`Atomic YAML precondition failed for ${path}.`);
		this.name = "AtomicYamlConflictError";
	}
}

export interface AtomicYamlPatchRevision {
	path: string;
	beforeHash: string;
	afterHash: string;
	beforeRevision: number;
	afterRevision: number;
}

export type CasRestoreResult =
	| { status: "restored"; receipt: CasReceipt }
	| { status: "conflict"; paths: readonly string[] }
	| { status: "discarded" };

/**
 * A receipt intentionally exposes only path-level hashes and opaque revisions.
 * The before values needed by restore stay in this module's closure.
 */
export interface CasReceipt {
	readonly revisions: readonly AtomicYamlPatchRevision[];
	restore(): Promise<CasRestoreResult>;
	discard(): void;
}

export interface AtomicYamlUpdate<T> {
	apply(current: Record<string, unknown>): T | Promise<T>;
	shouldWrite?(result: T): boolean;
	committed?(current: Record<string, unknown>, result: T): void | Promise<void>;
}

export interface AtomicYamlPatchOptions {
	/** Test seam for deterministic pre-rename and Windows sharing-violation failures. */
	rename?: (from: string, to: string) => Promise<void>;
	/** Test seam for bounded retry timing. */
	sleep?: (ms: number) => Promise<void>;
	/** Test seam for Windows rename retry behavior. */
	platform?: NodeJS.Platform;
	/** Called under the config lock before patches are applied. */
	validateRoot?: (root: unknown, patches: readonly AtomicYamlPatch[]) => void | Promise<void>;
	/** Called under the config lock after a successful CAS restore. */
	onRestored?: (patches: readonly AtomicYamlPatch[]) => void | Promise<void>;
}

/** A replacement failure never unlinks the destination as a fallback. */
export class AtomicYamlReplaceError extends Error {
	readonly code = "ATOMIC_YAML_REPLACE_FAILED";

	constructor(
		readonly configPath: string,
		readonly attempts: number,
		readonly cause: unknown,
	) {
		super(`Failed to atomically replace ${configPath} after ${attempts} rename attempts.`);
		this.name = "AtomicYamlReplaceError";
	}
}

type PathState = { exists: boolean; value: unknown };
type ReceiptChange = {
	path: string;
	before: PathState;
	after: PathState;
	publicRevision: AtomicYamlPatchRevision;
};

const queues = new Map<string, Promise<void>>();
let nextReceiptRevision = 0;
/** Bounded Windows sharing-violation retries: 10, 25, 50, 100, then 200 ms. */
const WINDOWS_RENAME_BACKOFF_MS = [10, 25, 50, 100, 200] as const;
const WINDOWS_SHARING_VIOLATION_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function canonicalConfigPath(configPath: string): string {
	return path.normalize(path.resolve(configPath));
}

function assertPatch(patch: AtomicYamlPatch): void {
	if (
		!patch ||
		typeof patch.path !== "string" ||
		patch.path.length === 0 ||
		patch.path.split(".").some(part => !part)
	) {
		throw new Error("Atomic YAML patches require a non-empty dotted path.");
	}
	if (
		patch.expected &&
		(typeof patch.expected.path !== "string" ||
			patch.expected.path.length === 0 ||
			patch.expected.path.split(".").some(part => !part) ||
			typeof patch.expected.hash !== "string" ||
			patch.expected.hash.length === 0)
	) {
		throw new Error("Atomic YAML patch preconditions require a non-empty dotted path and hash.");
	}
	if (patch.op === "set") {
		if (patch.value === undefined) {
			throw new TypeError(`Atomic YAML set patch for ${patch.path} cannot carry undefined; use unset instead.`);
		}
		return;
	}
	if (patch.op !== "unset") {
		throw new Error(`Unknown atomic YAML patch operation: ${(patch as { op?: unknown }).op}`);
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stateAtPath(value: Record<string, unknown>, segments: readonly string[]): PathState {
	let current: Record<string, unknown> = value;
	for (let index = 0; index < segments.length - 1; index++) {
		const next = record(current[segments[index]!]);
		if (!next) return { exists: false, value: undefined };
		current = next;
	}
	const key = segments[segments.length - 1]!;
	return Object.hasOwn(current, key) ? { exists: true, value: current[key] } : { exists: false, value: undefined };
}

/** Set a dotted YAML path, creating object intermediates as needed. */
export function setByPath(value: Record<string, unknown>, segments: readonly string[], nextValue: unknown): void {
	let current = value;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index]!;
		const next = record(current[segment]);
		if (!next) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
	current[segments[segments.length - 1]!] = nextValue;
}

/** Delete a dotted YAML path without disturbing sibling keys or parent objects. */
export function deleteByPath(value: Record<string, unknown>, segments: readonly string[]): void {
	let current = value;
	for (let index = 0; index < segments.length - 1; index++) {
		const next = record(current[segments[index]!]);
		if (!next) return;
		current = next;
	}
	delete current[segments[segments.length - 1]!];
}

function stableValue(value: unknown): string {
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "NaN";
		if (value === Infinity) return "Infinity";
		if (value === -Infinity) return "-Infinity";
		if (Object.is(value, -0)) return "-0";
	}
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map(key => `${JSON.stringify(key)}:${stableValue(object[key])}`)
		.join(",")}}`;
}

function stateHash(state: PathState): string {
	return createHash("sha256")
		.update(state.exists ? `present:${stableValue(state.value)}` : "absent")
		.digest("hex");
}

function cloneState(state: PathState): PathState {
	return state.exists ? { exists: true, value: structuredClone(state.value) } : state;
}

/** Hash a dotted YAML path state for an expected-hash patch precondition. */
export function atomicYamlPathHash(value: Record<string, unknown>, path: string): string {
	return stateHash(stateAtPath(value, path.split(".")));
}

type YamlReadResult = {
	current: Record<string, unknown>;
	root: unknown;
};

async function readYaml(configPath: string): Promise<YamlReadResult> {
	try {
		const root = YAML.parse(await fs.readFile(configPath, "utf8"));
		return { current: record(root) ?? {}, root };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { current: {}, root: undefined };
		throw error;
	}
}

async function syncParentDirectory(directory: string): Promise<void> {
	try {
		const directoryHandle = await fs.open(directory, "r");
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	} catch {
		// Directory fsync is not supported by every platform/filesystem. The renamed
		// destination remains valid even where the durability barrier is unavailable.
	}
}

async function replaceWithRetry(tempPath: string, configPath: string, options: AtomicYamlPatchOptions): Promise<void> {
	const rename = options.rename ?? fs.rename;
	const sleep = options.sleep ?? (async (delay: number): Promise<void> => await Bun.sleep(delay));
	const isWindows = (options.platform ?? process.platform) === "win32";
	let attempts = 0;

	for (;;) {
		attempts++;
		try {
			await rename(tempPath, configPath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const retryDelay = WINDOWS_RENAME_BACKOFF_MS[attempts - 1];
			if (!isWindows || !code || !WINDOWS_SHARING_VIOLATION_CODES.has(code) || retryDelay === undefined) {
				if (isWindows && code && WINDOWS_SHARING_VIOLATION_CODES.has(code)) {
					throw new AtomicYamlReplaceError(configPath, attempts, error);
				}
				throw error;
			}
			await sleep(retryDelay);
		}
	}
}

async function writeAtomicYaml(
	configPath: string,
	value: Record<string, unknown>,
	options: AtomicYamlPatchOptions,
): Promise<void> {
	const directory = path.dirname(configPath);
	const tempPath = path.join(directory, `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const tempHandle = await fs.open(tempPath, "wx", 0o600);
		try {
			await tempHandle.writeFile(YAML.stringify(value, null, 2), "utf8");
			await tempHandle.sync();
		} finally {
			await tempHandle.close();
		}
		await replaceWithRetry(tempPath, configPath, options);
		await syncParentDirectory(directory);
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

function createReceipt(
	configPath: string,
	changes: readonly ReceiptChange[],
	options: AtomicYamlPatchOptions,
): CasReceipt {
	let discarded = false;
	const revisions = changes.map(change => change.publicRevision);

	return {
		revisions,
		discard(): void {
			discarded = true;
		},
		async restore(): Promise<CasRestoreResult> {
			if (discarded) return { status: "discarded" };
			return await enqueueAtomicYamlOperation(configPath, async canonicalPath => {
				if (discarded) return { status: "discarded" };
				return await withFileLock(canonicalPath, async () => {
					const { current, root } = await readYaml(canonicalPath);
					const conflicts = changes
						.filter(
							change =>
								stateHash(stateAtPath(current, change.path.split("."))) !== change.publicRevision.afterHash,
						)
						.map(change => change.path);
					if (conflicts.length > 0) return { status: "conflict", paths: conflicts };

					const restorePatches: AtomicYamlPatch[] = changes.map(change =>
						change.before.exists
							? { path: change.path, op: "set", value: structuredClone(change.before.value) }
							: { path: change.path, op: "unset" },
					);
					await options.validateRoot?.(root, restorePatches);
					const receipt = await applyPatchesUnderLock(canonicalPath, current, restorePatches, options);
					await options.onRestored?.(restorePatches);
					return { status: "restored", receipt };
				});
			});
		},
	};
}

async function applyPatchesUnderLock(
	configPath: string,
	current: Record<string, unknown>,
	patches: readonly AtomicYamlPatch[],
	options: AtomicYamlPatchOptions,
): Promise<CasReceipt> {
	if (patches.length === 0) return createReceipt(configPath, [], options);

	for (const patch of patches) {
		if (!patch.expected) continue;
		const actualHash = stateHash(stateAtPath(current, patch.expected.path.split(".")));
		if (actualHash !== patch.expected.hash) {
			throw new AtomicYamlConflictError(patch.expected.path, patch.expected.hash, actualHash);
		}
	}

	const changesByPath = new Map<string, ReceiptChange>();
	for (const patch of patches) {
		const segments = patch.path.split(".");
		const existingChange = changesByPath.get(patch.path);
		const before = existingChange?.before ?? cloneState(stateAtPath(current, segments));
		if (patch.op === "set") {
			setByPath(current, segments, structuredClone(patch.value));
		} else {
			deleteByPath(current, segments);
		}
		const after = cloneState(stateAtPath(current, segments));
		const beforeRevision = existingChange?.publicRevision.beforeRevision ?? ++nextReceiptRevision;
		const afterRevision = ++nextReceiptRevision;
		changesByPath.set(patch.path, {
			path: patch.path,
			before,
			after,
			publicRevision: {
				path: patch.path,
				beforeHash: stateHash(before),
				afterHash: stateHash(after),
				beforeRevision,
				afterRevision,
			},
		});
	}
	const changes = [...changesByPath.values()];

	await writeAtomicYaml(configPath, current, options);
	return createReceipt(configPath, changes, options);
}

/** Build patches from current durable YAML while holding the shared queue and file lock. */
export function applyAtomicYamlPatchesWithCurrent(
	configPath: string,
	buildPatches: (
		current: Readonly<Record<string, unknown>>,
	) => Promise<readonly AtomicYamlPatch[]> | readonly AtomicYamlPatch[],
	options: AtomicYamlPatchOptions = {},
): Promise<CasReceipt> {
	return enqueueAtomicYamlOperation(configPath, async canonicalPath => {
		await fs.mkdir(path.dirname(canonicalPath), { recursive: true, mode: 0o700 });
		return await withFileLock(canonicalPath, async () => {
			const { current, root } = await readYaml(canonicalPath);
			const patches = await buildPatches(current);
			for (const patch of patches) assertPatch(patch);
			await options.validateRoot?.(root, patches);
			return await applyPatchesUnderLock(canonicalPath, current, patches, options);
		});
	});
}

/**
 * Reserve a FIFO operation for a config file immediately. The patch supplier runs
 * only when this operation reaches the front of the in-process queue, which lets
 * Settings debounce/coalesce inside its already-reserved causal slot.
 */
export function enqueueAtomicYamlOperation<T>(
	configPath: string,
	operation: (canonicalConfigPath: string) => Promise<T>,
): Promise<T> {
	const canonicalPath = canonicalConfigPath(configPath);
	const prior = queues.get(canonicalPath) ?? Promise.resolve();
	const result = prior.catch(() => undefined).then(() => operation(canonicalPath));
	const completion = result.then(
		() => undefined,
		() => undefined,
	);
	queues.set(canonicalPath, completion);
	void completion.finally(() => {
		if (queues.get(canonicalPath) === completion) queues.delete(canonicalPath);
	});
	return result;
}

/**
 * Reserve an atomic patch slot now, producing patches only after earlier slots
 * complete. Writers with state-aware merges use {@link reserveAtomicYamlUpdateSlot}.
 */
export function reserveAtomicYamlPatchSlot(
	configPath: string,
	patches: () => Promise<readonly AtomicYamlPatch[]> | readonly AtomicYamlPatch[],
	options: AtomicYamlPatchOptions = {},
): Promise<CasReceipt> {
	return enqueueAtomicYamlOperation(configPath, async canonicalPath => {
		const nextPatches = await patches();
		for (const patch of nextPatches) assertPatch(patch);
		await fs.mkdir(path.dirname(canonicalPath), { recursive: true, mode: 0o700 });
		return await withFileLock(canonicalPath, async () => {
			const { current, root } = await readYaml(canonicalPath);
			await options.validateRoot?.(root, nextPatches);
			return await applyPatchesUnderLock(canonicalPath, current, nextPatches, options);
		});
	});
}

/**
 * Reserve a FIFO update slot and atomically persist a caller-owned YAML mutation.
 * The supplier runs only when its operation reaches the front of the queue.
 */
export function reserveAtomicYamlUpdateSlot<T>(
	configPath: string,
	update: () => Promise<AtomicYamlUpdate<T>> | AtomicYamlUpdate<T>,
	options: AtomicYamlPatchOptions = {},
): Promise<T> {
	return enqueueAtomicYamlOperation(configPath, async canonicalPath => {
		const atomicUpdate = await update();
		await fs.mkdir(path.dirname(canonicalPath), { recursive: true, mode: 0o700 });
		return await withFileLock(canonicalPath, async () => {
			const { current } = await readYaml(canonicalPath);
			const result = await atomicUpdate.apply(current);
			if (atomicUpdate.shouldWrite?.(result) !== false) {
				await writeAtomicYaml(canonicalPath, current, options);
			}
			await atomicUpdate.committed?.(current, result);
			return result;
		});
	});
}

/**
 * Apply tagged patches through the one per-file in-process queue and the shared
 * cross-process file lock. Success means the temp file was fsynced and renamed.
 */
export function applyAtomicYamlPatches(
	configPath: string,
	patches: readonly AtomicYamlPatch[],
	options: AtomicYamlPatchOptions = {},
): Promise<CasReceipt> {
	for (const patch of patches) assertPatch(patch);
	const immutablePatches = patches.map(patch => {
		const expected = patch.expected ? { ...patch.expected } : undefined;
		return patch.op === "set"
			? ({
					path: patch.path,
					op: "set",
					value: structuredClone(patch.value),
					...(expected ? { expected } : {}),
				} as const)
			: ({ path: patch.path, op: "unset", ...(expected ? { expected } : {}) } as const);
	});
	return reserveAtomicYamlPatchSlot(configPath, () => immutablePatches, options);
}
