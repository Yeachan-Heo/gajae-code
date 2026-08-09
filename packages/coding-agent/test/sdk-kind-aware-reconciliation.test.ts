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
	test("retains bounded Unicode terminal content across restart", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "kind-recon-content-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
		const rec = createKindAwareReconciliation({ store });
		rec.admit("skill", "ref-content");
		await rec.noteAccepted("skill", { commandId: "c1", turnId: "t1" }, "ref-content");
		await rec.noteTransition(
			"skill",
			{ commandId: "c1", turnId: "t1" },
			{
				type: "agent_end",
				content: { version: 1, type: "text", text: "😀".repeat(10_000), byteLength: 40_000, truncated: false },
			},
		);
		const reopened = createKindAwareReconciliation({
			store: createReconciliationStore({ sessionFile, sessionId: "s1" }),
		});
		await reopened.hydrateFromStore();
		const result = reopened.lookupResult("skill", { clientRef: "ref-content" });
		expect(result).toMatchObject({ status: "terminal_ok", content: { truncated: true } });
		expect(new TextEncoder().encode(result.content?.text).length).toBeLessThanOrEqual(16_384);
		await fs.rm(root, { recursive: true, force: true });
	});
});
