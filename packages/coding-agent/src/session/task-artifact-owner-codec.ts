import * as crypto from "node:crypto";
import * as path from "node:path";
import type { NativeExactUnlinkResult } from "@gajae-code/natives";
import type { ManagedDirectoryRoot, ManagedSessionSecurityPolicy } from "./internal/managed-session-storage";
import type { NativeDirectoryTreeSnapshot } from "./session-storage";

export const OWNER_DIRECTORY = ".task-artifact-owners";
export const OWNER_LOCK_DIRECTORY = ".task-artifact-owner-locks";
export const OWNER_MANIFEST = ".gjc-task-artifact-owner-v1.json";
export const OWNER_SCHEMA_VERSION = 1 as const;
export const OWNER_DELETION_SCHEMA_VERSION = 2 as const;
export const OWNER_RETIREMENT_SCHEMA_VERSION = 1 as const;
export const EMPTY_PAYLOAD_SHA256 = crypto.createHash("sha256").update("").digest("hex");

const TREE_ENTRY_KEYS = new Set([
	"relativePath",
	"kind",
	"dev",
	"ino",
	"nlink",
	"size",
	"mtimeNs",
	"ctimeNs",
	"sha256",
]);
const RETIREMENT_CONTINUATION_KEYS = new Set([
	"schemaVersion",
	"parentIdentity",
	"retainedRootPath",
	"retainedTreeSnapshot",
	"detachedPaths",
	"nativeCodes",
	"payloadDurable",
	"retainedSuccessorPaths",
	"retainedPlaceholderPaths",
	"retainedUnknownPaths",
	"windowsErrorCodes",
]);
const U64_MAX = 18_446_744_073_709_551_615n;

type NativeDirectoryTreeEntry = NativeDirectoryTreeSnapshot["entries"][number];
type ExpectedTreeChildren = {
	readonly direct: Map<string, NativeDirectoryTreeEntry>;
	readonly quarantined: Map<string, NativeDirectoryTreeEntry | null>;
};

export interface TaskArtifactOwnerLocator {
	readonly schemaVersion: typeof OWNER_SCHEMA_VERSION;
	readonly ownerId: string;
	readonly directoryDev: string;
	readonly directoryIno: string;
}

export interface TaskArtifactOwnerStorageContext {
	readonly rootAuthority: ManagedDirectoryRoot;
	readonly sessionsRoot: string;
	readonly securityPolicy: ManagedSessionSecurityPolicy;
	readonly profileAgentDir: string;
}

/** Exact parent directory identity authorizing direct native owner-tree removal. */
export interface TaskArtifactOwnerParentIdentity {
	readonly dev: string;
	readonly ino: string;
}

/** Immutable exact deletion input retained by managed lifecycle tombstones and retries. */
export interface TaskArtifactOwnerDeletionEvidence {
	readonly schemaVersion: typeof OWNER_DELETION_SCHEMA_VERSION;
	readonly sessionId: string;
	readonly locator: TaskArtifactOwnerLocator;
	readonly parentIdentity: TaskArtifactOwnerParentIdentity;
	readonly treeSnapshot: NativeDirectoryTreeSnapshot;
}

/** Native retained-root and side-path state safe to persist for a later retirement attempt. */
export interface TaskArtifactOwnerRetirementContinuation {
	readonly schemaVersion: typeof OWNER_RETIREMENT_SCHEMA_VERSION;
	/** Must remain equal to the immutable evidence's managed owner-parent identity. */
	readonly parentIdentity: TaskArtifactOwnerParentIdentity;
	/** Only the original owner root or its native `.removing` sibling is actionable. */
	readonly retainedRootPath: string;
	/** Last identity-checked tree snapshot; it may only shrink from the original evidence. */
	readonly retainedTreeSnapshot: NativeDirectoryTreeSnapshot;
	/** Historical exact native detached-root roles; these paths are diagnostics, not extra authority. */
	readonly detachedPaths?: readonly string[];
	readonly nativeCodes?: readonly string[];
	readonly payloadDurable?: boolean;
	readonly retainedSuccessorPaths?: readonly string[];
	readonly retainedPlaceholderPaths?: readonly string[];
	readonly retainedUnknownPaths?: readonly string[];
	readonly windowsErrorCodes?: readonly string[];
}

