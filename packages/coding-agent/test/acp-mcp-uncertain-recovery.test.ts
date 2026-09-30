import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AcpSdkAdapter, acpMcpLaunchFailure } from "../src/sdk/acp";
import { lifecycleRequestTimeoutMs } from "../src/sdk/broker/startup-budget";
import { Broker } from "../src/sdk/broker/broker";
import { setLifecycleCommandResolverForTest } from "../src/sdk/broker/lifecycle";
import { SdkClientError } from "../src/sdk/client";

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
		expect(expectedTimeoutMs).toBeGreaterThan(0);
		expect(calls[0]?.options).toEqual({ idempotencyKey: "acp-request-1", timeoutMs: expectedTimeoutMs });
		expect(calls[1]?.options).toEqual(calls[0]!.options);
		expect(calls[1]?.input).toEqual(calls[0]?.input);
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
