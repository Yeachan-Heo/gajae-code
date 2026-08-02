import { describe, expect, it } from "bun:test";
import {
	Agent,
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
} from "@gajae-code/agent-core";
import { agentLoopContinue } from "@gajae-code/agent-core/agent-loop";
import { AppendOnlyContextManager } from "@gajae-code/agent-core/append-only-context";
import type { Context, Message, Model, SimpleStreamOptions, ToolResultMessage } from "@gajae-code/ai";
import {
	COMPOSER_BASH_POLICY_RECOVERY_PROMPT,
	CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT,
	formatComposerBashPolicyError,
} from "@gajae-code/ai/providers/composer-discipline";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({ path: z.string() });

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function hasText(messages: readonly (AgentMessage | Message)[], text: string): boolean {
	return messages.some(message => {
		if (!("content" in message)) return false;
		if (typeof message.content === "string") return message.content.includes(text);
		return (
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "text" && block.text.includes(text))
		);
	});
}

async function drain(stream: AsyncIterable<unknown> & { result(): Promise<unknown> }): Promise<void> {
	for await (const _event of stream) {
		// consume
	}
	await stream.result();
}

function composerPolicyBlockedBashTool(): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "Bash",
		description: "Runs terminal commands.",
		parameters: bashSchema,
		async execute() {
			return {
				content: [{ type: "text", text: formatComposerBashPolicyError("generic") }],
				isError: true,
			};
		},
	};
}

function failingBashToolWithOutput(text: string): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "Bash",
		description: "Runs terminal commands.",
		parameters: bashSchema,
		async execute() {
			return { content: [{ type: "text", text }], isError: true };
		},
	};
}

function readTool(onExecute?: () => void): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "Read",
		description: "Reads a repository file.",
		parameters: readSchema,
		async execute(_toolCallId, args) {
			onExecute?.();
			return { content: [{ type: "text", text: `read ${args.path}` }] };
		},
	};
}

function cursorComposerModel(model: Model): Model {
	return {
		...model,
		id: "composer-2.5",
		name: "composer-2.5",
		api: "cursor-agent",
		provider: "cursor",
	} as Model;
}

