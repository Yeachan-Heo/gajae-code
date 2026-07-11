import { describe, expect, it } from "bun:test";
import { streamGoogleGenAI } from "../src/providers/google-shared";
import { collectEvents, createBaseModel, createSseResponse } from "./openai-tool-choice-test-helpers";

type GoogleStreamApi = "google-generative-ai" | "google-vertex";

type CommonCandidateSafetyFinishReason =
	| "SAFETY"
	| "IMAGE_SAFETY"
	| "PROHIBITED_CONTENT"
	| "IMAGE_PROHIBITED_CONTENT"
	| "SPII"
	| "BLOCKLIST"
	| "RECITATION"
	| "IMAGE_RECITATION";
type VertexCandidateSafetyFinishReason = "MODEL_ARMOR";
type CandidateGenericTerminalFinishReason =
	| "MALFORMED_FUNCTION_CALL"
	| "UNEXPECTED_TOOL_CALL"
	| "NO_IMAGE"
	| "IMAGE_OTHER"
	| "OTHER"
	| "FINISH_REASON_UNSPECIFIED"
	| "LANGUAGE";
type CandidateNonTerminalFinishReason = "STOP" | "MAX_TOKENS";
type CommonPromptSafetyBlockReason = "SAFETY" | "IMAGE_SAFETY" | "PROHIBITED_CONTENT" | "BLOCKLIST";
type VertexPromptSafetyBlockReason = "MODEL_ARMOR" | "JAILBREAK";
type PromptGenericTerminalBlockReason = "OTHER" | "BLOCKED_REASON_UNSPECIFIED";

interface CandidateFinishReasonFixtures {
	commonSafety: readonly CommonCandidateSafetyFinishReason[];
	vertexSafety: readonly VertexCandidateSafetyFinishReason[];
	genericTerminal: readonly CandidateGenericTerminalFinishReason[];
	nonTerminal: readonly {
		reason: CandidateNonTerminalFinishReason;
		stopReason: "stop" | "length";
	}[];
}

interface PromptBlockReasonFixtures {
	commonSafety: readonly CommonPromptSafetyBlockReason[];
	vertexSafety: readonly VertexPromptSafetyBlockReason[];
	genericTerminal: readonly PromptGenericTerminalBlockReason[];
}

const candidateFinishReasonFixtures = {
	commonSafety: [
		"SAFETY",
		"IMAGE_SAFETY",
		"PROHIBITED_CONTENT",
		"IMAGE_PROHIBITED_CONTENT",
		"SPII",
		"BLOCKLIST",
		"RECITATION",
		"IMAGE_RECITATION",
	],
	vertexSafety: ["MODEL_ARMOR"],
	genericTerminal: [
		"MALFORMED_FUNCTION_CALL",
		"UNEXPECTED_TOOL_CALL",
		"NO_IMAGE",
		"IMAGE_OTHER",
		"OTHER",
		"FINISH_REASON_UNSPECIFIED",
		"LANGUAGE",
	],
	nonTerminal: [
		{ reason: "STOP", stopReason: "stop" },
		{ reason: "MAX_TOKENS", stopReason: "length" },
	],
} as const satisfies CandidateFinishReasonFixtures;

const promptBlockReasonFixtures = {
	commonSafety: ["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"],
	vertexSafety: ["MODEL_ARMOR", "JAILBREAK"],
	genericTerminal: ["OTHER", "BLOCKED_REASON_UNSPECIFIED"],
} as const satisfies PromptBlockReasonFixtures;

async function streamGoogleResponse(response: unknown | unknown[], api: GoogleStreamApi = "google-generative-ai") {
	const model = createBaseModel(api);
	const stream = streamGoogleGenAI({
		model,
		api,
		options: undefined,
		prepare: () => ({
			params: { model: model.id, contents: [] },
			url: "https://google.example.test/stream",
			headers: {},
			fetch: async () => createSseResponse(Array.isArray(response) ? response : [response]),
		}),
	});

	await collectEvents(stream);
	return stream.result();
}

