import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { applyImport, type BuildImportPreviewOptions, buildImportPreview } from "../src/customization/import";
import { discoverRuntimeSkills } from "../src/extensibility/runtime-skill-discovery";
import { loadSkills } from "../src/extensibility/skills";
import { loadAllMCPConfigs } from "../src/runtime-mcp/config";
import { MCPManager } from "../src/runtime-mcp/manager";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";

type ImportedProduct = "claude-code" | "codex";

const SKILL_NAME = "cross-convention-bundle";
const PROTECTED_SKILL = "ralplan";
const MCP_NAME = "cross-convention-server";
const MCP_SECRET = "cross-convention-secret";
const HOOK_TOOL = "read";
const SKILL_CONTENT = `---
name: ${SKILL_NAME}
description: Cross-convention fixture skill.
---

# Cross-convention fixture

This skill proves canonical runtime consumption.
`;
const PROTECTED_SKILL_CONTENT = `---
name: ${PROTECTED_SKILL}
description: Foreign workflow impostor.
---

# Must never override the bundled workflow.
`;
const MCP_SERVER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "cross-convention", version: "1" }
      }
    }) + "\\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{ name: "lookup", description: "Cross-convention lookup", inputSchema: { type: "object" } }]
      }
    }) + "\\n");
  } else if (message.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "canonical-mcp-consumed" }] }
    }) + "\\n");
  } else if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  }
});
`;

let root: string;
let projectDir: string;
let homeDir: string;
let agentDir: string;
let originalAgentDir: string;
let homeBefore: string[];

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
}

function previewOptions(product: ImportedProduct): BuildImportPreviewOptions {
	return {
		product,
		sourceScope: "project",
		destinationScope: "project",
		collisionPolicy: "skip",
		cwd: projectDir,
		homeDir,
	};
}

function sourceFiles(product: ImportedProduct): {
	skill: string;
	protectedSkill: string;
	hook: string;
	mcp: string;
} {
	if (product === "claude-code") {
		return {
			skill: path.join(projectDir, ".claude", "skills", SKILL_NAME, "SKILL.md"),
			protectedSkill: path.join(projectDir, ".claude", "skills", PROTECTED_SKILL, "SKILL.md"),
			hook: path.join(projectDir, ".claude", "hooks", "pre", `${HOOK_TOOL}.ts`),
			mcp: path.join(projectDir, ".mcp.json"),
		};
	}
	return {
		skill: path.join(projectDir, ".codex", "skills", SKILL_NAME, "SKILL.md"),
		protectedSkill: path.join(projectDir, ".codex", "skills", PROTECTED_SKILL, "SKILL.md"),
		hook: path.join(projectDir, ".codex", "hooks", `pre-${HOOK_TOOL}.ts`),
		mcp: path.join(projectDir, ".codex", "config.toml"),
	};
}

function hookContent(marker: string): string {
	return `export default (api) => api.on("tool_call", async (event) => {
	await Bun.write(${JSON.stringify(marker)}, event.toolName);
});
`;
}

function claudeMcpConfig(): string {
	return JSON.stringify({
		mcpServers: {
			[MCP_NAME]: {
				type: "stdio",
				command: process.execPath,
				args: ["-e", MCP_SERVER_SCRIPT],
				env: { API_KEY: MCP_SECRET },
			},
		},
	});
}

function codexMcpConfig(): string {
	return `[mcp_servers.${MCP_NAME}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", ${JSON.stringify(MCP_SERVER_SCRIPT)}]\nenv = { API_KEY = ${JSON.stringify(MCP_SECRET)} }\n`;
}

async function seedConvention(product: ImportedProduct, marker: string): Promise<void> {
	const files = sourceFiles(product);
	await writeFile(files.skill, SKILL_CONTENT);
	await writeFile(files.protectedSkill, PROTECTED_SKILL_CONTENT);
	await writeFile(files.hook, hookContent(marker));
	await writeFile(files.mcp, product === "claude-code" ? claudeMcpConfig() : codexMcpConfig());
}

async function seedNative(marker: string): Promise<void> {
	await writeFile(path.join(projectDir, ".gjc", "skills", SKILL_NAME, "SKILL.md"), SKILL_CONTENT);
	await writeFile(path.join(projectDir, ".gjc", "hooks", "pre", `${HOOK_TOOL}.ts`), hookContent(marker));
	await writeFile(
		path.join(projectDir, ".gjc", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				[MCP_NAME]: {
					type: "stdio",
					command: process.execPath,
					args: ["-e", MCP_SERVER_SCRIPT],
					env: { API_KEY: MCP_SECRET },
				},
			},
		}),
	);
}

async function removeConvention(product: ImportedProduct): Promise<void> {
	const files = sourceFiles(product);
	await fs.rm(product === "claude-code" ? path.join(projectDir, ".claude") : path.join(projectDir, ".codex"), {
		recursive: true,
		force: true,
	});
	if (product === "claude-code") await fs.rm(files.mcp, { force: true });
}

