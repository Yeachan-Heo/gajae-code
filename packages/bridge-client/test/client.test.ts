import { expect, test } from "bun:test";
import { SdkClient, SdkClientError } from "../src/client";

type FakeListener = ((event: Event) => void) | { handleEvent(event: Event): void };
type FakeListenerOptions = { once?: boolean };

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];
	readonly listeners = new Map<string, Map<FakeListener, FakeListenerOptions>>();
	readonly sent: string[] = [];
	readonly closeCalls: unknown[][] = [];
	readyState = FakeWebSocket.CONNECTING;
	throwOnSend: Error | undefined;
	deferClose = false;

	constructor(readonly url: string | URL) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: FakeListener, options?: FakeListenerOptions): void {
		const listeners = this.listeners.get(type) ?? new Map<FakeListener, FakeListenerOptions>();
		listeners.set(listener, options ?? {});
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: FakeListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	close(...args: unknown[]): void {
		this.closeCalls.push(args);
		this.readyState = this.deferClose ? FakeWebSocket.CLOSING : FakeWebSocket.CLOSED;
	}

	send(value: string): void {
		if (this.throwOnSend) throw this.throwOnSend;
		this.sent.push(value);
	}

	emit(type: string, event = new Event(type)): void {
		for (const [listener, options] of [...(this.listeners.get(type) ?? [])]) {
			if (options.once) this.removeEventListener(type, listener);
			if (typeof listener === "function") listener.call(this, event);
			else listener.handleEvent(event);
		}
	}

	snapshot(type: string): FakeListener[] {
		return [...(this.listeners.get(type)?.keys() ?? [])];
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.emit("open");
	}

	message(frame: unknown): void {
		this.emit(
			"message",
			new MessageEvent("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) }),
		);
	}
}

type FakeTimerHandle = { readonly id: number; unref: () => FakeTimerHandle };
type FakeTimerTask = { readonly callback: () => void; readonly due: number; readonly order: number };

class FakeClock {
	#nextId = 1;
	#nextOrder = 1;
	now = 1_000;
	readonly tasks = new Map<FakeTimerHandle, FakeTimerTask>();

	setTimeout(callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]): FakeTimerHandle {
		const handle: FakeTimerHandle = { id: this.#nextId++, unref: () => handle };
		this.tasks.set(handle, {
			callback: () => callback(...args),
			due: this.now + Math.max(0, delay),
			order: this.#nextOrder++,
		});
		return handle;
	}

	clearTimeout(handle: FakeTimerHandle): void {
		this.tasks.delete(handle);
	}

	advanceBy(milliseconds: number): void {
		this.advanceTo(this.now + milliseconds);
	}

	advanceTo(target: number): void {
		if (target < this.now) throw new Error("Fake clock cannot move backwards");
		for (;;) {
			const entry = [...this.tasks.entries()]
				.filter(([, task]) => task.due <= target)
				.sort((left, right) => left[1].due - right[1].due || left[1].order - right[1].order)[0];
			if (!entry) break;
			this.now = entry[1].due;
			this.tasks.delete(entry[0]);
			entry[1].callback();
		}
		this.now = target;
	}
}

async function withFakeTransport(run: (clock: FakeClock) => Promise<void>): Promise<void> {
	const webSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
	const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
	const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
	const dateNowDescriptor = Object.getOwnPropertyDescriptor(Date, "now");
	const clock = new FakeClock();
	FakeWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
	Object.defineProperty(globalThis, "setTimeout", {
		configurable: true,
		value: clock.setTimeout.bind(clock) as unknown as typeof setTimeout,
	});
	Object.defineProperty(globalThis, "clearTimeout", {
		configurable: true,
		value: clock.clearTimeout.bind(clock) as unknown as typeof clearTimeout,
	});
	Object.defineProperty(Date, "now", { configurable: true, value: () => clock.now });
	try {
		await run(clock);
	} finally {
		if (webSocket) Object.defineProperty(globalThis, "WebSocket", webSocket);
		else Reflect.deleteProperty(globalThis, "WebSocket");
		if (setTimeoutDescriptor) Object.defineProperty(globalThis, "setTimeout", setTimeoutDescriptor);
		if (clearTimeoutDescriptor) Object.defineProperty(globalThis, "clearTimeout", clearTimeoutDescriptor);
		if (dateNowDescriptor) Object.defineProperty(Date, "now", dateNowDescriptor);
	}
}

const flush = async () => {
	await new Promise<void>(resolve => queueMicrotask(resolve));
	await new Promise<void>(resolve => queueMicrotask(resolve));
};

async function connect(client: SdkClient, connectionId = "connection"): Promise<FakeWebSocket> {
	const pending = client.connect();
	const socket = FakeWebSocket.instances.at(-1)!;
	socket.open();
	socket.message({ type: "hello", connectionId });
	await pending;
	return socket;
}

function sent(socket: FakeWebSocket, index = 0): Record<string, unknown> {
	return JSON.parse(socket.sent[index]) as Record<string, unknown>;
}

test("SdkClient gates requests on hello and correlates success and typed errors", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const connecting = client.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		const request = client.control("turn.prompt", { text: "hello" });
		await flush();
		expect(socket.sent).toHaveLength(0);
		socket.message({ type: "hello", connectionId: "hello-gated" });
		await connecting;
		await flush();
		const frame = sent(socket);
		expect(frame).toMatchObject({ type: "control_request", operation: "turn.prompt", input: { text: "hello" } });
		socket.message({ type: "control_response", id: frame.id, ok: true, result: { accepted: true } });
		await expect(request).resolves.toMatchObject({ result: { accepted: true } });

		const failed = client.control("missing");
		await flush();
		const failedFrame = sent(socket, 1);
		socket.message({
			type: "control_response",
			id: failedFrame.id,
			ok: false,
			error: { code: "unknown_operation", message: "missing" },
		});
		await expect(failed).rejects.toBeInstanceOf(SdkClientError);
		await expect(failed).rejects.toMatchObject({ code: "unknown_operation", message: "missing" });
		await client.close();
	});
});

