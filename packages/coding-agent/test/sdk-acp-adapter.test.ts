import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import packageJson from "../package.json" with { type: "json" };
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { AcpSdkAdapter, type AcpSdkAdapterError, acpMcpLaunchFailure } from "../src/sdk/acp";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SdkClientError } from "../src/sdk/client";
import { MAX_REVERSE_PAYLOAD_BYTES } from "../src/sdk/host";
import type { SessionAttachment } from "../src/sdk/router";
import { SESSION_ABORT_TIMEOUT_MS, SESSION_REQUEST_TIMEOUT_MS } from "../src/sdk/session-reconnect";

class FakeSdkClient {
	connectionId = "acp-connection";
	frames: Record<string, unknown>[] = [];
	globalResponse: unknown = { ok: true };
	listeners = new Set<(frame: Record<string, unknown>) => void>();
	reconnectFailedListeners = new Set<(error: Error) => void>();
	reconnectListeners = new Set<() => void>();
	async control(
		operation: string,
		input: Record<string, unknown>,
		options?: { confirm?: boolean; idempotencyKey?: string },
	) {
		// Record only meaningful envelope options (confirm:true or a forwarded
		// idempotency key) so existing strict frame assertions stay stable.
		const envelope =
			options && (options.confirm === true || options.idempotencyKey !== undefined) ? options : undefined;
		this.frames.push({ type: "control_request", operation, input, ...(envelope ?? {}) });
		return { ok: true };
	}
	async query(query: string, input: Record<string, unknown>, cursor?: string) {
		this.frames.push({ type: "query_request", query, input, cursor });
		return { ok: true };
	}
	async global(operation: string, input: Record<string, unknown>, options?: { idempotencyKey?: string }) {
		this.frames.push({ type: "broker_request", operation, input, ...options });
		return this.globalResponse;
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
	onReconnect(listener: () => void) {
		this.reconnectListeners.add(listener);
		return () => this.reconnectListeners.delete(listener);
	}
	onReconnectFailed(listener: (error: Error) => void) {
		this.reconnectFailedListeners.add(listener);
		return () => this.reconnectFailedListeners.delete(listener);
	}
	async connect() {}
	emit(frame: Record<string, unknown>) {
		for (const listener of this.listeners) listener(frame);
	}
	emitReconnect() {
		for (const listener of this.reconnectListeners) listener();
	}
	emitReconnectFailure(error: Error) {
		for (const listener of this.reconnectFailedListeners) listener(error);
	}
	async close() {}
}

type RouterHarness = {
	router: unknown;
	attachment: SessionAttachment;
	requests: Record<string, unknown>[];
	requestOptions: ({ timeoutMs?: number } | undefined)[];
	sent: Record<string, unknown>[];
	/** Lease ids observed on the maintenance capability (#4689 heartbeat route). */
	maintenance: string[];
	setCurrent: (current: boolean) => void;
};

function createRouterHarness(options: { send?: (frame: Record<string, unknown>) => unknown } = {}): RouterHarness {
	let current = true;
	let nextLease = 0;
	const requests: Record<string, unknown>[] = [];
	const requestOptions: ({ timeoutMs?: number } | undefined)[] = [];
	const sent: Record<string, unknown>[] = [];
	const maintenance: string[] = [];
	const attachment: SessionAttachment = {
		sessionId: "session-1",
		connectionId: "router-connection-1",
		generation: 1,
		isCurrent: () => current,
		send: async frame => {
			sent.push(frame);
			return await options.send?.(frame);
		},
		sendMaintenance: leaseId => {
			maintenance.push(leaseId);
		},
	};
	const router = {
		request: async (
			_sessionId: string,
			frame: Record<string, unknown>,
			_generation?: number,
			_attachment?: SessionAttachment,
			options?: { timeoutMs?: number },
		) => {
			requests.push(frame);
			requestOptions.push(options);
			if (frame.type === "register_provider")
				return {
					ok: true,
					result: {
						leaseId: typeof frame.expectedLeaseId === "string" ? frame.expectedLeaseId : `lease-${++nextLease}`,
					},
				};
			return { ok: true, result: { accepted: true } };
		},
	};
	return { router, attachment, requests, requestOptions, sent, maintenance, setCurrent: value => (current = value) };
}

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
};

