import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, logger, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { Settings } from "../src/config/settings";
import { applyImport, type BuildImportPreviewOptions, buildImportPreview } from "../src/customization/import";
import { discoverRuntimeSkills } from "../src/extensibility/runtime-skill-discovery";
import { loadSkills, resetActiveSkillsForTests } from "../src/extensibility/skills";
import { MCPManager } from "../src/runtime-mcp/manager";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";

type ImportedProduct = "claude-code" | "codex";

const SKILL_NAME = "cross-convention-bundle";
const PROTECTED_SKILL = "ralplan";
const MCP_NAME = "cross-convention-server";
const MCP_SECRET = "cross-convention-secret";
const HOOK_TOOL = "read";
const READ_TARGET = "fixture-target.txt";
/** User-scope definition surfaces that an import must never create. */
const USER_DEFINITION_SURFACES = new Set(["agents", "commands", "hooks", "mcp.json", "prompts", "skills"]);
/**
 * Declared connection window for the fixture server. Discovery only blocks
 * session start for the declared window (capped by the manager's ceiling), and a
 * server with no declared window gets the 250ms floor — far too short to spawn a
 * runtime and complete an MCP handshake.
 */
const MCP_TIMEOUT_MS = 10_000;
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
	const credentialPresent = process.env.API_KEY === ${JSON.stringify(MCP_SECRET)};
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
	  result: { content: [{ type: "text", text: credentialPresent ? "canonical-mcp-consumed" : "missing-imported-secret" }] }
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

function claudeMcpConfig(script: string = MCP_SERVER_SCRIPT): string {
	return JSON.stringify({
		mcpServers: {
			[MCP_NAME]: {
				type: "stdio",
				command: process.execPath,
				args: ["-e", script],
				env: { API_KEY: MCP_SECRET },
				timeout: MCP_TIMEOUT_MS,
			},
		},
	});
}

function codexMcpConfig(script: string = MCP_SERVER_SCRIPT): string {
	return `[mcp_servers.${MCP_NAME}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", ${JSON.stringify(script)}]\nenv = { API_KEY = ${JSON.stringify(MCP_SECRET)} }\ntool_timeout_sec = ${MCP_TIMEOUT_MS / 1000}\n`;
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
					timeout: MCP_TIMEOUT_MS,
				},
			},
		}),
	);
}

async function seedCollisionBundle(marker: string): Promise<void> {
	await writeFile(
		path.join(projectDir, ".gjc", "skills", SKILL_NAME, "SKILL.md"),
		SKILL_CONTENT.replace("canonical runtime consumption", "pre-existing native authority"),
	);
	await writeFile(path.join(projectDir, ".gjc", "hooks", "pre", `${HOOK_TOOL}.ts`), hookContent(marker));
	await writeFile(
		path.join(projectDir, ".gjc", "mcp.json"),
		JSON.stringify({ mcpServers: { [MCP_NAME]: { type: "stdio", command: "native-collision" } } }),
	);
}

async function makeForeignHookDistinct(product: ImportedProduct, marker: string): Promise<void> {
	const files = sourceFiles(product);
	await fs.writeFile(
		files.skill,
		SKILL_CONTENT.replace("canonical runtime consumption", "foreign skill must stay inactive"),
		"utf8",
	);
	await fs.writeFile(files.hook, hookContent(marker), "utf8");
	const foreignMcpScript = MCP_SERVER_SCRIPT.replace("canonical-mcp-consumed", "foreign-mcp-consumed");
	await fs.writeFile(
		files.mcp,
		product === "claude-code" ? claudeMcpConfig(foreignMcpScript) : codexMcpConfig(foreignMcpScript),
		"utf8",
	);
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
	const untrustedLoadedSkills = await loadSkills({
		cwd: projectDir,
		enabled: true,
		trustProjectSkills: false,
		trustUserSkills: true,
	});
	expect(untrustedLoadedSkills.skills.some(skill => skill.name === SKILL_NAME)).toBe(false);

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
	expect(loadedSkill?.filePath).toBe(path.join(projectDir, ".gjc", "skills", SKILL_NAME, "SKILL.md"));
	const body = await loadedSkill?.loadContent?.();
	expect(body).toContain("canonical runtime consumption");
	expect(body).not.toContain("foreign skill must stay inactive");

	const created = await createAgentSession({
		cwd: projectDir,
		agentDir,
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(projectDir),
		skills: loadedSkills.skills,
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMcpAutoload: true,
		enableLsp: false,
		toolNames: [HOOK_TOOL],
	});
	try {
		const tool = created.session.agent.state.tools.find(candidate =>
			candidate.name.includes("cross_convention_server_lookup"),
		);
		expect(tool).toBeDefined();
		const toolResult = await tool?.execute("cross-convention-call", {}, undefined, {} as never, undefined);
		const text = (toolResult?.content ?? []).map(content => (content.type === "text" ? content.text : "")).join("\n");
		expect(text).toBe("canonical-mcp-consumed");
		const readTool = created.session.agent.state.tools.find(candidate => candidate.name === HOOK_TOOL);
		expect(readTool).toBeDefined();
		await readTool?.execute(
			"cross-convention-read",
			{ path: path.join(projectDir, READ_TARGET) },
			undefined,
			undefined as never,
			undefined,
		);
		await expect(fs.readFile(marker, "utf8")).resolves.toBe(HOOK_TOOL);
		return {
			skill: { name: loadedSkill!.name, description: loadedSkill!.description, body: body! },
			mcp: { toolName: tool!.name, text },
			hook: await fs.readFile(marker, "utf8"),
		};
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
	await writeFile(path.join(projectDir, READ_TARGET), "cross-convention read target\n");
	homeBefore = await fs.readdir(homeDir);
	originalAgentDir = getAgentDir();
	vi.spyOn(os, "homedir").mockReturnValue(homeDir);
	setAgentDir(agentDir);
	logger.setTransports({ console: false, file: path.join(agentDir, "gjc-test.log") });
	MCPManager.resetForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetActiveSkillsForTests();
	setAgentDir(originalAgentDir);
	// A session may write ordinary runtime state (logs, caches) under the user
	// config root; the fixture's contract is that no imported DEFINITION ever
	// lands in the user scope, and that nothing else appears in the home directory.
	const homeEntries = await fs.readdir(homeDir);
	expect(homeEntries.filter(entry => entry !== ".gjc")).toEqual(homeBefore);
	const userConfigEntries = await fs.readdir(path.join(homeDir, ".gjc")).catch(() => [] as string[]);
	expect(userConfigEntries.filter(entry => USER_DEFINITION_SURFACES.has(entry))).toEqual([]);
	await safeRm(root, { recursive: true, force: true });
});

