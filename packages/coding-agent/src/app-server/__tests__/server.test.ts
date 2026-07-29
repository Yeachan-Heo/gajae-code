import { expect, test } from "bun:test";
import * as path from "node:path";
import { experimentalValidators, stableValidators } from "../protocol-source/schema-validators.generated";
import { ConnectionState } from "../router/connection-state";
import { classifyInbound } from "../router/dispatch";
import { processInbound } from "../server";
import type { ChildBridgeOptions, SessionClient } from "../thread-runtime/child-bridge";
import {
	type EndpointAuthority,
	type ThreadEffectiveSettings,
	ThreadRuntimeManager,
} from "../thread-runtime/thread-runtime-manager";
import { coerceId } from "../transport/framing";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) =>
	b ? (JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>) : undefined;
const state = () => new ConnectionState();
const mgr = () => new ThreadRuntimeManager();

const authority = (gen: number): EndpointAuthority => ({
	endpointGeneration: gen,
	endpointIncarnation: "c".repeat(64),
	endpointMtimeMs: 1,
	pid: 1234,
});

const effectiveSettings = (sessionId: string, cwd: string): ThreadEffectiveSettings => ({
	model: "requested-model",
	modelProvider: "openai",
	serviceTier: null,
	cwd,
	instructionSources: [],
	approvalPolicy: "untrusted",
	approvalsReviewer: "user",
	sandbox: { type: "dangerFullAccess" },
	reasoningEffort: null,
	thread: {
		id: sessionId,
		sessionId,
		forkedFromId: null,
		parentThreadId: null,
		preview: "preview",
		ephemeral: false,
		isPinned: false,
		modelProvider: "openai",
		createdAt: 0,
		updatedAt: 0,
		recencyAt: null,
		status: { type: "idle" },
		path: null,
		cwd,
		cliVersion: "1",
		source: "cli",
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: null,
		name: null,
		turns: [],
		extra: null,
		historyMode: "paginated",
		canAcceptDirectInput: true,
	},
	runtimeWorkspaceRoots: [],
	activePermissionProfile: null,
	multiAgentMode: "proactive",
});

function serverClient(): SessionClient {
	return {
		onFrame: () => () => {},
		onReconnect: () => () => {},
		onReconnectFailed: () => () => {},
		request: async () => ({}),
		query: async () => ({}),
		control: async () => ({}),
		close: async () => {},
	};
}

test("server: oversize stdio frame returns GJC-only -32600 id null", async () => {
	const huge = "x".repeat(5 * 1024 * 1024);
	const result = await processInbound(state(), mgr(), enc(huge), { maxFrameBytes: 1024 }, "stdio");
	const parsed = dec(result.response)!;
	expect(parsed.id).toBe(null);
	expect((parsed.error as Record<string, unknown>).code).toBe(-32600);
});

test("server: malformed JSON is silently dropped with an explicit malformed rejection disposition", async () => {
	const result = await processInbound(state(), mgr(), enc("{not json"));
	expect(result).toEqual({ rejected: "malformed" });
});

test("server: oversize websocket and unix frames are dropped with an explicit oversize rejection disposition", async () => {
	const huge = enc("x".repeat(1025));
	await expect(processInbound(state(), mgr(), huge, { maxFrameBytes: 1024 }, "websocket")).resolves.toEqual({
		rejected: "oversize",
	});
	await expect(processInbound(state(), mgr(), huge, { maxFrameBytes: 1024 }, "unix")).resolves.toEqual({
		rejected: "oversize",
	});
});

test("server: request before initialize returns Not initialized", async () => {
	const result = await processInbound(state(), mgr(), enc('{"id":1,"method":"thread/start"}'));
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).code).toBe(-32600);
	expect((parsed.error as Record<string, unknown>).message).toBe("Not initialized");
});

test("server: implemented thread/start is not supported when no lifecycle adapter is installed", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await processInbound(s, mgr(), enc('{"method":"initialized"}'));
	const result = await processInbound(s, mgr(), enc('{"id":2,"method":"thread/start","params":{}}'));
	expect((dec(result.response)!.error as Record<string, unknown>).code).toBe(-32081);
});

test("server: malformed initialize params return -32602 without mutating capabilities", async () => {
	const s = state();
	const result = await processInbound(
		s,
		mgr(),
		enc(
			'{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test"},"capabilities":{"experimentalApi":true}}}',
		),
	);
	expect(dec(result.response)).toEqual({ id: 1, error: { code: -32602, message: "Invalid params" } });
	expect(s.stage).toBe("uninitialized");
	expect(s.capabilities).toBeUndefined();
});

test("server: malformed initialized notification is consumed without completing the handshake", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	const result = await processInbound(s, mgr(), enc('{"method":"initialized","params":{}}'));
	expect(result).toEqual({ notification: true });
	expect(s.stage).toBe("initializing");
	expect(s.initialized).toBe(false);
});

test("server: duplicate initialize returns Already initialized", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await processInbound(s, mgr(), enc('{"method":"initialized"}'));
	const result = await processInbound(
		s,
		mgr(),
		enc('{"id":2,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1.0.0"}}}'),
	);
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).message).toBe("Already initialized");
});