/** `completed` is decoded persisted data, not proof of physical retirement or writer closure. */
export type TaskArtifactOwnerRetirementOutcome =
	| {
			readonly kind: "completed";
			readonly evidence: TaskArtifactOwnerDeletionEvidence;
			readonly nativeOutcome?: NativeExactUnlinkResult;
	  }
	| {
			/** Live payload is durably destroyed; native namespace cleanup remains pending. */
			readonly kind: "payload_retired";
			readonly namespace: "retained";
			readonly evidence: TaskArtifactOwnerDeletionEvidence;
			readonly continuation: TaskArtifactOwnerRetirementContinuation;
			readonly nativeOutcome: NativeExactUnlinkResult;
	  }
	| {
			/** Native explicitly retained cleanup state with a validated, non-expanding continuation. */
			readonly kind: "cleanup_pending";
			readonly evidence: TaskArtifactOwnerDeletionEvidence;
			readonly continuation: TaskArtifactOwnerRetirementContinuation;
			readonly nativeOutcome?: NativeExactUnlinkResult;
	  }
	| {
			/** No safe completion proof exists; callers must retain evidence and continuation. */
			readonly kind: "uncertain";
			readonly evidence: TaskArtifactOwnerDeletionEvidence;
			readonly continuation: TaskArtifactOwnerRetirementContinuation;
			readonly reason: string;
			readonly nativeOutcome?: NativeExactUnlinkResult;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True only for canonical unsigned decimal strings within the native u64 range. */
export function isCanonicalDecimal(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value);
}

export function isCanonicalNativeId(value: unknown): value is string {
	return isCanonicalDecimal(value) && value.length <= 20 && BigInt(value) <= U64_MAX;
}

/** Deterministic owner identity bound to one non-empty logical session ID. */
export function ownerIdForSession(sessionId: string): string {
	if (sessionId.length === 0) throw new Error("task_artifact_owner_session_id_invalid");
	return crypto.createHash("sha256").update(sessionId, "utf8").digest("hex");
}

export function ownerRelativePath(ownerId: string): string {
	return `${OWNER_DIRECTORY}/${ownerId}`;
}

export function manifestRelativePath(ownerId: string): string {
	return `${ownerRelativePath(ownerId)}/${OWNER_MANIFEST}`;
}

export function assertSafeRelativePath(relativePath: string): void {
	if (
		relativePath.length === 0 ||
		path.posix.isAbsolute(relativePath) ||
		relativePath.split("/").some(component => component.length === 0 || component === "." || component === "..") ||
		relativePath.includes("\\")
	)
		throw new Error("task_artifact_owner_relative_path_invalid");
}

export function assertSessionRoot(context: TaskArtifactOwnerStorageContext): void {
	if (path.resolve(context.sessionsRoot) !== context.sessionsRoot) throw new Error("task_artifact_owner_root_invalid");
}

