import { afterEach, describe, expect, it } from "bun:test";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import type { Transport, WorkerInbound, WorkerInitPayload, WorkerOutbound } from "../../src/tools/browser/tab-protocol";
import { __setLoadPuppeteerInWorkerForTest, WorkerCore } from "../../src/tools/browser/tab-worker";

/**
 * WorkerCore-level emission tests. These drive the real `#run` success path with a
 * fake puppeteer page/CDP session so the diagnostics display block is proven to
 * actually reach the worker result — the mutation the focused suites did not cover.
 */

interface FakeCdpSession {
	handlers: Map<string, (event: never) => void>;
	enabled: string[];
	detached: boolean;
	on(name: string, handler: (event: never) => void): void;
	send(method: string): Promise<Record<string, never>>;
	detach(): Promise<void>;
}

class FakeTransport {
	readonly sent: Array<WorkerOutbound | WorkerInbound> = [];
	#handlers = new Set<(msg: WorkerOutbound | WorkerInbound) => void>();

	send(msg: WorkerOutbound | WorkerInbound): void {
		this.sent.push(msg);
	}

	onMessage(handler: (msg: WorkerOutbound | WorkerInbound) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	close(): void {}

	dispatch(msg: WorkerInbound): void {
		for (const handler of [...this.#handlers]) handler(msg);
	}

	results(): Array<Extract<WorkerOutbound, { type: "result" }>> {
		return this.sent.filter((msg): msg is Extract<WorkerOutbound, { type: "result" }> => msg.type === "result");
	}

	resultFor(id: string): Extract<WorkerOutbound, { type: "result" }> {
		const result = this.results().find(msg => msg.id === id);
		if (!result) throw new Error(`No result for run ${id}`);
		return result;
	}
}

function createFakeCdpSession(): FakeCdpSession {
	const handlers = new Map<string, (event: never) => void>();
	const session: FakeCdpSession = {
		handlers,
		enabled: [],
		detached: false,
		on(name: string, handler: (event: never) => void): void {
			handlers.set(name, handler);
		},
		async send(method: string): Promise<Record<string, never>> {
			session.enabled.push(method);
			return {};
		},
		async detach(): Promise<void> {
			session.detached = true;
		},
	};
	return session;
}

function createFakePage(session: FakeCdpSession): Page {
	const target = {
		_targetId: "target-1",
		createCDPSession: async (): Promise<CDPSession> => session as unknown as CDPSession,
	};
	const page = {
		url: () => "https://example.com/current?token=secret",
		title: async () => "Fake title",
		viewport: () => ({ width: 1, height: 1 }),
		isClosed: () => false,
		on: () => {},
		off: () => {},
		close: async () => {},
		target: () => target,
		evaluate: async () => undefined,
		goto: async () => {},
		content: async () => "<html></html>",
		locator: () => ({
			setTimeout: () => ({
				click: async () => {},
				waitHandle: async () => ({ type: async () => {}, dispose: async () => {} }),
				fill: async () => {},
			}),
		}),
		$: async () => undefined,
		$eval: async () => undefined,
		$$eval: async () => [],
	};
	return page as unknown as Page;
}

function createFakeBrowser(page: Page): Browser {
	const browser = {
		targets: () => [{ _targetId: "target-1", page: async () => page }],
		connected: false,
		disconnect: () => {},
		wsEndpoint: () => "ws://fake",
		newPage: async () => page,
		close: async () => {},
	};
	return browser as unknown as Browser;
}

const initPayload: WorkerInitPayload = {
	mode: "attach",
	browserWSEndpoint: "ws://fake",
	safeDir: "/tmp/gjc-puppeteer-test",
	targetId: "target-1",
	runtimeDiagnostics: true,
};

function runMessage(id: string, code: string): Extract<WorkerInbound, { type: "run" }> {
	return { type: "run", id, name: "main", code, timeoutMs: 5_000, session: { cwd: "/tmp" } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		// The worker resolves messages asynchronously, so predicates like resultFor()
		// may throw while a result is still in flight — retry instead of failing fast.
		try {
			if (predicate()) return;
		} catch {
			// result not yet available; poll again below
		}
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await Bun.sleep(1);
	}
}

function diagnosticsText(result: Extract<WorkerOutbound, { type: "result" }>): string | undefined {
	if (!result.ok) return undefined;
	return (result.payload.displays as Array<{ type: "text"; text: string }>)
		.filter(display => display.type === "text")
		.find(display => display.text.includes("runtimeDiagnostics"))?.text;
}

describe("browser tab worker runtime diagnostics emission", () => {
	afterEach(() => {
		__setLoadPuppeteerInWorkerForTest(undefined);
	});

	it("emits drained diagnostics into the successful result after user displays, with ordering intact", async () => {
		const session = createFakeCdpSession();
		const page = createFakePage(session);
		const transport = new FakeTransport();
		__setLoadPuppeteerInWorkerForTest(async () => ({ connect: async () => createFakeBrowser(page) }) as never);

		new WorkerCore(transport as unknown as Transport);
		transport.dispatch({ type: "init", payload: initPayload });
		await waitFor(() => transport.sent.some(msg => msg.type === "ready"));
		expect(session.enabled).toEqual(["Runtime.enable"]);

		// Page events land in the mailbox before the run drains them.
		session.handlers.get("Runtime.exceptionThrown")?.({
			exceptionDetails: {
				url: "https://example.com/account/SESSION_TOKEN_ABC123?token=secret",
				lineNumber: 3,
				exception: { className: "TypeError", description: "secret message" },
			},
		} as never);
		session.handlers.get("Runtime.consoleAPICalled")?.({
			type: "error",
			stackTrace: { callFrames: [{ url: "https://example.com/ui.js?token=secret", lineNumber: 8 }] },
		} as never);

		transport.dispatch(runMessage("run-1", "display({ first: 1 }); 1 + 1"));
		await waitFor(() => transport.resultFor("run-1").ok);

		const result = transport.resultFor("run-1");
		if (!result.ok) throw new Error("run-1 failed");
		expect(result.payload.returnValue).toBe(2);

		// Ordering: user display first, diagnostics block second, then the return value
		// is appended by BrowserTool (not part of the worker displays).
		const displays = result.payload.displays as Array<{ type: "text"; text: string }>;
		expect(displays).toHaveLength(2);
		expect(displays[0]).toMatchObject({ type: "text" });
		expect(displays[0].text).toContain("first");
		expect(displays[1].text).toContain('"runtimeDiagnostics"');

		const block = JSON.parse(displays[1].text) as {
			runtimeDiagnostics: Array<{ kind: string; url: string }>;
			runtimeDiagnosticsDropped: number;
			runtimeDiagnosticsTruncated?: boolean;
		};
		expect(block.runtimeDiagnostics.map(entry => entry.kind)).toEqual(["pageerror", "console-error"]);
		expect(block.runtimeDiagnostics.every(entry => entry.url === "https://example.com")).toBe(true);
		expect(block.runtimeDiagnosticsDropped).toBe(0);
		expect(block.runtimeDiagnosticsTruncated).toBeUndefined();
		// No pathname, query, argument, message, or class secret survives to the result.
		expect(displays[1].text).not.toContain("SESSION_TOKEN");
		expect(displays[1].text).not.toContain("secret");

		transport.dispatch({ type: "close" });
		await waitFor(() => session.detached && transport.sent.some(msg => msg.type === "closed"));
		expect(transport.sent.some(msg => msg.type === "closed")).toBe(true);
	});

	it("drains on success: the next successful run without new events emits no diagnostics", async () => {
		const session = createFakeCdpSession();
		const transport = new FakeTransport();
		__setLoadPuppeteerInWorkerForTest(
			async () => ({ connect: async () => createFakeBrowser(createFakePage(session)) }) as never,
		);

		new WorkerCore(transport as unknown as Transport);
		transport.dispatch({ type: "init", payload: initPayload });
		await waitFor(() => transport.sent.some(msg => msg.type === "ready"));

		session.handlers.get("Runtime.exceptionThrown")?.({
			exceptionDetails: { exception: { className: "Error" } },
		} as never);
		transport.dispatch(runMessage("run-1", "1 + 1"));
		await waitFor(() => transport.resultFor("run-1").ok);
		expect(diagnosticsText(transport.resultFor("run-1"))).toContain("pageerror");

		// No new events: run-2 must not re-emit the already-drained entries.
		transport.dispatch(runMessage("run-2", "2 + 2"));
		await waitFor(() => transport.resultFor("run-2").ok);
		expect(diagnosticsText(transport.resultFor("run-2"))).toBeUndefined();
	});

	it("retains the mailbox after a failed run and drains it on the next success", async () => {
		const session = createFakeCdpSession();
		const transport = new FakeTransport();
		__setLoadPuppeteerInWorkerForTest(
			async () => ({ connect: async () => createFakeBrowser(createFakePage(session)) }) as never,
		);

		new WorkerCore(transport as unknown as Transport);
		transport.dispatch({ type: "init", payload: initPayload });
		await waitFor(() => transport.sent.some(msg => msg.type === "ready"));

		session.handlers.get("Runtime.exceptionThrown")?.({
			exceptionDetails: { exception: { className: "ReferenceError" } },
		} as never);

		// The failing run must not drain the mailbox.
		transport.dispatch(runMessage("run-1", "throw new Error('boom')"));
		await waitFor(() => !transport.resultFor("run-1").ok);
		const failed = transport.resultFor("run-1");
		if (failed.ok) throw new Error("expected run-1 to fail");

		// Retention: the next successful run still surfaces the earlier page error.
		transport.dispatch(runMessage("run-2", "40 + 2"));
		await waitFor(() => transport.resultFor("run-2").ok);
		const text = diagnosticsText(transport.resultFor("run-2"));
		expect(text).toBeDefined();
		const block = JSON.parse(text as string) as { runtimeDiagnostics: Array<{ kind: string }> };
		expect(block.runtimeDiagnostics).toHaveLength(1);
		expect(block.runtimeDiagnostics[0]?.kind).toBe("pageerror");
	});

	it("bounds the emitted block even when a page reports a 300k-byte pathname", async () => {
		const session = createFakeCdpSession();
		const transport = new FakeTransport();
		__setLoadPuppeteerInWorkerForTest(
			async () => ({ connect: async () => createFakeBrowser(createFakePage(session)) }) as never,
		);

		new WorkerCore(transport as unknown as Transport);
		transport.dispatch({ type: "init", payload: initPayload });
		await waitFor(() => transport.sent.some(msg => msg.type === "ready"));

		const hugePath = `${"a".repeat(300_000)}`;
		session.handlers.get("Runtime.exceptionThrown")?.({
			exceptionDetails: { url: `https://example.com/${hugePath}` },
		} as never);

		transport.dispatch(runMessage("run-1", "1 + 1"));
		await waitFor(() => transport.resultFor("run-1").ok);
		const text = diagnosticsText(transport.resultFor("run-1"));
		expect(text).toBeDefined();
		expect(Buffer.byteLength(text as string, "utf8")).toBeLessThanOrEqual(4 * 1024);
		expect(text).not.toContain(hugePath);
	});

	it("does not instrument or emit anything when diagnostics are not opted in", async () => {
		const session = createFakeCdpSession();
		const transport = new FakeTransport();
		__setLoadPuppeteerInWorkerForTest(
			async () => ({ connect: async () => createFakeBrowser(createFakePage(session)) }) as never,
		);

		new WorkerCore(transport as unknown as Transport);
		transport.dispatch({
			type: "init",
			payload: { ...initPayload, runtimeDiagnostics: false },
		});
		await waitFor(() => transport.sent.some(msg => msg.type === "ready"));

		// Opt-in off: no CDP Runtime subscription happens at all.
		expect(session.enabled).toEqual([]);
		expect(session.handlers.size).toBe(0);

		transport.dispatch(runMessage("run-1", "1 + 1"));
		await waitFor(() => transport.resultFor("run-1").ok);
		const result = transport.resultFor("run-1");
		if (!result.ok) throw new Error("run-1 failed");
		expect(diagnosticsText(result)).toBeUndefined();
	});
});
