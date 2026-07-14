import { describe, expect, it } from "bun:test";
import { createSdkSessionTransport, ownedHarnessSessionForTest } from "../../src/harness-control-plane/sdk-transport";
import type { SdkClient } from "../../src/sdk/client";

type Responses = {
	metadata: unknown;
	context: unknown;
	replay: unknown;
	control: unknown;
};

const page = (item: Record<string, unknown>): Record<string, unknown> => ({
	type: "query_response",
	id: "query-id",
	ok: true,
	page: { items: [item], complete: true, revision: "revision" },
});

const validResponses = (): Responses => ({
	metadata: page({ sessionId: "session", name: "Session", cwd: "/repo", kind: "main" }),
	context: page({ isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 }),
	replay: { type: "event_replay_result", id: "replay-id", ok: true, events: [], generation: 0, lastSeq: 0 },
	control: {
		type: "control_response",
		id: "control-id",
		ok: true,
		result: { commandId: "command-id", accepted: true },
	},
});

let responses = validResponses();
const client = {
	onFrame: (_listener: (frame: Record<string, unknown>) => void): void => {},
	onReconnectFailed: (_listener: () => void): void => {},
	request: async (): Promise<unknown> => responses.replay,
	query: async (query: string): Promise<unknown> =>
		query === "session.metadata" ? responses.metadata : responses.context,
	control: async (): Promise<unknown> => responses.control,
	close: async (): Promise<void> => {},
};

async function transport() {
	return await createSdkSessionTransport({
		repo: "/repo",
		sessionId: "session",
		connect: async () => client as unknown as SdkClient,
		readEndpoint: async () => ({ url: "ws://sdk.test", token: "token" }),
	});
}

async function expectInvalidResponse(work: () => Promise<unknown>): Promise<void> {
	await expect(work()).rejects.toMatchObject({
		name: "HarnessSdkTransportError",
		code: "invalid_response",
	});
}

