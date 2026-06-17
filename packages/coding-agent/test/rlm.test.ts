import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai/models";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createEmptyNotebook, readNotebookDocument } from "@gajae-code/coding-agent/edit/notebook";
import type { CustomTool } from "@gajae-code/coding-agent/extensibility/custom-tools/types";
import {
	ensureRlmSessionDir,
	generateRlmSessionId,
	isValidRlmSessionId,
	resolveRlmArtifactPaths,
} from "@gajae-code/coding-agent/rlm/artifacts";
import { loadRlmDataContext } from "@gajae-code/coding-agent/rlm/data-context";
import { buildRlmGoalObjective, createRlmPreset } from "@gajae-code/coding-agent/rlm/index";
import { RlmNotebookWriter } from "@gajae-code/coding-agent/rlm/notebook";
import {
	assertRlmToolAllowlist,
	buildRlmSystemPrompt,
	isRlmToolAllowed,
	RLM_READ_ONLY_BASH_PREFIXES,
	RLM_RESEARCH_PROMPT,
	RLM_TOOL_ALLOWLIST,
} from "@gajae-code/coding-agent/rlm/preset";
import { synthesizeRlmReport } from "@gajae-code/coding-agent/rlm/report";
import type { RlmCellResult } from "@gajae-code/coding-agent/rlm/types";
import { type CreateAgentSessionOptions, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	checkBashAllowedPrefixes,
	normalizeReadOnlyBashCommand,
} from "@gajae-code/coding-agent/tools/bash-allowed-prefixes";
import * as z from "zod/v4";
import { createAssistantMessage } from "./helpers/agent-session-setup";

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-test-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const okCell = (output: string): RlmCellResult => ({
	output,
	exitCode: 0,
	cancelled: false,
	truncated: false,
	displayOutputs: [],
});

describe("rlm artifacts", () => {
	test("validates session ids", () => {
		expect(isValidRlmSessionId("2026-06-16-abc")).toBe(true);
		expect(isValidRlmSessionId("../escape")).toBe(false);
		expect(isValidRlmSessionId("has space")).toBe(false);
		expect(isValidRlmSessionId("")).toBe(false);
	});

	test("generated ids are valid and unique", () => {
		const a = generateRlmSessionId();
		const b = generateRlmSessionId();
		expect(isValidRlmSessionId(a)).toBe(true);
		expect(a).not.toBe(b);
	});

	test("resolves artifact paths under .gjc/rlm/<id> and creates the dir", async () => {
		const paths = resolveRlmArtifactPaths(tmp, "sess1");
		expect(paths.dir).toBe(path.join(tmp, ".gjc", "rlm", "sess1"));
		expect(paths.notebookPath.endsWith(path.join("sess1", "notebook.ipynb"))).toBe(true);
		expect(paths.reportPath.endsWith("report.md")).toBe(true);
		await ensureRlmSessionDir(paths);
		expect((await fs.stat(paths.dir)).isDirectory()).toBe(true);
	});

	test("rejects invalid session ids when resolving paths", () => {
		expect(() => resolveRlmArtifactPaths(tmp, "../escape")).toThrow();
	});
});

describe("rlm notebook writer", () => {
	test("appends code cells live with valid, re-readable .ipynb", async () => {
		const nbPath = path.join(tmp, "notebook.ipynb");
		const writer = new RlmNotebookWriter(nbPath);
		await writer.appendMarkdown("# Investigation");
		await writer.appendCode("x = 1\nprint(x)", okCell("1\n"));
		await writer.flush();

		const doc = await readNotebookDocument(nbPath, nbPath);
		expect(doc.cells.length).toBe(2);
		expect(doc.cells[0].cell_type).toBe("markdown");
		expect(doc.cells[1].cell_type).toBe("code");
		expect(doc.cells[1].execution_count).toBe(1);
		const outputs = doc.cells[1].outputs as Array<Record<string, unknown>>;
		expect(outputs[0].output_type).toBe("stream");
		expect(outputs[0].name).toBe("stdout");
	});

	test("error cells route to stderr stream and do not corrupt the notebook", async () => {
		const nbPath = path.join(tmp, "notebook.ipynb");
		const writer = new RlmNotebookWriter(nbPath);
		await writer.appendCode("boom()", {
			output: "NameError\n",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			displayOutputs: [],
		});
		await writer.flush();
		const doc = await readNotebookDocument(nbPath, nbPath);
		const outputs = doc.cells[0].outputs as Array<Record<string, unknown>>;
		expect(outputs[0].name).toBe("stderr");
	});

	test("concurrent appends serialize without corrupting the file", async () => {
		const nbPath = path.join(tmp, "notebook.ipynb");
		const writer = new RlmNotebookWriter(nbPath);
		await Promise.all([
			writer.appendCode("a=1", okCell("a\n")),
			writer.appendCode("b=2", okCell("b\n")),
			writer.appendCode("c=3", okCell("c\n")),
		]);
		await writer.flush();
		const doc = await readNotebookDocument(nbPath, nbPath);
		expect(doc.cells.length).toBe(3);
		const counts = doc.cells.map(cell => cell.execution_count);
		expect(new Set(counts).size).toBe(3);
	});
});

