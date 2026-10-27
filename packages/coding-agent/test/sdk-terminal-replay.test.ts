import { afterEach, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker, type BrokerResponse, lifecycleTargetForTest } from "../src/sdk/broker/broker";
import { deriveIdempotencyIdentity } from "../src/sdk/broker/identity";

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter(key => record[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("Broker replays the proven retirement error after the indexed session disappears", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-terminal-replay-"));
	roots.push(agentDir);
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const operation = "session.reconcile_uncertain";
		const key = "retirement-key";
		const input = {
			sessionId: "retired-session",
			cwd: agentDir,
			stateRoot: path.join(agentDir, ".gjc", "state"),
			remoteCreateKey: "create-key",
		};
		const target = createHash("sha256")
			.update(canonicalJson(lifecycleTargetForTest(operation, input)))
			.digest("hex");
		const identity = await deriveIdempotencyIdentity(agentDir, operation, key, target);
		const requestHash = createHash("sha256").update(canonicalJson({ operation, input })).digest("hex");
		const response: BrokerResponse = {
			ok: false,
			error: {
				code: "endpoint_stale",
				message: "retirement endpoint was replaced",
				cleanup: { phase: "artifacts", sessionId: input.sessionId },
			},
		};
		await broker.ledger.begin(identity, requestHash, {
			operationKey: `${operation}\u0000${key}`,
			fingerprint: createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex"),
		});
		await broker.ledger.transition(identity, "terminal_error", { response });
		// There is no indexed session now: executing retirement again would produce
		// not_found, not the proven endpoint_stale response recorded above.
		expect(broker.index.listSessions().sessions).toEqual([]);
		const file = Bun.file(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"));
		const before = await file.text();
		expect(await broker.handleRequest(operation, input, key)).toEqual(response);
		expect(broker.ledger.get(identity)?.response).toEqual(response);
		expect(await file.text()).toBe(before);
	} finally {
		await broker.stop();
	}
});

test("Broker returns the proven terminal error when a late transition wins the replay race", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-terminal-race-"));
	roots.push(agentDir);
	const broker = new Broker({ agentDir });
	await broker.start();
	type BeginArgs = Parameters<typeof broker.ledger.begin>;
	const realBegin = broker.ledger.begin.bind(broker.ledger);
	try {
		const operation = "session.reconcile_uncertain";
		const key = "race-key";
		const input = {
			sessionId: "racing-session",
			cwd: agentDir,
			stateRoot: path.join(agentDir, ".gjc", "state"),
			remoteCreateKey: "race-create-key",
		};
		const target = createHash("sha256")
			.update(canonicalJson(lifecycleTargetForTest(operation, input)))
			.digest("hex");
		const identity = await deriveIdempotencyIdentity(agentDir, operation, key, target);
		const requestHash = createHash("sha256").update(canonicalJson({ operation, input })).digest("hex");
		const cleanupPending: BrokerResponse = {
			ok: false,
			error: {
				code: "cleanup_pending",
				message: "retirement cleanup is still pending",
				cleanup: { phase: "artifacts", sessionId: input.sessionId },
			},
		};
		const proven: BrokerResponse = {
			ok: false,
			error: { code: "endpoint_stale", message: "retirement endpoint was replaced" },
		};
		await broker.ledger.begin(identity, requestHash, {
			operationKey: `${operation}\u0000${key}`,
			fingerprint: createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex"),
		});
		await broker.ledger.transition(identity, "effect_started", { response: cleanupPending });
		let seeded = false;
		vi.spyOn(broker.ledger, "begin").mockImplementation(async (...args: BeginArgs) => {
			const result = await realBegin(...args);
			// Simulate a late failure proving the terminal result after begin decided
			// to replay the cleanup-bearing effect_started row.
			if (!seeded && result.kind === "replay") {
				seeded = true;
				await broker.ledger.transition(identity, "terminal_error", { response: proven });
			}
			return result;
		});
		expect(await broker.handleRequest(operation, input, key)).toEqual(proven);
		expect(broker.ledger.get(identity)?.response).toEqual(proven);
		expect(seeded).toBe(true);
	} finally {
		vi.restoreAllMocks();
		await broker.stop();
	}
});
