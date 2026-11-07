import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai/core";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { PromptRevisions } from "../src/prompt-revisions";

const answer: AssistantMessage = {
	role: "assistant",
	api: "openai-completions",
	provider: "prompt-revisions-fixture",
	model: "fixture",
	timestamp: 1_700_000_000_000,
	content: [{ type: "text", text: "answer" }],
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

/** Real SDK tree; entries are a few milliseconds apart so timestamps order them like real turns. */
function tree() {
	const manager = SessionManager.inMemory("/tmp/prompt-revisions");
	const append = async (write: () => string) => {
		await Bun.sleep(2);
		return write();
	};
	return {
		manager,
		bookkeeping: () => append(() => manager.appendCustomEntry("workflow-intent-diff", {})),
		prompt: (text: string) =>
			append(() => manager.appendMessage({ role: "user", content: text, timestamp: Date.now() })),
		answer: () => append(() => manager.appendMessage(answer)),
		modelChange: () => append(() => manager.appendModelChange("fixture/other")),
	};
}

describe("prompt revisions", () => {
	test("groups answered edits across SDK bookkeeping and leaves out unanswered siblings", async () => {
		const t = tree();
		const root = await t.bookkeeping();
		const first = await t.prompt("first");
		const firstAnswer = await t.answer();
		const second = await t.prompt("second");
		const secondAnswer = await t.answer();
		t.manager.branch(firstAnswer);
		await t.modelChange();
		const secondEdit = await t.prompt("second edited");
		const secondEditAnswer = await t.answer();
		t.manager.branch(root);
		await t.bookkeeping();
		const firstEdit = await t.prompt("first edited");
		await t.answer();
		t.manager.branch(root);
		const pending = await t.prompt("first pending");

		const revisions = new PromptRevisions();
		expect(revisions.revision(t.manager, first)).toEqual({ index: 0, count: 2, next: firstEdit });
		expect(revisions.revision(t.manager, firstEdit)).toEqual({ index: 1, count: 2, previous: first });
		expect(revisions.revision(t.manager, second)).toEqual({ index: 0, count: 2, next: secondEdit });
		expect(revisions.revision(t.manager, secondEdit)).toEqual({ index: 1, count: 2, previous: second });
		// The prompt being answered is shown as the newest revision of its own position.
		expect(revisions.revision(t.manager, pending)).toEqual({ index: 2, count: 3, previous: firstEdit });

		// Its first answer is a leaf move from a prompt, so cached revisions of its siblings refresh.
		await t.answer();
		expect(revisions.revision(t.manager, first)).toEqual({ index: 0, count: 3, next: firstEdit });
		expect(revisions.revision(t.manager, firstEdit)).toEqual({ index: 1, count: 3, previous: first, next: pending });

		// Without a remembered leaf, a revision opens at its newest continuation.
		expect(revisions.target(t.manager, first)).toBe(secondEditAnswer);
		t.manager.branch(secondAnswer);
		revisions.remember(t.manager, [first, second]);
		expect(revisions.target(t.manager, first)).toBe(secondAnswer);
		expect(revisions.target(t.manager, secondEdit)).toBe(secondEditAnswer);
	});

	test("a single prompt or an unknown entry has no revisions", async () => {
		const t = tree();
		const only = await t.prompt("only");
		await t.answer();
		const revisions = new PromptRevisions();
		expect(revisions.revision(t.manager, only)).toBeUndefined();
		revisions.remember(t.manager, [only]);

		const other = tree();
		const prompt = await other.prompt("other");
		expect(revisions.revision(other.manager, prompt)).toBeUndefined();
		expect(revisions.revision(other.manager, "missing-entry")).toBeUndefined();
		expect(revisions.target(other.manager, prompt)).toBe(prompt);
	});
});
