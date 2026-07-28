import type { RunResourceEntry, RunResourceLedger, RunSettlementProof } from "./types";

interface TrackedResource {
	entry: RunResourceEntry;
	/** Current owning key; quarantine rebinds it so real settlement still releases the entry. */
	runKey: string;
}

export function createRunResourceLedger(): RunResourceLedger {
	const runs = new Map<string, Map<string, TrackedResource>>();
	const waiters = new Map<string, Set<() => void>>();
	let sequence = 0;

	const notifySettled = (resourceRunId: string): void => {
		// The run map is deleted once empty, so an absent map also means settled; keying
		// only on `size === 0` would leave waiters asleep until their grace timer fired.
		if ((runs.get(resourceRunId)?.size ?? 0) !== 0) return;
		for (const resolve of waiters.get(resourceRunId) ?? []) resolve();
		waiters.delete(resourceRunId);
	};

	const remove = (resourceRunId: string, id: string): void => {
		// Quarantine moves entries to a private key, so resolve the entry's current owner
		// instead of trusting the key captured when the resource was tracked.
		let ownerKey = resourceRunId;
		let resources = runs.get(ownerKey);
		if (!resources?.has(id)) {
			ownerKey = "";
			for (const [key, candidate] of runs)
				if (candidate.get(id)?.runKey === key) {
					ownerKey = key;
					resources = candidate;
					break;
				}
			if (!ownerKey) return;
		}
		if (!resources?.delete(id)) return;
		if (resources.size === 0) {
			runs.delete(ownerKey);
			notifySettled(ownerKey);
		}
	};

	return {
		track(resourceRunId, kind, label, settled) {
			const id = `${++sequence}`;
			const resources = runs.get(resourceRunId) ?? new Map<string, TrackedResource>();
			runs.set(resourceRunId, resources);
			resources.set(id, { entry: { id, kind, label, registeredAt: Date.now() }, runKey: resourceRunId });
			Promise.resolve(settled).then(
				() => remove(resourceRunId, id),
				() => remove(resourceRunId, id),
			);
		},
		pending(resourceRunId) {
			return [...(runs.get(resourceRunId)?.values() ?? [])].map(resource => resource.entry);
		},
		waitForSettlement(resourceRunId, { graceMs }) {
			if (runs.get(resourceRunId)?.size === undefined) {
				return Promise.resolve({ status: "settled" });
			}
			const { promise, resolve } = Promise.withResolvers<RunSettlementProof>();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (): void => {
				clearTimeout(timer);
				waiters.get(resourceRunId)?.delete(onSettled);
				resolve({ status: "settled" });
			};
			const onSettled = (): void => settle();
			const resourceWaiters = waiters.get(resourceRunId) ?? new Set<() => void>();
			resourceWaiters.add(onSettled);
			waiters.set(resourceRunId, resourceWaiters);
			timer = setTimeout(
				() => {
					resourceWaiters.delete(onSettled);
					if (resourceWaiters.size === 0) waiters.delete(resourceRunId);
					const pending = this.pending(resourceRunId);
					resolve(pending.length === 0 ? { status: "settled" } : { status: "unfenced", pending });
				},
				Math.max(0, graceMs),
			);
			return promise;
		},
		quarantine(resourceRunId) {
			const resources = runs.get(resourceRunId);
			if (!resources) return [];
			// Quarantine detaches the run from settlement accounting, but the entries stay
			// tracked under a private key so their real promises still release them and can
			// never re-enter the original run.
			const quarantineKey = `quarantined:${resourceRunId}:${++sequence}`;
			runs.delete(resourceRunId);
			runs.set(quarantineKey, resources);
			for (const resource of resources.values()) resource.runKey = quarantineKey;
			return [...resources.values()].map(resource => resource.entry);
		},
	};
}
