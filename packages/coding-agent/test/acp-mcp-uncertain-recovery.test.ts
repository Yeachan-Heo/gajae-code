import { expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AcpSdkAdapter, acpMcpLaunchFailure } from "../src/sdk/acp";
import { Broker } from "../src/sdk/broker/broker";
import { setLifecycleCommandResolverForTest } from "../src/sdk/broker/lifecycle";
import { lifecycleRequestTimeoutMs } from "../src/sdk/broker/startup-budget";
import { DEFAULT_SDK_REQUEST_TIMEOUT_MS, SdkClientError } from "../src/sdk/client";

test("replays an uncertain ACP lifecycle launch with the same idempotency key", async () => {
	const calls: Array<{ operation: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
	let attempts = 0;
	const client = {
		async global(operation: string, input: Record<string, unknown>, options: Record<string, unknown>) {
			calls.push({ operation, input, options });
			attempts += 1;
			if (attempts === 1) throw new SdkClientError("uncertain_after_send", "response lost after dispatch");
			return { sessionId: "session-reconciled" };
		},
		async close() {},
	};
	const adapter = new AcpSdkAdapter({ client: client as never });
	try {
		await expect(
			adapter.lifecycle(
				"session.create",
				{ cwd: "/tmp/workspace", target: { path: "/tmp/workspace" } },
				"acp-request-1",
			),
		).resolves.toEqual({ sessionId: "session-reconciled" });
		expect(calls).toHaveLength(2);
		// session.create is a startup lifecycle operation, so the adapter attaches the
		// computed broker deadline. The replay must reuse the exact same key AND deadline.
		const expectedTimeoutMs = lifecycleRequestTimeoutMs("session.create", calls[0]!.input);
		if (expectedTimeoutMs === undefined) throw new Error("session.create timeout was not computed");
		expect(expectedTimeoutMs).toBeGreaterThan(0);
		expect(calls[0]?.options).toMatchObject({ idempotencyKey: "acp-request-1", timeoutMs: expectedTimeoutMs });
		expect(calls[0]?.options.deadline).toBeTypeOf("number");
		expect(calls[1]?.options).toMatchObject({
			idempotencyKey: "acp-request-1",
			deadline: calls[0]!.options.deadline,
		});
		expect(calls[1]?.options.timeoutMs).toBeLessThan(expectedTimeoutMs);
		expect(calls[1]?.input).toEqual(calls[0]?.input);
	} finally {
		await adapter.close();
	}
});

test("replay timeout consumes the original lifecycle budget", async () => {
	setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
	const calls: Array<Record<string, unknown>> = [];
	const client = {
		async global(_operation: string, _input: Record<string, unknown>, options: Record<string, unknown>) {
			calls.push(options);
			if (calls.length === 1) {
				setSystemTime(new Date("2026-01-01T00:00:03.000Z"));
				throw new SdkClientError("uncertain_after_send", "response lost after dispatch");
			}
			return { ok: true };
		},
		async close() {},
	};
	const adapter = new AcpSdkAdapter({ client: client as never });
	try {
		await expect(adapter.lifecycle("session.close", {}, "consumed-budget")).resolves.toEqual({ ok: true });
		expect(calls[1]!.timeoutMs).toBe(5_000);
	} finally {
		await adapter.close();
		setSystemTime();
	}
});

test("rethrows the original uncertainty when replay margin is exhausted", async () => {
	setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
	let attempts = 0;
	const original = new SdkClientError("uncertain_after_send", "response lost after dispatch");
	const client = {
		async global() {
			attempts += 1;
			setSystemTime(new Date("2026-01-01T00:00:09.000Z"));
			throw original;
		},
		async close() {},
	};
	const adapter = new AcpSdkAdapter({ client: client as never });
	try {
		await expect(adapter.lifecycle("session.close", {}, "exhausted-budget")).rejects.toBe(original);
		expect(attempts).toBe(1);
	} finally {
		await adapter.close();
		setSystemTime();
	}
});

test("uses the SDK default timeout when lifecycle sizing is unavailable", async () => {
	const optionsSeen: Record<string, unknown>[] = [];
	const client = {
		async global(_operation: string, _input: Record<string, unknown>, options: Record<string, unknown>) {
			optionsSeen.push(options);
			if (optionsSeen.length === 1) throw new SdkClientError("uncertain_after_send", "response lost after dispatch");
			return { ok: true };
		},
		async close() {},
	};
	const adapter = new AcpSdkAdapter({ client: client as never });
	try {
		await expect(adapter.lifecycle("session.close", { readinessTimeoutMs: 1 }, "default-budget")).resolves.toEqual({
			ok: true,
		});
		expect(optionsSeen[0]!.timeoutMs).toBe(DEFAULT_SDK_REQUEST_TIMEOUT_MS);
	} finally {
		await adapter.close();
	}
});

test("the broker replays a committed create failure without attempting a second spawn", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-lifecycle-replay-"));
	const broker = new Broker({ agentDir: path.join(root, "agent") });
	let spawnAttempts = 0;
	try {
		setLifecycleCommandResolverForTest(broker, () => {
			spawnAttempts += 1;
			throw new Error("fixture spawn failure");
		});
		await broker.start();
		const input = { cwd: root };
		const first = await broker.handleRequest("session.create", input, "acp-lost-response");
		// The caller loses this response after dispatch and repeats the identical request.
		const replay = await broker.handleRequest("session.create", input, "acp-lost-response");
		expect(first).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
		expect(replay).toEqual(first);
		expect(spawnAttempts).toBe(1);
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("keeps uncertainty typed when the idempotent replay also loses its response", async () => {
	const client = {
		async global() {
			throw new SdkClientError("uncertain_after_send", "response lost after dispatch");
		},
		async close() {},
	};
	const adapter = new AcpSdkAdapter({ client: client as never });
	try {
		const error = await adapter
			.lifecycle("session.create", { cwd: "/tmp/workspace", target: { path: "/tmp/workspace" } }, "acp-request-2")
			.catch(value => value);
		const attributed = acpMcpLaunchFailure(error, [{ name: "paseo", command: "/bin/true", args: [] }]) as {
			code: string;
		};
		expect(attributed.code).toBe("uncertain_after_send");
	} finally {
		await adapter.close();
	}
});

test("keeps the sent uncertainty when replay reconnects before dispatch", async () => {
	const sentDetails = { id: "sent-request", operation: "session.create", idempotencyKey: "acp-request-3" };
	const original = new SdkClientError("uncertain_after_send", "response lost after dispatch", sentDetails);
	const replayFailure = new SdkClientError(
		"reconnect_exhausted",
		"SDK WebSocket reconnect attempts exhausted",
		new Error("connection refused"),
		{ attemptsConsumed: 2, attemptBudget: 2, elapsedMs: 25, reason: "attempts_exhausted" },
		{ transport: true },
	);
	let attempts = 0;
	const client = {
		async global() {
			attempts += 1;
			throw attempts === 1 ? original : replayFailure;
		},
		async close() {},
	};
	const adapter = new AcpSdkAdapter({ client: client as never });
	try {
		const error = (await adapter
			.lifecycle("session.create", { cwd: "/tmp/workspace", target: { path: "/tmp/workspace" } }, "acp-request-3")
			.catch(value => value)) as SdkClientError & { recovery?: unknown };
		expect(error).toBe(original);
		expect(error.code).toBe("uncertain_after_send");
		expect(error.details).toBe(sentDetails);
		expect(error.recovery).toBe(replayFailure);
		const attributed = acpMcpLaunchFailure(error, [{ name: "paseo", command: "/bin/true", args: [] }]) as {
			code: string;
		};
		expect(attributed.code).toBe("uncertain_after_send");
	} finally {
		await adapter.close();
	}
});

test("keeps the sent uncertainty when replay times out before dispatch", async () => {
	const original = new SdkClientError("uncertain_after_send", "response lost after dispatch", {
		id: "sent-request",
		operation: "session.close",
		idempotencyKey: "acp-request-4",
	});
	const replayFailure = new SdkClientError(
		"timeout",
		"SDK request timed out before dispatch",
		{ requestId: "replay-request", requestSent: false },
		undefined,
		{ transport: true },
	);
	let attempts = 0;
	const client = {
		async global() {
			attempts += 1;
			throw attempts === 1 ? original : replayFailure;
		},
		async close() {},
	};
	const adapter = new AcpSdkAdapter({ client: client as never });
	try {
		const error = (await adapter
			.lifecycle("session.close", {}, "acp-request-4")
			.catch(value => value)) as SdkClientError & {
			recovery?: SdkClientError;
		};
		expect(error).toBe(original);
		expect(error.details).toEqual(original.details);
		expect(error.recovery).toBe(replayFailure);
	} finally {
		await adapter.close();
	}
});
