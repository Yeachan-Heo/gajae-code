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

	test("a steer-only writer preserves prompt records owned by another reconciler", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "kind-owned-recon-"));
		try {
			const sessionFile = path.join(root, "s.jsonl");
			await fs.writeFile(sessionFile, "");
			const store = createReconciliationStore({ sessionFile, sessionId: "owned", now: () => 1_000 });
			await store.transact(() => [
				{
					kind: "prompt",
					commandId: "prompt-command",
					turnId: "prompt-turn",
					clientRef: "prompt-ref",
					status: "accepted",
					acceptedAt: 1,
				},
			]);
			const reconciliation = createKindAwareReconciliation({ store, ownedKinds: ["steer"] });
			await reconciliation.hydrateFromStore();
			await reconciliation.reserveSteer("steer-ref", "body");
			expect(store.snapshot()).toEqual([
				expect.objectContaining({ kind: "prompt", clientRef: "prompt-ref" }),
				expect.objectContaining({ kind: "steer", clientRef: "steer-ref" }),
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
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
	test("sanitizes durable provider diagnostics before query-visible hydration", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "kind-recon-diagnostic-"));
		try {
			const sessionFile = path.join(root, "s.jsonl");
			await fs.writeFile(sessionFile, "");
			const store = createReconciliationStore({ sessionFile, sessionId: "s1", now: () => 1_000 });
			await store.transact(() => [
				{
					kind: "prompt",
					commandId: "c1",
					turnId: "t1",
					clientRef: "diagnostic-ref",
					status: "failed",
					acceptedAt: 1,
					terminalAt: 2,
					error: { code: "provider_unavailable", message: "raw provider secret" },
					outcome: {
						kind: "failed",
						code: "prompt_failed",
						message: "raw provider secret",
						provenance: "agent_failed",
						phase: "submission",
						category: "unknown",
					},
					receiptState: "unknown",
				},
				{
					kind: "steer",
					clientRef: "steer-diagnostic-ref",
					textDigest: "0".repeat(64),
					createdAt: 1,
					commandId: "steer-c1",
					turnId: "steer-t1",
					acceptedAt: 1,
					settledAt: 2,
					status: "rejected",
					error: { code: "provider_unavailable", message: "raw steer provider secret" },
				},
			]);
			const reopenedStore = createReconciliationStore({ sessionFile, sessionId: "s1", now: () => 2_000 });
			const reopened = createKindAwareReconciliation({ store: reopenedStore });
			await reopened.hydrateFromStore();
			expect(reopened.lookupResult("prompt", { clientRef: "diagnostic-ref" })).toMatchObject({
				status: "failed",
				error: { code: "provider_unavailable", message: "Prompt submission failed." },
			});
			expect(reopened.lookup("prompt", { clientRef: "diagnostic-ref" })).toMatchObject({
				status: "failed",
				outcome: {
					kind: "failed",
					phase: "submission",
					category: "agent_runtime",
					message: "Prompt submission failed.",
				},
			});
			expect(reopened.lookupSteer("steer-diagnostic-ref")).toMatchObject({
				status: "rejected",
				error: { code: "provider_unavailable", message: "Prompt submission failed." },
			});
			expect(await fs.readFile(reopenedStore.path!, "utf8")).not.toContain("raw steer provider secret");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
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
			expect(new TextEncoder().encode(result.content?.text).length).toBe(16_384);
			expect(reopened.lookup(kind, { commandId: `c-${kind}`, turnId: `t-${kind}` })).toMatchObject({
				status: "terminal_ok",
			});
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	test("keeps prior truncated evidence through later false and blank content across reload", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "kind-recon-truncated-evidence-"));
		try {
			const sessionFile = path.join(root, "s.jsonl");
			await fs.writeFile(sessionFile, "");
			const store = createReconciliationStore({ sessionFile, sessionId: "truncated-evidence" });
			const rec = createKindAwareReconciliation({ store });
			const correlation = { commandId: "truncated-command", turnId: "truncated-turn" };
			rec.admit("prompt", "truncated-ref");
			await rec.noteAccepted("prompt", correlation, "truncated-ref");
			await rec.noteTransition("prompt", correlation, {
				type: "agent_end",
				content: { version: 1, type: "text", text: "bounded", byteLength: 7, truncated: true },
			});
			await rec.noteTransition("prompt", correlation, {
				type: "agent_end",
				content: { version: 1, type: "text", text: "later", byteLength: 5, truncated: false },
			});
			await rec.noteTransition("prompt", correlation, {
				type: "agent_end",
				content: { version: 1, type: "text", text: " ", byteLength: 1, truncated: false },
			});

			const reopened = createKindAwareReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "truncated-evidence" }),
			});
			await reopened.hydrateFromStore();
			expect(reopened.lookupResult("prompt", { clientRef: "truncated-ref" })).toMatchObject({
				content: { text: "bounded", byteLength: 7, truncated: true },
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	test("persists the content and receipt precedence matrix across reload", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "kind-recon-matrix-"));
		try {
			const sessionFile = path.join(root, "s.jsonl");
			await fs.writeFile(sessionFile, "");
			const store = createReconciliationStore({ sessionFile, sessionId: "matrix", now: () => 1_000 });
			const rec = createKindAwareReconciliation({ store, now: () => 1_000 });
			const text = (value: string) => ({
				version: 1 as const,
				type: "text" as const,
				text: value,
				byteLength: new TextEncoder().encode(value).length,
				truncated: false,
			});
			const stopped = {
				kind: "stopped" as const,
				reason: "cancelled" as const,
				provenance: "client_cancel" as const,
			};
			const admit = async (kind: "prompt" | "skill", name: string) => {
				const correlation = { commandId: `c-${name}`, turnId: `t-${name}` };
				rec.admit(kind, `ref-${name}`);
				await rec.noteAccepted(kind, correlation, `ref-${name}`);
				return correlation;
			};

			const completionFirst = await admit("prompt", "completion-first");
			await rec.finalizeOutcome("prompt", completionFirst, stopped, undefined, "completion");
			await rec.noteTransition("prompt", completionFirst, { type: "agent_end", content: text("later") });

			const blankThenReal = await admit("prompt", "blank-then-real");
			await rec.finalizeOutcome("prompt", blankThenReal, stopped, undefined, "   ");
			await rec.noteTransition("prompt", blankThenReal, { type: "agent_end", content: text("agent") });

			const realThenBlank = await admit("prompt", "real-then-blank");
			await rec.noteTransition("prompt", realThenBlank, { type: "agent_end", content: text("first") });
			await rec.noteTransition("prompt", realThenBlank, { type: "agent_end", content: text(" ") });

			const pendingMissing = await admit("prompt", "pending-missing");
			await rec.claimPendingOutcome("prompt", pendingMissing, stopped, "missing");
			await rec.noteTransition("prompt", pendingMissing, { type: "agent_end", content: text("receipt") });

			const existingPresent = await admit("prompt", "existing-present");
			await rec.claimPendingOutcome("prompt", existingPresent, stopped, "present");
			await rec.noteTransition("prompt", existingPresent, { type: "agent_end", content: text(" ") });

			const unknown = await admit("skill", "unknown");
			await rec.finalizeOutcome("skill", unknown);

			const reopened = createKindAwareReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "matrix", now: () => 2_000 }),
				now: () => 2_000,
			});
			await reopened.hydrateFromStore();
			for (const [name, expectedText, receiptState] of [
				["completion-first", "completion", "present"],
				["blank-then-real", "agent", "present"],
				["real-then-blank", "first", "present"],
				["pending-missing", "receipt", "present"],
			] as const) {
				expect(reopened.lookupResult("prompt", { clientRef: `ref-${name}` })).toMatchObject({
					content: { text: expectedText },
				});
				expect(reopened.lookup("prompt", { clientRef: `ref-${name}` })).toMatchObject({ receiptState });
			}
			expect(reopened.lookupResult("prompt", { clientRef: "ref-existing-present" }).content).toBeUndefined();
			expect(reopened.lookup("prompt", { clientRef: "ref-existing-present" })).toMatchObject({
				receiptState: "present",
			});
			expect(reopened.lookupResult("skill", { clientRef: "ref-unknown" }).content).toBeUndefined();
			expect(reopened.lookup("skill", { clientRef: "ref-unknown" })).toMatchObject({ receiptState: "unknown" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	test("terminal transitions preserve claimed skill outcomes across reload", async () => {
		const cases = [
			{
				name: "agent failure beats an earlier stopped claim at the terminal boundary",
				outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
				frame: { type: "agent_failed", error: new Error("late failure") },
				expectedStatus: "failed",
				expectedOutcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "Prompt submission failed.",
					provenance: "agent_failed",
					phase: "submission",
					category: "agent_runtime",
				},
			},
			{
				name: "failed claim beats a later completion frame",
				outcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "claimed failure",
					provenance: "agent_failed",
					phase: "submission",
					category: "agent_runtime",
				},
				frame: { type: "agent_end" },
				expectedStatus: "failed",
				expectedOutcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "Prompt submission failed.",
					provenance: "agent_failed",
					phase: "submission",
					category: "agent_runtime",
				},
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
				if (testCase.frame.type === "agent_failed")
					await rec.noteTransition("skill", correlation, { type: "agent_end" });

				expect(rec.lookup("skill", { clientRef }), testCase.name).toMatchObject({
					status: testCase.expectedStatus,
					outcome: testCase.expectedOutcome,
				});

				const reopenedStore = createReconciliationStore({ sessionFile, sessionId: "s1", now: () => 2000 });
				const reopened = createKindAwareReconciliation({ store: reopenedStore, now: () => 2000 });
				await reopened.hydrateFromStore();
				expect(reopened.lookup("skill", { clientRef }), `${testCase.name} after reload`).toMatchObject({
					status: testCase.expectedStatus,
					outcome: testCase.expectedOutcome,
				});
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	});
});
