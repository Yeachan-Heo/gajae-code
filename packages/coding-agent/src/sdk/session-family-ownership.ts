import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as util from "node:util";
import { CONFIG_DIR_NAME, getAgentProfileAuthority, getTrustedHomeDir } from "@gajae-code/utils/dirs";
import {
	type ClosedManagedTranscriptProof,
	isClosedManagedTranscriptProof,
	SessionManager,
	type TranscriptReadSnapshot,
} from "../session/session-manager";
import {
	type LifecycleLedgerEntry,
	type LifecycleState,
	SESSION_FAMILY_FORK_OPERATION,
} from "./broker/lifecycle-ledger";
import { observeProcessIncarnation } from "./broker/process-incarnation";
import { SessionIndex } from "./broker/session-index";
import type {
	SessionFamilyForkBinding,
	SessionFamilyOwnershipState,
	SessionFamilyReference,
	SessionFamilyRootRecord,
} from "./session-family-state";
import {
	assertSessionFamilyWorkspaceUnchanged,
	resolveSessionFamilyWorkspace,
	type SessionFamilyWorkspace,
	sessionFamilyWorkspacesOverlap,
} from "./session-family-workspace";

export type SessionFamilyOwnershipErrorCode =
	| "busy_branch"
	| "busy_workspace"
	| "uncertain"
	| "stale_reference"
	| "unsupported";

export class SessionFamilyOwnershipError extends Error {
	constructor(
		readonly code: SessionFamilyOwnershipErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "SessionFamilyOwnershipError";
	}
}

/**
 * First-party coordination is independent of per-session transcript/config roots.
 * Custom process profiles must not silently become separate ownership domains.
 * Explicit fixture coordinators use the constructor rather than this resolver.
 */
export function resolveSessionFamilyAuthorityDirectory(): string {
	if (getAgentProfileAuthority() !== "default") {
		throw new SessionFamilyOwnershipError(
			"unsupported",
			"Family sharing requires the default process profile authority.",
		);
	}
	return path.join(getTrustedHomeDir(), CONFIG_DIR_NAME, "session-families");
}

export interface SessionFamilyRootGrant {
	readonly kind: "root";
	readonly id: string;
	readonly generation: number;
	readonly sessionId: string;
	readonly workspace: SessionFamilyWorkspace;
}

export interface SessionFamilyChildGrant {
	readonly kind: "child";
	readonly id: string;
	readonly rootId: string;
	readonly generation: number;
	readonly sessionId: string;
	readonly workspace: SessionFamilyWorkspace;
}

/** Content evidence from a strictly closed managed child; never deletion authority. */
export function describeClosedFamilyForkTranscript(proof: ClosedManagedTranscriptProof): {
	identityDigest: string;
	contentDigest: string;
} {
	if (!isClosedManagedTranscriptProof(proof) || proof.revalidate().kind !== "valid")
		throw new SessionFamilyOwnershipError("uncertain", "Closed fork transcript evidence is unavailable.");
	const identity = proof.identity;
	const identityDigest = crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				sessionId: identity.sessionId,
				path: identity.canonicalPath,
				device: String(identity.dev),
				inode: String(identity.ino),
				links: String(identity.nlink),
				size: identity.size,
				mtimeNs: String(identity.mtimeNs),
				ctimeNs: String(identity.ctimeNs),
				sha256: identity.sha256,
			}),
		)
		.digest("hex");
	return Object.freeze({ identityDigest, contentDigest: identity.sha256 });
}

/** Historical operation facts only; none of these outcomes grants runtime admission. */
export type SessionFamilyForkLookup =
	| { kind: "not_found" }
	| { kind: "identity_conflict" }
	| { kind: "unresolved"; sessionId: string; state: LifecycleState }
	| { kind: "committed"; reference: SessionFamilyReference; state: LifecycleState; retainedUncertainty: boolean };

