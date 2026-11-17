import {
	consentEmbeddedDisconnect,
	createEmbeddedAgentSession,
	currentEmbeddedInteraction,
	currentEmbeddedResumeOperation,
	type EmbeddedAgentSessionOptions,
	type EmbeddedAgentSessionResult,
	type NativeEmbeddedOpenResult,
	type NativeEmbeddedRuntime,
	type PendingResumeOp,
	prepareEmbeddedDisconnect,
	reconcileEmbeddedResumeCheckpoint,
	resolveEmbeddedResumeCheckpoint,
	type SdkResumeCheckpoint,
	terminateEmbeddedAgentSession,
} from "@gajae-code/coding-agent/sdk";

/**
 * C14 connection state. `uncertain_cursor` and `checkpoint_incomplete` retain the
 * runtime and handle: the context is still live, only its recovery is unresolved.
 */
export type NativeConnectionState =
	| "connected"
	| "disconnecting"
	| "disconnected"
	| "release_failed"
	| "detach_unknown"
	| "uncertain_cursor"
	| "checkpoint_incomplete";

export interface NativeUnresolvedOpen {
	readonly kind: "unresolved";
	readonly state: Extract<NativeConnectionState, "uncertain_cursor" | "checkpoint_incomplete">;
	readonly handle: NativeOpenHandle;
	readonly op: PendingResumeOp;
	readonly error?: string;
	/** Retains the issuer's unpublished-open capability until retirement is proven. */
	retire(): Promise<void>;
}

export type NativeOpenOutcome =
	| { readonly kind: "opened"; readonly session: NativeSession }
	/** More than one live branch: the caller must ask which one continues. */
	| {
			readonly kind: "selector_required";
			readonly checkpoint: SdkResumeCheckpoint;
			readonly candidates: readonly string[];
	  }
	/** Recovery stayed unresolved. The handle is retained so the caller can reconcile, not reopen. */
	| NativeUnresolvedOpen
	| { readonly kind: "refused"; readonly reason: string };

type NativeOpenHandle = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>["handle"];

/** Default graceful Disconnect outcome. A blocked result keeps the runtime and handle live. */
export type NativeDisconnectOutcome =
	| { readonly kind: "disconnected" }
	| {
			readonly kind: "blocked";
			readonly state: NativeConnectionState;
			readonly blockers: readonly string[];
	  }
	| { readonly kind: "release_failed"; readonly error: string };

function mapOpenOutcome(opened: NativeEmbeddedOpenResult): NativeOpenOutcome {
	switch (opened.kind) {
		case "opened":
			return { kind: "opened", session: new NativeSession(opened.handle, opened.result, opened.runtime) };
		case "selector":
			return {
				kind: "selector_required",
				checkpoint: opened.checkpoint,
				candidates: opened.checkpoint.candidates ?? [],
			};
		case "uncertain_cursor":
		case "selection_incomplete":
		case "startup_failed":
			return {
				kind: "unresolved",
				state: opened.kind === "uncertain_cursor" ? "uncertain_cursor" : "checkpoint_incomplete",
				handle: opened.handle,
				op: opened.op,
				error: opened.error,
				async retire() {
					const result = await opened.abortOpen();
					if (result.receipt.terminalDisposition.kind !== "retired")
						throw new Error(`Native open could not be retired (${result.refusal ?? result.outcome.kind})`);
				},
			};
		case "refused":
			return { kind: "refused", reason: opened.reason };
	}
}

export interface NativeOpenInput {
	readonly options: Omit<EmbeddedAgentSessionOptions, "storage">;
	readonly storage: Exclude<EmbeddedAgentSessionOptions["storage"], { persist: false }>;
	/** Existing transcript to take over; omit to create a fresh one. */
	readonly file?: string;
	/** Exact execution selection when the caller already resolved a branch. */
	readonly selection?: { readonly snapshotDigest: string; readonly targetLeafId: string | null };
}

/**
 * One App-owned native session. Reads stay on the SDK result; every mutation goes
 * through `runtime`, so the host never reaches into the raw session for writes.
 */
export class NativeSession {
	#state: NativeConnectionState = "connected";
	#epoch = 0;
	readonly #handle: NativeOpenHandle;
	/** The full SDK result: the host's controllers and factory paths read from it. */
	readonly result: EmbeddedAgentSessionResult;
	readonly runtime: NativeEmbeddedRuntime;

	constructor(handle: NativeOpenHandle, result: EmbeddedAgentSessionResult, runtime: NativeEmbeddedRuntime) {
		this.#handle = handle;
		this.result = result;
		this.runtime = runtime;
	}

	get sdk(): EmbeddedAgentSessionResult["session"] {
		return this.result.session;
	}