function parseTreeSnapshot(value: unknown): NativeDirectoryTreeSnapshot {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 3 ||
		!isCanonicalNativeId(value.rootDev) ||
		!isCanonicalNativeId(value.rootIno)
	)
		throw new Error("task_artifact_owner_evidence_invalid");
	if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 50_000)
		throw new Error("task_artifact_owner_evidence_invalid");
	const entries: NativeDirectoryTreeEntry[] = [];
	const seen = new Set<string>();
	for (const rawEntry of value.entries) {
		if (
			!isRecord(rawEntry) ||
			Object.keys(rawEntry).length < 8 ||
			Object.keys(rawEntry).length > 9 ||
			typeof rawEntry.relativePath !== "string" ||
			(rawEntry.kind !== "directory" && rawEntry.kind !== "file") ||
			!isCanonicalNativeId(rawEntry.dev) ||
			!isCanonicalNativeId(rawEntry.ino) ||
			!isCanonicalNativeId(rawEntry.nlink) ||
			!isCanonicalNativeId(rawEntry.size) ||
			!isCanonicalDecimal(rawEntry.mtimeNs) ||
			!isCanonicalDecimal(rawEntry.ctimeNs) ||
			(rawEntry.sha256 !== undefined &&
				(typeof rawEntry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(rawEntry.sha256))) ||
			Object.keys(rawEntry).some(key => !TREE_ENTRY_KEYS.has(key))
		)
			throw new Error("task_artifact_owner_evidence_invalid");
		if (
			rawEntry.relativePath.includes("\\") ||
			(rawEntry.relativePath !== "" &&
				(rawEntry.relativePath.startsWith("/") ||
					rawEntry.relativePath.split("/").some(part => part.length === 0 || part === "." || part === ".."))) ||
			seen.has(rawEntry.relativePath)
		)
			throw new Error("task_artifact_owner_evidence_invalid");
		seen.add(rawEntry.relativePath);
		entries.push({
			relativePath: rawEntry.relativePath,
			kind: rawEntry.kind,
			dev: rawEntry.dev,
			ino: rawEntry.ino,
			nlink: rawEntry.nlink,
			size: rawEntry.size,
			mtimeNs: rawEntry.mtimeNs,
			ctimeNs: rawEntry.ctimeNs,
			...(typeof rawEntry.sha256 === "string" ? { sha256: rawEntry.sha256 } : {}),
		});
	}
	const root = entries.find(entry => entry.relativePath === "");
	if (root?.kind !== "directory" || root.dev !== value.rootDev || root.ino !== value.rootIno)
		throw new Error("task_artifact_owner_evidence_invalid");
	const entryKinds = new Map(entries.map(entry => [entry.relativePath, entry.kind]));
	for (const entry of entries) {
		if (entry.relativePath === "") continue;
		const separator = entry.relativePath.lastIndexOf("/");
		const parent = separator < 0 ? "" : entry.relativePath.slice(0, separator);
		if (entryKinds.get(parent) !== "directory") throw new Error("task_artifact_owner_evidence_invalid");
	}
	return { rootDev: value.rootDev, rootIno: value.rootIno, entries };
}

export function freezeTreeSnapshot(snapshot: NativeDirectoryTreeSnapshot): NativeDirectoryTreeSnapshot {
	const canonical = parseTreeSnapshot(snapshot);
	for (const entry of canonical.entries) Object.freeze(entry);
	Object.freeze(canonical.entries);
	return Object.freeze(canonical);
}

/** Windows native tree removal hashes original path and inode identity for child quarantine names. */
function treeQuarantineName(entry: NativeDirectoryTreeEntry): string {
	const material = `${entry.relativePath}\0${entry.dev}\0${entry.ino}`;
	return `.pi-tree-detached-${crypto.createHash("sha256").update(material, "utf8").digest("hex")}`;
}

/** Project only authenticated remaining entries; never restore an omitted entry's authority. */
export function normalizeRetainedTreeSnapshot(
	expected: NativeDirectoryTreeSnapshot,
	retained: NativeDirectoryTreeSnapshot,
): NativeDirectoryTreeSnapshot | undefined {
	if (expected.rootDev !== retained.rootDev || expected.rootIno !== retained.rootIno) return undefined;
	const expectedEntries = new Map(expected.entries.map(entry => [entry.relativePath, entry]));
	if (retained.entries.length > expected.entries.length) return undefined;

	const childrenByParent = new Map<string, ExpectedTreeChildren>();
	for (const entry of expected.entries) {
		if (entry.relativePath === "") continue;
		const separator = entry.relativePath.lastIndexOf("/");
		const parent = separator < 0 ? "" : entry.relativePath.slice(0, separator);
		const name = separator < 0 ? entry.relativePath : entry.relativePath.slice(separator + 1);
		let children = childrenByParent.get(parent);
		if (!children) {
			children = { direct: new Map(), quarantined: new Map() };
			childrenByParent.set(parent, children);
		}
		children.direct.set(name, entry);
		const quarantineName = treeQuarantineName(entry);
		children.quarantined.set(quarantineName, children.quarantined.has(quarantineName) ? null : entry);
	}

	const originalPathFor = (retainedPath: string): string | undefined => {
		if (retainedPath === "") return "";
		const components = retainedPath.split("/");
		if (components.some(component => component.length === 0 || component === "." || component === ".."))
			return undefined;
		let parent = "";
		for (const component of components) {
			const children = childrenByParent.get(parent);
			if (!children) return undefined;
			const direct = children.direct.get(component);
			const hasQuarantine = children.quarantined.has(component);
			const quarantined = children.quarantined.get(component);
			if ((direct && hasQuarantine) || quarantined === null) return undefined;
			const matched = direct ?? quarantined;
			if (!matched) return undefined;
			parent = matched.relativePath;
		}
		return parent;
	};

	const seenOriginalPaths = new Set<string>();
	const entries: NativeDirectoryTreeEntry[] = [];
	const valid = retained.entries.every(entry => {
		const originalPath = originalPathFor(entry.relativePath);
		if (originalPath === undefined || seenOriginalPaths.has(originalPath)) return false;
		seenOriginalPaths.add(originalPath);
		entries.push({ ...entry, relativePath: originalPath });
		if (originalPath === "") return entry.kind === "directory";
		const authorized = expectedEntries.get(originalPath);
		if (
			authorized === undefined ||
			authorized.kind !== entry.kind ||
			authorized.dev !== entry.dev ||
			authorized.ino !== entry.ino ||
			authorized.nlink !== entry.nlink
		)
			return false;
		if (entry.kind !== "file") return entry.size === authorized.size;
		const scrubbed = entry.size === "0" && entry.sha256 === EMPTY_PAYLOAD_SHA256;
		if (scrubbed) return true;
		if (entry.size !== authorized.size || entry.sha256 !== authorized.sha256) return false;
		return (
			entry.sha256 !== undefined || (entry.mtimeNs === authorized.mtimeNs && entry.ctimeNs === authorized.ctimeNs)
		);
	});
	return valid ? { rootDev: retained.rootDev, rootIno: retained.rootIno, entries } : undefined;
}