const invalidDurableInputs = [
	{
		create: { unsupported: true },
		createIdempotencyKey: "create-key",
		submission: { kind: "prompt", text: "hello", clientRef: "work" },
	},
	{
		create: {},
		createIdempotencyKey: "create-key",
		timeoutMs: 0,
		submission: { kind: "prompt", text: "hello", clientRef: "work" },
	},
	{
		create: {},
		createIdempotencyKey: "create-key",
		replaySinceSeq: -1,
		submission: { kind: "prompt", text: "hello", clientRef: "work" },
	},
	{
		create: {},
		createIdempotencyKey: "create-key",
		submission: { kind: "prompt", text: "hello", name: "mixed", clientRef: "work" },
	},
	{
		create: {},
		createIdempotencyKey: "create-key",
		submission: { kind: "prompt", text: "hello", clientRef: " invalid " },
	},
];

test("createConnectSubscribeSubmit rejects invalid durable inputs before broker traffic", async () => {
	await withFakeTransport(async () => {
		for (const input of invalidDurableInputs) {
			const client = new SdkClient("ws://sdk.test", "token");
			await expect(client.createConnectSubscribeSubmit(input as never)).resolves.toMatchObject({
				kind: "failed",
				error: { code: "invalid_input" },
			});
			await client.close();
		}
		expect(FakeWebSocket.instances).toHaveLength(0);
	});
});
test("createConnectSubscribeSubmit accepts long and trailing-newline prompt text", async () => {
	await withFakeTransport(async () => {
		for (const text of ["x".repeat(129), "realistic prompt text\n"]) {
			const client = new SdkClient("ws://sdk.test", "token");
			const pending = client.createConnectSubscribeSubmit({
				create: {},
				createIdempotencyKey: "create-key",
				submission: { kind: "prompt", text, clientRef: "prompt-work" },
			});
			await flush();
			expect(FakeWebSocket.instances).toHaveLength(1);
			await client.close();
			await expect(pending).resolves.toMatchObject({ kind: "create_uncertain" });
			FakeWebSocket.instances = [];
		}
	});
});

test("createConnectSubscribeSubmit replays and writes one prompt on the validated endpoint incarnation", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://broker.test", "broker-token", { reconnectAttempts: 0 });
		const pending = client.createConnectSubscribeSubmit({
			create: { cwd: "/repo", readiness: "immediate", target: { worktree: { name: "work" } } },
			createIdempotencyKey: "create-identity",
			submission: { kind: "prompt", text: "hello", clientRef: "prompt-work" },
		});
		const broker = FakeWebSocket.instances[0]!;
		broker.open();
		broker.message({ type: "hello", connectionId: "broker" });
		await flush();
		const create = sent(broker);
		expect(create).toMatchObject({
			type: "broker_request",
			operation: "session.create",
			idempotencyKey: "create-identity",
		});
		broker.message({ type: "broker_response", id: create.id, ok: true, result: { sessionId: "session-1" } });
		await flush();
		const endpointRequest = sent(broker, 1);
		broker.message({
			type: "broker_response",
			id: endpointRequest.id,
			ok: true,
			result: { url: "ws://endpoint.test", token: "endpoint-token", generation: 1 },
		});
		await flush();
		const endpoint = FakeWebSocket.instances[1]!;
		endpoint.open();
		endpoint.message({ type: "hello", connectionId: "endpoint-a" });
		await flush();
		const replay = sent(endpoint);
		expect(replay).toMatchObject({ type: "event_replay", sinceGeneration: 1, sinceSeq: 0 });
		endpoint.message({ type: "event", generation: 1, seq: 1, name: "session_ready" });
		endpoint.message({
			type: "event_replay_result",
			id: replay.id,
			ok: true,
			generation: 1,
			lastSeq: 2,
			events: [{ type: "event", generation: 1, seq: 1, name: "session_ready" }],
		});
		await flush();
		const control = sent(endpoint, 1);
		expect(control).toMatchObject({
			type: "control_request",
			operation: "turn.prompt",
			input: { text: "hello", clientRef: "prompt-work" },
		});
		endpoint.message({
			type: "control_response",
			id: control.id,
			ok: true,
			result: { commandId: "command-1", turnId: "turn-1" },
		});
		const result = await pending;
		expect(result).toMatchObject({ kind: "accepted", sessionId: "session-1" });
		expect(result.kind === "accepted" && "create" in result.identity).toBe(false);
		expect(endpoint.sent.filter(value => JSON.parse(value).type === "control_request")).toHaveLength(1);
		await client.close();
	});
});

