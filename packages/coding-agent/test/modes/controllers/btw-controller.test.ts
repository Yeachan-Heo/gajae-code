import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import { BtwController } from "@gajae-code/coding-agent/modes/controllers/btw-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { Container, type TUI } from "@gajae-code/tui";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface RunEphemeralTurnArgs {
	promptText: string;
	contextMessages?: readonly AgentMessage[];
	onTextDelta?: (delta: string) => void;
	signal?: AbortSignal;
}

interface RunEphemeralTurnResult {
	replyText: string;
	assistantMessage: AssistantMessage;
}

function makeFakeSession(
	runEphemeralTurn: (args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>,
): InteractiveModeContext["session"] {
	return {
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		runEphemeralTurn,
	} as unknown as InteractiveModeContext["session"];
}

function makeCtx(session: InteractiveModeContext["session"], btwContainer = new Container()): InteractiveModeContext {
	return {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		btwContainer,
		session,
		showStatus: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
}

beforeAll(async () => {
	await initTheme();
});

describe("BtwController", () => {
	it("dispatches the question to runEphemeralTurn with the btw prompt wrapper and a fresh signal", async () => {
		const runEphemeralTurn = vi.fn(async (_args: RunEphemeralTurnArgs) => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("What changed?");
		// Drain microtasks so the inner promise can resolve.
		await Promise.resolve();
		await Promise.resolve();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		const callArg = runEphemeralTurn.mock.calls[0]?.[0];
		expect(callArg).toBeDefined();
		expect(callArg?.promptText).toContain("<btw>");
		expect(callArg?.promptText).toContain("What changed?");
		expect(callArg?.signal).toBeInstanceOf(AbortSignal);
		expect(typeof callArg?.onTextDelta).toBe("function");
		expect(controller.hasActiveRequest()).toBe(true);
	});

	it("replaces a previous request by aborting it before issuing the next runEphemeralTurn", async () => {
		const signals: AbortSignal[] = [];
		let firstRelease!: () => void;
		const firstPromise = new Promise<RunEphemeralTurnResult>(resolve => {
			firstRelease = () => resolve({ replyText: "first", assistantMessage: createAssistantMessage("first") });
		});
		const runEphemeralTurn = vi
			.fn<(args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>>()
			.mockImplementationOnce(async args => {
				signals.push(args.signal as AbortSignal);
				return firstPromise;
			})
			.mockImplementationOnce(async args => {
				signals.push(args.signal as AbortSignal);
				return { replyText: "second", assistantMessage: createAssistantMessage("second") };
			});
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("First?");
		await controller.start("Second?");
		// Allow the second call to settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		expect(btwContainer.children).toHaveLength(1);
		// Allow the orphaned first request to finish to keep the test clean.
		firstRelease();
	});

	it("clears the panel when the active request is dismissed via Escape", async () => {
		const runEphemeralTurn = vi.fn(async () => new Promise<RunEphemeralTurnResult>(() => {}));
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		expect(btwContainer.children).toHaveLength(1);
		expect(controller.handleEscape()).toBe(true);
		expect(btwContainer.children).toHaveLength(0);
		expect(controller.hasActiveRequest()).toBe(false);
	});

	it("rejects empty questions before issuing the side-channel call", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "n/a",
			assistantMessage: createAssistantMessage("n/a"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("   ");
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(controller.hasActiveRequest()).toBe(false);
	});

	it("shows an error message when no model is configured", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "n/a",
			assistantMessage: createAssistantMessage("n/a"),
		}));
		const session = { model: undefined, runEphemeralTurn } as unknown as InteractiveModeContext["session"];
		const ctx = makeCtx(session);
		const controller = new BtwController(ctx);

		await controller.start("Anything?");
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(ctx.showError).toHaveBeenCalled();
	});
	it("replays completed retained turns as raw user and returned assistant messages", async () => {
		const firstAssistant = createAssistantMessage("First answer");
		const runEphemeralTurn = vi
			.fn<(args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>>()
			.mockResolvedValueOnce({ replyText: "First answer", assistantMessage: firstAssistant })
			.mockResolvedValueOnce({
				replyText: "Second answer",
				assistantMessage: createAssistantMessage("Second answer"),
			});
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.startRetained("  First question?  ");
		await Promise.resolve();
		await Promise.resolve();

		expect(controller.hasOpenRetainedThread()).toBe(true);
		expect(controller.isRetainedTurnInFlight()).toBe(false);
		expect(await controller.submitRetainedFollowUp("Second question?")).toBe("accepted");
		await Promise.resolve();
		await Promise.resolve();

		const secondCall = runEphemeralTurn.mock.calls[1]?.[0];
		expect(secondCall?.promptText).toContain("<btw-r>");
		expect(secondCall?.contextMessages).toHaveLength(2);
		const firstContextMessage = secondCall?.contextMessages?.[0];
		expect(firstContextMessage).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "First question?" }],
			attribution: "user",
		});
		expect(secondCall?.contextMessages?.[1]).toBe(firstAssistant);
		expect(controller.isRetainedTurnInFlight()).toBe(false);
	});

	it("rejects retained follow-ups while a request is in flight", async () => {
		const runEphemeralTurn = vi.fn(async () => new Promise<RunEphemeralTurnResult>(() => {}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.startRetained("First?");
		expect(await controller.submitRetainedFollowUp("Second?")).toBe("busy");
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("still answering"));
	});
	it("blocks one-shot replacement and retained re-entry while a retained thread is open", async () => {
		const runEphemeralTurn = vi.fn(async () => new Promise<RunEphemeralTurnResult>(() => {}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.startRetained("First?");
		await controller.start("One-shot?");
		await controller.startRetained("Replacement?");

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(controller.hasOpenRetainedThread()).toBe(true);
		expect(ctx.showStatus).toHaveBeenCalledTimes(2);
	});

	it("keeps retained complete and error panels open until Escape", async () => {
		const runEphemeralTurn = vi
			.fn<(args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>>()
			.mockResolvedValueOnce({ replyText: "Answer", assistantMessage: createAssistantMessage("Answer") })
			.mockRejectedValueOnce(new Error("boom"));
		const controller = new BtwController(makeCtx(makeFakeSession(runEphemeralTurn)));

		await controller.startRetained("First?");
		await Promise.resolve();
		await Promise.resolve();
		expect(controller.hasActiveRequest()).toBe(true);
		expect(controller.isRetainedTurnInFlight()).toBe(false);

		expect(await controller.submitRetainedFollowUp("Second?")).toBe("accepted");
		await Promise.resolve();
		await Promise.resolve();
		expect(controller.hasOpenRetainedThread()).toBe(true);
		expect(controller.isRetainedTurnInFlight()).toBe(false);

		expect(controller.handleEscape()).toBe(true);
		expect(controller.hasOpenRetainedThread()).toBe(false);
	});

	it("records failed retained turns into context so later follow-ups can see the failed question", async () => {
		const runEphemeralTurn = vi
			.fn<(args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>>()
			.mockRejectedValueOnce(new Error("provider unavailable"))
			.mockResolvedValueOnce({
				replyText: "Recovered answer",
				assistantMessage: createAssistantMessage("Recovered answer"),
			});
		const controller = new BtwController(makeCtx(makeFakeSession(runEphemeralTurn)));

		await controller.startRetained("Failed question?");
		await Promise.resolve();
		await Promise.resolve();
		expect(controller.hasOpenRetainedThread()).toBe(true);
		expect(controller.isRetainedTurnInFlight()).toBe(false);

		expect(await controller.submitRetainedFollowUp("try again")).toBe("accepted");
		await Promise.resolve();
		await Promise.resolve();

		const retryCall = runEphemeralTurn.mock.calls[1]?.[0];
		expect(retryCall?.contextMessages).toHaveLength(2);
		expect(retryCall?.contextMessages?.[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Failed question?" }],
			attribution: "user",
		});
		expect(retryCall?.contextMessages?.[1]).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "provider unavailable",
			content: [{ type: "text", text: "Error: provider unavailable" }],
		});
	});
	it("lets /btw-r replace an open one-shot /btw panel", async () => {
		const signals: AbortSignal[] = [];
		const runEphemeralTurn = vi
			.fn<(args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>>()
			.mockImplementationOnce(async args => {
				signals.push(args.signal as AbortSignal);
				return new Promise(() => {});
			})
			.mockImplementationOnce(async args => {
				signals.push(args.signal as AbortSignal);
				return { replyText: "retained", assistantMessage: createAssistantMessage("retained") };
			});
		const btwContainer = new Container();
		const controller = new BtwController(makeCtx(makeFakeSession(runEphemeralTurn), btwContainer));

		await controller.start("One-shot?");
		await controller.startRetained("Retained?");
		await Promise.resolve();
		await Promise.resolve();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
		expect(signals[0]?.aborted).toBe(true);
		expect(controller.hasOpenRetainedThread()).toBe(true);
		expect(btwContainer.children).toHaveLength(1);
	});
});
