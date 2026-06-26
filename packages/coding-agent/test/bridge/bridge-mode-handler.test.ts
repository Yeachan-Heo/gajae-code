import { describe, expect, it, mock } from "bun:test";
import type { BridgePermissionRequestPayload } from "../../src/modes/bridge/bridge-client-bridge";
import { createBridgeFetchHandler } from "../../src/modes/bridge/bridge-mode";
import { BridgeEventStream } from "../../src/modes/bridge/event-stream";
import { RpcHostToolBridge } from "../../src/modes/rpc/host-tools";
import { RpcHostUriBridge } from "../../src/modes/rpc/host-uris";
import type { RpcWorkflowGateResponse } from "../../src/modes/rpc/rpc-types";
import { BRIDGE_PROTOCOL_VERSION } from "../../src/modes/shared/agent-wire/protocol";
import { rpcSuccess } from "../../src/modes/shared/agent-wire/responses";
import { UiRequestBroker } from "../../src/modes/shared/agent-wire/ui-request-broker";
import type { UnattendedSessionControlPlane } from "../../src/modes/shared/agent-wire/unattended-session";
import type { ClientBridgePermissionOutcome } from "../../src/session/client-bridge";

type HandshakeJson = {
	status: string;
	session_id: string;
	accepted_capabilities: string[];
	unsupported: string[];
	accepted_scopes: string[];
	endpoints: {
		events: string;
		commands: string;
		uiResponses: string;
		claimControl: string;
		disconnectControl: string;
		hostToolResults: string;
		hostUriResults: string;
	};
};

