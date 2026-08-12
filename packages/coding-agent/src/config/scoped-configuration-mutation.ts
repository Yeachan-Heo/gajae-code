import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import type { LoadContext } from "../capability/types";
import {
	type AtomicYamlPatch,
	applyAtomicYamlPatchesWithCurrent,
	atomicYamlPathHash,
	deleteByPath,
	setByPath,
} from "./atomic-yaml-patch";

export type ScopedConfigurationScope = "project" | "user" | "managed";
export type ScopedConfigurationTiming = "next_session" | "current_runtime";
export type ScopedConfigurationMutationStatus =
	| "committed"
	| "applied"
	| "degraded"
	| "conflict"
	| "locked"
	| "rejected";

export type ScopedConfigurationReasonCode =
	| "project_scope_unavailable"
	| "scope_locked"
	| "invalid_scope"
	| "scope_rejected"
	| "target_escape"
	| "target_symlink"
	| "target_non_regular"
	| "target_parent_non_directory"
	| "unknown_owner_identity"
	| "invalid_patch"
	| "empty_patch"
	| "invalid_key"
	| "prototype_pollution_key"
	| "unsupported_value"
	| "duplicate_patch_paths"
	| "conflicting_patch_paths"
	| "invalid_yaml"
	| "invalid_yaml_root"
	| "scope_conflict"
	| "persistent_write_failed"
	| "runtime_precommit_failed"
	| "runtime_postcommit_failed"
	| "persistent_reload_mismatch"
	| "persistent_reload_unconfirmed";

export type ScopedConfigurationPrimitive = null | boolean | number | string;
export type ScopedConfigurationValue =
	| ScopedConfigurationPrimitive
	| readonly ScopedConfigurationValue[]
	| { readonly [key: string]: ScopedConfigurationValue };

export interface ScopedConfigurationSetPatch {
	readonly op: "set";
	readonly path: string;
	readonly value: ScopedConfigurationValue;
}

export interface ScopedConfigurationClearPatch {
	readonly op: "clear";
	readonly path: string;
}

export type ScopedConfigurationPatch = ScopedConfigurationSetPatch | ScopedConfigurationClearPatch;

export interface ScopedConfigurationExpectedOwner {
	readonly identity?: string;
	readonly revision?: string;
	readonly digest?: string;
}

export interface ScopedConfigurationFileStat {
	readonly dev?: number | bigint;
	readonly ino?: number | bigint;
	isSymbolicLink(): boolean;
	isDirectory(): boolean;
	isFile(): boolean;
}

export interface ScopedConfigurationFilesystem {
	readonly lstat: (target: string) => Promise<ScopedConfigurationFileStat>;
	readonly readFile: (target: string, encoding: "utf8") => Promise<string>;
	readonly [key: string]: unknown;
}

export type ScopedConfigurationClock = () => number;

export interface ScopedConfigurationSnapshot {
	readonly scope: Exclude<ScopedConfigurationScope, "managed">;
	readonly path: string;
	readonly safePath: string;
	readonly exists: boolean;
	readonly ownerIdentity: string;
	readonly revision: string;
	readonly digest: string;
	readonly data: Readonly<Record<string, unknown>>;
}

export interface ScopedConfigurationRuntimeContext {
	readonly scope: Exclude<ScopedConfigurationScope, "managed">;
	readonly phase: "before_commit" | "after_commit";
	readonly target: string;
	readonly path: string;
	readonly safePath: string;
	readonly patches: readonly ScopedConfigurationPatch[];
	readonly before: ScopedConfigurationSnapshot;
	readonly after?: ScopedConfigurationSnapshot;
}

export interface ScopedConfigurationVerificationResult {
	readonly ok: boolean;
}

export type ScopedConfigurationRuntimeResult = boolean | undefined | ScopedConfigurationVerificationResult;
export type ScopedConfigurationRuntimeCallback = (
	context: ScopedConfigurationRuntimeContext,
) => Promise<ScopedConfigurationRuntimeResult> | ScopedConfigurationRuntimeResult;

export interface ScopedConfigurationRuntime {
	readonly phase: "before_commit" | "after_commit";
	readonly apply: ScopedConfigurationRuntimeCallback;
}

