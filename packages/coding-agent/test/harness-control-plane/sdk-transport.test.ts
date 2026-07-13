import { describe, expect, it } from "bun:test";
import { createSdkSessionTransport } from "../../src/harness-control-plane/sdk-transport";
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

	it("surfaces spawned-child cleanup failure instead of hiding an orphan", async () => {
		const pending = createSdkSessionTransport({
			repo: "/repo",
			sessionId: "missing",
			discoveryTimeoutMs: 0,
			readEndpoint: async () => null,
			spawn: () => ({
				async stop() {
					throw new Error("exact child did not exit");
				},
			}),
		});

		await expect(pending).rejects.toThrow("exact child did not exit");
	});
});
