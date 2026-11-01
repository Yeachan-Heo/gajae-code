import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { type ExternalPermissionError, ExternalPermissionRuntime } from "../src/sdk/host/external-permissions";
import type { ClientBridgePermissionOption, ClientBridgePermissionToolCall } from "../src/session/client-bridge";

const options: ClientBridgePermissionOption[] = [
	{ optionId: "allow", name: "Allow", kind: "allow_once" },
	{ optionId: "reject", name: "Reject", kind: "reject_once" },
];

function toolCall(overrides: Partial<ClientBridgePermissionToolCall> = {}): ClientBridgePermissionToolCall {
	return {
		toolCallId: "call-1",
		toolName: "write",
		title: "Write file",
		rawInput: { path: "/tmp/file", content: "evidence" },
		content: [{ type: "text", text: "preview" }],
		locations: [{ path: "/tmp/file", line: 7 }],
		...overrides,
	};
}

function runtime(options?: ConstructorParameters<typeof ExternalPermissionRuntime>[1]): ExternalPermissionRuntime {
	const instance = new ExternalPermissionRuntime("session-1", options);
	instance.configure({ enabled: true });
	return instance;
}

function expectErrorCode(fn: () => unknown, code: ExternalPermissionError["code"]): void {
	expect(fn).toThrow(expect.objectContaining({ code }));
}

afterEach(() => {
	vi.useRealTimers();
	setSystemTime();
});

