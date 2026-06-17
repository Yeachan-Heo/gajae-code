import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { McpStdioCoordinatorClient } from "../src/coordinator-client";

const FAKE = path.join(import.meta.dir, "fixtures", "fake-coordinator.ts");

let client: McpStdioCoordinatorClient | null = null;

function makeClient(command = "bun", args = [FAKE]): McpStdioCoordinatorClient {
	client = new McpStdioCoordinatorClient({ command, args, env: {} });
	return client;
}

afterEach(async () => {
	await client?.close();
	client = null;
});

describe("McpStdioCoordinatorClient (real subprocess JSON-RPC)", () => {
	test("reads bounded coordination status", async () => {
		const status = await makeClient().getCoordinationStatus();
		expect(status.ok).toBe(true);
		expect(status.sessions).toHaveLength(1);
		expect(status.sessionStates).toHaveLength(1);
		expect(status.turns).toHaveLength(1);
	});

	test("starts a session with allow_mutation and returns the session id", async () => {
		const result = await makeClient().startSession({ cwd: "/home/bot/src/project", prompt: "hi" });
		expect(result).toEqual({ ok: true, sessionId: "sess-new" });
	});

	test("records a cancelled report", async () => {
		const result = await makeClient().reportStatus({ sessionId: "sess-1", turnId: "turn-1", status: "cancelled" });
		expect(result).toEqual({ ok: true });
	});

	test("watches hostile raw events with clamped snake_case args and routing-only output", async () => {
		const result = await makeClient().watchEvents({
			afterSeq: 7,
			sessionId: "sess-1",
			eventTypes: ["turn.completed"],
			timeoutMs: 45000,
			limit: 500,
		});
		expect(result).toEqual({
			ok: true,
			events: [
				{ seq: 8, kind: "turn.completed", sessionId: "sess-1" },
				{ seq: 9, kind: "session.state_changed", sessionId: null },
			],
			latestSeq: 10,
			timedOut: true,
		});
		const serialized = JSON.stringify(result.events);
		expect(serialized).not.toContain("summary");
		expect(serialized).not.toContain("metadata");
		expect(serialized).not.toContain("payload_ref");
		expect(serialized).not.toContain("HOSTILE");
	});

	test("returns coordinator_unreachable when the subprocess cannot be spawned", async () => {
		const status = await makeClient("gjc-telegram-remote-no-such-binary", []).getCoordinationStatus();
		expect(status.ok).toBe(false);
		expect(status.reason).toBe("coordinator_unreachable");
	});

	test("watchEvents returns coordinator_unreachable with input cursor on subprocess errors", async () => {
		const result = await makeClient("gjc-telegram-remote-no-such-binary", []).watchEvents({ afterSeq: 42 });
		expect(result).toEqual({
			ok: false,
			reason: "coordinator_unreachable",
			events: [],
			latestSeq: 42,
			timedOut: false,
		});
	});
});
