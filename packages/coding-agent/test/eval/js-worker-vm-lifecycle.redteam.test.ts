import { afterEach, describe, expect, it } from "bun:test";
import {
	disposeAllVmContexts,
	executeInVmContext,
	liveVmContextCount,
	resetVmContext,
} from "../../src/eval/js/context-manager";
import { WorkerCore } from "../../src/eval/js/worker-core";
import type { Transport, WorkerInbound, WorkerOutbound } from "../../src/eval/js/worker-protocol";
import type { ToolSession } from "../../src/tools";
import { ToolError } from "../../src/tools/tool-errors";

interface FakeTool {
	execute(
		toolCallId: string,
		args: unknown,
		signal: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

function makeSession(tools: Record<string, FakeTool> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		settings: { get: () => undefined } as unknown as ToolSession["settings"],
		getToolByName: (name: string) => tools[name],
	} as unknown as ToolSession;
}

async function expectSettles<T>(promise: Promise<T>, label: string, timeoutMs = 1_500): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`${label} did not settle`);
		}),
	]);
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 1_500): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() > deadline) throw new Error(`${label} did not become true`);
		await Bun.sleep(5);
	}
}

describe("JS worker VM lifecycle redteam", () => {
	afterEach(async () => {
		delete process.env.GAJAE_CODE_JS_EVAL_INLINE_WORKER;
		await disposeAllVmContexts();
	});

	it("coalesces many concurrent first acquires for one sessionKey to exactly one worker and returns to baseline after dispose", async () => {
		const baseline = liveVmContextCount();
		const key = `u5-redteam-concurrent-${crypto.randomUUID()}`;
		const session = makeSession();
		const results = await Promise.all(
			Array.from({ length: 24 }, (_unused, index) =>
				executeInVmContext({
					sessionKey: key,
					sessionId: key,
					cwd: process.cwd(),
					session,
					code: `${index}`,
					filename: `concurrent-${index}.js`,
					runState: {},
				}),
			),
		);
		expect(results).toHaveLength(24);
		expect(liveVmContextCount()).toBe(baseline + 1);
		await disposeAllVmContexts();
		expect(liveVmContextCount()).toBe(baseline);
	});

	it("rejects pending and queued runs on reset without hanging and releases the queue for a fresh worker", async () => {
		const key = `u5-redteam-reset-${crypto.randomUUID()}`;
		const session = makeSession();
		const pending = executeInVmContext({
			sessionKey: key,
			sessionId: key,
			cwd: process.cwd(),
			session,
			code: "await new Promise(() => {})",
			filename: "pending-reset.js",
			runState: {},
		});
		const queued = Array.from({ length: 5 }, (_unused, index) =>
			executeInVmContext({
				sessionKey: key,
				sessionId: key,
				cwd: process.cwd(),
				session,
				code: `${index}`,
				filename: `queued-reset-${index}.js`,
				runState: {},
			}),
		);
		await waitUntil(() => liveVmContextCount() > 0, "worker start");
		await waitUntil(() => liveVmContextCount() === 1, "worker ready");
		await resetVmContext(key);
		const settled = await expectSettles(
			Promise.all([pending, ...queued].map(run => run.catch(error => error))),
			"reset batch",
		);
		expect(settled).toHaveLength(6);
		expect(settled.every(value => value instanceof Error)).toBe(true);
		expect(liveVmContextCount()).toBe(0);
		const fresh = await expectSettles(
			executeInVmContext({
				sessionKey: key,
				sessionId: key,
				cwd: process.cwd(),
				session,
				code: "41 + 1",
				filename: "fresh-after-reset.js",
				runState: {},
			}),
			"fresh run after reset",
		);
		expect(fresh).toEqual({ value: undefined });
	});

	it("runs a reset:true cell against an existing VM after wiping previous state", async () => {
		const key = `u5-redteam-reset-own-caller-${crypto.randomUUID()}`;
		const session = makeSession();
		await executeInVmContext({
			sessionKey: key,
			sessionId: key,
			cwd: process.cwd(),
			session,
			code: "globalThis.__resetSentinel = 1",
			filename: "seed-before-own-reset.js",
			runState: {},
		});
		await expectSettles(
			executeInVmContext({
				sessionKey: key,
				sessionId: key,
				cwd: process.cwd(),
				session,
				reset: true,
				code: "if (globalThis.__resetSentinel !== undefined) throw new Error('state was not reset'); globalThis.__afterOwnReset = 7;",
				filename: "own-reset-runs.js",
				runState: {},
			}),
			"own reset run",
		);
		await expectSettles(
			executeInVmContext({
				sessionKey: key,
				sessionId: key,
				cwd: process.cwd(),
				session,
				code: "if (globalThis.__afterOwnReset !== 7) throw new Error('reset cell did not execute')",
				filename: "after-own-reset.js",
				runState: {},
			}),
			"post-reset verification run",
		);
	});

	it("observes the local pending rejection when worker send throws", async () => {
		const OriginalWorker = globalThis.Worker;
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		(globalThis as unknown as { Worker: typeof Worker }).Worker = class {
			#handlers = new Set<(event: MessageEvent) => void>();

			constructor() {
				void Bun.sleep(0).then(() => {
					for (const handler of this.#handlers) handler({ data: { type: "ready" } } as MessageEvent);
				});
			}

			postMessage(msg: WorkerInbound): void {
				if (msg.type === "run") throw new Error("synthetic send failure");
			}

			addEventListener(type: string, handler: EventListener): void {
				if (type === "message") this.#handlers.add(handler as (event: MessageEvent) => void);
			}

			removeEventListener(type: string, handler: EventListener): void {
				if (type === "message") this.#handlers.delete(handler as (event: MessageEvent) => void);
			}

			terminate(): void {
				this.#handlers.clear();
			}
		} as unknown as typeof Worker;
		try {
			const result = await expectSettles(
				executeInVmContext({
					sessionKey: `u5-redteam-send-failure-${crypto.randomUUID()}`,
					sessionId: "send-failure",
					cwd: process.cwd(),
					session: makeSession(),
					code: "1",
					filename: "send-failure.js",
					runState: {},
				}).catch(error => error),
				"send failure rejection",
			);
			expect(result).toBeInstanceOf(Error);
			expect(String((result as Error).message)).toContain("synthetic send failure");
			await Bun.sleep(20);
			expect(unhandled).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			(globalThis as unknown as { Worker: typeof Worker }).Worker = OriginalWorker;
		}
	});

	it("rejects pending and queued runs on abort/worker kill without hanging and releases the queue", async () => {
		const key = `u5-redteam-kill-${crypto.randomUUID()}`;
		const session = makeSession();
		const controller = new AbortController();
		const pending = executeInVmContext({
			sessionKey: key,
			sessionId: key,
			cwd: process.cwd(),
			session,
			code: "await new Promise(() => {})",
			filename: "pending-kill.js",
			runState: { signal: controller.signal },
		});
		const queued = Array.from({ length: 5 }, (_unused, index) =>
			executeInVmContext({
				sessionKey: key,
				sessionId: key,
				cwd: process.cwd(),
				session,
				code: `${index}`,
				filename: `queued-kill-${index}.js`,
				runState: {},
			}),
		);
		await waitUntil(() => liveVmContextCount() > 0, "worker start");
		controller.abort(new Error("redteam abort"));
		const settled = await expectSettles(
			Promise.all([pending, ...queued].map(run => run.catch(error => error))),
			"kill batch",
		);
		expect(settled).toHaveLength(6);
		expect(settled.every(value => value instanceof Error)).toBe(true);
		const fresh = await expectSettles(
			executeInVmContext({
				sessionKey: key,
				sessionId: key,
				cwd: process.cwd(),
				session,
				code: "'queue-released'",
				filename: "fresh-after-kill.js",
				runState: {},
			}),
			"fresh run after kill",
		);
		expect(fresh).toEqual({ value: undefined });
	});

	it("settles a host-side pending tool call when the run aborts before the tool replies", async () => {
		const key = `u5-redteam-tool-abort-${crypto.randomUUID()}`;
		const controller = new AbortController();
		let toolStarted = false;
		let toolRejected: unknown;
		const session = makeSession({
			slow: {
				async execute(_toolCallId, _args, signal) {
					toolStarted = true;
					return await new Promise((_resolve, reject) => {
						const onAbort = (): void => {
							toolRejected = signal.reason;
							reject(signal.reason);
						};
						signal.addEventListener("abort", onAbort, { once: true });
					});
				},
			},
		});
		const run = executeInVmContext({
			sessionKey: key,
			sessionId: key,
			cwd: process.cwd(),
			session,
			code: "await tool.slow({ phase: 'before-abort' })",
			filename: "tool-abort.js",
			runState: { signal: controller.signal },
		});
		await waitUntil(() => toolStarted, "tool call start");
		controller.abort(new ToolError("abort while tool pending"));
		const result = await expectSettles(
			run.catch(error => error),
			"tool-abort run",
		);
		expect(result).toBeInstanceOf(Error);
		expect(toolRejected).toBeInstanceOf(Error);
		expect(liveVmContextCount()).toBe(0);
	});

	it("unsubscribes WorkerCore transport listeners on close so reset/dispose/timeout paths cannot leak handlers", async () => {
		const hostHandlers = new Set<(msg: WorkerInbound) => void>();
		const outbound: WorkerOutbound[] = [];
		let unsubscribeCalls = 0;
		let closeCalls = 0;
		const transport: Transport = {
			send: msg => outbound.push(msg),
			onMessage: handler => {
				hostHandlers.add(handler);
				return () => {
					unsubscribeCalls += 1;
					hostHandlers.delete(handler);
				};
			},
			close: () => {
				closeCalls += 1;
			},
		};
		new WorkerCore(transport);
		expect(hostHandlers.size).toBe(1);
		for (const handler of [...hostHandlers]) handler({ type: "close" });
		expect(unsubscribeCalls).toBe(1);
		expect(closeCalls).toBe(1);
		expect(hostHandlers.size).toBe(0);
		expect(outbound.some(msg => msg.type === "closed")).toBe(true);
	});

	it("fails closed when inline-worker fallback would be needed in production without the explicit test env", async () => {
		const OriginalWorker = globalThis.Worker;
		delete process.env.GAJAE_CODE_JS_EVAL_INLINE_WORKER;
		(globalThis as unknown as { Worker: typeof Worker }).Worker = class {
			constructor() {
				throw new Error("synthetic worker spawn failure");
			}
		} as unknown as typeof Worker;
		try {
			await expect(
				executeInVmContext({
					sessionKey: `u5-redteam-fail-closed-${crypto.randomUUID()}`,
					sessionId: "fail-closed",
					cwd: process.cwd(),
					session: makeSession(),
					code: "1",
					filename: "fail-closed.js",
					runState: {},
				}),
			).rejects.toThrow(
				/inline fallback is disabled.*cannot interrupt synchronous user code.*synthetic worker spawn failure/,
			);
		} finally {
			(globalThis as unknown as { Worker: typeof Worker }).Worker = OriginalWorker;
		}
	});
});