	get state(): NativeConnectionState {
		return this.#state;
	}
	get epoch(): number {
		return this.#epoch;
	}
	/** The registered interaction service this runtime publishes questions on. */
	get interaction(): ReturnType<typeof currentEmbeddedInteraction> {
		return currentEmbeddedInteraction(this.#handle);
	}
	/** The operation this runtime reconciles right now; a durable selection replaces it. */
	get operation(): PendingResumeOp {
		return currentEmbeddedResumeOperation(this.#handle);
	}

	/**
	 * Default graceful Disconnect: record `disconnecting` with a new epoch, prove the
	 * owned suffix, then tear down under consent. An unresolved recovery keeps the
	 * runtime and handle instead of guessing.
	 */
	async disconnect(): Promise<NativeDisconnectOutcome> {
		if (this.#state === "disconnected") return { kind: "disconnected" };
		this.#state = "disconnecting";
		const epoch = ++this.#epoch;
		const current = (): boolean => this.#epoch === epoch;
		try {
			const reconciled = await reconcileEmbeddedResumeCheckpoint(this.#handle, {
				op: this.operation,
				mode: "repairDurability",
			});
			if (!current()) return { kind: "blocked", state: this.#state, blockers: ["superseded"] };
			const blockers = disconnectBlockers(reconciled);
			if (blockers.length > 0) {
				this.#state = reconciled.outcome.kind === "unknown" ? "uncertain_cursor" : "checkpoint_incomplete";
				return { kind: "blocked", state: this.#state, blockers };
			}
			const op = this.operation;
			const preparation = await prepareEmbeddedDisconnect(this.#handle, op);
			if (!current()) return { kind: "blocked", state: this.#state, blockers: ["superseded"] };
			if (!preparation.inventory) return { kind: "blocked", state: this.#state, blockers: ["work_inventory_missing"] };
			const inventory = preparation.inventory;
			// Default Disconnect stops the work this session still owns. A blocker with no
			// addressable target cannot be stopped by consent, so it is retained and reported.
			const untargeted = inventory.blockers.filter(blocker => !blocker.target);
			if (untargeted.length > 0) {
				this.#state = "checkpoint_incomplete";
				return { kind: "blocked", state: this.#state, blockers: untargeted.map(blocker => `owned_work:${blocker.kind}`) };
			}
			const consent = consentEmbeddedDisconnect(this.#handle, preparation, {
				stopAndJoin: true,
				work: {
					inventory,
					targets: inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : [])),
				},
			});
			if (!consent) return { kind: "blocked", state: this.#state, blockers: ["consent_refused"] };
			const receipt = await terminateEmbeddedAgentSession(this.#handle, { op, consent });
			this.#state = receipt.receipt.terminalDisposition.kind === "retired" ? "disconnected" : "detach_unknown";
			return this.#state === "disconnected"
				? { kind: "disconnected" }
				: { kind: "blocked", state: this.#state, blockers: ["terminal_retention"] };
		} catch (error) {
			this.#state = "release_failed";
			return { kind: "release_failed", error: error instanceof Error ? error.message : String(error) };
		}
	}
}

/** Reasons a graceful Disconnect must retain the session instead of tearing it down. */
function disconnectBlockers(reconciled: Awaited<ReturnType<typeof reconcileEmbeddedResumeCheckpoint>>): string[] {
	const blockers: string[] = [];
	if (reconciled.outcome.kind === "unknown") blockers.push("uncertain_cursor");
	if (reconciled.outcome.kind === "suffix_incomplete") blockers.push("suffix_incomplete");
	if (!reconciled.receipt.commitment.continueEligible) blockers.push("not_continue_eligible");
	for (const id of reconciled.receipt.commitment.heldIds) blockers.push(`suffix_held:${id}`);
	return blockers;
}

/**
 * Open a native session. A fresh transcript is created exclusive; an existing one is
 * taken over only from an exact resolved checkpoint, never from a guessed tail.
 */
export async function openNativeSession(input: NativeOpenInput): Promise<NativeOpenOutcome> {
	if (!input.file) {
		return mapOpenOutcome(
			await createEmbeddedAgentSession({
				...input.options,
				storage: input.storage,
				native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
			}),
		);
	}
	const resolution = resolveEmbeddedResumeCheckpoint(input.file);
	if (resolution.kind === "error") return { kind: "refused", reason: resolution.reason };
	const { checkpoint } = resolution;
	// A legacy multi-branch tail has no recorded cursor, so continuing from it would be a
	// guess. The SDK reports that as `selector`; anything ambiguous is surfaced, not resolved here.
	const opened = await createEmbeddedAgentSession({
		...input.options,
		storage: { ...input.storage, ...(input.file ? { file: input.file } : {}) },
		native: {
			expected: { snapshotDigest: checkpoint.snapshotDigest, resolved: checkpoint },
			// The policy must carry the same evidence it was admitted with, or the SDK
			// treats the snapshot as stale before any effect.
			ownerPolicy: {
				kind: "exclusive_native",
				expected: { snapshotDigest: checkpoint.snapshotDigest, resolved: checkpoint },
			},
			...(input.selection ? { selection: { ...input.selection, op: crypto.randomUUID() } } : {}),
		},
	});
	return mapOpenOutcome(opened);
}
