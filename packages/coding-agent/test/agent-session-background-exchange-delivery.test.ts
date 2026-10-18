import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import type { ToolCall } from "@gajae-code/ai";
import { createMockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { z } from "zod";
import { createAssistantMessage } from "./helpers/agent-session-setup";

registerMockApi();

type IrcRecord = AgentMessage & { customType: string; content: unknown };

function ircRecords(messages: readonly AgentMessage[]): IrcRecord[] {
	return messages.filter(
		(message): message is IrcRecord =>
			message.role === "custom" && String((message as { customType?: unknown }).customType).startsWith("irc:"),
	);
}

/**
 * The question carried by an `irc:incoming` record. Inbound peer text is framed as
 * untrusted data (`frameUntrustedIrcInbound`), so the payload is the JSON envelope
 * on the last line; an unframed record keeps its bare last line.
 */
function incomingLabel(record: IrcRecord): string {
	const lastLine = String(record.content).split("\n").at(-1) ?? "";
	try {
		const parsed = JSON.parse(lastLine) as { message?: unknown };
		if (typeof parsed.message === "string") return parsed.message;
	} catch {
		// Not framed: the last line is the label itself.
	}
	return lastLine;
}

function incomingLabels(messages: readonly AgentMessage[]): string[] {
	return ircRecords(messages)
		.filter(record => record.customType === "irc:incoming")
		.map(record => incomingLabel(record));
}

const sessions: AgentSession[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the re-armed exchange");
		await Bun.sleep(5);
	}
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

interface HarnessOptions {
	/** Defaults to the agent default, `one-at-a-time`. */
	readonly steeringMode?: "all" | "one-at-a-time";
	/** Drives a real tool pause between two provider steps. */
	readonly pausedTool?: boolean;
}

interface Harness {
	readonly session: AgentSession;
	readonly agent: Agent;
	/** Messages handed to the provider, one snapshot per request. */
	readonly requests: AgentMessage[][];
	readonly providerCalls: () => number;
	/** First provider step opened. */
	readonly firstStream: Promise<void>;
	/** The paused tool started executing. */
	readonly toolStarted: Promise<void>;
	/** Second provider step opened (with a genuine delta before it ends). */
	readonly secondStream: Promise<void>;
	releaseFirstStream(): void;
	releaseTool(): void;
	releaseSecondStream(): void;
}

function createHarness(options: HarnessOptions = {}): Harness {
	// The agent loop runs on the scripted stream below; the mock provider answers
	// the ephemeral `respondAsBackground` reply generation.
	const model = createMockModel({ handler: () => ({ content: ["pong"] }) });
	const requests: AgentMessage[][] = [];
	const firstStream = Promise.withResolvers<void>();
	const toolStarted = Promise.withResolvers<void>();
	const secondStream = Promise.withResolvers<void>();
	const firstStreamGate = Promise.withResolvers<void>();
	const secondStreamGate = Promise.withResolvers<void>();
	const toolGate = Promise.withResolvers<void>();
	const toolCall: ToolCall = { type: "toolCall", id: "call_paused_probe", name: "paused_probe", arguments: {} };
	const tool: AgentTool = {
		name: "paused_probe",
		label: "Paused probe",
		description: "Blocks the turn between two provider steps.",
		parameters: z.object({}),
		execute: async () => {
			toolStarted.resolve();
			await toolGate.promise;
			return { content: [{ type: "text", text: "probe-result" }] };
		},
	};
	let providerCalls = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		steeringMode: options.steeringMode,
		initialState: {
			model,
			systemPrompt: ["system prompt"],
			messages: [],
			tools: options.pausedTool ? [tool] : [],
		},
		convertToLlm: async (messages: AgentMessage[]) => {
			requests.push([...messages]);
			return convertToLlm(messages);
		},
		streamFn: () => {
			const call = ++providerCalls;
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = createAssistantMessage("");
				if (call === 1 && options.pausedTool) {
					partial.content = [toolCall];
					partial.stopReason = "toolUse";
				}
				stream.push({ type: "start", partial });
				if (call === 1) {
					if (options.pausedTool) {
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					}
					firstStream.resolve();
					await firstStreamGate.promise;
					stream.push({
						type: "done",
						reason: options.pausedTool ? "toolUse" : "stop",
						message: partial,
					});
					return;
				}
				// A genuine delta while the second step streams: the session event it
				// produces is what retries an exchange that was queued between steps.
				if (!options.pausedTool) {
					stream.push({ type: "done", reason: "stop", message: partial });
					return;
				}
				stream.push({ type: "text_delta", contentIndex: 0, delta: "tick", partial });
				secondStream.resolve();
				await secondStreamGate.promise;
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {
			getApiKey: async () => "test-key",
			getAvailable: () => [model],
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
	});
	sessions.push(session);
	return {
		session,
		agent,
		requests,
		providerCalls: () => providerCalls,
		firstStream: firstStream.promise,
		toolStarted: toolStarted.promise,
		secondStream: secondStream.promise,
		releaseFirstStream: () => firstStreamGate.resolve(),
		releaseTool: () => toolGate.resolve(),
		releaseSecondStream: () => secondStreamGate.resolve(),
	};
}

/** The question and the reply the session already sent on the model's behalf. */
async function queuePair(session: AgentSession, question: string): Promise<void> {
	const result = await session.respondAsBackground({ from: "0-Main", message: question });
	if (result.replyText === null) throw new Error("Expected the background exchange to produce a reply");
}

describe("background IRC exchange delivery", () => {
	it("keeps an exchange in one steering unit for the default one-at-a-time mode", async () => {
		const harness = createHarness();
		const prompt = harness.session.prompt("hello");
		await harness.firstStream;

		await queuePair(harness.session, "default-mode ping");
		expect(ircRecords(harness.agent.snapshotSteering()).map(record => record.customType)).toEqual([
			"irc:incoming",
			"irc:autoreply",
		]);

		harness.releaseFirstStream();
		await prompt;

		const committed = ircRecords(harness.agent.state.messages);
		expect(committed.map(record => record.customType)).toEqual(["irc:incoming", "irc:autoreply"]);
		// The model never sees the question in a request that lacks the reply this
		// session already sent for it.
		for (const request of harness.requests) {
			const records = ircRecords(request);
			expect(records.filter(record => record.customType === "irc:autoreply")).toHaveLength(
				records.filter(record => record.customType === "irc:incoming").length,
			);
		}
		expect(harness.requests.some(request => ircRecords(request).length === 2)).toBe(true);
	});

	it("keeps an exchange in one steering unit when the steering mode batches everything", async () => {
		const harness = createHarness({ steeringMode: "all" });
		const prompt = harness.session.prompt("hello");
		await harness.firstStream;

		await queuePair(harness.session, "all-mode ping");
		harness.releaseFirstStream();
		await prompt;

		expect(ircRecords(harness.agent.state.messages).map(record => record.customType)).toEqual([
			"irc:incoming",
			"irc:autoreply",
		]);
		expect(harness.requests.some(request => ircRecords(request).length === 2)).toBe(true);
	});

	it("delivers an exchange queued inside a real tool pause before the turn ends", async () => {
		const harness = createHarness({ pausedTool: true });
		const prompt = harness.session.prompt("hello");
		await harness.firstStream;
		harness.releaseFirstStream();
		await harness.toolStarted;

		// The run is executing a tool: a record queued here joins the live run and
		// waits for the loop's next boundary.
		await harness.session.respondAsBackground({ from: "0-Main", message: "between steps", awaitReply: false });
		expect(ircRecords(harness.agent.snapshotSteering())).toHaveLength(1);
		expect(ircRecords(harness.agent.state.messages)).toHaveLength(0);
		expect(harness.providerCalls()).toBe(1);

		harness.releaseTool();
		await harness.secondStream;
		harness.releaseSecondStream();
		await prompt;

		const committed = ircRecords(harness.agent.state.messages);
		expect(committed).toHaveLength(1);
		expect(committed[0]?.content).toContain("between steps");
		// The record reached a provider request inside the turn, not at its end.
		expect(
			harness.requests.some(request =>
				ircRecords(request).some(record => String(record.content).includes("between steps")),
			),
		).toBe(true);
	});

	it("carries an exchange queued before the run opens its first stream into that turn", async () => {
		const harness = createHarness();
		const prompt = harness.session.prompt("hello");
		// No run exists yet, so the session appends the record straight away.
		await harness.session.respondAsBackground({ from: "0-Main", message: "start of turn", awaitReply: false });
		expect(ircRecords(harness.agent.state.messages)).toHaveLength(1);

		await harness.firstStream;
		harness.releaseFirstStream();
		await prompt;

		const committed = ircRecords(harness.agent.state.messages);
		expect(committed).toHaveLength(1);
		expect(committed[0]?.content).toContain("start of turn");
		// It is part of the turn's history from the first provider request on.
		expect(harness.requests.some(request => ircRecords(request).length === 1)).toBe(true);
	});

	it("keeps an exchange together when an interrupt re-arms it as a follow-up", async () => {
		for (const steeringMode of ["one-at-a-time", "all"] as const) {
			const harness = createHarness({ steeringMode });
			const prompt = harness.session.prompt("hello");
			await harness.firstStream;

			await queuePair(harness.session, `${steeringMode} interrupted ping`);
			expect(ircRecords(harness.agent.snapshotSteering())).toHaveLength(2);

			// Esc while the pair still waits for its boundary: the run disowns the pair
			// and the session re-arms it as a follow-up of the next turn.
			await harness.session.abort({ cause: "user_interrupt" });
			await prompt.catch(() => undefined);
			expect(ircRecords(harness.agent.snapshotSteering())).toHaveLength(0);

			// The interrupt resumes into the re-armed pair, and the pair reaches one model
			// step as a unit: the request snapshot only shows that step once it starts.
			await waitFor(() => ircRecords(harness.agent.state.messages).length === 2);
			await waitFor(() => harness.requests.some(request => ircRecords(request).length === 2));

			const committed = ircRecords(harness.agent.state.messages);
			expect(committed.map(record => record.customType)).toEqual(["irc:incoming", "irc:autoreply"]);
			// The re-armed pair reaches the next turn as one unit: no request carries
			// the question without the reply this session already sent for it.
			for (const request of harness.requests) {
				for (let index = 0; index < request.length; index++) {
					const record = request[index];
					if (record?.role !== "custom" || record.customType !== "irc:incoming") continue;
					const next = request[index + 1];
					expect(next?.role === "custom" && next.customType === "irc:autoreply").toBe(true);
				}
			}
		}
	});

	it("persists an accepted exchange when the session switches before its boundary", async () => {
		const harness = createHarness();
		const prompt = harness.session.prompt("hello");
		await harness.firstStream;

		await queuePair(harness.session, "switch-away ping");
		// Admitted into the live run: the pair is steering, not history, yet.
		expect(ircRecords(harness.agent.snapshotSteering())).toHaveLength(2);
		expect(ircRecords(harness.agent.state.messages)).toHaveLength(0);

		// A session switch aborts the outgoing turn with the internal cause, whose
		// disposition drops unconsumed steering (switchSession calls abort() exactly
		// like this). Admission is not persistence, so the exchange still has to land
		// in the outgoing session's history.
		await harness.session.abort();
		await prompt.catch(() => undefined);

		const committed = ircRecords(harness.agent.state.messages);
		expect(committed.map(record => record.customType)).toEqual(["irc:incoming", "irc:autoreply"]);
	});

	it("conserves order, pairs, and count across generated queue schedules", async () => {
		const random = mulberry32(0x5eed_1234);
		for (let iteration = 0; iteration < 12; iteration++) {
			const harness = createHarness({
				pausedTool: true,
				steeringMode: iteration % 2 === 0 ? "one-at-a-time" : "all",
			});
			const queuedLabels: string[] = [];
			const queuedPairs = new Set<string>();
			let queuedRecords = 0;

			const prompt = harness.session.prompt("hello");
			await harness.firstStream;

			// Phase 1: queued while the first step streams (admitted straight away).
			const pairCount = 1 + Math.floor(random() * 2);
			for (let index = 0; index < pairCount; index++) {
				const label = `iter${iteration}-stream-${index}`;
				await queuePair(harness.session, label);
				queuedLabels.push(label);
				queuedPairs.add(label);
				queuedRecords += 2;
			}

			// Phase 2 boundary: the first step has ended and the run sits inside the tool,
			// so a record queued here has no open stream to join yet.
			harness.releaseFirstStream();
			await harness.toolStarted;

			// Phase 2: queued inside the tool pause (waits for the loop's next event).
			const singleCount = Math.floor(random() * 3);
			for (let index = 0; index < singleCount; index++) {
				const label = `iter${iteration}-pause-${index}`;
				await harness.session.respondAsBackground({ from: "0-Main", message: label, awaitReply: false });
				queuedLabels.push(label);
				queuedRecords += 1;
			}

			// Phase 3: the run streams again, then finishes.
			harness.releaseTool();
			await harness.secondStream;
			harness.releaseSecondStream();
			await prompt;

			const committed = ircRecords(harness.agent.state.messages);
			// Exactly once: nothing was dropped, duplicated, or committed twice.
			expect(committed).toHaveLength(queuedRecords);
			const labels = incomingLabels(harness.agent.state.messages);
			expect([...labels].sort()).toEqual([...queuedLabels].sort());
			// FIFO: the questions appear in the order they were queued.
			expect(labels).toEqual(queuedLabels);
			// Complete pairs: a question that already had a reply sent for it is
			// committed together with that reply, never on its own.
			for (let index = 0; index < committed.length; index++) {
				const record = committed[index];
				if (record?.customType !== "irc:incoming") continue;
				const label = incomingLabel(record);
				if (!queuedPairs.has(label)) continue;
				expect(committed[index + 1]?.customType).toBe("irc:autoreply");
				index += 1;
			}
			// No provider request ever carries a question whose reply exists without it.
			for (const request of harness.requests) {
				for (let index = 0; index < request.length; index++) {
					const record = request[index];
					if (record?.role !== "custom" || record.customType !== "irc:incoming") continue;
					const label = incomingLabel(record as IrcRecord);
					if (!queuedPairs.has(label)) continue;
					const next = request[index + 1];
					expect(next?.role === "custom" && next.customType === "irc:autoreply").toBe(true);
				}
			}
		}
	});
});

/** Deterministic generator so a failing schedule is reproducible from its seed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}
