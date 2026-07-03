import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@gajae-code/ai";
import { type Api, getBundledModel, type Model } from "@gajae-code/ai";
import {
	buildTitleGenerationInput,
	evaluateTitleGeneration,
	formatSessionTerminalTitle,
	generateSessionTitle,
	reconcileTitleAttemptBaseline,
	TITLE_GENERATION_USER_MESSAGE_INTERVAL,
} from "../src/utils/title-generator";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>) {
	return {
		getModelRole(role: string) {
			return role === "default" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("title generator", () => {
	it("returns the title from a forced set_title tool call", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Structured Title" },
				},
			],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Structured Title");
		expect(completeSimpleMock.mock.calls[0]?.[1]).toMatchObject({
			tools: [expect.objectContaining({ name: "set_title" })],
		});
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			disableReasoning: true,
			toolChoice: { type: "tool", name: "set_title" },
		});
	});

	it("falls back to text content when no set_title tool call is returned", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Text Title" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Text Title");
	});

	it("uses a reasoning-safe output budget for reasoning models", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Budget Title" },
				},
			],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);
		const maxTokens = (completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number } | undefined)?.maxTokens;

		expect(title).toBe("Budget Title");
		expect(maxTokens).toBeGreaterThanOrEqual(1024);
	});
});

describe("formatSessionTerminalTitle", () => {
	it("returns GJC when no session name or cwd is provided", () => {
		expect(formatSessionTerminalTitle(undefined)).toBe("GJC");
	});

	it("prefixes the session name with GJC", () => {
		expect(formatSessionTerminalTitle("My Session")).toBe("GJC: My Session");
	});

	it("falls back to the cwd basename when no session name is provided", () => {
		expect(formatSessionTerminalTitle(undefined, "/home/user/gajae")).toBe("GJC: gajae");
	});

	it("strips control characters from the session name", () => {
		expect(formatSessionTerminalTitle("ab\u0001\u001bc")).toBe("GJC: abc");
	});

	it("falls back to GJC when the sanitized session name is empty", () => {
		expect(formatSessionTerminalTitle("\u0001\u001b")).toBe("GJC");
	});
});

describe("evaluateTitleGeneration", () => {
	const interval = TITLE_GENERATION_USER_MESSAGE_INTERVAL;

	it("fires initial generation on the first submission of an unnamed session (new or resumed)", () => {
		expect(
			evaluateTitleGeneration({
				disabled: false,
				sessionName: undefined,
				titleSource: undefined,
				userMessagesSinceLastAttempt: 0,
			}),
		).toBe("initial");
	});

	it("retries initial generation only after the interval elapses", () => {
		const base = {
			disabled: false,
			sessionName: undefined,
			titleSource: undefined,
		};
		expect(evaluateTitleGeneration({ ...base, userMessagesSinceLastAttempt: 1 })).toBeUndefined();
		expect(evaluateTitleGeneration({ ...base, userMessagesSinceLastAttempt: interval - 1 })).toBeUndefined();
		expect(evaluateTitleGeneration({ ...base, userMessagesSinceLastAttempt: interval })).toBe("initial");
	});

	it("refreshes an auto-generated title once the interval elapses", () => {
		const base = {
			disabled: false,
			sessionName: "Fix resolver bug",
			titleSource: "auto" as const,
		};
		expect(evaluateTitleGeneration({ ...base, userMessagesSinceLastAttempt: 0 })).toBeUndefined();
		expect(evaluateTitleGeneration({ ...base, userMessagesSinceLastAttempt: interval - 1 })).toBeUndefined();
		expect(evaluateTitleGeneration({ ...base, userMessagesSinceLastAttempt: interval })).toBe("refresh");
	});

	it("never overwrites a user-set name", () => {
		expect(
			evaluateTitleGeneration({
				disabled: false,
				sessionName: "my name",
				titleSource: "user",
				userMessagesSinceLastAttempt: interval * 10,
			}),
		).toBeUndefined();
	});

	it("treats a named session without a recorded source as user-owned", () => {
		expect(
			evaluateTitleGeneration({
				disabled: false,
				sessionName: "legacy name",
				titleSource: undefined,
				userMessagesSinceLastAttempt: interval * 10,
			}),
		).toBeUndefined();
	});

	it("does nothing when title generation is disabled", () => {
		expect(
			evaluateTitleGeneration({
				disabled: true,
				sessionName: undefined,
				titleSource: undefined,
				userMessagesSinceLastAttempt: 0,
			}),
		).toBeUndefined();
	});
});

describe("buildTitleGenerationInput", () => {
	it("joins the trailing user messages with the current text", () => {
		expect(buildTitleGenerationInput(["first", "second", "third"], "current")).toBe("second\n\nthird\n\ncurrent");
	});

	it("extracts text blocks from structured user content", () => {
		expect(
			buildTitleGenerationInput(
				[
					[
						{ type: "text", text: "look at this" },
						{ type: "image", data: "abc", mimeType: "image/png" },
					],
				],
				"current",
			),
		).toBe("look at this\n\ncurrent");
	});

	it("skips empty messages", () => {
		expect(buildTitleGenerationInput(["", "   "], "current")).toBe("current");
	});

	it("returns just the current text when there is no prior context", () => {
		expect(buildTitleGenerationInput([], "current")).toBe("current");
	});
});

describe("reconcileTitleAttemptBaseline", () => {
	it("starts fresh at the current count when there is no baseline", () => {
		expect(reconcileTitleAttemptBaseline(undefined, "s1", 5)).toEqual({ sessionId: "s1", userMessages: 5 });
	});

	it("resets when the session changes (session switch)", () => {
		const baseline = { sessionId: "s1", userMessages: 2 };
		expect(reconcileTitleAttemptBaseline(baseline, "s2", 20)).toEqual({ sessionId: "s2", userMessages: 20 });
	});

	it("keeps the baseline while the message count grows", () => {
		const baseline = { sessionId: "s1", userMessages: 3 };
		expect(reconcileTitleAttemptBaseline(baseline, "s1", 9)).toEqual({ sessionId: "s1", userMessages: 3 });
	});

	it("clamps down after a history rewrite shrinks the message list", () => {
		// Compaction/pruning/checkpoint rewind can drop user messages below the
		// recorded baseline; without clamping the cadence would never fire again.
		const baseline = { sessionId: "s1", userMessages: 12 };
		expect(reconcileTitleAttemptBaseline(baseline, "s1", 4)).toEqual({ sessionId: "s1", userMessages: 4 });
	});
});
