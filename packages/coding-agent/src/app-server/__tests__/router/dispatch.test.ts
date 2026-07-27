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
	const verdict = dispatchClientRequest(state, classifyInbound(req("thread/start")));
	expect(verdict.kind).toBe("notInitialized");
});

test("dispatchClientRequest: alreadyInitialized on a duplicate initialize after success", () => {
	const state = new ConnectionState();
	state.beginInitialize(undefined);
	state.completeInitialize();
	const verdict = dispatchClientRequest(state, classifyInbound(req("initialize")));
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

test("dispatchClientRequest: an experimental method on an experimentalApi connection is handled", () => {
	const state = new ConnectionState();
	state.beginInitialize({ capabilities: { experimentalApi: true } });
	state.completeInitialize();
	const verdict = dispatchClientRequest(state, classifyInbound(req("fuzzyFileSearch/sessionStart")));
	expect(verdict.kind).toBe("handle");
});

test("dispatchClientRequest: a backend-less (not_supported) method -> notSupported(backendLess)", () => {
	const state = new ConnectionState();
	state.beginInitialize(undefined);
	state.completeInitialize();
	// Pick a method known to be not_supported in the overrides (realtime/remoteControl/marketplace/etc.).
	// Find one dynamically so the test does not hardcode a name that may shift.
	const notSupportedMethod = findNotSupportedMethod();
	if (!notSupportedMethod) throw new Error("no not_supported method in manifest to test");
	const verdict = dispatchClientRequest(state, classifyInbound(req(notSupportedMethod)));
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

function findNotSupportedMethod(): string | undefined {
	// Imported here to keep the test self-contained; matches the dispatch module's import.
	const { supportManifest } = require("../../protocol-source/support-manifest.generated");
	return (supportManifest as Array<{ method: string; support: string }>).find(r => r.support === "not_supported")?.method;
}
