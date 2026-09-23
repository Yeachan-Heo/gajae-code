import { beforeEach, expect, test } from "bun:test";
import path from "node:path";
import { PublicCommandFailure, renderPublicCommandFailure } from "../src/cli/public-command-errors";
import { runSdkSessionCli, type SdkSessionCliDependencies } from "../src/sdk/cli/session-cli";

const captured: { requests: unknown[]; listCalls: number } = { requests: [], listCalls: 0 };
let executeResult: unknown = {
	ok: true,
	operation: "session.close",
	result: { sessionId: "sess-1" },
};
const lifecycle: SdkSessionCliDependencies["lifecycleService"] = {
	list: async () => {
		captured.listCalls += 1;
		return {
			ok: true,
			operation: "session.list",
			result: {
				indexSeq: 1,
				sessions: [
					{
						sessionId: "sess-1",
						endpointGeneration: 3,
						endpointIncarnation: "a".repeat(64),
						live: true,
					},
				],
				warnings: [],
			},
		};
	},
	execute: async (request: unknown) => {
		captured.requests.push(request);
		return executeResult;
	},
} as unknown as SdkSessionCliDependencies["lifecycleService"];

const AGENT_DIR = path.join("/tmp", "gjc-sdk-session-close-test-agent");

async function run(args: Record<string, unknown>): Promise<{ outputs: unknown[]; exitCode: number | undefined }> {
	const outputs: unknown[] = [];
	let exitCode: number | undefined;
	try {
		await runSdkSessionCli(
			{ agentDir: AGENT_DIR, ...args } as never,
			value => outputs.push(value),
			code => {
				exitCode = code;
			},
			{ lifecycleService: lifecycle },
		);
	} catch (error) {
		expect(error).toBeInstanceOf(PublicCommandFailure);
		expect(outputs).toEqual([]);
		const command = args.action === "close" ? ["sdk", "session", "close"] : ["sdk", "session"];
		const rendered = await renderPublicCommandFailure(error, { command, json: true });
		expect(rendered.stderr).toBe("");
		const envelope = JSON.parse(rendered.stdout);
		expect(envelope).toMatchObject({ schema: "gjc.command-error", version: 1, ok: false, command });
		outputs.push(envelope);
		exitCode = rendered.exitCode;
	}
	return { outputs, exitCode };
}

beforeEach(() => {
	captured.requests = [];
	captured.listCalls = 0;
	executeResult = { ok: true, operation: "session.close", result: { sessionId: "sess-1" } };
});

test("close requires a session id before any lifecycle contact", async () => {
	const { outputs, exitCode } = await run({ action: "close" });
	expect(exitCode).toBe(2);
	expect(outputs[0]).toMatchObject({
		ok: false,
		error: { code: "usage", category: "usage", outcomeCertainty: "not-applied", retryability: "no" },
	});
	expect(captured.requests).toEqual([]);
	expect(captured.listCalls).toBe(0);
});

test("close refuses a json input whose sessionId contradicts the selected session", async () => {
	const { outputs, exitCode } = await run({
		action: "close",
		sessionId: "sess-1",
		jsonInput: JSON.stringify({ sessionId: "sess-2" }),
	});
	expect(exitCode).toBe(2);
	expect(outputs[0]).toMatchObject({
		ok: false,
		error: { code: "usage", category: "usage", outcomeCertainty: "not-applied", retryability: "no" },
	});
	expect(captured.requests).toEqual([]);
	expect(captured.listCalls).toBe(0);
});

test("close reports a missing session without issuing a lifecycle mutation", async () => {
	const { outputs, exitCode } = await run({ action: "close", sessionId: "missing-session" });
	expect(exitCode).toBe(1);
	expect(outputs[0]).toMatchObject({
		ok: false,
		error: { code: "endpoint_stale", category: "unavailable", outcomeCertainty: "unknown" },
	});
	expect(captured.requests).toEqual([]);
	expect(captured.listCalls).toBe(1);
});

