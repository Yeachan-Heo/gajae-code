import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createReconciliationStore,
	type DurableReconciliationRecord,
	type DurableTerminalScopeRecord,
	isSafeReconciliationSessionId,
	RECONCILIATION_STORE_VERSION,
	RECONCILIATION_STORE_VERSION_V1,
	reconciliationStorePath,
	settleProcessRestart,
	settleTerminalScopeRestart,
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
	test("v1 documents migrate to v2 on load and are rewritten durably", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-v1-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const storePath = reconciliationStorePath(sessionFile, "s1");
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(
			storePath,
			JSON.stringify({
				version: RECONCILIATION_STORE_VERSION_V1,
				sessionId: "s1",
				records: [{ kind: "prompt", commandId: "c1", turnId: "t1", status: "accepted", acceptedAt: 1 }],
			}),
		);
		const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
		await store.load();
		const rewritten = JSON.parse(await fs.readFile(storePath, "utf8"));
		expect(rewritten.version).toBe(RECONCILIATION_STORE_VERSION);
		expect(rewritten.records).toHaveLength(1);
		expect(await store.loadTerminalScopes()).toEqual([]);
		await fs.rm(root, { recursive: true, force: true });
	});

	test("terminal scope records round-trip through the shared document", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-term-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
		const scope: DurableTerminalScopeRecord = {
			selection: "turn",
			idempotencyKeyHash: "k-hash-1",
			idempotencyInputHash: "input-hash-1",
			turnDisposition: "stopped",
			ownedWorkDisposition: "left_running",
			automaticDeliveryDisposition: "enabled",
			resumeOnOwnedCompletion: true,
			turnContinuationFence: {
				state: "retained",
				abortedAttemptEpoch: 3,
				blockedContinuationIds: ["c-a"],
				predecessorTombstones: ["p-1"],
				ownedCompletionPolicy: "enabled",
			},
			responseState: "delivered",
			responsePayloadHash: "hash-1",
			acceptedAt: 10,
			terminalAt: 20,
		};
		await store.transactTerminalScopes(() => [scope]);
		await store.transact(() => [
			{ kind: "prompt", commandId: "c1", turnId: "t1", status: "accepted", acceptedAt: 1 },
		]);
		expect(store.snapshotTerminalScopes()).toEqual([scope]);
		expect(store.snapshot()).toHaveLength(1);

		// A fresh store instance reloads both records and terminal scopes from one document.
		const reloaded = createReconciliationStore({ sessionFile, sessionId: "s1" });
		await reloaded.load();
		expect(reloaded.snapshotTerminalScopes()).toEqual([scope]);
		expect(reloaded.snapshot()).toHaveLength(1);
		await fs.rm(root, { recursive: true, force: true });
	});

	test("invalid terminal scope documents are quarantined on load", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-bad-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const storePath = reconciliationStorePath(sessionFile, "s1");
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(
			storePath,
			JSON.stringify({
				version: RECONCILIATION_STORE_VERSION,
				sessionId: "s1",
				records: [],
				terminalScopes: [{ selection: "bogus", turnDisposition: "stopped" }],
			}),
		);
		const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
		expect(await store.loadTerminalScopes()).toEqual([]);
		const entries = await fs.readdir(path.dirname(storePath));
		expect(entries.some(name => name.includes("corrupt"))).toBe(true);
		await fs.rm(root, { recursive: true, force: true });
	});

	test.each([
		["turn disposition", { turnDisposition: "bogus" }],
		["owned-work disposition", { ownedWorkDisposition: "bogus" }],
		["response state", { responseState: "bogus" }],
		["empty response payload hash", { responsePayloadHash: "" }],
		["publication state", { terminalPublished: "yes" }],
	])("quarantines an evicted tombstone with invalid %s", async (_field, invalid) => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-evicted-bad-"));
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		const storePath = reconciliationStorePath(sessionFile, "s1");
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(
			storePath,
			JSON.stringify({
				version: RECONCILIATION_STORE_VERSION,
				sessionId: "s1",
				records: [],
				evictedTerminalKeys: [{ keyHash: "key", inputHash: "input", ...invalid }],
			}),
		);
		try {
			const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
			expect(await store.load()).toEqual([]);
			expect(store.snapshotTerminalKeys()).toEqual([]);
			expect((await fs.readdir(path.dirname(storePath))).some(name => name.includes("corrupt"))).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("settleTerminalScopeRestart maps pending to uncertain and never invents success", () => {
		const now = 5_000;
		const pending: DurableTerminalScopeRecord = {
			selection: "turn",
			turnDisposition: "pending",
			ownedWorkDisposition: "left_running",
			automaticDeliveryDisposition: "enabled",
			resumeOnOwnedCompletion: true,
			turnContinuationFence: {
				state: "retained",
				abortedAttemptEpoch: 1,
				blockedContinuationIds: [],
				predecessorTombstones: [],
				ownedCompletionPolicy: "enabled",
			},
			responseState: "pending",
			responsePayloadHash: "h",
			acceptedAt: 1,
		};
		const settled = settleTerminalScopeRestart([pending], now)[0];
		expect(settled.turnDisposition).toBe("uncertain");
		expect(settled.ownedWorkDisposition).toBe("uncertain");
		expect(settled.terminalAt).toBe(now);
		// A durable stopped scope is left untouched.
		const stopped: DurableTerminalScopeRecord = { ...pending, turnDisposition: "stopped", terminalAt: 2 };
		expect(settleTerminalScopeRestart([stopped], now)[0]).toBe(stopped);
	});
});

