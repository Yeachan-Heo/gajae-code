import { describe, expect, it } from "bun:test";
import { SlackLiveProvider, SlackProviderError, type SlackWebSocket } from "../src/sdk/bus/slack-live-provider";

class FakeSocket implements SlackWebSocket {
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	readonly sent: string[] = [];
	closed = false;

	constructor(readonly url: string) {}

	open(): void {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}

	message(value: unknown): void {
		this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
	}

	close(): void {
		this.closed = true;
		this.readyState = 3;
		this.onclose?.(new CloseEvent("close"));
	}

	disconnect(): void {
		this.readyState = 3;
		this.onclose?.(new CloseEvent("close"));
	}

	send(data: string): void {
		this.sent.push(data);
	}
}

type RecordedRequest = { url: string; init: RequestInit | undefined };

async function flushAsyncWork(): Promise<void> {
	for (let index = 0; index < 6; index++) {
		await Promise.resolve();
		await Bun.sleep(0);
	}
}

function response(body: object, status = 200, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function setup(
	responses: Array<Response | Error>,
	options: { sleep?: (milliseconds: number) => Promise<void> } = {},
): {
	provider: SlackLiveProvider;
	sockets: FakeSocket[];
	requests: RecordedRequest[];
	sleeps: number[];
} {
	const sockets: FakeSocket[] = [];
	const requests: RecordedRequest[] = [];
	const sleeps: number[] = [];
	const provider = new SlackLiveProvider({
		appToken: "xapp-secret",
		botToken: "xoxb-secret",
		fetch: async (url, init) => {
			requests.push({ url, init });
			const next = responses.shift();
			if (!next) throw new Error("unexpected request");
			if (next instanceof Error) throw next;
			return next;
		},
		webSocket: url => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			queueMicrotask(() => socket.open());
			return socket;
		},
		now: () => 1_000,
		sleep: async milliseconds => {
			sleeps.push(milliseconds);
			await options.sleep?.(milliseconds);
		},
	});
	return { provider, sockets, requests, sleeps };
}

