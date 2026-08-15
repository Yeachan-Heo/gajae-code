import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createKindAwareReconciliation } from "../src/sdk/bus/kind-aware-reconciliation";
import { createReconciliationStore } from "../src/sdk/bus/reconciliation-store";

describe("kind-aware reconciliation", () => {
	test("prompt and skill clientRefs do not collide", () => {
		const rec = createKindAwareReconciliation();
		rec.admit("prompt", "same-ref");
		rec.admit("skill", "same-ref");
		expect(() => rec.admit("prompt", "same-ref")).toThrow(/clientRef/);
	});

	test("durable store survives process restart with process_restart settlement", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "kind-recon-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId: "s1", now: () => 1000 });
		const rec = createKindAwareReconciliation({ store, now: () => 1000 });
		rec.admit("skill", "ref-1");
		await rec.noteAccepted("skill", { commandId: "c1", turnId: "t1" }, "ref-1", { skillName: "ralplan" });
		expect(rec.lookup("skill", { clientRef: "ref-1" })).toMatchObject({ status: "accepted" });

		const reopenedStore = createReconciliationStore({ sessionFile, sessionId: "s1", now: () => 2000 });
		const reopened = createKindAwareReconciliation({ store: reopenedStore, now: () => 2000 });
		await reopened.hydrateFromStore();
		expect(reopened.lookup("skill", { clientRef: "ref-1" })).toMatchObject({
			status: "failed",
			error: { code: "process_restart" },
		});
		await fs.rm(root, { recursive: true, force: true });
	});
	test("retains bounded prompt and skill terminal content across a late restart", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "kind-recon-content-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId: "s1", now: () => 1_000 });
		const rec = createKindAwareReconciliation({ store, now: () => 1_000 });
		for (const kind of ["prompt", "skill"] as const) {
			rec.admit(kind, `ref-${kind}`);
			await rec.noteAccepted(kind, { commandId: `c-${kind}`, turnId: `t-${kind}` }, `ref-${kind}`);
			await rec.noteTransition(
				kind,
				{ commandId: `c-${kind}`, turnId: `t-${kind}` },
				{
					type: "agent_end",
					content: { version: 1, type: "text", text: "😀".repeat(10_000), byteLength: 40_000, truncated: false },
				},
			);
		}
		const reopened = createKindAwareReconciliation({
			store: createReconciliationStore({ sessionFile, sessionId: "s1", now: () => 86_401_000 }),
			now: () => 86_401_000,
		});
		await reopened.hydrateFromStore();
		for (const kind of ["prompt", "skill"] as const) {
			const result = reopened.lookupResult(kind, { clientRef: `ref-${kind}` });
			expect(result).toMatchObject({ status: "terminal_ok", content: { truncated: true } });
			expect(new TextEncoder().encode(result.content?.text).length).toBeLessThanOrEqual(16_384);
			expect(reopened.lookup(kind, { commandId: `c-${kind}`, turnId: `t-${kind}` })).toMatchObject({
				status: "terminal_ok",
			});
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	test("terminal transitions preserve claimed skill outcomes across reload", async () => {
		const cases = [
			{
				name: "stopped claim beats a later failure frame",
				outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
				frame: { type: "agent_failed", error: new Error("late failure") },
				expectedStatus: "terminal_ok",
			},
			{
				name: "failed claim beats a later completion frame",
				outcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "claimed failure",
					provenance: "agent_failed",
				},
				frame: { type: "agent_end" },
				expectedStatus: "failed",
			},
		] as const;

		for (const [index, testCase] of cases.entries()) {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "kind-recon-terminal-"));
			try {
				const sessionFile = path.join(root, "s.jsonl");
				await fs.writeFile(sessionFile, "");
				const correlation = { commandId: `c${index}`, turnId: `t${index}` };
				const clientRef = `ref-${index}`;
				const store = createReconciliationStore({ sessionFile, sessionId: "s1", now: () => 1000 });
				const rec = createKindAwareReconciliation({ store, now: () => 1000 });
				rec.admit("skill", clientRef);
				await rec.noteAccepted("skill", correlation, clientRef, { skillName: "deep-interview" });
				await rec.claimPendingOutcome("skill", correlation, testCase.outcome);
				await rec.noteTransition("skill", correlation, testCase.frame);

				expect(rec.lookup("skill", { clientRef }), testCase.name).toMatchObject({
					status: testCase.expectedStatus,
					outcome: testCase.outcome,
				});

				const reopenedStore = createReconciliationStore({ sessionFile, sessionId: "s1", now: () => 2000 });
				const reopened = createKindAwareReconciliation({ store: reopenedStore, now: () => 2000 });
				await reopened.hydrateFromStore();
				expect(reopened.lookup("skill", { clientRef }), `${testCase.name} after reload`).toMatchObject({
					status: testCase.expectedStatus,
					outcome: testCase.outcome,
				});
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	});
});
