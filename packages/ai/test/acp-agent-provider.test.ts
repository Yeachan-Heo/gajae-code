import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { streamAcpAgent } from "../src/providers/acp-agent";
import {
	ReadResultSchema,
	ReadSuccessSchema,
	ShellResultSchema,
	ShellSuccessSchema,
} from "../src/providers/cursor/gen/agent_pb";
import type { Context, Model, ToolResultMessage } from "../src/types";

const fixturePath = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/fake-acp-agent.ts");

const model: Model<"acp-agent"> = {
	id: "composer-2.5",
	name: "Cursor Composer 2.5 ACP",
	api: "acp-agent",
	provider: "cursor-acp",
	baseUrl: "acp://cursor",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

const context: Context = {
	systemPrompt: ["You are a helpful coding agent."],
	messages: [{ role: "user", content: "Use tools", timestamp: 0 }],
};

function textToolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("ACP agent provider", () => {
	it("initializes Cursor-style ACP agents with parameterized model picker and applies default config options", async () => {
		const result = await streamAcpAgent(model, context, {
			command: "bun",
			args: [fixturePath],
			defaultConfigOptions: {
				model: "composer-2.5",
				fast: "false",
			},
			clientCapabilities: {
				_meta: {
					parameterizedModelPicker: true,
				},
			},
			execHandlers: {
				async read(args) {
					return {
						result: create(ReadResultSchema, {
							result: {
								case: "success",
								value: create(ReadSuccessSchema, {
									path: args.path,
									totalLines: 1,
									fileSize: BigInt("fake-file-content".length),
									truncated: false,
									output: { case: "content", value: "fake-file-content" },
								}),
							},
						}),
						toolResult: textToolResult(args.toolCallId ?? "read", "read", "fake-file-content"),
					};
				},
				async shell(args) {
					return {
						result: create(ShellResultSchema, {
							result: {
								case: "success",
								value: create(ShellSuccessSchema, {
									command: args.command,
									workingDirectory: args.workingDirectory,
									exitCode: 0,
									signal: "",
									stdout: "fake-shell-output",
									stderr: "",
									executionTime: 0,
								}),
							},
						}),
						toolResult: textToolResult(args.toolCallId ?? "shell", "bash", "fake-shell-output"),
					};
				},
			},
		}).result();

		const text = result.content.find(item => item.type === "text")?.text;
		expect(text).toBeDefined();
		const payload = JSON.parse(text ?? "{}");
		expect(payload.initialize.clientCapabilities._meta.parameterizedModelPicker).toBe(true);
		expect(payload.configSets).toContainEqual({
			sessionId: "fake-session",
			configId: "model",
			value: "composer-2.5",
		});
		expect(payload.configSets).toContainEqual({
			sessionId: "fake-session",
			configId: "fast",
			value: "false",
		});
		expect(payload.promptText).toContain("System:\nYou are a helpful coding agent.");
		expect(payload.promptText).toContain("user:\nUse tools");
		expect(payload.readContent).toBe("fake-file-content");
		expect(payload.shellOutput).toBe("fake-shell-output");
	});

	it("accepts bare tool result handler returns for ACP file and terminal requests", async () => {
		const result = await streamAcpAgent(model, context, {
			command: "bun",
			args: [fixturePath],
			defaultConfigOptions: {
				model: "composer-2.5",
				fast: "false",
			},
			execHandlers: {
				async read(args) {
					return textToolResult(args.toolCallId ?? "read", "read", "bare-read-content");
				},
				async shell(args) {
					return textToolResult(args.toolCallId ?? "shell", "bash", "bare-shell-output");
				},
			},
		}).result();

		const text = result.content.find(item => item.type === "text")?.text;
		expect(text).toBeDefined();
		const payload = JSON.parse(text ?? "{}");
		expect(payload.readContent).toBe("bare-read-content");
		expect(payload.shellOutput).toBe("bare-shell-output");
	});
});
