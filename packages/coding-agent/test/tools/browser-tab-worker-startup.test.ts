import { afterEach, describe, expect, it, vi } from "bun:test";
import type { BrowserHandle } from "../../src/tools/browser/registry";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "../../src/tools/browser/tab-protocol";
import {
	__setAcquireTabWorkerDepsForTest,
	__setAfterWorkerInitializationForTest,
	acquireTab,
	clearTabsForTest,
	getTab,
	initializeTabWorkerForTest,
} from "../../src/tools/browser/tab-supervisor";

class FakeStartupWorker {
	#errorHandlers = new Set<(error: Error) => void>();
	#closeHandlers = new Set<() => void>();
	#messageHandlers = new Set<(msg: WorkerOutbound) => void>();
	readonly sent: WorkerInbound[] = [];
	readonly terminate = vi.fn(async () => {});

	send(msg: WorkerInbound): void {
		this.sent.push(msg);
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onClose(handler: () => void): () => void {
		this.#closeHandlers.add(handler);
		return () => this.#closeHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	emit(msg: WorkerOutbound): void {
		for (const handler of this.#messageHandlers) handler(msg);
	}

	emitClose(): void {
		for (const handler of this.#closeHandlers) handler();
	}

	emitError(error: Error): void {
		for (const handler of this.#errorHandlers) handler(error);
	}
}

const initPayload = {
	mode: "headless" as const,
	browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
	safeDir: "/tmp/gjc-puppeteer",
	timeoutMs: 1_000,
};

const readyInfo: ReadyInfo = { targetId: "target", url: "", viewport: { width: 1, height: 1 } };

function fakeBrowser(): BrowserHandle {
	return {
		refCount: 1,
		kind: { kind: "headless", headless: true },
		browser: { wsEndpoint: () => "ws://browser", connected: true, close: vi.fn(async () => {}) },
	} as unknown as BrowserHandle;
}
async function rejectionOf<T>(promise: Promise<T>): Promise<Error> {
	return await promise.then(
		() => {
			throw new Error("Expected promise to reject");
		},
		error => error as Error,
	);
}

describe("browser tab worker startup", () => {
	afterEach(() => clearTabsForTest());

	it("surfaces worker startup errors instead of waiting for the bootstrap timeout", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emitError(new Error("/private/worker/tab-worker-entry.ts TOKEN=secret"));

		const error = await rejectionOf(pending);
		expect(error.message).toBe(
			`Tab worker startup failed (stage=error, mode=native-free, platform=${process.platform}).`,
		);
		expect(error.message).not.toContain("/private/worker");
		expect(error.message).not.toContain("TOKEN=secret");
		expect(worker.sent).toEqual([{ type: "bootstrap", version: 1, mode: "native-free" }]);
	});

	it("does not send init until the actual worker entry confirms bootstrap", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);
		expect(worker.sent).toEqual([{ type: "bootstrap", version: 1, mode: "native-free" }]);

		worker.emit({ type: "bootstrap-ready", version: 1, mode: "native-free" });
		await Bun.sleep(0);
		expect(worker.sent).toEqual([
			{ type: "bootstrap", version: 1, mode: "native-free" },
			{ type: "init", payload: initPayload },
		]);
		worker.emit({ type: "ready", info: readyInfo });

		await expect(pending).resolves.toEqual(readyInfo);
	});

	it("fails closed on ready before bootstrap and duplicate bootstrap confirmation", async () => {
		const earlyReady = new FakeStartupWorker();
		const earlyReadyPending = initializeTabWorkerForTest(earlyReady, initPayload, 1_000);
		earlyReady.emit({ type: "ready", info: readyInfo });
		await expect(earlyReadyPending).rejects.toThrow(
			`Tab worker startup failed (stage=protocol-phase, mode=native-free, platform=${process.platform}).`,
		);
		expect(earlyReady.sent).toEqual([{ type: "bootstrap", version: 1, mode: "native-free" }]);

		const duplicateBootstrap = new FakeStartupWorker();
		const duplicateBootstrapPending = initializeTabWorkerForTest(duplicateBootstrap, initPayload, 1_000);
		duplicateBootstrap.emit({ type: "bootstrap-ready", version: 1, mode: "native-free" });
		duplicateBootstrap.emit({ type: "bootstrap-ready", version: 1, mode: "native-free" });
		await expect(duplicateBootstrapPending).rejects.toThrow(
			`Tab worker startup failed (stage=protocol-phase, mode=native-free, platform=${process.platform}).`,
		);
		expect(duplicateBootstrap.sent).toEqual([
			{ type: "bootstrap", version: 1, mode: "native-free" },
			{ type: "init", payload: initPayload },
		]);
	});

	it("fails closed on invalid bootstrap, close, and bootstrap timeout", async () => {
		const invalid = new FakeStartupWorker();
		const invalidPending = initializeTabWorkerForTest(invalid, initPayload, 1_000);
		invalid.emit({ type: "bootstrap-failed", error: "/private/worker TOKEN=secret" });
		const invalidError = await rejectionOf(invalidPending);
		expect(invalidError.message).toBe(
			`Tab worker startup failed (stage=bootstrap, mode=native-free, platform=${process.platform}).`,
		);
		expect(invalidError.message).not.toContain("/private/worker");
		expect(invalidError.message).not.toContain("TOKEN=secret");

		const closed = new FakeStartupWorker();
		const closedPending = initializeTabWorkerForTest(closed, initPayload, 1_000);
		closed.emit({ type: "closed" });
		await expect(closedPending).rejects.toThrow(
			`Tab worker startup failed (stage=protocol-closed, mode=native-free, platform=${process.platform}).`,
		);

		const timedOut = new FakeStartupWorker();
		await expect(initializeTabWorkerForTest(timedOut, initPayload, 0)).rejects.toThrow(
			`Tab worker startup failed (stage=bootstrap-timeout, mode=native-free, platform=${process.platform}).`,
		);
	});

	it("cleans up and leaves no tab registered when spawn or startup fails without an inline fallback", async () => {
		const browser = fakeBrowser();
		const spawn = vi.fn(async () => {
			throw new Error("worker unavailable");
		});
		__setAcquireTabWorkerDepsForTest(spawn, undefined);
		await expect(acquireTab("spawn-failure", browser, { timeoutMs: 10 })).rejects.toThrow(
			`Tab worker startup failed (stage=spawn, mode=native-free, platform=${process.platform}).`,
		);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(getTab("spawn-failure")).toBeUndefined();

		const worker = new FakeStartupWorker();
		worker.send = msg => {
			worker.sent.push(msg);
			if (msg.type === "bootstrap") worker.emit({ type: "bootstrap-ready", version: 1, mode: "native-free" });
			if (msg.type === "init") worker.emitError(new Error("module startup failed"));
		};
		__setAcquireTabWorkerDepsForTest(async () => worker, undefined);
		await expect(acquireTab("startup-failure", browser, { timeoutMs: 10 })).rejects.toThrow(
			`Tab worker startup failed (stage=error, mode=native-free, platform=${process.platform}).`,
		);
		expect(worker.terminate).toHaveBeenCalledTimes(1);
		expect(getTab("startup-failure")).toBeUndefined();
	});

	it("fails closed when the worker physically closes during the registration handoff", async () => {
		const browser = fakeBrowser();
		const worker = new FakeStartupWorker();
		worker.send = msg => {
			worker.sent.push(msg);
			if (msg.type === "bootstrap") worker.emit({ type: "bootstrap-ready", version: 1, mode: "native-free" });
			if (msg.type === "init") worker.emit({ type: "ready", info: readyInfo });
		};
		__setAcquireTabWorkerDepsForTest(async () => worker, undefined);
		__setAfterWorkerInitializationForTest(() => worker.emitClose());

		await expect(acquireTab("handoff-close", browser, { timeoutMs: 10 })).rejects.toThrow(
			`Tab worker startup failed (stage=physical-close, mode=native-free, platform=${process.platform}).`,
		);
		expect(getTab("handoff-close")).toBeUndefined();
		expect(worker.terminate).toHaveBeenCalledTimes(1);
	});

	it("does not register a worker that fails in the replacement-hold handoff gap", async () => {
		const browser = fakeBrowser();
		const first = new FakeStartupWorker();
		const replacement = new FakeStartupWorker();
		for (const worker of [first, replacement]) {
			worker.send = msg => {
				worker.sent.push(msg);
				if (msg.type === "bootstrap") worker.emit({ type: "bootstrap-ready", version: 1, mode: "native-free" });
				if (msg.type === "init") worker.emit({ type: "ready", info: readyInfo });
				if (msg.type === "close") worker.emit({ type: "closed" });
			};
		}
		const spawn = vi.fn(async () => (spawn.mock.calls.length === 1 ? first : replacement));
		__setAcquireTabWorkerDepsForTest(spawn, undefined);

		await expect(acquireTab("replacement-gap", browser, { timeoutMs: 10 })).resolves.toMatchObject({ created: true });
		first.emitClose();
		__setAfterWorkerInitializationForTest(() => queueMicrotask(() => replacement.emitClose()));

		await expect(acquireTab("replacement-gap", browser, { timeoutMs: 10 })).rejects.toThrow(
			`Tab worker startup failed (stage=physical-close, mode=native-free, platform=${process.platform}).`,
		);
		expect(getTab("replacement-gap")).toBeUndefined();
		expect(replacement.terminate).toHaveBeenCalledTimes(1);
	});
});
