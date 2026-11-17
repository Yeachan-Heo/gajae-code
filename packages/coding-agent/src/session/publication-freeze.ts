import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { FileEntry } from "./session-manager";

export interface PublicationGeneration {
	readonly fileEntriesIndex: number;
	readonly entryRevision: number;
}

export interface PublicationPreparedEntry {
	readonly entry: FileEntry;
	/** Exact publication JSON, without the record-delimiting newline. */
	readonly json: string;
	readonly sha256: string;
}

export interface PublicationDebtSnapshot {
	readonly generation: PublicationGeneration;
	readonly entries: readonly FileEntry[];
	/** Prepared using a memory-only blob store: hashes/references, never durable blob effects. */
	readonly preparedEntries: readonly PublicationPreparedEntry[];
	readonly rewriteDebt: boolean;
	readonly heldIds: readonly string[];
	readonly heldReason?: "freeze_parked" | "persist_debt" | "rewrite_debt";
	readonly persistError?: Error;
}

export interface PublicationFreezeHandle {
	readonly freezeId: string;
	drain(): Promise<void>;
	debt(): PublicationDebtSnapshot;
	thaw(): Promise<void>;
	runRecovery<T>(body: () => Promise<T>): Promise<T>;
}

type Ticket = { active: boolean };
type Execution = {
	ticket?: Ticket;
	recovery?: Freeze;
	dispatched?: boolean;
	terminal?: boolean;
	lease?: { dispatched: boolean };
	active: boolean;
};

/** Internal control flow only; a lease must be released before publication can park. */
export class PublicationLeaseParkedError extends Error {
	constructor() {
		super("publication_lease_parked");
	}
}
type Held = { id?: string; run: () => Promise<void> };
type Parked = { resume: () => void; reject: (error: Error) => void };
type Freeze = {
	owner: symbol;
	lifecycle: string;
	handle: PublicationFreezeHandle;
	ready: PromiseWithResolvers<void>;
	released: PromiseWithResolvers<void>;
	phase: "freezing" | "frozen" | "thawing";
	recovery: number;
};

/** Manager-local admission, preparation and publication are deliberately separate lifetimes. */
export class PublicationBarrier {
	readonly #execution = new AsyncLocalStorage<Execution>();
	readonly #lifecycle: () => string;
	readonly #snapshot: (heldIds: readonly string[], holding: boolean) => PublicationDebtSnapshot;
	#freeze: Freeze | undefined;
	#preparations = 0;
	#dispatched = 0;
	#queued = 0;
	#activityVersion = 0;
	#activity = Promise.withResolvers<void>();
	#held: Held[] = [];
	#parked: Parked[] = [];
	#closing = false;
	#thawing: Promise<void> | undefined;

	constructor(
		lifecycle: () => string,
		snapshot: (heldIds: readonly string[], holding: boolean) => PublicationDebtSnapshot,
	) {
		this.#lifecycle = lifecycle;
		this.#snapshot = snapshot;
	}

	get terminal(): boolean {
		const execution = this.#execution.getStore();
		return execution?.active === true && execution.terminal === true;
	}

	get inDispatchedLease(): boolean {
		const execution = this.#execution.getStore();
		return execution?.active === true && execution.lease?.dispatched === true;
	}

	get active(): boolean {
		return this.#freeze !== undefined;
	}

	get blocked(): boolean {
		return this.#freeze !== undefined && !this.#bypasses();
	}

	#bypasses(): boolean {
		const execution = this.#execution.getStore();
		return (
			execution?.active === true &&
			(execution.dispatched === true ||
				execution.lease?.dispatched === true ||
				execution.terminal === true ||
				(execution.recovery === this.#freeze &&
					execution.recovery?.phase === "frozen" &&
					execution.recovery.lifecycle === this.#lifecycle()))
		);
	}

	#finish(ticket: Ticket | undefined): void {
		if (!ticket?.active) return;
		ticket.active = false;
		this.#preparations--;
		this.#checkReady();
	}

