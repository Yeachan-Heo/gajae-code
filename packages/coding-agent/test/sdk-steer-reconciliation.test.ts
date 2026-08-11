import { describe, expect, test } from "bun:test";
import { createKindAwareReconciliation } from "../src/sdk/bus/kind-aware-reconciliation";
import {
	PROMPT_RECONCILIATION_TERMINAL_CAPACITY,
	PROMPT_RECONCILIATION_TERMINAL_TTL_MS,
} from "../src/sdk/bus/prompt-reconciliation";
import {
	type DurableReconciliationRecord,
	type ReconciliationStore,
	settleProcessRestart,
} from "../src/sdk/bus/reconciliation-store";

class MemoryStore implements ReconciliationStore {
	readonly path = null;
	readonly sessionId = "steer-session";
	#records: DurableReconciliationRecord[] = [];
	async transact(mutator: (records: DurableReconciliationRecord[]) => DurableReconciliationRecord[]): Promise<void> {
		this.#records = mutator(this.snapshot());
	}
	async load(): Promise<DurableReconciliationRecord[]> {
		return this.snapshot();
	}
	snapshot(): DurableReconciliationRecord[] {
		return this.#records.map(record => ({ ...record }));
	}
	async delete(): Promise<void> {
		this.#records = [];
	}
}

describe("SDK steer reconciliation", () => {
	test("reserves digest without storing steer text and replays settled result", async () => {
		const store = new MemoryStore();
		const reconciliation = createKindAwareReconciliation({ store, now: () => 10 });
		const first = await reconciliation.reserveSteer("logical-1", "secret steer body");
		expect(first.replay).toBe(false);
		expect(JSON.stringify(store.snapshot())).not.toContain("secret steer body");
		expect(store.snapshot()[0]).toMatchObject({ kind: "steer", clientRef: "logical-1", status: "dispatching" });
		expect((store.snapshot()[0] as { textDigest: string }).textDigest).toMatch(/^[0-9a-f]{64}$/);
		await reconciliation.settleSteer("logical-1", "accepted");
		const replay = await reconciliation.reserveSteer("logical-1", "secret steer body");
		expect(replay).toMatchObject({
			replay: true,
			result: { clientRef: "logical-1", status: "accepted", acceptedAt: 10 },
		});
		expect(replay.result).toMatchObject({ commandId: expect.any(String), turnId: expect.any(String) });
	});

	test("same reference with another digest conflicts", async () => {
		const reconciliation = createKindAwareReconciliation({ store: new MemoryStore() });
		await reconciliation.reserveSteer("logical-1", "first");
		await expect(reconciliation.reserveSteer("logical-1", "second")).rejects.toMatchObject({
			code: "client_ref_conflict",
		});
	});

	test("dispatching projects uncertain and restart never redispatches", async () => {
		const store = new MemoryStore();
		const writer = createKindAwareReconciliation({ store, now: () => 10 });
		await writer.reserveSteer("logical-1", "body");
		await store.transact(records => settleProcessRestart(records, 20));
		const reader = createKindAwareReconciliation({ store, now: () => 20 });
		await reader.hydrateFromStore();
		expect(reader.lookupSteer("logical-1")).toMatchObject({
			status: "uncertain",
			error: { code: "process_restart_uncertain" },
		});
		expect(reader.lookupSteer("missing")).toEqual({ clientRef: "missing", status: "unknown" });
	});

	test("retains live dispatching records while expiring and capacity-bounding settled steers", async () => {
		let now = 0;
		const reconciliation = createKindAwareReconciliation({ store: new MemoryStore(), now: () => now });
		await reconciliation.reserveSteer("live", "body");
		for (let index = 0; index <= PROMPT_RECONCILIATION_TERMINAL_CAPACITY; index++) {
			await reconciliation.reserveSteer(`settled-${index}`, `body-${index}`);
			await reconciliation.settleSteer(`settled-${index}`, "accepted");
			now++;
		}
		expect(reconciliation.lookupSteer("live")).toMatchObject({ status: "uncertain" });
		expect(reconciliation.lookupSteer("settled-0")).toMatchObject({ status: "unknown" });
		now += PROMPT_RECONCILIATION_TERMINAL_TTL_MS;
		await reconciliation.reserveSteer("new", "body-new");
		expect(reconciliation.lookupSteer("live")).toMatchObject({ status: "uncertain" });
		expect(reconciliation.lookupSteer(`settled-${PROMPT_RECONCILIATION_TERMINAL_CAPACITY}`)).toMatchObject({
			status: "unknown",
		});
	});
});
