import { beforeEach, expect, test } from "bun:test";
import path from "node:path";
import { scanPublicCommand } from "../src/cli/public-command-entry";
import { PublicCommandFailure, renderPublicCommandFailure } from "../src/cli/public-command-errors";
import { runSdkSessionCli, type SdkSessionCliDependencies, sdkPublicFailure } from "../src/sdk/cli/session-cli";

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
					{ sessionId: "sess-no-authority", live: false },
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
		const command =
			args.action === "close"
				? ["sdk", "session", "close"]
				: args.action === "raw"
					? ["sdk", "session", "raw", String(args.rawAction)]
					: ["sdk", "session"];
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
		error: { code: "not_found", category: "operation", outcomeCertainty: "not-applied", retryability: "no" },
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

test("close --if-idle is public grammar and forwards the fence with a distinct stable request key", async () => {
	const parsed = scanPublicCommand("sdk", ["session", "close", "sess-1", "--if-idle"]);
	expect(parsed.kind).toBe("operation");
	if (parsed.kind !== "operation") throw new Error("Expected close operation");
	expect(parsed.flags["if-idle"]).toBe(true);
	await run({ action: "close", sessionId: "sess-1", ifIdle: true });
	await run({ action: "close", sessionId: "sess-1", jsonInput: '{"ifIdle":true}' });
	expect(captured.requests).toHaveLength(2);
	for (const request of captured.requests)
		expect(request).toMatchObject({
			target: { ifIdle: true },
			requestKey: `sdk:session-cli:session.close:sess-1:3:${"a".repeat(64)}:if-idle`,
		});
});

test("close --if-idle rejects a json input that disables the fence before any broker contact", async () => {
	for (const jsonInput of ['{"ifIdle":false}', '{"ifIdle":"yes"}', '{"ifIdle":null}']) {
		const { outputs, exitCode } = await run({ action: "close", sessionId: "sess-1", ifIdle: true, jsonInput });
		expect(exitCode).toBe(2);
		expect(outputs[0]).toMatchObject({
			ok: false,
			error: { code: "usage", category: "usage", outcomeCertainty: "not-applied", retryability: "no" },
		});
	}
	expect(captured.requests).toEqual([]);
	expect(captured.listCalls).toBe(0);

	await run({ action: "close", sessionId: "sess-1", ifIdle: true, jsonInput: '{"ifIdle":true}' });
	expect(captured.requests).toHaveLength(1);
	expect(captured.requests[0]).toMatchObject({ target: { ifIdle: true } });
});

for (const [code, certainty, retryability] of [
	["busy", "retryable", "yes"],
	["not_found", "terminal", "no"],
] as const) {
	test(`broker ${code} remains a definite public refusal`, async () => {
		executeResult = {
			ok: false,
			operation: "session.close",
			certainty,
			error: { code, message: "Private broker details" },
		};
		const { outputs, exitCode } = await run({ action: "close", sessionId: "sess-1", ifIdle: true });
		expect(exitCode).toBe(1);
		expect(outputs[0]).toMatchObject({ ok: false, error: { code, outcomeCertainty: "not-applied", retryability } });
		expect(JSON.stringify(outputs)).not.toContain("Private broker details");
	});
}

test("a busy close recommends inspect, wait and same-key retry; a stale close recommends inspect before any new key", async () => {
	executeResult = {
		ok: false,
		operation: "session.close",
		certainty: "retryable",
		error: { code: "busy", message: "Session is not idle." },
	};
	const busy = (await run({ action: "close", sessionId: "sess-1", ifIdle: true })).outputs[0] as {
		error: { nextSteps: { description: string; argv?: string[] }[] };
	};
	expect(busy.error.nextSteps).toHaveLength(1);
	const busyStep = busy.error.nextSteps[0]!;
	expect(busyStep.argv).toEqual(["sdk", "session", "inspect", "sess-1"]);
	expect(busyStep.description).toContain("rerun the same close command");
	expect(busyStep.description).toContain("Do not switch to a forced close");
	expect(busyStep.description).not.toContain("turn.steer");

	executeResult = {
		ok: false,
		operation: "session.close",
		certainty: "terminal",
		error: { code: "endpoint_stale", message: "Endpoint changed." },
	};
	const stale = (await run({ action: "close", sessionId: "sess-1", ifIdle: true })).outputs[0] as {
		error: { code: string; outcomeCertainty: string; nextSteps: { description: string; argv?: string[] }[] };
	};
	expect(stale.error).toMatchObject({ code: "endpoint_stale", outcomeCertainty: "unknown" });
	// The stale step comes first; the shared unknown-outcome warning follows it.
	expect(stale.error.nextSteps).toHaveLength(2);
	expect(stale.error.nextSteps[1]!.description).toContain("do not blindly retry");
	const staleStep = stale.error.nextSteps[0]!;
	expect(staleStep.argv).toEqual(["sdk", "session", "inspect", "sess-1"]);
	expect(staleStep.description).toContain("terminal for its idempotency key");
	expect(staleStep.description).not.toContain("rerun the same close command");
});

