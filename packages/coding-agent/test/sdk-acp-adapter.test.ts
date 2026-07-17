import { expect, test } from "bun:test";
import { AcpSdkAdapter, type AcpSdkAdapterError } from "../src/sdk/acp";

class FakeSdkClient {
	connectionId = "acp-connection";
	frames: Record<string, unknown>[] = [];
	listeners = new Set<(frame: Record<string, unknown>) => void>();
	reconnectFailedListeners = new Set<(error: Error) => void>();
	async control(operation: string, input: Record<string, unknown>) {
		this.frames.push({ type: "control_request", operation, input });
		return { ok: true };
	}
	async query(query: string, input: Record<string, unknown>, cursor?: string) {
		this.frames.push({ type: "query_request", query, input, cursor });
		return { ok: true };
	}
	async global(operation: string, input: Record<string, unknown>, options?: { idempotencyKey?: string }) {
		this.frames.push({ type: "broker_request", operation, input, ...options });
		return { ok: true };
	}
	async request(frame: Record<string, unknown>) {
		this.frames.push(frame);
		return { leaseId: "lease-1" };
	}
	async send(frame: Record<string, unknown>) {
		this.frames.push(frame);
	}
	onFrame(listener: (frame: Record<string, unknown>) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onReconnect(_listener: () => void) {
		return () => {};
	}
	onReconnectFailed(listener: (error: Error) => void) {
		this.reconnectFailedListeners.add(listener);
		return () => this.reconnectFailedListeners.delete(listener);
	}
	async connect() {}
	emit(frame: Record<string, unknown>) {
		for (const listener of this.listeners) listener(frame);
	}
	emitReconnectFailure(error: Error) {
		for (const listener of this.reconnectFailedListeners) listener(error);
	}
	async close() {}
}

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
};

test("ACP SDK adapter maps native and extension methods and keeps endpoint credentials machine-only", async () => {
	const sdk = new FakeSdkClient();
	const adapter = new AcpSdkAdapter({ url: "ws://unused", token: "secret", client: sdk as never });
	await adapter.start();
	await adapter.prompt({ prompt: "hello" });
	await adapter.cancel();
	await adapter.setModel({ modelId: "provider/model" });
	await adapter.handle("_gjc/sdk/control", { operation: "runtime.reload", input: { components: ["tools"] } });
	await adapter.handle("listSessions");
	expect(sdk.frames).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ operation: "turn.prompt", input: expect.objectContaining({ text: "hello" }) }),
			expect.objectContaining({ operation: "turn.abort" }),
			expect.objectContaining({ operation: "model.set", input: { id: "provider/model" } }),
			expect.objectContaining({ operation: "runtime.reload" }),
			expect.objectContaining({ operation: "session.list" }),
		]),
	);
	await expect(adapter.sdkGlobal({ operation: "session.get_endpoint" })).rejects.toMatchObject({
		code: "endpoint_credential_forbidden",
	} satisfies Partial<AcpSdkAdapterError>);
	await adapter.close();
});

test("ACP generic routes honor provider, machine, and secret field dispositions", async () => {
	const sdk = new FakeSdkClient();
	const adapter = new AcpSdkAdapter({ url: "ws://unused", token: "secret", client: sdk as never });
	await adapter.start();
	await expect(adapter.handle("_gjc/sdk/control", { operation: "host_tools.register" })).rejects.toMatchObject({
		code: "provider_required",
	});
	await expect(adapter.handle("_gjc/sdk/control", { operation: "auth.login" })).rejects.toMatchObject({
		code: "provider_required",
	});
	await expect(adapter.handle("_gjc/sdk/global", { operation: "session.get_endpoint" })).rejects.toMatchObject({
		code: "endpoint_credential_forbidden",
	});
	await expect(
		adapter.handle("_gjc/sdk/control", { operation: "config.patch", input: { apiToken: "secret" } }),
	).rejects.toMatchObject({ code: "secret_field_forbidden" });
	await adapter.handle("_gjc/sdk/control", { operation: "config.patch", input: { killSwitchHotkey: true } });
	expect(sdk.frames).toContainEqual({
		type: "control_request",
		operation: "config.patch",
		input: { killSwitchHotkey: true },
	});
	await adapter.close();
});