test("createConnectSubscribeSubmit never sends after replay incarnation closes before control write", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://broker.test", "broker-token", { reconnectAttempts: 0 });
		const pending = client.createConnectSubscribeSubmit({
			create: { cwd: "/repo" },
			createIdempotencyKey: "create-identity",
			submission: { kind: "skill", name: "review", clientRef: "skill-work" },
		});
		const broker = FakeWebSocket.instances[0]!;
		broker.open();
		broker.message({ type: "hello", connectionId: "broker" });
		await flush();
		const create = sent(broker);
		broker.message({ type: "broker_response", id: create.id, ok: true, result: { sessionId: "session-1" } });
		await flush();
		const endpointRequest = sent(broker, 1);
		broker.message({
			type: "broker_response",
			id: endpointRequest.id,
			ok: true,
			result: { url: "ws://endpoint.test", token: "endpoint-token" },
		});
		await flush();
		const endpoint = FakeWebSocket.instances[1]!;
		endpoint.open();
		endpoint.message({ type: "hello", connectionId: "endpoint-a" });
		await flush();
		const replay = sent(endpoint);
		endpoint.message({ type: "event_replay_result", id: replay.id, ok: true, generation: 1, lastSeq: 0, events: [] });
		endpoint.readyState = FakeWebSocket.CLOSED;
		endpoint.emit("close");
		await expect(pending).resolves.toMatchObject({
			kind: "attachment_uncertain",
			nextLegalLookupAction: "reconcileCreateConnectSubmit",
			prohibitResubmission: true,
		});
		expect(endpoint.sent.filter(value => JSON.parse(value).type === "control_request")).toHaveLength(0);
		await client.close();
	});
});

test("createConnectSubscribeSubmit rejects replay generation resets and sequence gaps without ordered control", async () => {
	for (const replayResult of [
		{ gap: { kind: "generation_reset", fromGeneration: 1, toGeneration: 2 }, generation: 2, lastSeq: 0, events: [] },
		{ gap: { kind: "sequence_gap", fromSeq: 1, toSeq: 2 }, generation: 1, lastSeq: 2, events: [] },
	]) {
		await withFakeTransport(async () => {
			const client = new SdkClient("ws://broker.test", "broker-token", { reconnectAttempts: 0 });
			const pending = client.createConnectSubscribeSubmit({
				create: { cwd: "/repo" },
				createIdempotencyKey: "create-identity",
				submission: { kind: "prompt", text: "hello", clientRef: "prompt-work" },
			});
			const broker = FakeWebSocket.instances[0]!;
			broker.open();
			broker.message({ type: "hello", connectionId: "broker" });
			await flush();
			const create = sent(broker);
			broker.message({ type: "broker_response", id: create.id, ok: true, result: { sessionId: "session-1" } });
			await flush();
			const endpointRequest = sent(broker, 1);
			broker.message({
				type: "broker_response",
				id: endpointRequest.id,
				ok: true,
				result: { url: "ws://endpoint.test", token: "endpoint-token" },
			});
			await flush();
			const endpoint = FakeWebSocket.instances[1]!;
			endpoint.open();
			endpoint.message({ type: "hello", connectionId: "endpoint-a" });
			await flush();
			const replay = sent(endpoint);
			endpoint.message({ type: "event_replay_result", id: replay.id, ok: true, ...replayResult });
			await expect(pending).resolves.toMatchObject({ kind: "subscription_uncertain", prohibitResubmission: true });
			expect(endpoint.sent.filter(value => JSON.parse(value).type === "control_request")).toHaveLength(0);
			await client.close();
		});
	}
});

test("createConnectSubscribeSubmit permits capability-gated global replay gaps on the validated incarnation", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://broker.test", "broker-token", { reconnectAttempts: 0 });
		const pending = client.createConnectSubscribeSubmit({
			create: { cwd: "/repo" },
			createIdempotencyKey: "create-identity",
			submission: { kind: "prompt", text: "hello", clientRef: "prompt-work" },
		});
		const broker = FakeWebSocket.instances[0]!;
		broker.open();
		broker.message({ type: "hello", connectionId: "broker" });
		await flush();
		const create = sent(broker);
		broker.message({ type: "broker_response", id: create.id, ok: true, result: { sessionId: "session-1" } });
		await flush();
		const endpointRequest = sent(broker, 1);
		broker.message({
			type: "broker_response",
			id: endpointRequest.id,
			ok: true,
			result: { url: "ws://endpoint.test", token: "endpoint-token" },
		});
		await flush();
		const endpoint = FakeWebSocket.instances[1]!;
		endpoint.open();
		endpoint.message({ type: "hello", connectionId: "endpoint-a" });
		await flush();
		const replay = sent(endpoint);
		endpoint.message({ type: "event", generation: 1, seq: 2, name: "live" });
		endpoint.message({ type: "event_replay_result", id: replay.id, ok: true, generation: 1, lastSeq: 2, events: [] });
		await flush();
		const control = sent(endpoint, 1);
		expect(control).toMatchObject({ type: "control_request", operation: "turn.prompt" });
		endpoint.message({ type: "control_response", id: control.id, ok: true, result: { commandId: "command-1" } });
		await expect(pending).resolves.toMatchObject({ kind: "accepted" });
		expect(endpoint.sent.filter(value => JSON.parse(value).type === "control_request")).toHaveLength(1);
		await client.close();
	});
});

