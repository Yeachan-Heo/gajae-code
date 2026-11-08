/**
 * C60 `btw.ask` control contract.
 *
 * The external SDK control for the `/btw` side question must answer from the
 * session-owned ephemeral runner, admit no turn, append nothing to the
 * transcript, refuse malformed/oversized questions as `invalid_input`, refuse a
 * second concurrent question as `busy`, and report `unavailable` (never hang)
 * when the host has no ephemeral runner seam.
 *
 * The runner is injected through the private `askEphemeralQuestion` option, so
 * no modelled provider call is involved. These cases drive the REAL SDK host
 * control path (`control_request` frame -> dispatchControl -> ControlSurface),
 * which also proves the operation is installed on the session surface: a missing
 * `sdkControl` binding would answer `operation_not_session_owned`.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import type { ExtensionAPI, ExtensionContext, ExtensionTranscriptEntry } from "../src/extensibility/extensions";
import type { BrokerDiscovery } from "../src/sdk/broker/discovery";
import { createBtwAskHandler, type EphemeralQuestionRunner } from "../src/sdk/host/control/btw-ask";
import { createSdkSessionRuntimeExtension, type SessionSdkTransport } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";
import {
	BTW_MAX_ANSWER_UTF8_BYTES,
	BTW_MAX_CONTEXT_TURNS,
	BTW_MAX_CONTEXT_UTF8_BYTES,
	BTW_MAX_QUESTION_UTF8_BYTES,
	type BtwTextExchange,
	boundBtwExchanges,
	utf8ByteLength,
} from "../src/session/btw-contract";

/** Unit fixtures must never launch the production broker daemon. */
const testBrokerDiscovery: BrokerDiscovery = {
	version: 1,
	protocolVersion: 3,
	packageGeneration: "test",
	ownerId: "test-broker",
	pid: process.pid,
	incarnation: "test-incarnation",
	host: "127.0.0.1",
	port: 1,
	url: "ws://127.0.0.1:1",
	token: "test-token",
	startedAt: 0,
	heartbeatAt: 0,
};

interface ControlResponseFrame {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: { code: string; message: string };
}

function memoryTransport(): SessionSdkTransport & {
	feed(connectionId: string, frame: SdkFrame): void;
	disconnect(connectionId: string): void;
	readonly sent: SdkFrame[];
} {
	let handler: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let closeHandler: ((connectionId: string) => void) | undefined;
	const sent: SdkFrame[] = [];
	let started = false;
	return {
		sessionId: "session-btw-ask",
		stateRoot: "/tmp/gjc-btw-ask-test",
		token: "btw-ask-test-token",
		sent,
		onFrame(next) {
			handler = next;
			return () => {
				if (handler === next) handler = undefined;
			};
		},
		onConnectionClose(next) {
			closeHandler = next;
			return () => {
				closeHandler = undefined;
			};
		},
		sendFrame(_connectionId, frame) {
			sent.push(frame);
		},
		start: async () => {
			started = true;
			return { url: "ws://127.0.0.1:1" };
		},
		stop: async () => {
			started = false;
		},
		broadcastFrame: () => {},
		disconnect: connectionId => closeHandler?.(connectionId),
		feed(connectionId, frame) {
			if (!started) throw new Error("transport is not started");
			handler?.(connectionId, frame);
		},
	};
}

interface BtwAskHarness {
	control(operation: string, input: Record<string, unknown>): Promise<ControlResponseFrame>;
	/** Frames already answered for a request id, without waiting. */
	responseFor(id: string): ControlResponseFrame | undefined;
	send(id: string, input: unknown): void;
	disconnect(): void;
	readonly transcript: ExtensionTranscriptEntry[];
	/** Prompt submissions routed through the extension API (`turn.prompt` admission). */
	readonly promptDispatches: number;
	stop(): Promise<void>;
}

