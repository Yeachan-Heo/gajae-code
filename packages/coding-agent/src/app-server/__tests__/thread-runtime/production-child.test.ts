import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import { loadThread } from "../../thread-runtime/child-bridge";
import { createProductionThreadStartAdapter } from "../../thread-runtime/production-child";
import { ThreadRuntimeManager } from "../../thread-runtime/thread-runtime-manager";

// These tests create REAL GJC sessions. No session double is used: the production adapter's whole
// purpose is that `thread/start` is backed by a real session, so a fake here would prove nothing.
const temporary = () => mkdtempSync(join(tmpdir(), "gjc-production-child-"));

test("the production adapter loads a real session and answers thread/start for both profiles", async () => {
	const agentDir = temporary();
	const cwd = temporary();
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	const adapter = { manager, ...createProductionThreadStartAdapter({ agentDir }) };
	try {
		for (const experimentalApi of [false, true]) {
			const runtime = await loadThread(adapter, { connectionId: "conn-a", params: { cwd }, experimentalApi });
			expect(runtime.threadId.length).toBeGreaterThan(0);
			const validate = stableValidators.clientRequestResults["thread/start"];
			// The stable validator is the strict subset both profiles must satisfy.
			if (!experimentalApi) expect(validate?.(runtime.response)).toBe(true);
			const thread = (runtime.response as { thread: Record<string, unknown> }).thread;
			expect(thread.cwd).toBe(cwd);
			expect(thread.sessionId).toBe(runtime.threadId);
			// Ownership is `attached`: an in-process child has no separate endpoint to fence.
			expect(manager.get(runtime.threadId)?.ownership).toBe("attached");
			expect(manager.get(runtime.threadId)?.client).toBeDefined();
			expect(manager.remove(runtime.threadId)).toBe(true);
		}
		expect(manager.loaded()).toEqual([]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}, 120_000);

test("the production adapter fails closed when the session cannot be created", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	const adapter = {
		manager,
		...createProductionThreadStartAdapter({
			createSession: async () => {
				throw new Error("session startup failed");
			},
		}),
	};
	await expect(loadThread(adapter, { connectionId: "conn-a", params: { cwd: temporary() } })).rejects.toThrow();
	// Nothing may be published when creation fails.
	expect(manager.loaded()).toEqual([]);
});