export function retainedTreeDoesNotExpandAuthority(
	expected: NativeDirectoryTreeSnapshot,
	retained: NativeDirectoryTreeSnapshot,
): boolean {
	return normalizeRetainedTreeSnapshot(expected, retained) !== undefined;
}

export function sameTreeContents(left: NativeDirectoryTreeSnapshot, right: NativeDirectoryTreeSnapshot): boolean {
	const project = (snapshot: NativeDirectoryTreeSnapshot) =>
		snapshot.entries.map(entry =>
			entry.kind === "directory"
				? { relativePath: entry.relativePath, kind: entry.kind }
				: { relativePath: entry.relativePath, kind: entry.kind, size: entry.size, sha256: entry.sha256 },
		);
	return JSON.stringify(project(left)) === JSON.stringify(project(right));
}

function parseParentIdentity(value: unknown): TaskArtifactOwnerParentIdentity {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 2 ||
		!isCanonicalNativeId(value.dev) ||
		!isCanonicalNativeId(value.ino)
	)
		throw new Error("task_artifact_owner_evidence_invalid");
	return Object.freeze({ dev: value.dev, ino: value.ino });
}

export function sameOwnerParentIdentity(
	left: TaskArtifactOwnerParentIdentity,
	right: TaskArtifactOwnerParentIdentity,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export function immutableDeletionEvidence(
	sessionId: string,
	locatorValue: TaskArtifactOwnerLocator,
	parentIdentityValue: TaskArtifactOwnerParentIdentity,
	treeSnapshotValue: NativeDirectoryTreeSnapshot,
): TaskArtifactOwnerDeletionEvidence {
	if (sessionId.length === 0) throw new Error("task_artifact_owner_evidence_invalid");
	const locator = parseTaskArtifactOwnerLocator(locatorValue);
	if (!locator || locator.ownerId !== ownerIdForSession(sessionId))
		throw new Error("task_artifact_owner_evidence_invalid");
	const parentIdentity = parseParentIdentity(parentIdentityValue);
	const treeSnapshot = freezeTreeSnapshot(treeSnapshotValue);
	if (treeSnapshot.rootDev !== locator.directoryDev || treeSnapshot.rootIno !== locator.directoryIno)
		throw new Error("task_artifact_owner_evidence_invalid");
	return Object.freeze({
		schemaVersion: OWNER_DELETION_SCHEMA_VERSION,
		sessionId,
		locator,
		parentIdentity,
		treeSnapshot,
	});
}

/** Parse a persisted locator. Missing metadata returns undefined; malformed metadata fails closed. */
export function parseTaskArtifactOwnerLocator(value: unknown): TaskArtifactOwnerLocator | undefined {
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 4 ||
		value.schemaVersion !== OWNER_SCHEMA_VERSION ||
		typeof value.ownerId !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.ownerId) ||
		!isCanonicalNativeId(value.directoryDev) ||
		!isCanonicalNativeId(value.directoryIno)
	)
		throw new Error("task_artifact_owner_locator_invalid");
	return Object.freeze({
		schemaVersion: OWNER_SCHEMA_VERSION,
		ownerId: value.ownerId,
		directoryDev: value.directoryDev,
		directoryIno: value.directoryIno,
	});
}

