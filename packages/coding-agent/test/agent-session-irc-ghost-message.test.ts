import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import type { Message } from "@gajae-code/ai";
import { createMockModel, type MockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@gajae-code/coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionConfig } from "@gajae-code/coding-agent/session/agent-session";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

registerMockApi();

type Harness = {
	session: AgentSession;
	registry: AgentRegistry;
	model: MockModel;
	/** Every `irc_message` session event observed on the recipient, in order. */
	ircEvents: Array<{ customType: string; content: string }>;
	sessionManager: SessionManager;
	snapshots: Array<readonly { role: string; customType?: string; content?: unknown }[]>;
};

const testSessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of testSessions.splice(0)) await session.dispose();
});

function createHarness(
	options: {
		model?: MockModel;
		agentId?: string;
		getApiKey?: () => Promise<string | undefined>;
		transformContext?: AgentSessionConfig["transformContext"];
		convertToLlm?: AgentSessionConfig["convertToLlm"];
	} = {},
): Harness {
	const model = options.model ?? createMockModel({ handler: () => ({ content: ["pong"] }) });
	const registry = new AgentRegistry();
	const sessionManager = SessionManager.inMemory();
	const snapshots: Harness["snapshots"] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
		streamFn: model.stream,
		convertToLlm: async messages => {
			snapshots.push(messages);
			return convertToLlm(messages);
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {
			getApiKey: options.getApiKey ?? (async () => "test-key"),
			getAvailable: () => [model],
		} as never,
		agentId: options.agentId ?? "1-Worker",
		agentRegistry: registry,
		convertToLlm:
			options.convertToLlm ??
			(async messages => {
				snapshots.push(messages);
				return convertToLlm(messages);
			}),
		transformContext: options.transformContext,
	});
	const ircEvents: Harness["ircEvents"] = [];
	session.subscribe(event => {
		if (event.type === "irc_message") {
			ircEvents.push({
				customType: String(event.message.customType),
				content: String(event.message.content),
			});
		}
	});
	testSessions.push(session);
	return { session, registry, model, ircEvents, sessionManager, snapshots };
}

function ircHistory(harness: Harness): Array<{ customType?: unknown }> {
	return harness.session.agent.state.messages.filter(
		(message): message is Extract<(typeof harness.session.agent.state.messages)[number], { role: "custom" }> =>
			message.role === "custom" && String(message.customType).startsWith("irc:"),
	);
}

function persistedIrcEntries(harness: Harness): number {
	return harness.sessionManager
		.getBranch()
		.filter(entry => entry.type === "custom" && String(entry.customType).startsWith("irc:")).length;
}

function addPeer(registry: AgentRegistry, id = "2-Worker"): void {
	registry.register({
		id,
		displayName: `${id} display`,
		rosterLabel: `${id} label`,
		kind: "sub",
		session: null,
		status: "running",
	});
}

function rosterDeliveryCount(harness: Harness): number {
	return harness.snapshots.filter(snapshot => JSON.stringify(snapshot).includes('"customType":"irc-peer-roster"'))
		.length;
}

/** Register a fake main session and capture relay observations forwarded to it. */
function attachMainRelaySpy(
	registry: AgentRegistry,
	options: { throwOnObserve?: boolean; onObserve?: () => void } = {},
): Array<{ kind?: string }> {
	const relayed: Array<{ kind?: string }> = [];
	const fakeMain = {
		emitIrcRelayObservation: (record: { details?: unknown }) => {
			relayed.push({ kind: (record.details as { kind?: string } | undefined)?.kind });
			options.onObserve?.();
			if (options.throwOnObserve) throw new Error("main observer unavailable");
		},
	};
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: "main",
		kind: "main",
		session: fakeMain as unknown as AgentSession,
	});
	return relayed;
}