function cursorToolResult(toolName: string, text: string, isError: boolean, toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

type CapturedRequest = { context: Context; options?: SimpleStreamOptions };

describe("Composer bash policy recovery", () => {
	it("keeps generic Composer tools enabled for one policy-recovery turn", async () => {
		let reads = 0;
		let toolChoiceGetterCalls = 0;
		const context: AgentContext = {
			systemPrompt: ["Test"],
			messages: [createUserMessage("Inspect the file and continue.")],
			tools: [composerPolicyBlockedBashTool(), readTool(() => (reads += 1))],
		};
		const mock = createMockModel({
			id: "grok-composer-2.5-fast",
			provider: "grok-build",
			responses: [
				{ content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "cat src/a.ts" } }] },
				{ content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } }] },
				{ content: ["Completed with the dedicated tool."] },
			],
		});
		const requests: CapturedRequest[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice: () => {
				toolChoiceGetterCalls += 1;
				return "required";
			},
		};

		await drain(
			agentLoopContinue(context, config, undefined, (model, requestContext, options) => {
				requests.push({ context: requestContext, options });
				return mock.stream(model, requestContext, options);
			}),
		);

		expect(requests).toHaveLength(3);
		expect(hasText(requests[1]!.context.messages, COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(true);
		expect(requests[1]!.context.tools?.map(tool => tool.name)).toEqual(["bash", "read"]);
		expect(requests[1]!.options?.toolChoice).toBe("auto");
		expect(requests.map(request => request.options?.toolChoice)).toEqual(["required", "auto", "required"]);
		expect(toolChoiceGetterCalls).toBe(2);
		expect(reads).toBe(1);
		expect(hasText(context.messages, COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(false);
	});

	it("keeps the generic recovery prompt out of append-only history and later requests", async () => {
		const appendOnlyContext = new AppendOnlyContextManager();
		const context: AgentContext = {
			systemPrompt: ["Test"],
			messages: [createUserMessage("Inspect the file and continue.")],
			tools: [composerPolicyBlockedBashTool(), readTool()],
		};
		const mock = createMockModel({
			id: "grok-composer-2.5-fast",
			provider: "grok-build",
			responses: [
				{ content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "cat src/a.ts" } }] },
				{ content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } }] },
				{ content: ["Recovered."] },
				{ content: ["Later request completed."] },
			],
		});
		const requests: CapturedRequest[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			appendOnlyContext,
		};
		const capture = (model: Model, requestContext: Context, options?: SimpleStreamOptions) => {
			requests.push({ context: requestContext, options });
			return mock.stream(model, requestContext, options);
		};

		await drain(agentLoopContinue(context, config, undefined, capture));
		context.messages.push(createUserMessage("Handle a later request."));
		await drain(agentLoopContinue(context, config, undefined, capture));

		expect(requests).toHaveLength(4);
		expect(hasText(requests[1]!.context.messages, COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(true);
		expect(hasText(requests[3]!.context.messages, COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(false);
		expect(hasText(appendOnlyContext.log.entries(), COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(false);
		expect(requests[3]!.context.tools?.map(tool => tool.name)).toEqual(["bash", "read"]);
	});

	it("stops after a second generic policy block instead of looping", async () => {
		const context: AgentContext = {
			systemPrompt: ["Test"],
			messages: [createUserMessage("Inspect the file and continue.")],
			tools: [composerPolicyBlockedBashTool()],
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "cat src/a.ts" } }] },
				{ content: [{ type: "toolCall", id: "bash-2", name: "bash", arguments: { command: "cat src/b.ts" } }] },
			],
		});
		const requests: CapturedRequest[] = [];
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		await drain(
			agentLoopContinue(context, config, undefined, (model, requestContext, options) => {
				requests.push({ context: requestContext, options });
				return mock.stream(model, requestContext, options);
			}),
		);

		expect(requests).toHaveLength(2);
		expect(hasText(requests[1]!.context.messages, COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(true);
		expect(
			requests.filter(request => hasText(request.context.messages, COMPOSER_BASH_POLICY_RECOVERY_PROMPT)),
		).toHaveLength(1);
		const lastAssistant = context.messages.findLast(message => message.role === "assistant");
		expect(lastAssistant?.role).toBe("assistant");
		if (lastAssistant?.role === "assistant") {
			expect(lastAssistant.stopReason).toBe("error");
			expect(lastAssistant.errorMessage).toContain("one automatic recovery turn");
		}
	});

	it("does not recover when ordinary Bash failure output merely quotes the policy error", async () => {
		const quotedPolicyError = `Test failure output:\n${formatComposerBashPolicyError("generic")}\nCommand exited with code 1`;
		const context: AgentContext = {
			systemPrompt: ["Test"],
			messages: [createUserMessage("Run the test and report its failure.")],
			tools: [failingBashToolWithOutput(quotedPolicyError)],
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "bun test" } }] },
				{ content: ["The test failed."] },
			],
		});
		const requests: CapturedRequest[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolChoice: "required",
		};

		await drain(
			agentLoopContinue(context, config, undefined, (model, requestContext, options) => {
				requests.push({ context: requestContext, options });
				return mock.stream(model, requestContext, options);
			}),
		);

		expect(requests).toHaveLength(2);
		expect(hasText(requests[1]!.context.messages, COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(false);
		expect(requests[1]!.options?.toolChoice).toBe("required");
	});

	it("continues a Cursor Composer turn once after a provider-side policy block", async () => {
		const mock = createMockModel({
			responses: [{ content: ["first remote turn"] }, { content: ["recovered remote turn"] }],
		});
		const requests: CapturedRequest[] = [];
		const agent = new Agent({
			initialState: {
				model: cursorComposerModel(mock.model),
				systemPrompt: ["Test"],
				tools: [readTool()],
				messages: [],
			},
			convertToLlm: identityConverter,
			cursorOnToolResult: async result => result,
			streamFn: async (model, requestContext, options) => {
				requests.push({ context: requestContext, options });
				if (requests.length === 1) {
					await options?.cursorOnToolResult?.(
						cursorToolResult("bash", formatComposerBashPolicyError("cursor"), true, "bash-1"),
					);
				}
				return mock.stream(model, requestContext, options);
			},
		});

		await agent.prompt("Inspect the file and continue.");

		expect(requests).toHaveLength(2);
		expect(hasText(requests[1]!.context.messages, CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(true);
		expect(requests[1]!.context.tools?.map(tool => tool.name)).toEqual(["read"]);
		expect(requests[1]!.options?.toolChoice).toBe("auto");
		expect(hasText(agent.state.messages, CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(false);
	});

	it("lets a queued user follow-up supersede Cursor's automatic recovery", async () => {
		const mock = createMockModel({
			responses: [{ content: ["first remote turn"] }, { content: ["follow-up handled"] }],
		});
		const requests: CapturedRequest[] = [];
		let agent!: Agent;
		agent = new Agent({
			initialState: { model: cursorComposerModel(mock.model), systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm: identityConverter,
			cursorOnToolResult: async result => result,
			streamFn: async (model, requestContext, options) => {
				requests.push({ context: requestContext, options });
				if (requests.length === 1) {
					await options?.cursorOnToolResult?.(
						cursorToolResult("bash", formatComposerBashPolicyError("cursor"), true, "bash-1"),
					);
					agent.followUp(createUserMessage("Handle this user follow-up now."));
				}
				return mock.stream(model, requestContext, options);
			},
		});

		await agent.prompt("Inspect the file and continue.");

		expect(requests).toHaveLength(2);
		expect(hasText(requests[1]!.context.messages, "Handle this user follow-up now.")).toBe(true);
		expect(hasText(requests[1]!.context.messages, CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(false);
		expect(hasText(agent.state.messages, CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(false);
	});

	it.each([
		"read",
		"search",
		"find",
		"write",
		"delete",
	])("does not add a Cursor continuation when the same remote turn recovers through %s", async toolName => {
		const mock = createMockModel({ responses: [{ content: ["recovered in the remote turn"] }] });
		const requests: CapturedRequest[] = [];
		const agent = new Agent({
			initialState: { model: cursorComposerModel(mock.model), systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm: identityConverter,
			cursorOnToolResult: async result => result,
			streamFn: async (model, requestContext, options) => {
				requests.push({ context: requestContext, options });
				await options?.cursorOnToolResult?.(
					cursorToolResult("bash", formatComposerBashPolicyError("cursor"), true, "bash-1"),
				);
				await options?.cursorOnToolResult?.(cursorToolResult(toolName, "ok", false, `${toolName}-1`));
				return mock.stream(model, requestContext, options);
			},
		});

		await agent.prompt("Inspect the file and continue.");

		expect(requests).toHaveLength(1);
		expect(hasText(agent.state.messages, CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(false);
	});

	it("does not retry a second Cursor Composer policy block", async () => {
		const mock = createMockModel({
			responses: [{ content: ["first remote turn"] }, { content: ["second remote turn"] }],
		});
		const requests: CapturedRequest[] = [];
		const agent = new Agent({
			initialState: { model: cursorComposerModel(mock.model), systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm: identityConverter,
			cursorOnToolResult: async result => result,
			streamFn: async (model, requestContext, options) => {
				requests.push({ context: requestContext, options });
				await options?.cursorOnToolResult?.(
					cursorToolResult("bash", formatComposerBashPolicyError("cursor"), true, `bash-${requests.length}`),
				);
				return mock.stream(model, requestContext, options);
			},
		});

		await agent.prompt("Inspect the file and continue.");

		expect(requests).toHaveLength(2);
		expect(hasText(requests[1]!.context.messages, CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT)).toBe(true);
		expect(
			requests.filter(request => hasText(request.context.messages, CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT)),
		).toHaveLength(1);
	});
});