test("ACP SDK adapter exposes SDK event frames while rejecting raw lifecycle globals", async () => {
	const sdk = new FakeSdkClient();
	const adapter = new AcpSdkAdapter({ url: "ws://unused", token: "secret", client: sdk as never });
	const received: Record<string, unknown>[] = [];
	const unsubscribe = adapter.onFrame(frame => received.push(frame));
	await adapter.start();
	await expect(
		adapter.handle("_gjc/sdk/global", {
			operation: "session.create",
			input: { cwd: "/workspace" },
			idempotencyKey: "generic-lifecycle-key",
		}),
	).rejects.toMatchObject({ code: "operation_prohibited" });
	await adapter.global("session.create", { cwd: "/workspace" }, "lifecycle-key");
	sdk.emit({ type: "event", payload: { type: "turn_end" } });
	expect(sdk.frames).toContainEqual({
		type: "broker_request",
		operation: "session.create",
		input: { cwd: "/workspace" },
		idempotencyKey: "lifecycle-key",
	});
	expect(received).toContainEqual({ type: "event", payload: { type: "turn_end" } });
	unsubscribe();
	await adapter.close();
});

test("ACP SDK adapter forwards terminal reconnect failures to its session owner", async () => {
	const sdk = new FakeSdkClient();
	const adapter = new AcpSdkAdapter({ url: "ws://unused", token: "secret", client: sdk as never });
	const failures: AcpSdkAdapterError[] = [];
	adapter.onReconnectFailed(error => failures.push(error as AcpSdkAdapterError));
	await adapter.start();
	sdk.emitReconnectFailure(new Error("token rejected"));
	await waitFor(() => failures.length === 1, "reconnect failure callback");
	expect(failures[0]).toMatchObject({ code: "reconnect_exhausted", message: "token rejected" });
	await adapter.close();
});
test("ACP lifecycle aliases forward caller idempotency keys outside operation input", async () => {
	const sdk = new FakeSdkClient();
	const adapter = new AcpSdkAdapter({ url: "ws://unused", token: "secret", client: sdk as never });
	const aliases: Array<{ method: string; operation: string; input: Record<string, unknown> }> = [
		{ method: "newSession", operation: "session.create", input: { cwd: "/workspace/new" } },
		{ method: "loadSession", operation: "session.resume", input: { cwd: "/workspace/load", sessionId: "load" } },
		{
			method: "resumeSession",
			operation: "session.resume",
			input: { cwd: "/workspace/resume", sessionId: "resume" },
		},
		{ method: "forkSession", operation: "session.fork", input: { cwd: "/workspace/fork", sessionId: "fork" } },
		{ method: "closeSession", operation: "session.close", input: { sessionId: "close" } },
	];

	await adapter.start();
	for (const alias of aliases)
		await expect(adapter.handle(alias.method, alias.input)).rejects.toMatchObject({ code: "invalid_input" });

	for (const [index, alias] of aliases.entries())
		await adapter.handle(alias.method, { ...alias.input, idempotencyKey: `alias-${index}` });

	expect(sdk.frames).toEqual(
		aliases.map((alias, index) => ({
			type: "broker_request",
			operation: alias.operation,
			input: alias.input,
			idempotencyKey: `alias-${index}`,
		})),
	);
	await adapter.close();
});
test("ACP reverse dispatch requires exact current lease ownership and rejects in-flight duplicates", async () => {
	const sdk = new FakeSdkClient();
	const callbacks: Array<{ method: string; params: Record<string, unknown> }> = [];
	const response = Promise.withResolvers<unknown>();
	const adapter = new AcpSdkAdapter({
		url: "ws://unused",
		token: "secret",
		client: sdk as never,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
		connection: {
			request: async (method, params) => {
				callbacks.push({ method, params });
				return await response.promise;
			},
		},
	});
	const reverse = (id: string, connectionId: string, capability: string, leaseId: string) =>
		sdk.emit({
			type: "reverse_request",
			id,
			connectionId,
			capability,
			leaseId,
			payload: { method: "ui.select", payload: { options: ["yes"] } },
		});
	await adapter.start();
	try {
		reverse("stale-connection", "stale-connection", "ui", "lease-1");
		reverse("stale-lease", sdk.connectionId, "ui", "stale-lease");
		reverse("wrong-capability", sdk.connectionId, "terminal", "lease-1");
		expect(callbacks).toEqual([]);

		reverse("in-flight", sdk.connectionId, "ui", "lease-1");
		reverse("in-flight", sdk.connectionId, "ui", "lease-1");
		expect(callbacks).toEqual([{ method: "ui.select", params: { options: ["yes"] } }]);

		response.resolve({ selected: "yes" });
		await waitFor(
			() => sdk.frames.some(frame => frame.type === "reverse_response" && frame.id === "in-flight"),
			"valid reverse response",
		);
		expect(sdk.frames.filter(frame => frame.type === "reverse_response")).toEqual([
			{
				type: "reverse_response",
				id: "in-flight",
				connectionId: sdk.connectionId,
				leaseId: "lease-1",
				ok: true,
				result: { selected: "yes" },
			},
		]);
	} finally {
		await adapter.close();
	}
});