test("terminal scope response state advances pending -> sent through the shared owner", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-resp-"));
	const sessionFile = path.join(root, "s.jsonl");
	await fs.writeFile(sessionFile, "");
	const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
	const scope: DurableTerminalScopeRecord = {
		selection: "turn",
		idempotencyKeyHash: "k-hash-1",
		idempotencyInputHash: "input-hash-1",
		turnDisposition: "stopped",
		ownedWorkDisposition: "left_running",
		automaticDeliveryDisposition: "enabled",
		resumeOnOwnedCompletion: true,
		turnContinuationFence: {
			state: "retained",
			abortedAttemptEpoch: 3,
			blockedContinuationIds: [],
			predecessorTombstones: [],
			ownedCompletionPolicy: "enabled",
		},
		responseState: "pending",
		responsePayloadHash: "hash-1",
		acceptedAt: 10,
		terminalAt: 20,
	};
	await store.transactTerminalScopes(() => [scope]);
	expect(store.snapshotTerminalScopes()[0]!.responseState).toBe("pending");
	// The afterControlResponse hook advances only the matching key from
	// pending to sent (AC 18 monotonic) and persists through reload.
	await store.transactTerminalScopes(scopes =>
		scopes.map(s =>
			s.idempotencyKeyHash === "k-hash-1" && s.responseState === "pending"
				? { ...s, responseState: "sent" as const }
				: s,
		),
	);
	expect(store.snapshotTerminalScopes()[0]!.responseState).toBe("sent");
	const reloaded = createReconciliationStore({ sessionFile, sessionId: "s1" });
	await reloaded.load();
	expect(reloaded.snapshotTerminalScopes()[0]!.responseState).toBe("sent");
	await fs.rm(root, { recursive: true, force: true });
});

test("initial pending marker CASes to stopped through the same owner", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-marker-"));
	const sessionFile = path.join(root, "s.jsonl");
	await fs.writeFile(sessionFile, "");
	const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
	// Initial marker (plan step 4): pending, publication false, response pending.
	await store.transactTerminalScopes(() => [
		{
			selection: "turn",
			idempotencyKeyHash: "k1",
			idempotencyInputHash: "i1",
			turnDisposition: "pending",
			terminalPublished: false,
			ownedWorkDisposition: "not_requested",
			automaticDeliveryDisposition: "enabled",
			resumeOnOwnedCompletion: true,
			turnContinuationFence: {
				state: "retained",
				abortedAttemptEpoch: 3,
				blockedContinuationIds: [],
				predecessorTombstones: [],
				ownedCompletionPolicy: "enabled",
			},
			responseState: "pending",
			responsePayloadHash: "i1",
			acceptedAt: 1,
		},
	]);
	const marker = store.snapshotTerminalScopes()[0]!;
	expect(marker.turnDisposition).toBe("pending");
	expect(marker.terminalPublished).toBe(false);
	// Semantic CAS (plan step 15): advance the same marker.
	await store.transactTerminalScopes(scopes =>
		scopes.map(s =>
			s.idempotencyKeyHash === "k1"
				? {
						...s,
						turnDisposition: "stopped" as const,
						terminalPublished: true,
						ownedWorkDisposition: "left_running" as const,
						terminalAt: 2,
					}
				: s,
		),
	);
	const cas = store.snapshotTerminalScopes()[0]!;
	expect(cas.turnDisposition).toBe("stopped");
	expect(cas.terminalPublished).toBe(true);
	expect(cas.ownedWorkDisposition).toBe("left_running");
	// Reload keeps the CASed state; restart settlement leaves a stopped scope untouched.
	const reloaded = createReconciliationStore({ sessionFile, sessionId: "s1" });
	await reloaded.load();
	expect(reloaded.snapshotTerminalScopes()[0]!.turnDisposition).toBe("stopped");
	expect(settleTerminalScopeRestart(reloaded.snapshotTerminalScopes(), 9)[0]).toEqual(
		reloaded.snapshotTerminalScopes()[0],
	);
	await fs.rm(root, { recursive: true, force: true });
});