/** Validate JSON-restored tombstone evidence before it is used for exact retirement. */
export function parseTaskArtifactOwnerDeletionEvidence(value: unknown): TaskArtifactOwnerDeletionEvidence {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 5 ||
		value.schemaVersion !== OWNER_DELETION_SCHEMA_VERSION ||
		typeof value.sessionId !== "string"
	)
		throw new Error("task_artifact_owner_evidence_invalid");
	const locator = parseTaskArtifactOwnerLocator(value.locator);
	if (!locator) throw new Error("task_artifact_owner_evidence_invalid");
	return immutableDeletionEvidence(
		value.sessionId,
		locator,
		parseParentIdentity(value.parentIdentity),
		parseTreeSnapshot(value.treeSnapshot),
	);
}

export function ownerAbsolutePath(context: TaskArtifactOwnerStorageContext, ownerId: string): string {
	return path.join(context.sessionsRoot, ownerRelativePath(ownerId));
}

export function isOwnerRetainedRoot(
	context: TaskArtifactOwnerStorageContext,
	ownerId: string,
	pathname: string,
): boolean {
	const owner = ownerAbsolutePath(context, ownerId);
	return pathname === owner || pathname === `${owner}.removing`;
}

export function isKnownNativeSidePath(
	context: TaskArtifactOwnerStorageContext,
	ownerId: string,
	pathname: string,
): boolean {
	if (!path.isAbsolute(pathname) || path.resolve(pathname) !== pathname) return false;
	if (isOwnerRetainedRoot(context, ownerId, pathname)) return true;
	const ownerParent = path.dirname(ownerAbsolutePath(context, ownerId));
	const sideName = path.basename(pathname);
	if (path.dirname(pathname) === ownerParent && sideName.startsWith(".gjc-") && sideName.length > 5) return true;
	const recoveryParent = path.join(context.sessionsRoot, ".gjc-recovery");
	const recoveryRelative = path.relative(recoveryParent, pathname);
	return (
		recoveryRelative !== "" &&
		!path.isAbsolute(recoveryRelative) &&
		recoveryRelative !== ".." &&
		!recoveryRelative.startsWith(`..${path.sep}`) &&
		!recoveryRelative.includes(path.sep)
	);
}

