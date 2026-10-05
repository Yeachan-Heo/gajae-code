import * as fs from "node:fs";
import * as path from "node:path";
import type { NativeDirectoryTreeSnapshot, NativeExactUnlinkResult } from "@gajae-code/natives";
import type { ManagedSessionDescendantStore } from "./internal/managed-session-storage";
import {
	captureOwnerTreeIfPresent,
	captureValidatedOwnerTree,
	newSessionRootReaderStore,
	newSessionRootStore,
	ownerTreeHasPendingManagedPublication,
} from "./internal/task-artifact-owner-access";
import {
	EMPTY_PAYLOAD_SHA256,
	isKnownNativeSidePath,
	isOwnerRetainedRoot,
	normalizeRetainedTreeSnapshot,
	OWNER_DIRECTORY,
	OWNER_RETIREMENT_SCHEMA_VERSION,
	ownerAbsolutePath,
	parseTaskArtifactOwnerDeletionEvidence,
	parseTaskArtifactOwnerRetirementContinuation,
	parseTaskArtifactOwnerRetirementOutcome,
	retainedTreeDoesNotExpandAuthority,
	sameOwnerParentIdentity,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerRetirementContinuation,
	type TaskArtifactOwnerRetirementOutcome,
	type TaskArtifactOwnerStorageContext,
} from "./task-artifact-owner-codec";

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
	const store = newSessionRootReaderStore(context);
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

/** Revalidate a persisted remnant through managed authority without mutation or new payload proof. */
export function verifyTaskArtifactOwnerRetirementContinuation(
	context: TaskArtifactOwnerStorageContext,
	evidenceValue: TaskArtifactOwnerDeletionEvidence,
	value: unknown,
): TaskArtifactOwnerRetirementContinuation {
	const evidence = parseTaskArtifactOwnerDeletionEvidence(evidenceValue);
	const continuation = parseTaskArtifactOwnerRetirementContinuation(context, evidence, value);
	const store = newSessionRootReaderStore(context);
	try {
		if (!sameOwnerParentIdentity(store.captureDirectoryIdentity(OWNER_DIRECTORY), evidence.parentIdentity))
			throw new Error("task_artifact_owner_parent_identity_mismatch");
		const snapshot = captureOwnerTreeIfPresent(
			context,
			store,
			evidence.locator.ownerId,
			continuation.retainedRootPath,
		);
		const prior = normalizeRetainedTreeSnapshot(evidence.treeSnapshot, continuation.retainedTreeSnapshot);
		const current = snapshot && normalizeRetainedTreeSnapshot(evidence.treeSnapshot, snapshot);
		if (!prior || !current || !retainedTreeDoesNotExpandAuthority(prior, current))
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
		let currentParent: { readonly dev: string; readonly ino: string };
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

		// Publication markers can hold writable descriptors; scrubbing cannot revoke them.
		if (ownerTreeHasPendingManagedPublication(evidence.treeSnapshot))
			return {
				kind: "uncertain",
				evidence,
				continuation: fallback,
				reason: "task_artifact_owner_writer_not_quiescent",
			};

		const ownerPath = ownerAbsolutePath(context, evidence.locator.ownerId);
		const removingPath = `${ownerPath}.removing`;
		const baseline = previous
			? normalizeRetainedTreeSnapshot(evidence.treeSnapshot, previous.retainedTreeSnapshot)
			: evidence.treeSnapshot;
		const candidates = [
			...new Set(
				[previous?.retainedRootPath, removingPath, ownerPath].filter(
					(pathname): pathname is string => pathname !== undefined,
				),
			),
		];
		let retainedRootPath: string | undefined;
		let retainedTreeSnapshot: NativeDirectoryTreeSnapshot | undefined;
		let nativeTreeSnapshot: NativeDirectoryTreeSnapshot | undefined;
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
			if (snapshot && ownerTreeHasPendingManagedPublication(snapshot))
				return {
					kind: "uncertain",
					evidence,
					continuation: fallback,
					reason: "task_artifact_owner_writer_not_quiescent",
				};
			const normalized = snapshot && normalizeRetainedTreeSnapshot(evidence.treeSnapshot, snapshot);
			if (!snapshot || !normalized || !baseline || !retainedTreeDoesNotExpandAuthority(baseline, normalized))
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
			nativeTreeSnapshot = normalized;
			break;
		}
		if (!retainedRootPath || !retainedTreeSnapshot || !nativeTreeSnapshot)
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
				nativeTreeSnapshot,
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
			if (residualTree) {
				const normalizedResidual = normalizeRetainedTreeSnapshot(evidence.treeSnapshot, residualTree);
				if (!normalizedResidual || !retainedTreeDoesNotExpandAuthority(nativeTreeSnapshot, normalizedResidual))
					residualValid = false;
			}
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
