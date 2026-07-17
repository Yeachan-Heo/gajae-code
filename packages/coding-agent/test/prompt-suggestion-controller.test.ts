import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { PromptSuggestionController } from "../src/modes/prompt-suggestion-controller";
import type { InteractiveModeContext } from "../src/modes/types";

interface FakeCtxOptions {
	enabled?: boolean;
	editorText?: string;
	isStreaming?: boolean;
}

function createFakeCtx(options: FakeCtxOptions = {}) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	let editorText = options.editorText ?? "";
	const state = {
		renderCount: 0,
		setTextCalls: [] as string[],
	};
	const ctx = {
		settings: {
			get(key: string) {
				return key === "promptSuggestions" ? (options.enabled ?? true) : undefined;
			},
			getModelRole(role: string) {
				return role === "default" ? `${model.provider}/${model.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		},
		shutdownRequested: false,
		session: {
			isStreaming: options.isStreaming ?? false,
			messages: [{ role: "user", content: "fix the bug", timestamp: Date.now() }],
			modelRegistry: {
				getAvailable: () => [model],
				getApiKey: async () => "test-key",
			},
			sessionId: "test-session",
			model,
			agent: {
				metadataForProvider: () => undefined,
			},
		},
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
				state.setTextCalls.push(text);
			},
		},
		ui: {
			requestRender: () => {
				state.renderCount++;
			},
		},
	} as unknown as InteractiveModeContext;
	return { ctx, state, setEditorText: (text: string) => (editorText = text) };
}

function mockPrediction(text: string) {
	return vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "stop",
		content: [{ type: "text", text }],
	} as never);
}

async function settle() {
	// Let the generation promise chain resolve.
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PromptSuggestionController", () => {
	it("stores the prediction after agent end and renders it", async () => {
		const { ctx, state } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		mockPrediction("run the tests");

		controller.onAgentEnd();
		await settle();

		expect(controller.current).toBe("run the tests");
		expect(state.renderCount).toBeGreaterThan(0);
	});

	it("does nothing when the setting is disabled", async () => {
		const { ctx } = createFakeCtx({ enabled: false });
		const controller = new PromptSuggestionController(ctx);
		const completeSimpleMock = mockPrediction("run the tests");

		controller.onAgentEnd();
		await settle();

		expect(controller.current).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("does not generate while the composer has text", async () => {
		const { ctx } = createFakeCtx({ editorText: "draft in progress" });
		const controller = new PromptSuggestionController(ctx);
		const completeSimpleMock = mockPrediction("run the tests");

		controller.onAgentEnd();
		await settle();

		expect(controller.current).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("discards a stale generation when a new turn starts mid-flight", async () => {
		const { ctx } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		mockPrediction("run the tests");

		controller.onAgentEnd();
		controller.onAgentStart();
		await settle();

		expect(controller.current).toBeNull();
	});

	it("discards a completed generation when the composer gained text meanwhile", async () => {
		const { ctx, setEditorText } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		mockPrediction("run the tests");

		controller.onAgentEnd();
		setEditorText("user started typing");
		await settle();

		expect(controller.current).toBeNull();
	});

	it("dismisses the suggestion when the user types", async () => {
		const { ctx } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		mockPrediction("run the tests");

		controller.onAgentEnd();
		await settle();
		expect(controller.current).toBe("run the tests");

		controller.notifyEditorChanged("r");
		expect(controller.current).toBeNull();
	});

	it("accepts the suggestion on Tab from an empty composer", async () => {
		const { ctx, state } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		mockPrediction("run the tests");

		controller.onAgentEnd();
		await settle();

		expect(controller.tryAcceptOnTab("")).toBe(true);
		expect(state.setTextCalls).toEqual(["run the tests"]);
		expect(controller.current).toBeNull();
	});

	it("does not consume Tab when the composer has text or no suggestion exists", async () => {
		const { ctx, state } = createFakeCtx();
		const controller = new PromptSuggestionController(ctx);
		mockPrediction("run the tests");

		expect(controller.tryAcceptOnTab("")).toBe(false);

		controller.onAgentEnd();
		await settle();

		expect(controller.tryAcceptOnTab("some draft")).toBe(false);
		expect(state.setTextCalls).toEqual([]);
	});
});