export interface PublishSessionFamilyForkInput {
	root: SessionFamilyRootGrant;
	child: SessionFamilyChildGrant;
	operationIdentity: string;
	requestHash: string;
	/** The producer retains source quiescence until this operation settles. */
	source: TranscriptReadSnapshot;
	/** Join the actual complete child lifetime, not cancellation or a deadline. */
	teardown: () => Promise<void>;
	captureTranscript: () => ClosedManagedTranscriptProof;
}

type Grant = SessionFamilyRootGrant | SessionFamilyChildGrant;
interface Capability {
	directory: string;
	rootId: string;
	tokenHash: string;
	pid: number;
	incarnation: string;
	released: boolean;
}

// Public identifiers and serialized lookalikes do not carry release authority.
const capabilities = new WeakMap<Grant, Capability>();

function currentActor(): { pid: number; incarnation: string } {
	const observation = observeProcessIncarnation(process.pid);
	if (observation.status !== "present") {
		throw new SessionFamilyOwnershipError("uncertain", "Runtime process identity could not be established.");
	}
	return { pid: process.pid, incarnation: observation.incarnation };
}

function secretHash(): string {
	return crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
}

function writerActive(state: SessionFamilyOwnershipState, sessionId: string): boolean {
	return state.roots.some(
		root =>
			root.sessionId === sessionId ||
			root.children.some(child => child.sessionId === sessionId && child.phase !== "closed"),
	);
}

function conflict(root: SessionFamilyRootRecord, code: "busy_branch" | "busy_workspace"): never {
	const observation = observeProcessIncarnation(root.actor.pid);
	if (
		root.phase === "uncertain" ||
		observation.status !== "present" ||
		observation.incarnation !== root.actor.incarnation
	) {
		// Death or PID reuse never proves that descendants have stopped. The durable
		// record remains; reclaiming a short index lock cannot remove this fence.
		throw new SessionFamilyOwnershipError("uncertain", "An earlier runtime has no verified clean teardown.");
	}
	throw new SessionFamilyOwnershipError(code, "Another runtime owns the requested conversation or workspace.");
}

