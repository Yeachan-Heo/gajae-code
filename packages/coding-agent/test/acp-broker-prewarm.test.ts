import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { AcpSdkAdapter } from "../src/sdk/acp/adapter";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { SdkClient } from "../src/sdk/client";
import {
	cleanupFixtureRoots,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

const cleanupRoots: FixtureRootCleanup[] = [];

afterEach(async () => {
	await cleanupFixtureRoots(cleanupRoots);
});

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	const result = Promise.withResolvers<T>();
	return result;
}

function adapter(label: string): AcpSdkAdapter {
	return {
		global: async () => ({ sessions: [{ sessionId: label, locator: { cwd: process.cwd() } }] }),
		close: async () => {},
	} as unknown as AcpSdkAdapter;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
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

	it("declines a joined prewarm retry when session/new cannot reserve lifecycle time", async () => {
		const first = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		const second = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		let calls = 0;
		let now = 0;
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{
				promptWatchdogClock: {
					now: () => now,
					schedule: () => () => {},
				},
				brokerConnector: () => {
					calls += 1;
					return calls === 1 ? first.promise : second.promise;
				},
			},
		);

		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const originalError = new Error("prewarm failed too late");
		const session = agent.newSession({ cwd: process.cwd(), mcpServers: [] });
		now = 17_000;
		first.reject(originalError);

		await expect(session).rejects.toBe(originalError);
		expect(calls).toBe(1);
	});

	it("bounds a joined prewarm retry by the remaining session/new budget", async () => {
		const first = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		const second = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		const retryStarted = deferred<void>();
		let calls = 0;
		let now = 0;
		let deadlineHandler: (() => void) | undefined;
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{
				promptWatchdogClock: {
					now: () => now,
					schedule: (handler: () => void) => {
						deadlineHandler = handler;
						return () => {};
					},
				},
				brokerConnector: () => {
					calls += 1;
					if (calls === 2) retryStarted.resolve();
					return calls === 1 ? first.promise : second.promise;
				},
			},
		);

		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const session = agent.newSession({ cwd: process.cwd(), mcpServers: [] });
		first.reject(new Error("prewarm failed"));
		await retryStarted.promise;
		expect(calls).toBe(2);
		now = 60_000;
		deadlineHandler?.();

		await expect(session).rejects.toThrow("ACP broker connection exceeded its request budget.");
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

	it("does not clobber the broker slot when a disposed connection rejects", async () => {
		const first = deferred<{ adapter: AcpSdkAdapter; client: SdkClient }>();
		let calls = 0;
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
		first.reject(new Error("broker timeout"));
		await Promise.allSettled([first.promise]);
		await expect(agent.listSessions({})).rejects.toThrow("broker timeout");
		expect(calls).toBe(2);
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

	it("closes a resolved prewarm adapter exactly once across repeated disposal", async () => {
		let closeCalls = 0;
		const abort = new AbortController();
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{
				brokerConnector: async () => ({
					adapter: {
						close: async () => {
							closeCalls += 1;
						},
					} as unknown as AcpSdkAdapter,
					client: {} as SdkClient,
				}),
			},
		);

		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		await Bun.sleep(1);
		abort.abort();
		abort.abort();
		await Bun.sleep(10);

		expect(closeCalls).toBe(1);
	});

	it("closes a replacement adapter resolved while live session teardown is pending", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gjc-acp-broker-dispose-race-"));
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await mkdir(cwd, { recursive: true });
		const environment = createFixtureBrokerEnvironment(root, agentDir);
		const started = await withFixtureBrokerEnvironment(() =>
			startFixtureBrokerWithLeaseForTest({ agentDir, env: environment }),
		);
		cleanupRoots.push(createFixtureRootCleanup(root, agentDir, started.lease));

		const replacementClient = deferred<SdkClient>();
		let connectCalls = 0;
		let reconnectFailureHandler: ((error: unknown) => void) | undefined;
		const realConnect = SdkClient.connect.bind(SdkClient);
		const reconnectSpy = vi.spyOn(SdkClient.prototype, "onReconnectFailed").mockImplementation(handler => {
			reconnectFailureHandler ??= handler as unknown as (error: unknown) => void;
			return () => {};
		});
		const connectSpy = vi.spyOn(SdkClient, "connect").mockImplementation(async (url, token, options) => {
			connectCalls += 1;
			if (connectCalls === 2) return replacementClient.promise;
			return await realConnect(url, token, options);
		});
		const abort = new AbortController();
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		const agent = new AcpAgent(
			{ signal: abort.signal, closed: Promise.resolve() } as unknown as AgentSideConnection,
			{ agentDir },
		);

		const teardown = Promise.withResolvers<void>();
		let sessionCloseStarted = false;
		let replacementWindow = true;
		let sessionAdapter: AcpSdkAdapter | undefined;
		let firstBrokerAdapter: AcpSdkAdapter | undefined;
		const originalStart = AcpSdkAdapter.prototype.start;
		const startSpy = vi.spyOn(AcpSdkAdapter.prototype, "start").mockImplementation(async function (
			this: AcpSdkAdapter,
			...args
		) {
			firstBrokerAdapter ??= this;
			return await originalStart.apply(this, args);
		});
		const originalOnFrame = AcpSdkAdapter.prototype.onFrame;
		const frameSpy = vi.spyOn(AcpSdkAdapter.prototype, "onFrame").mockImplementation(function (
			this: AcpSdkAdapter,
			handler,
		) {
			sessionAdapter = this;
			return originalOnFrame.call(this, handler);
		});
		let replacementCloseCalls = 0;
		const originalClose = AcpSdkAdapter.prototype.close;
		const closeSpy = vi.spyOn(AcpSdkAdapter.prototype, "close").mockImplementation(async function (
			this: AcpSdkAdapter,
		) {
			if (this === sessionAdapter && !sessionCloseStarted) {
				sessionCloseStarted = true;
				await teardown.promise;
			} else if (
				this !== sessionAdapter &&
				this !== firstBrokerAdapter &&
				sessionCloseStarted &&
				replacementWindow
			) {
				replacementCloseCalls += 1;
			}
			await originalClose.call(this);
		});

		try {
			await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const created = await agent.newSession({ cwd, mcpServers: [] });
			reconnectFailureHandler?.(new Error("reconnect failed"));

			const listing = agent.listSessions({});
			await waitFor(() => connectCalls === 2, "replacement broker connection");
			abort.abort();
			await waitFor(() => sessionCloseStarted, "live session teardown");

			replacementClient.resolve({
				connectionId: "replacement",
				connect: async () => {},
				close: async () => {},
				onFrame: () => () => {},
				onReconnect: () => () => {},
				onReconnectFailed: () => () => {},
			} as unknown as SdkClient);
			await expect(listing).rejects.toMatchObject({ code: "connection_closed" });
			replacementWindow = false;
			teardown.resolve();
			await Bun.sleep(20);

			expect(created.sessionId).toEqual(expect.any(String));
			expect(replacementCloseCalls).toBe(1);
			expect(unhandled).toEqual([]);
		} finally {
			startSpy.mockRestore();
			reconnectSpy.mockRestore();
			connectSpy.mockRestore();
			frameSpy.mockRestore();
			teardown.resolve();
			abort.abort();
			closeSpy.mockRestore();
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