describe("ExternalPermissionRuntime", () => {
	it("approves with a snapshotted option and returns raw input and path evidence", async () => {
		const channel = runtime();
		const pending = channel.request(toolCall(), options);
		const [request] = channel.list().requests;
		expect(request).toMatchObject({
			sessionId: "session-1",
			toolCall: {
				rawInput: { path: "/tmp/file", content: "evidence" },
				locations: [{ path: "/tmp/file", line: 7 }],
			},
			options,
		});
		expect(channel.respond({ sessionId: "session-1", id: request.id, optionId: "allow" })).toEqual({
			accepted: true,
		});
		expect(await pending).toEqual({ outcome: "selected", optionId: "allow", kind: "allow_once" });
		expect(channel.list().requests).toEqual([]);
		channel.dispose();
	});

	it("returns comments only for rejecting options", async () => {
		const channel = runtime();
		const pending = channel.request(toolCall(), options);
		const [request] = channel.list().requests;
		channel.respond({ sessionId: "session-1", id: request.id, optionId: "reject", comment: "Not safe" });
		expect(await pending).toEqual({
			outcome: "selected",
			optionId: "reject",
			kind: "reject_once",
			comment: "Not safe",
		});
		channel.dispose();
	});

	it("isolates queued evidence, options, and list results from caller mutation", async () => {
		const channel = runtime();
		const call = toolCall();
		const offered = structuredClone(options);
		const pending = channel.request(call, offered);
		call.rawInput = { path: "/changed" };
		call.locations![0]!.path = "/changed";
		offered[0]!.optionId = "changed";
		const listing = channel.list();
		listing.requests[0]!.toolCall.rawInput = { path: "/tampered" };
		listing.requests[0]!.options[0]!.optionId = "tampered";
		expect(channel.list().requests[0]).toMatchObject({
			toolCall: { rawInput: { path: "/tmp/file" }, locations: [{ path: "/tmp/file", line: 7 }] },
			options,
		});
		const [request] = channel.list().requests;
		channel.respond({ sessionId: "session-1", id: request.id, optionId: "allow" });
		expect(await pending).toMatchObject({ outcome: "selected", optionId: "allow" });
		channel.dispose();
	});

	it("rejects malformed configuration, listing, requests, and responses without consuming pending requests", async () => {
		const channel = runtime();
		const pending = channel.request(toolCall(), options);
		const [request] = channel.list().requests;
		expectErrorCode(() => channel.configure({ enabled: true, extra: 1 }), "invalid_input");
		expectErrorCode(() => channel.list({ sessionId: "session-1" }), "invalid_input");
		expectErrorCode(() => channel.list([]), "invalid_input");
		expectErrorCode(
			() => channel.respond({ sessionId: "session-1", id: request.id, optionId: "missing" }),
			"invalid_input",
		);
		expectErrorCode(
			() =>
				channel.respond({ sessionId: "session-1", id: request.id, optionId: "allow", comment: "not a rejection" }),
			"invalid_input",
		);
		expectErrorCode(
			() =>
				channel.respond({ sessionId: "session-1", id: request.id, optionId: "reject", comment: "x".repeat(4097) }),
			"invalid_input",
		);
		expect(channel.list().requests).toHaveLength(1);
		channel.respond({ sessionId: "session-1", id: request.id, optionId: "allow" });
		await pending;
		channel.dispose();
	});

	it("rejects cross-session, stale, duplicate, and unknown-option responses", async () => {
		const channel = runtime();
		const pending = channel.request(toolCall(), options);
		const [request] = channel.list().requests;
		expectErrorCode(
			() => channel.respond({ sessionId: "other", id: request.id, optionId: "allow" }),
			"invalid_input",
		);
		expectErrorCode(
			() => channel.respond({ sessionId: "session-1", id: request.id, optionId: "unknown" }),
			"invalid_input",
		);
		channel.respond({ sessionId: "session-1", id: request.id, optionId: "allow" });
		await pending;
		expectErrorCode(
			() => channel.respond({ sessionId: "session-1", id: request.id, optionId: "allow" }),
			"invalid_input",
		);
		channel.dispose();
	});

	it("supports concurrent requests and enforces capacity", async () => {
		const channel = runtime({ maxPending: 2 });
		const first = channel.request(toolCall(), options);
		const second = channel.request(toolCall({ toolCallId: "call-2" }), options);
		expect(channel.list().requests).toHaveLength(2);
		expectErrorCode(() => channel.request(toolCall({ toolCallId: "call-3" }), options), "too_many_outstanding");
		const [one, two] = channel.list().requests;
		channel.respond({ sessionId: "session-1", id: one!.id, optionId: "allow" });
		channel.respond({ sessionId: "session-1", id: two!.id, optionId: "reject" });
		await expect(first).resolves.toMatchObject({ optionId: "allow" });
		await expect(second).resolves.toMatchObject({ optionId: "reject" });
		channel.dispose();
	});

	it("enforces individual and aggregate JSON payload bounds", async () => {
		const channel = runtime();
		expectErrorCode(
			() => channel.request(toolCall({ rawInput: { large: "x".repeat(260 * 1024) } }), options),
			"payload_too_large",
		);
		const one = channel.request(toolCall({ rawInput: { large: "x".repeat(100 * 1024) } }), options);
		expectErrorCode(
			() =>
				channel.request(toolCall({ toolCallId: "call-2", rawInput: { large: "y".repeat(100 * 1024) } }), options),
			"payload_too_large",
		);
		expect(channel.list().requests).toHaveLength(1);
		channel.cancelPending();
		expect(await one).toEqual({ outcome: "cancelled" });
		expect(channel.enabled).toBe(true);
		channel.dispose();
	});

	it("cancels on timeout and removes the pending request", async () => {
		vi.useFakeTimers();
		const channel = runtime({ timeoutMs: 50 });
		const pending = channel.request(toolCall(), options);
		expect(channel.list().requests).toHaveLength(1);
		vi.advanceTimersByTime(50);
		expect(await pending).toEqual({ outcome: "cancelled" });
		expect(channel.list().requests).toEqual([]);
		channel.dispose();
	});

	it("cancels when aborted before or after enqueue", async () => {
		const channel = runtime();
		const before = new AbortController();
		before.abort();
		expect(await channel.request(toolCall(), options, before.signal)).toEqual({ outcome: "cancelled" });
		expect(channel.list().requests).toEqual([]);
		const after = new AbortController();
		const pending = channel.request(toolCall(), options, after.signal);
		after.abort();
		expect(await pending).toEqual({ outcome: "cancelled" });
		expect(channel.list().requests).toEqual([]);
		channel.dispose();
	});

	it("rejects an expired response even before the timeout callback runs", async () => {
		vi.useFakeTimers();
		const channel = runtime({ timeoutMs: 50 });
		const pending = channel.request(toolCall(), options);
		const [request] = channel.list().requests;
		setSystemTime(Date.now() + 50);
		expectErrorCode(
			() => channel.respond({ sessionId: "session-1", id: request.id, optionId: "allow" }),
			"resource_gone",
		);
		expect(await pending).toEqual({ outcome: "cancelled" });
		expect(channel.list().requests).toEqual([]);
		channel.dispose();
	});

	it("cancels pending requests on disable and dispose and cannot re-enable after disposal", async () => {
		const disabled = runtime();
		const waiting = disabled.request(toolCall(), options);
		disabled.configure({ enabled: false });
		expect(await waiting).toEqual({ outcome: "cancelled" });
		expect(disabled.enabled).toBe(false);
		expectErrorCode(() => disabled.request(toolCall(), options), "resource_gone");
		disabled.dispose();
		expectErrorCode(() => disabled.configure({ enabled: true }), "resource_gone");

		const disposed = runtime();
		const pending = disposed.request(toolCall(), options);
		disposed.dispose();
		expect(await pending).toEqual({ outcome: "cancelled" });
		expect(disposed.enabled).toBe(false);
		expectErrorCode(() => disposed.request(toolCall(), options), "resource_gone");
	});
});