	#checkReady(): void {
		const freeze = this.#freeze;
		if (freeze?.phase === "freezing" && this.#preparations === 0 && this.#dispatched === 0) {
			freeze.lifecycle = this.#lifecycle();
			freeze.phase = "frozen";
			freeze.ready.resolve();
		}
	}

	/** Admission happens synchronously, before the body's first await or snapshot. */
	prepare<T>(body: () => Promise<T>): Promise<T> {
		const inherited = this.#execution.getStore();
		if (inherited?.active && (inherited.ticket?.active || this.#bypasses())) return body();
		if (this.#closing && !this.terminal) return Promise.reject(new Error("Session manager is closing."));
		if (this.#freeze || this.#thawing) {
			const admitted = Promise.withResolvers<void>();
			this.#parked.push({ resume: admitted.resolve, reject: admitted.reject });
			return admitted.promise.then(() => this.prepare(body));
		}
		const ticket: Ticket = { active: true };
		const execution: Execution = { ticket, active: true, lease: inherited?.active ? inherited.lease : undefined };
		this.#preparations++;
		return this.#execution.run(execution, async () => {
			try {
				return await body();
			} finally {
				this.#finish(ticket);
				execution.active = false;
			}
		});
	}

	/** A suspended preparation cannot pin a predecessor that itself awaits thaw. */
	async waitPreparation<T>(pending: Promise<T>): Promise<T> {
		const execution = this.#execution.getStore();
		if (this.#bypasses()) return pending;
		this.#finish(execution?.ticket);
		const value = await pending;
		if (execution?.active && execution.ticket && !this.#bypasses()) {
			await this.prepare(async () => {
				if (!execution.ticket!.active) {
					execution.ticket!.active = true;
					this.#preparations++;
				}
			});
		}
		return value;
	}

	/** Previously enqueued work is held publication, not a newly parked caller. */
	queued<T>(body: () => Promise<T>): Promise<T> {
		if (this.blocked) return this.publish(body);
		if (this.#closing) return this.runTerminal(body);
		return this.prepare(body);
	}

	#notifyActivity(): void {
		this.#activityVersion++;
		if (!this.#freeze && !this.#thawing) return;
		const activity = this.#activity;
		this.#activity = Promise.withResolvers<void>();
		activity.resolve();
	}

	/** Thaw joins registered queue successors; freeze readiness deliberately does not. */
	registerQueued(): () => void {
		this.#queued++;
		this.#notifyActivity();
		return () => {
			this.#queued--;
			this.#notifyActivity();
		};
	}

	/** Queue registration is settlement, not dispatched I/O or a held completion. */
	finishPreparation(): void {
		this.#finish(this.#execution.getStore()?.ticket);
	}

	/** End preparation BEFORE awaiting held publication; freeze never joins held completion. */
	publish<T>(body: () => Promise<T>, id?: string): Promise<T> {
		if (this.#bypasses()) return body();
		const execution = this.#execution.getStore();
		if (execution?.active && execution.lease) {
			if (this.blocked) throw new PublicationLeaseParkedError();
			execution.lease.dispatched = true;
		}
		this.#finish(execution?.ticket);
		if (this.#freeze || this.#thawing) {
			const completion = Promise.withResolvers<T>();
			this.#held.push({
				id,
				run: async () => {
					try {
						completion.resolve(await this.#dispatch(body));
					} catch (error) {
						completion.reject(error);
						throw error;
					}
				},
			});
			this.#notifyActivity();
			return completion.promise;
		}
		return this.#dispatch(body);
	}

	#dispatch<T>(body: () => Promise<T>): Promise<T> {
		this.#dispatched++;
		const execution: Execution = { active: true, dispatched: true, terminal: this.#closing };
		return this.#execution.run(execution, async () => {
			try {
				return await body();
			} finally {
				execution.active = false;
				this.#dispatched--;
				this.#checkReady();
			}
		});
	}

	/** Refuse before mutation instead of parking inside another owner's lease. */
	checkLease(): void {
		if (this.blocked) throw new PublicationLeaseParkedError();
	}

	/** The following non-yielding mutation is the lease's actual publication dispatch. */
	dispatchLease(): void {
		this.checkLease();
		const execution = this.#execution.getStore();
		if (execution?.active && execution.lease) execution.lease.dispatched = true;
	}

	lease<T>(body: () => Promise<T>): Promise<T> {
		return this.prepare(async () => {
			const parent = this.#execution.getStore()!;
			for (;;) {
				const execution: Execution = {
					ticket: parent.ticket,
					recovery: parent.recovery,
					dispatched: parent.dispatched,
					terminal: parent.terminal,
					lease: { dispatched: false },
					active: true,
				};
				try {
					return await this.io(() => this.#execution.run(execution, body));
				} catch (error) {
					if (!(error instanceof PublicationLeaseParkedError)) throw error;
					execution.active = false;
					// body has returned through the transaction's release/uncertainty handling.
					await this.#execution.run(parent, () => this.publish(async () => {}));
					await this.#execution.run(parent, () => this.prepare(async () => {}));
				} finally {
					execution.active = false;
				}
			}
		});
	}

	/** Descriptor cleanup is drainable I/O, not permission to publish a later snapshot. */
	async io<T>(body: () => Promise<T>): Promise<T> {
		this.#dispatched++;
		try {
			return await body();
		} finally {
			this.#dispatched--;
			this.#checkReady();
		}
	}

	/** A synchronous caller retains its entry and order without pretending publication succeeded. */
	holdSync(body: () => void, id?: string): boolean {
		// Held dispatches carry terminal authority; new callers must never join their drain.
		if (this.#closing && !this.terminal) throw new Error("Session manager is closing.");
		if (!this.blocked && !this.#thawing) return false;
		if (this.#bypasses()) return false;
		this.#held.push({ id, run: () => this.#dispatch(async () => body()) });
		this.#notifyActivity();
		return true;
	}

	quiesce(owner: symbol): Promise<PublicationFreezeHandle> {
		if (this.#closing) return Promise.reject(new Error("Session manager is closing."));
		if (this.#freeze || this.#thawing) return Promise.reject(new Error("publication_freeze_already_owned"));
		const ready = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const lifecycle = this.#lifecycle();
		const assertOwned = (): Freeze => {
			if (this.#freeze !== freeze) throw new Error("publication_freeze_stale_handle");
			return freeze;
		};
		const assertCurrent = (): Freeze => {
			assertOwned();
			if (this.#lifecycle() !== freeze.lifecycle) throw new Error("publication_freeze_stale_handle");
			return freeze;
		};
		const handle: PublicationFreezeHandle = Object.freeze({
			freezeId: `publication-freeze-${randomUUID()}`,
			drain: async () => {
				assertCurrent();
				await ready.promise;
				assertCurrent();
			},
			debt: () => {
				assertCurrent();
				return this.#snapshot(
					this.#held.flatMap(request => (request.id === undefined ? [] : [request.id])),
					true,
				);
			},
			// Invalidating publication must not strand cleanup of this exact owned freeze.
			thaw: async () => this.#thaw(assertOwned()),
			runRecovery: async <T>(body: () => Promise<T>): Promise<T> => {
				assertCurrent();
				await ready.promise;
				assertCurrent();
				if (freeze.phase !== "frozen" || this.#closing) throw new Error("publication_recovery_not_live");
				freeze.recovery++;
				const execution: Execution = { recovery: freeze, active: true };
				try {
					return await this.#execution.run(execution, body);
				} finally {
					execution.active = false;
					freeze.recovery--;
				}
			},
		});
		const freeze: Freeze = { owner, lifecycle, handle, ready, released, phase: "freezing", recovery: 0 };
		this.#freeze = freeze;
		this.#checkReady();
		return ready.promise.then(() => handle);
	}

	async #thaw(freeze: Freeze): Promise<void> {
		await freeze.ready.promise;
		if (freeze.recovery > 0) throw new Error("publication_recovery_in_flight");
		if (freeze.phase === "thawing") return this.#thawing;
		freeze.phase = "thawing";
		const thawing = this.#completeThaw(freeze);
		this.#thawing = thawing;
		return thawing;
	}

	async #completeThaw(freeze: Freeze): Promise<void> {
		try {
			let drainedVersion: number;
			do {
				drainedVersion = await this.#drainHeld(freeze);
			} while (
				this.#lifecycle() === freeze.lifecycle &&
				(drainedVersion !== this.#activityVersion || this.#queued > 0)
			);
		} finally {
			this.#freeze = undefined;
			this.#thawing = undefined;
			freeze.released.resolve();
			const parked = this.#parked.splice(0);
			for (const request of parked) {
				if (this.#closing) request.reject(new Error("Session manager is closing."));
				else request.resume();
			}
		}
	}

	async #drainHeld(freeze: Freeze): Promise<number> {
		// Invalidated lifecycles and failed requests retain debt, never stale publication authority.
		let index = 0;
		while (this.#lifecycle() === freeze.lifecycle && (index < this.#held.length || this.#queued > 0)) {
			if (index === this.#held.length) {
				await this.#activity.promise;
				continue;
			}
			const request = this.#held[index]!;
			try {
				await request.run();
				this.#held.splice(index, 1);
			} catch {
				// Settle later waiters too; their persistence latch prevents publication.
				index++;
			}
		}
		return this.#activityVersion;
	}

	beginClose(): void {
		this.#closing = true;
		for (const request of this.#parked.splice(0)) request.reject(new Error("Session manager is closing."));
	}

	async joinClose(): Promise<void> {
		const freeze = this.#freeze;
		if (freeze) {
			await freeze.ready.promise;
			await freeze.released.promise;
		}
	}

	runTerminal<T>(body: () => Promise<T>): Promise<T> {
		const execution: Execution = { terminal: true, active: true };
		return this.#execution.run(execution, async () => {
			try {
				return await body();
			} finally {
				execution.active = false;
			}
		});
	}
}