test("an attachment without sendMaintenance is rejected at setup, leaving no lease (#4730 review)", async () => {
	// A custom attachment that predates the maintenance capability must fail with
	// an explicit migration error at setup, not silently stop renewing leases
	// later when the heartbeat fires.
	const harness = createRouterHarness();
	const legacy: SessionAttachment = {
		sessionId: harness.attachment.sessionId,
		connectionId: "router-connection-1",
		generation: 1,
		isCurrent: () => true,
		send: async frame => {
			harness.sent.push(frame);
		},
	};
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: legacy,
		sessionId: legacy.sessionId,
		providers: [{ capability: "ui", definitions: [] }],
		heartbeatMs: 5,
	});
	await expect(adapter.start()).rejects.toThrow(/sendMaintenance/);
	try {
		// No heartbeat may be emitted for an attachment that cannot renew.
		const before = harness.maintenance.length;
		await Bun.sleep(40);
		expect(harness.maintenance.length).toBe(before);
		expect(harness.maintenance).toHaveLength(0);
	} finally {
		await adapter.close();
	}
});

test("a capability-less attachment is rejected on the handoff paths too (#4730 review)", async () => {
	// acceptAttachment/attachmentReady are the replacement and ready handoffs. A
	// capability-less attachment arriving there must be refused as well, or a
	// replacement could silently take over live leases and stop renewing them.
	const harness = createRouterHarness();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [] }],
		heartbeatMs: 5,
	});
	await adapter.start();
	try {
		const legacy: SessionAttachment = {
			sessionId: harness.attachment.sessionId,
			connectionId: "router-connection-2",
			generation: 2,
			isCurrent: () => true,
			send: async () => {},
		};
		expect(() => adapter.acceptAttachment(legacy)).toThrow(/sendMaintenance/);
		// The different-object path is guarded above. The SAME-object path must be
		// guarded too, and asserting it needs an adapter whose CURRENT attachment
		// is the capability-less one -- otherwise attachmentReady re-enters the
		// different-object branch and just re-tests the first guard (#4730 review).
		const sameObject = new AcpSdkAdapter({
			router: harness.router as never,
			attachment: legacy,
			sessionId: legacy.sessionId,
			// A provider MUST be configured, or a zero register_provider count is
			// zero either way and proves nothing (#4730 review).
			providers: [{ capability: "ui", definitions: [] }],
		});
		const registeredBefore = harness.requests.filter(frame => frame.type === "register_provider").length;
		await expect(sameObject.attachmentReady(legacy)).rejects.toThrow(/sendMaintenance/);
		// Rejected before provider registration: no lease may exist for an
		// attachment that cannot renew one.
		expect(harness.requests.filter(frame => frame.type === "register_provider").length).toBe(registeredBefore);
		expect(sameObject.leaseIds.size).toBe(0);
		await sameObject.close();
		// The supported attachment keeps renewing; the refusal did not wedge it.
		await waitFor(() => harness.maintenance.length >= 1, "heartbeat still renewing after refusal");
	} finally {
		await adapter.close();
	}
});

