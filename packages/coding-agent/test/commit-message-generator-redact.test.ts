import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { generateCommitMessage } from "../src/utils/commit-message-generator";

const CANARY = "sk-ant-GJCCANARY-commitmsg-9f3c1d7a2b6e4c8f";
const NPM_CANARY = "npm_GJCCANARYCOMMITMSG9F3C1D7A2B6E4C8F";
const GITHUB_CANARY = "github_pat_11ABCDEFG0hijklmnopq_RSTUVWXYZ0123456789abcdefghij";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: { provider: string; id: string }) {
	return {
		getModelRole() {
			return `${model.provider}/${model.id}`;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function promptText(call: unknown): string {
	const messages = (call as { messages?: Array<{ content?: unknown }> } | undefined)?.messages;
	const content = messages?.[0]?.content;
	return typeof content === "string" ? content : "";
}

describe("generateCommitMessage credential text", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("redacts a provider key in the request and the returned message", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: `chore(config): document key ${CANARY}` }],
		} as never);

		const message = await generateCommitMessage(
			`diff --git a/config.env b/config.env\n+ANTHROPIC_API_KEY=${CANARY}\n`,
			{ getAvailable: () => [model], getApiKey: async () => "test-key" } as never,
			createSettings(model),
		);

		const sent = promptText(completeSimpleMock.mock.calls[0]?.[1]);
		expect(sent).not.toContain(CANARY);
		expect(sent).toContain("ANTHROPIC_API_KEY=[REDACTED_SECRET]");
		expect(message).not.toContain(CANARY);
		expect(message).toContain("[REDACTED_TOKEN]");
	});

	it("redacts an npm token in the request and the echoed message", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: `chore: note ${NPM_CANARY}.` }],
		} as never);

		const message = await generateCommitMessage(
			`diff --git a/config.env b/config.env\n+NPM_TOKEN=${NPM_CANARY}\n+export const answer = 42;\n`,
			{ getAvailable: () => [model], getApiKey: async () => "test-key" } as never,
			createSettings(model),
		);

		const sent = promptText(completeSimpleMock.mock.calls[0]?.[1]);
		expect(sent).not.toContain(NPM_CANARY);
		expect(sent).toContain("«redacted-npm-token»");
		expect(sent).toContain("export const answer = 42");
		expect(message).toBe("chore: note «redacted-npm-token»");
	});

	it("redacts a github fine-grained token in the request and the echoed message", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: `chore: note ${GITHUB_CANARY}.` }],
		} as never);

		const message = await generateCommitMessage(
			`diff --git a/config.env b/config.env\n+token=${GITHUB_CANARY}\n+export const answer = 42;\n`,
			{ getAvailable: () => [model], getApiKey: async () => "test-key" } as never,
			createSettings(model),
		);

		const sent = promptText(completeSimpleMock.mock.calls[0]?.[1]);
		expect(sent).not.toContain(GITHUB_CANARY);
		expect(sent).toContain("[REDACTED_TOKEN]");
		expect(sent).toContain("export const answer = 42");
		expect(message).not.toContain(GITHUB_CANARY);
		expect(message).toBe("chore: note [REDACTED_TOKEN]");
	});

	it("still allows an ordinary source diff through commit message generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "feat: export the answer." }],
		} as never);

		const message = await generateCommitMessage(
			"diff --git a/src/app.ts b/src/app.ts\n+export const answer = 42;\n",
			{ getAvailable: () => [model], getApiKey: async () => "test-key" } as never,
			createSettings(model),
		);

		const sent = promptText(completeSimpleMock.mock.calls[0]?.[1]);
		expect(sent).toContain("export const answer = 42");
		expect(sent).not.toContain("[REDACTED");
		expect(message).toBe("feat: export the answer");
	});

	it("still allows a localhost URL in the diff", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "docs: note the local health url" }],
		} as never);

		const message = await generateCommitMessage(
			"diff --git a/README.md b/README.md\n+See http://127.0.0.1:8080/health\n",
			{ getAvailable: () => [model], getApiKey: async () => "test-key" } as never,
			createSettings(model),
		);

		const sent = promptText(completeSimpleMock.mock.calls[0]?.[1]);
		expect(sent).toContain("http://127.0.0.1:8080/health");
		expect(message).toBe("docs: note the local health url");
	});
});
