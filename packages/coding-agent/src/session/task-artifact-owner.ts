import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ArtifactManager } from "./artifacts";
import { acquireManagedLock, type ManagedSessionDescendantStore } from "./internal/managed-session-storage";
import {
	locatorFromManifest,
	newSessionRootStore,
	type OwnerManifest,
	openOwnerStore,
	readOwnerManifest,
} from "./internal/task-artifact-owner-access";
import type { NativeDirectoryTreeSnapshot } from "./session-storage";
import {
	assertSafeRelativePath,
	assertSessionRoot,
	OWNER_DIRECTORY,
	OWNER_LOCK_DIRECTORY,
	OWNER_MANIFEST,
	OWNER_SCHEMA_VERSION,
	ownerIdForSession,
	ownerRelativePath,
	parseTaskArtifactOwnerLocator,
	sameTreeContents,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerStorageContext,
} from "./task-artifact-owner-codec";

export interface ManagedTaskArtifactOwner {
	readonly locator: TaskArtifactOwnerLocator;
	readonly manager: ArtifactManager;
}

function makeOwnerManager(ownerStore: ManagedSessionDescendantStore): ArtifactManager {
	return new ArtifactManager(ownerStore);
}

function legacyPathOverlapsOwner(
	sessionsRoot: string,
	sourceRelativePath: string,
	destinationRelativePath: string,
): boolean {
	const source = path.resolve(sessionsRoot, sourceRelativePath);
	const destination = path.resolve(sessionsRoot, destinationRelativePath);
	const sourceToDestination = path.relative(source, destination);
	const destinationToSource = path.relative(destination, source);
	return (
		source !== destination &&
		((!path.isAbsolute(sourceToDestination) &&
			sourceToDestination !== ".." &&
			!sourceToDestination.startsWith(`..${path.sep}`)) ||
			(!path.isAbsolute(destinationToSource) &&
				destinationToSource !== ".." &&
				!destinationToSource.startsWith(`..${path.sep}`)))
	);
}