test("a busy raw global session.close gets close guidance: wait-and-retry when busy, terminal key when stale", async () => {
	executeResult = {
		ok: false,
		operation: "session.close",
		certainty: "retryable",
		error: { code: "busy", message: "Session is not idle." },
	};
	const rawClose = async (operation: string) =>
		(
			await run({
				action: "raw",
				rawAction: "global",
				operation,
				idempotencyKey: "raw-close-key",
				jsonInput: '{"sessionId":"sess-1","ifIdle":true}',
			})
		).outputs[0] as {
			error: { code: string; retryability: string; nextSteps: { description: string; argv?: string[] }[] };
		};
	const busy = await rawClose("session.close");
	expect(busy.error).toMatchObject({ code: "busy", retryability: "yes" });
	expect(busy.error.nextSteps).toHaveLength(1);
	expect(busy.error.nextSteps[0]!.argv).toEqual(["sdk", "session", "inspect", "sess-1"]);
	expect(busy.error.nextSteps[0]!.description).toContain("rerun the same close command");
	expect(busy.error.nextSteps[0]!.description).not.toContain("turn.steer");

	// Another busy raw lifecycle operation keeps the generic busy advice.
	executeResult = { ...(executeResult as object), operation: "session.delete" };
	const other = await rawClose("session.delete");
	expect(other.error.code).toBe("busy");
	expect(other.error.nextSteps[0]!.description).toContain("turn.steer");

	// A stale raw close is terminal for its key, like the semantic close.
	executeResult = {
		ok: false,
		operation: "session.close",
		certainty: "terminal",
		error: { code: "endpoint_stale", message: "Endpoint changed." },
	};
	const stale = await rawClose("session.close");
	expect(stale.error.code).toBe("endpoint_stale");
	expect(stale.error.nextSteps[0]!.argv).toEqual(["sdk", "session", "inspect", "sess-1"]);
	expect(stale.error.nextSteps[0]!.description).toContain("terminal for its idempotency key");
	executeResult = { ...(executeResult as object), operation: "session.delete" };
	const staleOther = await rawClose("session.delete");
	expect(staleOther.error.code).toBe("endpoint_stale");
	expect(JSON.stringify(staleOther.error.nextSteps)).not.toContain("terminal for its idempotency key");
});

test("a row without endpoint authority refuses before any close is sent and omits the terminal-key step", async () => {
	const { outputs, exitCode } = await run({ action: "close", sessionId: "sess-no-authority", ifIdle: true });
	expect(exitCode).toBe(1);
	const envelope = outputs[0] as {
		error: { code: string; outcomeCertainty: string; nextSteps: { description: string; argv?: string[] }[] };
	};
	expect(envelope.error).toMatchObject({ code: "endpoint_stale", outcomeCertainty: "not-applied" });
	for (const next of envelope.error.nextSteps)
		expect(next.description).not.toContain("terminal for its idempotency key");
	expect(captured.listCalls).toBe(1);
	expect(captured.requests).toEqual([]);
});

test("a generic not_found code cannot erase prior acceptance proof or invent no-effect proof", async () => {
	for (const [proof, certainty] of [
		[undefined, "unknown"],
		["accepted", "applied"],
	] as const) {
		const rendered = await renderPublicCommandFailure(sdkPublicFailure("not_found", undefined, proof), {
			command: ["sdk", "session", "send"],
			json: true,
		});
		expect(rendered.envelope.error).toMatchObject({ code: "not_found", outcomeCertainty: certainty });
	}
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
