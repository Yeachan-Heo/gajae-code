import { describe, expect, test } from "bun:test";
import {
	createReconciliationStore,
	type DurableReconciliationRecord,
	RECONCILIATION_STORE_VERSION,
	type ReconciliationStoreFs,
} from "../src/sdk/bus/reconciliation-store";

const SESSION = "session-recovery";

function activePrompt(): DurableReconciliationRecord {
	return {
		kind: "prompt",
		commandId: "c1",
		turnId: "t1",
		status: "accepted",
		acceptedAt: 1,
		pendingOutcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
	};
}

function stubFs(overrides: Partial<ReconciliationStoreFs>): ReconciliationStoreFs {
	return {
		mkdir: async () => {},
		writeFile: async () => {},
		rename: async () => {},
		unlink: async () => {},
		readFile: async () => JSON.stringify({ version: RECONCILIATION_STORE_VERSION, sessionId: SESSION, records: [] }),
		open: async () => ({ sync: async () => {}, close: async () => {} }),
		...overrides,
	} as ReconciliationStoreFs;
}

function store(fs: ReconciliationStoreFs) {
	return createReconciliationStore({
		sessionFile: "/tmp/gjc-recovery/session.jsonl",
		sessionId: SESSION,
		fs,
		now: () => 100,
	});
}

describe("reconciliation restart recovery", () => {
	test("a missing store is an empty store", async () => {
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
		expect(
			await store(
				stubFs({
					readFile: async () => {
						throw missing;
					},
				}),
			).load(),
		).toEqual([]);
	});

	test("a non-ENOENT read failure propagates instead of serving empty state", async () => {
		const denied = Object.assign(new Error("denied"), { code: "EACCES" });
		await expect(
			store(
				stubFs({
					readFile: async () => {
						throw denied;
					},
				}),
			).load(),
		).rejects.toThrow("denied");
	});

	test("corrupt content is quarantined and yields empty state", async () => {
		let renamed = "";
		const loaded = await store(
			stubFs({
				readFile: async () => "{not json",
				rename: async (from: string, to: string) => {
					renamed = `${from}->${to}`;
				},
			}),
		).load();
		expect(loaded).toEqual([]);
		expect(renamed).toContain(".corrupt.");
	});

	test("JSON-valid but malformed records are quarantined, not settled", async () => {
		for (const record of [
			{ kind: "bogus", commandId: "c", turnId: "t", status: "accepted", acceptedAt: 1 },
			{ kind: "prompt", commandId: "", turnId: "t", status: "accepted", acceptedAt: 1 },
			{ kind: "prompt", commandId: "c", turnId: "t", status: "weird", acceptedAt: 1 },
			{
				kind: "prompt",
				commandId: "c",
				turnId: "t",
				status: "accepted",
				acceptedAt: 1,
				pendingOutcome: { kind: "stopped", reason: "nope", provenance: "agent" },
			},
			// A skill record may never carry a prompt pending claim.
			{
				kind: "skill",
				commandId: "c",
				turnId: "t",
				status: "accepted",
				acceptedAt: 1,
				pendingOutcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			},
			// A finalized record may not still hold a pending claim.
			{
				kind: "prompt",
				commandId: "c",
				turnId: "t",
				status: "terminal_ok",
				acceptedAt: 1,
				terminalAt: 2,
				pendingOutcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			},
			// Terminal status without `terminalAt` is inconsistent.
			{ kind: "prompt", commandId: "c", turnId: "t", status: "terminal_ok", acceptedAt: 1 },
			// An outcome may only appear on a finalized record.
			{
				kind: "prompt",
				commandId: "c",
				turnId: "t",
				status: "accepted",
				acceptedAt: 1,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			},
			{ kind: "prompt", commandId: "c", turnId: "t", status: "accepted", acceptedAt: 1, error: { code: 5 } },
			// `error` must carry both a string code and a string message.
			{ kind: "prompt", commandId: "c", turnId: "t", status: "accepted", acceptedAt: 1, error: { code: "x" } },
			{ kind: "prompt", commandId: "c", turnId: "t", status: "accepted", acceptedAt: 1, error: "denied" },
			// `terminalAt` without a terminal status is the other direction of disagreement.
			{ kind: "prompt", commandId: "c", turnId: "t", status: "accepted", acceptedAt: 1, terminalAt: 2 },
			// Known optional fields must still be well typed.
			{ kind: "prompt", commandId: "c", turnId: "t", status: "in_flight", acceptedAt: 1, startedAt: "soon" },
			{ kind: "prompt", commandId: "c", turnId: "t", status: "accepted", acceptedAt: 1, clientRef: 7 },
			{ kind: "skill", commandId: "c", turnId: "t", status: "accepted", acceptedAt: 1, skillName: 9 },
		]) {
			let renamed = "";
			const loaded = await store(
				stubFs({
					readFile: async () =>
						JSON.stringify({ version: RECONCILIATION_STORE_VERSION, sessionId: SESSION, records: [record] }),
					rename: async (from: string, to: string) => {
						renamed = `${from}->${to}`;
					},
				}),
			).load();
			expect(loaded).toEqual([]);
			expect(renamed).toContain(".corrupt.");
		}
	});

	test("a failed restart rewrite propagates rather than dropping reconciliation truth", async () => {
		await expect(
			store(
				stubFs({
					readFile: async () =>
						JSON.stringify({
							version: RECONCILIATION_STORE_VERSION,
							sessionId: SESSION,
							records: [activePrompt()],
						}),
					writeFile: async () => {
						throw new Error("disk full");
					},
				}),
			).load(),
		).rejects.toThrow(/reconciliation persist failed|disk full/);
	});

	test("an active prompt is finalized from its durable pending outcome", async () => {
		const loaded = await store(
			stubFs({
				readFile: async () =>
					JSON.stringify({ version: RECONCILIATION_STORE_VERSION, sessionId: SESSION, records: [activePrompt()] }),
			}),
		).load();
		expect(loaded[0]).toMatchObject({
			status: "terminal_ok",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		expect(loaded[0]?.pendingOutcome).toBeUndefined();
	});

	test("persist-before-swap keeps memory unchanged when the write fails", async () => {
		const failing = store(
			stubFs({
				writeFile: async () => {
					throw new Error("disk full");
				},
			}),
		);
		await failing.load();
		await expect(failing.transact(() => [activePrompt()])).rejects.toThrow(/reconciliation persist failed|disk full/);
		expect(failing.snapshot()).toEqual([]);
	});
});