test("durable recovery identity never carries create material or MCP credentials from any source", async () => {
	await withFakeTransport(async () => {
		// Secrets in every credential form the broker accepts: HTTP/SSE URL
		// userinfo, URL query params, stdio args, env, and headers.
		const urlUserinfoSecret = "TEST_URL_USERINFO_TOKEN";
		const urlQuerySecret = "TEST_URL_QUERY_TOKEN";
		const stdioArgsSecret = "TEST_STDIO_ARGS_TOKEN";
		const envSecret = "TEST_ONLY_MCP_ENV_SECRET";
		const headerSecret = "TEST_ONLY_MCP_AUTH_SECRET";
		const allSecrets = [urlUserinfoSecret, urlQuerySecret, stdioArgsSecret, envSecret, headerSecret];
		const client = new SdkClient("ws://broker.test", "broker-token", { reconnectAttempts: 0 });
		const pending = client.createConnectSubscribeSubmit({
			create: {
				cwd: "/repo",
				mcpServers: [
					{
						type: "http",
						name: "remote-with-userinfo",
						url: `https://user:${urlUserinfoSecret}@mcp.test?api_key=${urlQuerySecret}`,
						headers: { Authorization: `Bearer ${headerSecret}` },
					},
					{
						type: "stdio",
						name: "stdio-with-args-secret",
						command: "/usr/local/bin/mcp-runner",
						args: ["--token", stdioArgsSecret],
						env: { MCP_TOKEN: envSecret },
					},
				],
			},
			createIdempotencyKey: "create-identity",
			submission: { kind: "prompt", text: "hello", clientRef: "prompt-work" },
		});
		const broker = FakeWebSocket.instances[0]!;
		broker.open();
		broker.message({ type: "hello", connectionId: "broker" });
		await flush();
		const create = sent(broker);
		// The broker receives the full create with secrets intact.
		expect((create.input as Record<string, unknown[]>).mcpServers).toHaveLength(2);
		broker.message({
			type: "broker_response",
			id: create.id,
			ok: true,
			result: { sessionId: "session-1", generation: 1 },
		});
		await flush();
		const endpointRequest = sent(broker, 1);
		broker.message({ type: "broker_response", id: endpointRequest.id, ok: true, result: {} });
		const result = await pending;
		expect(result).toMatchObject({ kind: "attachment_uncertain", identity: { sessionId: "session-1" } });
		// No secret from any credential form appears in the serialized result.
		const serialized = JSON.stringify(result);
		for (const secret of allSecrets) expect(serialized).not.toContain(secret);
		if (result.kind === "failed") throw new Error("Expected recovery identity");
		// The identity carries no create field at all — no replay material.
		expect("create" in result.identity).toBe(false);
		expect("createRedacted" in result.identity).toBe(false);
		// Recovery from an identity with a sessionId goes directly to endpoint
		// lookup; the create option is accepted but not needed for this path.
		const recovery = client.reconcileCreateConnectSubmit(result.identity, {
			create: {
				cwd: "/repo",
				mcpServers: [
					{
						type: "http",
						name: "remote-with-userinfo",
						url: `https://user:${urlUserinfoSecret}@mcp.test?api_key=${urlQuerySecret}`,
						headers: { Authorization: `Bearer ${headerSecret}` },
					},
					{
						type: "stdio",
						name: "stdio-with-args-secret",
						command: "/usr/local/bin/mcp-runner",
						args: ["--token", stdioArgsSecret],
						env: { MCP_TOKEN: envSecret },
					},
				],
			},
		});
		await flush();
		const recoveryEndpoint = sent(broker, 2);
		expect(recoveryEndpoint).toMatchObject({
			type: "broker_request",
			operation: "session.get_endpoint",
			input: { sessionId: "session-1" },
		});
		broker.message({
			type: "broker_response",
			id: recoveryEndpoint.id,
			ok: true,
			result: { url: "ws://endpoint.test", token: "endpoint-token", generation: 1 },
		});
		await flush();
		const endpoint = FakeWebSocket.instances[1]!;
		endpoint.open();
		endpoint.message({ type: "hello", connectionId: "endpoint-a" });
		await flush();
		const replay = sent(endpoint);
		endpoint.message({ type: "event_replay_result", id: replay.id, ok: true, generation: 1, lastSeq: 0, events: [] });
		await flush();
		const status = sent(endpoint, 1);
		endpoint.message({ type: "query_response", id: status.id, ok: true, result: { status: "unknown" } });
		const reconciled = await recovery;
		expect(reconciled).toMatchObject({ kind: "reconciled", status: { status: "unknown" } });
		const reconciledSerialized = JSON.stringify(reconciled);
		for (const secret of allSecrets) expect(reconciledSerialized).not.toContain(secret);
		await client.close();
	});
});

