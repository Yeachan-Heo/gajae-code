import * as native from "@gajae-code/natives";
import { getProjectDir } from "@gajae-code/utils";
import type { SessionIdentityAllocation, SessionManager } from "../session/session-manager";
import type { CreateAgentSessionOptions } from "./session";
import {
	resolveSessionFamilyAuthorityDirectory,
	SessionFamilyOwnership,
	SessionFamilyOwnershipError,
	type SessionFamilyRootGrant,
} from "./session-family-ownership";
import { SessionFamilyRegistry } from "./session-family-registry";
import { assertSessionFamilyWorkspaceUnchanged } from "./session-family-workspace";

// This internal handoff is not a public sharing policy or authority-directory override.
// A copied options object does not carry the original runtime's grant.
const startups = new WeakMap<CreateAgentSessionOptions, SessionFamilyStartup>();

/** Reserve before the SDK starts settings, credentials, managers, or extensions. */
export async function prepareNewFamilySession(
	options: CreateAgentSessionOptions,
	authorityDirectory: string = resolveSessionFamilyAuthorityDirectory(),
): Promise<CreateAgentSessionOptions> {
	if (
		(process.platform !== "linux" && process.platform !== "darwin") ||
		typeof native.retainStagedDirectory !== "function" ||
		typeof native.NativeStagedDirectory?.prototype?.createOwnedChild !== "function" ||
		typeof native.NativeOwnedStagedDirectory?.prototype?.creationReceipt !== "function" ||
		typeof native.NativeOwnedStagedDirectory?.prototype?.bindFile !== "function" ||
		typeof native.NativeOwnedStagedDirectory?.prototype?.syncSync !== "function" ||
		typeof native.NativeOwnedStagedDirectory?.prototype?.retireEmptySync !== "function" ||
		typeof native.NativeOwnedStagedDirectory?.prototype?.release !== "function" ||
		typeof native.NativeOwnedStagedFile?.prototype?.moveNoReplaceSync !== "function" ||
		typeof native.NativeOwnedStagedFile?.prototype?.sealSync !== "function" ||
		typeof native.NativeOwnedStagedFile?.prototype?.discardSync !== "function" ||
		typeof native.NativeOwnedStagedFile?.prototype?.release !== "function" ||
		typeof native.NativeStagedDirectory?.prototype?.bindFile !== "function" ||
		typeof native.NativeStagedDirectory?.prototype?.syncSync !== "function" ||
		typeof native.NativeStagedDirectory?.prototype?.release !== "function" ||
		typeof native.NativeStagedFile?.prototype?.sealSync !== "function" ||
		typeof native.NativeStagedFile?.prototype?.discardSync !== "function" ||
		typeof native.NativeStagedFile?.prototype?.retirePublishedAliasSync !== "function" ||
		typeof native.NativeStagedFile?.prototype?.release !== "function"
	) {
		throw new SessionFamilyOwnershipError("unsupported", "Retained native session cleanup is unavailable.");
	}
	const snapshot = { ...options };
	if (snapshot.sessionManager) {
		throw new SessionFamilyOwnershipError(
			"unsupported",
			"An already-open manager cannot establish family admission.",
		);
	}
	if ((snapshot.taskDepth ?? 0) > 0 || snapshot.parentTaskPrefix || snapshot.currentAgentType) {
		throw new SessionFamilyOwnershipError("unsupported", "Subordinate startup requires a scoped child grant.");
	}
	const ownership = new SessionFamilyOwnership(authorityDirectory);
	const grant = await ownership.acquireRoot(snapshot.cwd ?? getProjectDir());
	const prepared = Object.freeze({ ...snapshot, cwd: grant.workspace.cwd });
	startups.set(prepared, new SessionFamilyStartup(ownership, grant, new SessionFamilyRegistry(authorityDirectory)));
	return prepared;
}

/** @internal No identifiers or caller-supplied manager getters can synthesize this handoff. */
export function getSessionFamilyStartup(options: CreateAgentSessionOptions): SessionFamilyStartup | undefined {
	return startups.get(options);
}

/** Cancellation is clean only while no factory has accepted the reservation. */
export async function cancelPreparedFamilySession(options: CreateAgentSessionOptions): Promise<void> {
	const startup = startups.get(options);
	if (!startup) throw new SessionFamilyOwnershipError("stale_reference", "Family startup admission is unavailable.");
	await startup.cancelBeforeStart();
}

export class SessionFamilyStartup {
	readonly identityAllocation: SessionIdentityAllocation;
	readonly #ownership: SessionFamilyOwnership;
	readonly #grant: SessionFamilyRootGrant;
	readonly #registry: SessionFamilyRegistry;
	readonly #ready = Promise.withResolvers<void>();
	readonly #startupFailure = new SessionFamilyOwnershipError("uncertain", "Family runtime startup did not complete.");
	#phase: "prepared" | "starting" | "ready" | "failed" | "cancelled" = "prepared";
	#completion: Promise<void> | undefined;
	#effectsStarted = false;
	#manager: SessionManager | undefined;