function scopeContains(parent: SessionFamilyWorkspace, child: SessionFamilyWorkspace): boolean {
	const relative = path.relative(parent.root, child.root);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Internal coordinator. Production entrypoints must use the same machine authority directory. */
export class SessionFamilyOwnership {
	readonly #directory: string;
	readonly #index: SessionIndex;

	constructor(authorityDirectory: string) {
		this.#directory = path.resolve(authorityDirectory);
		this.#index = new SessionIndex(this.#directory);
	}

	async #transaction<T>(operation: (state: SessionFamilyOwnershipState, directory: string) => Promise<T>): Promise<T> {
		try {
			return await this.#index.updateFamilyOwnership(async state =>
				operation(state, await fs.realpath(this.#directory)),
			);
		} catch (error) {
			if (error instanceof SessionFamilyOwnershipError) throw error;
			throw new SessionFamilyOwnershipError(
				"uncertain",
				"Conversation ownership could not be established durably.",
				{ cause: error },
			);
		}
	}

	#owned(state: SessionFamilyOwnershipState, directory: string, grant: Grant): SessionFamilyRootRecord {
		const capability = capabilities.get(grant);
		const actor = currentActor();
		if (
			!capability ||
			capability.released ||
			capability.directory !== directory ||
			capability.pid !== actor.pid ||
			capability.incarnation !== actor.incarnation
		) {
			throw new SessionFamilyOwnershipError("stale_reference", "The runtime ownership capability is not current.");
		}
		const root = state.roots.find(
			candidate => candidate.id === capability.rootId && candidate.generation === grant.generation,
		);
		if (!root || root.actor.pid !== actor.pid || root.actor.incarnation !== actor.incarnation) {
			throw new SessionFamilyOwnershipError("stale_reference", "The runtime ownership generation is not current.");
		}
		const hash =
			grant.kind === "root" ? root.tokenHash : root.children.find(child => child.id === grant.id)?.tokenHash;
		if (hash !== capability.tokenHash)
			throw new SessionFamilyOwnershipError("stale_reference", "The runtime ownership token does not match.");
		return root;
	}

	async acquireRoot(cwd: string, sessionId: string = Bun.randomUUIDv7()): Promise<SessionFamilyRootGrant> {
		const workspace = await resolveSessionFamilyWorkspace(cwd);
		const actor = currentActor();
		return await this.#transaction(async (state, directory) => {
			await assertSessionFamilyWorkspaceUnchanged(workspace);
			for (const root of state.roots) {
				if (
					root.sessionId === sessionId ||
					root.children.some(child => child.sessionId === sessionId && child.phase !== "closed")
				)
					conflict(root, "busy_branch");
				if (root.workspaces.some(owned => sessionFamilyWorkspacesOverlap(owned, workspace)))
					conflict(root, "busy_workspace");
			}
			const tokenHash = secretHash();
			const grant: SessionFamilyRootGrant = Object.freeze({
				kind: "root",
				id: Bun.randomUUIDv7(),
				generation: state.revision + 1,
				sessionId,
				workspace: Object.freeze(workspace),
			});
			state.roots.push({
				id: grant.id,
				generation: grant.generation,
				sessionId,
				tokenHash,
				actor,
				workspaces: [workspace],
				phase: "active",
				children: [],
			});
			capabilities.set(grant, { directory, rootId: grant.id, tokenHash, ...actor, released: false });
			return grant;
		});
	}

	/** Reserve before child manager construction or dispatch, including nested tasks. */
	async reserveChild(
		parent: Grant,
		sessionId: string = Bun.randomUUIDv7(),
		cwd = parent.workspace.cwd,
	): Promise<SessionFamilyChildGrant> {
		const workspace = await resolveSessionFamilyWorkspace(cwd);
		return await this.#transaction(async (state, directory) => {
			const root = this.#owned(state, directory, parent);
			if (root.phase !== "active")
				throw new SessionFamilyOwnershipError("uncertain", "The root runtime is draining or uncertain.");
			if (parent.kind === "child") {
				const owningChild = root.children.find(child => child.id === parent.id);
				if (owningChild?.phase !== "active" || !scopeContains(parent.workspace, workspace)) {
					throw new SessionFamilyOwnershipError(
						"unsupported",
						"A subordinate cannot expand or replace its ownership scope.",
					);
				}
			}
			await assertSessionFamilyWorkspaceUnchanged(workspace);
			if (writerActive(state, sessionId))
				throw new SessionFamilyOwnershipError("busy_branch", "The child conversation already has an owner.");
			for (const other of state.roots) {
				if (other !== root && other.workspaces.some(owned => sessionFamilyWorkspacesOverlap(owned, workspace)))
					conflict(other, "busy_workspace");
			}
			if (
				!root.workspaces.some(
					owned =>
						owned.root === workspace.root && owned.device === workspace.device && owned.inode === workspace.inode,
				)
			)
				root.workspaces.push(workspace);
			const actor = currentActor();
			const tokenHash = secretHash();
			const grant: SessionFamilyChildGrant = Object.freeze({
				kind: "child",
				id: Bun.randomUUIDv7(),
				rootId: root.id,
				generation: root.generation,
				sessionId,
				workspace: Object.freeze(workspace),
			});
			root.children.push({
				id: grant.id,
				parentId: parent.kind === "child" ? parent.id : null,
				sessionId,
				tokenHash,
				workspace,
				actor,
				phase: "pending",
			});
			capabilities.set(grant, { directory, rootId: root.id, tokenHash, ...actor, released: false });
			return grant;
		});
	}

	async activateChild(grant: SessionFamilyChildGrant): Promise<void> {
		await this.#transaction(async (state, directory) => {
			const root = this.#owned(state, directory, grant);
			const child = root.children.find(candidate => candidate.id === grant.id);
			if (root.phase !== "active" || !child || (child.phase !== "pending" && child.phase !== "active")) {
				throw new SessionFamilyOwnershipError("uncertain", "The subordinate no longer has startup admission.");
			}
			await assertSessionFamilyWorkspaceUnchanged(child.workspace);
			child.phase = "active";
		});
	}

	/** A failed teardown is sticky; a later completion message cannot erase uncertainty. */
	async completeChild(grant: SessionFamilyChildGrant, outcome: "closed" | "uncertain"): Promise<void> {
		await this.#transaction(async (state, directory) => {
			const root = this.#owned(state, directory, grant);
			const child = root.children.find(candidate => candidate.id === grant.id);
			if (!child || child.phase === "uncertain")
				throw new SessionFamilyOwnershipError("uncertain", "Subordinate teardown is not verified.");
			child.phase = outcome;
			if (outcome === "uncertain") root.phase = "uncertain";
		});
	}

	/**
	 * Resolve only the original key. Matching immutable lineage proves historical
	 * publication even after an admitted child has advanced. This neither reruns
	 * effects nor certifies current transcript availability or runtime teardown.
	 */
	async lookupForkPublication(operationKey: string, requestHash: string): Promise<SessionFamilyForkLookup> {
		if (!operationKey.startsWith(`${SESSION_FAMILY_FORK_OPERATION}\u0000`) || !requestHash)
			return { kind: "identity_conflict" };
		try {
			return await this.#index.observeFamilyForkPublication<SessionFamilyForkLookup>(
				operationKey,
				async (state, entry) => {
					if (!entry) return { kind: "not_found" };
					if (entry.requestHash !== requestHash) return { kind: "identity_conflict" };
					if (!entry.intendedSessionId)
						throw new SessionFamilyOwnershipError("uncertain", "The original fork identity is unavailable.");
					const reference = state.branches.find(branch => branch.branchId === entry.intendedSessionId);
					if (!reference) return { kind: "unresolved", sessionId: entry.intendedSessionId, state: entry.state };
					const binding = entry.familyFork;
					const source = binding && state.branches.find(branch => branch.branchId === binding.source.branchId);
					if (
						!binding ||
						!source ||
						!entry.durableEffects?.transcript ||
						!util.isDeepStrictEqual(
							{ ...source, device: binding.source.device, inode: binding.source.inode },
							binding.source,
						) ||
						reference.familyId !== binding.source.familyId ||
						reference.parentBranchId !== binding.source.branchId ||
						reference.resourceId !== binding.destination.resourceId ||
						!util.isDeepStrictEqual(reference.anchor, binding.anchor) ||
						reference.sourceDirectory !== binding.destination.sourceDirectory ||
						path.dirname(reference.sessionFile) !== binding.destination.sourceDirectory ||
						reference.cwd !== binding.destination.workspace.cwd ||
						!util.isDeepStrictEqual(reference.workspace, binding.destination.workspace) ||
						reference.storage !== "managed" ||
						reference.managedAgentDir !== binding.destination.managedAgentDir
					)
						throw new SessionFamilyOwnershipError(
							"uncertain",
							"The reserved child has no matching committed lineage.",
						);
					const owner = state.roots.find(
						root => root.id === binding.owner.rootId && root.generation === binding.owner.generation,
					);
					return {
						kind: "committed",
						reference: structuredClone(reference),
						state: entry.state,
						retainedUncertainty:
							entry.state === "terminal_uncertain" ||
							owner?.phase === "uncertain" ||
							owner?.children.some(
								child => child.sessionId === entry.intendedSessionId && child.phase === "uncertain",
							) === true,
					};
				},
				result => result.kind === "committed",
			);
		} catch (error) {
			if (error instanceof SessionFamilyOwnershipError) throw error;
			throw new SessionFamilyOwnershipError("uncertain", "Fork publication lookup could not be confirmed.", {
				cause: error,
			});
		}
	}

	#forkBinding(
		state: SessionFamilyOwnershipState,
		directory: string,
		input: PublishSessionFamilyForkInput,
		entry: LifecycleLedgerEntry | undefined,
	): SessionFamilyForkBinding {
		const root = this.#owned(state, directory, input.root);
		const childRoot = this.#owned(state, directory, input.child);
		const child = root.children.find(candidate => candidate.id === input.child.id);
		if (
			input.root.kind !== "root" ||
			input.child.kind !== "child" ||
			childRoot !== root ||
			!child ||
			child.parentId !== null
		)
			throw new SessionFamilyOwnershipError("stale_reference", "The fork child does not belong to this owner.");
		if (
			root.phase !== "active" ||
			child.phase !== "active" ||
			root.children.some(candidate => candidate.parentId === child.id)
		)
			throw new SessionFamilyOwnershipError("uncertain", "The fork lifetime is not active for publication.");
		const binding = entry?.familyFork;
		if (
			!entry ||
			!binding ||
			entry.requestHash !== input.requestHash ||
			entry.state !== "awaiting_ready" ||
			!entry.operationKey?.startsWith(`${SESSION_FAMILY_FORK_OPERATION}\u0000`) ||
			entry.intendedSessionId !== child.sessionId ||
			!entry.durableEffects?.transcript ||
			binding.owner.rootId !== root.id ||
			binding.owner.generation !== root.generation ||
			!util.isDeepStrictEqual(binding.owner.actor, root.actor) ||
			root.sessionId !== binding.source.branchId ||
			!util.isDeepStrictEqual(
				binding.source,
				state.branches.find(branch => branch.branchId === root.sessionId),
			) ||
			!util.isDeepStrictEqual(binding.source.workspace, input.root.workspace) ||
			!util.isDeepStrictEqual(binding.destination.workspace, child.workspace)
		)
			throw new SessionFamilyOwnershipError(
				"stale_reference",
				"The materialized fork reservation does not match its owner.",
			);
		return binding;
	}

	/**
	 * Atomically publish reference plus lineage only after actual child teardown.
	 * The caller must hold its source quiescence interval throughout this call.
	 * This does not manufacture that interval or treat a journal terminal as commit.
	 */
	async publishForkAfterTeardown(input: PublishSessionFamilyForkInput): Promise<SessionFamilyReference> {
		// Copy top-level inputs before awaiting; public lookalikes cannot bootstrap
		// an authority directory or dispatch a teardown callback.
		const request = { ...input };
		for (const grant of [request.root, request.child]) {
			const capability = capabilities.get(grant);
			if (!capability || capability.released)
				throw new SessionFamilyOwnershipError("stale_reference", "The fork ownership capability is not current.");
		}
		const directory = await fs.realpath(this.#directory);
		for (const grant of [request.root, request.child]) {
			if (capabilities.get(grant)!.directory !== directory)
				throw new SessionFamilyOwnershipError(
					"stale_reference",
					"The fork ownership capability belongs to another authority.",
				);
		}
		const originalBinding = await this.#index.readFamilyOwnershipWithLifecycle(async (state, ledger) => {
			await ledger.assertFamilyForkJournalHealthy();
			return this.#forkBinding(state, directory, request, ledger.get(request.operationIdentity));
		});
		let proof: ClosedManagedTranscriptProof | undefined;
		let proofCloseAttempted = false;
		try {
			await request.teardown();
			return await this.#index.updateFamilyOwnershipWithLifecycle(async (state, ledger) => {
				await ledger.assertFamilyForkJournalHealthy();
				const entry = ledger.get(request.operationIdentity);
				const binding = this.#forkBinding(state, directory, request, entry);
				if (!util.isDeepStrictEqual(binding, originalBinding))
					throw new SessionFamilyOwnershipError(
						"stale_reference",
						"The fork reservation changed during teardown.",
					);
				await assertSessionFamilyWorkspaceUnchanged(request.root.workspace);
				await assertSessionFamilyWorkspaceUnchanged(request.child.workspace);
				if (
					SessionManager.getDefaultSessionDirReadOnly(
						binding.destination.workspace.cwd,
						binding.destination.managedAgentDir,
					) !== binding.destination.sourceDirectory
				)
					throw new SessionFamilyOwnershipError(
						"uncertain",
						"The managed fork destination binding is not current.",
					);
				const sourceIdentity = request.source.identity;
				const inspected = SessionManager.inspectCompleteCommittedSnapshot(request.source, binding.anchor.entryId);
				if (
					inspected.kind !== "complete" ||
					inspected.sessionId !== binding.source.branchId ||
					inspected.capturedDigest !== binding.anchor.capturedDigest ||
					sourceIdentity.canonicalPath !== binding.source.sessionFile ||
					sourceIdentity.nlink !== 1n ||
					String(sourceIdentity.dev) !== binding.source.device ||
					String(sourceIdentity.ino) !== binding.source.inode ||
					(await fs.realpath(inspected.cwd)) !== binding.source.cwd
				)
					throw new SessionFamilyOwnershipError(
						"uncertain",
						"The committed source snapshot is no longer current.",
					);
				const captured = request.captureTranscript();
				if (!isClosedManagedTranscriptProof(captured))
					throw new SessionFamilyOwnershipError("uncertain", "Closed fork transcript evidence is unavailable.");
				proof = captured;
				const receipt = describeClosedFamilyForkTranscript(proof);
				const identity = proof.identity;
				if (
					identity.sessionId !== entry!.intendedSessionId ||
					identity.nlink !== 1n ||
					path.dirname(identity.canonicalPath) !== binding.destination.sourceDirectory ||
					!util.isDeepStrictEqual(receipt, entry!.durableEffects!.transcript)
				)
					throw new SessionFamilyOwnershipError(
						"uncertain",
						"The materialized child transcript does not match its reservation.",
					);
				const childCapture = SessionManager.captureTranscriptReadOnly(identity.canonicalPath);
				if (childCapture.kind !== "captured")
					throw new SessionFamilyOwnershipError("uncertain", "The closed child transcript cannot be inspected.");
				try {
					const childFacts = SessionManager.inspectCompleteCommittedSnapshot(
						childCapture.snapshot,
						binding.anchor.entryId,
					);
					const observed = childCapture.snapshot.identity;
					if (
						childFacts.kind !== "complete" ||
						childFacts.sessionId !== identity.sessionId ||
						observed.dev !== identity.dev ||
						observed.ino !== identity.ino ||
						observed.sha256 !== identity.sha256 ||
						observed.ctimeNs !== identity.ctimeNs ||
						(await fs.realpath(childFacts.cwd)) !== binding.destination.workspace.cwd
					)
						throw new SessionFamilyOwnershipError(
							"uncertain",
							"The child snapshot does not match its reserved scope.",
						);
				} catch (error) {
					try {
						childCapture.snapshot.close();
					} catch (cleanupError) {
						throw new AggregateError([error, cleanupError], "Child inspection and descriptor cleanup failed.");
					}
					throw error;
				}
				childCapture.snapshot.close();
				const reference: SessionFamilyReference = {
					familyId: binding.source.familyId,
					branchId: identity.sessionId,
					resourceId: binding.destination.resourceId,
					sessionFile: identity.canonicalPath,
					sourceDirectory: binding.destination.sourceDirectory,
					cwd: binding.destination.workspace.cwd,
					workspace: structuredClone(binding.destination.workspace),
					device: String(identity.dev),
					inode: String(identity.ino),
					storage: "managed",
					managedAgentDir: binding.destination.managedAgentDir,
					parentBranchId: binding.source.branchId,
					anchor: { ...binding.anchor },
				};
				if (
					state.branches.some(
						branch =>
							branch.branchId === reference.branchId ||
							branch.resourceId === reference.resourceId ||
							branch.sessionFile === reference.sessionFile ||
							(branch.device === reference.device && branch.inode === reference.inode),
					)
				)
					throw new SessionFamilyOwnershipError("uncertain", "The fork publication identity is already claimed.");
				if (proof.revalidate().kind !== "valid" || request.source.revalidate().kind !== "valid")
					throw new SessionFamilyOwnershipError("uncertain", "Fork publication evidence changed before commit.");
				proofCloseAttempted = true;
				proof.close();
				proof = undefined;
				state.branches.push(reference);
				this.#owned(state, directory, request.child).children.find(child => child.id === request.child.id)!.phase =
					"closed";
				return structuredClone(reference);
			});
		} catch (error) {
			const failures: unknown[] = [error];
			if (proof && !proofCloseAttempted) {
				try {
					proof.close();
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			}
			try {
				await this.completeChild(request.child, "uncertain");
			} catch (retentionError) {
				failures.push(retentionError);
			}
			throw new SessionFamilyOwnershipError("uncertain", "Fork publication or teardown is unconfirmed.", {
				cause: { failure: new AggregateError(failures, "Fork publication failed."), proof },
			});
		}
	}

	/** Joining actual runtime teardown is mandatory; detach and deadline expiry are not proof. */
	async releaseAfterTeardown(
		grant: SessionFamilyRootGrant,
		teardown: () => Promise<void>,
		captureTranscript?: () => ClosedManagedTranscriptProof,
	): Promise<void> {
		if (grant.kind !== "root")
			throw new SessionFamilyOwnershipError("unsupported", "A subordinate cannot release root ownership.");
		const capability = capabilities.get(grant);
		if (capability?.released) return;
		await this.#transaction(async (state, directory) => {
			const root = this.#owned(state, directory, grant);
			if (root.phase === "uncertain")
				throw new SessionFamilyOwnershipError("uncertain", "Runtime teardown remains uncertain.");
			root.phase = "draining";
		});
		let transcript: ClosedManagedTranscriptProof | undefined;
		try {
			await teardown();
			const proof = captureTranscript?.();
			if (proof !== undefined) {
				if (!isClosedManagedTranscriptProof(proof)) {
					throw new SessionFamilyOwnershipError("uncertain", "Closed transcript evidence is unavailable.");
				}
				transcript = proof;
			}
			await this.#transaction(async (state, directory) => {
				const root = this.#owned(state, directory, grant);
				if (root.phase !== "draining" || root.children.some(child => child.phase !== "closed")) {
					throw new SessionFamilyOwnershipError("uncertain", "Owned subordinate work has not completed teardown.");
				}
				const reference = state.branches.find(branch => branch.branchId === root.sessionId);
				if (transcript) {
					if (
						!reference ||
						!isClosedManagedTranscriptProof(transcript) ||
						transcript.identity.sessionId !== root.sessionId ||
						transcript.identity.canonicalPath !== reference.sessionFile ||
						reference.storage !== "managed" ||
						reference.cwd !== grant.workspace.cwd ||
						reference.workspace.root !== grant.workspace.root ||
						reference.workspace.device !== grant.workspace.device ||
						reference.workspace.inode !== grant.workspace.inode ||
						reference.workspace.gitCommonDirectory !== grant.workspace.gitCommonDirectory ||
						transcript.revalidate().kind !== "valid"
					) {
						throw new SessionFamilyOwnershipError("uncertain", "The owned transcript binding is not verified.");
					}
					// Preserve logical identity and immutable lineage. Only the certified
					// post-write physical object changes, atomically with root release.
					reference.device = String(transcript.identity.dev);
					reference.inode = String(transcript.identity.ino);
				}
				transcript?.close();
				transcript = undefined;
				state.roots.splice(state.roots.indexOf(root), 1);
			});
			if (capability) capability.released = true;
		} catch (error) {
			let failure = error;
			try {
				await this.#transaction(async (state, directory) => {
					this.#owned(state, directory, grant).phase = "uncertain";
				});
			} catch (retentionError) {
				failure = new AggregateError(
					[error, retentionError],
					"Runtime teardown and ownership-fence retention failed.",
				);
			}
			try {
				transcript?.close();
			} catch (cleanupError) {
				failure = new AggregateError(
					[failure, cleanupError],
					"Runtime teardown and transcript-proof cleanup failed.",
				);
			}
			throw failure;
		}
	}
}
