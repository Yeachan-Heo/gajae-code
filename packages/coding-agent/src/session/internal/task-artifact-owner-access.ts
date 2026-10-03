import * as fs from "node:fs";
import * as path from "node:path";
import type { NativeDirectoryTreeSnapshot } from "@gajae-code/natives";
import {
	assertSafeRelativePath,
	assertSessionRoot,
	freezeTreeSnapshot,
	immutableDeletionEvidence,
	isOwnerRetainedRoot,
	manifestRelativePath,
	OWNER_DIRECTORY,
	OWNER_MANIFEST,
	OWNER_SCHEMA_VERSION,
	ownerIdForSession,
	ownerRelativePath,
	parseTaskArtifactOwnerLocator,
	sameOwnerParentIdentity,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerParentIdentity,
	type TaskArtifactOwnerStorageContext,
} from "../task-artifact-owner-codec";
import { ManagedSessionDescendantStore } from "./managed-session-storage";

export interface OwnerManifest extends TaskArtifactOwnerLocator {
	readonly sessionId: string;
}

export function newSessionRootStore(context: TaskArtifactOwnerStorageContext): ManagedSessionDescendantStore {
	assertSessionRoot(context);
	if (path.resolve(context.profileAgentDir) !== context.profileAgentDir)
		throw new Error("task_artifact_owner_profile_invalid");
	const profile = fs.lstatSync(context.profileAgentDir, { bigint: true });
	if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error("task_artifact_owner_profile_invalid");
	const stat = fs.lstatSync(context.sessionsRoot, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("task_artifact_owner_root_invalid");
	return new ManagedSessionDescendantStore(
		context.rootAuthority,
		context.sessionsRoot,
		undefined,
		context.securityPolicy,
		context.profileAgentDir,
		{
			canonicalPath: context.sessionsRoot,
			dev: BigInt.asUintN(64, stat.dev),
			ino: BigInt.asUintN(64, stat.ino),
		},
	);
}

function parseOwnerManifest(bytes: Uint8Array): OwnerManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		throw new Error("task_artifact_owner_manifest_invalid");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 5)
		throw new Error("task_artifact_owner_manifest_invalid");
	const record = parsed as Record<string, unknown>;
	if (typeof record.sessionId !== "string" || record.sessionId.length === 0)
		throw new Error("task_artifact_owner_manifest_invalid");
	let locator: TaskArtifactOwnerLocator | undefined;
	try {
		locator = parseTaskArtifactOwnerLocator({
			schemaVersion: record.schemaVersion,
			ownerId: record.ownerId,
			directoryDev: record.directoryDev,
			directoryIno: record.directoryIno,
		});
	} catch {
		throw new Error("task_artifact_owner_manifest_invalid");
	}
	if (!locator) throw new Error("task_artifact_owner_manifest_invalid");
	return { ...locator, sessionId: record.sessionId };
}

export function readOwnerManifest(
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

export function assertOwnerDirectoryExists(context: TaskArtifactOwnerStorageContext, ownerId: string): void {
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

export function assertOwnerIdentity(store: ManagedSessionDescendantStore, locator: TaskArtifactOwnerLocator): void {
	const identity = store.subtreeRootAuthority;
	if (identity.dev.toString() !== locator.directoryDev || identity.ino.toString() !== locator.directoryIno)
		throw new Error("task_artifact_owner_identity_mismatch");
}

export function openOwnerStore(
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
	const ownerPath = path.join(context.sessionsRoot, ownerRelativePath(locator.ownerId));
	const ownerStore = new ManagedSessionDescendantStore(
		context.rootAuthority,
		ownerPath,
		undefined,
		context.securityPolicy,
		context.profileAgentDir,
		{
			canonicalPath: ownerPath,
			dev: BigInt(locator.directoryDev),
			ino: BigInt(locator.directoryIno),
		},
	);
	try {
		assertOwnerIdentity(ownerStore, locator);
		readOwnerManifest(ownerStore, locator, OWNER_MANIFEST);
		return ownerStore;
	} catch (error) {
		ownerStore.close();
		throw error;
	}
}

export function locatorFromManifest(manifest: OwnerManifest): TaskArtifactOwnerLocator {
	return {
		schemaVersion: OWNER_SCHEMA_VERSION,
		ownerId: manifest.ownerId,
		directoryDev: manifest.directoryDev,
		directoryIno: manifest.directoryIno,
	};
}

export function captureValidatedOwnerTree(
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

export function captureOwnerTreeIfPresent(
	context: TaskArtifactOwnerStorageContext,
	rootStore: ManagedSessionDescendantStore,
	ownerId: string,
	pathname: string,
): NativeDirectoryTreeSnapshot | undefined {
	if (!isOwnerRetainedRoot(context, ownerId, pathname))
		throw new Error("task_artifact_owner_retained_root_unrecognized");
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
	return freezeTreeSnapshot(rootStore.captureTree(relative));
}

export function ownerTreeHasPendingManagedPublication(snapshot: NativeDirectoryTreeSnapshot): boolean {
	return snapshot.entries.some(entry =>
		/^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:staging|replacement)$/u.test(
			path.posix.basename(entry.relativePath),
		),
	);
}

/** Capture exact owner evidence without repairing its security, timestamps, or namespace. */
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
		const parentIdentity: TaskArtifactOwnerParentIdentity = rootStore.captureDirectoryIdentity(OWNER_DIRECTORY);
		const treeSnapshot = captureValidatedOwnerTree(context, rootStore, sessionId, locator);
		// This refuses to capture during publication; it does not revoke independent open descriptors.
		if (ownerTreeHasPendingManagedPublication(treeSnapshot))
			throw new Error("task_artifact_owner_writer_not_quiescent");
		const parentAfter = rootStore.captureDirectoryIdentity(OWNER_DIRECTORY);
		if (!sameOwnerParentIdentity(parentIdentity, parentAfter))
			throw new Error("task_artifact_owner_parent_changed_during_capture");
		return immutableDeletionEvidence(sessionId, locator, parentIdentity, treeSnapshot);
	} finally {
		rootStore.close();
	}
}
