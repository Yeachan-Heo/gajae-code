import { describe, expect, test } from "bun:test";
import { createRunResourceLedger } from "../src/run-resource-ledger";

describe("run resource ledger", () => {
	test("keeps tracked resources pending until they settle", async () => {
		const ledger = createRunResourceLedger();
		const resource = Promise.withResolvers<void>();
		ledger.track("run", "tool", "pending tool", resource.promise);

		expect(ledger.pending("run")).toMatchObject([{ kind: "tool", label: "pending tool" }]);
		resource.resolve();
		await Promise.resolve();
		expect(ledger.pending("run")).toEqual([]);
	});

	test("waits for every tracked resource, including rejected resources", async () => {
		const ledger = createRunResourceLedger();
		const resolved = Promise.withResolvers<void>();
		const rejected = Promise.withResolvers<void>();
		ledger.track("run", "provider_factory", "factory", resolved.promise);
		ledger.track("run", "provider_iterator", "iterator", rejected.promise);
		const settled = ledger.waitForSettlement("run", { graceMs: 25 });

		resolved.resolve();
		rejected.reject(new Error("iterator failed"));
		expect(await settled).toEqual({ status: "settled" });
		expect(ledger.pending("run")).toEqual([]);
	});

	test("reports an unfenced entry after the grace period", async () => {
		const ledger = createRunResourceLedger();
		const never = Promise.withResolvers<void>();
		ledger.track("run", "post_prompt", "background cleanup", never.promise);

		expect(await ledger.waitForSettlement("run", { graceMs: 5 })).toMatchObject({
			status: "unfenced",
			pending: [{ kind: "post_prompt", label: "background cleanup" }],
		});
	});

	test("quarantines entries permanently after detaching a run", async () => {
		const ledger = createRunResourceLedger();
		const resource = Promise.withResolvers<void>();
		ledger.track("run", "tool", "late tool", resource.promise);

		expect(ledger.quarantine("run")).toMatchObject([{ kind: "tool", label: "late tool" }]);
		expect(ledger.pending("run")).toEqual([]);
		resource.resolve();
		await Promise.resolve();
		expect(ledger.pending("run")).toEqual([]);
	});

	test("isolates entries and settlement waiters by resource run id", async () => {
		const ledger = createRunResourceLedger();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		ledger.track("first", "tool", "first tool", first.promise);
		ledger.track("second", "tool", "second tool", second.promise);
		const firstSettled = ledger.waitForSettlement("first", { graceMs: 25 });

		first.resolve();
		expect(await firstSettled).toEqual({ status: "settled" });
		expect(ledger.pending("second")).toMatchObject([{ label: "second tool" }]);
		second.resolve();
		await Promise.resolve();
		expect(ledger.pending("second")).toEqual([]);
	});
});

test("a lease that also covers a hanging trailing result stays unfenced", async () => {
	const ledger = createRunResourceLedger();
	const iteratorSettled = Promise.resolve();
	const { promise: hangingResult } = Promise.withResolvers<void>();
	// Mirrors the agent loop: the provider lease spans the iterator AND `response.result()`.
	ledger.track(
		"run-hang",
		"provider_iterator",
		"provider/model",
		iteratorSettled.then(() => hangingResult),
	);
	const proof = await ledger.waitForSettlement("run-hang", { graceMs: 20 });
	expect(proof.status).toBe("unfenced");
	if (proof.status === "unfenced") expect(proof.pending.map(entry => entry.kind)).toEqual(["provider_iterator"]);
});

test("real settlement wakes a waiter well before the grace timer", async () => {
	const ledger = createRunResourceLedger();
	const { promise: work, resolve: finish } = Promise.withResolvers<void>();
	ledger.track("run-early", "tool", "slow-tool", work);
	const started = Date.now();
	const settlement = ledger.waitForSettlement("run-early", { graceMs: 5_000 });
	finish();
	expect(await settlement).toEqual({ status: "settled" });
	expect(Date.now() - started).toBeLessThan(1_000);
});