describe("SDK harness transport response validation", () => {
	it("rejects metadata missing required SDK fields", async () => {
		responses = validResponses();
		responses.metadata = page({ sessionId: "session", name: "Session", cwd: "/repo" });
		const sdkTransport = await transport();
		await expectInvalidResponse(() => sdkTransport.getState());
	});

	it("rejects malformed context and replay responses", async () => {
		responses = validResponses();
		responses.context = page({ isStreaming: false, steeringQueueDepth: 0 });
		const sdkTransport = await transport();
		await expectInvalidResponse(() => sdkTransport.getState());

		responses = validResponses();
		responses.replay = { type: "event_replay_result", id: "replay-id", ok: true, generation: 0, lastSeq: 0 };
		await expectInvalidResponse(transport);
	});

	it("rejects a non-boolean control acknowledgement and absent command id", async () => {
		responses = validResponses();
		const sdkTransport = await transport();
		responses.control = {
			type: "control_response",
			id: "control-id",
			ok: "true",
			result: { commandId: "command-id" },
		};
		await expectInvalidResponse(() => sdkTransport.sendPrompt("hello"));

		responses.control = { type: "control_response", id: "control-id", ok: true, result: {} };
		await expectInvalidResponse(() => sdkTransport.sendPrompt("hello"));
	});

	it("rejects a control result whose accepted field is false, missing, or non-boolean", async () => {
		responses = validResponses();
		const sdkTransport = await transport();
		responses.control = {
			type: "control_response",
			id: "control-id",
			ok: true,
			result: { commandId: "command-id", accepted: false },
		};
		await expectInvalidResponse(() => sdkTransport.sendPrompt("hello"));

		responses.control = { type: "control_response", id: "control-id", ok: true, result: { commandId: "command-id" } };
		await expectInvalidResponse(() => sdkTransport.sendPrompt("hello"));

		responses.control = {
			type: "control_response",
			id: "control-id",
			ok: true,
			result: { commandId: "command-id", accepted: "true" },
		};
		await expectInvalidResponse(() => sdkTransport.sendPrompt("hello"));
	});

	it("accepts well-formed SDK state and control responses", async () => {
		responses = validResponses();
		const sdkTransport = await transport();
		await expect(sdkTransport.getState()).resolves.toEqual({
			isStreaming: false,
			steeringQueueDepth: 0,
			followupQueueDepth: 0,
		});
		await expect(sdkTransport.sendPrompt("hello")).resolves.toEqual({ commandId: "command-id", ack: true });
	});
});
describe("SDK harness child lifecycle", () => {
	it("awaits spawned-child cleanup before reporting discovery failure", async () => {
		const releaseStop = Promise.withResolvers<void>();
		let stopStarted = false;
		let settled = false;
		const pending = createSdkSessionTransport({
			repo: "/repo",
			sessionId: "missing",
			discoveryTimeoutMs: 0,
			readEndpoint: async () => null,
			spawn: () => ({
				async stop() {
					stopStarted = true;
					await releaseStop.promise;
				},
			}),
		});
		const outcome = pending.then(
			() => undefined,
			error => error,
		);
		void outcome.then(() => {
			settled = true;
		});

		await Bun.sleep(0);
		expect(stopStarted).toBe(true);
		expect(settled).toBe(false);
		releaseStop.resolve();
		const error = await outcome;
		expect(error).toMatchObject({ name: "HarnessSdkTransportError", code: "endpoint_unavailable" });
	});

	it("awaits spawned-child cleanup when the connected transport closes", async () => {
		responses = validResponses();
		const releaseStop = Promise.withResolvers<void>();
		let endpointReads = 0;
		let stopStarted = false;
		const sdkTransport = await createSdkSessionTransport({
			repo: "/repo",
			sessionId: "session",
			discoveryTimeoutMs: 1_000,
			readEndpoint: async () => (endpointReads++ === 0 ? null : { url: "ws://sdk.test", token: "token" }),
			spawn: () => ({
				async stop() {
					stopStarted = true;
					await releaseStop.promise;
				},
			}),
			connect: async () => client as unknown as SdkClient,
		});
		let closed = false;
		const close = sdkTransport.close().then(() => {
			closed = true;
		});

		await Bun.sleep(0);
		expect(stopStarted).toBe(true);
		expect(closed).toBe(false);
		releaseStop.resolve();
		await close;
		expect(closed).toBe(true);
	});

	it("preserves client and spawned-child close failures", async () => {
		responses = validResponses();
		const clientCloseError = new Error("SDK client close failed");
		const childStopError = new Error("exact child did not exit");
		let endpointReads = 0;
		const sdkTransport = await createSdkSessionTransport({
			repo: "/repo",
			sessionId: "close-failures",
			discoveryTimeoutMs: 1_000,
			readEndpoint: async () => (endpointReads++ === 0 ? null : { url: "ws://sdk.test", token: "token" }),
			spawn: () => ({
				async stop() {
					throw childStopError;
				},
			}),
			connect: async () =>
				({
					...client,
					async close(): Promise<void> {
						throw clientCloseError;
					},
				}) as unknown as SdkClient,
		});

		const error = await sdkTransport.close().then(
			() => undefined,
			failure => failure,
		);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([clientCloseError, childStopError]);
	});

	it("preserves discovery timeout and spawned-child cleanup failures", async () => {
		const cleanupError = new Error("exact child did not exit");
		const error = await createSdkSessionTransport({
			repo: "/repo",
			sessionId: "missing",
			discoveryTimeoutMs: 0,
			readEndpoint: async () => null,
			spawn: () => ({
				async stop() {
					throw cleanupError;
				},
			}),
		}).then(
			() => undefined,
			failure => failure,
		);

		expect(error).toBeInstanceOf(AggregateError);
		const causes = (error as AggregateError).errors;
		expect(causes[0]).toMatchObject({ name: "HarnessSdkTransportError", code: "endpoint_unavailable" });
		expect(causes[1]).toBe(cleanupError);
	});

	it("awaits spawned-child stop exactly once when a post-spawn discovery read throws", async () => {
		const releaseStop = Promise.withResolvers<void>();
		let reads = 0;
		let stopCalls = 0;
		let stopStarted = false;
		let settled = false;
		const discoveryError = new Error("endpoint read became unreadable");
		const pending = createSdkSessionTransport({
			repo: "/repo",
			sessionId: "throws",
			discoveryTimeoutMs: 1_000,
			readEndpoint: async () => {
				reads += 1;
				// First read (before spawn) reports no endpoint; the second read, inside the
				// post-spawn discovery loop, throws — reproducing the orphaned-child path.
				if (reads === 1) return null;
				throw discoveryError;
			},
			spawn: () => ({
				async stop() {
					stopCalls += 1;
					stopStarted = true;
					await releaseStop.promise;
				},
			}),
		});
		const outcome = pending.then(
			() => undefined,
			error => error,
		);
		void outcome.then(() => {
			settled = true;
		});

		// The discovery loop sleeps DISCOVERY_POLL_MS before its first post-spawn read.
		await Bun.sleep(80);
		expect(stopStarted).toBe(true);
		expect(stopCalls).toBe(1);
		expect(settled).toBe(false);

		releaseStop.resolve();
		const error = await outcome;
		expect(stopCalls).toBe(1);
		expect(settled).toBe(true);
		expect(error).toBe(discoveryError);
	});

	it("aggregates discovery and cleanup causes when both fail after spawn", async () => {
		const discoveryError = new Error("endpoint discovery read failed");
		const cleanupError = new Error("exact child did not exit");
		let reads = 0;
		let stopCalls = 0;
		const error = await createSdkSessionTransport({
			repo: "/repo",
			sessionId: "throws-and-cleanup-fails",
			discoveryTimeoutMs: 1_000,
			readEndpoint: async () => {
				reads += 1;
				if (reads === 1) return null;
				throw discoveryError;
			},
			spawn: () => ({
				async stop() {
					stopCalls += 1;
					throw cleanupError;
				},
			}),
		}).then(
			() => undefined,
			failure => failure,
		);

		expect(stopCalls).toBe(1);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([discoveryError, cleanupError]);
	});
	it("does not signal an already-exited exact child and memoizes verified cleanup", async () => {
		const signals: NodeJS.Signals[] = [];
		const child = {
			exitCode: 0,
			exited: Promise.resolve(0),
			kill(signal: number | NodeJS.Signals = "SIGTERM") {
				if (typeof signal === "string") signals.push(signal);
			},
		};
		const session = ownedHarnessSessionForTest(child, { termGraceMs: 1, killVerifyMs: 1 });

		const first = session.stop();
		const concurrent = session.stop();
		expect(concurrent).toBe(first);
		await first;
		expect(signals).toEqual([]);
		expect(session.stop()).toBe(first);
	});

	it("allows exact-child cleanup to retry after unverified termination", async () => {
		const exit = Promise.withResolvers<number>();
		const signals: NodeJS.Signals[] = [];
		const child = {
			exitCode: null as number | null,
			exited: exit.promise,
			kill(signal: number | NodeJS.Signals = "SIGTERM") {
				if (typeof signal === "string") signals.push(signal);
			},
		};
		const session = ownedHarnessSessionForTest(child, { termGraceMs: 1, killVerifyMs: 1 });

		const first = session.stop();
		await expect(first).rejects.toMatchObject({
			name: "HarnessSdkTransportError",
			code: "endpoint_unavailable",
		});
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);

		child.exitCode = 0;
		exit.resolve(0);
		const retry = session.stop();
		expect(retry).not.toBe(first);
		await retry;
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(session.stop()).toBe(retry);
	});
});
