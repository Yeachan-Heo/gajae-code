import { afterAll, describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { executePythonWithKernel } from "@gajae-code/coding-agent/eval/py/executor";
import { PythonKernel } from "@gajae-code/coding-agent/eval/py/kernel";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@gajae-code/coding-agent/eval/py/tool-bridge";
import { resolvePythonIntegrationGate } from "@gajae-code/coding-agent/tools/implementations";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { TempDir } from "@gajae-code/utils";

const SHOULD_RUN = resolvePythonIntegrationGate(Bun.env);

describe.skipIf(!SHOULD_RUN)("Python tool bridge integration", () => {
	afterAll(async () => {
		await disposePyToolBridge();
	});

	it("uses the session capability from the Python prelude to invoke its registered tool", async () => {
		using tempDir = TempDir.createSync("@python-tool-bridge-");
		const calls: unknown[] = [];
		const readTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: { type: "object" },
			async execute(_id: string, args: unknown): Promise<AgentToolResult> {
				calls.push(args);
				return { content: [{ type: "text", text: "file body" }] };
			},
		} as unknown as AgentTool;
		const toolSession = {
			getToolByName: (name: string) => (name === "read" ? readTool : undefined),
		} as unknown as ToolSession;
		const bridge = await ensurePyToolBridge();
		const capability = crypto.randomUUID();
		const sessionId = "python-prelude-session";
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
			const result = await executePythonWithKernel(kernel, 'tool.read({"path": "example.ts"})');
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("file body");
			expect(calls).toEqual([{ path: "example.ts", _i: "py prelude" }]);
		} finally {
			unregister();
			await kernel.shutdown();
		}
	});
});