test("ACP reverse cancellation remains terminal after its tombstone TTL while the callback is still running", async () => {
	const sdk = new FakeSdkClient();
	const callback = Promise.withResolvers<unknown>();
	const adapter = new AcpSdkAdapter({
		url: "ws://unused",
		token: "secret",
		client: sdk as never,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
		reverseCancelTtlMs: 5,
		connection: { request: async () => await callback.promise },
	});
	await adapter.start();
	try {
		sdk.emit({
			type: "reverse_request",
			id: "slow-cancelled",
			connectionId: sdk.connectionId,
			capability: "ui",
			leaseId: "lease-1",
			payload: { method: "ui.select", payload: {} },
		});
		sdk.emit({ type: "reverse_cancel", id: "slow-cancelled" });
		await Bun.sleep(10);
		callback.resolve({ selected: "yes" });
		await Bun.sleep(0);
		expect(sdk.frames.some(frame => frame.type === "reverse_response" && frame.id === "slow-cancelled")).toBe(false);
	} finally {
		await adapter.close();
	}
});

test("ACP reverse cancellation and stale failures suppress responses over the real WebSocket transport", async () => {
	let server!: ReturnType<typeof Bun.serve>;

	let socket: any;
	let connectionId = "connection-1";
	const clientFrames: Record<string, unknown>[] = [];
	const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(client) {
				socket = client;
				client.send(JSON.stringify({ type: "hello", connectionId }));
			},
			message(client, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				clientFrames.push(frame);
				if (frame.type === "register_provider")
					client.send(JSON.stringify({ type: "register_provider_result", id: frame.id, leaseId: "lease-1" }));
			},
		},
	});
	const adapter = new AcpSdkAdapter({
		url: `ws://127.0.0.1:${server.port}`,
		token: "token",
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
		connection: { request: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
	});
	try {
		await adapter.start();
		socket.send(
			JSON.stringify({
				type: "reverse_request",
				id: "cancelled",
				connectionId,
				capability: "ui",
				leaseId: "lease-1",
				payload: { method: "ui.select", payload: {} },
			}),
		);
		await waitFor(() => pending.length === 1, "cancelled reverse request");
		socket.send(JSON.stringify({ type: "reverse_cancel", id: "cancelled" }));
		await Bun.sleep(10);
		pending.shift()!.resolve({ selected: "ignored" });
		await Bun.sleep(20);
		expect(clientFrames.some(frame => frame.type === "reverse_response" && frame.id === "cancelled")).toBe(false);

		socket.send(
			JSON.stringify({
				type: "reverse_request",
				id: "stale-error",
				connectionId,
				capability: "ui",
				leaseId: "lease-1",
				payload: { method: "ui.select", payload: {} },
			}),
		);
		await waitFor(() => pending.length === 1, "stale reverse request");
		connectionId = "connection-2";
		socket.send(JSON.stringify({ type: "hello", connectionId }));
		await Bun.sleep(10);
		pending.shift()!.reject(new Error("stale failure"));
		await Bun.sleep(20);
		expect(clientFrames.some(frame => frame.type === "reverse_response" && frame.id === "stale-error")).toBe(false);
	} finally {
		await adapter.close();
		server.stop(true);
	}
});