export interface ScopedConfigurationReloadContext {
	readonly scope: Exclude<ScopedConfigurationScope, "managed">;
	readonly target: string;
	readonly path: string;
	readonly safePath: string;
	readonly patches: readonly ScopedConfigurationPatch[];
	readonly before: ScopedConfigurationSnapshot;
	readonly after: ScopedConfigurationSnapshot;
}

export type ScopedConfigurationReloadResult = boolean | undefined | ScopedConfigurationVerificationResult;
export type ScopedConfigurationReloadAndVerify = (
	context: ScopedConfigurationReloadContext,
) => Promise<ScopedConfigurationReloadResult> | ScopedConfigurationReloadResult;

export interface ScopedConfigurationMutationRequest {
	readonly scope: ScopedConfigurationScope;
	readonly patches: readonly ScopedConfigurationPatch[];
	readonly expectedOwner?: ScopedConfigurationExpectedOwner;
	readonly expectedOwnerIdentity?: string;
	readonly expectedOwnerRevision?: string;
	readonly expectedOwnerDigest?: string;
	readonly runtime?: ScopedConfigurationRuntime;
	readonly commitGuard?: () => boolean;
	readonly runtimePhase?: "before_commit" | "after_commit";
	readonly runtimeCallback?: ScopedConfigurationRuntimeCallback;
}

export interface ScopedConfigurationReceiptPatch {
	readonly op: "set" | "clear";
	readonly path: string;
}

export interface ScopedConfigurationMutationReceipt {
	readonly status: ScopedConfigurationMutationStatus;
	readonly reason: ScopedConfigurationReasonCode | null;

	readonly scope: ScopedConfigurationScope;
	readonly safePath: string | null;
	readonly beforeRevision: string | null;
	readonly afterRevision: string | null;
	readonly beforeDigest: string | null;
	readonly afterDigest: string | null;
	readonly timing: ScopedConfigurationTiming;
	readonly confirmation: "confirmed" | "unconfirmed" | "not_applicable";
	readonly durability: "none" | "committed" | "committed_unconfirmed";
	readonly patches: readonly ScopedConfigurationReceiptPatch[];
}

export interface ScopedConfigurationMutationServiceOptions {
	readonly loadContext: LoadContext;
	readonly agentDir: string;
	readonly reloadAndVerify: ScopedConfigurationReloadAndVerify;
	readonly filesystem?: ScopedConfigurationFilesystem;
	readonly clock?: ScopedConfigurationClock;
}

export interface NativeProjectSettingsStoreOptions {
	readonly loadContext: LoadContext;
	readonly agentDir: string;
	readonly filesystem?: ScopedConfigurationFilesystem;
	readonly clock?: ScopedConfigurationClock;
}

export class NativeProjectSettingsStoreError extends Error {
	readonly code: ScopedConfigurationReasonCode;
	readonly safePath: string | null;

	constructor(code: ScopedConfigurationReasonCode, safePath: string | null) {
		super("Native project settings store operation was rejected.");
		this.name = "NativeProjectSettingsStoreError";
		this.code = code;
		this.safePath = safePath;
	}
}

interface PathInspection {
	readonly safePath: string;
	readonly exists: boolean;
	readonly ownerIdentity: string;
}

interface ParsedDocument {
	readonly data: Record<string, unknown>;
	readonly exists: boolean;
}

class MutationAbort extends Error {
	readonly code: ScopedConfigurationReasonCode;

	constructor(code: ScopedConfigurationReasonCode) {
		super("Scoped configuration mutation was rejected.");
		this.name = "MutationAbort";
		this.code = code;
	}
}

const PROTOTYPE_POLLUTION_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;
const DEFAULT_CLOCK: ScopedConfigurationClock = () => Date.now();

const DEFAULT_FILESYSTEM: ScopedConfigurationFilesystem = Object.freeze({
	lstat: async (target: string): Promise<ScopedConfigurationFileStat> => await fs.lstat(target),
	readFile: async (target: string): Promise<string> => {
		const file = Bun.file(target);
		if (!(await file.exists())) {
			const missing = new Error("missing");
			Object.defineProperty(missing, "code", { value: "ENOENT", enumerable: false });
			throw missing;
		}
		return await file.text();
	},
});

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return (error as { readonly code?: unknown }).code === "ENOENT";
}

