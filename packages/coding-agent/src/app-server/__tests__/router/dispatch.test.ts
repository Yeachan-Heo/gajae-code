import { expect, test } from "bun:test";
import { ConnectionState } from "../../router/connection-state";
import {
	classifyInbound,
	dispatchClientRequest,
	isClientNotificationMethod,
	isClientRequestMethod,
	shouldEmitNotification,
} from "../../router/dispatch";

const req = (method: string, id: string | number = 1, params: unknown = {}) => ({ method, id, params });

test("classifyInbound: an id-bearing known method is a clientRequest with manifest support", () => {
	const c = classifyInbound(req("initialize"));
	expect(c.direction).toBe("clientRequest");
	if (c.direction !== "clientRequest") throw new Error("unreachable");
	expect(c.method).toBe("initialize");
});

test("classifyInbound: an id-bearing unknown method is 'unknown' (methodNotFound downstream)", () => {
	const c = classifyInbound(req("does/not/exist"));
	expect(c.direction).toBe("unknown");
});

test("classifyInbound: a frame with no id is a notification (consumed, never answered)", () => {
	const c = classifyInbound({ method: "initialized" });
	expect(c.direction).toBe("clientNotification");
});

test("classifyInbound: a frame with no method is invalid (invalidRequest)", () => {
	const c = classifyInbound({ id: 1 });
	expect(c.direction).toBe("invalid");
	if (c.direction !== "invalid") throw new Error("unreachable");
	expect(c.reason).toBe("invalidRequest");
});

test("classifyInbound: jsonrpc was already stripped by the codec; a leftover is not re-added here", () => {
	const c = classifyInbound({ method: "initialized" });
	expect("jsonrpc" in c).toBe(false);
});

test("dispatchClientRequest: notInitialized when the handshake has not completed", () => {
	const state = new ConnectionState();
	const verdict = dispatchClientRequest(state, classifyInbound(req("thread/start", 1, { cwd: "/workspace" })));
	expect(verdict.kind).toBe("notInitialized");
});

test("dispatchClientRequest: alreadyInitialized on a duplicate initialize after success", () => {
	const state = new ConnectionState();
	state.beginInitialize(undefined);
	state.completeInitialize();
	const verdict = dispatchClientRequest(
		state,
		classifyInbound(req("initialize", 1, { clientInfo: { name: "test", version: "1" } })),
	);
	expect(verdict.kind).toBe("alreadyInitialized");
});

test("dispatchClientRequest: an experimental method on a stable connection -> notSupported(experimentalGate)", () => {
	const state = new ConnectionState();
	state.beginInitialize(undefined);
	state.completeInitialize();
	// fuzzyFileSearch/sessionStart is experimental in the pinned catalog.
	const verdict = dispatchClientRequest(state, classifyInbound(req("fuzzyFileSearch/sessionStart")));
	expect(verdict.kind).toBe("notSupported");
	if (verdict.kind !== "notSupported") throw new Error("unreachable");
	expect(verdict.reason).toBe("experimentalGate");
});

test("dispatchClientRequest: a non-implemented method remains notSupported on an experimentalApi connection", () => {
	const state = new ConnectionState();
	state.beginInitialize({ capabilities: { experimentalApi: true } });
	state.completeInitialize();
	const verdict = dispatchClientRequest(
		state,
		classifyInbound(req("thread/approveGuardianDeniedAction", 1, { threadId: "t1", event: {} })),
	);
	expect(verdict).toMatchObject({ kind: "notSupported", reason: "backendLess" });
});

test("dispatchClientRequest: rejects malformed params for implemented methods before a handler boundary", () => {
	const state = initializedState();
	const malformed = [
		["fs/readFile", { path: 1 }],
		["fs/writeFile", { path: "/workspace/file", dataBase64: 1 }],
	] as const;
	for (const [method, params] of malformed) {
		expect(dispatchClientRequest(state, classifyInbound(req(method, 7, params)))).toEqual({
			kind: "invalidParams",
			id: 7,
		});
	}
});

test("dispatchClientRequest: preserves vendored unknown-key and optional-params semantics", () => {
	const state = initializedState();
	expect(dispatchClientRequest(state, classifyInbound(req("config/read", 8, { unknown: true }))).kind).toBe("handle");
	expect(dispatchClientRequest(state, classifyInbound({ method: "account/logout", id: 9 }))).toMatchObject({
		kind: "notSupported",
		id: 9,
	});
});

test("dispatchClientRequest: an explicitly implemented method reaches the handler verdict", () => {
	const state = initializedState({ experimentalApi: true });
	expect(dispatchClientRequest(state, classifyInbound(req("config/read", 10, {}))).kind).toBe("handle");
});

test("dispatchClientRequest: a backend-less (not_supported) method -> notSupported(backendLess)", () => {
	const state = new ConnectionState();
	state.beginInitialize(undefined);
	state.completeInitialize();
	const verdict = dispatchClientRequest(
		state,
		classifyInbound(req("account/login/cancel", 1, { loginId: "login-1" })),
	);
	expect(verdict.kind).toBe("notSupported");
	if (verdict.kind !== "notSupported") throw new Error("unreachable");
	expect(verdict.reason).toBe("backendLess");
});

test("dispatchClientRequest: a methodNotFound for an unknown id-bearing frame", () => {
	const state = new ConnectionState();
	state.beginInitialize(undefined);
	state.completeInitialize();
	const verdict = dispatchClientRequest(state, classifyInbound(req("totally/fabricated/method")));
	expect(verdict.kind).toBe("methodNotFound");
});

test("shouldEmitNotification: honors exact-match opt-out", () => {
	const state = new ConnectionState();
	state.beginInitialize({ capabilities: { optOutNotificationMethods: ["thread/started"] } });
	state.completeInitialize();
	expect(shouldEmitNotification(state, "thread/started", "stable")).toBe(false);
	expect(shouldEmitNotification(state, "turn/completed", "stable")).toBe(true);
	// prefix must not match
	expect(shouldEmitNotification(state, "thread/started/anything", "stable")).toBe(true);
});

test("shouldEmitNotification: experimental notification gated by experimentalApi", () => {
	const stable = new ConnectionState();
	stable.beginInitialize(undefined);
	stable.completeInitialize();
	expect(shouldEmitNotification(stable, "process/exited", "experimental")).toBe(false);
	const exp = new ConnectionState();
	exp.beginInitialize({ capabilities: { experimentalApi: true } });
	exp.completeInitialize();
	expect(shouldEmitNotification(exp, "process/exited", "experimental")).toBe(true);
});

test("catalog membership helpers reflect the pinned bundle", () => {
	expect(isClientRequestMethod("initialize")).toBe(true);
	expect(isClientNotificationMethod("initialized")).toBe(true);
	expect(isClientRequestMethod("initialized")).toBe(false);
});

function initializedState(capabilities?: { experimentalApi?: boolean }): ConnectionState {
	const state = new ConnectionState();
	state.beginInitialize({ capabilities });
	state.completeInitialize();
	return state;
}