describe("rlm report synthesis", () => {
	test("produces deterministic markdown with cells, outputs, and summary", () => {
		const notebook = createEmptyNotebook();
		notebook.cells.push({ cell_type: "markdown", source: "intro" });
		notebook.cells.push({
			cell_type: "code",
			source: "print('hi')",
			execution_count: 1,
			outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }],
		});
		const report = synthesizeRlmReport({
			title: "My Research",
			summary: "Found something.",
			notebook,
			dataPath: "/tmp/DATA.md",
			generatedAt: "2026-01-01T00:00:00Z",
		});
		expect(report).toContain("# My Research");
		expect(report).toContain("Cells executed: 1");
		expect(report).toContain("Data context: /tmp/DATA.md");
		expect(report).toContain("## Summary");
		expect(report).toContain("Found something.");
		expect(report).toContain("### Cell 1");
		expect(report).toContain("print('hi')");
		expect(report).toContain("hi");
		// Deterministic: same input → same output.
		expect(
			synthesizeRlmReport({
				title: "My Research",
				summary: "Found something.",
				notebook,
				dataPath: "/tmp/DATA.md",
				generatedAt: "2026-01-01T00:00:00Z",
			}),
		).toBe(report);
	});
});

describe("rlm data context", () => {
	test("auto-loads project-root DATA.md when present", async () => {
		await Bun.write(path.join(tmp, "DATA.md"), "rows: 100");
		const ctx = await loadRlmDataContext(tmp, undefined);
		expect(ctx?.content).toBe("rows: 100");
		expect(ctx?.path).toBe(path.join(tmp, "DATA.md"));
	});

	test("returns null when no DATA.md and no flag", async () => {
		expect(await loadRlmDataContext(tmp, undefined)).toBeNull();
	});

	test("--data overrides and is required to exist", async () => {
		await Bun.write(path.join(tmp, "custom.md"), "custom data");
		const ctx = await loadRlmDataContext(tmp, "custom.md");
		expect(ctx?.content).toBe("custom data");
		await expect(loadRlmDataContext(tmp, "missing.md")).rejects.toThrow(/not found/);
	});
});

