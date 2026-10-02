import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	NativeDirectoryTreeEntry,
	NativeDirectoryTreeSnapshot,
	NativeExactUnlinkResult,
} from "@gajae-code/natives";
import { ArtifactManager } from "./artifacts";
import {
	acquireManagedLock,
	type ManagedDirectoryRoot,
	ManagedSessionDescendantStore,
	type ManagedSessionSecurityPolicy,
} from "./internal/managed-session-storage";

const OWNER_DIRECTORY = ".task-artifact-owners";
const OWNER_LOCK_DIRECTORY = ".task-artifact-owner-locks";
const OWNER_MANIFEST = ".gjc-task-artifact-owner-v1.json";
const OWNER_SCHEMA_VERSION = 1 as const;
const OWNER_DELETION_SCHEMA_VERSION = 2 as const;
const OWNER_RETIREMENT_SCHEMA_VERSION = 1 as const;
const EMPTY_PAYLOAD_SHA256 = crypto.createHash("sha256").update("").digest("hex");
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

export interface TaskArtifactOwnerLocator {
	schemaVersion: typeof OWNER_SCHEMA_VERSION;
	ownerId: string;
	directoryDev: string;
	directoryIno: string;
}

export interface TaskArtifactOwnerStorageContext {
	readonly rootAuthority: ManagedDirectoryRoot;
	readonly sessionsRoot: string;
	readonly securityPolicy: ManagedSessionSecurityPolicy;
	readonly profileAgentDir: string;
}

export interface ManagedTaskArtifactOwner {
	readonly locator: TaskArtifactOwnerLocator;
	readonly manager: ArtifactManager;
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

/** `completed` requires native success and no remaining owner root or retained side-path role. */
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

interface OwnerManifest extends TaskArtifactOwnerLocator {
	sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalDecimal(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value);
}

function isCanonicalNativeId(value: unknown): value is string {
	return isCanonicalDecimal(value) && value.length <= 20 && BigInt(value) <= 18_446_744_073_709_551_615n;
}

function ownerIdForSession(sessionId: string): string {
	if (sessionId.length === 0 || sessionId.length > 512) throw new Error("task_artifact_owner_session_id_invalid");
	return crypto.createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function ownerRelativePath(ownerId: string): string {
	return `${OWNER_DIRECTORY}/${ownerId}`;
}

function manifestRelativePath(ownerId: string): string {
	return `${ownerRelativePath(ownerId)}/${OWNER_MANIFEST}`;
}

function assertSafeRelativePath(relativePath: string): void {
	if (
		relativePath.length === 0 ||
		path.posix.isAbsolute(relativePath) ||
		relativePath.split("/").some(component => component.length === 0 || component === "." || component === "..") ||
		relativePath.includes("\\")
	)
		throw new Error("task_artifact_owner_relative_path_invalid");
}

function assertSessionRoot(context: TaskArtifactOwnerStorageContext): void {
	if (path.resolve(context.sessionsRoot) !== context.sessionsRoot) throw new Error("task_artifact_owner_root_invalid");
}

function newSessionRootStore(context: TaskArtifactOwnerStorageContext): ManagedSessionDescendantStore {
	assertSessionRoot(context);
	return new ManagedSessionDescendantStore(
		context.rootAuthority,
		context.sessionsRoot,
		undefined,
		context.securityPolicy,
		context.profileAgentDir,
	);
}

function parseOwnerManifest(value: Uint8Array): OwnerManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value).toString("utf8"));
	} catch {
		throw new Error("task_artifact_owner_manifest_invalid");
	}
	if (
		!isRecord(parsed) ||
		Object.keys(parsed).length !== 5 ||
		parsed.schemaVersion !== OWNER_SCHEMA_VERSION ||
		typeof parsed.sessionId !== "string" ||
		parsed.sessionId.length === 0 ||
		typeof parsed.ownerId !== "string" ||
		!/^[0-9a-f]{64}$/u.test(parsed.ownerId) ||
		!isCanonicalNativeId(parsed.directoryDev) ||
		!isCanonicalNativeId(parsed.directoryIno)
	)
		throw new Error("task_artifact_owner_manifest_invalid");
	return {
		schemaVersion: OWNER_SCHEMA_VERSION,
		sessionId: parsed.sessionId,
		ownerId: parsed.ownerId,
		directoryDev: parsed.directoryDev,
		directoryIno: parsed.directoryIno,
	};
}

function readOwnerManifest(
	store: ManagedSessionDescendantStore,
	locator: TaskArtifactOwnerLocator,
	relativePath = manifestRelativePath(locator.ownerId),
): OwnerManifest {
	const manifest = store.readExpected(relativePath);
	if (!manifest) throw new Error("task_artifact_owner_manifest_missing");
	const parsed = parseOwnerManifest(manifest.bytes);
	if (
		parsed.ownerId !== locator.ownerId ||
		parsed.directoryDev !== locator.directoryDev ||
		parsed.directoryIno !== locator.directoryIno
	)
		throw new Error("task_artifact_owner_manifest_mismatch");
	return parsed;
}