function safePathCandidate(
	scope: Exclude<ScopedConfigurationScope, "managed">,
	loadContext: LoadContext,
	agentDir: string,
): string | null {
	if (scope === "project") {
		if (loadContext.repoRoot === null || loadContext.repoRoot.length === 0) return null;
		return path.resolve(loadContext.repoRoot, ".gjc", "config.yml");
	}
	if (agentDir.length === 0) return null;
	return path.resolve(agentDir, "config.yml");
}

function basePathFor(
	scope: Exclude<ScopedConfigurationScope, "managed">,
	loadContext: LoadContext,
	agentDir: string,
): string | null {
	if (scope === "project") {
		if (loadContext.repoRoot === null || loadContext.repoRoot.length === 0) return null;
		return path.resolve(loadContext.repoRoot);
	}
	if (agentDir.length === 0) return null;
	return path.resolve(agentDir);
}

function isContained(basePath: string, target: string): boolean {
	const relative = path.relative(basePath, target);
	return (
		relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
	);
}

function absoluteComponents(target: string): string[] {
	const parsed = path.parse(target);
	const rest = target
		.slice(parsed.root.length)
		.split(path.sep)
		.filter(segment => segment.length > 0);
	const components: string[] = [parsed.root];
	let current = parsed.root;
	for (const segment of rest) {
		current = path.join(current, segment);
		components.push(current);
	}
	return components;
}

function ownerIdentity(stat: ScopedConfigurationFileStat): string {
	if (stat.dev === undefined || stat.ino === undefined) throw new MutationAbort("unknown_owner_identity");
	if (typeof stat.dev === "number" && !Number.isFinite(stat.dev)) throw new MutationAbort("unknown_owner_identity");
	if (typeof stat.ino === "number" && !Number.isFinite(stat.ino)) throw new MutationAbort("unknown_owner_identity");
	return `dev:${String(stat.dev)}:ino:${String(stat.ino)}`;
}

async function inspectTarget(
	basePath: string,
	target: string,
	filesystem: ScopedConfigurationFilesystem,
): Promise<PathInspection> {
	const safePath = path.normalize(path.resolve(target));
	if (!isContained(basePath, safePath)) throw new MutationAbort("target_escape");
	const components = absoluteComponents(safePath);
	for (let index = 0; index < components.length; index++) {
		const component = components[index]!;
		let stat: ScopedConfigurationFileStat;
		try {
			stat = await filesystem.lstat(component);
		} catch (error) {
			if (isMissing(error)) {
				return { safePath, exists: false, ownerIdentity: `missing:${safePath}` };
			}
			throw new MutationAbort("scope_rejected");
		}
		if (stat.isSymbolicLink()) throw new MutationAbort("target_symlink");
		const isTarget = index === components.length - 1;
		if (isTarget) {
			if (!stat.isFile()) throw new MutationAbort("target_non_regular");
			return { safePath, exists: true, ownerIdentity: ownerIdentity(stat) };
		}
		if (!stat.isDirectory()) throw new MutationAbort("target_parent_non_directory");
	}
	throw new MutationAbort("scope_rejected");
}

function validatePath(
	scope: ScopedConfigurationScope,
	loadContext: LoadContext,
	agentDir: string,
): {
	readonly basePath: string;
	readonly target: string;
} {
	if (scope === "managed") throw new MutationAbort("scope_locked");
	const basePath = basePathFor(scope, loadContext, agentDir);
	const target = safePathCandidate(scope, loadContext, agentDir);
	if (basePath === null || target === null) {
		if (scope === "project") throw new MutationAbort("project_scope_unavailable");
		throw new MutationAbort("scope_rejected");
	}
	if (!path.isAbsolute(basePath) || !path.isAbsolute(target)) throw new MutationAbort("scope_rejected");
	if (!isContained(basePath, target)) throw new MutationAbort("target_escape");
	return { basePath, target };
}