test("durable recovery identity rejects nested, encoded, and duplicate credential forms in serialized output", async () => {
	await withFakeTransport(async () => {
		// Percent-encoded userinfo, base64 token in args, duplicate credential
		// across URL query and headers, and nested env values.
		const encodedUserinfoSecret = "TEST_ENCODED_USERINFO_SECRET";
		const base64ArgsSecret = "TEST_BASE64_ARGS_SECRET";
		const duplicateQuerySecret = "TEST_DUP_QUERY_SECRET";
		const nestedEnvSecret = "TEST_NESTED_ENV_SECRET";
		const allSecrets = [encodedUserinfoSecret, base64ArgsSecret, duplicateQuerySecret, nestedEnvSecret];
		const client = new SdkClient("ws://broker.test", "broker-token", { reconnectAttempts: 0 });
		const pending = client.createConnectSubscribeSubmit({
			create: {
				cwd: "/repo",
				mcpServers: [
					{
						type: "sse",
						name: "encoded-userinfo",
						url: `https://user%3A${encodedUserinfoSecret}@mcp-sse.test`,
						headers: { "X-Api-Key": duplicateQuerySecret },
					},
					{
						type: "stdio",
						name: "base64-args",
						command: "/opt/mcp/server",
						args: ["--auth", Buffer.from(base64ArgsSecret).toString("base64")],
						env: { NESTED_KEY: nestedEnvSecret },
					},
					{
						type: "http",
						name: "dup-query",
						url: `https://mcp-dup.test?key=${duplicateQuerySecret}`,
					},
				],
			},
			createIdempotencyKey: "create-encoded-identity",
			submission: { kind: "skill", name: "review", clientRef: "skill-work" },
		});
		const broker = FakeWebSocket.instances[0]!;
		broker.open();
		broker.message({ type: "hello", connectionId: "broker" });
		await flush();
		const create = sent(broker);
		broker.message({
			type: "broker_response",
			id: create.id,
			ok: false,
			error: { code: "invalid_input", message: `Rejected ${allSecrets.join(", ")}` },
		});
		const result = await pending;
		expect(result).toMatchObject({ kind: "failed", error: { code: "invalid_input" } });
		const serialized = JSON.stringify(result);
		for (const secret of allSecrets) expect(serialized).not.toContain(secret);
		if (result.kind === "failed" && result.identity) {
			expect("create" in result.identity).toBe(false);
		}
		await client.close();
	});
});

test("reconcileCreateConnectSubmit reports create_uncertain without create replay material", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const result = await client.reconcileCreateConnectSubmit({
			version: 1,
			operation: "session.create",
			createIdempotencyKey: "create-key",
			submission: { kind: "prompt", clientRef: "work" },
		});
		expect(result).toMatchObject({
			kind: "create_uncertain",
			nextLegalLookupAction: "reconcileCreateConnectSubmit",
			prohibitResubmission: true,
		});
		expect(FakeWebSocket.instances).toHaveLength(0);
		await client.close();
	});
});

test("reconcileCreateConnectSubmit rejects malformed recovery identities before broker traffic", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const result = await client.reconcileCreateConnectSubmit({
			version: 1,
			operation: "session.create",
			createIdempotencyKey: "create-key",
			submission: { kind: "not-a-submission", clientRef: "work" },
		} as never);
		expect(result).toMatchObject({ kind: "failed", error: { code: "invalid_input" } });
		expect(FakeWebSocket.instances).toHaveLength(0);
		await client.close();
	});
});

test("durable create errors never serialize MCP credential values", async () => {
	await withFakeTransport(async () => {
		const envSecret = "TEST_ONLY_MCP_ENV_ERROR_SECRET";
		const headerSecret = "TEST_ONLY_MCP_AUTH_ERROR_SECRET";
		const client = new SdkClient("ws://broker.test", "broker-token", { reconnectAttempts: 0 });
		const pending = client.createConnectSubscribeSubmit({
			create: {
				cwd: "/repo",
				mcpServers: [
					{
						type: "http",
						name: "remote",
						url: "https://mcp.test",
						headers: { Authorization: `Bearer ${headerSecret}` },
					},
					{
						type: "stdio",
						name: "local",
						command: "/usr/local/bin/mcp",
						args: [],
						env: { MCP_TOKEN: envSecret },
					},
				],
			},
			createIdempotencyKey: "create-error-identity",
			submission: { kind: "prompt", text: "hello", clientRef: "prompt-error-work" },
		});
		const broker = FakeWebSocket.instances[0]!;
		broker.open();
		broker.message({ type: "hello", connectionId: "broker" });
		await flush();
		const create = sent(broker);
		broker.message({
			type: "broker_response",
			id: create.id,
			ok: false,
			error: { code: "invalid_input", message: `Rejected ${envSecret} and ${headerSecret}` },
		});
		const result = await pending;
		expect(result).toMatchObject({ kind: "failed", error: { code: "invalid_input" } });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(envSecret);
		expect(serialized).not.toContain(headerSecret);
		await client.close();
	});
});