describe("SlackLiveProvider fake Socket Mode protocol", () => {
	it("opens Socket Mode and emits acknowledgement bytes before handler processing", async () => {
		const fixture = setup([response({ ok: true, url: "wss://socket.test" })]);
		const order: string[] = [];
		await fixture.provider.start(envelope => {
			void (async () => {
				await fixture.provider.ack(envelope.envelope_id);
				order.push("processed");
			})();
		});
		expect(fixture.requests[0]?.url).toBe("https://slack.com/api/apps.connections.open");
		expect(fixture.sockets[0]?.url).toBe("wss://socket.test");
		fixture.sockets[0]?.message({ envelope_id: "e-1", payload: { type: "events_api" } });
		await Promise.resolve();
		expect(fixture.sockets[0]?.sent).toEqual([JSON.stringify({ envelope_id: "e-1" })]);
		expect(order).toEqual(["processed"]);
	});

	it("reconnects after disconnect and accepts Socket Mode redelivery without storing a cursor", async () => {
		const fixture = setup([
			response({ ok: true, url: "wss://one.test" }),
			response({ ok: true, url: "wss://two.test" }),
		]);
		const received: string[] = [];
		await fixture.provider.start(envelope => {
			received.push(envelope.envelope_id);
		});
		fixture.sockets[0]?.disconnect();
		await flushAsyncWork();
		expect(fixture.sleeps).toEqual([1_000]);
		expect(fixture.sockets[1]?.url).toBe("wss://two.test");
		fixture.sockets[1]?.message({ envelope_id: "redelivered", payload: {} });
		expect(received).toEqual(["redelivered"]);
		expect(JSON.stringify(fixture.provider)).not.toContain("cursor");
	});

	it("keeps retrying replacement opens beyond three failures until Socket Mode recovers", async () => {
		const fixture = setup([
			response({ ok: true, url: "wss://one.test" }),
			new Error("replacement unavailable"),
			new Error("replacement unavailable"),
			new Error("replacement unavailable"),
			new Error("replacement unavailable"),
			response({ ok: true, url: "wss://recovered.test" }),
		]);
		await fixture.provider.start(() => {});
		fixture.sockets[0]?.disconnect();
		await flushAsyncWork();
		expect(fixture.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
		expect(fixture.sockets[1]?.url).toBe("wss://recovered.test");
	});

	it("posts and reconciles client message IDs through history and thread replies", async () => {
		const fixture = setup([
			response({ ok: true, channel: "C1", ts: "1.0", client_msg_id: "client-1" }),
			response({ ok: true, messages: [] }),
			response({ ok: true, messages: [{ ts: "2.0", client_msg_id: "client-1" }] }),
		]);
		await expect(
			fixture.provider.postMessage({ channel: "C1", text: "hello", threadTs: "0.0", clientMsgId: "client-1" }),
		).resolves.toEqual({
			channel: "C1",
			ts: "1.0",
			client_msg_id: "client-1",
		});
		await expect(
			fixture.provider.findMessageByClientMsgId({ channel: "C1", threadTs: "0.0", clientMsgId: "client-1" }),
		).resolves.toEqual({
			channel: "C1",
			ts: "2.0",
			client_msg_id: "client-1",
		});
		expect(fixture.requests.map(request => request.url)).toEqual([
			"https://slack.com/api/chat.postMessage",
			"https://slack.com/api/conversations.history",
			"https://slack.com/api/conversations.replies",
		]);
		expect(fixture.requests[0]?.init?.body).toContain("client_msg_id");
	});

	it("bounds rate-limit retry and exposes no credential in typed errors", async () => {
		const fixture = setup([
			response({ ok: false }, 429, { "retry-after": "120" }),
			response({ ok: true, channel: "C1", ts: "1.0" }),
		]);
		await fixture.provider.postMessage({ channel: "C1", text: "hello", clientMsgId: "client-1" });
		expect(fixture.sleeps).toEqual([60_000]);

		const limited = setup([
			response({ ok: false }, 429, { "retry-after": "1" }),
			response({ ok: false }, 429, { "retry-after": "1" }),
		]);
		let error: unknown;
		try {
			await limited.provider.postMessage({ channel: "C1", text: "hello", clientMsgId: "client-1" });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SlackProviderError);
		expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 1_000 });
		expect(`${error}`).not.toContain("xoxb-secret");
		expect(JSON.stringify(error)).not.toContain("xoxb-secret");
	});

	it("stops a pending reconnect before it can open another Socket Mode connection", async () => {
		let releaseSleep: (() => void) | undefined;
		const sleepStarted = new Promise<void>(resolve => {
			releaseSleep = resolve;
		});
		const fixture = setup(
			[response({ ok: true, url: "wss://socket.test" }), response({ ok: true, url: "wss://replacement.test" })],
			{ sleep: async () => await sleepStarted },
		);
		await fixture.provider.start(() => {});
		fixture.sockets[0]?.disconnect();
		await Promise.resolve();
		await fixture.provider.stop();
		releaseSleep?.();
		await flushAsyncWork();
		expect(fixture.sockets[0]?.readyState).toBe(3);
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.sockets).toHaveLength(1);
	});
	it("marks a half-open Socket Mode connection unhealthy and reconnects", async () => {
		let now = 1_000;
		const sockets: FakeSocket[] = [];
		const responses = [response({ ok: true, url: "wss://one.test" }), response({ ok: true, url: "wss://two.test" })];
		const provider = new SlackLiveProvider({
			appToken: "xapp-secret",
			botToken: "xoxb-secret",
			activityTimeoutMs: 100,
			now: () => now,
			fetch: async () => responses.shift()!,
			webSocket: url => {
				const socket = new FakeSocket(url);
				sockets.push(socket);
				queueMicrotask(() => socket.open());
				return socket;
			},
			sleep: async () => undefined,
		});
		await provider.start(() => {});
		expect(provider.transportHealthy).toBe(true);
		now += 101;
		expect(provider.transportHealthy).toBe(false);
		expect(sockets[0]?.closed).toBe(true);
		await flushAsyncWork();
		expect(sockets[1]?.url).toBe("wss://two.test");
		expect(provider.transportHealthy).toBe(true);
		await provider.stop();
	});

	it("exposes callback failures as unhealthy until a later delivery succeeds", async () => {
		const fixture = setup([response({ ok: true, url: "wss://socket.test" })]);
		await fixture.provider.start(async envelope => {
			if (envelope.envelope_id === "failure") throw new Error("durable dispatch failed");
		});
		fixture.sockets[0]?.message({ envelope_id: "failure", payload: {} });
		await flushAsyncWork();
		expect(fixture.provider.transportHealthy).toBe(false);
		fixture.sockets[0]?.message({ envelope_id: "recovered", payload: {} });
		await flushAsyncWork();
		expect(fixture.provider.transportHealthy).toBe(true);
		await fixture.provider.stop();
	});

	it("rejects Socket Mode startup when the socket closes before open", async () => {
		const sockets: FakeSocket[] = [];
		const provider = new SlackLiveProvider({
			appToken: "xapp-secret",
			botToken: "xoxb-secret",
			fetch: async () => response({ ok: true, url: "wss://socket.test" }),
			webSocket: url => {
				const socket = new FakeSocket(url);
				sockets.push(socket);
				return socket;
			},
		});
		const started = provider.start(() => {});
		for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt++) await Bun.sleep(1);
		expect(sockets).toHaveLength(1);
		sockets[0]?.disconnect();
		await expect(started).rejects.toMatchObject({ code: "connection", operation: "socket_connect" });
	});
});
