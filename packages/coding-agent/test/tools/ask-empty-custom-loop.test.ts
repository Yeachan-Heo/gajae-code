/**
 * Regression coverage for gajae-code#5001: an answering surface that keeps
 * submitting an empty/whitespace-only free-text answer used to make the ask
 * tool re-ask the identical question forever. The re-asks are now bounded and
 * the ask settles instead of spinning.
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { AskAnswerRequest, AskAnswerSource, ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool } from "@gajae-code/coding-agent/tools/ask";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function neverResolvingContext() {
	return {
		select: (_prompt: string, _options: string[], dialogOptions?: { signal?: AbortSignal }) =>
			new Promise<string | undefined>(resolve => {
				dialogOptions?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			}),
		editor: (_title: string, _prefill: string, dialogOptions?: { signal?: AbortSignal }) =>
			new Promise<string | undefined>(resolve => {
				dialogOptions?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			}),
		abort: () => {},
	};
}

describe("AskTool empty free-text answers", () => {
	it("bounds the re-ask loop instead of repeating one question forever", async () => {
		const questions: string[] = [];
		const settlements: unknown[] = [];
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: (request: AskAnswerRequest) => {
				questions.push(request.question);
				// A surface stuck on whitespace-only free text. Before the fix this
				// branch was re-entered without any bound.
				if (questions.length > 25) throw new Error(`LOOP_UNBOUNDED_${questions.length}`);
				return Promise.resolve({
					source: "remote" as const,
					interaction: { kind: "value" as const, value: "   " },
					settle: async (settlement: unknown) => {
						settlements.push(settlement);
						return { kind: "resolved_without_commit" as const };
					},
				});
			},
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source }));

		// The bounded path names the surface defect instead of looping, and it must not
		// be reported as a user cancellation (#5001 review B2).
		await expect(
			tool.execute(
				"empty-custom-loop",
				{ questions: [{ id: "only", question: "Which one?", options: [{ label: "a" }, { label: "b" }] }] },
				undefined,
				undefined,
				neverResolvingContext() as never,
			),
		).rejects.toThrow(/empty free-text answer 3 times/);

		// Bounded: the same question is asked a small, fixed number of times.
		expect(questions.length).toBeLessThanOrEqual(3);
		expect(new Set(questions).size).toBe(1);
		expect(settlements.every(s => (s as { kind?: string }).kind === "invalid")).toBe(true);
	});
});

describe("multi-question exhaustion", () => {
	it("keeps answers collected before the exhausted question", async () => {
		let call = 0;
		const source: AskAnswerSource = {
			awaitAnswer: async () => undefined,
			awaitAnswerRequest: () => {
				call += 1;
				// First question answers normally; the second is stuck on whitespace.
				const value = call === 1 ? "a" : "   ";
				return Promise.resolve({
					source: "remote" as const,
					interaction: { kind: "value" as const, value },
					settle: async () => ({ kind: "resolved_without_commit" as const }),
				});
			},
		};
		const tool = new AskTool(createSession({ getAskAnswerSource: () => source }));

		const result = await tool.execute(
			"multi-exhaustion",
			{
				questions: [
					{ id: "first", question: "First?", options: [{ label: "a" }, { label: "b" }] },
					{ id: "second", question: "Second?", options: [{ label: "c" }, { label: "d" }] },
				],
			},
			undefined,
			undefined,
			neverResolvingContext() as never,
		);

		// #5001 review B2.3: the first answer survives instead of being discarded.
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("a");
		expect(text).toMatch(/Stopped at question 2 of 2/);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["a"]);
	});
});