describe("issue #4508 cross-convention canonical fixture", () => {
	for (const convention of ["claude-code", "codex", "native"] as const) {
		test(`${convention} bundle is consumed through canonical .gjc`, async () => {
			const marker = path.join(root, `${convention}-hook-ran`);
			const foreignMarker = path.join(root, `${convention}-foreign-hook-ran`);
			if (convention === "native") {
				await seedNative(marker);
			} else {
				await seedConvention(convention, marker);
				await seedCollisionBundle(path.join(root, `${convention}-collision-hook-ran`));
				const collisionPlan = await buildImportPreview(previewOptions(convention));
				expect(collisionPlan.preview.entries.filter(entry => entry.status === "conflict")).toHaveLength(3);
				const collisionResult = await applyImport(collisionPlan, { cwd: projectDir });
				expect(collisionResult.ok).toBe(true);
				expect(collisionResult.entries.filter(entry => entry.outcome === "skipped")).toHaveLength(4);
				expect(
					await fs.readFile(path.join(projectDir, ".gjc", "skills", SKILL_NAME, "SKILL.md"), "utf8"),
				).toContain("pre-existing native authority");
				expect(await fs.readFile(path.join(projectDir, ".gjc", "hooks", "pre", "read.ts"), "utf8")).toContain(
					"collision-hook-ran",
				);
				expect(await fs.readFile(path.join(projectDir, ".gjc", "mcp.json"), "utf8")).toContain("native-collision");
				await safeRm(path.join(projectDir, ".gjc"), { recursive: true, force: true });
				const plan = await buildImportPreview(previewOptions(convention));
				const previewJson = JSON.stringify(plan.preview);
				await expect(fs.stat(path.join(projectDir, ".gjc"))).rejects.toMatchObject({ code: "ENOENT" });
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
				for (const sourceFile of Object.values(sourceFiles(convention))) {
					expect(await fs.stat(sourceFile)).toBeTruthy();
				}
				expect(
					await fs.readFile(path.join(projectDir, ".gjc", "skills", SKILL_NAME, "SKILL.md"), "utf8"),
				).toContain("x-gjc-imported-from");
				expect(await fs.stat(path.join(projectDir, ".gjc", "hooks", "pre", "read.ts"))).toBeTruthy();
				expect(await fs.stat(path.join(projectDir, ".gjc", "mcp.json"))).toBeTruthy();
				await makeForeignHookDistinct(convention, foreignMarker);
			}

			const observed = await consumeCanonicalBundle(marker);
			expect(observed.skill.name).toBe(SKILL_NAME);
			expect(observed.skill.description).toBe("Cross-convention fixture skill.");
			expect(observed.mcp.text).toBe("canonical-mcp-consumed");
			expect(observed.hook).toBe(HOOK_TOOL);
			expect(
				await fs.stat(foreignMarker).then(
					() => true,
					() => false,
				),
			).toBe(false);
			await fs.rm(marker, { force: true });
			const repeated = await consumeCanonicalBundle(marker);
			expect(repeated).toEqual(observed);
			expect(
				await fs.stat(foreignMarker).then(
					() => true,
					() => false,
				),
			).toBe(false);
		}, 30_000);
	}
});
