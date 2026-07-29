import type { RunResourceEntry, RunResourceLedger, RunSettlementProof } from "./types";

const MAX_TOMBSTONE_ENTRIES = 256;

type RunLifecycle = "open" | "sealed" | "quarantined";

interface TrackedResource {
	entry: RunResourceEntry;
}

interface RunState {
	lifecycle: RunLifecycle;
	resources: Map<string, TrackedResource>;
	/** Bounded public snapshot retained after quarantine. */
	tombstone: RunResourceEntry[];
	waiters: Set<SettlementWaiter>;
}

interface SettlementWaiter {
	resolve: (proof: RunSettlementProof) => void;
	timer: NodeJS.Timeout;
}

function copyEntries(entries: readonly RunResourceEntry[]): RunResourceEntry[] {
	return entries.map(entry => ({ ...entry }));
}

export function createRunResourceLedger(): RunResourceLedger {
	const runs = new Map<string, RunState>();
	let sequence = 0;

	const snapshot = (state: RunState): RunResourceEntry[] => {
		if (state.lifecycle === "quarantined") return copyEntries(state.tombstone);
		return [...state.resources.values()].map(resource => ({ ...resource.entry }));
	};

	const settlementProof = (state: RunState): RunSettlementProof | undefined => {
		if (state.lifecycle === "quarantined") {
			return { status: "unfenced", pending: copyEntries(state.tombstone) };
		}
		if (state.lifecycle === "sealed" && state.resources.size === 0) {
			return { status: "settled" };
		}
		return undefined;
	};

	const removeWaiter = (state: RunState, waiter: SettlementWaiter): void => {
		clearTimeout(waiter.timer);
		state.waiters.delete(waiter);
	};

	const notify = (state: RunState): void => {
		const proof = settlementProof(state);
		if (!proof) return;
		for (const waiter of state.waiters) {
			removeWaiter(state, waiter);
			waiter.resolve(
				proof.status === "unfenced"
					? { status: "unfenced", pending: copyEntries(proof.pending) }
					: { status: "settled" },
			);
		}
	};

	const settleTracked = (state: RunState, id: string): void => {
		if (!state.resources.delete(id)) return;
		notify(state);
	};

	const observeSettlement = (settled: PromiseLike<unknown>, onSettled: () => void): void => {
		// Assimilate the settlement promise once and consume both outcomes so a
		// rejected resource cannot become an unhandled rejection.
		let promise: Promise<unknown>;
		try {
			promise = Promise.resolve(settled);
		} catch {
			onSettled();
			return;
		}
		void promise.then(onSettled, onSettled);
	};

	const appendTombstone = (state: RunState, entry: RunResourceEntry): void => {
		state.tombstone.push({ ...entry });
		if (state.tombstone.length > MAX_TOMBSTONE_ENTRIES) {
			state.tombstone.splice(0, state.tombstone.length - MAX_TOMBSTONE_ENTRIES);
		}
	};

	const quarantineState = (state: RunState): RunResourceEntry[] => {
		if (state.lifecycle !== "quarantined") {
			state.lifecycle = "quarantined";
			state.tombstone = [];
			for (const resource of state.resources.values()) appendTombstone(state, resource.entry);
			state.resources.clear();
		}
		notify(state);
		return copyEntries(state.tombstone);
	};

	return {
		open(resourceRunId) {
			const existing = runs.get(resourceRunId);
			if (existing) return;
			runs.set(resourceRunId, {
				lifecycle: "open",
				resources: new Map<string, TrackedResource>(),
				tombstone: [],
				waiters: new Set<SettlementWaiter>(),
			});
		},

		track(resourceRunId, kind, label, settled) {
			let state = runs.get(resourceRunId);
			if (!state) {
				// Keep track() usable for low-level callers while making the lifecycle
				// explicit for settlement: an implicitly-created run is still open and
				// therefore cannot settle until seal() is called.
				state = {
					lifecycle: "open",
					resources: new Map<string, TrackedResource>(),
					tombstone: [],
					waiters: new Set<SettlementWaiter>(),
				};
				runs.set(resourceRunId, state);
			}

			const id = `${++sequence}`;
			const entry: RunResourceEntry = { id, kind, label, registeredAt: Date.now() };

			if (state.lifecycle === "quarantined") {
				// Quarantine is terminal: late work is retained only in the bounded
				// tombstone and never re-enters normal settlement accounting.
				appendTombstone(state, entry);
				observeSettlement(settled, () => {});
				return;
			}

			if (state.lifecycle === "sealed") {
				// Sealing only freezes admission of *new* work; it does not mean the run's
				// resources have all been registered yet. `agent_end` is published before
				// seal(), and its handlers register their own post-prompt work while the
				// event is still draining, so this late registration is the normal
				// lifecycle rather than an escaped resource. Admit it into ordinary
				// settlement accounting so the run stays unsettled until it completes;
				// quarantining here would make every cancel unfenced forever.
				state.resources.set(id, { entry });
				observeSettlement(settled, () => settleTracked(state!, id));
				return;
			}

			state.resources.set(id, { entry });
			observeSettlement(settled, () => settleTracked(state!, id));
		},

		pending(resourceRunId) {
			const state = runs.get(resourceRunId);
			return state ? snapshot(state) : [];
		},

		seal(resourceRunId) {
			const state = runs.get(resourceRunId);
			if (state?.lifecycle !== "open") return;
			state.lifecycle = "sealed";
			notify(state);
		},

		waitForSettlement(resourceRunId, { graceMs }) {
			const state = runs.get(resourceRunId);
			if (!state) {
				return Promise.resolve({ status: "unfenced", pending: [] });
			}

			const immediate = settlementProof(state);
			if (immediate) return Promise.resolve(immediate);

			const { promise, resolve } = Promise.withResolvers<RunSettlementProof>();
			let waiter!: SettlementWaiter;
			waiter = {
				resolve,
				timer: setTimeout(
					() => {
						state.waiters.delete(waiter);
						const settled = settlementProof(state);
						resolve(
							settled ?? {
								status: "unfenced",
								pending: snapshot(state),
							},
						);
					},
					Math.max(0, graceMs),
				),
			};
			state.waiters.add(waiter);
			return promise;
		},

		quarantine(resourceRunId) {
			let state = runs.get(resourceRunId);
			if (!state) {
				state = {
					lifecycle: "quarantined",
					resources: new Map<string, TrackedResource>(),
					tombstone: [],
					waiters: new Set<SettlementWaiter>(),
				};
				runs.set(resourceRunId, state);
			}
			return quarantineState(state);
		},
	};
}