/** Validate JSON-restored native continuation data against immutable owner authorization. */
export function parseTaskArtifactOwnerRetirementContinuation(
	context: TaskArtifactOwnerStorageContext,
	evidenceValue: TaskArtifactOwnerDeletionEvidence,
	value: unknown,
): TaskArtifactOwnerRetirementContinuation {
	assertSessionRoot(context);
	const evidence = parseTaskArtifactOwnerDeletionEvidence(evidenceValue);
	if (
		!isRecord(value) ||
		Object.keys(value).length < 4 ||
		Object.keys(value).length > 11 ||
		Object.keys(value).some(key => !RETIREMENT_CONTINUATION_KEYS.has(key)) ||
		value.schemaVersion !== OWNER_RETIREMENT_SCHEMA_VERSION ||
		typeof value.retainedRootPath !== "string"
	)
		throw new Error("task_artifact_owner_continuation_invalid");
	const parentIdentity = parseParentIdentity(value.parentIdentity);
	if (!sameOwnerParentIdentity(parentIdentity, evidence.parentIdentity))
		throw new Error("task_artifact_owner_continuation_invalid");
	if (!isOwnerRetainedRoot(context, evidence.locator.ownerId, value.retainedRootPath))
		throw new Error("task_artifact_owner_continuation_invalid");
	const retainedTreeSnapshot = freezeTreeSnapshot(parseTreeSnapshot(value.retainedTreeSnapshot));
	if (!retainedTreeDoesNotExpandAuthority(evidence.treeSnapshot, retainedTreeSnapshot))
		throw new Error("task_artifact_owner_continuation_invalid");
	const optionalStringList = (
		key: string,
		maximum: number,
		validate: (candidate: string) => boolean,
	): readonly string[] | undefined => {
		const candidates = value[key];
		if (candidates === undefined) return undefined;
		if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > maximum)
			throw new Error("task_artifact_owner_continuation_invalid");
		const parsed = candidates.map(candidate => {
			if (typeof candidate !== "string" || !validate(candidate))
				throw new Error("task_artifact_owner_continuation_invalid");
			return candidate;
		});
		if (new Set(parsed).size !== parsed.length) throw new Error("task_artifact_owner_continuation_invalid");
		return Object.freeze(parsed);
	};
	const isNativeSidePath = (candidate: string) => isKnownNativeSidePath(context, evidence.locator.ownerId, candidate);
	const detachedPaths = optionalStringList("detachedPaths", 2, candidate =>
		isOwnerRetainedRoot(context, evidence.locator.ownerId, candidate),
	);
	const nativeCodes = optionalStringList("nativeCodes", 64, candidate => /^[A-Za-z0-9_.:-]{1,128}$/u.test(candidate));
	const retainedSuccessorPaths = optionalStringList("retainedSuccessorPaths", 256, isNativeSidePath);
	const retainedPlaceholderPaths = optionalStringList("retainedPlaceholderPaths", 256, isNativeSidePath);
	const retainedUnknownPaths = optionalStringList("retainedUnknownPaths", 256, isNativeSidePath);
	const windowsErrorCodes = optionalStringList("windowsErrorCodes", 64, candidate =>
		/^0x[0-9A-Fa-f]{8}$/u.test(candidate),
	);
	if (value.payloadDurable !== undefined && typeof value.payloadDurable !== "boolean")
		throw new Error("task_artifact_owner_continuation_invalid");
	return Object.freeze({
		schemaVersion: OWNER_RETIREMENT_SCHEMA_VERSION,
		parentIdentity,
		retainedRootPath: value.retainedRootPath,
		retainedTreeSnapshot,
		...(detachedPaths !== undefined ? { detachedPaths } : {}),
		...(nativeCodes !== undefined ? { nativeCodes } : {}),
		...(value.payloadDurable !== undefined ? { payloadDurable: value.payloadDurable } : {}),
		...(retainedSuccessorPaths !== undefined ? { retainedSuccessorPaths } : {}),
		...(retainedPlaceholderPaths !== undefined ? { retainedPlaceholderPaths } : {}),
		...(retainedUnknownPaths !== undefined ? { retainedUnknownPaths } : {}),
		...(windowsErrorCodes !== undefined ? { windowsErrorCodes } : {}),
	});
}

/**
 * Strictly decode persisted managed-journal data. Parsing does not establish current physical retirement,
 * payload destruction, or writer quiescence.
 */