async function createBtwAskHarness(askEphemeralQuestion?: EphemeralQuestionRunner): Promise<BtwAskHarness> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-btw-ask-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const harnessState = { promptDispatches: 0 };
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: async () => {
			harnessState.promptDispatches += 1;
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		ensureBrokerImpl: async () => testBrokerDiscovery,
		createTransport: async () => transport,
		askEphemeralQuestion,
	});
	const transcript: ExtensionTranscriptEntry[] = [];
	const ctx = {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => ["sdkControl"],
		sdkControl: () => {
			throw new Error("btw.ask must use its session-owned runner, not ctx.sdkControl");
		},
		sessionManager: {
			getSessionId: () => transport.sessionId,
			getSessionFile: () => path.join(cwd, `${transport.sessionId}.json`),
			getSessionName: () => undefined,
			getBranch: () => [],
		},
		getTranscript: () => transcript,
		getGoalState: () => undefined,
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({}, ctx);
	let nextId = 0;
	const responseFor = (id: string): ControlResponseFrame | undefined =>
		transport.sent.find(frame => frame.type === "control_response" && frame.id === id) as
			| ControlResponseFrame
			| undefined;
	const send = (id: string, input: unknown): void => {
		transport.feed("client", {
			type: "control_request",
			id,
			operation: "btw.ask",
			input,
		} as SdkFrame);
	};
	return {
		transcript,
		get promptDispatches() {
			return harnessState.promptDispatches;
		},
		send,
		disconnect: () => transport.disconnect("client"),
		responseFor,
		async control(operation, input) {
			const id = `btw-ask-${nextId++}-${operation}`;
			if (operation !== "btw.ask") throw new Error(`Unsupported test operation: ${operation}`);
			send(id, input);
			const deadline = Date.now() + 10_000;
			for (;;) {
				const response = responseFor(id);
				if (response) return response;
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${operation} (${id})`);
				await Bun.sleep(5);
			}
		},
		async stop() {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

test("btw.ask answers from the session-owned runner without admitting a turn or touching the transcript", async () => {
	const questions: string[] = [];
	const harness = await createBtwAskHarness(async question => {
		questions.push(question);
		return "  the side answer  ";
	});
	try {
		const response = await harness.control("btw.ask", { question: "  what changed?  " });

		expect(response).toMatchObject({ id: expect.any(String), ok: true, result: { reply: "the side answer" } });
		// The runner receives the trimmed question, exactly once.
		expect(questions).toEqual(["what changed?"]);
		// No turn was admitted and nothing reached the transcript.
		expect(harness.promptDispatches).toBe(0);
		expect(harness.transcript).toEqual([]);
	} finally {
		await harness.stop();
	}
});

test("btw.ask accepts the exact UTF-8 question limit", async () => {
	const questions: string[] = [];
	const harness = await createBtwAskHarness(async question => {
		questions.push(question);
		return "limit ok";
	});
	try {
		const response = await harness.control("btw.ask", { question: "a".repeat(BTW_MAX_QUESTION_UTF8_BYTES) });
		expect(response).toMatchObject({ ok: true, result: { reply: "limit ok" } });
		expect(questions[0]?.length).toBe(BTW_MAX_QUESTION_UTF8_BYTES);
	} finally {
		await harness.stop();
	}
});

test("btw.ask refuses a missing, blank, or oversized question as invalid input before reaching the runner", async () => {
	let runnerCalls = 0;
	const harness = await createBtwAskHarness(async () => {
		runnerCalls += 1;
		return "must not run";
	});
	try {
		const rejections = [
			await harness.control("btw.ask", {}),
			await harness.control("btw.ask", { question: "   " }),
			await harness.control("btw.ask", { question: 7 }),
			await harness.control("btw.ask", { question: "a".repeat(BTW_MAX_QUESTION_UTF8_BYTES + 1) }),
		];
		for (const response of rejections) {
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("invalid_input");
		}
		expect(runnerCalls).toBe(0);
		expect(harness.promptDispatches).toBe(0);
	} finally {
		await harness.stop();
	}
});

test("btw.ask refuses a second concurrent question as busy and recovers once the first settles", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<string>();
	let runnerCalls = 0;
	const harness = await createBtwAskHarness(async () => {
		runnerCalls += 1;
		started.resolve();
		return await release.promise;
	});
	try {
		harness.send("first", { question: "first question" });
		await started.promise;

		harness.send("second", { question: "second question" });
		const deadline = Date.now() + 10_000;
		while (!harness.responseFor("second")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the concurrent btw.ask refusal");
			await Bun.sleep(5);
		}
		expect(harness.responseFor("second")).toMatchObject({
			ok: false,
			error: {
				code: "busy",
				message: "A /btw question is already running. Wait for it to finish.",
			},
		});
		expect(runnerCalls).toBe(1);

		release.resolve("first answer");
		while (!harness.responseFor("first")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the first btw.ask answer");
			await Bun.sleep(5);
		}
		expect(harness.responseFor("first")).toMatchObject({ ok: true, result: { reply: "first answer" } });

		// The single-flight guard is released with the runner, not permanently held.
		const next = await harness.control("btw.ask", { question: "third question" });
		expect(next).toMatchObject({ ok: true, result: { reply: "first answer" } });
		expect(runnerCalls).toBe(2);
		expect(harness.promptDispatches).toBe(0);
	} finally {
		release.resolve("released");
		await harness.stop();
	}
});

test("btw.ask forwards caller exchanges to the runner in order, mapping reply to answer", async () => {
	const calls: { question: string; exchanges: readonly BtwTextExchange[] }[] = [];
	const harness = await createBtwAskHarness(async (question, exchanges) => {
		calls.push({ question, exchanges });
		return "follow-up answer";
	});
	try {
		const exchanges = [
			{ question: "first side question", reply: "first side reply" },
			{ question: "  second  ", reply: "" },
		];
		const response = await harness.control("btw.ask", { question: "and then?", exchanges });
		expect(response).toMatchObject({ ok: true, result: { reply: "follow-up answer" } });
		// Without exchanges the runner still receives an explicit empty history.
		await harness.control("btw.ask", { question: "fresh question" });
		expect(calls).toEqual([
			{
				question: "and then?",
				exchanges: [
					{ question: "first side question", answer: "first side reply" },
					{ question: "  second  ", answer: "" },
				],
			},
			{ question: "fresh question", exchanges: [] },
		]);
		expect(harness.promptDispatches).toBe(0);
		expect(harness.transcript).toEqual([]);
	} finally {
		await harness.stop();
	}
});

test("btw.ask refuses unknown fields and malformed exchanges as invalid input before reaching the runner", async () => {
	let runnerCalls = 0;
	const harness = await createBtwAskHarness(async () => {
		runnerCalls += 1;
		return "must not run";
	});
	try {
		const cases: [Record<string, unknown>, string][] = [
			[{ question: "q", history: [] }, "Unknown btw.ask input field: history"],
			[{ question: "q", exchanges: "q:a" }, "btw.ask exchanges must be an array"],
			[{ question: "q", exchanges: { question: "q", reply: "r" } }, "btw.ask exchanges must be an array"],
			[{ question: "q", exchanges: [null] }, "btw.ask exchanges[0] must be a { question, reply } object."],
			[{ question: "q", exchanges: [["q", "r"]] }, "btw.ask exchanges[0] must be a { question, reply } object."],
			[
				{
					question: "q",
					exchanges: [
						{ question: "q", reply: "r" },
						{ question: "q", answer: "r" },
					],
				},
				"Unknown btw.ask exchanges[1] field: answer",
			],
			[{ question: "q", exchanges: [{ question: " ", reply: "r" }] }, "exchanges[0].question must be a nonempty"],
			[{ question: "q", exchanges: [{ question: "q" }] }, "btw.ask exchanges[0].reply must be a string."],
			[{ question: "q", exchanges: [{ question: "q", reply: 7 }] }, "btw.ask exchanges[0].reply must be a string."],
		];
		for (const [input, message] of cases) {
			const response = await harness.control("btw.ask", input);
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("invalid_input");
			expect(response.error?.message).toContain(message);
		}
		expect(runnerCalls).toBe(0);
		expect(harness.promptDispatches).toBe(0);
	} finally {
		await harness.stop();
	}
});

test("property: caller exchanges are bounded like the /btw panel, keeping the newest in order", async () => {
	const unit = fc.constantFrom("a", "é", "한", "🦞");
	const text = (maxUnits: number) =>
		fc.tuple(unit, fc.integer({ min: 1, max: maxUnits })).map(([character, count]) => character.repeat(count));
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.record({
					question: fc.oneof(text(12), text(6_000)),
					reply: fc.oneof(fc.constant(""), text(12), text(12_000)),
				}),
				{ maxLength: 20 },
			),
			async exchanges => {
				let received: readonly BtwTextExchange[] | undefined;
				const ask = createBtwAskHandler(async (_question, history) => {
					received = history;
					return "answer";
				});
				await ask({ question: "next", exchanges });
				if (!received) throw new Error("runner was not called");
				const mapped = exchanges.map(({ question, reply }) => ({ question, answer: reply }));
				expect(received).toEqual(boundBtwExchanges(mapped));
				// The documented semantics, checked independently of the bounding helper.
				expect(received.length).toBeLessThanOrEqual(BTW_MAX_CONTEXT_TURNS);
				let total = 0;
				const offset = mapped.length - received.length;
				for (const [index, kept] of received.entries()) {
					const source = mapped[offset + index]!;
					expect(source.question.startsWith(kept.question)).toBe(true);
					expect(source.answer.startsWith(kept.answer)).toBe(true);
					expect(utf8ByteLength(kept.question)).toBeLessThanOrEqual(BTW_MAX_QUESTION_UTF8_BYTES);
					expect(utf8ByteLength(kept.answer)).toBeLessThanOrEqual(BTW_MAX_ANSWER_UTF8_BYTES);
					// A cut lands on a character boundary: the next character would exceed the limit.
					for (const [cut, full, limit] of [
						[kept.question, source.question, BTW_MAX_QUESTION_UTF8_BYTES],
						[kept.answer, source.answer, BTW_MAX_ANSWER_UTF8_BYTES],
					] as const) {
						if (cut === full) continue;
						const next = String.fromCodePoint(full.slice(cut.length).codePointAt(0)!);
						expect(utf8ByteLength(cut + next)).toBeGreaterThan(limit);
					}
					total += utf8ByteLength(kept.question) + utf8ByteLength(kept.answer);
				}
				expect(total).toBeLessThanOrEqual(BTW_MAX_CONTEXT_UTF8_BYTES);
				// Only the oldest are dropped, and only when the next older one would not fit.
				if (offset > 0 && received.length < BTW_MAX_CONTEXT_TURNS) {
					const dropped = boundBtwExchanges([mapped[offset - 1]!])[0]!;
					expect(total + utf8ByteLength(dropped.question) + utf8ByteLength(dropped.answer)).toBeGreaterThan(
						BTW_MAX_CONTEXT_UTF8_BYTES,
					);
				}
			},
		),
		{ seed: 7322, numRuns: 120 },
	);
});

test("btw.ask reports unavailable when the host has no ephemeral runner seam", async () => {
	const harness = await createBtwAskHarness(undefined);
	try {
		const response = await harness.control("btw.ask", { question: "anything" });
		expect(response.ok).toBe(false);
		expect(response.error?.code).toBe("unavailable");
		expect(response.error?.message).toContain("btw.ask is unavailable");
		expect(harness.promptDispatches).toBe(0);
	} finally {
		await harness.stop();
	}
});

test("btw.ask maps malformed runner replies to unavailable and allows a subsequent retry", async () => {
	let reply: unknown;
	const harness = await createBtwAskHarness(async () => reply as string);
	try {
		for (reply of [undefined, null, 7, {}, ["not a string"]]) {
			expect(await harness.control("btw.ask", { question: "question" })).toMatchObject({
				ok: false,
				error: { code: "unavailable", message: "The /btw runner returned an invalid reply." },
			});
		}
		reply = " valid answer ";
		expect(await harness.control("btw.ask", { question: "retry" })).toMatchObject({
			ok: true,
			result: { reply: "valid answer" },
		});
	} finally {
		await harness.stop();
	}
});

test("property: generated question types and UTF-8 boundaries are validated before runner admission", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.oneof(
				fc.jsonValue(),
				fc
					.tuple(fc.constantFrom("a", "한", "🦞", " "), fc.integer({ min: -2, max: 2 }))
					.map(([unit, offset]) =>
						unit.repeat(
							Math.floor(BTW_MAX_QUESTION_UTF8_BYTES / new TextEncoder().encode(unit).byteLength) + offset,
						),
					),
			),
			async question => {
				const calls: string[] = [];
				const ask = createBtwAskHandler(async value => {
					calls.push(value);
					return " answer ";
				});
				const valid =
					typeof question === "string" &&
					question.trim().length > 0 &&
					new TextEncoder().encode(question).byteLength <= BTW_MAX_QUESTION_UTF8_BYTES;
				// Wire input is untrusted; deliberately exercise runtime type validation.
				if (valid) {
					expect(await ask({ question })).toEqual({ reply: "answer" });
					expect(calls).toEqual([(question as string).trim()]);
				} else {
					await expect(ask({ question })).rejects.toMatchObject({ code: "invalid_input" });
					expect(calls).toEqual([]);
				}
			},
		),
		{ seed: 750401, numRuns: 150 },
	);
});

for (const ending of ["disconnect", "shutdown"] as const) {
	test(`SDK-only BTW runner receives ${ending} cancellation without releasing single-flight early`, async () => {
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<string>();
		let calls = 0;
		const harness = await createBtwAskHarness(async (_question, _exchanges, signal) => {
			calls++;
			if (!signal) throw new Error("Missing request cancellation signal");
			started.resolve(signal);
			return await release.promise;
		});
		let stopped = false;
		try {
			harness.send("pending", { question: "first" });
			const signal = await started.promise;
			expect(signal.aborted).toBe(false);
			if (ending === "disconnect") harness.disconnect();
			else {
				await harness.stop();
				stopped = true;
			}
			expect(signal.aborted).toBe(true);
			if (ending === "disconnect") {
				const response = await harness.control("btw.ask", { question: "second" });
				expect(response).toMatchObject({ ok: false, error: { code: "busy" } });
				expect(calls).toBe(1);
			}
		} finally {
			release.resolve("settled");
			if (!stopped) await harness.stop();
		}
	});
}

test("property: concurrent callers never overlap runners and settle/reject permits retry", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.record({ reject: fc.boolean(), contenders: fc.integer({ min: 1, max: 5 }), reply: fc.string() }), {
				minLength: 1,
				maxLength: 12,
			}),
			async rounds => {
				let release = Promise.withResolvers<string>();
				let active = 0;
				let calls = 0;
				const ask = createBtwAskHandler(async () => {
					calls++;
					active++;
					expect(active).toBe(1);
					try {
						return await release.promise;
					} finally {
						active--;
					}
				});
				for (const [index, round] of rounds.entries()) {
					release = Promise.withResolvers<string>();
					const answer = ask({ question: "question" }).then(
						result => ({ result }),
						error => ({ error }),
					);
					try {
						await Promise.all(
							Array.from({ length: round.contenders }, () =>
								expect(ask({ question: "concurrent question" })).rejects.toThrow("already running"),
							),
						);
						expect(calls).toBe(index + 1);
					} finally {
						if (round.reject) release.reject(new Error("provider rejected"));
						else release.resolve(round.reply);
						const outcome = await answer;
						if (round.reject) expect(outcome).toMatchObject({ error: { message: "provider rejected" } });
						else expect(outcome).toEqual({ result: { reply: round.reply.trim() } });
					}
					expect(active).toBe(0);
				}
			},
		),
		{ seed: 750402, numRuns: 100 },
	);
});
