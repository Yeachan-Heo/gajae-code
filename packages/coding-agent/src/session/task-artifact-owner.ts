import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NativeDirectoryTreeEntry, NativeDirectoryTreeSnapshot } from "@gajae-code/natives";
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

/** Exact deletion input retained by managed lifecycle tombstones and retries. */
export interface TaskArtifactOwnerDeletionEvidence {
	readonly schemaVersion: typeof OWNER_SCHEMA_VERSION;
	readonly sessionId: string;
	readonly locator: TaskArtifactOwnerLocator;
	readonly treeSnapshot: NativeDirectoryTreeSnapshot;
}

interface OwnerManifest extends TaskArtifactOwnerLocator {
	sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalDecimal(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value);
}

function ownerIdForSession(sessionId: string): string {
	if (sessionId.length === 0 || sessionId.length > 512) throw new Error("task_artifact_owner_session_id_invalid");
	return createHash("sha256").update(sessionId, "utf8").digest("hex");
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
		!isCanonicalDecimal(parsed.directoryDev) ||
		!isCanonicalDecimal(parsed.directoryIno)
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
	if (!isRecord(value) || !isCanonicalDecimal(value.rootDev) || !isCanonicalDecimal(value.rootIno))
		throw new Error("task_artifact_owner_evidence_invalid");
	if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 50_000)
		throw new Error("task_artifact_owner_evidence_invalid");
	const entries: NativeDirectoryTreeEntry[] = [];
	for (const rawEntry of value.entries) {
		if (
			!isRecord(rawEntry) ||
			typeof rawEntry.relativePath !== "string" ||
			(rawEntry.kind !== "directory" && rawEntry.kind !== "file") ||
			!isCanonicalDecimal(rawEntry.dev) ||
			!isCanonicalDecimal(rawEntry.ino) ||
			!isCanonicalDecimal(rawEntry.nlink) ||
			!isCanonicalDecimal(rawEntry.size) ||
			!isCanonicalDecimal(rawEntry.mtimeNs) ||
			!isCanonicalDecimal(rawEntry.ctimeNs) ||
			(rawEntry.sha256 !== undefined &&
				(typeof rawEntry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(rawEntry.sha256)))
		)
			throw new Error("task_artifact_owner_evidence_invalid");
		if (
			rawEntry.relativePath.includes("\\") ||
			(rawEntry.relativePath !== "" &&
				(rawEntry.relativePath.startsWith("/") ||
					rawEntry.relativePath.split("/").some(part => part.length === 0 || part === "." || part === "..")))
		)
			throw new Error("task_artifact_owner_evidence_invalid");
		entries.push(rawEntry as unknown as NativeDirectoryTreeEntry);
	}
	const root = entries.find(entry => entry.relativePath === "");
	if (root?.kind !== "directory" || root.dev !== value.rootDev || root.ino !== value.rootIno)
		throw new Error("task_artifact_owner_evidence_invalid");
	return { rootDev: value.rootDev, rootIno: value.rootIno, entries };
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
			createHash("sha256").update(captured.bytes).digest("hex") !== entry.sha256
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
		!isCanonicalDecimal(value.directoryDev) ||
		!isCanonicalDecimal(value.directoryIno)
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
		const treeSnapshot = captureValidatedOwnerTree(context, rootStore, sessionId, locator);
		return { schemaVersion: OWNER_SCHEMA_VERSION, sessionId, locator, treeSnapshot };
	} finally {
		rootStore.close();
	}
}

/** Validate JSON-restored tombstone evidence before it is used for exact retirement. */
export function parseTaskArtifactOwnerDeletionEvidence(value: unknown): TaskArtifactOwnerDeletionEvidence {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 4 ||
		value.schemaVersion !== OWNER_SCHEMA_VERSION ||
		typeof value.sessionId !== "string" ||
		value.sessionId.length === 0
	)
		throw new Error("task_artifact_owner_evidence_invalid");
	const locator = parseTaskArtifactOwnerLocator(value.locator);
	if (!locator || locator.ownerId !== ownerIdForSession(value.sessionId))
		throw new Error("task_artifact_owner_evidence_invalid");
	const treeSnapshot = parseTreeSnapshot(value.treeSnapshot);
	if (treeSnapshot.rootDev !== locator.directoryDev || treeSnapshot.rootIno !== locator.directoryIno)
		throw new Error("task_artifact_owner_evidence_invalid");
	return { schemaVersion: OWNER_SCHEMA_VERSION, sessionId: value.sessionId, locator, treeSnapshot };
}

/** Retire only the exact owner tree captured by a validated lifecycle deletion plan. */
export function retireTaskArtifactOwner(
	context: TaskArtifactOwnerStorageContext,
	evidenceValue: TaskArtifactOwnerDeletionEvidence,
): void {
	const evidence = parseTaskArtifactOwnerDeletionEvidence(evidenceValue);
	const rootStore = newSessionRootStore(context);
	try {
		const current = captureValidatedOwnerTree(context, rootStore, evidence.sessionId, evidence.locator);
		if (JSON.stringify(current) !== JSON.stringify(evidence.treeSnapshot))
			throw new Error("task_artifact_owner_changed_since_capture");
		rootStore.removeTreeExpected(ownerRelativePath(evidence.locator.ownerId), evidence.treeSnapshot);
	} finally {
		rootStore.close();
	}
}