export function parseTaskArtifactOwnerRetirementOutcome(
	context: TaskArtifactOwnerStorageContext,
	evidence: TaskArtifactOwnerDeletionEvidence,
	value: unknown,
): TaskArtifactOwnerRetirementOutcome {
	const invalid = (): never => {
		throw new Error("task_artifact_owner_retirement_outcome_invalid");
	};
	if (!isRecord(value)) return invalid();
	const kind = value.kind;
	if (kind !== "completed" && kind !== "payload_retired" && kind !== "cleanup_pending" && kind !== "uncertain")
		return invalid();
	const expectedKeys = [
		"kind",
		"evidence",
		...(kind !== "completed" ? ["continuation"] : []),
		...(kind === "payload_retired" ? ["namespace"] : []),
		...(kind === "uncertain" ? ["reason"] : []),
		...(value.nativeOutcome !== undefined ? ["nativeOutcome"] : []),
	];
	if (Object.keys(value).length !== expectedKeys.length || !expectedKeys.every(key => key in value)) return invalid();
	const original = parseTaskArtifactOwnerDeletionEvidence(value.evidence);
	const expectedEvidence = parseTaskArtifactOwnerDeletionEvidence(evidence);
	if (JSON.stringify(original) !== JSON.stringify(expectedEvidence)) return invalid();
	const continuation =
		kind !== "completed"
			? parseTaskArtifactOwnerRetirementContinuation(context, expectedEvidence, value.continuation)
			: undefined;
	let nativeOutcome: NativeExactUnlinkResult | undefined;
	if (value.nativeOutcome !== undefined) {
		if (!isRecord(value.nativeOutcome)) return invalid();
		const record = value.nativeOutcome;
		const allowed = [
			"ok",
			"code",
			"detachedPath",
			"retainedSuccessorPath",
			"retainedPlaceholderPath",
			"retainedUnknownPath",
			"payloadDurable",
			"windowsErrorCode",
		];
		if (Object.keys(record).some(key => !allowed.includes(key)) || typeof record.ok !== "boolean") return invalid();
		if (record.ok && Object.keys(record).length !== 1) return invalid();
		for (const [key, paths] of [
			["detachedPath", continuation?.detachedPaths],
			["retainedSuccessorPath", continuation?.retainedSuccessorPaths],
			["retainedPlaceholderPath", continuation?.retainedPlaceholderPaths],
			["retainedUnknownPath", continuation?.retainedUnknownPaths],
		] as const) {
			const pathname = record[key];
			if (pathname !== undefined && (typeof pathname !== "string" || !paths?.includes(pathname))) return invalid();
		}
		if (
			record.code !== undefined &&
			(record.ok || typeof record.code !== "string" || !continuation?.nativeCodes?.includes(record.code))
		)
			return invalid();
		if (
			record.payloadDurable !== undefined &&
			(typeof record.payloadDurable !== "boolean" ||
				(record.payloadDurable && (record.ok || continuation?.payloadDurable !== true)))
		)
			return invalid();
		if (
			record.windowsErrorCode !== undefined &&
			(record.ok ||
				typeof record.windowsErrorCode !== "string" ||
				!continuation?.windowsErrorCodes?.includes(record.windowsErrorCode))
		)
			return invalid();
		nativeOutcome = Object.freeze({
			ok: record.ok,
			...(typeof record.code === "string" ? { code: record.code } : {}),
			...(typeof record.detachedPath === "string" ? { detachedPath: record.detachedPath } : {}),
			...(typeof record.retainedSuccessorPath === "string"
				? { retainedSuccessorPath: record.retainedSuccessorPath }
				: {}),
			...(typeof record.retainedPlaceholderPath === "string"
				? { retainedPlaceholderPath: record.retainedPlaceholderPath }
				: {}),
			...(typeof record.retainedUnknownPath === "string" ? { retainedUnknownPath: record.retainedUnknownPath } : {}),
			...(typeof record.payloadDurable === "boolean" ? { payloadDurable: record.payloadDurable } : {}),
			...(typeof record.windowsErrorCode === "string" ? { windowsErrorCode: record.windowsErrorCode } : {}),
		}) as NativeExactUnlinkResult;
	}
	if (kind === "completed") {
		if (!nativeOutcome?.ok) return invalid();
		return Object.freeze({ kind, evidence: original, nativeOutcome });
	}
	if (!continuation || (kind !== "uncertain" && nativeOutcome?.ok)) return invalid();
	if (kind === "payload_retired") {
		if (
			value.namespace !== "retained" ||
			nativeOutcome?.code !== "cleanup_pending" ||
			nativeOutcome.payloadDurable !== true ||
			continuation.retainedRootPath !== `${ownerAbsolutePath(context, expectedEvidence.locator.ownerId)}.removing` ||
			continuation.retainedSuccessorPaths?.length ||
			continuation.retainedPlaceholderPaths?.length ||
			continuation.retainedUnknownPaths?.length ||
			continuation.retainedTreeSnapshot.entries.some(
				entry => entry.kind === "file" && (entry.size !== "0" || entry.sha256 !== EMPTY_PAYLOAD_SHA256),
			)
		)
			return invalid();
		return Object.freeze({ kind, namespace: "retained", evidence: original, continuation, nativeOutcome });
	}
	if (kind === "uncertain") {
		if (typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 4096) return invalid();
		return Object.freeze({
			kind,
			evidence: original,
			continuation,
			reason: value.reason,
			...(nativeOutcome ? { nativeOutcome } : {}),
		});
	}
	return Object.freeze({ kind, evidence: original, continuation, ...(nativeOutcome ? { nativeOutcome } : {}) });
}
