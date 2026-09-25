import { afterAll, describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { executePythonWithKernel } from "@gajae-code/coding-agent/eval/py/executor";
import { PythonKernel } from "@gajae-code/coding-agent/eval/py/kernel";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@gajae-code/coding-agent/eval/py/tool-bridge";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { resolvePythonIntegrationGate } from "@gajae-code/coding-agent/tools/implementations";
import { TempDir } from "@gajae-code/utils";

const SHOULD_RUN = resolvePythonIntegrationGate(Bun.env);

describe.skipIf(!SHOULD_RUN)("Python eval output() helper (issue #5936)", () => {
	afterAll(async () => {
		await disposePyToolBridge();
	});

	it("reads agent output via tool.read() with agent:// paths", async () => {
		using tempDir = TempDir.createSync("@python-eval-output-");
		const mockOutput = "# Agent output\nLine 2\nLine 3\nLine 4";
		const readTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: { type: "object" },
			async execute(_id: string, args: unknown): Promise<AgentToolResult> {
				const { path } = args as { path: string };
				if (path === "agent://test_0") {
					return { content: [{ type: "text", text: mockOutput }] };
				}
				throw new Error(`Unexpected path: ${path}`);
			},
		} as unknown as AgentTool;
		const toolSession = {
			getToolByName: (name: string) => (name === "read" ? readTool : undefined),
		} as unknown as ToolSession;
		const bridge = await ensurePyToolBridge();
		const capability = crypto.randomUUID();
		const sessionId = "python-eval-output-test";
		const unregister = registerPyToolBridge(sessionId, capability, { toolSession });
		const kernel = await PythonKernel.start({
			cwd: tempDir.path(),
			env: {
				PI_TOOL_BRIDGE_URL: bridge.url,
				PI_TOOL_BRIDGE_CAPABILITY: capability,
				PI_TOOL_BRIDGE_SESSION: sessionId,
			},
		});
		try {
			const result = await executePythonWithKernel(kernel, 'result = output("test_0")\nprint(result)');
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Agent output");
			expect(result.output).toContain("Line 2");
		} finally {
			unregister();
			await kernel.shutdown();
		}
	});

	it("returns json format with metadata", async () => {
		using tempDir = TempDir.createSync("@python-eval-output-json-");
		const mockOutput = "output line 1\noutput line 2";
		const readTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: { type: "object" },
			async execute(_id: string, args: unknown): Promise<AgentToolResult> {
				const { path } = args as { path: string };
				if (path === "agent://test_0") {
					return { content: [{ type: "text", text: mockOutput }] };
				}
				throw new Error(`Unexpected path: ${path}`);
			},
		} as unknown as AgentTool;
		const toolSession = {
			getToolByName: (name: string) => (name === "read" ? readTool : undefined),
		} as unknown as ToolSession;
		const bridge = await ensurePyToolBridge();
		const capability = crypto.randomUUID();
		const sessionId = "python-eval-output-json-test";
		const unregister = registerPyToolBridge(sessionId, capability, { toolSession });
		const kernel = await PythonKernel.start({
			cwd: tempDir.path(),
			env: {
				PI_TOOL_BRIDGE_URL: bridge.url,
				PI_TOOL_BRIDGE_CAPABILITY: capability,
				PI_TOOL_BRIDGE_SESSION: sessionId,
			},
		});
		try {
			const result = await executePythonWithKernel(
				kernel,
				`import json
result = output("test_0", format="json")
print(json.dumps(result))`,
			);
			expect(result.exitCode).toBe(0);
			const output = result.output.trim();
			const parsed = JSON.parse(output);
			expect(parsed).toHaveProperty("id", "test_0");
			expect(parsed).toHaveProperty("content", mockOutput);
			expect(parsed).toHaveProperty("line_count", 2);
		} finally {
			unregister();
			await kernel.shutdown();
		}
	});

	it("handles multiple IDs", async () => {
		using tempDir = TempDir.createSync("@python-eval-output-multi-");
		const outputs: Record<string, string> = {
			"agent://output_0": "First output",
			"agent://output_1": "Second output",
		};
		const readTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: { type: "object" },
			async execute(_id: string, args: unknown): Promise<AgentToolResult> {
				const { path } = args as { path: string };
				if (path in outputs) {
					return { content: [{ type: "text", text: outputs[path] }] };
				}
				throw new Error(`Unexpected path: ${path}`);
			},
		} as unknown as AgentTool;
		const toolSession = {
			getToolByName: (name: string) => (name === "read" ? readTool : undefined),
		} as unknown as ToolSession;
		const bridge = await ensurePyToolBridge();
		const capability = crypto.randomUUID();
		const sessionId = "python-eval-output-multi-test";
		const unregister = registerPyToolBridge(sessionId, capability, { toolSession });
		const kernel = await PythonKernel.start({
			cwd: tempDir.path(),
			env: {
				PI_TOOL_BRIDGE_URL: bridge.url,
				PI_TOOL_BRIDGE_CAPABILITY: capability,
				PI_TOOL_BRIDGE_SESSION: sessionId,
			},
		});
		try {
			const result = await executePythonWithKernel(
				kernel,
				`import json
result = output("output_0", "output_1")
for item in result:
    print(f"{item['id']}: {item['content']}")`,
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("output_0: First output");
			expect(result.output).toContain("output_1: Second output");
		} finally {
			unregister();
			await kernel.shutdown();
		}
	});
});
