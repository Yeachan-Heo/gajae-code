import { describe, expect, test } from "bun:test";
import { HindsightSessionState } from "../src/hindsight/state";
import { pruneSupersededMaintenanceReminders } from "../src/session/volatile-context-pruning";

const config = {
	autoRetain: true,
	autoRecall: false,
	retainEveryNTurns: 1,
	retainOverlapTurns: 0,
	retainMode: "full-session",
	retainContext: "",
	recallBudget: "low",
	recallMaxTokens: 100,
	recallTypes: [],
	recallPromptPreamble: "",
	recallContextTurns: 0,
	recallMaxQueryChars: 100,
	mentalModelsEnabled: false,
	debug: false,
} as never;

function custom(id: string, customType: string, content: string) {
	return {
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		type: "custom_message" as const,
		customType,
		content,
		display: false,
	};
}

describe("ctx-cache adversarial hindsight and reminder behavior", () => {
	test("coalesces an agent_end storm into one active retain and drops an empty full-session delta", async () => {
		let release!: () => void;
		let calls = 0;
		const client = {
			retain: async () => {
				calls++;
				await new Promise<void>(resolve => {
					release = resolve;
				});
			},
		} as never;
		const entries = [
			{ type: "message", message: { role: "user", content: "user" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "assistant" }] } },
		];
		const session = { sessionManager: { getEntries: () => entries }, getHindsightSessionState: () => state } as never;
		const state = new HindsightSessionState({
			sessionId: "storm",
			client,
			bankId: "bank",
			config,
			session,
			missionsSet: new Set(),
		});
		const first = state.maybeRetainOnAgentEnd();
		const second = state.maybeRetainOnAgentEnd();
		const third = state.maybeRetainOnAgentEnd();
		await Bun.sleep(0);
		expect(calls).toBe(1);
		release();
		await Promise.all([first, second, third]);
		expect(calls).toBe(1);
		expect(await state.retainSession([])).toBe(false);
	});

	test("re-injects recalled context when content flaps and only retires known interleaved reminder kinds", () => {
		const state = new HindsightSessionState({
			sessionId: "recall",
			client: {} as never,
			bankId: "bank",
			config,
			session: {} as never,
			missionsSet: new Set(),
		});
		state.lastRecallSnippet = "A";
		expect(state.getRecallSnippetForInjection()).toBe("A");
		expect(state.getRecallSnippetForInjection()).toBe("A");
		expect(state.markRecallSnippetInjected("A")).toBe(true);
		expect(state.getRecallSnippetForInjection()).toBeUndefined();
		state.lastRecallSnippet = "B";
		expect(state.getRecallSnippetForInjection()).toBe("B");
		expect(state.markRecallSnippetInjected("B")).toBe(true);
		state.lastRecallSnippet = "A";
		expect(state.getRecallSnippetForInjection()).toBe("A");

		const entries = [
			custom("old", "resolve-reminder", "preview one"),
			custom("hostile", "resolve-reminder:latest", "must remain"),
			custom("other", "goal-reminder", "ordinary context"),
			custom("new", "resolve-reminder", "preview two"),
		];
		const result = pruneSupersededMaintenanceReminders(entries);
		expect(result.changed.map(entry => entry.id)).toEqual(["old"]);
		expect(entries[1]?.content).toBe("must remain");
		expect(entries[2]?.content).toBe("ordinary context");
	});
});