test("ACP lease heartbeats take the maintenance route, never the reconciling send path (#4689)", async () => {
	// The 5s lease heartbeat was one of the two timers that forced a locked
	// authority reconcile per attached session. A regression back to send() (or
	// to a full reconcile) must fail here, not just in the index-level tests.
	const harness = createRouterHarness();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [] }],
		heartbeatMs: 5,
	});
	await adapter.start();
	try {
		// A real registered provider lease must exist for a heartbeat to be sent.
		const registered = harness.requests.filter(frame => frame.type === "register_provider");
		expect(registered.length).toBeGreaterThan(0);

		const sentBefore = harness.sent.length;
		const requestsBefore = harness.requests.length;
		await waitFor(() => harness.maintenance.length >= 2, "two lease heartbeats on the maintenance route");

		// Every heartbeat carried a real lease id...
		expect(harness.maintenance.every(leaseId => typeof leaseId === "string" && leaseId.length > 0)).toBe(true);
		// ...and none of them went through the reconciling send() path or emitted
		// any additional router request traffic.
		expect(harness.sent.length).toBe(sentBefore);
		expect(harness.requests.length).toBe(requestsBefore);
	} finally {
		await adapter.close();
	}
});

test("ACP lease heartbeats stop once the attachment is no longer current (#4689)", async () => {
	const harness = createRouterHarness();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [] }],
		heartbeatMs: 5,
	});
	await adapter.start();
	try {
		await waitFor(() => harness.maintenance.length >= 1, "a first lease heartbeat");
		harness.setCurrent(false);
		const afterStale = harness.maintenance.length;
		await Bun.sleep(60);
		// A stale attachment is a quiet no-op: no further heartbeats, and the
		// adapter must not escalate it into reconnect/command traffic.
		expect(harness.maintenance.length).toBe(afterStale);
	} finally {
		await adapter.close();
	}
});

test("ACP abort keeps the one-shot reply deadline while other session commands take the session budget", async () => {
	const harness = createRouterHarness();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
	});
	await adapter.start();
	try {
		await adapter.cancel();
		await adapter.control("turn.abort", { mode: "terminal", idempotencyKey: "abort-budget-direct" });
		await adapter.prompt({ prompt: "hello" });
		await adapter.query("models.list/current");

		const budgetsFor = (predicate: (frame: Record<string, unknown>) => boolean): (number | undefined)[] => {
			const budgets = harness.requests
				.map((frame, index) => (predicate(frame) ? harness.requestOptions[index]?.timeoutMs : undefined))
				.filter((_value, index) => predicate(harness.requests[index]!));
			if (budgets.length === 0) throw new Error("expected frame was never dispatched");
			return budgets;
		};

		// A cancel is awaited before ACP can arm any settlement path, so it must not
		// inherit the wide session reply budget the cold catalog query needs (#4258).
		// Both ACP abort ingresses -- cancel() and a raw turn.abort control -- go
		// through control(), so both must carry the cancellation budget.
		expect(budgetsFor(frame => frame.operation === "turn.abort")).toEqual([
			SESSION_ABORT_TIMEOUT_MS,
			SESSION_ABORT_TIMEOUT_MS,
		]);
		expect(SESSION_ABORT_TIMEOUT_MS).toBeLessThan(SESSION_REQUEST_TIMEOUT_MS);
		expect(budgetsFor(frame => frame.operation === "turn.prompt")).toEqual([undefined]);
		expect(budgetsFor(frame => frame.query === "models.list/current")).toEqual([undefined]);
	} finally {
		await adapter.close();
	}
});

test("ACP SDK adapter maps native and extension methods and keeps endpoint credentials machine-only", async () => {
	const harness = createRouterHarness();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
	});
	await adapter.start();
	await adapter.prompt({ prompt: "hello" });
	await adapter.cancel();
	await adapter.cancel("owned");
	await adapter.setModel({ modelId: "provider/model" });
	await adapter.handle("_gjc/sdk/control", { operation: "runtime.reload", input: { components: ["tools"] } });
	await expect(adapter.handle("listSessions")).rejects.toMatchObject({ code: "operation_prohibited" });
	expect(harness.requests).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ operation: "turn.prompt", input: expect.objectContaining({ text: "hello" }) }),
			expect.objectContaining({
				operation: "turn.abort",
				input: { mode: "terminal", scope: "owned" },
				idempotencyKey: expect.any(String),
			}),
			expect.objectContaining({
				operation: "turn.abort",
				input: { mode: "terminal", scope: "turn" },
				idempotencyKey: expect.any(String),
			}),
			expect.objectContaining({ operation: "model.set", input: { id: "provider/model" } }),
			expect.objectContaining({ operation: "runtime.reload" }),
		]),
	);
	const broker = new AcpSdkAdapter({ client: new FakeSdkClient() as never });
	await broker.start();
	await expect(broker.sdkGlobal({ operation: "session.get_endpoint" })).rejects.toMatchObject({
		code: "endpoint_credential_forbidden",
	} satisfies Partial<AcpSdkAdapterError>);
	await adapter.close();
	await broker.close();
});