test("close rejects malformed explicit endpoint authority before mutation", async () => {
	const { outputs, exitCode } = await run({
		action: "close",
		sessionId: "sess-1",
		jsonInput: JSON.stringify({ endpointGeneration: 3, endpointIncarnation: "not-an-incarnation" }),
	});
	expect(exitCode).toBe(2);
	expect(outputs[0]).toMatchObject({
		ok: false,
		error: { code: "usage", category: "usage", outcomeCertainty: "not-applied", retryability: "no" },
	});
	expect(captured.requests).toEqual([]);
	expect(captured.listCalls).toBe(0);
});

test("close dispatches session.close with current endpoint authority in its request key", async () => {
	const { outputs, exitCode } = await run({ action: "close", sessionId: "sess-1" });
	expect(exitCode).toBeUndefined();
	expect(outputs[0]).toMatchObject({ ok: true, operation: "session.close" });
	expect(captured.listCalls).toBe(1);
	expect(captured.requests).toHaveLength(1);
	expect(captured.requests[0]).toMatchObject({
		operation: "session.close",
		capability: "session.close",
		requestKey: `sdk:session-cli:session.close:sess-1:3:${"a".repeat(64)}`,
		target: { sessionId: "sess-1", endpointGeneration: 3, endpointIncarnation: "a".repeat(64) },
	});
});

test("a retried close replays the identical request key for one endpoint generation", async () => {
	await run({ action: "close", sessionId: "sess-1" });
	await run({ action: "close", sessionId: "sess-1" });
	const keys = captured.requests.map(request => (request as { requestKey: string }).requestKey);
	expect(keys).toEqual([
		`sdk:session-cli:session.close:sess-1:3:${"a".repeat(64)}`,
		`sdk:session-cli:session.close:sess-1:3:${"a".repeat(64)}`,
	]);
});

test("an explicit idempotency key wins over the derived one", async () => {
	await run({ action: "close", sessionId: "sess-1", idempotencyKey: "attempt-7" });
	expect(captured.requests[0]).toMatchObject({ requestKey: "attempt-7" });
});

test("a refused close surfaces an unknown operation outcome and exits nonzero", async () => {
	executeResult = {
		ok: false,
		operation: "session.close",
		certainty: "terminal",
		error: { code: "terminal_uncertain", message: "Session ownership is uncertain and cannot be closed safely." },
	};
	const { outputs, exitCode } = await run({ action: "close", sessionId: "sess-1" });
	expect(exitCode).toBe(1);
	expect(outputs[0]).toMatchObject({
		ok: false,
		error: { code: "operation_failed", category: "operation", outcomeCertainty: "unknown", retryability: "unknown" },
	});
	expect(captured.listCalls).toBe(1);
	expect(captured.requests).toHaveLength(1);
});

test("endpoint authority passes through when the caller supplies it", async () => {
	await run({
		action: "close",
		sessionId: "sess-1",
		jsonInput: JSON.stringify({ endpointGeneration: 3, endpointIncarnation: "b".repeat(64) }),
	});
	expect(captured.listCalls).toBe(0);
	expect(captured.requests[0]).toMatchObject({
		target: { sessionId: "sess-1", endpointGeneration: 3, endpointIncarnation: "b".repeat(64) },
		requestKey: `sdk:session-cli:session.close:sess-1:3:${"b".repeat(64)}`,
	});
});

test("an unknown verb reports usage and directs callers to session help without lifecycle contact", async () => {
	const { outputs, exitCode } = await run({ action: "shutdown", sessionId: "sess-1" });
	expect(exitCode).toBe(2);
	expect(outputs[0]).toMatchObject({
		ok: false,
		error: {
			code: "usage",
			category: "usage",
			outcomeCertainty: "not-applied",
			retryability: "no",
			nextSteps: [{ executable: "gjc", argv: ["sdk", "session", "--help"] }],
		},
	});
	expect(captured.requests).toEqual([]);
	expect(captured.listCalls).toBe(0);
});
