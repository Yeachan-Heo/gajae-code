import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createReconciliationStore,
	type DurableReconciliationRecord,
	isSafeReconciliationSessionId,
	reconciliationStorePath,
	settleProcessRestart,
} from "../src/sdk/bus/reconciliation-store";

describe("reconciliation-store", () => {
	test("safe session id pattern rejects path traversal", () => {
		expect(isSafeReconciliationSessionId("live")).toBe(true);
		expect(isSafeReconciliationSessionId("a.b-c_1")).toBe(true);
		expect(isSafeReconciliationSessionId("../etc")).toBe(false);
		expect(isSafeReconciliationSessionId("a/b")).toBe(false);
		expect(isSafeReconciliationSessionId("")).toBe(false);
		expect(() => reconciliationStorePath("/tmp/s.jsonl", "../x")).toThrow();
	});

	test("path is private sibling of transcript, not artifacts stem", () => {
		const sessionFile = "/home/u/.gjc/agent/sessions/scope/abc.jsonl";
		const storePath = reconciliationStorePath(sessionFile, "abc");
		expect(storePath).toBe("/home/u/.gjc/agent/sessions/scope/.sdk-reconciliation/abc.json");
		expect(storePath.includes("abc/")).toBe(false); // not under artifact stem abc/
	});

	test("settleProcessRestart never invents terminal_ok", () => {
		const now = 1_000_000;
		const input: DurableReconciliationRecord[] = [
			{
				kind: "prompt",
				commandId: "c1",
				turnId: "t1",
				status: "accepted",
				acceptedAt: 1,
			},
			{
				kind: "skill",
				commandId: "c2",
				turnId: "t2",
				status: "in_flight",
				acceptedAt: 1,
				startedAt: 2,
			},
			{
				kind: "prompt",
				commandId: "c3",
				turnId: "t3",
				status: "terminal_ok",
				acceptedAt: 1,
				terminalAt: 3,
			},
		];
		const settled = settleProcessRestart(input, now);
		// Prompts must always end with one normalized outcome; only skills keep the
		// legacy outcome-less `process_restart` settlement.
		expect(settled[0]?.status).toBe("failed");
		expect(settled[0]?.error?.code).toBe("prompt_failed");
		expect(settled[0]?.outcome).toMatchObject({ kind: "failed", code: "prompt_failed" });
		expect(settled[1]?.status).toBe("failed");
		expect(settled[1]?.error?.code).toBe("process_restart");
		expect(settled[2]?.status).toBe("terminal_ok");
	});

	test("transact persists and reload settles a non-terminal prompt with its normalized outcome", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "recon-store-"));
		const sessionFile = path.join(root, "sess.jsonl");
		await fs.writeFile(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId: "sess1", now: () => 5000 });
		await store.transact(() => [
			{
				kind: "prompt",
				commandId: "cmd",
				turnId: "turn",
				clientRef: "ref-a",
				status: "accepted",
				acceptedAt: 1000,
			},
		]);
		expect(store.path).toContain(".sdk-reconciliation");
		const raw = await fs.readFile(store.path!, "utf8");
		expect(raw).toContain("accepted");
		expect(raw).not.toContain("secret-args");

		const reopened = createReconciliationStore({ sessionFile, sessionId: "sess1", now: () => 9000 });
		const loaded = await reopened.load();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.status).toBe("failed");
		expect(loaded[0]?.error?.code).toBe("prompt_failed");
		// sticky after settle
		const again = createReconciliationStore({ sessionFile, sessionId: "sess1", now: () => 10_000 });
		const loaded2 = await again.load();
		expect(loaded2[0]?.status).toBe("failed");
		expect(loaded2[0]?.error?.code).toBe("prompt_failed");

		await again.delete();
		await expect(fs.stat(store.path!)).rejects.toMatchObject({ code: "ENOENT" });
		await fs.rm(root, { recursive: true, force: true });
	});

	test("corrupt file quarantines and returns empty", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "recon-corrupt-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const storePath = reconciliationStorePath(sessionFile, "s1");
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(storePath, "not-json{{{");
		const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
		const loaded = await store.load();
		expect(loaded).toEqual([]);
		const entries = await fs.readdir(path.dirname(storePath));
		expect(entries.some(name => name.includes("corrupt"))).toBe(true);
		await fs.rm(root, { recursive: true, force: true });
	});

	test("quarantines terminal_ok records with failed outcomes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "recon-terminal-mismatch-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const storePath = reconciliationStorePath(sessionFile, "s1");
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(
			storePath,
			JSON.stringify({
				version: 1,
				sessionId: "s1",
				records: [
					{
						kind: "prompt",
						commandId: "c1",
						turnId: "t1",
						status: "terminal_ok",
						acceptedAt: 1,
						terminalAt: 2,
						outcome: {
							kind: "failed",
							code: "prompt_failed",
							message: "failed",
							provenance: "agent_failed",
						},
					},
				],
			}),
		);
		const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
		expect(await store.load()).toEqual([]);
		const entries = await fs.readdir(path.dirname(storePath));
		expect(entries.some(name => name.includes("corrupt"))).toBe(true);
		await fs.rm(root, { recursive: true, force: true });
	});

	test("quarantines failed records with terminal_ok outcomes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "recon-status-mismatch-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const storePath = reconciliationStorePath(sessionFile, "s1");
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(
			storePath,
			JSON.stringify({
				version: 1,
				sessionId: "s1",
				records: [
					{
						kind: "prompt",
						commandId: "c1",
						turnId: "t1",
						status: "failed",
						acceptedAt: 1,
						terminalAt: 2,
						outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
					},
				],
			}),
		);
		const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
		expect(await store.load()).toEqual([]);
		const entries = await fs.readdir(path.dirname(storePath));
		expect(entries.some(name => name.includes("corrupt"))).toBe(true);
		await fs.rm(root, { recursive: true, force: true });
	});

	test("accepts outcome-less terminal records", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "recon-outcome-less-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const storePath = reconciliationStorePath(sessionFile, "s1");
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(
			storePath,
			JSON.stringify({
				version: 1,
				sessionId: "s1",
				records: [
					{
						kind: "prompt",
						commandId: "c1",
						turnId: "t1",
						status: "terminal_ok",
						acceptedAt: 1,
						terminalAt: 2,
					},
				],
			}),
		);
		const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
		expect(await store.load()).toMatchObject([
			{ kind: "prompt", commandId: "c1", status: "terminal_ok", terminalAt: 2 },
		]);
		const entries = await fs.readdir(path.dirname(storePath));
		expect(entries.some(name => name.includes("corrupt"))).toBe(false);
		await fs.rm(root, { recursive: true, force: true });
	});

	test("memory-only when no session file", async () => {
		const store = createReconciliationStore({ sessionFile: null, sessionId: "x" });
		expect(store.path).toBeNull();
		await store.transact(() => [
			{ kind: "skill", commandId: "c", turnId: "t", status: "accepted", acceptedAt: 1, skillName: "ralplan" },
		]);
		expect(store.snapshot()).toHaveLength(1);
		await store.delete();
		expect(store.snapshot()).toHaveLength(0);
	});
});