test("response-state transition is guarded by the normalized input hash", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-inputhash-"));
	const sessionFile = path.join(root, "s.jsonl");
	await fs.writeFile(sessionFile, "");
	const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
	const base = {
		selection: "turn" as const,
		idempotencyKeyHash: "k1",
		ownedWorkDisposition: "left_running" as const,
		automaticDeliveryDisposition: "enabled" as const,
		resumeOnOwnedCompletion: true,
		turnContinuationFence: {
			state: "retained" as const,
			abortedAttemptEpoch: 3,
			blockedContinuationIds: [],
			predecessorTombstones: [],
			ownedCompletionPolicy: "enabled" as const,
		},
		responseState: "pending" as const,
		responsePayloadHash: "p",
		acceptedAt: 1,
	};
	await store.transactTerminalScopes(() => [
		{ ...base, idempotencyInputHash: "input-turn", turnDisposition: "stopped" as const },
		{ ...base, idempotencyInputHash: "input-owned", turnDisposition: "stopped" as const },
	]);
	// A response for the TURN input (matching key + input) advances only the
	// turn record; the owned record (same key, different input) stays pending
	// — a conflict/invalid response for a different input must never advance
	// the original marker (review thread P2).
	await store.transactTerminalScopes(scopes =>
		scopes.map(scope =>
			scope.idempotencyKeyHash === "k1" &&
			scope.idempotencyInputHash === "input-turn" &&
			scope.responseState === "pending"
				? { ...scope, responseState: "sent" as const }
				: scope,
		),
	);
	const after = store.snapshotTerminalScopes();
	expect(after.find(s => s.idempotencyInputHash === "input-turn")?.responseState).toBe("sent");
	expect(after.find(s => s.idempotencyInputHash === "input-owned")?.responseState).toBe("pending");
	await fs.rm(root, { recursive: true, force: true });
});

test("no-effect terminal reservations persist and survive restart settlement", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-noeffect-"));
	const sessionFile = path.join(root, "s.jsonl");
	await fs.writeFile(sessionFile, "");
	const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
	await store.transactTerminalScopes(() => [
		{
			selection: "turn",
			idempotencyKeyHash: "k1",
			idempotencyInputHash: "i1",
			turnDisposition: "no_effect",
			ownedWorkDisposition: "not_requested",
			automaticDeliveryDisposition: "enabled",
			resumeOnOwnedCompletion: true,
			turnContinuationFence: {
				state: "retained",
				abortedAttemptEpoch: 0,
				blockedContinuationIds: [],
				predecessorTombstones: [],
				ownedCompletionPolicy: "enabled",
			},
			responseState: "pending",
			responsePayloadHash: "i1",
			acceptedAt: 1,
		},
	]);
	// Validator accepts it and restart settlement leaves a no-effect row
	// untouched (only pending rows settle to uncertainty).
	const reloaded = createReconciliationStore({ sessionFile, sessionId: "s1" });
	await reloaded.load();
	expect(reloaded.snapshotTerminalScopes()[0]!.turnDisposition).toBe("no_effect");
	expect(settleTerminalScopeRestart(reloaded.snapshotTerminalScopes(), 9)[0]!.turnDisposition).toBe("no_effect");
	await fs.rm(root, { recursive: true, force: true });
});
test("evicted pending tombstone advances to sent through the delivery transaction", async () => {
	// A terminal response write lands while the row was already evicted by the
	// 256-row retention cap: the delivery callback must update the matching
	// COMPACT TOMBSTONE (evictedTerminalKeys), not only live scope rows — a
	// same-key replay after cache expiry/restart would otherwise report a false
	// durable delivery state (review thread P2).
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-evicted-delivery-"));
	const sessionFile = path.join(root, "s.jsonl");
	await fs.writeFile(sessionFile, "");
	const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
	const scope = {
		selection: "turn" as const,
		idempotencyKeyHash: "k-evicted",
		idempotencyInputHash: "i-evicted",
		turnDisposition: "stopped" as const,
		ownedWorkDisposition: "left_running" as const,
		automaticDeliveryDisposition: "enabled" as const,
		resumeOnOwnedCompletion: true,
		turnContinuationFence: {
			state: "retained" as const,
			abortedAttemptEpoch: 3,
			blockedContinuationIds: [],
			predecessorTombstones: [],
			ownedCompletionPolicy: "enabled" as const,
		},
		responseState: "pending" as const,
		responsePayloadHash: "p",
		acceptedAt: 1,
	};
	await store.transactTerminalScopes(() => [scope]);
	// The retention cap evicts the completed row; its compact tombstone keeps
	// the pending response state so the replay reconstructs the original row.
	await store.transactTerminalState(_state => ({
		scopes: [],
		keys: [
			{
				keyHash: "k-evicted",
				inputHash: "i-evicted",
				turnDisposition: "stopped",
				ownedWorkDisposition: "left_running",
				responseState: "pending",
				responsePayloadHash: "p",
			},
		],
	}));
	expect(store.snapshotTerminalKeys()[0]!.responseState).toBe("pending");
	// The delivery callback (onControlResponseDelivery) transaction: advance
	// the matching live scope OR evicted tombstone from pending, atomically.
	await store.transactTerminalState(state => ({
		scopes: state.scopes.map(s =>
			s.idempotencyKeyHash === "k-evicted" && s.idempotencyInputHash === "i-evicted" && s.responseState === "pending"
				? { ...s, responseState: "sent" as const }
				: s,
		),
		keys: state.keys.map(k =>
			k.keyHash === "k-evicted" && k.inputHash === "i-evicted" && k.responseState === "pending"
				? { ...k, responseState: "sent" }
				: k,
		),
	}));
	// The tombstone now reports the durable sent state; an unrelated pending
	// tombstone is untouched.
	expect(store.snapshotTerminalKeys()[0]!.responseState).toBe("sent");
	await store.transactTerminalState(state => ({
		scopes: state.scopes,
		keys: [
			...state.keys,
			{
				keyHash: "k-other",
				inputHash: "i-other",
				turnDisposition: "stopped",
				ownedWorkDisposition: "left_running",
				responseState: "pending",
				responsePayloadHash: "q",
			},
		],
	}));
	await store.transactTerminalState(state => ({
		scopes: state.scopes,
		keys: state.keys.map(k =>
			k.keyHash === "k-evicted" && k.inputHash === "i-evicted" && k.responseState === "pending"
				? { ...k, responseState: "failed" }
				: k,
		),
	}));
	expect(store.snapshotTerminalKeys().find(k => k.keyHash === "k-evicted")?.responseState).toBe("sent");
	expect(store.snapshotTerminalKeys().find(k => k.keyHash === "k-other")?.responseState).toBe("pending");
	// Survives restart settlement (settlement only touches pending SCOPE rows).
	const reloaded = createReconciliationStore({ sessionFile, sessionId: "s1" });
	await reloaded.load();
	expect(reloaded.snapshotTerminalKeys().find(k => k.keyHash === "k-evicted")?.responseState).toBe("sent");
});