test("Broker client injection cannot service live session controls or queries", async () => {
	const sdk = new FakeSdkClient();
	const adapter = new AcpSdkAdapter({ client: sdk as never });
	await adapter.start();
	await expect(adapter.prompt({ prompt: "hello" })).rejects.toMatchObject({ code: "operation_prohibited" });
	await expect(adapter.query("runtime.capabilities")).rejects.toMatchObject({ code: "operation_prohibited" });
	expect(sdk.frames).toEqual([]);
	await adapter.close();
});

test("Router reverse send rejection settles the request and reports transport failure", async () => {
	const failures: AcpSdkAdapterError[] = [];
	const harness = createRouterHarness({
		send: async () => {
			throw new Error("send rejected");
		},
	});
	const callback = Promise.resolve({ selected: "yes" });
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [] }],
		connection: { request: async () => await callback },
	});
	adapter.onReconnectFailed(error => failures.push(error as AcpSdkAdapterError));
	await adapter.start();
	try {
		adapter.acceptFrame({
			type: "reverse_request",
			id: "send-rejected",
			connectionId: "router-connection-1",
			capability: "ui",
			leaseId: "lease-1",
			payload: { method: "ui.select", payload: {} },
		});
		await waitFor(() => failures.length > 0, "reverse send rejection");
		expect(failures[0]?.code).toBe("reconnect_exhausted");
	} finally {
		await adapter.close();
	}
});

test("ACP generic routes honor provider, machine, and secret field dispositions", async () => {
	const harness = createRouterHarness();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
	});
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
	expect(harness.requests).toContainEqual(
		expect.objectContaining({
			type: "control_request",
			operation: "config.patch",
			input: { killSwitchHotkey: true },
		}),
	);
	await adapter.close();
});

test("ACP SDK adapter forwards the bounded idempotency key on control envelopes", async () => {
	// Terminal abort requires the key on the control envelope: without
	// forwarding it, every {mode:"terminal"} control through this surface is
	// rejected with invalid_input (review thread P1).
	const harness = createRouterHarness();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
	});
	await adapter.start();
	await adapter.control("turn.abort", { mode: "terminal", idempotencyKey: "term-key-acp" });
	expect(harness.requests).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: "control_request",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "term-key-acp",
			}),
		]),
	);
	// The key is an envelope concern: it is stripped from the input payload.
	await adapter.close();
});

test("ACP SDK adapter exposes SDK event frames while rejecting raw lifecycle globals", async () => {
	const sdk = new FakeSdkClient();
	const adapter = new AcpSdkAdapter({ client: sdk as never });
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
		timeoutMs: 21_000,
	});
	expect(received).toContainEqual({ type: "event", payload: { type: "turn_end" } });
	unsubscribe();
	await adapter.close();
});

