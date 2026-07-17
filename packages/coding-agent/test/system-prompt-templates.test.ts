import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentTool, INTENT_FIELD } from "@gajae-code/agent-core";
import {
	buildSystemPrompt,
	buildSystemPromptToolMetadata,
	buildVolatileProjectContext,
} from "@gajae-code/coding-agent/system-prompt";
import { prompt } from "@gajae-code/utils";
import Handlebars from "handlebars";
import * as z from "zod/v4";
import { getBundledAgent } from "../src/task/agents";

const systemPromptsDir = path.resolve(import.meta.dir, "../src/prompts/system");

const baseRenderContext: prompt.TemplateContext = {
	TASK_TOOL_NAME: "task",
	ARGUMENTS: "alpha beta",
	agent: "You are a delegated worker",
	agentsMdSearch: { files: [] },
	appendPrompt: "Appendix instructions",
	arguments: "alpha beta",
	base: "Base system prompt",
	content: "Rule content",
	context: "Background context",
	contextFile: "/tmp/context.md",
	contextFiles: [{ path: "/tmp/context/a.md", content: "Alpha context" }],
	customPrompt: "Custom prompt body",
	cwd: "/tmp/pi-issue-147",
	date: "2026-02-24",
	dateTime: "2026-02-24T12:00:00Z",
	editToolName: "edit",
	environment: [{ label: "OS", value: "Darwin" }],
	finalPlanFilePath: "local://PLAN_FINAL.md",
	intentField: INTENT_FIELD,
	intentTracing: true,
	iterative: true,
	maxRetries: 3,
	modifiedFiles: ["packages/coding-agent/src/config/prompt-templates.ts"],
	name: "rs-no-unwrap",
	path: "packages/coding-agent/src/config/prompt-templates.ts",
	planContent: "1. Read code\n2. Add tests",
	planExists: true,
	planFilePath: "local://PLAN.md",
	readFiles: ["packages/coding-agent/src/prompts/system/custom-system-prompt.md"],
	repeatToolDescriptions: true,
	reentry: false,
	request: "Create an agent to review prompt templates",
	retryCount: 1,
	rules: [{ name: "rs-no-unwrap", description: "Avoid unwrap", globs: ["**/*.rs"] }],
	systemPromptCustomization: "System customization",
	toolInfo: [{ name: "read", label: "Read", description: "Reads files" }],
	toolRefs: {
		read: "read",
		search: "search",
		find: "find",
		edit: "edit",
		irc: "irc",
		job: "job",
		task: "task",
		subagent: "subagent",
		web_search: "web_search",
		todo_write: "todo_write",
		search_tool_bm25: "search_tool_bm25",
		lsp: "lsp",
		ast_grep: "ast_grep",
		ast_edit: "ast_edit",
		grep: "grep",
		write: "write",
	},
	tools: ["read", "search", "find", "edit", "task", "subagent", "job", "irc", "web_search", "todo_write"],
	worktree: "/tmp/pi-issue-147",
	writeToolName: "write",
};

async function loadSystemPromptTemplates(): Promise<Map<string, string>> {
	const templates = new Map<string, string>();
	const glob = new Bun.Glob("*.md");

	for await (const fileName of glob.scan({ cwd: systemPromptsDir, onlyFiles: true })) {
		const templatePath = path.join(systemPromptsDir, fileName);
		templates.set(fileName, await Bun.file(templatePath).text());
	}

	return templates;
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) return 0;
	return text.split(needle).length - 1;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-system-prompt-"));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("executor red-team block renders only for ultragoal completion QA assignments", () => {
	const executor = getBundledAgent("executor");
	expect(executor).toBeDefined();

	const ordinary = prompt.render(executor!.systemPrompt, { ultragoalRedTeam: false });
	expect(ordinary).not.toContain("<ultragoal_red_team_mode>");

	const redTeam = prompt.render(executor!.systemPrompt, { ultragoalRedTeam: true });
	expect(redTeam).toContain("<ultragoal_red_team_mode>");
	expect(redTeam).toContain("executorQa");
});