async function consumeCanonicalBundle(marker: string): Promise<{
	skill: { name: string; description: string; body: string };
	mcp: { toolName: string; text: string };
	hook: string;
}> {
	const runtimeSkills = await discoverRuntimeSkills({
		cwd: projectDir,
		home: homeDir,
		policy: { enabled: true, trustProjectSkills: false, trustUserSkills: true },
	});
	expect(runtimeSkills.candidates.some(candidate => candidate.name === SKILL_NAME)).toBe(false);

	const trustedRuntimeSkills = await discoverRuntimeSkills({
		cwd: projectDir,
		home: homeDir,
		policy: { enabled: true, trustProjectSkills: true, trustUserSkills: true },
	});
	const discoveredSkill = trustedRuntimeSkills.candidates.find(candidate => candidate.name === SKILL_NAME);
	expect(discoveredSkill?.path).toBe(path.join(projectDir, ".gjc", "skills", SKILL_NAME, "SKILL.md"));

	const loadedSkills = await loadSkills({
		cwd: projectDir,
		enabled: true,
		trustProjectSkills: true,
		trustUserSkills: true,
	});
	const loadedSkill = loadedSkills.skills.find(skill => skill.name === SKILL_NAME);
	expect(loadedSkill).toBeDefined();
	const body = await loadedSkill?.loadContent?.();
	expect(body).toContain("canonical runtime consumption");

	const loadedMcp = await loadAllMCPConfigs(projectDir, {
		nativeOnly: true,
		filterExa: false,
		autoloadOnly: true,
	});
	expect(loadedMcp.configs[MCP_NAME]).toMatchObject({ command: process.execPath });
	const manager = new MCPManager(projectDir);
	try {
		const connected = await manager.connectServers(loadedMcp.configs, loadedMcp.sources);
		expect(connected.errors).toEqual(new Map());
		const tool = connected.tools.find(candidate => candidate.name.includes("cross_convention_server_lookup"));
		expect(tool).toBeDefined();
		const toolResult = await tool?.execute("cross-convention-call", {}, undefined, {} as never, undefined);
		const text = (toolResult?.content ?? []).map(content => (content.type === "text" ? content.text : "")).join("\n");
		expect(text).toBe("canonical-mcp-consumed");
		expect(tool?.mcpServerName).toBe(MCP_NAME);
		return {
			skill: { name: loadedSkill!.name, description: loadedSkill!.description, body: body! },
			mcp: { toolName: tool!.name, text },
			hook: await consumeHook(marker),
		};
	} finally {
		await manager.disconnectAll();
	}
}

async function consumeHook(marker: string): Promise<string> {
	const created = await createAgentSession({
		cwd: projectDir,
		agentDir,
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(projectDir),
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMcpAutoload: false,
		enableLsp: false,
		toolNames: ["__none__"],
	});
	try {
		expect(created.session.extensionRunner?.hasHandlers("tool_call")).toBe(true);
		await created.session.extensionRunner?.emitToolCall({
			type: "tool_call",
			toolName: HOOK_TOOL,
			toolCallId: "cross-convention-hook",
			input: {},
		});
		await expect(fs.readFile(marker, "utf8")).resolves.toBe(HOOK_TOOL);
		return await fs.readFile(marker, "utf8");
	} finally {
		await created.session.dispose();
	}
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-issue-4508-"));
	projectDir = path.join(root, "project");
	homeDir = path.join(root, "home");
	agentDir = path.join(root, "agent");
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(homeDir, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	homeBefore = await fs.readdir(homeDir);
	originalAgentDir = getAgentDir();
	setAgentDir(agentDir);
	vi.spyOn(os, "homedir").mockReturnValue(homeDir);
	MCPManager.resetForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	await expect(fs.readdir(homeDir)).resolves.toEqual(homeBefore);
	await fs.rm(root, { recursive: true, force: true });
});

describe("issue #4508 cross-convention canonical fixture", () => {
	for (const convention of ["claude-code", "codex", "native"] as const) {
		test(`${convention} bundle is consumed through canonical .gjc`, async () => {
			const marker = path.join(root, `${convention}-hook-ran`);
			if (convention === "native") {
				await seedNative(marker);
			} else {
				await seedConvention(convention, marker);
				const plan = await buildImportPreview(previewOptions(convention));
				const previewJson = JSON.stringify(plan.preview);
				expect(
					plan.preview.entries.some(entry => entry.surface === "skills" && entry.destinationName === SKILL_NAME),
				).toBe(true);
				expect(
					plan.preview.entries.some(entry => entry.surface === "hooks" && entry.destinationName === "pre/read.ts"),
				).toBe(true);
				expect(
					plan.preview.entries.some(entry => entry.surface === "mcps" && entry.destinationName === MCP_NAME),
				).toBe(true);
				expect(
					plan.preview.entries.find(entry => entry.surface === "skills" && entry.sourceName === PROTECTED_SKILL)
						?.status,
				).toBe("unsupported");
				expect(previewJson).not.toContain(MCP_SECRET);
				expect(previewJson).toContain("env:API_KEY");

				const applied = await applyImport(plan, { cwd: projectDir });
				expect(applied.ok).toBe(true);
				expect(applied.entries.filter(entry => entry.outcome === "imported")).toHaveLength(3);
				expect(
					await fs.readFile(path.join(projectDir, ".gjc", "skills", SKILL_NAME, "SKILL.md"), "utf8"),
				).toContain("x-gjc-imported-from");
				expect(await fs.stat(path.join(projectDir, ".gjc", "hooks", "pre", "read.ts"))).toBeTruthy();
				expect(await fs.stat(path.join(projectDir, ".gjc", "mcp.json"))).toBeTruthy();
				await removeConvention(convention);
			}

			const observed = await consumeCanonicalBundle(marker);
			expect(observed.skill.name).toBe(SKILL_NAME);
			expect(observed.skill.description).toBe("Cross-convention fixture skill.");
			expect(observed.mcp.text).toBe("canonical-mcp-consumed");
			expect(observed.hook).toBe(HOOK_TOOL);
		});
	}
});
