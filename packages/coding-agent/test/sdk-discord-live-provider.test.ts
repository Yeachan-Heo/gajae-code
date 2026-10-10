import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DiscordNotificationDaemon } from "../src/sdk/bus/discord-daemon";
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
	close(code = 1_000, reason = ""): void {
		this.readyState = 3;
		this.emit("close", new CloseEvent("close", { code, reason }));
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
	binary(frame: Record<string, unknown>): void {
		this.emit("message", new MessageEvent("message", { data: Buffer.from(JSON.stringify(frame)) }));
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
			if (path.endsWith("/applications/@me")) return response({ id: "app" });
			if (path.endsWith("/gateway/bot")) return response({ url: "wss://gateway.test" });
			if (path.includes("/threads/active"))
				return response({
					threads: [{ id: "thread", parent_id: "parent", owner_id: "bot", thread_metadata: { archived: false } }],
				});
			if (path.includes("archived/public")) return response({ threads: [] });
			if (path.includes("/messages?limit")) return response([]);
			if (path.endsWith("/channels/parent/messages")) return response({ id: "starter" });
			if (path.endsWith("/channels/parent/messages/starter/threads"))
				return response({
					id: "thread",
					parent_id: "parent",
					owner_id: "bot",
					thread_metadata: { archived: false },
				});
			if (path.includes("/interactions/")) return new Response(null, { status: 204 });
			if (path.includes("/messages")) return response({ id: "message" });
			return response({ id: "thread", parent_id: "parent", owner_id: "bot", thread_metadata: { archived: false } });
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

	test("probes the bot and current application endpoints", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const live = provider(requests, []);
		await expect(live.probeConfiguration()).resolves.toEqual({
			ok: true,
			detail: "Discord bot and application credentials are valid.",
			botUserId: "bot",
		});
		expect(requests.map(request => request.path)).toEqual([
			"https://discord.test/api/users/@me",
			"https://discord.test/api/applications/@me",
		]);
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
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) {
					return response(
						threadCreated
							? [
									{
										id: "starter",
										author: { id: "bot", bot: true },
										content: "<!-- gjc-thread-nonce:nonce -->",
										thread: {
											id: "public-thread",
											parent_id: "parent",
											owner_id: "bot",
											thread_metadata: { archived: false },
										},
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
		socket.binary({
			op: 0,
			t: "MESSAGE_CREATE",
			s: 4,
			d: {
				id: "message",
				guild_id: "guild",
				channel_id: "thread",
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
		await Bun.sleep(10);
		expect(events.sort()).toEqual(["interaction", "message"]);
		expect(requests.map(request => request.path)).toContain("https://discord.test/api/channels/thread");
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
	test("aborts the shared request authority when response JSON never settles", async () => {
		const body = Promise.withResolvers<unknown>();
		let requestSignal: AbortSignal | undefined;
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			fetchImpl: async (_input, init) => {
				requestSignal = init?.signal ?? undefined;
				return {
					status: 200,
					ok: true,
					json: () => body.promise,
				} as unknown as Response;
			},
		});
		await expect(live.postMessage({ threadId: "thread", content: "x" })).rejects.toThrow(
			"Discord API request timed out",
		);
		expect(requestSignal?.aborted).toBe(true);
	}, 10_000);

	test("keeps one deadline across rate-limit body parsing, sleep, retry, and the final body", async () => {
		let calls = 0;
		let now = 0;
		const signals: Array<AbortSignal | null | undefined> = [];
		const sleeps: number[] = [];
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			now: () => now,
			fetchImpl: async (_input, init) => {
				calls++;
				signals.push(init?.signal);
				if (calls === 1)
					return {
						status: 429,
						ok: false,
						json: async () => {
							now += 500;
							return { retry_after: 4 };
						},
					} as unknown as Response;
				return {
					status: 200,
					ok: true,
					json: async () => {
						now = 5_000;
						return {};
					},
				} as unknown as Response;
			},
			sleep: async milliseconds => {
				sleeps.push(milliseconds);
				now += milliseconds;
			},
		});
		await expect(live.postMessage({ threadId: "thread", content: "x" })).rejects.toThrow(
			"Discord API request timed out",
		);
		expect(calls).toBe(2);
		expect(sleeps).toEqual([4_000]);
		expect(signals).toHaveLength(2);
		expect(signals[0]).toBe(signals[1]);
		expect(signals[0]?.aborted).toBe(true);
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
	test("does not reconnect after a terminal Gateway close code", async () => {
		const requests: Array<{ path: string; init: RequestInit }> = [];
		const sockets: FakeSocket[] = [];
		const live = provider(requests, sockets);
		await live.start(async () => {});
		sockets[0]!.close(4_014, "disallowed intents");
		expect(sockets).toHaveLength(1);
		expect(live.gatewayError?.message).toContain("4014");
		expect(live.transportHealthy).toBe(false);
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

	test("does not adopt an outsider thread that copies the public nonce marker ahead of the bot starter", async () => {
		const marker = "<!-- gjc-thread-nonce:nonce -->";
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input => {
				const path = String(input);
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) {
					return response([
						{
							id: "evil-msg",
							author: { id: "OUTSIDER-4242", bot: false },
							content: `attack copy of ${marker}`,
							thread: {
								id: "evil-thread",
								parent_id: "parent",
								owner_id: "OUTSIDER-4242",
								thread_metadata: { archived: false },
							},
						},
						{
							id: "starter",
							author: { id: "bot", bot: true },
							content: marker,
							thread: {
								id: "bot-thread",
								parent_id: "parent",
								owner_id: "bot",
								thread_metadata: { archived: false },
							},
						},
					]);
				}
				return response({ threads: [] });
			},
		});
		await expect(
			live.findThreadByNonce({ guildId: "guild", parentId: "parent", nonce: "nonce" }),
		).resolves.toMatchObject({ id: "bot-thread", parentId: "parent" });
	});

	test("returns null when every public nonce marker was posted by someone other than the bot", async () => {
		const marker = "<!-- gjc-thread-nonce:nonce -->";
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input => {
				const path = String(input);
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) {
					return response([
						{
							id: "evil-msg",
							author: { id: "OUTSIDER-4242", bot: false },
							content: marker,
							thread: {
								id: "evil-thread",
								parent_id: "parent",
								owner_id: "OUTSIDER-4242",
								thread_metadata: { archived: false },
							},
						},
						{
							id: "spoofed-bot-flag",
							author: { id: "bot", bot: false },
							content: marker,
							thread: {
								id: "spoofed-thread",
								parent_id: "parent",
								owner_id: "bot",
								thread_metadata: { archived: false },
							},
						},
					]);
				}
				return response({ threads: [] });
			},
		});
		await expect(
			live.findThreadByNonce({ guildId: "guild", parentId: "parent", nonce: "nonce" }),
		).resolves.toBeNull();
	});

	test("does not relabel a nonce thread from another parent as this channel", async () => {
		const marker = "<!-- gjc-thread-nonce:nonce -->";
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input => {
				const path = String(input);
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) {
					return response([
						{
							id: "starter",
							author: { id: "bot", bot: true },
							content: marker,
							thread: {
								id: "foreign-thread",
								parent_id: "OTHER-PARENT-9",
								owner_id: "bot",
								thread_metadata: { archived: false },
							},
						},
					]);
				}
				return response({ threads: [] });
			},
		});
		await expect(
			live.findThreadByNonce({ guildId: "guild", parentId: "parent", nonce: "nonce" }),
		).resolves.toBeNull();
	});

	test("does not adopt an outsider thread from the active-thread fallback", async () => {
		const marker = "<!-- gjc-thread-nonce:nonce -->";
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input => {
				const path = String(input);
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) return response([]);
				if (path.endsWith("/guilds/guild/threads/active")) {
					return response({
						threads: [
							{
								id: "evil-thread",
								parent_id: "parent",
								owner_id: "OUTSIDER-4242",
								thread_metadata: { archived: false },
							},
						],
					});
				}
				if (path.endsWith("/channels/evil-thread/messages?limit=25")) {
					return response([{ id: "copied", author: { id: "OUTSIDER-4242", bot: false }, content: marker }]);
				}
				if (path.includes("archived/public")) return response({ threads: [] });
				return response({ threads: [] });
			},
		});
		await expect(
			live.findThreadByNonce({ guildId: "guild", parentId: "parent", nonce: "nonce" }),
		).resolves.toBeNull();
	});

	test("reconciles a bot-owned thread from the active-thread fallback after the parent starter scrolls away", async () => {
		const marker = "<!-- gjc-thread-nonce:nonce -->";
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input => {
				const path = String(input);
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) return response([]);
				if (path.endsWith("/guilds/guild/threads/active")) {
					return response({
						threads: [
							{
								id: "evil-thread",
								parent_id: "parent",
								owner_id: "OUTSIDER-4242",
								thread_metadata: { archived: false },
							},
							{
								id: "bot-thread",
								parent_id: "parent",
								owner_id: "bot",
								thread_metadata: { archived: false },
							},
						],
					});
				}
				if (path.endsWith("/channels/parent/messages/bot-thread")) {
					return response({ id: "bot-thread", author: { id: "bot", bot: true }, content: marker });
				}
				if (path.endsWith("/channels/bot-thread/messages?limit=25")) {
					return response([{ id: "echo", author: { id: "bot", bot: true }, content: marker }]);
				}
				if (path.includes("archived/public")) return response({ threads: [] });
				return response({ threads: [] });
			},
		});
		await expect(
			live.findThreadByNonce({ guildId: "guild", parentId: "parent", nonce: "nonce" }),
		).resolves.toMatchObject({ id: "bot-thread", parentId: "parent" });
	});

	test("does not adopt a bot-owned thread whose later message echoes the marker", async () => {
		const marker = "<!-- gjc-thread-nonce:nonce -->";
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input => {
				const path = String(input);
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) return response([]);
				if (path.endsWith("/guilds/guild/threads/active")) {
					return response({
						threads: [
							{
								id: "echo-thread",
								parent_id: "parent",
								owner_id: "bot",
								thread_metadata: { archived: false },
							},
							{
								id: "bot-thread",
								parent_id: "parent",
								owner_id: "bot",
								thread_metadata: { archived: false },
							},
						],
					});
				}
				if (path.endsWith("/channels/parent/messages/echo-thread")) {
					return response({ id: "echo-thread", author: { id: "bot", bot: true }, content: "hello" });
				}
				if (path.endsWith("/channels/echo-thread/messages?limit=25")) {
					return response([{ id: "echo", author: { id: "bot", bot: true }, content: marker }]);
				}
				if (path.endsWith("/channels/parent/messages/bot-thread")) {
					return response({ id: "bot-thread", author: { id: "bot", bot: true }, content: marker });
				}
				if (path.includes("archived/public")) return response({ threads: [] });
				return response({ threads: [] });
			},
		});
		await expect(
			live.findThreadByNonce({ guildId: "guild", parentId: "parent", nonce: "nonce" }),
		).resolves.toMatchObject({ id: "bot-thread", parentId: "parent" });
	});

	test("propagates a starter lookup failure instead of treating the nonce thread as missing", async () => {
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input => {
				const path = String(input);
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) return response([]);
				if (path.endsWith("/guilds/guild/threads/active")) {
					return response({
						threads: [
							{
								id: "bot-thread",
								parent_id: "parent",
								owner_id: "bot",
								thread_metadata: { archived: false },
							},
						],
					});
				}
				if (path.endsWith("/channels/parent/messages/bot-thread"))
					return new Response("unavailable", { status: 500 });
				if (path.endsWith("/channels/bot-thread/messages?limit=25")) {
					return response([
						{ id: "echo", author: { id: "bot", bot: true }, content: "<!-- gjc-thread-nonce:nonce -->" },
					]);
				}
				if (path.includes("archived/public")) return response({ threads: [] });
				return response({ threads: [] });
			},
		});
		await expect(live.findThreadByNonce({ guildId: "guild", parentId: "parent", nonce: "nonce" })).rejects.toThrow(
			"Discord API request failed (500)",
		);
	});

	test("starts the thread from a new bot starter when an outsider already posted the nonce marker", async () => {
		const marker = "<!-- gjc-thread-nonce:nonce -->";
		const threadPosts: string[] = [];
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async (input, init) => {
				const path = String(input);
				const method = (init?.method ?? "GET").toUpperCase();
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) {
					return response([
						{
							id: "evil-msg",
							author: { id: "OUTSIDER-4242", bot: false },
							content: marker,
						},
					]);
				}
				if (path.endsWith("/channels/parent/messages") && method === "POST") return response({ id: "bot-starter" });
				if (method === "POST" && path.endsWith("/threads")) {
					threadPosts.push(path);
					const id = path.includes("evil-msg") ? "evil-thread" : "bot-thread";
					return response({ id, parent_id: "parent", owner_id: "bot", thread_metadata: { archived: false } });
				}
				return response({ threads: [] });
			},
		});
		await expect(
			live.createThread({ guildId: "guild", parentId: "parent", name: "Session", nonce: "nonce" }),
		).resolves.toMatchObject({ id: "bot-thread", parentId: "parent" });
		expect(threadPosts).toEqual(["https://discord.test/api/channels/parent/messages/bot-starter/threads"]);
	});

	test("does not adopt a thread another member started from the bot's own starter message", async () => {
		const marker = "<!-- gjc-thread-nonce:nonce -->";
		const threadPosts: string[] = [];
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async (input, init) => {
				const path = String(input);
				const method = (init?.method ?? "GET").toUpperCase();
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) {
					return response([
						{
							id: "bot-starter",
							author: { id: "bot", bot: true },
							content: marker,
							thread: {
								id: "evil-thread",
								parent_id: "parent",
								owner_id: "OUTSIDER-4242",
								thread_metadata: { archived: false },
							},
						},
					]);
				}
				if (path.endsWith("/channels/parent/messages") && method === "POST")
					return response({ id: "fresh-starter" });
				if (method === "POST" && path.endsWith("/threads")) {
					threadPosts.push(path);
					return response({
						id: "bot-thread",
						parent_id: "parent",
						owner_id: "bot",
						thread_metadata: { archived: false },
					});
				}
				return response({ threads: [] });
			},
		});
		await expect(
			live.createThread({ guildId: "guild", parentId: "parent", name: "Session", nonce: "nonce" }),
		).resolves.toMatchObject({ id: "bot-thread", parentId: "parent" });
		expect(threadPosts).toEqual(["https://discord.test/api/channels/parent/messages/fresh-starter/threads"]);
	});

	test("rejects a thread-create response that omits owner_id", async () => {
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async (input, init) => {
				const path = String(input);
				const method = (init?.method ?? "GET").toUpperCase();
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) return response([]);
				if (path.endsWith("/channels/parent/messages") && method === "POST") return response({ id: "starter" });
				if (method === "POST" && path.endsWith("/threads"))
					return response({ id: "thread", parent_id: "parent", thread_metadata: { archived: false } });
				return response({ threads: [] });
			},
		});
		await expect(
			live.createThread({ guildId: "guild", parentId: "parent", name: "Session", nonce: "nonce" }),
		).rejects.toThrow("Discord returned an invalid thread response");
	});

	test("rejects a thread-create response owned by someone else", async () => {
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async (input, init) => {
				const path = String(input);
				const method = (init?.method ?? "GET").toUpperCase();
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) return response([]);
				if (path.endsWith("/channels/parent/messages") && method === "POST") return response({ id: "starter" });
				if (method === "POST" && path.endsWith("/threads")) {
					return response({
						id: "evil-thread",
						parent_id: "parent",
						owner_id: "OUTSIDER-4242",
						thread_metadata: { archived: false },
					});
				}
				return response({ threads: [] });
			},
		});
		await expect(
			live.createThread({ guildId: "guild", parentId: "parent", name: "Session", nonce: "nonce" }),
		).rejects.toThrow("Discord returned an invalid thread response");
	});

	test("does not adopt an outsider thread from the archived-thread fallback", async () => {
		const marker = "<!-- gjc-thread-nonce:nonce -->";
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async input => {
				const path = String(input);
				if (path.endsWith("/users/@me")) return response({ id: "bot" });
				if (path.endsWith("/channels/parent/messages?limit=100")) return response([]);
				if (path.endsWith("/guilds/guild/threads/active")) return response({ threads: [] });
				if (path.includes("archived/public")) {
					return response({
						threads: [
							{
								id: "evil-thread",
								parent_id: "parent",
								owner_id: "OUTSIDER-4242",
								thread_metadata: { archived: false },
							},
						],
					});
				}
				if (path.endsWith("/channels/evil-thread/messages?limit=25")) {
					return response([{ id: "copied", author: { id: "OUTSIDER-4242", bot: false }, content: marker }]);
				}
				return response({ threads: [] });
			},
		});
		await expect(
			live.findThreadByNonce({ guildId: "guild", parentId: "parent", nonce: "nonce" }),
		).resolves.toBeNull();
	});

	test("notification does not post when the thread-create response is owned by someone else", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-discord-nonce-owner-"));
		const posts: string[] = [];
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async (input, init) => {
				const requestPath = String(input).slice("https://discord.test/api".length);
				const method = (init?.method ?? "GET").toUpperCase();
				if (requestPath === "/users/@me") return response({ id: "bot" });
				if (requestPath === "/channels/parent/messages?limit=100") return response([]);
				if (requestPath === "/channels/parent/messages" && method === "POST")
					return response({ id: "bot-starter" });
				if (requestPath === "/channels/parent/messages/bot-starter/threads" && method === "POST") {
					return response({
						id: "evil-thread",
						parent_id: "parent",
						owner_id: "OUTSIDER-4242",
						thread_metadata: { archived: false },
					});
				}
				if (method === "POST" && requestPath.endsWith("/messages")) {
					posts.push(requestPath);
					return response({ id: "posted" });
				}
				if (requestPath.includes("/messages?limit")) return response([]);
				return response({ threads: [] });
			},
		});
		const daemon = new DiscordNotificationDaemon({
			agentDir,
			guildId: "guild",
			parentChannelId: "parent",
			provider: live,
			resolveAttachment: async (sessionId, expectedGeneration = 1) => ({
				sessionId,
				generation: expectedGeneration,
				isCurrent: () => true,
				send: () => {},
				sendMaintenance: () => {},
			}),
		});
		try {
			await expect(
				daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "SESSION-OUTPUT-CANARY",
				}),
			).rejects.toThrow("Discord returned an invalid thread response");
			expect(posts).toEqual([]);
		} finally {
			await daemon.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("notification retry posts the session body to the bot thread after an outsider copies the marker", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-discord-nonce-author-"));
		const posts: Array<{ path: string; body: string }> = [];
		const parentMessages: Array<Record<string, unknown>> = [];
		let lostThreadPost = true;
		const live = new DiscordLiveProvider({
			applicationId: "app",
			botToken: "discord-secret-token",
			apiBaseUrl: "https://discord.test/api",
			fetchImpl: async (input, init) => {
				const requestPath = String(input).slice("https://discord.test/api".length);
				const method = (init?.method ?? "GET").toUpperCase();
				if (requestPath === "/users/@me") return response({ id: "bot" });
				if (requestPath === "/channels/parent/messages?limit=100") return response(parentMessages);
				if (requestPath === "/channels/parent/messages" && method === "POST") {
					const body = JSON.parse(String(init?.body)) as { content: string };
					const message = { id: "bot-starter", author: { id: "bot", bot: true }, content: body.content };
					parentMessages.push(message);
					return response(message);
				}
				if (requestPath === "/channels/parent/messages/bot-starter/threads" && method === "POST") {
					if (lostThreadPost) {
						lostThreadPost = false;
						throw new Error("Discord connection lost before the thread request reached the API");
					}
					const thread = {
						id: "bot-thread",
						parent_id: "parent",
						owner_id: "bot",
						thread_metadata: { archived: false },
					};
					const starter = parentMessages.find(message => message.id === "bot-starter");
					if (starter) starter.thread = thread;
					return response(thread);
				}
				if (requestPath === "/guilds/guild/threads/active" || requestPath.includes("archived/public"))
					return response({ threads: [] });
				if (method === "POST" && requestPath.endsWith("/messages")) {
					posts.push({ path: requestPath, body: String(init?.body) });
					return response({ id: `posted-${posts.length}` });
				}
				if (requestPath.includes("/messages?limit")) return response([]);
				return response({});
			},
		});
		const daemon = new DiscordNotificationDaemon({
			agentDir,
			guildId: "guild",
			parentChannelId: "parent",
			provider: live,
			resolveAttachment: async (sessionId, expectedGeneration = 1) => ({
				sessionId,
				generation: expectedGeneration,
				isCurrent: () => true,
				send: () => {},
				sendMaintenance: () => {},
			}),
		});
		try {
			await expect(
				daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "SESSION-OUTPUT-CANARY-attempt-1",
				}),
			).rejects.toThrow("connection lost");
			const starter = parentMessages.find(message => message.id === "bot-starter");
			expect(starter?.content).toContain("<!-- gjc-thread-nonce:");
			parentMessages.unshift({
				id: "evil-msg",
				author: { id: "OUTSIDER-4242", bot: false },
				content: `attack copy of ${String(starter?.content)}`,
				thread: {
					id: "evil-thread",
					parent_id: "parent",
					owner_id: "OUTSIDER-4242",
					thread_metadata: { archived: false },
				},
			});
			const conversation = await daemon.notify({
				sessionId: "session",
				endpointGeneration: 1,
				content: "SESSION-OUTPUT-CANARY-attempt-2",
			});
			expect(conversation.threadId).toBe("bot-thread");
			expect(posts.map(post => post.path)).toEqual(["/channels/bot-thread/messages"]);
			expect(posts[0]?.body).toContain("SESSION-OUTPUT-CANARY-attempt-2");
			expect(JSON.stringify(posts)).not.toContain("evil-thread");
		} finally {
			await daemon.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
