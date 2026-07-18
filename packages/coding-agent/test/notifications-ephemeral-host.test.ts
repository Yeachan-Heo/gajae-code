import { afterEach, describe, expect, it, vi } from "bun:test";
import { EphemeralTurnHost } from "../src/sdk/bus/index";

type Frame = Record<string, unknown>;

const sent: Array<{ connectionId: string; frame: Frame }> = [];

function request(overrides: Record<string, unknown> = {}): Frame {
	return {
		type: "ephemeral_turn",
		sessionId: "session",
		requestId: "request",
		updateId: 1,
		messageId: 1,
		threadId: "thread",
		question: "question",
		...overrides,
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
function configure(
	host: EphemeralTurnHost,
	authority: { sessionId?: string; endpointDigest?: string; eventGeneration?: number } = {},
): void {
	host.configureAuthority({
		sessionId: authority.sessionId ?? "session",
		endpointDigest: authority.endpointDigest ?? "digest",
		eventGeneration: authority.eventGeneration ?? 1,
	});
}

afterEach(() => {
	sent.length = 0;
	vi.useRealTimers();
});

describe("EphemeralTurnHost", () => {
	it("limits a logical session to two active turns and emits a failed busy terminal", () => {
		const pending = Promise.withResolvers<{ replyText: string }>();
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async () => await pending.promise,
		);
		configure(host);
		host.handle("one", request({ requestId: "one" }));
		host.handle("two", request({ requestId: "two" }));
		host.handle("three", request({ requestId: "three" }));

		expect(sent).toEqual([
			expect.objectContaining({ connectionId: "three", frame: expect.objectContaining({ status: "busy" }) }),
		]);
	});
	it("does not swallow an active terminal delivery failure", () => {
		const pending = Promise.withResolvers<{ replyText: string }>();
		const host = new EphemeralTurnHost(
			() => {
				throw new Error("directed delivery failed");
			},
			async () => await pending.promise,
		);
		configure(host);

		host.handle("one", request({ requestId: "one" }));
		host.handle("two", request({ requestId: "two" }));

		expect(() => host.handle("three", request({ requestId: "three" }))).toThrow("directed delivery failed");
		host.dispose();
	});
	it("contains a rejected terminal delivery without disrupting later turns", async () => {
		const pending = Promise.withResolvers<{ replyText: string }>();
		const delivered: Array<{ connectionId: string; frame: Frame }> = [];
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
		let executions = 0;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => {
				if (connectionId === "disconnected") throw new Error("directed delivery failed");
				delivered.push({ connectionId, frame });
			},
			async question => {
				executions += 1;
				return question === "first" ? await pending.promise : { replyText: "second answer" };
			},
		);
		configure(host);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			host.handle("disconnected", request({ requestId: "first", question: "first" }));
			pending.resolve({ replyText: "first answer" });
			await flush();
			host.handle("reconnected", request({ requestId: "first", question: "first" }));

			host.handle("healthy", request({ requestId: "second", question: "second" }));
			await flush();

			expect(unhandled).toEqual([]);
			expect(executions).toBe(2);
			expect(delivered).toEqual([
				expect.objectContaining({
					connectionId: "reconnected",
					frame: expect.objectContaining({ requestId: "first", status: "ok", text: "first answer" }),
				}),
				expect.objectContaining({
					connectionId: "healthy",
					frame: expect.objectContaining({ requestId: "second", status: "ok", text: "second answer" }),
				}),
			]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			host.dispose();
		}
	});

	it("suppresses terminal completion when the host is disposed or its delivery route is no longer authoritative", async () => {
		const disposedPending = Promise.withResolvers<{ replyText: string }>();
		const stalePending = Promise.withResolvers<{ replyText: string }>();
		const delivered: Array<{ connectionId: string; frame: Frame }> = [];
		const disposedHost = new EphemeralTurnHost(
			(connectionId, frame) => delivered.push({ connectionId, frame }),
			async () => await disposedPending.promise,
		);
		configure(disposedHost);

		disposedHost.handle("disposed", request({ requestId: "disposed" }));
		disposedHost.dispose();
		disposedPending.resolve({ replyText: "late" });
		await flush();

		let authoritative = true;
		const staleHost = new EphemeralTurnHost(
			(connectionId, frame) => {
				if (authoritative) delivered.push({ connectionId, frame });
			},
			async () => await stalePending.promise,
		);
		configure(staleHost);
		staleHost.handle("stale", request({ requestId: "stale" }));
		authoritative = false;
		stalePending.resolve({ replyText: "late" });
		await flush();

		expect(delivered).toEqual([]);
		staleHost.dispose();
	});
	it("fences active work and ignores inbound turns and cancellations while notifications are disabled", async () => {
		const pending = Promise.withResolvers<{ replyText: string }>();
		let executions = 0;
		let activeSignal: AbortSignal | undefined;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async (_question, signal) => {
				executions++;
				activeSignal = signal;
				return await pending.promise;
			},
		);
		configure(host);
		const active = request({ requestId: "active" });
		host.handle("owner", active);
		expect(executions).toBe(1);

		host.disable();
		expect(activeSignal?.aborted).toBe(true);
		host.handle("disabled", request({ requestId: "disabled" }));
		host.handle("disabled", { ...active, type: "ephemeral_turn_cancel", reason: "daemon_shutdown" });
		pending.resolve({ replyText: "stale" });
		await flush();
		expect(executions).toBe(1);
		expect(sent).toEqual([]);

		host.enable();
		host.handle("reenabled", request({ requestId: "reenabled" }));
		await flush();
		expect(executions).toBe(2);
		expect(sent).toEqual([
			expect.objectContaining({
				connectionId: "reenabled",
				frame: expect.objectContaining({ requestId: "reenabled", status: "ok", text: "stale" }),
			}),
		]);
		host.dispose();
	});

	it("terminalizes immediately when authenticated cancellation or session loss aborts the controller", async () => {
		let signal: AbortSignal | undefined;
		const pending = Promise.withResolvers<{ replyText: string }>();
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async (_promptText, receivedSignal) => {
				signal = receivedSignal;
				return await pending.promise;
			},
		);
		configure(host);
		const frame = request();
		host.handle("owner", frame);
		expect(signal).toBeInstanceOf(AbortSignal);
		host.handle("owner", { ...frame, type: "ephemeral_turn_cancel", reason: "daemon_shutdown" });
		expect(signal?.aborted).toBe(true);
		expect(sent.at(-1)?.frame).toMatchObject({ status: "cancelled" });
		const second = request({ requestId: "second" });
		host.handle("owner", second);
		host.sessionUnavailable("session");
		expect(sent.at(-1)?.frame).toMatchObject({ requestId: "second", status: "session_unavailable" });
		pending.resolve({ replyText: "late" });
		await flush();
		expect(sent.filter(item => item.frame.requestId === "request")).toHaveLength(1);
	});
	it("aborts disabled turns while admitting a later re-enabled turn", async () => {
		const first = Promise.withResolvers<{ replyText: string }>();
		const second = Promise.withResolvers<{ replyText: string }>();
		const pending = [first, second];
		let signal: AbortSignal | undefined;
		let executions = 0;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async (_promptText, receivedSignal) => {
				signal = receivedSignal;
				return await pending[executions++]!.promise;
			},
		);
		configure(host);

		host.handle("owner", request({ requestId: "before-disable" }));
		host.sessionUnavailable("session");
		expect(signal?.aborted).toBe(true);
		expect(sent.at(-1)?.frame).toMatchObject({ requestId: "before-disable", status: "session_unavailable" });

		host.handle("owner", request({ requestId: "after-enable" }));
		second.resolve({ replyText: "available again" });
		await flush();

		expect(executions).toBe(2);
		expect(sent.at(-1)?.frame).toMatchObject({
			requestId: "after-enable",
			status: "ok",
			text: "available again",
		});
		first.resolve({ replyText: "late" });
		await flush();
		host.dispose();
	});
	it("aborts the provider's real signal at the deterministic deadline", () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const pending = Promise.withResolvers<{ replyText: string }>();
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async (_promptText, receivedSignal) => {
				signal = receivedSignal;
				return await pending.promise;
			},
		);
		configure(host);
		host.handle("owner", request());
		vi.advanceTimersByTime(120_000);
		expect(signal?.aborted).toBe(true);
	});
	it("releases an aborted active slot before an executor that ignores cancellation settles", async () => {
		const first = Promise.withResolvers<{ replyText: string }>();
		const second = Promise.withResolvers<{ replyText: string }>();
		const third = Promise.withResolvers<{ replyText: string }>();
		const pending = [first, second, third];
		let executions = 0;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async () => await pending[executions++]!.promise,
		);
		configure(host);
		const one = request({ requestId: "one" });
		host.handle("one", one);
		host.handle("two", request({ requestId: "two" }));
		host.handle("one", { ...one, type: "ephemeral_turn_cancel", reason: "daemon_shutdown" });
		host.handle("three", request({ requestId: "three" }));

		expect(executions).toBe(3);
		expect(sent).toEqual([
			expect.objectContaining({
				connectionId: "one",
				frame: expect.objectContaining({ requestId: "one", status: "cancelled" }),
			}),
		]);

		first.resolve({ replyText: "late" });
		await flush();
		expect(sent).toHaveLength(1);
		host.sessionUnavailable("session");
	});

	it("keeps a replacement connection authoritative after an original connection replays the active tuple", async () => {
		const pending = Promise.withResolvers<{ replyText: string }>();
		let executions = 0;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async () => {
				executions++;
				return await pending.promise;
			},
		);
		configure(host);
		const frame = request();
		host.handle("original", frame);
		host.handle("replacement", frame);
		host.handle("original", frame);
		expect(executions).toBe(1);
		pending.resolve({ replyText: "answer" });
		await flush();
		expect(sent.map(item => item.connectionId)).toEqual(["replacement"]);
		host.handle("late", frame);
		expect(sent.at(-1)).toMatchObject({ connectionId: "late", frame: { status: "ok", text: "answer" } });
	});

	it("suppresses request-id conflicts while active and after terminal retention or payload eviction", async () => {
		const pending = Promise.withResolvers<{ replyText: string }>();
		let executions = 0;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async () => {
				executions++;
				return await pending.promise;
			},
		);
		configure(host);
		host.handle("owner", request());
		host.handle("active-conflict", request({ messageId: 2 }));
		expect(executions).toBe(1);
		pending.resolve({ replyText: "answer" });
		await flush();

		host.handle("terminal-conflict", request({ messageId: 2 }));
		expect(executions).toBe(1);
		host.evictTerminalEvents();
		host.handle("evicted-conflict", request({ messageId: 2 }));
		expect(executions).toBe(1);

		host.handle("replay", request());
		expect(sent.at(-1)).toMatchObject({ connectionId: "replay", frame: { status: "failed" } });
		expect(sent.at(-1)?.frame.text).toBeUndefined();
	});
	it("enforces the 262144-byte UTF-8 terminal result ceiling", async () => {
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async question => ({ replyText: question === "exact" ? "a".repeat(262_144) : "a".repeat(262_145) }),
		);
		configure(host);
		host.handle("exact", request({ requestId: "exact", question: "exact" }));
		await flush();
		expect(sent.at(-1)?.frame).toMatchObject({ requestId: "exact", status: "ok" });
		expect(Buffer.byteLength(String(sent.at(-1)?.frame.text), "utf8")).toBe(262_144);

		host.handle("over", request({ requestId: "over", question: "over" }));
		await flush();
		expect(sent.at(-1)?.frame).toMatchObject({ requestId: "over", status: "failed" });
		expect(sent.at(-1)?.frame.text).toBeUndefined();
	});
	it.each([
		["empty", ""],
		["whitespace-only", " \n\t"],
	])("turns a %s successful reply into a cached failed terminal", async (_label, replyText) => {
		let executions = 0;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async () => {
				executions += 1;
				return { replyText };
			},
		);
		configure(host);

		host.handle("owner", request());
		await flush();
		expect(sent.at(-1)).toMatchObject({ connectionId: "owner", frame: { status: "failed" } });
		expect(sent.at(-1)?.frame.text).toBeUndefined();

		host.handle("replay", request());
		expect(executions).toBe(1);
		expect(sent.at(-1)).toMatchObject({ connectionId: "replay", frame: { status: "failed" } });
		expect(sent.at(-1)?.frame.text).toBeUndefined();
	});

	it("rejects stale cancellation while allowing the replacement connection to cancel", () => {
		let signal: AbortSignal | undefined;
		const pending = Promise.withResolvers<{ replyText: string }>();
		let executions = 0;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async (_promptText, receivedSignal) => {
				signal = receivedSignal;
				executions++;
				return await pending.promise;
			},
		);
		configure(host);
		const frame = request();
		host.handle("owner", frame);
		host.handle("replacement", frame);
		host.handle("owner", frame);
		host.handle("other", { ...frame, type: "ephemeral_turn_cancel", reason: "daemon_shutdown" });
		host.handle("owner", { ...frame, type: "ephemeral_turn_cancel", reason: "wrong_reason" });
		expect(signal?.aborted).toBe(false);
		expect(executions).toBe(1);
		host.handle("replacement", frame);
		host.handle("owner", { ...frame, type: "ephemeral_turn_cancel", reason: "daemon_shutdown" });
		expect(signal?.aborted).toBe(false);
		host.handle("replacement", { ...frame, type: "ephemeral_turn_cancel", reason: "daemon_shutdown" });
		expect(signal?.aborted).toBe(true);
		expect(sent).toEqual([
			expect.objectContaining({
				connectionId: "replacement",
				frame: expect.objectContaining({ status: "cancelled" }),
			}),
		]);
	});
	it("expires terminal idempotency state on its owned idle timer", async () => {
		vi.useFakeTimers();
		let executions = 0;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async () => {
				executions++;
				return { replyText: "answer" };
			},
		);
		configure(host);
		const frame = request();

		host.handle("first", frame);
		await flush();
		expect(executions).toBe(1);

		vi.advanceTimersByTime(300_000);
		host.handle("after-expiry", frame);
		await flush();

		expect(executions).toBe(2);
		expect(sent.at(-1)).toMatchObject({
			connectionId: "after-expiry",
			frame: { requestId: "request", status: "ok", text: "answer" },
		});
		host.dispose();
	});

	it("bounds terminal tombstones to 256 records and admits the evicted oldest tuple", async () => {
		let executions = 0;
		const host = new EphemeralTurnHost(
			(connectionId, frame) => sent.push({ connectionId, frame }),
			async () => {
				executions++;
				return { replyText: "answer" };
			},
		);
		configure(host);
		const oldest = request({ requestId: "request-0", updateId: 0, messageId: 1 });

		for (let index = 0; index < 257; index++) {
			host.handle(
				`connection-${index}`,
				request({ requestId: `request-${index}`, updateId: index, messageId: index + 1 }),
			);
			await flush();
		}
		expect(executions).toBe(257);

		host.handle("oldest-retry", oldest);
		await flush();

		expect(executions).toBe(258);
		expect(sent.at(-1)).toMatchObject({
			connectionId: "oldest-retry",
			frame: { requestId: "request-0", status: "ok", text: "answer" },
		});
		host.dispose();
	});
});
it("fences strict frames by configured logical session, digest, and event generation", () => {
	let executions = 0;
	let signal: AbortSignal | undefined;
	const pending = Promise.withResolvers<{ replyText: string }>();
	const host = new EphemeralTurnHost(
		(connectionId, frame) => sent.push({ connectionId, frame }),
		async (_question, receivedSignal) => {
			executions++;
			signal = receivedSignal;
			return await pending.promise;
		},
	);
	host.handle("unconfigured", request());
	configure(host, { sessionId: "other", endpointDigest: "first", eventGeneration: 1 });
	host.handle("wrong-session", request());
	expect(executions).toBe(0);

	configure(host, { endpointDigest: "first", eventGeneration: 1 });
	host.handle("owner", request());
	expect(executions).toBe(1);
	configure(host, { endpointDigest: "second", eventGeneration: 1 });
	expect(signal?.aborted).toBe(true);

	configure(host, { endpointDigest: "second", eventGeneration: 2 });
	host.handle("generation-owner", request({ requestId: "generation" }));
	expect(executions).toBe(2);
});