/** Recovery must replay exactly what the broker hashed, never a redacted subset. */
test("reconcileCreateConnectSubmit replays unknown create fields only by rejecting them before creation", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const result = await client.createConnectSubscribeSubmit({
			create: { cwd: "/repo", unknown: "would-change-broker-hash" },
			createIdempotencyKey: "create-key",
			submission: { kind: "prompt", text: "hello", clientRef: "work" },
		});
		expect(result).toMatchObject({ kind: "failed", error: { code: "invalid_input" } });
		expect(FakeWebSocket.instances).toHaveLength(0);
		await client.close();
	});
});
test("reconcileCreateConnectSubmit queries status despite a replay gap and never submits ordered work", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://broker.test", "broker-token", { reconnectAttempts: 0 });
		const pending = client.reconcileCreateConnectSubmit(
			{
				version: 1,
				operation: "session.create",
				createIdempotencyKey: "create-identity",
				submission: { kind: "skill", clientRef: "skill-work" },
			},
			{ create: { cwd: "/repo" } },
		);
		const broker = FakeWebSocket.instances[0]!;
		broker.open();
		broker.message({ type: "hello", connectionId: "broker" });
		await flush();
		const create = sent(broker);
		expect(create).toMatchObject({
			type: "broker_request",
			operation: "session.create",
			idempotencyKey: "create-identity",
		});
		broker.message({
			type: "broker_response",
			id: create.id,
			ok: true,
			result: { sessionId: "session-1", generation: 1 },
		});
		await flush();
		const endpointRequest = sent(broker, 1);
		expect(endpointRequest).toMatchObject({
			type: "broker_request",
			operation: "session.get_endpoint",
			input: { sessionId: "session-1", endpointGeneration: 1 },
		});
		broker.message({
			type: "broker_response",
			id: endpointRequest.id,
			ok: true,
			result: { url: "ws://endpoint.test", token: "endpoint-token", generation: 1 },
		});
		await flush();
		const endpoint = FakeWebSocket.instances[1]!;
		endpoint.open();
		endpoint.message({ type: "hello", connectionId: "endpoint-a" });
		await flush();
		const replay = sent(endpoint);
		endpoint.message({
			type: "event_replay_result",
			id: replay.id,
			ok: true,
			generation: 1,
			lastSeq: 2,
			gap: { kind: "sequence_gap", fromSeq: 1, toSeq: 2 },
			events: [],
		});
		await flush();
		const status = sent(endpoint, 1);
		expect(status).toMatchObject({
			type: "query_request",
			query: "skill.invoke_status",
			input: { clientRef: "skill-work" },
		});
		expect(endpoint.sent.filter(value => JSON.parse(value).type === "control_request")).toHaveLength(0);
		endpoint.message({ type: "query_response", id: status.id, ok: true, result: { status: "unknown" } });
		await expect(pending).resolves.toMatchObject({
			kind: "reconciled",
			identity: { sessionId: "session-1", createIdempotencyKey: "create-identity" },
			status: { status: "unknown" },
		});
		await client.close();
	});
});

test("createConnectSubscribeSubmit classifies lifecycle errors after an ordered write as uncertain", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://broker.test", "broker-token", { reconnectAttempts: 0 });
		const pending = client.createConnectSubscribeSubmit({
			create: { cwd: "/repo" },
			createIdempotencyKey: "create-identity",
			submission: { kind: "prompt", text: "hello", clientRef: "prompt-work" },
		});
		const broker = FakeWebSocket.instances[0]!;
		broker.open();
		broker.message({ type: "hello", connectionId: "broker" });
		await flush();
		const create = sent(broker);
		broker.message({ type: "broker_response", id: create.id, ok: true, result: { sessionId: "session-1" } });
		await flush();
		const endpointRequest = sent(broker, 1);
		broker.message({
			type: "broker_response",
			id: endpointRequest.id,
			ok: true,
			result: { url: "ws://endpoint.test", token: "endpoint-token" },
		});
		await flush();
		const endpoint = FakeWebSocket.instances[1]!;
		endpoint.open();
		endpoint.message({ type: "hello", connectionId: "endpoint-a" });
		await flush();
		const replay = sent(endpoint);
		endpoint.message({ type: "event_replay_result", id: replay.id, ok: true, generation: 1, lastSeq: 0, events: [] });
		await flush();
		const control = sent(endpoint, 1);
		endpoint.message({
			type: "control_response",
			id: control.id,
			ok: false,
			error: { code: "endpoint_stale", message: "endpoint changed" },
		});
		await expect(pending).resolves.toMatchObject({ kind: "submission_uncertain", prohibitResubmission: true });
		await client.close();
	});
});

test("SdkClient accepts hello that races ahead of the open handler", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const connecting = client.connect();
		const socket = FakeWebSocket.instances[0];
		// Deliver hello while still in the opening phase (before open()).
		socket.message({ type: "server_hello", connectionId: "early" });
		socket.open();
		await connecting;
		const request = client.query("session.metadata", {});
		await flush();
		const frame = sent(socket);
		expect(frame).toMatchObject({ type: "query_request", query: "session.metadata" });
		socket.message({ type: "query_response", id: frame.id, ok: true, result: { sessionId: "live" } });
		await expect(request).resolves.toMatchObject({ ok: true, result: { sessionId: "live" } });
		await client.close();
	});
});

test("SdkClient close resolves only after the owned transport closes", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const socket = await connect(client);
		socket.deferClose = true;
		let settled = false;
		const closing = client.close().then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);
		expect(socket.readyState).toBe(FakeWebSocket.CLOSING);
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await closing;
		expect(settled).toBe(true);
	});
});

test("SdkClient concurrent close callers await the same transport close", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const socket = await connect(client);
		socket.deferClose = true;
		const first = client.close();
		const second = client.close();
		expect(second).toBe(first);
		await flush();
		expect(socket.closeCalls).toHaveLength(1);
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
	});
});

test("SdkClient close rejects with a typed timeout when transport close stalls", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", { timeoutMs: 50 });
		const socket = await connect(client);
		socket.deferClose = true;
		const closing = client.close();
		clock.advanceBy(50);
		await expect(closing).rejects.toMatchObject({
			code: "timeout",
			message: "SDK WebSocket close timed out after 50ms",
		});
		expect(socket.snapshot("close")).toHaveLength(0);
	});
});

test("SdkClient close still issues socket close after the operation deadline elapses (no transport leak)", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", { timeoutMs: 50, deadline: clock.now + 10 });
		const socket = await connect(client);
		clock.advanceBy(100); // operation deadline (now + 10) is now in the past
		const closing = client.close();
		await flush();
		// Regression: close must always issue socket.close() bounded by its own close
		// grace, never gate on the expired request deadline and throw before closing.
		expect(socket.closeCalls.length).toBeGreaterThanOrEqual(1);
		await closing;
		expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
	});
});

