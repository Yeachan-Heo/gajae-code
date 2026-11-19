import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import fc from "fast-check";
import type { ControlSurface } from "../src/sdk/host/control/operations";
import { type ExternalPermissionError, ExternalPermissionRuntime } from "../src/sdk/host/external-permissions";
import type {
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../src/session/client-bridge";

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
	it("rolls back an installed provider when switching to prompt mode fails", async () => {
		const channel = new ExternalPermissionRuntime("session");
		const providers: unknown[] = [];
		const failure = new Error("policy failed");
		const surface: Pick<ControlSurface, "setPermissionMode" | "configurePermissionChannel" | "respondPermission"> = {
			setPermissionMode: async () => {
				throw failure;
			},
		};
		channel.installControls(
			surface,
			provider => providers.push(provider),
			() => false,
		);
		try {
			await expect(surface.configurePermissionChannel!({ enabled: true })).rejects.toBe(failure);
			expect(providers).toHaveLength(2);
			expect(typeof providers[0]).toBe("function");
			expect(providers[1]).toBeUndefined();
			expect(channel.enabled).toBe(false);
		} finally {
			channel.dispose();
		}
	});
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

	it("property: generated JSON evidence and offered options remain isolated and responses are fenced", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.jsonValue(),
				fc.uniqueArray(fc.string({ minLength: 1, maxLength: 32 }), { minLength: 1, maxLength: 8 }),
				fc.constantFrom("allow_once", "allow_always", "reject_once", "reject_always"),
				fc.string({ maxLength: 128 }),
				async (evidence, ids, kind, comment) => {
					const channel = runtime();
					try {
						const offered: ClientBridgePermissionOption[] = ids.map(optionId => ({
							optionId,
							name: optionId,
							kind,
						}));
						const call = toolCall({ rawInput: evidence });
						const pending = channel.request(call, offered);
						const original = channel.list();
						const request = original.requests[0]!;
						expectErrorCode(() => channel.configure({ enabled: true, extra: evidence }), "invalid_input");
						expectErrorCode(() => channel.list({ extra: evidence }), "invalid_input");
						for (const title of ["", ids[0]!.repeat(4097)])
							expectErrorCode(() => channel.request(toolCall({ title }), offered), "invalid_input");
						expectErrorCode(() => channel.request(call, [...offered, offered[0]!]), "invalid_input");
						expect(channel.list()).toEqual(original);
						call.rawInput = { replaced: true };
						offered[0]!.optionId = "mutated";
						const listing = channel.list();
						listing.requests[0]!.toolCall.rawInput = null;
						listing.requests[0]!.options.length = 0;
						const response = { sessionId: "session-1", id: request.id, optionId: ids[0]! };
						for (const invalid of [
							{ ...response, sessionId: `other-${comment}` },
							{ ...response, id: "unknown" },
							{ ...response, optionId: `${ids.join("")}!` },
							{ ...response, extra: evidence },
						]) {
							expectErrorCode(() => channel.respond(invalid), "invalid_input");
							expect(channel.list()).toEqual(original);
						}
						const rejecting = kind.startsWith("reject");
						if (!rejecting) expectErrorCode(() => channel.respond({ ...response, comment }), "invalid_input");
						channel.respond(rejecting ? { ...response, comment } : response);
						expect(await pending).toEqual({
							outcome: "selected",
							optionId: ids[0]!,
							kind,
							...(rejecting ? { comment } : {}),
						});
						expectErrorCode(() => channel.respond(response), "invalid_input");
						expect(channel.list().requests).toEqual([]);
					} finally {
						channel.dispose();
					}
				},
			),
			{ seed: 749501, numRuns: 100 },
		);
	});

	it("property: generated command traces match the bounded queue lifecycle model", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 5 }),
				fc.array(
					fc.constantFrom(
						"request",
						"allow",
						"reject",
						"abort",
						"cancel",
						"disable",
						"enable",
						"dispose",
						"expire",
					),
					{ minLength: 1, maxLength: 40 },
				),
				async (capacity, commands) => {
					vi.useFakeTimers();
					const channel = runtime({ maxPending: capacity, timeoutMs: 10 });
					let enabled = true;
					let disposed = false;
					const pending = new Map<
						string,
						{ controller: AbortController; promise: Promise<ClientBridgePermissionOutcome> }
					>();
					try {
						for (const command of commands) {
							const first = pending.entries().next().value;
							if (command === "request") {
								if (!enabled || disposed)
									expectErrorCode(() => channel.request(toolCall(), options), "resource_gone");
								else if (pending.size === capacity)
									expectErrorCode(() => channel.request(toolCall(), options), "too_many_outstanding");
								else {
									const controller = new AbortController();
									const promise = channel.request(toolCall(), options, controller.signal);
									const request = channel.list().requests.at(-1)!;
									pending.set(request.id, { controller, promise });
								}
							} else if ((command === "allow" || command === "reject" || command === "abort") && first) {
								const [id, entry] = first;
								if (command === "abort") entry.controller.abort();
								else channel.respond({ sessionId: "session-1", id, optionId: command });
								expect(await entry.promise).toEqual(
									command === "abort"
										? { outcome: "cancelled" }
										: {
												outcome: "selected",
												optionId: command,
												kind: command === "allow" ? "allow_once" : "reject_once",
											},
								);
								pending.delete(id);
								expectErrorCode(
									() => channel.respond({ sessionId: "session-1", id, optionId: "allow" }),
									"invalid_input",
								);
							} else if (command === "enable") {
								if (disposed) expectErrorCode(() => channel.configure({ enabled: true }), "resource_gone");
								else {
									channel.configure({ enabled: true });
									enabled = true;
								}
							} else if (["cancel", "disable", "dispose", "expire"].includes(command)) {
								if (command === "cancel") channel.cancelPending();
								if (command === "disable") {
									channel.configure({ enabled: false });
									enabled = false;
								}
								if (command === "dispose") {
									channel.dispose();
									enabled = false;
									disposed = true;
								}
								if (command === "expire") vi.advanceTimersByTime(10);
								for (const entry of pending.values())
									expect(await entry.promise).toEqual({ outcome: "cancelled" });
								pending.clear();
							}
							expect(channel.enabled).toBe(enabled);
							expect(channel.list().requests.map(request => request.id)).toEqual([...pending.keys()]);
						}
					} finally {
						channel.dispose();
						for (const entry of pending.values()) expect(await entry.promise).toEqual({ outcome: "cancelled" });
						vi.useRealTimers();
					}
				},
			),
			{ seed: 749502, numRuns: 200 },
		);
	});

	it("property: UTF-8 and JSON escaping cannot bypass aggregate payload limits", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom("a", "한", "🦞", '"', "\n"),
				fc.integer({ min: -2, max: 2 }),
				async (character, delta) => {
					const channel = runtime();
					try {
						const empty = channel.request(toolCall({ rawInput: { text: "" } }), options);
						const overhead = new TextEncoder().encode(JSON.stringify(channel.list())).byteLength;
						channel.cancelPending();
						expect(await empty).toEqual({ outcome: "cancelled" });
						const bytesPerCharacter = new TextEncoder().encode(JSON.stringify(character)).byteLength - 2;
						const length = Math.floor((192 * 1024 - overhead) / bytesPerCharacter) + delta;
						const call = toolCall({ rawInput: { text: character.repeat(length) } });
						if (overhead + length * bytesPerCharacter > 192 * 1024) {
							expectErrorCode(() => channel.request(call, options), "payload_too_large");
							expect(channel.list().requests).toEqual([]);
						} else {
							const pending = channel.request(call, options);
							const before = channel.list();
							expectErrorCode(() => channel.request(call, options), "payload_too_large");
							expect(channel.list()).toEqual(before);
							channel.cancelPending();
							expect(await pending).toEqual({ outcome: "cancelled" });
						}
						expectErrorCode(
							() => channel.request(toolCall({ rawInput: character.repeat(260 * 1024) }), options),
							"payload_too_large",
						);
					} finally {
						channel.dispose();
					}
				},
			),
			{ seed: 749503, numRuns: 50 },
		);
	});
});
