/**
 * C58 `btw.ask` control contract.
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
import type { ExtensionAPI, ExtensionContext, ExtensionTranscriptEntry } from "../src/extensibility/extensions";
import type { BrokerDiscovery } from "../src/sdk/broker/discovery";
import { createSdkSessionRuntimeExtension, type SessionSdkTransport } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";
import { BTW_MAX_QUESTION_UTF8_BYTES } from "../src/session/btw-contract";

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
	readonly sent: SdkFrame[];
} {
	let handler: ((connectionId: string, frame: SdkFrame) => void) | undefined;
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
	readonly transcript: ExtensionTranscriptEntry[];
	/** Prompt submissions routed through the extension API (`turn.prompt` admission). */
	readonly promptDispatches: number;
	stop(): Promise<void>;
}

async function createBtwAskHarness(
	askEphemeralQuestion?: (question: string) => Promise<string>,
): Promise<BtwAskHarness> {
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
