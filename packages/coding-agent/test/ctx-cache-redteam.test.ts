import { describe, expect, test } from "bun:test";
import { HindsightSessionState } from "../src/hindsight/state";
import { pruneSupersededMaintenanceReminders } from "../src/session/volatile-context-pruning";

const configValues = {
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
};
const config = configValues as never;

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
		const retainGate = Promise.withResolvers<void>();
		const client = {
			retain: async () => {
				calls++;
				release = retainGate.resolve;
				await retainGate.promise;
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

	test("ignores a recall completion from the predecessor generation after reset", async () => {
		let resolveRecall!: (response: unknown) => void;
		const recallGate = Promise.withResolvers<unknown>();
		const client = {
			recall: async () => {
				resolveRecall = recallGate.resolve;
				return recallGate.promise;
			},
		} as never;
		const entries = [{ type: "message", message: { role: "user", content: "current user" } }];
		const state = new HindsightSessionState({
			sessionId: "predecessor",
			client,
			bankId: "bank",
			config: { ...configValues, autoRecall: true } as never,
			session: { sessionManager: { getEntries: () => entries } } as never,
			missionsSet: new Set(),
		});

		const recall = state.beforeAgentStartPrompt("current prompt");
		await Bun.sleep(0);
		state.setSessionId("successor");
		state.resetConversationTracking();
		resolveRecall({ results: [{ id: "stale", text: "predecessor memory" }] });

		expect(await recall).toBeUndefined();
		expect(state.sessionId).toBe("successor");
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.lastRecallSnippet).toBeUndefined();
	});

	test("ignores a late auto-retain completion from the predecessor generation after reset", async () => {
		let calls = 0;
		const releaseRetains: Array<() => void> = [];
		const client = {
			retain: async () => {
				calls++;
				const retainGate = Promise.withResolvers<void>();
				releaseRetains.push(retainGate.resolve);
				await retainGate.promise;
			},
		} as never;
		const entries = [
			{ type: "message", message: { role: "user", content: "current user" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "current reply" }] } },
		];
		const state = new HindsightSessionState({
			sessionId: "predecessor",
			client,
			bankId: "bank",
			config: { ...configValues, autoRetain: true } as never,
			session: { sessionManager: { getEntries: () => entries } } as never,
			missionsSet: new Set(),
		});

		const retain = state.maybeRetainOnAgentEnd();
		const stalePending = state.maybeRetainOnAgentEnd();
		await Bun.sleep(0);
		state.setSessionId("successor");
		state.resetConversationTracking();
		releaseRetains[0]?.();

		await Promise.all([retain, stalePending]);
		await Bun.sleep(0);
		releaseRetains[1]?.();
		await Bun.sleep(0);
		expect(state.sessionId).toBe("successor");
		expect(calls).toBe(1);
		expect(state.lastRetainedTurn).toBe(0);
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