function assertOwnerDirectoryExists(context: TaskArtifactOwnerStorageContext, ownerId: string): void {
	const parent = path.join(context.sessionsRoot, OWNER_DIRECTORY);
	const owner = path.join(parent, ownerId);
	for (const candidate of [parent, owner]) {
		let stat: fs.BigIntStats;
		try {
			stat = fs.lstatSync(candidate, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("task_artifact_owner_missing");
			throw error;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("task_artifact_owner_replaced");
	}
}

function assertOwnerIdentity(store: ManagedSessionDescendantStore, locator: TaskArtifactOwnerLocator): void {
	const identity = store.subtreeRootAuthority;
	if (identity.dev.toString() !== locator.directoryDev || identity.ino.toString() !== locator.directoryIno)
		throw new Error("task_artifact_owner_identity_mismatch");
}

function openOwnerStore(
	context: TaskArtifactOwnerStorageContext,
	rootStore: ManagedSessionDescendantStore,
	locator: TaskArtifactOwnerLocator,
	sessionId: string,
): ManagedSessionDescendantStore {
	if (locator.ownerId !== ownerIdForSession(sessionId)) throw new Error("task_artifact_owner_session_mismatch");
	assertOwnerDirectoryExists(context, locator.ownerId);
	const manifest = readOwnerManifest(rootStore, locator);
	if (manifest.sessionId !== sessionId) throw new Error("task_artifact_owner_session_mismatch");
	const identity = rootStore.captureDirectoryIdentity(ownerRelativePath(locator.ownerId));
	if (identity.dev !== locator.directoryDev || identity.ino !== locator.directoryIno)
		throw new Error("task_artifact_owner_identity_mismatch");
	const ownerStore = new ManagedSessionDescendantStore(
		context.rootAuthority,
		path.join(context.sessionsRoot, ownerRelativePath(locator.ownerId)),
		undefined,
		context.securityPolicy,
		context.profileAgentDir,
	);
	assertOwnerIdentity(ownerStore, locator);
	readOwnerManifest(ownerStore, locator, OWNER_MANIFEST);
	return ownerStore;
}

function locatorFromManifest(manifest: OwnerManifest): TaskArtifactOwnerLocator {
	return {
		schemaVersion: OWNER_SCHEMA_VERSION,
		ownerId: manifest.ownerId,
		directoryDev: manifest.directoryDev,
		directoryIno: manifest.directoryIno,
	};
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
		entries.push(rawEntry as unknown as NativeDirectoryTreeEntry);
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

function freezeTreeSnapshot(snapshot: NativeDirectoryTreeSnapshot): NativeDirectoryTreeSnapshot {
	for (const entry of snapshot.entries) Object.freeze(entry);
	Object.freeze(snapshot.entries);
	return Object.freeze(snapshot);
}

function retainedTreeDoesNotExpandAuthority(
	expected: NativeDirectoryTreeSnapshot,
	retained: NativeDirectoryTreeSnapshot,
): boolean {
	if (expected.rootDev !== retained.rootDev || expected.rootIno !== retained.rootIno) return false;
	const expectedEntries = new Map(expected.entries.map(entry => [entry.relativePath, entry]));
	if (retained.entries.length > expected.entries.length) return false;
	return retained.entries.every(entry => {
		if (entry.relativePath === "") return entry.kind === "directory";
		const authorized = expectedEntries.get(entry.relativePath);
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
}

function sameTreeContents(left: NativeDirectoryTreeSnapshot, right: NativeDirectoryTreeSnapshot): boolean {
	const project = (snapshot: NativeDirectoryTreeSnapshot) =>
		snapshot.entries.map(entry =>
			entry.kind === "directory"
				? { relativePath: entry.relativePath, kind: entry.kind }
				: { relativePath: entry.relativePath, kind: entry.kind, size: entry.size, sha256: entry.sha256 },
		);
	return JSON.stringify(project(left)) === JSON.stringify(project(right));
}

async function copyLegacyArtifactTree(
	store: ManagedSessionDescendantStore,
	sourceRelativePath: string,
	destinationRelativePath: string,
): Promise<void> {
	assertSafeRelativePath(sourceRelativePath);
	const source = store.captureTree(sourceRelativePath);
	for (const entry of source.entries) {
		if (entry.relativePath === "") continue;
		const destination = path.posix.join(destinationRelativePath, entry.relativePath);
		if (entry.kind === "directory") {
			store.ensureDirectory(destination);
			continue;
		}
		const sourceName = path.posix.join(sourceRelativePath, entry.relativePath);
		const captured = store.readExpected(sourceName);
		if (
			!captured ||
			captured.identity.dev.toString() !== entry.dev ||
			captured.identity.ino.toString() !== entry.ino ||
			String(captured.identity.size) !== entry.size ||
			captured.identity.mtimeNs.toString() !== entry.mtimeNs ||
			captured.identity.ctimeNs.toString() !== entry.ctimeNs ||
			crypto.createHash("sha256").update(captured.bytes).digest("hex") !== entry.sha256
		)
			throw new Error("task_artifact_owner_source_changed");
		await store.publishNoReplace(destination, captured.bytes);
	}
	const sourceAfter = store.captureTree(sourceRelativePath);
	const destinationAfter = store.captureTree(destinationRelativePath);
	if (JSON.stringify(sourceAfter) !== JSON.stringify(source) || !sameTreeContents(source, destinationAfter))
		throw new Error("task_artifact_owner_copy_mismatch");
}

function makeOwnerManager(ownerStore: ManagedSessionDescendantStore): ArtifactManager {
	return new ArtifactManager(ownerStore);
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
	return {
		schemaVersion: OWNER_SCHEMA_VERSION,
		ownerId: value.ownerId,
		directoryDev: value.directoryDev,
		directoryIno: value.directoryIno,
	};
}

/** Reopen a locator only beneath the already-validated managed sessions root. */
export function restoreManagedTaskArtifactOwner(
	context: TaskArtifactOwnerStorageContext,
	sessionId: string,
	locatorValue: unknown,
): ManagedTaskArtifactOwner {
	const locator = parseTaskArtifactOwnerLocator(locatorValue);
	if (!locator) throw new Error("task_artifact_owner_locator_missing");
	const rootStore = newSessionRootStore(context);
	try {
		const ownerStore = openOwnerStore(context, rootStore, locator, sessionId);
		return { locator, manager: makeOwnerManager(ownerStore) };
	} finally {
		rootStore.close();
	}
}

/** Establish or restore the logical-session owner under the captured managed sessions authority. */
export async function ensureManagedTaskArtifactOwner(
	context: TaskArtifactOwnerStorageContext,
	sessionId: string,
	locatorValue: unknown,
	legacyArtifactRelativePath?: string,
): Promise<ManagedTaskArtifactOwner> {
	const locator = parseTaskArtifactOwnerLocator(locatorValue);
	const ownerId = locator?.ownerId ?? ownerIdForSession(sessionId);
	if (ownerId !== ownerIdForSession(sessionId)) throw new Error("task_artifact_owner_session_mismatch");
	const lock = await acquireManagedLock(
		path.join(context.sessionsRoot, OWNER_LOCK_DIRECTORY),
		`owner-${ownerId}`,
		context.rootAuthority,
		context.securityPolicy,
	);
	try {
		lock.assertOwned();
		if (locator) return restoreManagedTaskArtifactOwner(context, sessionId, locator);

		const rootStore = newSessionRootStore(context);
		try {
			const ownerRelativePath = ownerRelativePathForId(ownerId);
			let existingDirectory = false;
			try {
				const stat = fs.lstatSync(path.join(context.sessionsRoot, ownerRelativePath), { bigint: true });
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("task_artifact_owner_replaced");
				existingDirectory = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (existingDirectory) {
				const manifestFile = rootStore.readExpected(manifestRelativePath(ownerId));
				if (!manifestFile) throw new Error("task_artifact_owner_manifest_missing");
				const manifest = parseOwnerManifest(manifestFile.bytes);
				if (manifest.sessionId !== sessionId || manifest.ownerId !== ownerId)
					throw new Error("task_artifact_owner_session_mismatch");
				const restoredLocator = locatorFromManifest(manifest);
				const ownerStore = openOwnerStore(context, rootStore, restoredLocator, sessionId);
				return { locator: restoredLocator, manager: makeOwnerManager(ownerStore) };
			}

			rootStore.ensureDirectory(OWNER_DIRECTORY);
			const identity = rootStore.ensureDirectory(ownerRelativePath);
			const createdLocator: TaskArtifactOwnerLocator = {
				schemaVersion: OWNER_SCHEMA_VERSION,
				ownerId,
				directoryDev: identity.dev.toString(),
				directoryIno: identity.ino.toString(),
			};
			if (legacyArtifactRelativePath) {
				assertSafeRelativePath(legacyArtifactRelativePath);
				if (legacyArtifactRelativePath !== ownerRelativePath) {
					let sourceExists = true;
					try {
						fs.lstatSync(path.join(context.sessionsRoot, legacyArtifactRelativePath), { bigint: true });
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						sourceExists = false;
					}
					if (sourceExists) await copyLegacyArtifactTree(rootStore, legacyArtifactRelativePath, ownerRelativePath);
				}
			}
			lock.assertOwned();
			await rootStore.publishNoReplace(
				manifestRelativePath(ownerId),
				Buffer.from(`${JSON.stringify({ ...createdLocator, sessionId })}\n`, "utf8"),
			);
			const ownerStore = openOwnerStore(context, rootStore, createdLocator, sessionId);
			ownerStore.fsyncTree();
			return { locator: createdLocator, manager: makeOwnerManager(ownerStore) };
		} finally {
			rootStore.close();
		}
	} finally {
		await lock.release();
	}
}

function ownerRelativePathForId(ownerId: string): string {
	return ownerRelativePath(ownerId);
}

function captureValidatedOwnerTree(
	context: TaskArtifactOwnerStorageContext,
	rootStore: ManagedSessionDescendantStore,
	sessionId: string,
	locator: TaskArtifactOwnerLocator,
): NativeDirectoryTreeSnapshot {
	if (locator.ownerId !== ownerIdForSession(sessionId)) throw new Error("task_artifact_owner_session_mismatch");
	assertOwnerDirectoryExists(context, locator.ownerId);
	const manifest = readOwnerManifest(rootStore, locator);
	if (manifest.sessionId !== sessionId) throw new Error("task_artifact_owner_session_mismatch");
	const tree = rootStore.captureTree(ownerRelativePath(locator.ownerId));
	if (tree.rootDev !== locator.directoryDev || tree.rootIno !== locator.directoryIno)
		throw new Error("task_artifact_owner_identity_mismatch");
	return tree;
}

function ownerAbsolutePath(context: TaskArtifactOwnerStorageContext, ownerId: string): string {
	return path.join(context.sessionsRoot, ownerRelativePath(ownerId));
}

function isOwnerRetainedRoot(context: TaskArtifactOwnerStorageContext, ownerId: string, pathname: string): boolean {
	const owner = ownerAbsolutePath(context, ownerId);
	return pathname === owner || pathname === `${owner}.removing`;
}

function isKnownNativeSidePath(context: TaskArtifactOwnerStorageContext, ownerId: string, pathname: string): boolean {
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

function sameOwnerParentIdentity(
	left: TaskArtifactOwnerParentIdentity,
	right: TaskArtifactOwnerParentIdentity,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function immutableDeletionEvidence(
	sessionId: string,
	locator: TaskArtifactOwnerLocator,
	parentIdentity: TaskArtifactOwnerParentIdentity,
	treeSnapshot: NativeDirectoryTreeSnapshot,
): TaskArtifactOwnerDeletionEvidence {
	return Object.freeze({
		schemaVersion: OWNER_DELETION_SCHEMA_VERSION,
		sessionId,
		locator: Object.freeze({ ...locator }),
		parentIdentity: Object.freeze({ ...parentIdentity }),
		treeSnapshot: freezeTreeSnapshot(treeSnapshot),
	});
}

function mergeUniqueStrings(
	previous: readonly string[] | undefined,
	next: string | undefined,
	maximum: number,
): string[] | undefined {
	const values = new Set(previous ?? []);
	if (next !== undefined) values.add(next);
	if (values.size > maximum) throw new Error("task_artifact_owner_native_diagnostic_limit_exceeded");
	return values.size > 0 ? [...values] : undefined;
}

function retainedSidePaths(
	context: TaskArtifactOwnerStorageContext,
	evidence: TaskArtifactOwnerDeletionEvidence,
	previous: readonly string[] | undefined,
	next: string | undefined,
): string[] | undefined {
	const values = mergeUniqueStrings(previous, next, 256) ?? [];
	const ownerParent = path.dirname(ownerAbsolutePath(context, evidence.locator.ownerId));
	const retained: string[] = [];
	for (const pathname of values) {
		if (!isKnownNativeSidePath(context, evidence.locator.ownerId, pathname))
			throw new Error("task_artifact_owner_native_side_path_unrecognized");
		if (path.dirname(pathname) !== ownerParent) {
			retained.push(pathname);
			continue;
		}
		try {
			fs.lstatSync(pathname, { bigint: true });
			retained.push(pathname);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") retained.push(pathname);
		}
	}
	return retained.length > 0 ? retained : undefined;
}

function continuationRecord(
	context: TaskArtifactOwnerStorageContext,
	evidence: TaskArtifactOwnerDeletionEvidence,
	retainedRootPath: string,
	retainedTreeSnapshot: NativeDirectoryTreeSnapshot,
	previous?: TaskArtifactOwnerRetirementContinuation,
	result?: NativeExactUnlinkResult,
): TaskArtifactOwnerRetirementContinuation {
	const detachedPaths = mergeUniqueStrings(previous?.detachedPaths, result?.detachedPath, 2);
	if (detachedPaths?.some(pathname => !isOwnerRetainedRoot(context, evidence.locator.ownerId, pathname)))
		throw new Error("task_artifact_owner_native_retained_root_unrecognized");
	const nativeCodes = mergeUniqueStrings(previous?.nativeCodes, result?.code, 64);
	if (nativeCodes?.some(code => !/^[A-Za-z0-9_.:-]{1,128}$/u.test(code)))
		throw new Error("task_artifact_owner_native_code_unrecognized");
	const retainedSuccessorPaths = retainedSidePaths(
		context,
		evidence,
		previous?.retainedSuccessorPaths,
		result?.retainedSuccessorPath,
	);
	const retainedPlaceholderPaths = retainedSidePaths(
		context,
		evidence,
		previous?.retainedPlaceholderPaths,
		result?.retainedPlaceholderPath,
	);
	const retainedUnknownPaths = retainedSidePaths(
		context,
		evidence,
		previous?.retainedUnknownPaths,
		result?.retainedUnknownPath,
	);
	const windowsErrorCodes = mergeUniqueStrings(previous?.windowsErrorCodes, result?.windowsErrorCode, 64);
	if (windowsErrorCodes?.some(code => !/^0x[0-9A-Fa-f]{8}$/u.test(code)))
		throw new Error("task_artifact_owner_native_windows_code_unrecognized");
	const payloadDurable =
		previous?.payloadDurable === true || result?.payloadDurable === true
			? true
			: (result?.payloadDurable ?? previous?.payloadDurable);
	return parseTaskArtifactOwnerRetirementContinuation(context, evidence, {
		schemaVersion: OWNER_RETIREMENT_SCHEMA_VERSION,
		parentIdentity: evidence.parentIdentity,
		retainedRootPath,
		retainedTreeSnapshot,
		...(detachedPaths !== undefined ? { detachedPaths } : {}),
		...(nativeCodes !== undefined ? { nativeCodes } : {}),
		...(payloadDurable !== undefined ? { payloadDurable } : {}),
		...(retainedSuccessorPaths !== undefined ? { retainedSuccessorPaths } : {}),
		...(retainedPlaceholderPaths !== undefined ? { retainedPlaceholderPaths } : {}),
		...(retainedUnknownPaths !== undefined ? { retainedUnknownPaths } : {}),
		...(windowsErrorCodes !== undefined ? { windowsErrorCodes } : {}),
	});
}

function defaultContinuation(
	context: TaskArtifactOwnerStorageContext,
	evidence: TaskArtifactOwnerDeletionEvidence,
	previous?: TaskArtifactOwnerRetirementContinuation,
): TaskArtifactOwnerRetirementContinuation {
	return (
		previous ??
		continuationRecord(
			context,
			evidence,
			`${ownerAbsolutePath(context, evidence.locator.ownerId)}.removing`,
			evidence.treeSnapshot,
		)
	);
}

function captureOwnerTreeIfPresent(
	context: TaskArtifactOwnerStorageContext,
	rootStore: ManagedSessionDescendantStore,
	ownerId: string,
	pathname: string,
): NativeDirectoryTreeSnapshot | undefined {
	if (!isOwnerRetainedRoot(context, ownerId, pathname)) {
		// The caller supplies only the two deterministic owner-root candidates.
		throw new Error("task_artifact_owner_retained_root_unrecognized");
	}
	let named: fs.BigIntStats;
	try {
		named = fs.lstatSync(pathname, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!named.isDirectory() || named.isSymbolicLink()) throw new Error("task_artifact_owner_retained_root_replaced");
	const relative = path.relative(context.sessionsRoot, pathname).split(path.sep).join("/");
	assertSafeRelativePath(relative);
	return freezeTreeSnapshot(parseTreeSnapshot(rootStore.captureTree(relative)));
}

/** Capture exact, validated owner-tree evidence without repairing its security or timestamps. */
export function captureTaskArtifactOwnerDeletionEvidence(
	context: TaskArtifactOwnerStorageContext,
	sessionId: string,
	locatorValue: unknown,
): TaskArtifactOwnerDeletionEvidence | undefined {
	const locator = parseTaskArtifactOwnerLocator(locatorValue);
	if (!locator) return undefined;
	const rootStore = newSessionRootStore(context);
	try {
		rootStore.verifyRootSecurity();
		const parentIdentity = rootStore.captureDirectoryIdentity(OWNER_DIRECTORY);
		const treeSnapshot = captureValidatedOwnerTree(context, rootStore, sessionId, locator);
		const parentAfter = rootStore.captureDirectoryIdentity(OWNER_DIRECTORY);
		if (!sameOwnerParentIdentity(parentIdentity, parentAfter))
			throw new Error("task_artifact_owner_parent_changed_during_capture");
		return immutableDeletionEvidence(sessionId, locator, parentIdentity, treeSnapshot);
	} finally {
		rootStore.close();
	}
}

/** Validate JSON-restored tombstone evidence before it is used for exact retirement. */
export function parseTaskArtifactOwnerDeletionEvidence(value: unknown): TaskArtifactOwnerDeletionEvidence {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 5 ||
		value.schemaVersion !== OWNER_DELETION_SCHEMA_VERSION ||
		typeof value.sessionId !== "string" ||
		value.sessionId.length === 0
	)
		throw new Error("task_artifact_owner_evidence_invalid");
	const locator = parseTaskArtifactOwnerLocator(value.locator);
	if (!locator || locator.ownerId !== ownerIdForSession(value.sessionId))
		throw new Error("task_artifact_owner_evidence_invalid");
	const parentIdentity = parseParentIdentity(value.parentIdentity);
	const treeSnapshot = parseTreeSnapshot(value.treeSnapshot);
	if (treeSnapshot.rootDev !== locator.directoryDev || treeSnapshot.rootIno !== locator.directoryIno)
		throw new Error("task_artifact_owner_evidence_invalid");
	return immutableDeletionEvidence(value.sessionId, locator, parentIdentity, treeSnapshot);
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

function nativeResultSidePathsRemain(
	context: TaskArtifactOwnerStorageContext,
	rootStore: ManagedSessionDescendantStore,
	evidence: TaskArtifactOwnerDeletionEvidence,
	continuation: TaskArtifactOwnerRetirementContinuation,
): boolean {
	const ownerParent = path.dirname(ownerAbsolutePath(context, evidence.locator.ownerId));
	try {
		if (!sameOwnerParentIdentity(rootStore.captureDirectoryIdentity(OWNER_DIRECTORY), evidence.parentIdentity))
			return true;
	} catch {
		return true;
	}
	let remains = false;
	for (const pathname of [
		...(continuation.retainedSuccessorPaths ?? []),
		...(continuation.retainedPlaceholderPaths ?? []),
		...(continuation.retainedUnknownPaths ?? []),
	]) {
		if (path.dirname(pathname) !== ownerParent) {
			remains = true;
			continue;
		}
		try {
			fs.lstatSync(pathname, { bigint: true });
			remains = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") remains = true;
		}
	}
	try {
		return (
			remains ||
			!sameOwnerParentIdentity(rootStore.captureDirectoryIdentity(OWNER_DIRECTORY), evidence.parentIdentity)
		);
	} catch {
		return true;
	}
}

/** Confirm physical completion from a managed native proof, never from canonical absence alone. */
export function verifyTaskArtifactOwnerPhysicalRetirement(
	context: TaskArtifactOwnerStorageContext,
	evidence: TaskArtifactOwnerDeletionEvidence,
	value: unknown,
): void {
	const outcome = parseTaskArtifactOwnerRetirementOutcome(context, evidence, value);
	if (outcome.kind !== "completed") throw new Error("task_artifact_owner_physical_retirement_unverified");
	const store = newSessionRootStore(context);
	try {
		if (!sameOwnerParentIdentity(store.captureDirectoryIdentity(OWNER_DIRECTORY), evidence.parentIdentity))
			throw new Error("task_artifact_owner_parent_identity_mismatch");
		const canonical = ownerAbsolutePath(context, evidence.locator.ownerId);
		if (
			captureOwnerTreeIfPresent(context, store, evidence.locator.ownerId, canonical) ||
			captureOwnerTreeIfPresent(context, store, evidence.locator.ownerId, `${canonical}.removing`)
		)
			throw new Error("task_artifact_owner_physical_retirement_unverified");
	} finally {
		store.close();
	}
}

/** Strictly decode managed-journal data; parsing does not establish current retirement or writer quiescence. */
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
	if (JSON.stringify(original) !== JSON.stringify(evidence)) return invalid();
	const continuation =
		kind !== "completed"
			? parseTaskArtifactOwnerRetirementContinuation(context, evidence, value.continuation)
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
		nativeOutcome = {
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
		};
	}
	if (kind === "completed") {
		if (!nativeOutcome?.ok) return invalid();
		return Object.freeze({ kind, evidence: original, nativeOutcome });
	}
	if (!continuation || nativeOutcome?.ok) return invalid();
	if (kind === "payload_retired") {
		if (
			value.namespace !== "retained" ||
			nativeOutcome?.code !== "cleanup_pending" ||
			nativeOutcome.payloadDurable !== true ||
			continuation.retainedRootPath !== `${ownerAbsolutePath(context, evidence.locator.ownerId)}.removing` ||
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

/** Revalidate a persisted remnant through managed authority without mutation or new payload proof. */
export function verifyTaskArtifactOwnerRetirementContinuation(
	context: TaskArtifactOwnerStorageContext,
	evidenceValue: TaskArtifactOwnerDeletionEvidence,
	value: unknown,
): TaskArtifactOwnerRetirementContinuation {
	const evidence = parseTaskArtifactOwnerDeletionEvidence(evidenceValue);
	const continuation = parseTaskArtifactOwnerRetirementContinuation(context, evidence, value);
	const store = newSessionRootStore(context);
	try {
		if (!sameOwnerParentIdentity(store.captureDirectoryIdentity(OWNER_DIRECTORY), evidence.parentIdentity))
			throw new Error("task_artifact_owner_parent_identity_mismatch");
		const snapshot = captureOwnerTreeIfPresent(
			context,
			store,
			evidence.locator.ownerId,
			continuation.retainedRootPath,
		);
		if (!snapshot || !retainedTreeDoesNotExpandAuthority(continuation.retainedTreeSnapshot, snapshot))
			throw new Error("task_artifact_owner_retained_tree_mismatch");
		if (
			continuation.payloadDurable === true &&
			snapshot.entries.some(
				entry => entry.kind === "file" && (entry.size !== "0" || entry.sha256 !== EMPTY_PAYLOAD_SHA256),
			)
		)
			throw new Error("task_artifact_owner_retired_payload_changed");
		return continuation;
	} finally {
		store.close();
	}
}

/** Continue exact native removal without widening the original owner-tree authority. */
export function retireTaskArtifactOwner(
	context: TaskArtifactOwnerStorageContext,
	evidenceValue: TaskArtifactOwnerDeletionEvidence,
	continuationValue?: unknown,
): TaskArtifactOwnerRetirementOutcome {
	const evidence = parseTaskArtifactOwnerDeletionEvidence(evidenceValue);
	const previous =
		continuationValue === undefined
			? undefined
			: parseTaskArtifactOwnerRetirementContinuation(context, evidence, continuationValue);
	const fallback = defaultContinuation(context, evidence, previous);
	const rootStore = newSessionRootStore(context);
	try {
		try {
			rootStore.verifyRootSecurity();
		} catch {
			return {
				kind: "uncertain",
				evidence,
				continuation: fallback,
				reason: "task_artifact_owner_namespace_unverified",
			};
		}
		let currentParent: TaskArtifactOwnerParentIdentity;
		try {
			currentParent = rootStore.captureDirectoryIdentity(OWNER_DIRECTORY);
		} catch {
			return {
				kind: "uncertain",
				evidence,
				continuation: fallback,
				reason: "task_artifact_owner_parent_unavailable",
			};
		}
		if (!sameOwnerParentIdentity(currentParent, evidence.parentIdentity))
			return {
				kind: "uncertain",
				evidence,
				continuation: fallback,
				reason: "task_artifact_owner_parent_identity_changed",
			};

		const ownerPath = ownerAbsolutePath(context, evidence.locator.ownerId);
		const removingPath = `${ownerPath}.removing`;
		const baseline = previous?.retainedTreeSnapshot ?? evidence.treeSnapshot;
		const candidates = [
			...new Set(
				[previous?.retainedRootPath, removingPath, ownerPath].filter(
					(pathname): pathname is string => pathname !== undefined,
				),
			),
		];
		let retainedRootPath: string | undefined;
		let retainedTreeSnapshot: NativeDirectoryTreeSnapshot | undefined;
		for (const candidate of candidates) {
			let snapshot: NativeDirectoryTreeSnapshot | undefined;
			try {
				snapshot = captureOwnerTreeIfPresent(context, rootStore, evidence.locator.ownerId, candidate);
			} catch {
				return {
					kind: "uncertain",
					evidence,
					continuation: fallback,
					reason: "task_artifact_owner_retained_tree_unavailable",
				};
			}
			if (
				!snapshot ||
				snapshot.rootDev !== evidence.locator.directoryDev ||
				snapshot.rootIno !== evidence.locator.directoryIno ||
				!retainedTreeDoesNotExpandAuthority(baseline, snapshot)
			)
				continue;
			if (candidate === ownerPath && JSON.stringify(snapshot) === JSON.stringify(evidence.treeSnapshot)) {
				try {
					const validated = captureValidatedOwnerTree(context, rootStore, evidence.sessionId, evidence.locator);
					if (JSON.stringify(validated) !== JSON.stringify(evidence.treeSnapshot))
						return {
							kind: "uncertain",
							evidence,
							continuation: fallback,
							reason: "task_artifact_owner_changed_since_capture",
						};
				} catch {
					return {
						kind: "uncertain",
						evidence,
						continuation: fallback,
						reason: "task_artifact_owner_identity_unverified",
					};
				}
			}
			retainedRootPath = candidate;
			retainedTreeSnapshot = snapshot;
			break;
		}
		if (!retainedRootPath || !retainedTreeSnapshot)
			return {
				kind: "uncertain",
				evidence,
				continuation: fallback,
				reason: "task_artifact_owner_retained_root_not_found_or_unverified",
			};

		let nativeOutcome: NativeExactUnlinkResult;
		try {
			nativeOutcome = rootStore.removeTreeExpectedWithParentIdentity(
				path.relative(context.sessionsRoot, retainedRootPath).split(path.sep).join("/"),
				retainedTreeSnapshot,
				{ dev: BigInt(evidence.parentIdentity.dev), ino: BigInt(evidence.parentIdentity.ino) },
			);
		} catch {
			return {
				kind: "uncertain",
				evidence,
				continuation: fallback,
				reason: "task_artifact_owner_native_removal_uncertain",
			};
		}
		let parentStillBound = false;
		try {
			parentStillBound = sameOwnerParentIdentity(
				rootStore.captureDirectoryIdentity(OWNER_DIRECTORY),
				evidence.parentIdentity,
			);
		} catch {
			parentStillBound = false;
		}
		if (!parentStillBound)
			return {
				kind: "uncertain",
				evidence,
				continuation: fallback,
				reason: "task_artifact_owner_parent_identity_changed_after_removal",
				nativeOutcome,
			};
		const reportedRoot = nativeOutcome.detachedPath;
		const reportedRootKnown =
			reportedRoot === undefined || isOwnerRetainedRoot(context, evidence.locator.ownerId, reportedRoot);
		const nextRoot = reportedRootKnown && reportedRoot !== undefined ? reportedRoot : retainedRootPath;
		let residualTree: NativeDirectoryTreeSnapshot | undefined;
		let residualValid = reportedRootKnown;
		try {
			residualTree = captureOwnerTreeIfPresent(context, rootStore, evidence.locator.ownerId, nextRoot);
			if (
				residualTree &&
				(residualTree.rootDev !== evidence.locator.directoryDev ||
					residualTree.rootIno !== evidence.locator.directoryIno ||
					!retainedTreeDoesNotExpandAuthority(retainedTreeSnapshot, residualTree))
			)
				residualValid = false;
		} catch {
			residualValid = false;
		}
		const nextTree = residualValid && residualTree ? residualTree : retainedTreeSnapshot;
		let nextContinuation: TaskArtifactOwnerRetirementContinuation;
		try {
			nextContinuation = continuationRecord(context, evidence, nextRoot, nextTree, previous, nativeOutcome);
		} catch {
			return {
				kind: "uncertain",
				evidence,
				continuation: continuationRecord(context, evidence, retainedRootPath, retainedTreeSnapshot, previous),
				reason: "task_artifact_owner_native_retained_state_unrecognized",
				nativeOutcome,
			};
		}
		if (!residualValid)
			return {
				kind: "uncertain",
				evidence,
				continuation: nextContinuation,
				reason: "task_artifact_owner_native_retained_state_unverified",
				nativeOutcome,
			};

		let ownerRootRemains = false;
		for (const candidate of [ownerPath, removingPath]) {
			let snapshot: NativeDirectoryTreeSnapshot | undefined;
			try {
				snapshot = captureOwnerTreeIfPresent(context, rootStore, evidence.locator.ownerId, candidate);
			} catch {
				ownerRootRemains = true;
				break;
			}
			if (snapshot) {
				ownerRootRemains = true;
				break;
			}
		}
		const sidePathsRemain = nativeResultSidePathsRemain(context, rootStore, evidence, nextContinuation);
		if (nativeOutcome.ok && !ownerRootRemains && !sidePathsRemain)
			return { kind: "completed", evidence, nativeOutcome };
		if (
			!nativeOutcome.ok &&
			nativeOutcome.code === "cleanup_pending" &&
			nativeOutcome.payloadDurable === true &&
			residualTree &&
			nextRoot === removingPath &&
			!sidePathsRemain &&
			residualTree.entries.every(
				entry => entry.kind === "directory" || (entry.size === "0" && entry.sha256 === EMPTY_PAYLOAD_SHA256),
			)
		)
			return {
				kind: "payload_retired",
				namespace: "retained",
				evidence,
				continuation: nextContinuation,
				nativeOutcome,
			};
		if (!nativeOutcome.ok && nativeOutcome.code === "cleanup_pending")
			return { kind: "cleanup_pending", evidence, continuation: nextContinuation, nativeOutcome };
		return {
			kind: "uncertain",
			evidence,
			continuation: nextContinuation,
			reason: nativeOutcome.ok
				? "task_artifact_owner_native_success_retained_authority"
				: `task_artifact_owner_native_removal_${nativeOutcome.code ?? "uncertain"}`,
			nativeOutcome,
		};
	} finally {
		rootStore.close();
	}
}