test("ACP reconcile_uncertain validates proof and projects an opaque result", async () => {
	const sdk = new FakeSdkClient();
	sdk.globalResponse = {
		ok: true,
		result: {
			sessionId: "retired-session",
			retired: true,
			ledgerState: "terminal_error",
			indexType: "session_closed",
			stateRoot: "/workspace/.gjc/state",
			endpointGeneration: 2,
			endpointMtimeMs: 1,
			endpointFileId: "dev:123",
			processIncarnation: "linux:123",
			hostIncarnation: "host:123",
			lifecycleRequestId: "retire-effect",
			remoteCreateKey: "remote-create-key",
		},
	};
	const adapter = new AcpSdkAdapter({ client: sdk as never });
	await adapter.start();
	const result = await adapter.global(
		"session.reconcile_uncertain",
		{
			sessionId: "retired-session",
			cwd: "/workspace",
			stateRoot: "/workspace/.gjc/state",
			endpointGeneration: 2,
			endpointMtimeMs: 1,
			endpointFileId: "dev:123",
			processIncarnation: "linux:123",
			hostIncarnation: "host:123",
			lifecycleRequestId: "retire-effect",
			remoteCreateKey: "remote-create-key",
		},
		"acp-retire-key",
	);
	expect(result).toEqual({
		ok: true,
		result: { sessionId: "retired-session", endpointGeneration: 2, endpointFileId: "dev:123" },
	});
	expect(JSON.stringify(result)).not.toContain("stateRoot");
	expect(JSON.stringify(result)).not.toContain("processIncarnation");
	expect(sdk.frames).toContainEqual({
		type: "broker_request",
		operation: "session.reconcile_uncertain",
		input: expect.any(Object),
		idempotencyKey: "acp-retire-key",
	});
	await adapter.close();
});

test("ACP SDK adapter forwards terminal reconnect failures to its session owner", async () => {
	const sdk = new FakeSdkClient();
	const adapter = new AcpSdkAdapter({ client: sdk as never });
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
	const adapter = new AcpSdkAdapter({ client: sdk as never });
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
			...(alias.operation === "session.close" ? {} : { timeoutMs: 21_000 }),
		})),
	);
	await adapter.close();
});

test("ACP reverse dispatch captures Router identity before reverse dispatch and rejects duplicates", async () => {
	const harness = createRouterHarness();
	const callbacks: Array<{ method: string; params: Record<string, unknown> }> = [];
	const response = Promise.withResolvers<unknown>();
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
		connection: {
			request: async (method, params) => {
				callbacks.push({ method, params });
				return await response.promise;
			},
		},
	});
	const connectionId = "router-connection-1";
	const reverse = (id: string, frameConnectionId = connectionId, capability = "ui", leaseId = "lease-1") =>
		adapter.acceptFrame({
			type: "reverse_request",
			id,
			connectionId: frameConnectionId,
			capability,
			leaseId,
			payload: { method: "ui.select", payload: { options: ["yes"] } },
		});
	await adapter.start();
	expect(adapter.connectionId).toBe(connectionId);
	try {
		reverse("stale-lease", connectionId, "ui", "stale-lease");
		reverse("wrong-capability", connectionId, "terminal", "lease-1");
		expect(callbacks).toEqual([]);

		reverse("in-flight");
		reverse("in-flight");
		await waitFor(() => callbacks.length === 1, "valid reverse request");
		expect(callbacks).toEqual([{ method: "ui.select", params: { options: ["yes"] } }]);

		response.resolve({ selected: "yes" });
		await waitFor(
			() => harness.sent.some(frame => frame.type === "reverse_response" && frame.id === "in-flight"),
			"valid reverse response",
		);
		expect(harness.sent.filter(frame => frame.type === "reverse_response")).toEqual([
			{
				type: "reverse_response",
				id: "in-flight",
				connectionId,
				leaseId: "lease-1",
				ok: true,
				result: { selected: "yes" },
			},
		]);

		// A different exact transport identity is not accepted until provider leases reclaim.
		reverse("rotated-connection", "router-connection-2");
		expect(callbacks).toHaveLength(1);
	} finally {
		await adapter.close();
	}
});