describe("Google safety stops", () => {
	it("classifies the exhaustive candidate finish-reason partition", async () => {
		for (const finishReason of candidateFinishReasonFixtures.commonSafety) {
			const result = await streamGoogleResponse({ candidates: [{ finishReason }] });
			expect(result.errorKind).toBe("provider_safety_stop");
			expect(result.stopReason).toBe("error");
		}

		for (const finishReason of candidateFinishReasonFixtures.vertexSafety) {
			const result = await streamGoogleResponse({ candidates: [{ finishReason }] }, "google-vertex");
			expect(result.errorKind).toBe("provider_safety_stop");
			expect(result.stopReason).toBe("error");
		}

		for (const finishReason of candidateFinishReasonFixtures.genericTerminal) {
			const result = await streamGoogleResponse({ candidates: [{ finishReason }] });
			expect(result.errorKind).toBeUndefined();
			expect(result.stopReason).toBe("error");
		}

		for (const { reason, stopReason } of candidateFinishReasonFixtures.nonTerminal) {
			const result = await streamGoogleResponse({ candidates: [{ finishReason: reason }] });
			expect(result.errorKind).toBeUndefined();
			expect(result.stopReason).toBe(stopReason);
		}
	});

	it("classifies the exhaustive prompt block-reason partition", async () => {
		for (const blockReason of promptBlockReasonFixtures.commonSafety) {
			const result = await streamGoogleResponse({ promptFeedback: { blockReason } });
			expect(result.errorKind).toBe("provider_safety_stop");
			expect(result.stopReason).toBe("error");
		}

		for (const blockReason of promptBlockReasonFixtures.vertexSafety) {
			const result = await streamGoogleResponse({ promptFeedback: { blockReason } }, "google-vertex");
			expect(result.errorKind).toBe("provider_safety_stop");
			expect(result.stopReason).toBe("error");
		}

		for (const blockReason of promptBlockReasonFixtures.genericTerminal) {
			const result = await streamGoogleResponse({ promptFeedback: { blockReason } });
			expect(result.errorKind).toBeUndefined();
			expect(result.stopReason).toBe("error");
		}
	});
	it("keeps candidate-only and prompt-only safety values in separate domains", async () => {
		const promptOnlyCandidate = await streamGoogleResponse(
			{ candidates: [{ finishReason: "JAILBREAK" }] },
			"google-vertex",
		);
		expect(promptOnlyCandidate.errorKind).toBeUndefined();
		expect(promptOnlyCandidate.stopReason).toBe("error");

		for (const blockReason of ["SPII", "RECITATION"] as const) {
			const candidateOnlyPrompt = await streamGoogleResponse({ promptFeedback: { blockReason } }, "google-vertex");
			expect(candidateOnlyPrompt.errorKind).toBeUndefined();
			expect(candidateOnlyPrompt.stopReason).toBe("error");
		}
	});
	it("keeps candidate and prompt safety signals terminal and sticky", async () => {
		const candidateSafety = await streamGoogleResponse([
			{ candidates: [{ finishReason: "SAFETY" }] },
			{ candidates: [{ finishReason: "STOP" }] },
		]);
		expect(candidateSafety.errorKind).toBe("provider_safety_stop");
		expect(candidateSafety.stopReason).toBe("error");

		const promptSafety = await streamGoogleResponse(
			[{ promptFeedback: { blockReason: "MODEL_ARMOR" } }, { candidates: [{ finishReason: "STOP" }] }],
			"google-vertex",
		);
		expect(promptSafety.errorKind).toBe("provider_safety_stop");
		expect(promptSafety.stopReason).toBe("error");

		const simultaneousPromptSafety = await streamGoogleResponse(
			{
				candidates: [{ finishReason: "STOP" }],
				promptFeedback: { blockReason: "JAILBREAK" },
			},
			"google-vertex",
		);
		expect(simultaneousPromptSafety.errorKind).toBe("provider_safety_stop");
		expect(simultaneousPromptSafety.stopReason).toBe("error");
	});

	it("keeps a safety stop instead of promoting a safety-finished tool call to toolUse", async () => {
		const result = await streamGoogleResponse({
			candidates: [
				{
					content: { parts: [{ functionCall: { name: "read", args: { path: "README.md" } } }] },
					finishReason: "SAFETY",
				},
			],
		});

		expect(result.content.some(block => block.type === "toolCall")).toBe(true);
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.stopReason).toBe("error");
	});

	it("keeps a generic terminal error instead of promoting its tool call to toolUse", async () => {
		const result = await streamGoogleResponse({
			candidates: [
				{
					content: { parts: [{ functionCall: { name: "read", args: { path: "README.md" } } }] },
					finishReason: "MALFORMED_FUNCTION_CALL",
				},
			],
		});

		expect(result.content.some(block => block.type === "toolCall")).toBe(true);
		expect(result.errorKind).toBeUndefined();
		expect(result.stopReason).toBe("error");
	});
});
