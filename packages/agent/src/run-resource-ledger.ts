import type {
	ClaimProducerResult,
	ForkProducerResult,
	ReserveProducerResult,
	RunCancellationDomain,
	RunCancellationDomainBridge,
	RunResourceEntry,
	RunResourceKind,
	RunResourceLedger,
	RunResourceProducerLease,
	RunSettlementProof,
} from "./types";

const MAX_TOMBSTONE_ENTRIES = 256;
type RunLifecycle = "open" | "sealed" | "quarantined";

interface TrackedResource {
	entry: RunResourceEntry;
}

interface RunState {
	lifecycle: RunLifecycle;
	resourceRunId: string;
	domain: RunCancellationDomain | undefined;
	domainBridge: RunCancellationDomainBridge;
	resources: Map<string, TrackedResource>;
	tombstone: RunResourceEntry[];
	waiters: Set<SettlementWaiter>;
	claimedOwners: Set<object>;
	released: boolean;
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
	const standaloneDomains = new Map<string, { domain: RunCancellationDomain; controller: AbortController }>();
	const standaloneReleased = new Set<string>();
	const standaloneQuarantined = new Set<string>();
	let bridge: RunCancellationDomainBridge | undefined;
	let agentSessionClaimKey: object | undefined;
	let sequence = 0;

	const standaloneBridge: RunCancellationDomainBridge = {
		open(resourceRunId) {
			if (standaloneQuarantined.has(resourceRunId)) return { ok: false, reason: "quarantined" };
			const existing = standaloneDomains.get(resourceRunId);
			if (existing) return { ok: true, domain: existing.domain, created: false };
			if (standaloneReleased.has(resourceRunId)) return { ok: false, reason: "duplicate_identity" };
			const controller = new AbortController();
			const domain: RunCancellationDomain = { resourceRunId, signal: controller.signal };
			standaloneDomains.set(resourceRunId, { domain, controller });
			return { ok: true, domain, created: true };
		},
		lookup(resourceRunId) {
			return standaloneDomains.get(resourceRunId)?.domain;
		},
		abort(resourceRunId, reason) {
			const record = standaloneDomains.get(resourceRunId);
			if (!record)
				return { ok: false, reason: standaloneQuarantined.has(resourceRunId) ? "quarantined" : "unknown_run" };
			const newlyAborted = !record.controller.signal.aborted;
			if (newlyAborted) record.controller.abort(reason);
			return { ok: true, newlyAborted };
		},
		release(resourceRunId, disposition) {
			const record = standaloneDomains.get(resourceRunId);
			if (!record) return;
			if (disposition === "quarantined") {
				standaloneQuarantined.add(resourceRunId);
				if (!record.controller.signal.aborted) record.controller.abort();
			}
			standaloneDomains.delete(resourceRunId);
			standaloneReleased.add(resourceRunId);
		},
	};

	const snapshot = (state: RunState): RunResourceEntry[] =>
		state.lifecycle === "quarantined"
			? copyEntries(state.tombstone)
			: [...state.resources.values()].map(resource => ({ ...resource.entry }));

	const settlementProof = (state: RunState): RunSettlementProof | undefined => {
		if (state.lifecycle === "quarantined")
			return { status: "unfenced", reason: "quarantined", pending: copyEntries(state.tombstone) };
		if (state.lifecycle === "sealed" && state.resources.size === 0) return { status: "settled" };
		return undefined;
	};

	const releaseIfSettled = (state: RunState): void => {
		if (state.released || state.lifecycle !== "sealed" || state.resources.size !== 0 || !state.domain) return;
		state.released = true;
		state.domainBridge.release(state.resourceRunId, "settled");
		state.domain = undefined;
	};

	const notify = (state: RunState): void => {
		const proof = settlementProof(state);
		if (proof) {
			for (const waiter of [...state.waiters]) {
				clearTimeout(waiter.timer);
				state.waiters.delete(waiter);
				waiter.resolve(
					proof.status === "settled"
						? proof
						: { status: "unfenced", reason: proof.reason, pending: copyEntries(proof.pending) },
				);
			}
		}
		releaseIfSettled(state);
	};

	const appendTombstone = (state: RunState, entry: RunResourceEntry): void => {
		state.tombstone.push({ ...entry });
		if (state.tombstone.length > MAX_TOMBSTONE_ENTRIES)
			state.tombstone.splice(0, state.tombstone.length - MAX_TOMBSTONE_ENTRIES);
	};

	const observeSettlement = (settled: PromiseLike<unknown>, onSettled: () => void): void => {
		try {
			void Promise.resolve(settled).then(onSettled, onSettled);
		} catch {
			onSettled();
		}
	};

	const quarantineState = (state: RunState): RunResourceEntry[] => {
		if (state.lifecycle !== "quarantined") {
			state.lifecycle = "quarantined";
			state.tombstone = [];
			for (const resource of state.resources.values()) appendTombstone(state, resource.entry);
			state.resources.clear();
			if (state.domain) {
				state.domainBridge.abort(state.resourceRunId);
				if (!state.released) {
					state.released = true;
					state.domainBridge.release(state.resourceRunId, "quarantined");
				}
				state.domain = undefined;
			}
		}
		notify(state);
		return copyEntries(state.tombstone);
	};