test("ACP reverse responses reject an inner result below the cap when its frame exceeds the transport limit", async () => {
	const harness = createRouterHarness();
	const connectionId = "router-connection-1";
	const emptyResultBytes = Buffer.byteLength(JSON.stringify({ value: "" }));
	const result = { value: "x".repeat(MAX_REVERSE_PAYLOAD_BYTES - emptyResultBytes - 1) };
	expect(Buffer.byteLength(JSON.stringify(result))).toBe(MAX_REVERSE_PAYLOAD_BYTES - 1);
	expect(
		Buffer.byteLength(
			JSON.stringify({
				type: "reverse_response",
				id: "near-frame-limit",
				connectionId,
				leaseId: "lease-1",
				ok: true,
				result,
			}),
		),
	).toBeGreaterThan(MAX_REVERSE_PAYLOAD_BYTES);
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "terminal", definitions: [] }],
		connection: { request: async () => result },
	});
	await adapter.start();
	try {
		adapter.acceptFrame({
			type: "reverse_request",
			id: "near-frame-limit",
			connectionId,
			capability: "terminal",
			leaseId: "lease-1",
			payload: { method: "terminal.output", payload: {} },
		});
		await waitFor(
			() => harness.sent.some(frame => frame.type === "reverse_response" && frame.id === "near-frame-limit"),
			"oversized reverse response rejection",
		);
		expect(harness.sent.find(frame => frame.type === "reverse_response" && frame.id === "near-frame-limit")).toEqual({
			type: "reverse_response",
			id: "near-frame-limit",
			connectionId,
			leaseId: "lease-1",
			ok: false,
			error: { code: "payload_too_large", message: "payload_too_large" },
		});
	} finally {
		await adapter.close();
	}
});

test("ACP reverse cancellation remains terminal after its tombstone TTL while the callback is still running", async () => {
	const harness = createRouterHarness();
	const callback = Promise.withResolvers<unknown>();
	let cancellationSignal: AbortSignal | undefined;
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
		reverseCancelTtlMs: 5,
		connection: {
			request: async (_method, _params, options) => {
				cancellationSignal = options?.cancellationSignal;
				return await callback.promise;
			},
		},
	});
	const connectionId = "router-connection-1";
	await adapter.start();
	try {
		adapter.acceptFrame({
			type: "reverse_request",
			id: "slow-cancelled",
			connectionId,
			capability: "ui",
			leaseId: "lease-1",
			payload: { method: "ui.select", payload: {} },
		});
		await waitFor(() => cancellationSignal !== undefined, "reverse cancellation signal");
		adapter.acceptFrame({ type: "reverse_cancel", id: "slow-cancelled" });
		expect(cancellationSignal?.aborted).toBe(true);
		await Bun.sleep(10);
		callback.resolve({ selected: "yes" });
		await Bun.sleep(0);
		expect(harness.sent.some(frame => frame.type === "reverse_response" && frame.id === "slow-cancelled")).toBe(
			false,
		);
	} finally {
		await adapter.close();
	}
});

test("ACP same-attachment reconnect readiness aborts reverse requests owned by the previous transport", async () => {
	const harness = createRouterHarness();
	let cancellationSignal: AbortSignal | undefined;
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [] }],
		connection: {
			request: async (_method, _params, options) => {
				cancellationSignal = options?.cancellationSignal;
				return await new Promise<never>(() => {});
			},
		},
	});
	await adapter.start();
	try {
		adapter.acceptFrame({
			type: "reverse_request",
			id: "reconnect-abort",
			connectionId: "router-connection-1",
			capability: "ui",
			leaseId: "lease-1",
			payload: { method: "ui.elicit", payload: {} },
		});
		await waitFor(() => cancellationSignal !== undefined, "reverse cancellation signal");
		await adapter.attachmentReady(harness.attachment);
		await waitFor(() => cancellationSignal?.aborted === true, "reconnect reverse abort");
		expect(harness.sent.some(frame => frame.type === "reverse_response" && frame.id === "reconnect-abort")).toBe(
			false,
		);
	} finally {
		await adapter.close();
	}
});