describe("system Handlebars prompt templates", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("parses and compiles every system template", async () => {
		const templates = await loadSystemPromptTemplates();
		expect(templates.size).toBeGreaterThan(0);

		for (const [fileName, template] of templates) {
			expect(() => Handlebars.parse(template), `Failed parsing ${fileName}`).not.toThrow();
			expect(() => Handlebars.compile(template), `Failed compiling ${fileName}`).not.toThrow();
		}
	});

	test("custom-system-prompt renders only project context", async () => {
		const templatePath = path.join(systemPromptsDir, "custom-system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const contextOnly = prompt.render(template, {
			...baseRenderContext,
			contextFiles: [{ path: "a.txt", content: "A" }],
		});
		expect(contextOnly).toContain("<project>");
		expect(contextOnly).toContain("## Context");
		expect(contextOnly).not.toContain("Version Control");

		const empty = prompt.render(template, { ...baseRenderContext, contextFiles: [] });
		expect(empty).not.toContain("<project>");
	});

	test("subagent system owns shared context while user prompt only owns assignment", async () => {
		const systemTemplate = await Bun.file(path.join(systemPromptsDir, "subagent-system-prompt.md")).text();
		const userTemplate = await Bun.file(path.join(systemPromptsDir, "subagent-user-prompt.md")).text();

		const subagentSystem = prompt.render(systemTemplate, {
			...baseRenderContext,
			context: "Shared task background",
			agent: "You are a task agent.",
		});
		const subagentUser = prompt.render(userTemplate, {
			...baseRenderContext,
			context: "Shared task background",
			assignment: "Do the task.",
		});

		expect(subagentSystem).toContain("[CONTEXT]\nShared task background\n[/CONTEXT]");
		expect(subagentSystem).toContain("[ROLE]");
		expect(subagentUser).toContain("Complete the assignment below, thoroughly:");
		expect(subagentUser).toContain("Do the task.");
		expect(subagentUser).not.toContain("[CONTEXT]");
		expect(subagentUser).not.toContain("Shared task background");
	});

	test("system-prompt trims workflow/soul blocks for subagents while retaining safety contracts", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const full = prompt.render(template, { ...baseRenderContext, subagent: false });
		const sub = prompt.render(template, { ...baseRenderContext, subagent: true });

		// Top-level agent keeps concise routing and soul blocks.
		expect(full).toContain("<gjc-runtime>");
		expect(full).toContain("<routing>");
		expect(full).toContain("<soul>");
		expect(full).not.toContain("<role-agent-surface>");

		// Subagent base prompt drops runtime routing and soul.
		expect(sub).not.toContain("<gjc-runtime>");
		expect(sub).not.toContain("<routing>");
		expect(sub).not.toContain("<soul>");

		// Required repo/tool/completion constraints remain for subagents.
		expect(sub).toContain("<completion-contract>");
		expect(sub).toContain("<repo-safety>");
		expect(sub).toContain("<tools>");
		expect(sub).toContain("<authority>");

		// No shared-cache-identity assertion is introduced (Phase 2, gated on prefix factoring).
		expect(sub.toLowerCase()).not.toContain("cache identity");
		expect(sub.toLowerCase()).not.toContain("shared cache");

		// Measured byte reduction target: >= 25%.
		const fullBytes = Buffer.byteLength(full);
		const subBytes = Buffer.byteLength(sub);
		const reduction = 1 - subBytes / fullBytes;
		expect(reduction).toBeGreaterThanOrEqual(0.25);
	});
	test("system-prompt omits obsolete MCP discovery plumbing", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = prompt.render(template, {
			...baseRenderContext,
			mcpDiscoveryMode: true,
			mcpDiscoveryServerSummaries: ["github (2 tools)"],
		});

		expect(rendered).not.toContain("<discovery>");
		expect(rendered).not.toContain("Discoverable MCP servers");
	});

	test("system-prompt renders tool-discovery block with discoverable tools when active", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = prompt.render(template, {
			...baseRenderContext,
			toolDiscoveryActive: true,
			discoverableTools: [{ name: "browser", summary: "Control a headless browser" }],
		});

		expect(rendered).toContain("<tool-discovery>");
		expect(rendered).toContain("`search_tool_bm25`");
		expect(rendered).toContain("Discoverable capabilities include browser automation");
		expect(rendered).not.toContain("Discoverable tools:");
		expect(rendered).not.toContain("Control a headless browser");

		const disabled = prompt.render(template, { ...baseRenderContext, toolDiscoveryActive: false });
		expect(disabled).not.toContain("<tool-discovery>");
	});

	test("system-prompt renders detached subagent semantics", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = prompt.render(template, baseRenderContext);

		expect(rendered).toContain("<detached-subagents>");
		expect(rendered).toContain("Normal `task` launches return immediately as detached background subagents");
		expect(rendered).toContain("its await/cancel doctrine is authoritative");
		expect(rendered).not.toContain("never cancel just because an await timed out");
	});

	test("system-prompt bounds long-form media ingestion before fallback drafting", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = prompt.render(template, baseRenderContext);

		expect(rendered).toContain("<media-ingestion>");
		expect(rendered).toContain("For YouTube, podcasts, webinars, screen recordings");
		expect(rendered).toContain('Do not let "recover the full transcript" silently replace');
		expect(rendered).toContain("transcript/caption retrieval fails after two attempts");
		expect(rendered).toContain("produce an evidence-scoped draft");
		expect(rendered).toContain("Evidence used");
		expect(rendered).toContain("Limitations");
		expect(rendered).toContain("Never spend an extended turn repeatedly trying to ingest the same blocked video");
	});

	test("system-prompt distinguishes informational questions from explicit implementation requests", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = prompt.render(template, baseRenderContext);

		expect(countOccurrences(rendered, "Informational questions are answer-only/read-only")).toBe(1);
		expect(rendered).toContain("unless the user explicitly requests a change, command, or execution");
		expect(rendered).toContain("Clear, low-risk implementation requests use direct tools");
		expect(rendered).toContain("Vague requirements use `/skill:deep-interview`");
	});

	test("keeps system and project as separate ordered blocks; volatile facts excluded from stable prefix", async () => {
		await withTempDir(async dir => {
			const workspaceTree = {
				rootPath: dir,
				rendered: ".\n  - src/        1m",
				truncated: false,
				totalLines: 2,
				agentsMdFiles: [],
			};
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree,
			});

			expect(systemPrompt).toHaveLength(2);
			expect(systemPrompt[0]).toContain("<completion-contract>");
			expect(systemPrompt[0]).not.toContain("current working directory");
			expect(systemPrompt[1]).toContain("<workstation>");
			// Volatile facts must NOT appear in the stable system prefix anymore.
			expect(systemPrompt[1]).not.toContain("<workspace-tree>");
			expect(systemPrompt[1]).not.toContain("Today is ");
			expect(systemPrompt[1]).not.toContain("current working directory is");

			// They are delivered via the per-turn volatile context instead.
			const volatile = buildVolatileProjectContext({ cwd: dir, workspaceTree });
			expect(volatile).toContain("<workspace-tree>");
			expect(volatile).toContain("Today is ");
			expect(volatile).toContain(`current working directory is '${dir}'.`);
			expect(volatile.indexOf("</workspace-tree>")).toBeLessThan(volatile.indexOf("Today is "));
		});
	});
	test("buildSystemPrompt wires SYSTEM.md customization without replacing the base prompt", async () => {
		await withTempDir(async dir => {
			await fs.mkdir(path.join(dir, ".gjc"), { recursive: true });
			await fs.writeFile(path.join(dir, ".gjc", "SYSTEM.md"), "Project system sentinel.");

			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree: {
					rootPath: dir,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
			});

			expect(systemPrompt).toHaveLength(2);
			expect(systemPrompt[0]).toContain("<gajae-code-system-prompt>");
			expect(systemPrompt[0]).toContain("<soul>");
			expect(systemPrompt[0]).toContain("The Boss’s Orders = Absolute Obedience");
			expect(systemPrompt[0]).toContain("<system-prompt-customization>");
			expect(systemPrompt[0]).toContain("Project system sentinel.");
		});
	});

	test("renders workspace tree in the per-turn volatile context, not the stable project prompt", async () => {
		await withTempDir(async dir => {
			const workspaceTree = {
				rootPath: dir,
				rendered: ".\n  - src/        1m",
				truncated: true,
				totalLines: 2,
				agentsMdFiles: ["packages/coding-agent/AGENTS.md"],
			};
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree,
			});

			const projectPrompt = systemPrompt[1] ?? "";
			// The stable project prompt no longer carries the mtime-sorted tree.
			expect(projectPrompt).not.toContain("<workspace-tree>");

			const volatile = buildVolatileProjectContext({ cwd: dir, workspaceTree });
			expect(volatile).toContain("<workspace-tree>");
			expect(volatile).toContain("Working directory layout (sorted by mtime, recent first; depth ≤ 3):");
			expect(volatile).toContain("(some entries elided to keep the tree short");
		});
	});

	test("buildSystemPrompt deduplicates always-apply rules already present in SYSTEM.md", async () => {
		const duplicateRule = ["Use static imports.", "", "Do not use dynamic loading."].join("\n");
		const distinctRule = "Validate inputs at boundaries.";

		await withTempDir(async dir => {
			const configDir = path.join(dir, ".agent");
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(
				path.join(configDir, "SYSTEM.md"),
				["Project instructions", "", duplicateRule, "", "Trailing note"].join("\n"),
			);

			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: ["read"],
				workspaceTree: {
					rootPath: dir,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				customPrompt: "Custom prompt body",
				alwaysApplyRules: [
					{ name: "no-dynamic-loading", content: duplicateRule, path: "/tmp/no-dynamic-loading.md" },
					{ name: "validate-boundaries", content: distinctRule, path: "/tmp/validate-boundaries.md" },
				],
			});

			const prompt = systemPrompt.join("\n\n");

			expect(countOccurrences(prompt, "Use static imports.")).toBe(1);
			expect(countOccurrences(prompt, "Do not use dynamic loading.")).toBe(1);
			expect(countOccurrences(prompt, distinctRule)).toBe(1);
		});
	});

	test("buildSystemPrompt deduplicates always-apply rules already present in customPrompt", async () => {
		const duplicateRule = ["Keep functions small.", "", "Extract shared helpers on the second use."].join("\n");
		const distinctRule = "Surface failures explicitly to callers.";

		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: {
				rootPath: os.tmpdir(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			customPrompt: ["Custom guidance", "", duplicateRule, "", "More custom guidance"].join("\n"),
			alwaysApplyRules: [
				{ name: "small-functions", content: duplicateRule, path: "/tmp/small-functions.md" },
				{ name: "truthful-failures", content: distinctRule, path: "/tmp/truthful-failures.md" },
			],
		});

		const prompt = systemPrompt.join("\n\n");

		expect(countOccurrences(prompt, "Keep functions small.")).toBe(1);
		expect(countOccurrences(prompt, "Extract shared helpers on the second use.")).toBe(1);
		expect(countOccurrences(prompt, distinctRule)).toBe(1);
	}, 30_000);

	test("buildSystemPromptToolMetadata captures custom wire names", () => {
		const editTool = {
			name: "edit",
			label: "Edit",
			description: "Edits files",
			parameters: z.object({}),
			customWireName: "apply_patch",
			execute: async () => ({ content: [] }),
		} satisfies AgentTool;

		const metadata = buildSystemPromptToolMetadata(new Map([["edit", editTool]]));

		expect(metadata.get("edit")?.wireName).toBe("apply_patch");
	});

	test("buildSystemPrompt references overridden tool wire names", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "search", "find", "edit", "lsp", "bash", "eval"],
			workspaceTree: {
				rootPath: os.tmpdir(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			tools: new Map([
				["read", { label: "Read", description: "Reads files" }],
				["search", { label: "Search", description: "Searches files" }],
				["find", { label: "Find", description: "Finds files" }],
				["edit", { label: "Edit", description: "Edits files", wireName: "apply_patch" }],
				["lsp", { label: "LSP", description: "Queries language servers" }],
				["bash", { label: "Bash", description: "Runs shell commands" }],
				["eval", { label: "Eval", description: "Runs eval cells" }],
			]),
		});

		const promptText = systemPrompt.join("\n\n");

		expect(promptText).toContain("Edit: `apply_patch`");
		expect(promptText).toContain("Surgical text edits → `apply_patch`");
		expect(promptText).not.toContain("Edit: `edit`");
	}, 30_000);

	test("buildSystemPrompt omits CPU info when os.cpus fails", async () => {
		vi.spyOn(os, "cpus").mockImplementation(() => {
			throw new Error("os.cpus() failed");
		});

		const { systemPrompt } = await buildSystemPrompt({
			cwd: os.tmpdir(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: {
				rootPath: os.tmpdir(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const projectPrompt = systemPrompt[1] ?? "";

		const workstation = /<workstation>\n(?<content>[\s\S]*?)\n<\/workstation>/u.exec(projectPrompt)?.groups?.content;
		expect(workstation).toContain("OS:");
		expect(workstation).not.toContain("CPU:");
	}, 30_000);
});
