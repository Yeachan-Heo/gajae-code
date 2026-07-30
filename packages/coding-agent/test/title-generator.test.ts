import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@gajae-code/ai";
import { type Api, getBundledModel, type Model } from "@gajae-code/ai";
import { formatSessionTerminalTitle, generateSessionTitle } from "../src/utils/title-generator";

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

		expect(title).toEqual({ kind: "title", title: "Structured Title" });
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

		expect(title).toEqual({ kind: "title", title: "Text Title" });
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

		expect(title).toEqual({ kind: "title", title: "Budget Title" });
		expect(maxTokens).toBeGreaterThanOrEqual(1024);
	});
	it("classifies unavailable, provider failures, and aborts while forwarding the request signal", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const unavailable = await generateSessionTitle(
			"message",
			{
				getAvailable: () => [],
				getApiKey: async () => "unused",
			} as never,
			createSettings(model),
		);
		expect(unavailable).toEqual({ kind: "unavailable", reason: "no_model" });

		const signal = AbortSignal.abort(new Error("cancelled"));
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "error",
			content: [],
		} as never);
		const failed = await generateSessionTitle(
			"message",
			createRegistry(model),
			createSettings(model),
			undefined,
			undefined,
			undefined,
			signal,
		);
		expect(failed).toEqual({ kind: "failed", reason: "provider_error" });
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ signal });

		const aborted = await generateSessionTitle(
			"message",
			{
				getAvailable: () => [model],
				getApiKey: async () => {
					throw signal.reason;
				},
			} as never,
			createSettings(model),
			undefined,
			undefined,
			undefined,
			signal,
		);
		expect(aborted).toEqual({ kind: "unavailable", reason: "aborted" });
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