test("ACP reverse cancellation and stale failures suppress responses after Router identity rotation", async () => {
	const harness = createRouterHarness();
	const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
	const adapter = new AcpSdkAdapter({
		router: harness.router as never,
		attachment: harness.attachment,
		sessionId: harness.attachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
		connection: {
			request: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
		},
	});
	const reverse = (id: string, connectionId: string) =>
		adapter.acceptFrame({
			type: "reverse_request",
			id,
			connectionId,
			capability: "ui",
			leaseId: "lease-1",
			payload: { method: "ui.select", payload: {} },
		});
	await adapter.start();
	try {
		reverse("cancelled", "router-connection-1");
		await waitFor(() => pending.length === 1, "cancelled reverse request");
		adapter.acceptFrame({ type: "reverse_cancel", id: "cancelled" });
		await Bun.sleep(10);
		pending.shift()!.resolve({ selected: "ignored" });
		await Bun.sleep(20);
		expect(harness.sent.some(frame => frame.type === "reverse_response" && frame.id === "cancelled")).toBe(false);

		reverse("stale-error", "router-connection-1");
		await waitFor(() => pending.length === 1, "stale reverse request");
		reverse("rotation", "router-connection-2");
		pending.shift()!.reject(new Error("stale failure"));
		await Bun.sleep(20);
		expect(harness.sent.some(frame => frame.type === "reverse_response" && frame.id === "stale-error")).toBe(false);
	} finally {
		await adapter.close();
	}
});

test("the ACP MCP launch wrapper reports broker refusal and re-attributes spawn failures", () => {
	const mcpServers = [
		{ name: "docs", command: "docs-mcp", args: [] },
		{ name: "search", command: "search-mcp", args: [] },
	];

	const refused = new SdkClientError(
		"startup_admission_refused",
		"SDK host startup was refused because the broker no longer owns the session root.",
	);
	expect(acpMcpLaunchFailure(refused, mcpServers)).toBe(refused);

	const preservedSpawn = acpMcpLaunchFailure(new SdkClientError("spawn_failed", "child exited"), mcpServers);
	expect(preservedSpawn).toMatchObject({ code: "spawn_failed", message: "child exited" });

	const bare = new SdkClientError("spawn_failed", "child exited");
	expect(acpMcpLaunchFailure(bare, [])).toBe(bare);
	const readyThenExited = new SdkClientError(
		"ready_then_exited",
		"Session s became ready then exited before live admission.",
	);
	expect(acpMcpLaunchFailure(readyThenExited, mcpServers)).toBe(readyThenExited);
	expect(acpMcpLaunchFailure(readyThenExited, [])).toBe(readyThenExited);
});
test("the production ACP MCP launch path preserves broker admission timeout failures", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "gjc-acp-mcp-admission-timeout-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "workspace");
	const token = "acp-admission-timeout-token";
	const controller = new AbortController();
	let server!: ReturnType<typeof Bun.serve>;
	try {
		await fs.mkdir(cwd, { recursive: true });
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).searchParams.get("token") !== token)
					return new Response("Unauthorized", { status: 401 });
				if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
				},
				message(socket, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					socket.send(
						JSON.stringify({
							type: "broker_response",
							id: frame.id,
							ok: false,
							error: {
								code: "startup_admission_timeout",
								message: "SDK host startup was not admitted before the queue wait cutoff.",
							},
						}),
					);
				},
			},
		});
		await writeBrokerDiscovery(agentDir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: packageJson.version,
			ownerId: "acp-admission-timeout-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port: server.port!,
			url: `ws://127.0.0.1:${server.port}`,
			token,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});
		const agent = new AcpAgent(
			{
				signal: controller.signal,
				closed: Promise.withResolvers<void>().promise,
			} as unknown as AgentSideConnection,
			{ agentDir },
		);
		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		await expect(
			agent.newSession({
				cwd,
				additionalDirectories: [],
				mcpServers: [{ name: "docs", command: process.execPath, args: [], env: [] }],
			}),
		).rejects.toMatchObject({
			code: "startup_admission_timeout",
			message: "SDK host startup was not admitted before the queue wait cutoff.",
		});
	} finally {
		server?.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
});