test("server: unknown method returns method not found", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await processInbound(s, mgr(), enc('{"method":"initialized"}'));
	const result = await processInbound(s, mgr(), enc('{"id":2,"method":"fabricated/method"}'));
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).code).toBe(-32601);
});

test("server: notification is consumed silently", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	const result = await processInbound(s, mgr(), enc('{"method":"initialized"}'));
	expect(result.response).toBeUndefined();
	expect(result.notification).toBe(true);
});

test("server: jsonrpc header is stripped and not echoed back", async () => {
	const s = state();
	const result = await processInbound(
		s,
		mgr(),
		enc('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	const text = new TextDecoder().decode(result.response!);
	expect(text).not.toContain("jsonrpc");
});

test("server: invalid numeric ids return -32600 before initialize and string and integer ids succeed", async () => {
	const invalidIds = ["1.5", "-0", "9007199254740992"];
	for (const id of invalidIds) {
		const s = state();
		const result = await processInbound(
			s,
			mgr(),
			enc(`{"id":${id},"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}`),
		);
		expect((dec(result.response)!.error as Record<string, unknown>).code, id).toBe(-32600);
		expect(s.stage, id).toBe("uninitialized");
	}

	for (const id of ['"string-id"', "1"]) {
		const s = state();
		const result = await processInbound(
			s,
			mgr(),
			enc(`{"id":${id},"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}`),
		);
		expect(dec(result.response), id).toHaveProperty("result");
		expect(s.stage, id).toBe("initializing");
	}
});

test("server: non-finite JavaScript numeric ids are invalid", () => {
	for (const id of [Number.NaN, Number.POSITIVE_INFINITY]) {
		const classification = classifyInbound({ id, method: "initialize" }, coerceId(id));
		expect(classification.direction).toBe("invalid");
	}
});

test("server: response frames carrying both or neither result and error are invalid requests", async () => {
	for (const frame of [
		'{"id":"server-1"}',
		'{"id":"server-1","result":{},"error":{"code":-32603,"message":"Internal error"}}',
	]) {
		const result = await processInbound(state(), mgr(), enc(frame));
		expect((dec(result.response)!.error as Record<string, unknown>).code).toBe(-32600);
	}
});

test("server: injected thread/start returns a stable schema response after publication", async () => {
	const s = state();
	const manager = mgr();
	const cwd = path.resolve("server-cwd");
	let subscribed = false;
	const bridge: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "server-session-stable",
			cwd,
			authority: authority(11),
			client: serverClient(),
			awaitReady: async () => {},
			closeChild: async () => {},
		}),
		readEffectiveSettings: async () => effectiveSettings("server-session-stable", cwd),
	};
	await processInbound(
		s,
		manager,
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await processInbound(s, manager, enc('{"method":"initialized"}'));
	const result = await processInbound(
		s,
		manager,
		enc(`{"id":2,"method":"thread/start","params":{"cwd":"${cwd}"}}`),
		undefined,
		"websocket",
		undefined,
		{
			connectionId: "conn-stable",
			threadStartAdapter: bridge,
			subscribe: threadId => {
				subscribed = manager.get(threadId) !== undefined;
			},
		},
	);
	const parsed = dec(result.response)!;
	const response = parsed.result as Record<string, unknown>;
	expect(stableValidators.clientRequestResults["thread/start"](response)).toBe(true);
	expect((response.thread as Record<string, unknown>).id).toBe("server-session-stable");
	expect(response).not.toHaveProperty("runtimeWorkspaceRoots");
	expect(response).not.toHaveProperty("activePermissionProfile");
	expect(response).not.toHaveProperty("multiAgentMode");
	const stableThread = response.thread as Record<string, unknown>;
	expect(stableThread).not.toHaveProperty("extra");
	expect(stableThread).not.toHaveProperty("historyMode");
	expect(stableThread).not.toHaveProperty("canAcceptDirectInput");
	expect(subscribed).toBe(true);
});

test("server: injected thread/start selects the experimental 13-field response", async () => {
	const s = state();
	const manager = mgr();
	const cwd = path.resolve("server-experimental-cwd");
	const bridge: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "server-session-experimental",
			cwd,
			authority: authority(12),
			client: serverClient(),
			awaitReady: async () => {},
			closeChild: async () => {},
		}),
		readEffectiveSettings: async () => effectiveSettings("server-session-experimental", cwd),
	};
	await processInbound(
		s,
		manager,
		enc(
			'{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{"experimentalApi":true}}}',
		),
	);
	await processInbound(s, manager, enc('{"method":"initialized"}'));
	const result = await processInbound(
		s,
		manager,
		enc(`{"id":2,"method":"thread/start","params":{"cwd":"${cwd}"}}`),
		undefined,
		"websocket",
		undefined,
		{ connectionId: "conn-experimental", threadStartAdapter: bridge },
	);
	const response = dec(result.response)!.result as Record<string, unknown>;
	expect(experimentalValidators.clientRequestResults["thread/start"](response)).toBe(true);
	expect(response).toHaveProperty("runtimeWorkspaceRoots");
	expect(response).toHaveProperty("activePermissionProfile");
	expect(response).toHaveProperty("multiAgentMode");
	const experimentalThread = response.thread as Record<string, unknown>;
	expect(experimentalThread).toMatchObject({ extra: null, historyMode: "paginated", canAcceptDirectInput: true });
});