	constructor(ownership: SessionFamilyOwnership, grant: SessionFamilyRootGrant, registry: SessionFamilyRegistry) {
		this.#ownership = ownership;
		this.#grant = grant;
		this.#registry = registry;
		this.identityAllocation = Object.freeze({ sessionId: grant.sessionId });
		void this.#ready.promise.catch(() => {});
	}

	begin(): void {
		if (this.#phase !== "prepared") {
			throw new SessionFamilyOwnershipError(
				"stale_reference",
				"Family startup admission has already been consumed.",
			);
		}
		this.#phase = "starting";
	}

	async validateWorkspace(): Promise<void> {
		await assertSessionFamilyWorkspaceUnchanged(this.#grant.workspace);
	}

	beginEffects(): void {
		this.#effectsStarted = true;
	}

	acceptManager(manager: SessionManager): void {
		if (
			(this.#manager !== undefined && this.#manager !== manager) ||
			manager.getSessionId() !== this.#grant.sessionId ||
			manager.getCwd() !== this.#grant.workspace.cwd
		) {
			throw new SessionFamilyOwnershipError("stale_reference", "The manager does not match its startup admission.");
		}
		this.#manager = manager;
	}

	async registerManager(manager: SessionManager, agentDir: string, isDisposed: () => boolean): Promise<void> {
		const canPublish = () => !isDisposed() && this.#phase === "starting" && this.#completion === undefined;
		const assertPublishable = () => {
			if (!canPublish()) {
				throw new SessionFamilyOwnershipError(
					"uncertain",
					"A retiring runtime cannot publish its family reference.",
				);
			}
		};
		assertPublishable();
		await this.validateWorkspace();
		assertPublishable();
		this.acceptManager(manager);
		await manager.ensureOnDisk();
		await manager.flush();
		assertPublishable();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile)
			throw new SessionFamilyOwnershipError("unsupported", "Family registration requires persistence.");
		await this.#registry.registerExisting(
			{
				sessionFile,
				sourceDirectory: manager.getSessionDir(),
				expectedSessionId: this.#grant.sessionId,
				expectedCwd: this.#grant.workspace.cwd,
				storage: "managed",
				managedAgentDir: agentDir,
			},
			canPublish,
		);
	}

	ready(disposed: boolean): void {
		if (this.#phase !== "starting" || disposed || this.#completion !== undefined) {
			throw new SessionFamilyOwnershipError("uncertain", "Family startup no longer has a publishable runtime.");
		}
		this.#phase = "ready";
		this.#ready.resolve();
	}

	failed(): void {
		if (this.#phase === "starting") {
			this.#phase = "failed";
			this.#ready.reject(this.#startupFailure);
		}
		if (this.#phase === "failed" && this.#effectsStarted) {
			// Persist uncertainty without waiting for a constructor or close retry to settle.
			this.#completion ??= this.#ownership.releaseAfterTeardown(this.#grant, async () => {
				throw this.#startupFailure;
			});
			void this.#completion.catch(() => {});
		}
	}

	dispose(localTeardown: Promise<void>): Promise<void> {
		if (this.#phase === "starting") this.failed();
		this.#completion ??= this.#ownership.releaseAfterTeardown(
			this.#grant,
			async () => {
				// Failure fences immediately. AgentSession independently retains localTeardown
				// even if this finalizer rejects before physical cleanup finishes.
				await Promise.all([localTeardown, this.#ready.promise]);
			},
			() => {
				if (!this.#manager) {
					throw new SessionFamilyOwnershipError("uncertain", "The admitted writer is unavailable.");
				}
				return this.#manager.captureClosedManagedTranscriptProof();
			},
		);
		return this.#completion;
	}

	async retainStartupFailure(): Promise<void> {
		this.failed();
		if (!this.#effectsStarted) {
			this.#completion ??= this.#ownership.releaseAfterTeardown(this.#grant, async () => {});
			await this.#completion;
			return;
		}
		try {
			await this.dispose(Promise.resolve());
		} catch (error) {
			if (error !== this.#startupFailure) throw error;
		}
	}

	async cancelBeforeStart(): Promise<void> {
		if (this.#phase !== "prepared") {
			throw new SessionFamilyOwnershipError(
				"stale_reference",
				"Only an unstarted family reservation can be cancelled.",
			);
		}
		this.#phase = "cancelled";
		await this.#ownership.releaseAfterTeardown(this.#grant, async () => {});
	}
}