test("SdkClient settles owner responses before isolated frame observers", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token");
		const socket = await connect(client);
		const observed: string[] = [];
		let closePromise: Promise<void> | undefined;
		client.onFrame(() => {
			throw new Error("observer failure");
		});
		client.onFrame(frame => {
			observed.push(String(frame.type));
			closePromise = client.close();
		});
		client.onFrame(() => {
			observed.push("after-close");
		});

		const request = client.control("settle-before-observers");
		await flush();
		const frame = sent(socket);
		socket.message({ type: "control_response", id: frame.id, ok: true, result: { settled: true } });

		await expect(request).resolves.toMatchObject({ result: { settled: true } });
		expect(observed).toEqual(["control_response", "after-close"]);
		await closePromise;
	});
});

test("SdkClient rejects malformed frames and a lost response with typed transport errors", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		const malformed = client.control("malformed");
		await flush();
		socket.message("not-json");
		await expect(malformed).rejects.toMatchObject({ code: "protocol_error" });

		const lost = client.control("lost");
		await flush();
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(lost).rejects.toMatchObject({ code: "uncertain_after_send" });
		await client.close();
	});
});

test("SdkClient owns request timeout, reconnect backoff, and absolute deadline deterministically", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", {
			timeoutMs: 50,
			reconnectAttempts: 1,
			reconnectBackoffMs: 10,
		});
		const socket = await connect(client);
		const timedOut = client.control("wait");
		await flush();
		clock.advanceBy(50);
		await expect(timedOut).rejects.toMatchObject({ code: "uncertain_after_send" });

		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		const afterReconnect = client.control("after-reconnect");
		await flush();
		clock.advanceBy(10);
		await flush();
		const replacement = FakeWebSocket.instances[1];
		replacement.open();
		replacement.message({ type: "hello", connectionId: "replacement" });
		for (let index = 0; index < 4; index++) await flush();
		const frame = sent(replacement);
		replacement.message({ type: "control_response", id: frame.id, ok: true });
		await expect(afterReconnect).resolves.toMatchObject({ ok: true });
		await client.close();

		const deadlineClient = new SdkClient("ws://sdk.test", "token", { deadline: clock.now + 5, reconnectAttempts: 0 });
		const deadlineConnect = deadlineClient.connect();
		clock.advanceBy(5);
		await expect(deadlineConnect).rejects.toMatchObject({ code: "timeout" });
		await expect(deadlineClient.control("after-deadline")).rejects.toMatchObject({ code: "timeout" });
		await deadlineClient.close();
	});
});

test("SdkClient isolates reconnect observers from transport settlement", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1, reconnectBackoffMs: 10 });
		const first = await connect(client, "first");
		const notifications: string[] = [];
		client.onReconnect(() => {
			throw new Error("observer failure");
		});
		client.onReconnect(() => {
			notifications.push("reconnected");
		});

		first.readyState = FakeWebSocket.CLOSED;
		first.emit("close");
		const request = client.control("after-reconnect-observer");
		await flush();
		clock.advanceBy(10);
		await flush();
		const replacement = FakeWebSocket.instances[1];
		replacement.open();
		replacement.message({ type: "hello", connectionId: "second" });
		for (let index = 0; index < 4; index++) await flush();
		const frame = sent(replacement);
		replacement.message({ type: "control_response", id: frame.id, ok: true });

		await expect(request).resolves.toMatchObject({ ok: true });
		expect(notifications).toEqual(["reconnected"]);
		await client.close();
	});
});

test("SdkClient preserves typed reconnect exhaustion across hostile failure observers", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const notifications: string[] = [];
		client.onReconnectFailed(() => {
			throw new Error("observer failure");
		});
		client.onReconnectFailed(error => {
			notifications.push(error.code);
		});

		const connecting = client.connect();
		FakeWebSocket.instances[0].emit("error");
		await expect(connecting).rejects.toMatchObject({ code: "reconnect_exhausted" });
		expect(notifications).toEqual(["reconnect_exhausted"]);
		await client.close();
	});
});

test("SdkClient terminal close rejects opening, hello, and retry waiters", async () => {
	await withFakeTransport(async () => {
		const openingClient = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1 });
		const opening = openingClient.connect();
		await openingClient.close();
		await expect(opening).rejects.toMatchObject({ code: "connection_closed" });

		const helloClient = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1 });
		const hello = helloClient.connect();
		FakeWebSocket.instances[1].open();
		await helloClient.close();
		await expect(hello).rejects.toMatchObject({ code: "connection_closed" });

		const retryClient = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 1, reconnectBackoffMs: 10 });
		const retry = retryClient.connect();
		FakeWebSocket.instances[2].emit("error");
		for (let index = 0; index < 4; index++) await flush();
		await retryClient.close();
		await expect(retry).rejects.toMatchObject({ code: "connection_closed" });
	});
});

