import { describe, expect, it } from "bun:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import type { AcpSdkAdapter } from "../src/sdk/acp";
import type { SdkClient } from "../src/sdk/client";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function adapter(label: string): AcpSdkAdapter {
	return {
		global: async () => ({ sessions: [{ sessionId: label, locator: { cwd: process.cwd() } }] }),
		close: async () => {},
	} as unknown as AcpSdkAdapter;
}

describe("ACP broker prewarm", () => {
	it("retries a foreground broker caller after a joined prewarm failure", async () => {
		const first = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		const second = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		let calls = 0;
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{
				brokerConnector: () => {
					calls += 1;
					return calls === 1 ? first.promise : second.promise;
				},
			},
		);

		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		expect(calls).toBe(1);
		const foreground = agent.listSessions({});
		first.reject(new Error("endpoint A failed"));
		second.resolve({ adapter: adapter("endpoint B"), client: {} as SdkClient });

		await expect(foreground).resolves.toEqual(
			expect.objectContaining({
				sessions: [expect.objectContaining({ sessionId: "endpoint B" })],
			}),
		);
		expect(calls).toBe(2);
	});

	it("does not retry a foreground attempt that starts after prewarm failure", async () => {
		const first = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		const foreground = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		let calls = 0;
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{
				brokerConnector: () => {
					calls += 1;
					return calls === 1 ? first.promise : foreground.promise;
				},
			},
		);

		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		first.reject(new Error("prewarm failed"));
		await Promise.allSettled([first.promise]);
		foreground.reject(new Error("foreground failed"));

		await expect(agent.listSessions({})).rejects.toThrow("foreground failed");
		expect(calls).toBe(2);
	});

	it("returns the retry error without starting a third broker attempt", async () => {
		const first = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		const second = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		let calls = 0;
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{
				brokerConnector: () => {
					calls += 1;
					return calls === 1 ? first.promise : second.promise;
				},
			},
		);

		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const foreground = agent.listSessions({});
		first.reject(new Error("endpoint A failed"));
		second.reject(new Error("endpoint B failed"));

		await expect(foreground).rejects.toThrow("endpoint B failed");
		expect(calls).toBe(2);
	});

	it("does not retry after disposal and closes a late prewarm adapter", async () => {
		const first = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		let calls = 0;
		let closeCalls = 0;
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{
				brokerConnector: () => {
					calls += 1;
					return first.promise;
				},
			},
		);

		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		abort.abort();
		await Promise.resolve();
		first.resolve({
			adapter: {
				close: async () => {
					closeCalls += 1;
				},
			} as unknown as AcpSdkAdapter,
			client: {} as SdkClient,
		});
		await Promise.allSettled([first.promise]);
		await Promise.resolve();

		expect(calls).toBe(1);
		expect(closeCalls).toBe(1);
	});

	it("reuses a successful prewarm for the foreground caller", async () => {
		let calls = 0;
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{
				brokerConnector: async () => {
					calls += 1;
					return { adapter: adapter("endpoint A"), client: {} as SdkClient };
				},
			},
		);

		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		await expect(agent.listSessions({})).resolves.toEqual(
			expect.objectContaining({
				sessions: [expect.objectContaining({ sessionId: "endpoint A" })],
			}),
		);
		expect(calls).toBe(1);
	});

	it("handles an unjoined prewarm failure without an unhandled rejection", async () => {
		const first = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{ brokerConnector: () => first.promise },
		);

		try {
			await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
			first.reject(new Error("ignored prewarm failure"));
			await Promise.allSettled([first.promise]);
			await Promise.resolve();
			await Promise.resolve();
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("shares one fresh retry when concurrent callers joined a failed prewarm", async () => {
		const first = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		const second = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		let calls = 0;
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{
				brokerConnector: () => {
					calls += 1;
					return calls === 1 ? first.promise : second.promise;
				},
			},
		);

		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const firstForeground = agent.listSessions({});
		const secondForeground = agent.listSessions({});
		first.reject(new Error("endpoint A failed"));
		second.resolve({ adapter: adapter("endpoint B"), client: {} as SdkClient });

		await expect(Promise.all([firstForeground, secondForeground])).resolves.toEqual([
			expect.objectContaining({ sessions: [expect.objectContaining({ sessionId: "endpoint B" })] }),
			expect.objectContaining({ sessions: [expect.objectContaining({ sessionId: "endpoint B" })] }),
		]);
		expect(calls).toBe(2);
	});
});