test("empty-store reload clears retained evicted-terminal keys on every empty-load path", async () => {
	// Reproduction of the review-thread P2 scenario: a store instance that
	// already loaded evicted-key tombstones must not keep replaying or
	// conflicting on keys that no longer exist in the durable store — the
	// ENOENT, no-path, and corrupt/quarantine branches all empty the store.
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-recon-empty-reload-"));
	const sessionFile = path.join(root, "s.jsonl");
	await fs.writeFile(sessionFile, "");
	const store = createReconciliationStore({ sessionFile, sessionId: "s1" });
	await store.transactTerminalState(_state => ({
		scopes: [],
		keys: [
			{
				keyHash: "k-gone",
				inputHash: "i-gone",
				turnDisposition: "stopped",
				ownedWorkDisposition: "left_running",
				responseState: "pending",
				responsePayloadHash: "p",
			},
		],
	}));
	expect(store.snapshotTerminalKeys()[0]!.keyHash).toBe("k-gone");

	// ENOENT: the store's backing file deleted → load() clears
	// records/scopes AND the retained terminal-key cache.
	await fs.rm(reconciliationStorePath(sessionFile, "s1"), { force: true });
	await store.load();
	expect(store.snapshotTerminalKeys()).toEqual([]);

	// Corrupt/quarantine: unparseable content → same cleared cache.
	await store.transactTerminalState(_state => ({
		scopes: [],
		keys: [
			{
				keyHash: "k-quarantine",
				inputHash: "i-q",
				turnDisposition: "stopped",
				ownedWorkDisposition: "left_running",
				responseState: "pending",
				responsePayloadHash: "p",
			},
		],
	}));
	await fs.writeFile(reconciliationStorePath(sessionFile, "s1"), "{ definitely not json");
	await store.load();
	expect(store.snapshotTerminalKeys()).toEqual([]);

	// No-path: a store instance without a backing file starts empty.
	const pathless = createReconciliationStore({ sessionFile: "", sessionId: "s2" });
	await pathless.load();
	expect(pathless.snapshotTerminalKeys()).toEqual([]);
	await fs.rm(root, { recursive: true, force: true });
});
