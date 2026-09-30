import { expect, test } from "bun:test";
import { AcpSdkAdapter, acpMcpLaunchFailure } from "../src/sdk/acp";
import { lifecycleRequestTimeoutMs } from "../src/sdk/broker/startup-budget";
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