function stableValue(value: unknown, seen: WeakSet<object>): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "NaN";
		if (value === Infinity) return "Infinity";
		if (value === -Infinity) return "-Infinity";
		if (Object.is(value, -0)) return "-0";
		return JSON.stringify(value);
	}
	if (typeof value !== "object" || value === undefined) return String(value);
	if (seen.has(value)) throw new MutationAbort("unsupported_value");
	seen.add(value);
	try {
		if (Array.isArray(value)) return `[${value.map(item => stableValue(item, seen)).join(",")}]`;
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableValue(object[key], seen)}`)
			.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

function documentDigest(value: Record<string, unknown>): string {
	return createHash("sha256").update(stableValue(value, new WeakSet<object>())).digest("hex");
}

function validateSegment(segment: string): void {
	if (segment.length === 0 || !SAFE_KEY_SEGMENT.test(segment)) throw new MutationAbort("invalid_key");
	if (PROTOTYPE_POLLUTION_SEGMENTS.has(segment)) throw new MutationAbort("prototype_pollution_key");
}

function validateValueObjectKey(key: string): void {
	if (key.includes("\0") || PROTOTYPE_POLLUTION_SEGMENTS.has(key)) throw new MutationAbort("unsupported_value");
}

function validatePatchPath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new MutationAbort("invalid_key");
	const segments = value.split(".");
	for (const segment of segments) validateSegment(segment);
	return value;
}

function validateConfigurationValue(value: unknown, seen: WeakSet<object>): asserts value is ScopedConfigurationValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new MutationAbort("unsupported_value");
		return;
	}
	if (typeof value !== "object" || value === undefined) throw new MutationAbort("unsupported_value");
	if (seen.has(value)) throw new MutationAbort("unsupported_value");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			for (const entry of value) validateConfigurationValue(entry, seen);
			return;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new MutationAbort("unsupported_value");
		for (const [key, entry] of Object.entries(value)) {
			validateValueObjectKey(key);
			validateConfigurationValue(entry, seen);
		}
	} finally {
		seen.delete(value);
	}
}

function validatePatches(patches: readonly ScopedConfigurationPatch[]): ScopedConfigurationReceiptPatch[] {
	if (!Array.isArray(patches) || patches.length === 0) throw new MutationAbort("empty_patch");
	const paths = new Set<string>();
	const normalized: ScopedConfigurationReceiptPatch[] = [];
	for (const patch of patches) {
		if (typeof patch !== "object" || patch === null) throw new MutationAbort("invalid_patch");
		const pathValue = validatePatchPath((patch as { readonly path?: unknown }).path);
		if (paths.has(pathValue)) throw new MutationAbort("duplicate_patch_paths");
		for (const previous of paths) {
			if (pathValue.startsWith(`${previous}.`) || previous.startsWith(`${pathValue}.`)) {
				throw new MutationAbort("conflicting_patch_paths");
			}
		}
		paths.add(pathValue);
		const op = (patch as { readonly op?: unknown }).op;
		if (op === "set") {
			validateConfigurationValue((patch as { readonly value?: unknown }).value, new WeakSet<object>());
			normalized.push({ op: "set", path: pathValue });
		} else if (op === "clear") {
			normalized.push({ op: "clear", path: pathValue });
		} else {
			throw new MutationAbort("invalid_patch");
		}
	}
	return normalized;
}

function validateRuntime(runtime: ScopedConfigurationRuntime | undefined): void {
	if (runtime === undefined) return;
	if (
		typeof runtime !== "object" ||
		(runtime.phase !== "before_commit" && runtime.phase !== "after_commit") ||
		typeof runtime.apply !== "function"
	) {
		throw new MutationAbort("invalid_patch");
	}
}

function runtimeFromRequest(request: ScopedConfigurationMutationRequest): ScopedConfigurationRuntime | undefined {
	if (request.runtimeCallback === undefined && request.runtimePhase === undefined) return request.runtime;
	if (request.runtime !== undefined || request.runtimeCallback === undefined || request.runtimePhase === undefined) {
		throw new MutationAbort("invalid_patch");
	}
	return { phase: request.runtimePhase, apply: request.runtimeCallback };
}

async function readDocument(target: string, filesystem: ScopedConfigurationFilesystem): Promise<ParsedDocument> {
	let content: string;
	try {
		content = await filesystem.readFile(target, "utf8");
	} catch (error) {
		if (isMissing(error)) return { data: {}, exists: false };
		throw new MutationAbort("scope_rejected");
	}
	try {
		if (content.trim().length === 0) return { data: {}, exists: true };
		const parsed: unknown = YAML.parse(content);
		if (parsed === undefined) return { data: {}, exists: true };
		if (!isObject(parsed)) throw new MutationAbort("invalid_yaml_root");
		return { data: parsed, exists: true };
	} catch (error) {
		if (error instanceof MutationAbort) throw error;
		throw new MutationAbort("invalid_yaml");
	}
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	try {
		return structuredClone(value) as Record<string, unknown>;
	} catch {
		throw new MutationAbort("unsupported_value");
	}
}

function snapshotFrom(
	scope: Exclude<ScopedConfigurationScope, "managed">,
	inspection: PathInspection,
	document: ParsedDocument,
): ScopedConfigurationSnapshot {
	const data = cloneRecord(document.data);
	const digest = documentDigest(data);
	return Object.freeze({
		scope,
		path: inspection.safePath,
		safePath: inspection.safePath,
		exists: document.exists,
		ownerIdentity: inspection.exists ? inspection.ownerIdentity : `missing:${inspection.safePath}`,
		revision: digest,
		digest,
		data: Object.freeze(data),
	});
}

function safeExpectedOwner(
	expectedOwner: ScopedConfigurationExpectedOwner | undefined,
): ScopedConfigurationExpectedOwner {
	if (expectedOwner === undefined) return {};
	for (const value of [expectedOwner.identity, expectedOwner.revision, expectedOwner.digest]) {
		if (value !== undefined && (typeof value !== "string" || value.length === 0))
			throw new MutationAbort("scope_rejected");
	}
	return expectedOwner;
}

function expectedOwnerFromRequest(request: ScopedConfigurationMutationRequest): ScopedConfigurationExpectedOwner {
	const supplied = request.expectedOwner ?? {};
	for (const pair of [
		[supplied.identity, request.expectedOwnerIdentity],
		[supplied.revision, request.expectedOwnerRevision],
		[supplied.digest, request.expectedOwnerDigest],
	] as const) {
		if (pair[0] !== undefined && pair[1] !== undefined && pair[0] !== pair[1]) {
			throw new MutationAbort("scope_rejected");
		}
	}
	return safeExpectedOwner({
		identity: request.expectedOwnerIdentity ?? supplied.identity,
		revision: request.expectedOwnerRevision ?? supplied.revision,
		digest: request.expectedOwnerDigest ?? supplied.digest,
	});
}

function patchListFor(
	patches: readonly ScopedConfigurationPatch[],
	current: Record<string, unknown>,
): AtomicYamlPatch[] {
	return patches.map(patch => {
		const expected = { path: patch.path, hash: atomicYamlPathHash(current, patch.path) };
		if (patch.op === "set") {
			return {
				path: patch.path,
				op: "set",
				value: structuredClone(patch.value),
				expected,
			} satisfies AtomicYamlPatch;
		}
		return { path: patch.path, op: "unset", expected } satisfies AtomicYamlPatch;
	});
}

function applyToClone(
	value: Record<string, unknown>,
	patches: readonly ScopedConfigurationPatch[],
): Record<string, unknown> {
	const next = cloneRecord(value);
	for (const patch of patches) {
		const segments = patch.path.split(".");
		if (patch.op === "set") setByPath(next, segments, structuredClone(patch.value));
		else deleteByPath(next, segments);
	}
	return next;
}

function callbackSucceeded(result: ScopedConfigurationRuntimeResult | ScopedConfigurationReloadResult): boolean {
	if (typeof result === "boolean") return result;
	if (result === undefined) return true;
	return result.ok;
}

function resultReceipt(
	input: Omit<ScopedConfigurationMutationReceipt, "patches"> & {
		readonly patches?: readonly ScopedConfigurationReceiptPatch[];
	},
	patches: readonly ScopedConfigurationReceiptPatch[],
): ScopedConfigurationMutationReceipt {
	return Object.freeze({ ...input, patches: Object.freeze([...patches]) });
}

export function resolveNativeConfigurationTarget(
	scope: Exclude<ScopedConfigurationScope, "managed">,
	loadContext: LoadContext,
	agentDir: string,
): string {
	const resolved = validatePath(scope, loadContext, agentDir);
	return resolved.target;
}

export class NativeProjectSettingsStore {
	readonly #loadContext: LoadContext;
	readonly #agentDir: string;
	readonly #filesystem: ScopedConfigurationFilesystem;
	readonly #clock: ScopedConfigurationClock;

	constructor(options: NativeProjectSettingsStoreOptions) {
		this.#loadContext = Object.freeze({ ...options.loadContext });
		this.#agentDir = options.agentDir;
		this.#filesystem = options.filesystem ?? DEFAULT_FILESYSTEM;
		this.#clock = options.clock ?? DEFAULT_CLOCK;
	}

	target(scope: Exclude<ScopedConfigurationScope, "managed">): string {
		return validatePath(scope, this.#loadContext, this.#agentDir).target;
	}

	async read(scope: ScopedConfigurationScope): Promise<ScopedConfigurationSnapshot> {
		if (scope === "managed") throw new NativeProjectSettingsStoreError("scope_locked", null);
		const resolved = validatePath(scope, this.#loadContext, this.#agentDir);
		try {
			const firstInspection = await inspectTarget(resolved.basePath, resolved.target, this.#filesystem);
			const document = await readDocument(resolved.target, this.#filesystem);
			const secondInspection = await inspectTarget(resolved.basePath, resolved.target, this.#filesystem);
			if (
				firstInspection.ownerIdentity !== secondInspection.ownerIdentity ||
				firstInspection.exists !== secondInspection.exists
			) {
				throw new NativeProjectSettingsStoreError("scope_conflict", resolved.target);
			}
			void this.#clock();
			return snapshotFrom(scope, secondInspection, document);
		} catch (error) {
			if (error instanceof NativeProjectSettingsStoreError) throw error;
			if (error instanceof MutationAbort) throw new NativeProjectSettingsStoreError(error.code, resolved.target);
			throw new NativeProjectSettingsStoreError("scope_rejected", resolved.target);
		}
	}
}

export class ScopedConfigurationMutationService {
	readonly #loadContext: LoadContext;
	readonly #agentDir: string;
	readonly #reloadAndVerify: ScopedConfigurationReloadAndVerify;
	readonly #filesystem: ScopedConfigurationFilesystem;
	readonly #clock: ScopedConfigurationClock;
	readonly #store: NativeProjectSettingsStore;

	constructor(options: ScopedConfigurationMutationServiceOptions) {
		this.#loadContext = Object.freeze({ ...options.loadContext });
		this.#agentDir = options.agentDir;
		this.#reloadAndVerify = options.reloadAndVerify;
		this.#filesystem = options.filesystem ?? DEFAULT_FILESYSTEM;
		this.#clock = options.clock ?? DEFAULT_CLOCK;
		this.#store = new NativeProjectSettingsStore({
			loadContext: this.#loadContext,
			agentDir: this.#agentDir,
			filesystem: this.#filesystem,
			clock: this.#clock,
		});
	}

	async read(scope: Exclude<ScopedConfigurationScope, "managed">): Promise<ScopedConfigurationSnapshot> {
		return await this.#store.read(scope);
	}

	async mutate(request: ScopedConfigurationMutationRequest): Promise<ScopedConfigurationMutationReceipt> {
		const scope = request.scope;
		let patchReceipt: ScopedConfigurationReceiptPatch[];
		try {
			patchReceipt = validatePatches(request.patches);
		} catch (error) {
			const reason = error instanceof MutationAbort ? error.code : "invalid_patch";
			const knownScope: ScopedConfigurationScope =
				scope === "project" || scope === "user" || scope === "managed" ? scope : "project";
			return resultReceipt(
				{
					status: "rejected",
					reason,
					scope: knownScope,
					safePath:
						knownScope === "managed" ? null : safePathCandidate(knownScope, this.#loadContext, this.#agentDir),
					beforeRevision: null,
					afterRevision: null,
					beforeDigest: null,
					afterDigest: null,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				[],
			);
		}
		let runtime: ScopedConfigurationRuntime | undefined;
		try {
			runtime = runtimeFromRequest(request);
			validateRuntime(runtime);
		} catch (error) {
			const reason = error instanceof MutationAbort ? error.code : "invalid_patch";
			const knownScope: ScopedConfigurationScope =
				scope === "project" || scope === "user" || scope === "managed" ? scope : "project";
			return resultReceipt(
				{
					status: "rejected",
					reason,
					scope: knownScope,
					safePath:
						knownScope === "managed" ? null : safePathCandidate(knownScope, this.#loadContext, this.#agentDir),
					beforeRevision: null,
					afterRevision: null,
					beforeDigest: null,
					afterDigest: null,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				patchReceipt,
			);
		}
		if (scope !== "project" && scope !== "user" && scope !== "managed") {
			return resultReceipt(
				{
					status: "rejected",
					reason: "invalid_scope",
					scope,
					safePath: null,
					beforeRevision: null,
					afterRevision: null,
					beforeDigest: null,
					afterDigest: null,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				patchReceipt,
			);
		}
		if (scope === "managed") {
			return resultReceipt(
				{
					status: "locked",
					reason: "scope_locked",
					scope,
					safePath: null,
					beforeRevision: null,
					afterRevision: null,
					beforeDigest: null,
					afterDigest: null,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				patchReceipt,
			);
		}

		let resolved: { readonly basePath: string; readonly target: string };
		try {
			resolved = validatePath(scope, this.#loadContext, this.#agentDir);
		} catch (error) {
			const reason = error instanceof MutationAbort ? error.code : "scope_rejected";
			return resultReceipt(
				{
					status: reason === "project_scope_unavailable" ? "locked" : "rejected",
					reason,
					scope,
					safePath: safePathCandidate(scope, this.#loadContext, this.#agentDir),
					beforeRevision: null,
					afterRevision: null,
					beforeDigest: null,
					afterDigest: null,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				patchReceipt,
			);
		}

		let before: ScopedConfigurationSnapshot;
		try {
			before = await this.#store.read(scope);
		} catch (error) {
			const reason = error instanceof NativeProjectSettingsStoreError ? error.code : "scope_rejected";
			return resultReceipt(
				{
					status: "rejected",
					reason,
					scope,
					safePath: resolved.target,
					beforeRevision: null,
					afterRevision: null,
					beforeDigest: null,
					afterDigest: null,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				patchReceipt,
			);
		}

		let expected: ScopedConfigurationExpectedOwner;
		try {
			expected = expectedOwnerFromRequest(request);
		} catch (error) {
			const reason = error instanceof MutationAbort ? error.code : "scope_rejected";
			return resultReceipt(
				{
					status: "rejected",
					reason,
					scope,
					safePath: resolved.target,
					beforeRevision: before.revision,
					afterRevision: before.revision,
					beforeDigest: before.digest,
					afterDigest: before.digest,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				patchReceipt,
			);
		}
		const boundExpected: ScopedConfigurationExpectedOwner = {
			identity: expected.identity ?? before.ownerIdentity,
			revision: expected.revision ?? before.revision,
			digest: expected.digest ?? before.digest,
		};
		if (
			(boundExpected.identity !== undefined && boundExpected.identity !== before.ownerIdentity) ||
			(boundExpected.revision !== undefined && boundExpected.revision !== before.revision) ||
			(boundExpected.digest !== undefined && boundExpected.digest !== before.digest)
		) {
			return resultReceipt(
				{
					status: "conflict",
					reason: "scope_conflict",
					scope,
					safePath: resolved.target,
					beforeRevision: before.revision,
					afterRevision: before.revision,
					beforeDigest: before.digest,
					afterDigest: before.digest,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				patchReceipt,
			);
		}
		if (runtime?.phase === "before_commit") {
			try {
				const runtimeResult = await runtime.apply({
					scope,
					phase: "before_commit",
					target: resolved.target,
					path: resolved.target,
					safePath: resolved.target,
					patches: request.patches,
					before,
				});
				if (!callbackSucceeded(runtimeResult)) throw new MutationAbort("runtime_precommit_failed");
			} catch (error) {
				const reason = error instanceof MutationAbort ? error.code : "runtime_precommit_failed";
				return resultReceipt(
					{
						status: "rejected",
						reason,
						scope,
						safePath: resolved.target,
						beforeRevision: before.revision,
						afterRevision: before.revision,
						beforeDigest: before.digest,
						afterDigest: before.digest,
						timing: "next_session",
						confirmation: "not_applicable",
						durability: "none",
					},
					patchReceipt,
				);
			}
		}

		const expectedAfter = applyToClone(before.data, request.patches);
		const predictedAfterDigest = documentDigest(expectedAfter);
		let committed = false;
		try {
			await applyAtomicYamlPatchesWithCurrent(
				resolved.target,
				async current => {
					const currentInspection = await inspectTarget(resolved.basePath, resolved.target, this.#filesystem);
					const currentDigest = documentDigest(current);
					if (
						currentInspection.ownerIdentity !== boundExpected.identity ||
						currentDigest !== boundExpected.digest ||
						currentDigest !== boundExpected.revision
					) {
						throw new MutationAbort("scope_conflict");
					}
					if (request.commitGuard !== undefined) {
						let allowed: boolean;
						try {
							allowed = request.commitGuard();
						} catch {
							throw new MutationAbort("runtime_precommit_failed");
						}
						if (!allowed) throw new MutationAbort("runtime_precommit_failed");
					}
					return patchListFor(request.patches, current);
				},
				{
					validateRoot: root => {
						if (root !== undefined && !isObject(root)) throw new MutationAbort("invalid_yaml_root");
					},
				},
			);
			committed = true;
		} catch (error) {
			const reason = error instanceof MutationAbort ? error.code : "persistent_write_failed";
			const status: ScopedConfigurationMutationStatus = reason === "scope_conflict" ? "conflict" : "rejected";
			return resultReceipt(
				{
					status,
					reason,
					scope,
					safePath: resolved.target,
					beforeRevision: before.revision,
					afterRevision: before.revision,
					beforeDigest: before.digest,
					afterDigest: before.digest,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				patchReceipt,
			);
		}
		if (!committed) {
			return resultReceipt(
				{
					status: "rejected",
					reason: "persistent_write_failed",
					scope,
					safePath: resolved.target,
					beforeRevision: before.revision,
					afterRevision: before.revision,
					beforeDigest: before.digest,
					afterDigest: before.digest,
					timing: "next_session",
					confirmation: "not_applicable",
					durability: "none",
				},
				patchReceipt,
			);
		}

		let after: ScopedConfigurationSnapshot;
		try {
			after = await this.#store.read(scope);
		} catch {
			return resultReceipt(
				{
					status: "degraded",
					reason: "persistent_reload_unconfirmed",
					scope,
					safePath: resolved.target,
					beforeRevision: before.revision,
					afterRevision: null,
					beforeDigest: before.digest,
					afterDigest: null,
					timing: runtime?.phase === "after_commit" ? "current_runtime" : "next_session",

					confirmation: "unconfirmed",
					durability: "committed_unconfirmed",
				},
				patchReceipt,
			);
		}

		let reloadConfirmed = true;
		try {
			const reloadResult = await this.#reloadAndVerify({
				scope,
				target: resolved.target,
				path: resolved.target,

				safePath: resolved.target,
				patches: request.patches,
				before,
				after,
			});
			reloadConfirmed = callbackSucceeded(reloadResult);
		} catch {
			reloadConfirmed = false;
		}
		const durableMatches = after.digest === predictedAfterDigest;
		const persistentMismatch = !reloadConfirmed || !durableMatches;
		let runtimeApplied = false;
		let runtimeFailed = false;
		if (runtime?.phase === "after_commit") {
			try {
				const runtimeResult = await runtime.apply({
					scope,
					phase: "after_commit",
					target: resolved.target,
					path: resolved.target,
					safePath: resolved.target,
					patches: request.patches,
					before,
					after,
				});
				runtimeApplied = callbackSucceeded(runtimeResult);
				runtimeFailed = !runtimeApplied;
			} catch {
				runtimeFailed = true;
			}
		}
		void this.#clock();
		const degraded = persistentMismatch || runtimeFailed;
		const reason: ScopedConfigurationReasonCode | null = runtimeFailed
			? "runtime_postcommit_failed"
			: persistentMismatch
				? "persistent_reload_mismatch"
				: null;
		const status: ScopedConfigurationMutationStatus = degraded
			? "degraded"
			: runtimeApplied
				? "applied"
				: "committed";
		return resultReceipt(
			{
				status,
				reason,
				scope,
				safePath: resolved.target,
				beforeRevision: before.revision,
				afterRevision: after.revision,
				beforeDigest: before.digest,
				afterDigest: after.digest,
				timing: runtime?.phase === "after_commit" ? "current_runtime" : "next_session",
				confirmation: degraded ? "unconfirmed" : "confirmed",
				durability: degraded ? "committed_unconfirmed" : "committed",
			},
			patchReceipt,
		);
	}
}
