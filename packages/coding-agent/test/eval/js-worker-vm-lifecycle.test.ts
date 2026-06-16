import { afterEach, describe, expect, it } from "bun:test";
import {
	disposeAllVmContexts,
	disposeVmContextsByOwner,
	executeInVmContext,
	liveVmContextCount,
} from "../../src/eval/js/context-manager";
import { WorkerCore } from "../../src/eval/js/worker-core";
import type { Transport, WorkerInbound, WorkerOutbound } from "../../src/eval/js/worker-protocol";
import { disposeAllResourceOwners } from "../../src/runtime/process-lifecycle";
import type { ToolSession } from "../../src/tools";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		settings: { get: () => undefined } as unknown as ToolSession["settings"],
		getToolByName: () => undefined,
	} as unknown as ToolSession;
}

async function expectSettles<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(1_000).then(() => {
			throw new Error(`${label} did not settle`);
		}),
	]);
}

describe("JS worker VM lifecycle", () => {
	afterEach(async () => {
		delete process.env.GAJAE_CODE_JS_EVAL_INLINE_WORKER;
		await disposeAllVmContexts();
	});

	it("coalesces concurrent first acquire to one worker", async () => {
		const key = `u5-concurrent-${crypto.randomUUID()}`;
		const session = makeSession();
		await Promise.all([
			executeInVmContext({
				sessionKey: key,
				sessionId: key,
				cwd: process.cwd(),
				session,
				code: "1",
				filename: "a.js",
				runState: {},
			}),
			executeInVmContext({
				sessionKey: key,
				sessionId: key,
				cwd: process.cwd(),
				session,
				code: "2",
				filename: "b.js",
				runState: {},
			}),
		]);
		expect(liveVmContextCount()).toBe(1);
	});

	it("worker kill rejects pending and queued runs without hanging", async () => {
		const key = `u5-kill-${crypto.randomUUID()}`;
		const session = makeSession();
		const controller = new AbortController();
		const first = executeInVmContext({
			sessionKey: key,
			sessionId: key,
			cwd: process.cwd(),
			session,
			code: "await new Promise(() => {})",
			filename: "blocked.js",
			runState: { signal: controller.signal },
		});
		const second = executeInVmContext({
			sessionKey: key,
			sessionId: key,
			cwd: process.cwd(),
			session,
			code: "1",
			filename: "queued.js",
			runState: {},
		});
		while (liveVmContextCount() === 0) await Bun.sleep(5);
		await Bun.sleep(20);
		controller.abort();
		await expectSettles(
			first.catch(error => error),
			"pending run",
		);
		const queuedResult = await expectSettles(
			second.catch(error => error),
			"queued run",
		);
		expect(queuedResult).toBeInstanceOf(Error);
	});

	it("disposes live VM contexts through resource-owner cleanup", async () => {
		const key = `u5-owner-${crypto.randomUUID()}`;
		await executeInVmContext({
			sessionKey: key,
			sessionId: key,
			cwd: process.cwd(),
			session: makeSession(),
			code: "globalThis.__u5 = 1",
			filename: "owner.js",
			runState: {},
		});
		expect(liveVmContextCount()).toBe(1);
		await disposeAllResourceOwners();
		expect(liveVmContextCount()).toBe(0);
	});

	it("disposes live VM contexts by eval owner rather than session key", async () => {
		const baseline = liveVmContextCount();
		const ownerId = `u5-owner-id-${crypto.randomUUID()}`;
		await executeInVmContext({
			sessionKey: `js:session:file:cwd:${process.cwd()}`,
			sessionId: "session-key-does-not-match-owner",
			ownerId,
			cwd: process.cwd(),
			session: makeSession(),
			code: "globalThis.__u5Owner = 1",
			filename: "owner-dispose.js",
			runState: {},
		});
		expect(liveVmContextCount()).toBe(baseline + 1);
		await disposeVmContextsByOwner(ownerId);
		expect(liveVmContextCount()).toBe(baseline);
	});

	it("re-registers VM resource cleanup after global resource disposal", async () => {
		await executeInVmContext({
			sessionKey: `u5-reregister-first-${crypto.randomUUID()}`,
			sessionId: "first",
			cwd: process.cwd(),
			session: makeSession(),
			code: "1",
			filename: "first.js",
			runState: {},
		});
		expect(liveVmContextCount()).toBe(1);
		await disposeAllResourceOwners();
		expect(liveVmContextCount()).toBe(0);
		await executeInVmContext({
			sessionKey: `u5-reregister-second-${crypto.randomUUID()}`,
			sessionId: "second",
			cwd: process.cwd(),
			session: makeSession(),
			code: "2",
			filename: "second.js",
			runState: {},
		});
		expect(liveVmContextCount()).toBe(1);
		await disposeAllResourceOwners();
		expect(liveVmContextCount()).toBe(0);
	});

	it("settles run-local pending tool promises when a run ends", async () => {
		const hostHandlers = new Set<(msg: WorkerInbound) => void>();
		const outbound: WorkerOutbound[] = [];
		const transport: Transport = {
			send: msg => outbound.push(msg),
			onMessage: handler => {
				hostHandlers.add(handler);
				return () => hostHandlers.delete(handler);
			},
			close: () => undefined,
		};
		new WorkerCore(transport);
		for (const handler of hostHandlers)
			handler({ type: "init", snapshot: { cwd: process.cwd(), sessionId: "tools" } });
		for (const handler of hostHandlers) {
			handler({
				type: "run",
				runId: "r1",
				code: "globalThis.toolPromise = tool.never({}).catch(() => undefined); 'done';",
				filename: "tool.js",
				snapshot: { cwd: process.cwd(), sessionId: "tools" },
			});
		}
		await expectSettles(
			(async () => {
				while (!outbound.some(msg => msg.type === "result")) await Bun.sleep(5);
			})(),
			"tool run",
		);
		const toolCall = outbound.find(
			(msg): msg is Extract<WorkerOutbound, { type: "tool-call" }> => msg.type === "tool-call",
		);
		expect(toolCall).toBeDefined();
		for (const handler of hostHandlers)
			handler({ type: "tool-reply", id: toolCall!.id, reply: { ok: true, value: "late" } });
		expect(outbound.some(msg => msg.type === "tool-call")).toBe(true);
		expect(outbound.some(msg => msg.type === "result" && msg.ok)).toBe(true);
	});

	it("fails closed when Worker construction fails outside explicit inline test mode", async () => {
		const OriginalWorker = globalThis.Worker;
		(globalThis as unknown as { Worker: typeof Worker }).Worker = class {
			constructor() {
				throw new Error("worker unavailable");
			}
		} as unknown as typeof Worker;
		try {
			await expect(
				executeInVmContext({
					sessionKey: `u5-fail-${crypto.randomUUID()}`,
					sessionId: "fail",
					cwd: process.cwd(),
					session: makeSession(),
					code: "1",
					filename: "fail.js",
					runState: {},
				}),
			).rejects.toThrow("inline fallback is disabled");
		} finally {
			(globalThis as unknown as { Worker: typeof Worker }).Worker = OriginalWorker;
		}
	});
});