describe("rlm preset tool boundary", () => {
	test("allowlist membership is exact, case-insensitive, and excludes mutation tools", () => {
		expect(RLM_TOOL_ALLOWLIST).toEqual([
			"python",
			"read",
			"web_search",
			"search_tool_bm25",
			"bash",
			"goal",
			"complete_research",
		]);
		expect(isRlmToolAllowed("python")).toBe(true);
		expect(isRlmToolAllowed("READ")).toBe(true);
		expect(isRlmToolAllowed("web_search")).toBe(true);
		expect(isRlmToolAllowed("search_tool_bm25")).toBe(true);
		expect(isRlmToolAllowed("bash")).toBe(true);
		expect(isRlmToolAllowed("goal")).toBe(true);
		expect(isRlmToolAllowed("complete_research")).toBe(true);
		expect(isRlmToolAllowed("edit")).toBe(false);
		expect(isRlmToolAllowed("write")).toBe(false);
	});

	test("assertRlmToolAllowlist passes for the RLM surface", () => {
		expect(() =>
			assertRlmToolAllowlist([
				"python",
				"read",
				"web_search",
				"search_tool_bm25",
				"bash",
				"goal",
				"complete_research",
			]),
		).not.toThrow();
	});

	test("assertRlmToolAllowlist throws naming leaked mutation tools", () => {
		expect(() => assertRlmToolAllowlist(["python", "bash", "edit"])).toThrow(/edit/);
		expect(() => assertRlmToolAllowlist(["write"])).toThrow(/write/);
	});

	test("RLM preset wires read-only bash and required goal mode into session options", async () => {
		const pythonTool = {
			name: "python",
			label: "Python",
			description: "Execute Python",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		} satisfies CustomTool;
		const dataContext = { path: "/tmp/DATA.md", content: "schema: x" };
		const preset = createRlmPreset({ dataContext, pythonTool, objective: "Analyze the schema" });
		const options: CreateAgentSessionOptions = {
			customTools: [{ ...pythonTool, name: "bash" }],
			extensions: [(() => undefined) as never],
		};
		const settings = Settings.isolated({ "goal.enabled": false, "recipe.enabled": true });

		preset.applyOptions(options, settings);

		expect(options.toolNames).toEqual(["read", "web_search", "search_tool_bm25", "bash", "goal"]);
		expect(options.customTools).toEqual([pythonTool]);
		expect(options.skills).toEqual([]);
		expect(options.extensions).toEqual([]);
		expect(options.additionalExtensionPaths).toEqual([]);
		expect(options.preloadedExtensions).toBeUndefined();
		expect(options.rules).toEqual([]);
		expect(options.disableExtensionDiscovery).toBe(true);
		expect(options.bashAllowedPrefixes).toEqual([...RLM_READ_ONLY_BASH_PREFIXES]);
		expect(options.bashRestrictionProfile).toBe("read-only");
		expect(options.goalToolAllowedOps).toEqual(["get", "complete"]);
		expect(options.discoverableToolAllowedNames).toEqual([]);
		expect(settings.get("goal.enabled")).toBe(true);
		expect(settings.get("goal.continuationModes")).toEqual(["interactive"]);
		expect(settings.get("tools.discoveryMode")).toBe("all");
		expect(settings.get("recipe.enabled")).toBe(false);
		if (typeof options.systemPrompt !== "function")
			throw new Error("RLM preset must install a system prompt builder");
		expect(options.systemPrompt(["base"]).join("\n")).toContain("schema: x");

		let activeToolNames = ["python", "read", "web_search", "search_tool_bm25", "bash"];
		let createdObjective: string | undefined;
		let goalState: unknown;
		await preset.onSessionCreated?.({
			getActiveToolNames: () => activeToolNames,
			setActiveToolsByName: async (toolNames: string[]) => {
				activeToolNames = toolNames;
			},
			getGoalModeState: () => goalState,
			goalRuntime: {
				createGoal: async ({ objective }: { objective: string }) => {
					createdObjective = objective;
					goalState = {
						enabled: true,
						mode: "active",
						goal: {
							id: "goal-1",
							objective,
							status: "active",
							tokensUsed: 0,
							timeUsedSeconds: 0,
							createdAt: 0,
							updatedAt: 0,
						},
					};
					return goalState;
				},
				resumeGoal: async () => goalState,
			},
		} as never);
		expect(createdObjective).toBe("Analyze the schema");
		expect(activeToolNames).toEqual(["python", "read", "web_search", "search_tool_bm25", "bash", "goal"]);

		await expect(
			preset.onSessionCreated?.({
				getActiveToolNames: () => ["python", "read", "bash", "goal", "edit"],
				setActiveToolsByName: async () => {},
				getGoalModeState: () => goalState,
				goalRuntime: { createGoal: async () => goalState, resumeGoal: async () => goalState },
			} as never),
		).rejects.toThrow(/edit/);
	});

	test("RLM goal objective is derived from the user prompt before data fallback", () => {
		expect(
			buildRlmGoalObjective({
				messages: ["", "Analyze DATA.md", "Find outliers"],
				dataContext: { path: "/tmp/DATA.md", content: "schema" },
			}),
		).toBe("Analyze DATA.md\n\nFind outliers");
		expect(
			buildRlmGoalObjective({ messages: [], dataContext: { path: "/tmp/DATA.md", content: "schema" } }),
		).toContain("/tmp/DATA.md");
		expect(buildRlmGoalObjective({ messages: [], dataContext: null })).toContain("RLM research session");
	});

	test("RLM sessions start with an active goal and cannot stop cleanly before goal completion", async () => {
		const pythonTool = {
			name: "python",
			label: "Python",
			description: "Execute Python",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		} satisfies CustomTool;
		const settings = Settings.isolated({ "goal.enabled": false, "recipe.enabled": true, "todo.reminders": false });
		const preset = createRlmPreset({ dataContext: null, pythonTool, objective: "Compute the RLM result" });
		const options: CreateAgentSessionOptions = {
			cwd: tmp,
			agentDir: tmp,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		};
		preset.applyOptions(options, settings);
		const { session } = await createAgentSession(options);
		try {
			await preset.onSessionCreated?.(session);
			expect(session.getGoalModeState()?.goal).toMatchObject({
				objective: "Compute the RLM result",
				status: "active",
			});
			expect(session.getActiveToolNames().sort()).toEqual([
				"bash",
				"goal",
				"python",
				"read",
				"search_tool_bm25",
				"web_search",
			]);

			const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
			const assistantMessage = { ...createAssistantMessage("Done without the goal tool."), timestamp: 101 };
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			for (let i = 0; i < 20; i++) await Promise.resolve();
			await session.waitForIdle();
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(
				session.agent.state.messages.some(
					message =>
						message.role === "developer" && JSON.stringify(message.content).includes("active and uncleared"),
				),
			).toBe(true);

			const goalTool = session.getToolByName("goal");
			if (!goalTool) throw new Error("RLM session must register the goal tool");
			await expect(goalTool.execute("call-drop", { op: "drop" } as never)).rejects.toThrow(
				"only allows goal operations: get, complete",
			);
			await goalTool.execute("call-complete", { op: "complete" } as never);
			expect(session.getGoalModeState()?.goal.status).toBe("complete");

			const completedMessage = { ...createAssistantMessage("Done after the goal tool."), timestamp: 102 };
			session.agent.emitExternalEvent({ type: "message_end", message: completedMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [completedMessage] });
			for (let i = 0; i < 20; i++) await Promise.resolve();
			await session.waitForIdle();
			expect(continueSpy).toHaveBeenCalledTimes(1);
		} finally {
			await session.dispose();
		}
	});

	test("RLM read-only bash allows simple inspections and blocks unsafe shell shapes", () => {
		expect(
			checkBashAllowedPrefixes("rg sales DATA.md", RLM_READ_ONLY_BASH_PREFIXES, { profile: "read-only" }),
		).toEqual({
			allowed: true,
		});
		expect(checkBashAllowedPrefixes("ls -la .gjc", RLM_READ_ONLY_BASH_PREFIXES, { profile: "read-only" })).toEqual({
			allowed: true,
		});
		expect(
			checkBashAllowedPrefixes("rg foo | head", RLM_READ_ONLY_BASH_PREFIXES, { profile: "read-only" }).allowed,
		).toBe(false);
		expect(
			checkBashAllowedPrefixes("rg --pre ./script foo", RLM_READ_ONLY_BASH_PREFIXES, { profile: "read-only" })
				.allowed,
		).toBe(false);
		expect(
			checkBashAllowedPrefixes("tree -o out.txt", RLM_READ_ONLY_BASH_PREFIXES, { profile: "read-only" }).allowed,
		).toBe(false);
		expect(
			checkBashAllowedPrefixes("cat DATA.md", RLM_READ_ONLY_BASH_PREFIXES, { profile: "read-only" }).allowed,
		).toBe(false);
	});

	test("RLM read-only bash normalizes through absolute binaries and quoted args", () => {
		const normalized = normalizeReadOnlyBashCommand("ls 'dir name'");
		expect(normalized).toContain("/ls'");
		expect(normalized).toContain("'dir name'");
		expect(normalizeReadOnlyBashCommand("rg foo | head")).toBeUndefined();
	});

	test("system prompt builder appends the research prompt and data context", () => {
		const noData = buildRlmSystemPrompt(null)(["base"]);
		expect(noData[0]).toBe("base");
		expect(noData).toContain(RLM_RESEARCH_PROMPT);

		const withData = buildRlmSystemPrompt({ path: "/tmp/DATA.md", content: "schema: x" })(["base"]);
		expect(withData.some(block => block.includes("schema: x") && block.includes("/tmp/DATA.md"))).toBe(true);
	});
});
