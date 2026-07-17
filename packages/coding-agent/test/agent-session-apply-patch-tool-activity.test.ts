import { describe, expect, test } from "bun:test";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { Settings } from "../src/config/settings";
import { EditTool } from "../src/edit";
import { projectToolSummary } from "../src/sdk/bus/index";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";

function model(): Model<"openai-responses"> {
	return {
		id: "test",
		name: "test",
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

function editToolSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

describe("apply_patch tool activity resolution", () => {
	test("resolves the EditTool by wire name and projects only safe apply_patch summaries", () => {
		const editTool = new EditTool(editToolSession());
		const agent = new Agent({ initialState: { model: model(), systemPrompt: [], tools: [editTool], messages: [] } });
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			toolRegistry: new Map([[editTool.name, editTool as AgentTool]]),
		});

		expect(editTool.name).toBe("edit");
		expect(editTool.customWireName).toBe("apply_patch");
		expect(session.getToolByName("edit")).toBe(editTool as AgentTool);
		expect(session.getToolByName("apply_patch")).toBe(editTool as AgentTool);

		const resolved = session.getToolByName("apply_patch");
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/safe.ts",
			"@@",
			"-const token = 'SECRET=never';",
			"+const token = 'updated';",
			"*** End Patch",
		].join("\n");
		const verboseArgsSummary = projectToolSummary(resolved, "args", { input: patch });
		const leanArgsSummary = undefined;
		expect(verboseArgsSummary).toBe("src/safe.ts, 1 edit");
		expect(verboseArgsSummary).not.toContain("SECRET=never");
		expect(leanArgsSummary).toBeUndefined();
		expect(verboseArgsSummary).not.toBe(leanArgsSummary);
		expect(
			projectToolSummary(resolved, "result", {
				details: { perFileResults: [{ path: "src/safe.ts", diff: "SECRET=never" }] },
			}),
		).toBe("applied, 1 file");
		expect(
			projectToolSummary(resolved, "args", {
				input: ["*** Begin Patch", "*** Delete File: https://secret.example/token", "*** End Patch"].join("\n"),
			}),
		).toBeUndefined();
	});
});