test("SdkClient fences stale socket callbacks and never replays sent mutations", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const first = await connect(client, "first");
		const staleMessage = first.snapshot("message");
		first.readyState = FakeWebSocket.CLOSED;
		first.emit("close");

		const replacementRequest = client.control("replacement");
		for (let index = 0; index < 4; index++) await flush();
		const second = FakeWebSocket.instances[1];
		second.open();
		second.message({ type: "hello", connectionId: "second" });
		for (let index = 0; index < 4; index++) await flush();
		const observedResponseIds: string[] = [];
		client.onFrame(frame => {
			if (typeof frame.id === "string") observedResponseIds.push(frame.id);
		});
		const replacementFrame = sent(second);
		if (typeof replacementFrame.id !== "string") throw new Error("replacement request id missing");
		for (const listener of staleMessage) {
			const event = new MessageEvent("message", {
				data: JSON.stringify({ type: "control_response", id: replacementFrame.id, ok: true }),
			});
			if (typeof listener === "function") listener(event);
			else listener.handleEvent(event);
		}
		expect(observedResponseIds).toEqual([]);
		second.message({ type: "control_response", id: replacementFrame.id, ok: true });
		await expect(replacementRequest).resolves.toMatchObject({ ok: true });
		expect(observedResponseIds).toEqual([replacementFrame.id]);

		const mutation = client.control("mutate", { value: 1 });
		await flush();
		const mutationFrame = sent(second, 1);
		second.readyState = FakeWebSocket.CLOSED;
		second.emit("close");
		await expect(mutation).rejects.toMatchObject({ code: "uncertain_after_send" });

		const next = client.control("after-close");
		for (let index = 0; index < 4; index++) await flush();
		const third = FakeWebSocket.instances[2];
		third.open();
		third.message({ type: "hello", connectionId: "third" });
		for (let index = 0; index < 4; index++) await flush();
		const nextFrame = sent(third);
		third.message({ type: "control_response", id: nextFrame.id, ok: true });
		await expect(next).resolves.toMatchObject({ ok: true });
		expect(second.sent.filter(value => sent(second, second.sent.indexOf(value)).operation === "mutate")).toHaveLength(
			1,
		);
		expect(third.sent.some(value => (JSON.parse(value) as Record<string, unknown>).id === mutationFrame.id)).toBe(
			false,
		);
		await client.close();
	});
});

test("SdkClient clamps reconnect backoff to the configured per-attempt ceiling", async () => {
	await withFakeTransport(async clock => {
		const reconnectAttempts = 5;
		const reconnectBackoffMs = 100;
		const reconnectMaxBackoffMs = 200;
		const client = new SdkClient("ws://sdk.test", "token", {
			reconnectAttempts,
			reconnectBackoffMs,
			reconnectMaxBackoffMs,
		});
		const uncapped = Array.from({ length: reconnectAttempts }, (_, attempt) => reconnectBackoffMs * 2 ** attempt);
		const expected = uncapped.map(backoff => Math.min(backoff, reconnectMaxBackoffMs));

		const start = clock.now;
		const connecting = client.connect();
		const observed: number[] = [];
		for (let attempt = 0; attempt <= reconnectAttempts; attempt++) {
			const socket = FakeWebSocket.instances[attempt];
			if (!socket) throw new Error(`missing socket for attempt ${attempt}`);
			socket.emit("error");
			for (let index = 0; index < 4; index++) await flush();
			if (attempt === reconnectAttempts) break;
			// The failed incarnation clears its open timer, so only the backoff sleep is pending.
			const pending = [...clock.tasks.values()].map(task => task.due - clock.now);
			expect(pending).toHaveLength(1);
			observed.push(pending[0]);
			clock.advanceBy(pending[0]);
			for (let index = 0; index < 4; index++) await flush();
		}

		await expect(connecting).rejects.toMatchObject({ code: "reconnect_exhausted" });
		expect(FakeWebSocket.instances).toHaveLength(reconnectAttempts + 1);
		expect(observed).toEqual(expected);
		expect(Math.max(...observed)).toBe(reconnectMaxBackoffMs);
		expect(clock.now - start).toBe(expected.reduce((total, backoff) => total + backoff, 0));
		expect(clock.now - start).toBeLessThan(uncapped.reduce((total, backoff) => total + backoff, 0));
		await client.close();
	});
});

test("SdkClient treats explicit server unavailable as terminal, not uncertain_after_send", async () => {
	await withFakeTransport(async () => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0 });
		const socket = await connect(client);
		// Send a request that gets an explicit server rejection.
		const rejected = client.control("rejected");
		await flush();
		expect(socket.sent).toHaveLength(1);
		const frame = sent(socket);
		// Simulate the server sending back an unavailable rejection.
		socket.message({
			type: "control_response",
			id: frame.id as string,
			ok: false,
			error: { code: "unavailable", message: "broker publication unavailable" },
		});
		await flush();
		// The outcome is known: the server rejected it. It must stay "unavailable",
		// not become "uncertain_after_send".
		await expect(rejected).rejects.toMatchObject({ code: "unavailable" });
		await client.close();
	});
});

test("SdkClient still converts timeout and connection_closed after send to uncertain_after_send", async () => {
	await withFakeTransport(async clock => {
		const client = new SdkClient("ws://sdk.test", "token", { reconnectAttempts: 0, timeoutMs: 50 });
		const socket = await connect(client);
		// timeout after send -> uncertain_after_send
		const timedOut = client.control("timeout-test");
		await flush();
		expect(socket.sent).toHaveLength(1);
		clock.advanceBy(60);
		await expect(timedOut).rejects.toMatchObject({ code: "uncertain_after_send" });

		// connection_closed after send -> uncertain_after_send
		const lost = client.control("lost-test");
		await flush();
		expect(socket.sent).toHaveLength(2);
		socket.readyState = FakeWebSocket.CLOSED;
		socket.emit("close");
		await expect(lost).rejects.toMatchObject({ code: "uncertain_after_send" });

		await client.close();
	});
});