	const register = (
		state: RunState,
		kind: RunResourceKind,
		label: string,
		settled: PromiseLike<unknown>,
	): string | undefined => {
		if (state.lifecycle === "quarantined") {
			const entry: RunResourceEntry = { id: `${++sequence}`, kind, label, registeredAt: Date.now() };
			appendTombstone(state, entry);
			observeSettlement(settled, () => {});
			return undefined;
		}
		// Sealing only freezes admission of genuinely *new* work through
		// reserveProducer()/claimProducer(); it does not mean the run's resources have
		// all been registered yet. `agent_end` is published before seal(), and its
		// handlers register their own post-prompt work while the event is still
		// draining, so this late registration is the normal lifecycle rather than an
		// escaped resource. Admit it into ordinary settlement accounting so the run
		// stays unsettled until it completes; quarantining here would make every
		// cancel unfenced forever.
		const entry: RunResourceEntry = { id: `${++sequence}`, kind, label, registeredAt: Date.now() };
		state.resources.set(entry.id, { entry });
		observeSettlement(settled, () => {
			state.resources.delete(entry.id);
			notify(state);
		});
		return entry.id;
	};

	const leaseFor = (state: RunState, kind: RunResourceKind, label: string): RunResourceProducerLease | undefined => {
		const domain = state.domain;
		if (!domain) return undefined;
		const completion = Promise.withResolvers<void>();
		if (!register(state, kind, label, completion.promise)) return undefined;
		let closed = false;
		const close = (): void => {
			if (closed) return;
			closed = true;
			completion.resolve();
		};
		const lease: RunResourceProducerLease = {
			resourceRunId: state.resourceRunId,
			domain,
			signal: domain.signal,
			track(childKind, childLabel, settled) {
				if (closed || state.lifecycle === "quarantined") {
					quarantineState(state);
					observeSettlement(settled, () => {});
					return false;
				}
				return register(state, childKind, childLabel, settled) !== undefined;
			},
			fork(expectedDomain, childKind, childLabel): ForkProducerResult {
				if (expectedDomain !== domain) {
					quarantineState(state);
					return { ok: false, reason: "domain_mismatch" };
				}
				const wasQuarantined = state.lifecycle === "quarantined";
				if (closed || wasQuarantined) {
					quarantineState(state);
					return { ok: false, reason: wasQuarantined ? "quarantined" : "parent_closed" };
				}
				const child = leaseFor(state, childKind, childLabel);
				return child ? { ok: true, lease: child } : { ok: false, reason: "quarantined" };
			},
			closeDiscovery: close,
		};
		return lease;
	};

	return {
		bindCancellationDomainBridge(nextBridge) {
			if (bridge && bridge !== nextBridge) throw new Error("Run cancellation domain bridge is already bound");
			bridge = nextBridge;
		},
		bindAgentSessionClaimKey(key) {
			if (agentSessionClaimKey && agentSessionClaimKey !== key) {
				throw new Error("AgentSession claim key is already bound");
			}
			agentSessionClaimKey = key;
		},
		open(resourceRunId) {
			const existing = runs.get(resourceRunId);
			if (existing) return existing.lifecycle === "open" ? existing.domain : undefined;
			const domainBridge = bridge ?? standaloneBridge;
			const opened = domainBridge.open(resourceRunId);
			if (!opened.ok) return undefined;
			const state: RunState = {
				lifecycle: "open",
				resourceRunId,
				domain: opened.domain,
				domainBridge,
				resources: new Map(),
				tombstone: [],
				waiters: new Set(),
				claimedOwners: new Set(),
				released: false,
			};
			runs.set(resourceRunId, state);
			return opened.domain;
		},
		lookupDomain(resourceRunId) {
			return runs.get(resourceRunId)?.domain;
		},
		reserveProducer(resourceRunId, expectedDomain, kind, label): ReserveProducerResult {
			const state = runs.get(resourceRunId);
			if (!state) return { ok: false, reason: "unknown_run" };
			if (state.lifecycle === "quarantined") return { ok: false, reason: "quarantined" };
			if (state.lifecycle !== "open") {
				quarantineState(state);
				return { ok: false, reason: "sealed" };
			}
			if (expectedDomain && expectedDomain !== state.domain) {
				quarantineState(state);
				return { ok: false, reason: "domain_mismatch" };
			}
			const lease = leaseFor(state, kind, label);
			return lease ? { ok: true, lease } : { ok: false, reason: "quarantined" };
		},
		claimProducer(resourceRunId, expectedDomain, ownerKey): ClaimProducerResult {
			if (!agentSessionClaimKey || ownerKey !== agentSessionClaimKey) {
				return { ok: false, reason: "closed" };
			}
			const state = runs.get(resourceRunId);
			if (!state) return { ok: false, reason: "handle_mismatch" };
			if (state.lifecycle === "quarantined") return { ok: false, reason: "quarantined" };
			if (state.lifecycle !== "open") {
				quarantineState(state);
				return { ok: false, reason: "closed" };
			}
			if (expectedDomain && expectedDomain !== state.domain) {
				quarantineState(state);
				return { ok: false, reason: "domain_mismatch" };
			}
			if (state.claimedOwners.has(ownerKey)) {
				quarantineState(state);
				return { ok: false, reason: "already_claimed" };
			}
			state.claimedOwners.add(ownerKey);
			const lease = leaseFor(state, "post_prompt", "agent-session");
			return lease ? { ok: true, lease } : { ok: false, reason: "quarantined" };
		},
		track(resourceRunId, kind, label, settled) {
			const state = runs.get(resourceRunId);
			if (!state) {
				observeSettlement(settled, () => {});
				return;
			}
			register(state, kind, label, settled);
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
			if (!state) return Promise.resolve({ status: "unfenced", reason: "unknown_run", pending: [] });
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
								reason: state.lifecycle === "open" ? "run_not_sealed" : "resources_pending",
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
			const state = runs.get(resourceRunId);
			return state ? quarantineState(state) : [];
		},
	};
}
