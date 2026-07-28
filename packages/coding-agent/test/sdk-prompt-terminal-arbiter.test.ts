import { describe, expect, test } from "bun:test";
import { createKindAwareReconciliation } from "../src/sdk/bus/kind-aware-reconciliation";
import {
	type DurableReconciliationRecord,
	type ReconciliationStore,
	settleProcessRestart,
} from "../src/sdk/bus/reconciliation-store";
import type { SdkPromptTerminalOutcome } from "../src/sdk/prompt-status";

class MemoryStore implements ReconciliationStore {
	readonly path = null;
	readonly sessionId = "test-session";
	#records: DurableReconciliationRecord[] = [];
	#failNext = false;
	#holdNext?: Promise<void>;
	#onHeld?: () => void;

	failNext(): void {
		this.#failNext = true;
	}

	holdNext(hold: Promise<void>, onHeld: () => void): void {
		this.#holdNext = hold;
		this.#onHeld = onHeld;
	}

	async transact(mutator: (records: DurableReconciliationRecord[]) => DurableReconciliationRecord[]): Promise<void> {
		const next = mutator(this.snapshot());
		if (this.#failNext) {
			this.#failNext = false;
			throw new Error("persist failed");
		}
		const hold = this.#holdNext;
		this.#holdNext = undefined;
		if (hold) {
			this.#onHeld?.();
			this.#onHeld = undefined;
			await hold;
		}
		this.#records = next;
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

const correlation = { commandId: "command", turnId: "turn" };
const stopped = (reason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled") =>
	({ kind: "stopped", reason, provenance: "agent" }) as const;
const failed = (code: "prompt_failed" | "prompt_deadline_exceeded") =>
	({ kind: "failed", code, message: `${code} message`, provenance: "agent_failed" }) as const;

async function accepted(store = new MemoryStore()) {
	const reconciliation = createKindAwareReconciliation({ store, now: () => 100 });
	await reconciliation.noteAccepted("prompt", correlation, "prompt-ref");
	return { reconciliation, store };
}

describe("SDK prompt terminal arbiter", () => {
	test("claims the first pending outcome without exposing it as terminal", async () => {
		const { reconciliation, store } = await accepted();
		const first = stopped("end_turn");

		expect(await reconciliation.claimPendingOutcome(correlation, first)).toEqual(first);
		expect(await reconciliation.claimPendingOutcome(correlation, stopped("cancelled"))).toEqual(first);
		expect(reconciliation.peekPendingOutcome(correlation)).toEqual(first);
		expect(reconciliation.lookup("prompt", correlation)).toMatchObject({ status: "accepted" });
		expect(reconciliation.lookup("prompt", correlation)).not.toHaveProperty("outcome");
		await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
		expect(reconciliation.lookup("prompt", correlation)).toMatchObject({ status: "in_flight" });
		expect(reconciliation.lookup("prompt", correlation)).not.toHaveProperty("outcome");
		expect(store.snapshot()).toMatchObject([{ pendingOutcome: first }]);
	});

	test("finalizes the durable stopped claim and round-trips every stop reason", async () => {
		for (const reason of ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const) {
			const { reconciliation } = await accepted();
			const outcome = stopped(reason);
			await reconciliation.claimPendingOutcome(correlation, outcome);
			await reconciliation.finalizePromptOutcome(correlation);

			expect(reconciliation.lookup("prompt", correlation)).toMatchObject({
				status: "terminal_ok",
				outcome,
			});
		}
	});

	test("maps failure claims to their code unless an error override is supplied", async () => {
		for (const code of ["prompt_failed", "prompt_deadline_exceeded"] as const) {
			const { reconciliation } = await accepted();
			const outcome = failed(code);
			await reconciliation.claimPendingOutcome(correlation, outcome);
			await reconciliation.finalizePromptOutcome(correlation);
			expect(reconciliation.lookup("prompt", correlation)).toMatchObject({
				status: "failed",
				outcome,
				error: { code },
			});
		}

		const { reconciliation } = await accepted();
		await reconciliation.claimPendingOutcome(correlation, failed("prompt_failed"));
		await reconciliation.finalizePromptOutcome(correlation, undefined, { code: "overridden", message: "override" });
		expect(reconciliation.lookup("prompt", correlation)).toMatchObject({
			status: "failed",
			error: { code: "overridden", message: "override" },
		});
	});

	test("does not mutate live state when durable claim persistence fails", async () => {
		const { reconciliation, store } = await accepted();
		store.failNext();

		await expect(reconciliation.claimPendingOutcome(correlation, stopped("end_turn"))).rejects.toThrow(
			"persist failed",
		);
		expect(reconciliation.lookup("prompt", correlation)).toMatchObject({ status: "accepted" });
		expect(reconciliation.peekPendingOutcome(correlation)).toBeUndefined();
		expect(store.snapshot()).toEqual([
			expect.objectContaining({ kind: "prompt", commandId: "command", turnId: "turn", status: "accepted" }),
		]);
	});

	test("serializes interleaved prompt and skill mutations without erasing either", async () => {
		const { reconciliation, store } = await accepted();
		const held = Promise.withResolvers<void>();
		const claimEntered = Promise.withResolvers<void>();
		store.holdNext(held.promise, claimEntered.resolve);

		const claim = reconciliation.claimPendingOutcome(correlation, stopped("end_turn"));
		await claimEntered.promise;
		const skill = reconciliation.noteAccepted("skill", { commandId: "skill-command", turnId: "skill-turn" });
		held.resolve();
		await Promise.all([claim, skill]);

		expect(store.snapshot()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "prompt", pendingOutcome: stopped("end_turn") }),
				expect.objectContaining({ kind: "skill", commandId: "skill-command", turnId: "skill-turn" }),
			]),
		);
	});

	test("settles restart records with pending prompt outcomes and preserves skill restart failures", () => {
		const pendingOutcome: SdkPromptTerminalOutcome = stopped("max_tokens");
		const settled = settleProcessRestart(
			[
				{ kind: "prompt", commandId: "pending", turnId: "1", status: "accepted", acceptedAt: 1, pendingOutcome },
				{ kind: "prompt", commandId: "missing", turnId: "2", status: "in_flight", acceptedAt: 1 },
				{ kind: "skill", commandId: "skill", turnId: "3", status: "accepted", acceptedAt: 1 },
			],
			500,
		);

		expect(settled[0]).toMatchObject({ status: "terminal_ok", terminalAt: 500, outcome: pendingOutcome });
		expect(settled[0]?.pendingOutcome).toBeUndefined();
		expect(settled[1]).toMatchObject({
			status: "failed",
			outcome: { kind: "failed", code: "prompt_failed" },
			error: { code: "prompt_failed" },
		});
		expect(settled[2]).toMatchObject({ status: "failed", error: { code: "process_restart" } });
	});
});
