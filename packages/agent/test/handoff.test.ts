import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage, AgentTool } from "@gajae-code/agent-core";
import { AUTO_HANDOFF_THRESHOLD_FOCUS, generateHandoff, renderHandoffPrompt } from "@gajae-code/agent-core/compaction";
import type { AssistantMessage, Model, ToolCall } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { Effort } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function getTestModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected built-in anthropic model to exist");
	}
	return model;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("handoff helpers", () => {
	test("renders custom focus into the handoff prompt", () => {
		const rendered = renderHandoffPrompt("preserve failing test name");
		expect(rendered).toContain("Write a handoff document");
		expect(rendered).toContain("Additional focus: preserve failing test name");
	});

	test("exports the threshold focus text used by auto-handoff", () => {
		expect(AUTO_HANDOFF_THRESHOLD_FOCUS).toBe(
			"Threshold-triggered maintenance: preserve critical implementation state and immediate next actions.",
		);
	});

	test("generates handoff with the live cache prefix and tool use disabled", async () => {
		const strayToolCall: ToolCall = { type: "toolCall", id: "call_1", name: "read", arguments: {} };
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(
				createAssistantMessage([
					{ type: "text", text: "## Goal\nContinue" },
					strayToolCall,
					{ type: "text", text: "## Next Steps\n1. Run the focused test" },
				]),
			);
		const model = getTestModel();
		const systemPrompt = ["Live system prompt"];
		const tools: AgentTool[] = [];
		const messages: AgentMessage[] = [
			{ role: "user", content: "start work", timestamp: 1 },
			createAssistantMessage([{ type: "text", text: "started" }]),
		];

		const document = await generateHandoff(messages, model, "test-key", {
			systemPrompt,
			tools,
			customInstructions: "preserve failing test name",
			initiatorOverride: "agent",
			metadata: { session: "handoff-test" },
		});

		expect(document).toBe("## Goal\nContinue\n## Next Steps\n1. Run the focused test");
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
		const call = completeSimpleSpy.mock.calls[0];
		if (!call) throw new Error("Expected completeSimple call");
		const [calledModel, context, options] = call;
		expect(calledModel).toBe(model);
		expect(context.systemPrompt).toBe(systemPrompt);
		expect(context.tools).toBe(tools);
		expect(context.messages[0]).toMatchObject({ role: "user", content: "start work" });
		expect(options).toMatchObject({
			apiKey: "test-key",
			reasoning: Effort.High,
			toolChoice: "none",
			initiatorOverride: "agent",
			metadata: { session: "handoff-test" },
		});

		const lastMessage = context.messages[context.messages.length - 1];
		if (!lastMessage) throw new Error("Expected trailing handoff prompt message");
		if (lastMessage.role !== "user") {
			throw new Error("Expected trailing handoff prompt to be a user message");
		}
		expect(lastMessage.attribution).toBe("agent");
		if (!Array.isArray(lastMessage.content)) {
			throw new Error("Expected handoff prompt content blocks");
		}
		const promptBlock = lastMessage.content[0];
		if (promptBlock?.type !== "text") {
			throw new Error("Expected text handoff prompt block");
		}
		expect(promptBlock.text).toContain("Write a handoff document");
		expect(promptBlock.text).toContain("Additional focus: preserve failing test name");
	});

	test("appends the prompt extension without replacing the base handoff prompt", () => {
		const base = renderHandoffPrompt();
		const rendered = renderHandoffPrompt(undefined, "Prefer terse bullet summaries.");

		// The immutable safety/structure core is preserved verbatim.
		expect(rendered).toContain("Write a handoff document");
		expect(rendered).toContain("Output ONLY the handoff document.");
		expect(rendered).toContain("Use exactly this structure:");
		// Every required base section still renders, in order.
		for (const section of ["## Goal", "## Progress", "## Key Decisions", "## Next Steps"]) {
			expect(rendered).toContain(section);
		}
		// The extension is additive and framed as a supplement — never a replacement —
		// and is appended AFTER the required structure, not spliced in or replacing it.
		expect(rendered).toContain("Prefer terse bullet summaries.");
		expect(rendered).toContain("supplements — does not replace");
		expect(rendered.indexOf("Prefer terse bullet summaries.")).toBeGreaterThan(rendered.indexOf("## Next Steps"));
		expect(rendered.length).toBeGreaterThan(base.length);
	});

	test("renders both custom focus and the prompt extension together", () => {
		const rendered = renderHandoffPrompt("preserve failing test name", "Prefer terse bullet summaries.");

		expect(rendered).toContain("Additional focus: preserve failing test name");
		expect(rendered).toContain("Prefer terse bullet summaries.");
		expect(rendered).toContain("Write a handoff document");
		// The extension block is appended before the custom-focus block.
		expect(rendered.indexOf("Prefer terse bullet summaries.")).toBeLessThan(
			rendered.indexOf("Additional focus: preserve failing test name"),
		);
	});

	test("returns the immutable base prompt when neither focus nor extension is provided", () => {
		const base = renderHandoffPrompt();

		expect(renderHandoffPrompt(undefined, undefined)).toBe(base);
		expect(base).not.toContain("supplements — does not replace");
		expect(base).not.toContain("Additional focus:");
	});

	test("threads the prompt extension through generateHandoff", async () => {
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "## Goal\nContinue" }]));

		await generateHandoff([{ role: "user", content: "start", timestamp: 1 }], getTestModel(), "test-key", {
			systemPrompt: ["Live system prompt"],
			tools: [],
			customInstructions: "preserve failing test name",
			promptExtension: "Prefer terse bullet summaries.",
			initiatorOverride: "agent",
		});

		const call = completeSimpleSpy.mock.calls[0];
		if (!call) throw new Error("Expected completeSimple call");
		const [, context] = call;
		const lastMessage = context.messages[context.messages.length - 1];
		if (lastMessage?.role !== "user" || !Array.isArray(lastMessage.content)) {
			throw new Error("Expected trailing handoff prompt user message");
		}
		const promptBlock = lastMessage.content[0];
		if (promptBlock?.type !== "text") throw new Error("Expected text handoff prompt block");
		expect(promptBlock.text).toContain("Prefer terse bullet summaries.");
		expect(promptBlock.text).toContain("Additional focus: preserve failing test name");
		expect(promptBlock.text).toContain("Write a handoff document");
	});
});
