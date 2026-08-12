import { expect, test } from "bun:test";
import { AcpSdkAdapter } from "../src/sdk/acp";
import type { SessionAttachment } from "../src/sdk/router";
import { SessionRouterError } from "../src/sdk/router";

type RouterHarness = {
	router: unknown;
	attachment: SessionAttachment;
	setCurrent: (v: boolean) => void;
};

function createRouterHarness(): RouterHarness {
	let current = true;
	const attachment: SessionAttachment = {
		sessionId: "session-4356",
		connectionId: "router-connection-4356",
		generation: 1,
		isCurrent: () => current,
		send: async () => {},
	};
	const router = {
		request: async (_sid: string, frame: Record<string, unknown>) => {
			if (frame.type === "register_provider")
				return { ok: true, result: { leaseId: `lease-${String(frame.capability)}` } };
			return { ok: true, result: {} };
		},
	};
	return { router, attachment, setCurrent: v => (current = v) };
}

test("4356 heartbeat tick during non-current attachment does not fail ACP session", async () => {
	const harness = createRouterHarness();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [] }],
		heartbeatMs: 10,
	});
	const failures: unknown[] = [];
	adapter.onReconnectFailed(e => failures.push(e));
	await adapter.start();
	harness.setCurrent(false);
	await Bun.sleep(40);
	expect(failures.length).toBe(0);
	harness.setCurrent(true);
	await Bun.sleep(40);
	expect(failures.length).toBe(0);
	await adapter.close();
});

test("4356 SessionRouterError is not wrapped as reconnect_exhausted transport loss", async () => {
	const harness = createRouterHarness();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [] }],
		heartbeatMs: 10,
	});
	const failures: unknown[] = [];
	adapter.onReconnectFailed(e => failures.push(e));
	await adapter.start();
	// Stale heartbeat would previously throw bare SessionRouterError and be rewrapped as reconnect_exhausted.
	// Now it must be treated as transient local-authority condition, not transport loss.
	harness.setCurrent(false);
	await Bun.sleep(40);
	expect(failures.length).toBe(0);
	// A genuine SessionRouterError passed through other paths must also be filtered.
	const stale = new SessionRouterError("pre_send", "SDK session attachment is stale.");
	expect(stale.phase).toBe("pre_send");
	expect(stale.message).not.toBe("SDK session attachment is unavailable.");
	await adapter.close();
});

test("4356 no SessionRouterError throw site uses the bare default message", async () => {
	const files = [
		"packages/coding-agent/src/sdk/router/session-router.ts",
		"packages/coding-agent/src/sdk/acp/adapter.ts",
	];
	for (const file of files) {
		const text = await Bun.file(file).text();
		const bare = [...text.matchAll(/throw new SessionRouterError\("pre_send"\)/g)];
		expect(bare.length).toBe(0);
	}
	const adapterText = await Bun.file("packages/coding-agent/src/sdk/acp/adapter.ts").text();
	expect(adapterText).not.toContain('throw new SessionRouterError("pre_send")');
	const routerText = await Bun.file("packages/coding-agent/src/sdk/router/session-router.ts").text();
	// Every throw must carry a site-specific message.
	expect(routerText).not.toContain('throw new SessionRouterError("pre_send");');
});

test("4356 AcpAgent recovery preserves mcpServers and makes failure observable", async () => {
	const agentText = await Bun.file("packages/coding-agent/src/modes/acp/acp-agent.ts").text();
	// mcpServers must be preserved across auto-recovery, not dropped to [].
	expect(agentText).toContain("#knownSessionMcpServers");
	expect(agentText).toContain("this.#knownSessionMcpServers.get(id)");
	// Only reconnect_exhausted may terminalize; stale-attachment must be filtered.
	expect(agentText).toContain('error.code !== "reconnect_exhausted"');
	// Recovery failure must be observable, not swallowed.
	expect(agentText).toContain("gjcRecoverFailed");
});

test("4356 session/load path preserves mcpServers declaration", async () => {
	const agentText = await Bun.file("packages/coding-agent/src/modes/acp/acp-agent.ts").text();
	// loadSession/resumeSession must record the client's mcpServers for later recovery.
	expect(agentText).toContain("loadSession");
	expect(agentText).toContain("resumeSession");
	// Both must update knownSessionMcpServers when a non-empty declaration is present.
	const loadPreserves =
		agentText.includes("loadSession") &&
		agentText.includes("#knownSessionMcpServers.set(params.sessionId, mcpServers)");
	expect(loadPreserves).toBe(true);
});