describe("AgentSession respondAsBackground failure visibility", () => {
	it("does not surface irc_message events or ghost history records when reply generation fails", async () => {
		// Real-world shape: recipient's provider call fails (rate limit, outage).
		// The sender is told the delivery failed; the recipient's UI must not
		// show an incoming message that never reaches any agent's history.
		const harness = createHarness({
			model: createMockModel({ handler: () => ({ throw: "model unavailable" }) }),
		});

		await expect(harness.session.respondAsBackground({ from: "0-Main", message: "ping" })).rejects.toThrow(
			"model unavailable",
		);

		expect(harness.ircEvents).toEqual([]);
		expect(ircHistory(harness)).toHaveLength(0);
		expect(persistedIrcEntries(harness)).toBe(0);
	});

	it("does not leave a ghost incoming message when the sender aborts mid-reply", async () => {
		// Real-world shape: the sending agent's tool call is aborted (user ESC)
		// while the recipient is still generating the auto-reply.
		const started = Promise.withResolvers<void>();
		const harness = createHarness({
			model: createMockModel({
				handler: () => {
					started.resolve();
					return { delayMs: 5_000, content: ["late reply"] };
				},
			}),
		});
		const abort = new AbortController();

		const pending = harness.session.respondAsBackground({
			from: "0-Main",
			message: "ping",
			signal: abort.signal,
		});
		await started.promise;
		abort.abort();
		await expect(pending).rejects.toThrow();

		expect(harness.ircEvents).toEqual([]);
		expect(ircHistory(harness)).toHaveLength(0);
		expect(persistedIrcEntries(harness)).toBe(0);
	});

	it("does not forward relay observations to the main UI when the reply fails", async () => {
		const harness = createHarness({
			model: createMockModel({ handler: () => ({ throw: "model unavailable" }) }),
		});
		const relayed = attachMainRelaySpy(harness.registry);

		await expect(harness.session.respondAsBackground({ from: "0-Main", message: "ping" })).rejects.toThrow();

		expect(relayed).toHaveLength(0);
	});

	it("accepts the ordered reply pair before recipient and main observations and sender success", async () => {
		const harness = createHarness();
		const acceptedAtRecipientObservation: string[][] = [];
		const acceptedAtMainObservation: string[][] = [];
		attachMainRelaySpy(harness.registry, {
			onObserve: () => {
				acceptedAtMainObservation.push(ircHistory(harness).map(message => String(message.customType)));
			},
		});
		harness.session.subscribe(event => {
			if (event.type === "irc_message") {
				acceptedAtRecipientObservation.push(ircHistory(harness).map(message => String(message.customType)));
			}
		});

		const { replyText } = await harness.session.respondAsBackground({ from: "0-Main", message: "ping" });

		expect(replyText).toBe("pong");
		expect(harness.ircEvents.map(e => e.customType)).toEqual(["irc:incoming", "irc:autoreply"]);
		expect(harness.ircEvents[0]?.content).toContain("ping");
		expect(harness.ircEvents[1]?.content).toContain("pong");
		expect(acceptedAtRecipientObservation).toEqual([
			["irc:incoming", "irc:autoreply"],
			["irc:incoming", "irc:autoreply"],
		]);
		expect(acceptedAtMainObservation).toEqual([
			["irc:incoming", "irc:autoreply"],
			["irc:incoming", "irc:autoreply"],
		]);
	});

	it("forwards message and reply relay observations to the main UI on success", async () => {
		const harness = createHarness();
		const relayed = attachMainRelaySpy(harness.registry);

		await harness.session.respondAsBackground({ from: "0-Main", message: "ping" });

		expect(relayed.map(r => r.kind)).toEqual(["message", "reply"]);
	});

	it("accepts the no-reply incoming batch before recipient and main observation and sender success", async () => {
		const harness = createHarness();
		const acceptedAtRecipientObservation: string[][] = [];
		const acceptedAtMainObservation: string[][] = [];
		attachMainRelaySpy(harness.registry, {
			onObserve: () => {
				acceptedAtMainObservation.push(ircHistory(harness).map(message => String(message.customType)));
			},
		});
		harness.session.subscribe(event => {
			if (event.type === "irc_message") {
				acceptedAtRecipientObservation.push(ircHistory(harness).map(message => String(message.customType)));
			}
		});

		const result = await harness.session.respondAsBackground({
			from: "0-Main",
			message: "fyi",
			awaitReply: false,
		});

		expect(result.replyText).toBeNull();
		expect(harness.ircEvents.map(e => e.customType)).toEqual(["irc:incoming"]);
		expect(acceptedAtRecipientObservation).toEqual([["irc:incoming"]]);
		expect(acceptedAtMainObservation).toEqual([["irc:incoming"]]);
	});

	it("does not accept or surface a pre-aborted no-reply delivery", async () => {
		const harness = createHarness();
		const relayed = attachMainRelaySpy(harness.registry);
		const abort = new AbortController();
		abort.abort();

		await expect(
			harness.session.respondAsBackground({
				from: "0-Main",
				message: "fyi",
				awaitReply: false,
				signal: abort.signal,
			}),
		).rejects.toThrow();

		expect(harness.ircEvents).toEqual([]);
		expect(relayed).toEqual([]);
		expect(ircHistory(harness)).toEqual([]);
		expect(persistedIrcEntries(harness)).toBe(0);
	});

	it("isolates recipient and main observer failures after accepting a successful exchange", async () => {
		const harness = createHarness();
		attachMainRelaySpy(harness.registry, { throwOnObserve: true });
		harness.session.subscribe(event => {
			if (event.type === "irc_message") throw new Error("recipient observer unavailable");
		});

		await expect(harness.session.respondAsBackground({ from: "0-Main", message: "ping" })).resolves.toEqual({
			replyText: "pong",
		});
		expect(ircHistory(harness).map(message => message.customType)).toEqual(["irc:incoming", "irc:autoreply"]);
	});

	it("does not add ephemeral turns to session history", async () => {
		const harness = createHarness();
		const before = [...harness.session.agent.state.messages];

		await expect(harness.session.runEphemeralTurn({ promptText: "<btw>side question</btw>" })).resolves.toMatchObject(
			{
				replyText: "pong",
			},
		);

		expect(harness.session.agent.state.messages).toEqual(before);
	});
	it("rejects promptly without dispatching a provider call when credential lookup ignores cancellation", async () => {
		const credential = Promise.withResolvers<string>();
		const harness = createHarness({ getApiKey: () => credential.promise });
		const abort = new AbortController();

		const pending = harness.session.runEphemeralTurn({ promptText: "side question", signal: abort.signal });
		abort.abort();

		await expect(pending).rejects.toThrow();
		expect(harness.model.calls).toHaveLength(0);
	});

	it("rejects promptly without dispatching a provider call when conversion ignores cancellation", async () => {
		const conversionStarted = Promise.withResolvers<void>();
		const conversion = Promise.withResolvers<Message[]>();
		const harness = createHarness({
			convertToLlm: async _messages => {
				conversionStarted.resolve();
				return await conversion.promise;
			},
		});
		const abort = new AbortController();

		const pending = harness.session.runEphemeralTurn({ promptText: "side question", signal: abort.signal });
		await conversionStarted.promise;
		abort.abort();

		await expect(pending).rejects.toThrow();
		expect(harness.model.calls).toHaveLength(0);
	});

	it("deeply isolates persisted history and caller prepends from mutating context hooks", async () => {
		const historyMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "live history" }],
			timestamp: Date.now(),
		};
		const callerPrepend = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "caller prepend" }],
			timestamp: Date.now(),
		};
		let transformCalls = 0;
		const harness = createHarness({
			transformContext: messages => {
				transformCalls++;
				for (const message of messages) {
					if (message.role !== "user" || typeof message.content === "string") continue;
					const text = message.content[0];
					if (text?.type === "text") text.text = "mutated by hook";
				}
				return messages;
			},
		});
		harness.session.agent.appendMessage(historyMessage);
		harness.sessionManager.appendMessage(historyMessage);
		const beforeLive = JSON.stringify(harness.session.agent.state.messages);
		const beforePersisted = JSON.stringify(harness.sessionManager.getBranch());

		await harness.session.runEphemeralTurn({
			promptText: "side question",
			prependMessages: [callerPrepend],
		});

		expect(JSON.stringify(harness.session.agent.state.messages)).toBe(beforeLive);
		expect(JSON.stringify(harness.sessionManager.getBranch())).toBe(beforePersisted);
		expect(callerPrepend.content[0]?.text).toBe("caller prepend");
		expect(transformCalls).toBe(1);
	});

	it("preserves long /btw replies while retaining explicit IRC reply shaping", async () => {
		const longReply = "x".repeat(5_000);
		const harness = createHarness({
			model: createMockModel({ handler: () => ({ content: [longReply] }) }),
		});

		await expect(harness.session.runEphemeralTurn({ promptText: "<btw>long answer</btw>" })).resolves.toMatchObject({
			replyText: longReply,
		});
		const irc = await harness.session.respondAsBackground({
			from: "0-Main",
			message: "IRC background reply",
		});
		expect(irc.replyText).not.toBeNull();
		expect(Buffer.byteLength(irc.replyText!, "utf8")).toBeLessThanOrEqual(4_096);
	});
	it("commits a successful IRC roster claim after accepting its exchange", async () => {
		const harness = createHarness();
		addPeer(harness.registry);

		await harness.session.respondAsBackground({ from: "0-Main", message: "ping" });
		await harness.session.runEphemeralTurn({ promptText: "follow up" });

		expect(rosterDeliveryCount(harness)).toBe(1);
	});

	it("commits the roster claim before an idle awaited-exchange observer accepts a changed roster", async () => {
		const harness = createHarness();
		addPeer(harness.registry);
		let observerDelivery: Promise<{ replyText: string | null }> | undefined;
		harness.session.agent.subscribe(event => {
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === "irc:incoming" &&
				!observerDelivery
			) {
				addPeer(harness.registry, "3-Observer");
				observerDelivery = harness.session.respondAsBackground({ from: "3-Observer", message: "observer ping" });
			}
		});

		await harness.session.respondAsBackground({ from: "0-Main", message: "ping" });
		if (!observerDelivery) throw new Error("Expected the idle IRC observer to accept a follow-up exchange");
		await expect(observerDelivery).resolves.toEqual({ replyText: "pong" });
		expect(rosterDeliveryCount(harness)).toBe(2);
	});

	it("releases an IRC roster claim when reply generation fails before acceptance", async () => {
		let fail = true;
		const harness = createHarness({
			model: createMockModel({
				handler: () => (fail ? { throw: "model unavailable" } : { content: ["pong"] }),
			}),
		});
		addPeer(harness.registry);

		await expect(harness.session.respondAsBackground({ from: "0-Main", message: "ping" })).rejects.toThrow(
			"model unavailable",
		);
		fail = false;
		await harness.session.respondAsBackground({ from: "0-Main", message: "retry" });

		expect(rosterDeliveryCount(harness)).toBe(2);
	});
});