async function copyLegacyArtifactTree(
	store: ManagedSessionDescendantStore,
	sourceRelativePath: string,
	destinationRelativePath: string,
	sourceSnapshot: NativeDirectoryTreeSnapshot,
): Promise<void> {
	for (const entry of sourceSnapshot.entries) {
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
	if (
		JSON.stringify(sourceAfter) !== JSON.stringify(sourceSnapshot) ||
		!sameTreeContents(sourceSnapshot, destinationAfter)
	)
		throw new Error("task_artifact_owner_copy_mismatch");
}

function taskArtifactOwnerFromStore(
	locator: TaskArtifactOwnerLocator,
	ownerStore: ManagedSessionDescendantStore,
): ManagedTaskArtifactOwner {
	return Object.freeze({ locator: Object.freeze({ ...locator }), manager: makeOwnerManager(ownerStore) });
}

interface FailureState {
	failed: boolean;
	value: unknown;
}

function recordFailure(state: FailureState, error: unknown, message: string): void {
	state.value = state.failed ? new AggregateError([state.value, error], message) : error;
	state.failed = true;
}

function closeManagedStore(
	store: ManagedSessionDescendantStore | undefined,
	state: FailureState,
	message: string,
): void {
	if (!store) return;
	try {
		store.close();
	} catch (error) {
		recordFailure(state, error, message);
	}
}

function closeReturnedOwner(result: ManagedTaskArtifactOwner | undefined, state: FailureState): void {
	closeManagedStore(result?.manager.getManagedStore(), state, "Closing the task artifact owner also failed.");
}

/** Reopen an owner only beneath the captured managed sessions-root authority. */
export function restoreManagedTaskArtifactOwner(
	context: TaskArtifactOwnerStorageContext,
	sessionId: string,
	locatorValue: unknown,
): ManagedTaskArtifactOwner {
	const locator = parseTaskArtifactOwnerLocator(locatorValue);
	if (!locator) throw new Error("task_artifact_owner_locator_missing");
	const rootStore = newSessionRootStore(context);
	const state: FailureState = { failed: false, value: undefined };
	let result: ManagedTaskArtifactOwner | undefined;
	try {
		const ownerStore = openOwnerStore(context, rootStore, locator, sessionId);
		result = taskArtifactOwnerFromStore(locator, ownerStore);
	} catch (error) {
		recordFailure(state, error, "Restoring the task artifact owner failed.");
	}
	closeManagedStore(rootStore, state, "Restoring the task artifact owner and closing its root store failed.");
	if (state.failed) {
		closeReturnedOwner(result, state);
		throw state.value;
	}
	if (!result) throw new Error("task_artifact_owner_unavailable");
	return result;
}

/** Establish or restore the logical-session owner under the captured managed sessions authority. */
export async function ensureManagedTaskArtifactOwner(
	context: TaskArtifactOwnerStorageContext,
	sessionId: string,
	locatorValue: unknown,
	legacyArtifactRelativePath?: string,
): Promise<ManagedTaskArtifactOwner> {
	assertSessionRoot(context);
	const locator = parseTaskArtifactOwnerLocator(locatorValue);
	const ownerId = locator?.ownerId ?? ownerIdForSession(sessionId);
	if (ownerId !== ownerIdForSession(sessionId)) throw new Error("task_artifact_owner_session_mismatch");
	const lock = await acquireManagedLock(
		path.join(context.sessionsRoot, OWNER_LOCK_DIRECTORY),
		`owner-${ownerId}`,
		context.rootAuthority,
		context.securityPolicy,
	);

	let result: ManagedTaskArtifactOwner | undefined;
	const state: FailureState = { failed: false, value: undefined };
	try {
		lock.assertOwned();
		if (locator) {
			result = restoreManagedTaskArtifactOwner(context, sessionId, locator);
		} else {
			const rootStore = newSessionRootStore(context);
			let ownerStore: ManagedSessionDescendantStore | undefined;
			try {
				rootStore.verifyRootSecurity();
				const ownerRelative = ownerRelativePath(ownerId);
				const ownerPath = path.join(context.sessionsRoot, ownerRelative);
				let existingDirectory = false;
				try {
					const stat = fs.lstatSync(ownerPath, { bigint: true });
					if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("task_artifact_owner_replaced");
					existingDirectory = true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}

				if (existingDirectory) {
					const identity = rootStore.captureDirectoryIdentity(ownerRelative);
					const existingLocator: TaskArtifactOwnerLocator = {
						schemaVersion: OWNER_SCHEMA_VERSION,
						ownerId,
						directoryDev: identity.dev,
						directoryIno: identity.ino,
					};
					const manifest: OwnerManifest = readOwnerManifest(rootStore, existingLocator);
					if (manifest.sessionId !== sessionId) throw new Error("task_artifact_owner_session_mismatch");
					const restoredLocator = locatorFromManifest(manifest);
					const restoredStore = openOwnerStore(context, rootStore, restoredLocator, sessionId);
					result = taskArtifactOwnerFromStore(restoredLocator, restoredStore);
				} else {
					let legacySource: { relativePath: string; snapshot: NativeDirectoryTreeSnapshot } | undefined;
					if (legacyArtifactRelativePath !== undefined) {
						assertSafeRelativePath(legacyArtifactRelativePath);
						if (legacyPathOverlapsOwner(context.sessionsRoot, legacyArtifactRelativePath, ownerRelative))
							throw new Error("task_artifact_owner_legacy_path_overlaps_owner");
						try {
							fs.lstatSync(path.join(context.sessionsRoot, legacyArtifactRelativePath), { bigint: true });
							legacySource = {
								relativePath: legacyArtifactRelativePath,
								snapshot: rootStore.captureTree(legacyArtifactRelativePath),
							};
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
					}

					rootStore.ensureDirectory(OWNER_DIRECTORY);
					const identity = rootStore.ensureDirectory(ownerRelative);
					const createdLocator: TaskArtifactOwnerLocator = {
						schemaVersion: OWNER_SCHEMA_VERSION,
						ownerId,
						directoryDev: identity.dev.toString(),
						directoryIno: identity.ino.toString(),
					};
					ownerStore = rootStore.deriveSubtree(ownerRelative);
					if (legacySource) {
						await copyLegacyArtifactTree(
							rootStore,
							legacySource.relativePath,
							ownerRelative,
							legacySource.snapshot,
						);
					}
					ownerStore.fsyncTree();
					lock.assertOwned();
					await ownerStore.publishNoReplace(
						OWNER_MANIFEST,
						Buffer.from(`${JSON.stringify({ ...createdLocator, sessionId })}\n`, "utf8"),
					);
					const verifiedStore = openOwnerStore(context, rootStore, createdLocator, sessionId);
					try {
						ownerStore.close();
					} catch (error) {
						try {
							verifiedStore.close();
						} catch (closeError) {
							throw new AggregateError(
								[error, closeError],
								"Opening the owner and closing its writer store failed.",
							);
						}
						throw error;
					}
					ownerStore = undefined;
					result = taskArtifactOwnerFromStore(createdLocator, verifiedStore);
				}
			} catch (error) {
				recordFailure(state, error, "Provisioning the task artifact owner failed.");
			}
			closeManagedStore(
				ownerStore,
				state,
				"Provisioning the task artifact owner and closing its writer store failed.",
			);
			closeManagedStore(rootStore, state, "Provisioning the task artifact owner and closing its root store failed.");
		}
	} catch (error) {
		recordFailure(state, error, "Task artifact owner setup failed.");
	}

	try {
		await lock.release();
	} catch (releaseError) {
		recordFailure(state, releaseError, "Task artifact owner setup and lock release failed.");
	}
	if (state.failed) {
		closeReturnedOwner(result, state);
		throw state.value;
	}
	if (!result) throw new Error("task_artifact_owner_unavailable");
	return result;
}