describe("bridge mode fetch handler", () => {
	it("serves health without auth", async () => {
		const handle = createBridgeFetchHandler({ sessionId: "sess-1", token: "secret" });
		const response = await handle(new Request("https://bridge.test/healthz"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("requires bearer auth for handshake", async () => {
		const handle = createBridgeFetchHandler({ sessionId: "sess-1", token: "secret" });
		const response = await handle(
			new Request("https://bridge.test/v1/handshake", {
				method: "POST",
				body: JSON.stringify({
					protocol_version_range: { min: 1, max: 2 },
					capabilities: ["events"],
					requested_scopes: ["prompt"],
				}),
			}),
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});

	it("rejects malformed authenticated handshake payloads", async () => {
		const handle = createBridgeFetchHandler({ sessionId: "sess-1", token: "secret" });
		const response = await handle(
			new Request("https://bridge.test/v1/handshake", {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({}),
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_request" });
	});

	it("advertises only health/help and no enabled session surface by default", async () => {
		const handle = createBridgeFetchHandler({ sessionId: "sess-1", token: "secret", commandScopes: ["prompt"] });
		const help = await handle(new Request("https://bridge.test/v1/help"));
		expect(help.status).toBe(200);
		expect(await help.json()).toEqual({
			status: "experimental_gated",
			message: "Bridge mode is experimental; session-control endpoints fail closed by default.",
			endpoints: {
				events: false,
				commands: false,
				control: false,
				uiResponses: false,
				hostToolResults: false,
				hostUriResults: false,
			},
		});

		const handshake = await handle(
			new Request("https://bridge.test/v1/handshake", {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({
					protocol_version_range: { min: 1, max: 2 },
					capabilities: ["events", "prompt", "host_tools"],
					requested_scopes: ["prompt"],
				}),
			}),
		);
		expect(handshake.status).toBe(200);
		const body = (await handshake.json()) as HandshakeJson;
		expect(body.accepted_capabilities).toEqual([]);
		expect(body.accepted_scopes).toEqual([]);
		expect(body.endpoints).toEqual({
			events: "",
			commands: "",
			uiResponses: "",
			claimControl: "",
			disconnectControl: "",
			hostToolResults: "",
			hostUriResults: "",
		});
	});

	it("fails closed disabled session endpoints before body parsing, scope checks, dispatch, or broker mutation", async () => {
		let calls = 0;
		const permissionBroker = new UiRequestBroker<BridgePermissionRequestPayload, ClientBridgePermissionOutcome>({
			emitRequest: () => {},
		});
		const hostToolBridge = new RpcHostToolBridge(() => {});
		const hostUriBridge = new RpcHostUriBridge(() => {});
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			commandScopes: ["prompt", "control", "host_tools", "host_uri"],
			permissionBroker,
			hostToolBridge,
			hostUriBridge,
			commandDispatcher: async command => {
				calls += 1;
				return rpcSuccess(command.id, "prompt");
			},
		});
		const authed = { Authorization: "Bearer secret" };
		const disabledRequests = [
			new Request("https://bridge.test/v1/sessions/sess-1/events?last_seq=not-a-number", { headers: authed }),
			new Request("https://bridge.test/v1/sessions/sess-1/commands", {
				method: "POST",
				headers: authed,
				body: "not json",
			}),
			new Request("https://bridge.test/v1/sessions/sess-1/control:claim", { method: "POST", headers: authed }),
			new Request("https://bridge.test/v1/sessions/sess-1/control:disconnect", { method: "POST", headers: authed }),
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/request-1", {
				method: "POST",
				headers: authed,
				body: "not json",
			}),
			new Request("https://bridge.test/v1/sessions/sess-1/host-tool-results/tool-1", {
				method: "POST",
				headers: authed,
				body: "not json",
			}),
			new Request("https://bridge.test/v1/sessions/sess-1/host-uri-results/uri-1", {
				method: "POST",
				headers: authed,
				body: "not json",
			}),
		];
		const expectedEndpoints = [
			"events",
			"commands",
			"control",
			"control",
			"uiResponses",
			"hostToolResults",
			"hostUriResults",
		];
		for (const [index, request] of disabledRequests.entries()) {
			const response = await handle(request);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "endpoint_disabled", endpoint: expectedEndpoints[index] });
		}
		expect(calls).toBe(0);
		expect(permissionBroker.ownerToken).toBeUndefined();
	});

	it("negotiates capabilities and scopes on handshake", async () => {
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			commandScopes: ["prompt", "bash"],
			endpointMatrix: {
				events: true,
				commands: true,
				control: true,
				uiResponses: true,
				hostToolResults: true,
				hostUriResults: true,
			},
		});
		const response = await handle(
			new Request("https://bridge.test/v1/handshake", {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({
					protocol_version_range: { min: 1, max: 2 },
					capabilities: ["events", "prompt", "ui.editor", "host_tools", "host_uri"],
					requested_scopes: ["prompt", "bash"],
				}),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as HandshakeJson;
		expect(body.status).toBe("accepted");
		expect(body.session_id).toBe("sess-1");
		expect(body.accepted_capabilities).toEqual(["events", "prompt", "host_tools", "host_uri"]);
		expect(body.unsupported).toEqual(["ui.editor"]);
		expect(body.accepted_scopes).toEqual(["prompt", "bash"]);
		expect(body.endpoints.events).toBe("/v1/sessions/sess-1/events");
	});
	it("serves authenticated event stream frames", async () => {
		const eventStream = new BridgeEventStream();
		eventStream.publish({
			protocol_version: BRIDGE_PROTOCOL_VERSION,
			session_id: "sess-1",
			seq: 1,
			frame_id: "frame-1",
			type: "event",
			payload: { event_type: "agent_start", event: { type: "agent_start" } },
		});
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			eventStream,
			endpointMatrix: { events: true },
		});
		const unauthorized = await handle(new Request("https://bridge.test/v1/sessions/sess-1/events"));
		expect(unauthorized.status).toBe(401);
		const response = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/events", { headers: { Authorization: "Bearer secret" } }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing stream body");
		const chunk = await reader.read();
		await reader.cancel();
		expect(new TextDecoder().decode(chunk.value)).toContain('"frame_id":"frame-1"');
		const invalidCursor = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/events?last_seq=abc", {
				headers: { Authorization: "Bearer secret" },
			}),
		);
		expect(invalidCursor.status).toBe(400);
		const numericPrefixCursor = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/events?last_seq=1abc", {
				headers: { Authorization: "Bearer secret" },
			}),
		);
		expect(numericPrefixCursor.status).toBe(400);
	});
	it("dispatches authorized commands with idempotency", async () => {
		let calls = 0;
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			commandScopes: ["prompt"],
			endpointMatrix: { commands: true },
			idempotencyCache: new Map(),
			commandDispatcher: async command => {
				calls += 1;
				return rpcSuccess(command.id, "prompt");
			},
		});
		const request = () =>
			new Request("https://bridge.test/v1/sessions/sess-1/commands", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Idempotency-Key": "idem-1" },
				body: JSON.stringify({ id: "req-1", type: "prompt", message: "hello" }),
			});
		const first = await handle(request());
		const second = await handle(request());
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(calls).toBe(1);
		expect(await first.json()).toEqual({ id: "req-1", type: "response", command: "prompt", success: true });
	});

	it("rejects command scopes before dispatch", async () => {
		let calls = 0;
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			commandScopes: ["prompt"],
			endpointMatrix: { commands: true },
			commandDispatcher: async command => {
				calls += 1;
				return rpcSuccess(command.id, "prompt");
			},
		});
		const response = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/commands", {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({ id: "req-1", type: "bash", command: "echo hi" }),
			}),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "scope_denied", scope: "bash" });
		expect(calls).toBe(0);
	});

	it("rejects malformed command payloads and coalesces concurrent idempotent commands", async () => {
		let calls = 0;
		const { promise, resolve } = Promise.withResolvers<void>();
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			commandScopes: ["prompt"],
			endpointMatrix: { commands: true },
			idempotencyCache: new Map(),
			commandDispatcher: async command => {
				calls += 1;
				await promise;
				return rpcSuccess(command.id, "prompt");
			},
		});
		const malformed = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/commands", {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({ id: "bad", type: "prompt" }),
			}),
		);
		expect(malformed.status).toBe(400);
		const request = () =>
			new Request("https://bridge.test/v1/sessions/sess-1/commands", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Idempotency-Key": "concurrent-1" },
				body: JSON.stringify({ id: "req-1", type: "prompt", message: "hello" }),
			});
		const first = handle(request());
		const second = handle(request());
		await Bun.sleep(1);
		resolve();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
		expect(calls).toBe(1);
	});
	it("claims control and resolves permission responses with owner token", async () => {
		const permissionBroker = new UiRequestBroker<BridgePermissionRequestPayload, ClientBridgePermissionOutcome>({
			emitRequest: () => {},
		});
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			permissionBroker,
			commandScopes: ["prompt", "control"],
			endpointMatrix: { control: true, uiResponses: true },
			idempotencyCache: new Map(),
		});
		const claim = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/control:claim", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "X-GJC-Bridge-Owner-Token": "owner-1" },
			}),
		);
		expect(claim.status).toBe(200);
		const pending = permissionBroker.request(
			{ kind: "permission", toolCall: { toolCallId: "tool-1", toolName: "bash", title: "Run bash" }, options: [] },
			{ correlationId: "tool-1" },
		);
		const wrongOwner = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/tool-1", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "X-GJC-Bridge-Owner-Token": "wrong" },
				body: JSON.stringify({ outcome: "cancelled" }),
			}),
		);
		expect(wrongOwner.status).toBe(403);
		const response = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/tool-1", {
				method: "POST",
				headers: {
					Authorization: "Bearer secret",
					"X-GJC-Bridge-Owner-Token": "owner-1",
					"Idempotency-Key": "ui-idem-1",
				},
				body: JSON.stringify({ outcome: "selected", optionId: "allow", kind: "allow_once" }),
			}),
		);
		expect(response.status).toBe(200);
		const retry = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/tool-1", {
				method: "POST",
				headers: {
					Authorization: "Bearer secret",
					"X-GJC-Bridge-Owner-Token": "owner-1",
					"Idempotency-Key": "ui-idem-1",
				},
				body: JSON.stringify({ outcome: "selected", optionId: "allow", kind: "allow_once" }),
			}),
		);
		expect(retry.status).toBe(200);
		const replayWrongOwner = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/tool-1", {
				method: "POST",
				headers: {
					Authorization: "Bearer secret",
					"X-GJC-Bridge-Owner-Token": "attacker",
					"Idempotency-Key": "ui-idem-1",
				},
				body: JSON.stringify({ outcome: "selected", optionId: "allow", kind: "allow_once" }),
			}),
		);
		expect(replayWrongOwner.status).toBe(403);
		expect(await pending).toEqual({ outcome: "selected", optionId: "allow", kind: "allow_once" });
		const duplicate = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/tool-1", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "X-GJC-Bridge-Owner-Token": "owner-1" },
				body: JSON.stringify({ outcome: "cancelled" }),
			}),
		);
		expect(duplicate.status).toBe(409);
		const pendingDisconnect = permissionBroker.request(
			{ kind: "permission", toolCall: { toolCallId: "tool-2", toolName: "edit", title: "Run edit" }, options: [] },
			{ correlationId: "tool-2" },
		);
		const disconnect = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/control:disconnect", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "X-GJC-Bridge-Owner-Token": "owner-1" },
			}),
		);
		expect(disconnect.status).toBe(200);
		expect(await pendingDisconnect).toEqual({ status: "cancelled", reason: "disconnect" });
	});

	it("requires claimed controller ownership before resolving workflow gate UI responses", async () => {
		const permissionBroker = new UiRequestBroker<BridgePermissionRequestPayload, ClientBridgePermissionOutcome>({
			emitRequest: () => {},
		});
		const gateResolution = {
			gate_id: "gate-1",
			status: "accepted" as const,
			answer_hash: "answer-hash",
			resolved_at: "2026-06-25T00:00:00.000Z",
		};
		const resolveGateCalls: RpcWorkflowGateResponse[] = [];
		const resolveGate = mock(async (response: RpcWorkflowGateResponse) => {
			resolveGateCalls.push(response);
			return gateResolution;
		});
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			permissionBroker,
			commandScopes: ["prompt", "control"],
			endpointMatrix: { control: true, uiResponses: true },
			idempotencyCache: new Map(),
			unattendedControlPlane: { resolveGate } as unknown as UnattendedSessionControlPlane,
		});
		const claim = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/control:claim", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "X-GJC-Bridge-Owner-Token": "owner-1" },
			}),
		);
		expect(claim.status).toBe(200);

		const body = JSON.stringify({ gate_id: "gate-1", answer: { decision: "approve" } });
		const wrongOwner = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/wg_gate-1", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "X-GJC-Bridge-Owner-Token": "wrong" },
				body,
			}),
		);
		expect(wrongOwner.status).toBe(403);
		expect(await wrongOwner.json()).toEqual({ status: "rejected", code: "not_controller" });
		expect(resolveGate.mock.calls.length).toBe(0);

		const response = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/wg_gate-1", {
				method: "POST",
				headers: {
					Authorization: "Bearer secret",
					"X-GJC-Bridge-Owner-Token": "owner-1",
					"Idempotency-Key": "gate-idem-1",
				},
				body,
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(gateResolution);
		expect(resolveGate.mock.calls.length).toBe(1);
		expect(resolveGateCalls[0]).toEqual({
			gate_id: "gate-1",
			answer: { decision: "approve" },
			idempotency_key: "gate-idem-1",
		});

		const retry = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/wg_gate-1", {
				method: "POST",
				headers: {
					Authorization: "Bearer secret",
					"X-GJC-Bridge-Owner-Token": "owner-1",
					"Idempotency-Key": "gate-idem-1",
				},
				body,
			}),
		);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual(gateResolution);
		expect(resolveGate.mock.calls.length).toBe(1);

		const replayWrongOwner = await handle(
			new Request("https://bridge.test/v1/sessions/sess-1/ui-responses/wg_gate-1", {
				method: "POST",
				headers: {
					Authorization: "Bearer secret",
					"X-GJC-Bridge-Owner-Token": "attacker",
					"Idempotency-Key": "gate-idem-1",
				},
				body,
			}),
		);
		expect(replayWrongOwner.status).toBe(403);
		expect(await replayWrongOwner.json()).toEqual({ status: "rejected", code: "not_controller" });
		expect(resolveGate.mock.calls.length).toBe(1);
	});

	it("accepts host tool and URI callback results", async () => {
		const toolRequests: Array<{ id: string }> = [];
		const uriRequests: Array<{ id: string }> = [];
		const hostToolBridge = new RpcHostToolBridge(frame => toolRequests.push({ id: frame.id }));
		const hostUriBridge = new RpcHostUriBridge(frame => uriRequests.push({ id: frame.id }));
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			hostToolBridge,
			hostUriBridge,
			commandScopes: ["prompt", "host_tools", "host_uri"],
			endpointMatrix: { hostToolResults: true, hostUriResults: true },
		});
		const toolPromise = hostToolBridge.requestExecution(
			{ name: "host_echo", label: "Echo", description: "Echo", parameters: { type: "object" } },
			"tool-call-1",
			{},
		);
		const invalidToolResponse = await handle(
			new Request(`https://bridge.test/v1/sessions/sess-1/host-tool-results/${toolRequests[0]!.id}`, {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({ type: "host_tool_result", result: { nope: true } }),
			}),
		);
		expect(invalidToolResponse.status).toBe(400);
		const invalidIsErrorResponse = await handle(
			new Request(`https://bridge.test/v1/sessions/sess-1/host-tool-results/${toolRequests[0]!.id}`, {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({
					type: "host_tool_result",
					isError: "false",
					result: { content: [{ type: "text", text: "ok" }] },
				}),
			}),
		);
		expect(invalidIsErrorResponse.status).toBe(400);
		const toolResponse = await handle(
			new Request(`https://bridge.test/v1/sessions/sess-1/host-tool-results/${toolRequests[0]!.id}`, {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({ type: "host_tool_result", result: { content: [{ type: "text", text: "ok" }] } }),
			}),
		);
		expect(toolResponse.status).toBe(200);
		expect(await toolPromise).toEqual({ content: [{ type: "text", text: "ok" }] });

		const uriPromise = hostUriBridge.requestRead("bridge", new URL("bridge://resource") as never);
		const invalidUriResponse = await handle(
			new Request(`https://bridge.test/v1/sessions/sess-1/host-uri-results/${uriRequests[0]!.id}`, {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({ type: "not_host_uri_result", content: "body" }),
			}),
		);
		expect(invalidUriResponse.status).toBe(400);
		const uriResponse = await handle(
			new Request(`https://bridge.test/v1/sessions/sess-1/host-uri-results/${uriRequests[0]!.id}`, {
				method: "POST",
				headers: { Authorization: "Bearer secret" },
				body: JSON.stringify({ type: "host_uri_result", content: "body", contentType: "text/plain" }),
			}),
		);
		expect(uriResponse.status).toBe(200);
		expect(await uriPromise).toMatchObject({
			url: "bridge://resource",
			content: "body",
			contentType: "text/plain",
			size: 4,
		});
		expect(() => hostUriBridge.setSchemes([{ scheme: "memory" }])).toThrow(/reserved/);
	});
	it("evicts completed idempotency records once the sequential cache exceeds the bound", async () => {
		const idempotencyCache = new Map();
		let calls = 0;
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			commandScopes: ["prompt"],
			endpointMatrix: { commands: true },
			idempotencyCache,
			commandDispatcher: async command => {
				calls += 1;
				return rpcSuccess(command.id, "prompt");
			},
		});
		const send = (key: string) =>
			handle(
				new Request("https://bridge.test/v1/sessions/sess-1/commands", {
					method: "POST",
					headers: { Authorization: "Bearer secret", "Idempotency-Key": key },
					body: JSON.stringify({ id: key, type: "prompt", message: "hi" }),
				}),
			);
		// More than MAX_IDEMPOTENCY_RECORDS (1000); each request awaited so its
		// record is completed (non-pending) before the next insert.
		const total = 1_050;
		const firstKey = "key-0";
		for (let i = 0; i < total; i++) {
			const res = await send(`key-${i}`);
			expect(res.status).toBe(200);
		}
		expect(calls).toBe(total);
		// Completed records are bounded and the oldest completed key is evicted.
		expect(idempotencyCache.size).toBeLessThanOrEqual(1_000);
		expect(idempotencyCache.has(firstKey)).toBe(false);
		// Replaying an evicted key re-dispatches (no stale cached success).
		const replay = await send(firstKey);
		expect(replay.status).toBe(200);
		expect(calls).toBe(total + 1);
		// Pending records are intentionally NOT evicted, so an all-pending burst can
		// temporarily exceed the bound; this test only covers completed records.
	});
});
