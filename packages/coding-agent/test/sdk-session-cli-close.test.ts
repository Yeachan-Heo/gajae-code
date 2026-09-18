import { beforeEach, expect, mock, test } from "bun:test";
import path from "node:path";

type Captured = {
	requests: unknown[];
};

const captured: Captured = { requests: [] };
let executeResult: unknown = {
	ok: true,
	operation: "session.close",
	result: { sessionId: "sess-1" },
};

mock.module("../src/sdk/lifecycle/broker-client", () => ({
	createBrokerSessionLifecycleService: () => ({
		execute: async (request: unknown) => {
			captured.requests.push(request);
			return executeResult;
		},
	}),
}));

const { runSdkSessionCli } = await import("../src/sdk/cli/session-cli");

const AGENT_DIR = path.join("/tmp", "gjc-sdk-session-close-test-agent");

async function run(args: Record<string, unknown>): Promise<{ outputs: unknown[]; exitCode: number | undefined }> {
	const outputs: unknown[] = [];
	let exitCode: number | undefined;
	await runSdkSessionCli(
		{ agentDir: AGENT_DIR, ...args } as never,
		value => outputs.push(value),
		code => {
			exitCode = code;
		},
	);
	return { outputs, exitCode };
}

beforeEach(() => {
	captured.requests = [];
	executeResult = { ok: true, operation: "session.close", result: { sessionId: "sess-1" } };
});

test("close requires a session id before any lifecycle contact", async () => {
	const { outputs, exitCode } = await run({ action: "close" });
	expect(exitCode).toBe(2);
	expect(outputs[0]).toMatchObject({ ok: false, error: { code: "usage" } });
	expect(captured.requests).toEqual([]);
});

test("close refuses a json input whose sessionId contradicts the selected session", async () => {
	const { outputs, exitCode } = await run({
		action: "close",
		sessionId: "sess-1",
		jsonInput: JSON.stringify({ sessionId: "sess-2" }),
	});
	expect(exitCode).toBe(2);
	expect(outputs[0]).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	expect(captured.requests).toEqual([]);
});

test("close dispatches session.close with a request key derived from the session", async () => {
	const { outputs, exitCode } = await run({ action: "close", sessionId: "sess-1" });
	expect(exitCode).toBeUndefined();
	expect(outputs[0]).toMatchObject({ ok: true, operation: "session.close" });
	expect(captured.requests).toHaveLength(1);
	expect(captured.requests[0]).toMatchObject({
		operation: "session.close",
		capability: "session.close",
		// Derived, not random: a retried close must replay one lifecycle request.
		requestKey: "sdk:session-cli:session.close:sess-1",
		target: { sessionId: "sess-1" },
	});
});

test("a retried close replays the identical request key", async () => {
	await run({ action: "close", sessionId: "sess-1" });
	await run({ action: "close", sessionId: "sess-1" });
	const keys = captured.requests.map(request => (request as { requestKey: string }).requestKey);
	expect(keys).toEqual(["sdk:session-cli:session.close:sess-1", "sdk:session-cli:session.close:sess-1"]);
});

test("an explicit idempotency key wins over the derived one", async () => {
	await run({ action: "close", sessionId: "sess-1", idempotencyKey: "attempt-7" });
	expect(captured.requests[0]).toMatchObject({ requestKey: "attempt-7" });
});

test("a refused close surfaces the broker error and exits nonzero", async () => {
	executeResult = {
		ok: false,
		operation: "session.close",
		certainty: "terminal",
		error: { code: "terminal_uncertain", message: "Session ownership is uncertain and cannot be closed safely." },
	};
	const { outputs, exitCode } = await run({ action: "close", sessionId: "sess-1" });
	expect(exitCode).toBe(1);
	expect(outputs[0]).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
});

test("endpoint authority passes through when the caller supplies it", async () => {
	await run({
		action: "close",
		sessionId: "sess-1",
		jsonInput: JSON.stringify({ endpointGeneration: 3, endpointIncarnation: 9 }),
	});
	expect(captured.requests[0]).toMatchObject({
		target: { sessionId: "sess-1", endpointGeneration: 3, endpointIncarnation: 9 },
	});
});

test("an unknown verb still names close in its usage error", async () => {
	const { outputs, exitCode } = await run({ action: "shutdown", sessionId: "sess-1" });
	expect(exitCode).toBe(2);
	const error = (outputs[0] as { error: { message: string } }).error;
	expect(error.message).toContain("close");
});
