import { describe, expect, test } from "bun:test";
import { type DiscordGatewaySocket, DiscordLiveProvider } from "../src/sdk/bus/discord-live-provider";
import type { DiscordInboundEvent } from "../src/sdk/bus/discord-provider";

type Listener = (event: Event) => void;

class FakeSocket implements DiscordGatewaySocket {
	readyState = 1;
	readonly sent: string[] = [];
	readonly listeners = new Map<string, Listener[]>();
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = 3;
		this.emit("close", new Event("close"));
	}
	addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	emit(type: string, event: Event): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
	message(frame: Record<string, unknown>): void {
		this.emit("message", new MessageEvent("message", { data: JSON.stringify(frame) }));
	}
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function provider(
	requests: Array<{ path: string; init: RequestInit }>,
	sockets: FakeSocket[],
	sleeps: number[] = [],
	heartbeats: Array<() => void> = [],
): DiscordLiveProvider {
	return new DiscordLiveProvider({
		applicationId: "app",
		botToken: "discord-secret-token",
		apiBaseUrl: "https://discord.test/api",
		fetchImpl: async (input, init) => {
			requests.push({ path: String(input), init: init ?? {} });
			const path = String(input);
			if (path.endsWith("/users/@me")) return response({ id: "bot" });
			if (path.endsWith("/gateway/bot")) return response({ url: "wss://gateway.test" });
			if (path.includes("/threads/active"))
				return response({ threads: [{ id: "thread", parent_id: "parent", thread_metadata: { archived: false } }] });
			if (path.includes("archived/public")) return response({ threads: [] });
			if (path.includes("/messages?limit")) return response([]);
			if (path.endsWith("/channels/parent/messages")) return response({ id: "starter" });
			if (path.endsWith("/channels/parent/messages/starter/threads"))
				return response({ id: "thread", parent_id: "parent", thread_metadata: { archived: false } });
			if (path.includes("/interactions/")) return new Response(null, { status: 204 });
			if (path.includes("/messages")) return response({ id: "message" });
			return response({ id: "thread", parent_id: "parent", thread_metadata: { archived: false } });
		},
		WebSocketImpl: url => {
			expect(url).toBe("wss://gateway.test/?v=10&encoding=json");
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		sleep: async milliseconds => {
			sleeps.push(milliseconds);
		},
		setIntervalImpl: callback => {
			heartbeats.push(callback);
			return { cancel() {} };
		},
		setTimeoutImpl: callback => {
			callback();
			return { cancel() {} };
		},
	});
}

describe("DiscordLiveProvider protocol", () => {
	test("creates a generic-text-parent thread from a durable nonce starter message", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const sockets: FakeSocket[] = [];
		const live = provider(requests, sockets);
		await live.createThread({ guildId: "guild", parentId: "parent", name: "Session", nonce: "nonce" });
		const starter = requests.find(request => request.path === "https://discord.test/api/channels/parent/messages")!;
		const thread = requests.find(
			request => request.path === "https://discord.test/api/channels/parent/messages/starter/threads",
		)!;
		expect(new Headers(starter.init.headers).get("Authorization")).toBe("Bot discord-secret-token");
		expect(JSON.parse(String(starter.init.body))).toEqual({ content: "<!-- gjc-thread-nonce:nonce -->" });
		expect(String(starter.init.body)).not.toContain("discord-secret-token");
		expect(JSON.parse(String(thread.init.body))).toEqual({ name: "Session", auto_archive_duration: 1_440 });
		expect(String(thread.init.body)).not.toContain('"message"');
		expect(requests.map(request => request.path)).not.toContain("https://discord.test/api/channels/parent/threads");
		expect(thread.init.method).toBe("POST");
	});

	test("reconciles an accepted uncertain create through its parent nonce without a duplicate thread", async () => {
		const sockets: FakeSocket[] = [];
		let threadCreated = false;
		let threadCreates = 0;
		let starterMessages = 0;
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input => {
				const path = String(input);
				if (path.endsWith("/channels/parent/messages?limit=100")) {
					return response(
						threadCreated
							? [
									{
										id: "starter",
										content: "<!-- gjc-thread-nonce:nonce -->",
										thread: { id: "public-thread", thread_metadata: { archived: false } },
									},
								]
							: [],
					);
				}
				if (path.endsWith("/channels/parent/messages")) {
					starterMessages++;
					return response({ id: "starter" });
				}
				if (path.endsWith("/channels/parent/messages/starter/threads")) {
					threadCreates++;
					threadCreated = true;
					throw new Error("connection lost after Discord accepted the create");
				}
				return response({ threads: [] });
			},
			WebSocketImpl: () => new FakeSocket(),
		});
		await expect(
			live.createThread({ guildId: "guild", parentId: "parent", name: "Session", nonce: "nonce" }),
		).rejects.toThrow("connection lost");
		expect(
			await live.createThread({ guildId: "guild", parentId: "parent", name: "Session", nonce: "nonce" }),
		).toMatchObject({ id: "public-thread", parentId: "parent" });
		expect({ starterMessages, threadCreates }).toEqual({ starterMessages: 1, threadCreates: 1 });
		expect(sockets).toEqual([]);
	});

	test("serializes Discord select controls and maps selected gateway values", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const sockets: FakeSocket[] = [];
		const events: DiscordInboundEvent[] = [];
		const live = provider(requests, sockets);
		await live.postMessage({
			threadId: "thread",
			content: "Choose",
			components: [
				{ type: 1, components: [{ type: 3, customId: "gjc:4:ask", options: [{ label: "Yes", value: "yes" }] }] },
			],
		});
		const payload = JSON.parse(String(requests[0]?.init.body)) as {
			components: Array<{ components: Array<{ custom_id: string; options: Array<{ value: string }> }> }>;
		};
		expect(payload.components[0]?.components[0]).toMatchObject({
			custom_id: "gjc:4:ask",
			options: [{ value: "yes" }],
		});
		await live.start(async event => {
			events.push(event);
		});
		const socket = sockets[0]!;
		socket.message({ op: 10, d: { heartbeat_interval: 1 } });
		socket.message({
			op: 0,
			t: "INTERACTION_CREATE",
			s: 5,
			d: {
				id: "interaction",
				token: "interaction-token",
				guild_id: "guild",
				channel_id: "thread",
				channel: { parent_id: "parent" },
				member: { user: { id: "member" } },
				data: { custom_id: "gjc:4:ask", values: ["yes"] },
			},
		});
		await Promise.resolve();
		expect(events[0]?.interaction).toEqual({
			id: "interaction",
			token: "interaction-token",
			customId: "gjc:4:ask",
			value: "yes",
		});
		await live.stop();
	});

	test("defers accepted components through the unauthenticated interaction callback without leaking credentials", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const sockets: FakeSocket[] = [];
		const live = provider(requests, sockets);
		await live.deferInteraction({ id: "interaction", token: "interaction-callback-token" });
		const callback = requests[0]!;
		expect(callback.path).toBe(
			"https://discord.test/api/interactions/interaction/interaction-callback-token/callback",
		);
		expect(callback.init.method).toBe("POST");
		expect(callback.init.body).toBe(JSON.stringify({ type: 6 }));
		expect(new Headers(callback.init.headers).get("Authorization")).toBeNull();
		expect(JSON.stringify(callback.init)).not.toContain("discord-secret-token");
		expect(String(callback.init.body)).not.toContain("interaction-callback-token");
	});

	test("sends stable message nonces with Discord provider enforcement", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const sockets: FakeSocket[] = [];
		const live = provider(requests, sockets);
		await live.postMessage({ threadId: "thread", content: "durable", nonce: "gjc-stable-nonce" });
		const post = requests.find(request => request.path === "https://discord.test/api/channels/thread/messages")!;
		expect(post.init.method).toBe("POST");
		expect(JSON.parse(String(post.init.body))).toEqual({
			content: "durable",
			nonce: "gjc-stable-nonce",
			enforce_nonce: true,
		});
	});

	test("uses provider-enforced stable nonces after more than one hundred intervening messages", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const accepted = new Map<string, string>();
		let created = 0;
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async (input, init) => {
				requests.push({ path: String(input), init: init ?? {} });
				const payload = JSON.parse(String(init?.body)) as { nonce?: string; enforce_nonce?: boolean };
				const existing =
					payload.nonce === undefined || !payload.enforce_nonce ? undefined : accepted.get(payload.nonce);
				if (existing) return response({ id: existing });
				const id = `message-${++created}`;
				if (payload.nonce !== undefined) accepted.set(payload.nonce, id);
				return response({ id });
			},
			WebSocketImpl: () => new FakeSocket(),
		});
		const first = await live.postMessage({ threadId: "thread", content: "durable", nonce: "gjc-stable-nonce" });
		for (let index = 0; index < 101; index++)
			await live.postMessage({ threadId: "thread", content: `churn-${index}` });
		const retried = await live.postMessage({ threadId: "thread", content: "durable", nonce: "gjc-stable-nonce" });
		expect(retried).toEqual(first);
		expect(created).toBe(102);
		expect(requests).toHaveLength(103);
		expect(requests.every(request => !request.path.includes("?limit=100"))).toBe(true);
	});
	test("finds an accepted post by its stable nonce for journal receipt reconstruction", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async (input, init) => {
				requests.push({ path: String(input), init: init ?? {} });
				return response([{ id: "accepted-message", nonce: "gjc-nonce" }]);
			},
			WebSocketImpl: () => new FakeSocket(),
		});
		expect(await live.findMessageByNonce({ threadId: "thread", nonce: "gjc-nonce" })).toEqual({
			id: "accepted-message",
		});
		expect(await live.findMessageByNonce({ threadId: "thread", nonce: "other" })).toBeNull();
		expect(requests.map(request => request.path)).toEqual([
			"https://discord.test/api/channels/thread/messages?limit=100",
			"https://discord.test/api/channels/thread/messages?limit=100",
		]);
	});

	test("identifies, heartbeats, maps inbound events, reconnects, and stops cleanly", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const sockets: FakeSocket[] = [];
		const events: string[] = [];
		const live = provider(requests, sockets);
		await live.start(async event => {
			events.push(event.id);
		});
		const socket = sockets[0]!;
		socket.message({ op: 10, d: { heartbeat_interval: 1 } });
		expect(socket.sent.map(value => JSON.parse(value))).toContainEqual(
			expect.objectContaining({ op: 2, d: expect.objectContaining({ token: "discord-secret-token" }) }),
		);
		socket.message({
			op: 0,
			t: "MESSAGE_CREATE",
			s: 4,
			d: {
				id: "message",
				guild_id: "guild",
				channel_id: "thread",
				thread: { parent_id: "parent" },
				author: { id: "member", bot: false },
				content: "reply",
			},
		});
		socket.message({
			op: 0,
			t: "INTERACTION_CREATE",
			s: 5,
			d: {
				id: "interaction",
				token: "interaction-token",
				guild_id: "guild",
				channel_id: "thread",
				channel: { parent_id: "parent" },
				member: { user: { id: "member" } },
				data: { custom_id: "gjc:1:ask", value: "yes" },
			},
		});
		await Promise.resolve();
		expect(events).toEqual(["message", "interaction"]);
		socket.close();
		expect(sockets).toHaveLength(2);
		await live.stop();
		expect(sockets[1]?.readyState).toBe(3);
		expect(requests.map(request => request.path).join("\n")).not.toContain("discord-secret-token");
	});

	test("bounds rate-limit retries without leaking its token in errors", async () => {
		let calls = 0;
		const sleeps: number[] = [];
		const limited = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			fetchImpl: async () => {
				calls++;
				return response({ retry_after: 0.01 }, 429);
			},
			sleep: async milliseconds => {
				sleeps.push(milliseconds);
			},
		});
		let error = "";
		try {
			await limited.postMessage({ threadId: "thread", content: "x" });
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		expect(error).toBe("Discord API rate limit retry exhausted");
		expect(error).not.toContain("discord-secret-token");
		expect(calls).toBe(3);
		expect(sleeps).toEqual([10, 10]);
	});

	test("resets stopped state after startup failure so a later start can connect", async () => {
		let attempts = 0;
		const sockets: FakeSocket[] = [];
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			fetchImpl: async input => {
				attempts++;
				if (attempts === 1) throw new Error("temporary startup failure");
				return String(input).endsWith("/users/@me")
					? response({ id: "bot" })
					: response({ url: "wss://gateway.test" });
			},
			WebSocketImpl: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
		});
		await expect(live.start(async () => {})).rejects.toThrow("temporary startup failure");
		await live.start(async () => {});
		expect(sockets).toHaveLength(1);
		await live.stop();
	});

	test("non-resumable invalid session clears resume state and waits before identifying", async () => {
		const sockets: FakeSocket[] = [];
		const delays: number[] = [];
		let reconnect: (() => void) | undefined;
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input =>
				String(input).endsWith("/users/@me") ? response({ id: "bot" }) : response({ url: "wss://gateway.test" }),
			WebSocketImpl: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			setTimeoutImpl: (callback, milliseconds) => {
				delays.push(milliseconds);
				reconnect = callback;
				return { cancel() {} };
			},
		});
		await live.start(async () => {});
		const first = sockets[0]!;
		first.message({ op: 10, d: { heartbeat_interval: 1 } });
		first.message({
			op: 0,
			t: "READY",
			s: 7,
			d: { session_id: "resume-me", resume_gateway_url: "wss://resume.test" },
		});
		first.message({ op: 9, d: false });
		expect(delays).toEqual([1_000]);
		expect(sockets).toHaveLength(1);
		reconnect?.();
		expect(sockets).toHaveLength(2);
		const second = sockets[1]!;
		second.message({ op: 10, d: { heartbeat_interval: 1 } });
		const frames = second.sent.map(value => JSON.parse(value) as { op: number });
		expect(frames).toContainEqual(expect.objectContaining({ op: 2 }));
		expect(frames).not.toContainEqual(expect.objectContaining({ op: 6 }));
		await live.stop();
	});

	test("resumable invalid session retains resume state and resumes after the retry delay", async () => {
		const sockets: FakeSocket[] = [];
		const delays: number[] = [];
		let reconnect: (() => void) | undefined;
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input =>
				String(input).endsWith("/users/@me") ? response({ id: "bot" }) : response({ url: "wss://gateway.test" }),
			WebSocketImpl: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			setTimeoutImpl: (callback, milliseconds) => {
				delays.push(milliseconds);
				reconnect = callback;
				return { cancel() {} };
			},
		});
		await live.start(async () => {});
		const first = sockets[0]!;
		first.message({ op: 10, d: { heartbeat_interval: 1 } });
		first.message({
			op: 0,
			t: "READY",
			s: 7,
			d: { session_id: "resume-me", resume_gateway_url: "wss://resume.test" },
		});
		first.message({ op: 9, d: true });
		expect(delays).toEqual([1_000]);
		expect(sockets).toHaveLength(1);
		reconnect?.();
		expect(sockets).toHaveLength(2);
		const second = sockets[1]!;
		second.message({ op: 10, d: { heartbeat_interval: 1 } });
		expect(second.sent.map(value => JSON.parse(value))).toContainEqual({
			op: 6,
			d: { token: "discord-secret-token", session_id: "resume-me", seq: 7 },
		});
		await live.stop();
	});
	test("requires READY or RESUMED plus a heartbeat ACK before reporting a healthy transport", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const sockets: FakeSocket[] = [];
		const heartbeats: Array<() => void> = [];
		const live = provider(requests, sockets, [], heartbeats);
		await live.start(async () => {});
		const first = sockets[0]!;
		expect(live.transportHealthy).toBe(false);
		first.message({ op: 10, d: { heartbeat_interval: 1 } });
		first.message({ op: 0, t: "READY", s: 1, d: { session_id: "session" } });
		expect(live.transportHealthy).toBe(false);
		first.message({ op: 11, d: null });
		expect(live.transportHealthy).toBe(true);

		heartbeats[0]!();
		expect(live.transportHealthy).toBe(false);
		heartbeats[0]!();
		expect(first.readyState).toBe(3);
		expect(live.transportHealthy).toBe(false);
		expect(sockets).toHaveLength(2);

		const second = sockets[1]!;
		second.message({ op: 10, d: { heartbeat_interval: 1 } });
		second.message({ op: 11, d: null });
		second.message({ op: 0, t: "RESUMED", s: 2, d: {} });
		expect(live.transportHealthy).toBe(true);
		await live.stop();
	});
});
