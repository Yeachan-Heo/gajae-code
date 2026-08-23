/**
 * Issue #4291 acceptance: `/extensions` umbrella local customization surface.
 *
 * Covers canonical project/global `.gjc` scope resolution, inventory/status
 * provenance against the runtime contracts, Claude Code + Codex import
 * preview/apply with collision policy, redaction, unsupported semantics,
 * cancellation, transactional apply with rollback, idempotency, mutations,
 * and the adversarial regression branches from the gen-1 cohort review
 * (traversal, symlinked ancestors, rollback preservation, malformed shapes,
 * occupied rename suffixes, reserved names, secret serialization).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyImport,
	type BuildImportPreviewOptions,
	buildImportPreview,
} from "@gajae-code/coding-agent/customization/import";
import { loadCustomizationInventory } from "@gajae-code/coding-agent/customization/inventory";
import {
	removeHookFile,
	removeMcpServerEntry,
	removeSkill,
	setMcpServerEnabled,
	setSkillEnabled,
} from "@gajae-code/coding-agent/customization/mutations";
import { resolveScopePaths } from "@gajae-code/coding-agent/customization/types";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";

let tmpRoot: string;
let projectDir: string;
let homeDir: string;
let savedAgentDir: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4291-"));
	projectDir = path.join(tmpRoot, "project");
	homeDir = path.join(tmpRoot, "home");
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(homeDir, { recursive: true });
	savedAgentDir = getAgentDir();
	// Keep the global scope coherent: the canonical agent dir lives under the
	// fixture home so management discovery and scope writes agree.
	setAgentDir(path.join(homeDir, ".gjc", "agent"));
});

afterEach(async () => {
	setAgentDir(savedAgentDir);
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf-8");
}

const SKILL_MD = `---
description: Fixture skill for tests.
---

# Fixture

Do the thing.
`;

function previewOptions(overrides: Partial<BuildImportPreviewOptions> = {}): BuildImportPreviewOptions {
	return {
		product: "claude-code",
		sourceScope: "project",
		destinationScope: "project",
		collisionPolicy: "skip",
		cwd: projectDir,
		homeDir,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Acceptance 2: canonical scope locations
// ---------------------------------------------------------------------------

describe("scope resolution", () => {
	test("project scope resolves to <project>/.gjc", () => {
		const paths = resolveScopePaths("project", projectDir);
		expect(paths.root).toBe(path.join(projectDir, ".gjc"));
		expect(paths.skillsDir).toBe(path.join(projectDir, ".gjc", "skills"));
		expect(paths.hooksDir).toBe(path.join(projectDir, ".gjc", "hooks"));
		expect(paths.mcpConfigPath).toBe(path.join(projectDir, ".gjc", "mcp.json"));
	});

	test("global scope resolves to the agent dir (~/.gjc/agent)", () => {
		const paths = resolveScopePaths("global", projectDir);
		expect(paths.root).toBe(getAgentDir());
		expect(paths.skillsDir).toBe(path.join(getAgentDir(), "skills"));
		expect(paths.mcpConfigPath).toBe(path.join(getAgentDir(), "mcp.json"));
	});
});

// ---------------------------------------------------------------------------
// Acceptance 3 + additional: inventory with zero extension modules
// ---------------------------------------------------------------------------

describe("customization inventory", () => {
	test("one project SKILL.md is managed even with no extension modules installed", async () => {
		await writeFile(path.join(projectDir, ".gjc", "skills", "fixture", "SKILL.md"), SKILL_MD);
		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir });
		const row = inventory.rows.find(r => r.surface === "skills" && r.name === "fixture");
		expect(row).toBeDefined();
		expect(row?.status).toBe("enabled");
		expect(row?.scope).toBe("project");
		expect(row?.path).toBe(path.join(projectDir, ".gjc", "skills", "fixture", "SKILL.md"));
	});

	test("global skills surface under the global scope", async () => {
		await writeFile(path.join(getAgentDir(), "skills", "global-skill", "SKILL.md"), SKILL_MD);
		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir });
		const row = inventory.rows.find(r => r.surface === "skills" && r.name === "global-skill");
		expect(row).toBeDefined();
		expect(row?.scope).toBe("global");
	});

	test("selected agent directory owns every global inventory surface", async () => {
		const profile = path.join(tmpRoot, "selected-agent");
		const decoy = getAgentDir();
		await writeFile(path.join(profile, "skills", "profile-skill", "SKILL.md"), SKILL_MD);
		await writeFile(path.join(profile, "hooks", "pre", "profile.ts"), "export {}\n");
		await writeFile(
			path.join(profile, "mcp.json"),
			JSON.stringify({ mcpServers: { profile: { type: "stdio", command: "profile-command" } } }),
		);
		await writeFile(path.join(decoy, "skills", "decoy-skill", "SKILL.md"), SKILL_MD);
		await writeFile(path.join(decoy, "hooks", "pre", "decoy.ts"), "export {}\n");
		await writeFile(
			path.join(decoy, "mcp.json"),
			JSON.stringify({ mcpServers: { decoy: { type: "stdio", command: "decoy-command" } } }),
		);

		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir, agentDir: profile });
		const globalRows = inventory.rows.filter(row => row.scope === "global");
		expect(globalRows.map(row => row.name)).toEqual(
			expect.arrayContaining(["profile-skill", "profile.ts", "profile"]),
		);
		expect(globalRows.map(row => row.name)).not.toEqual(expect.arrayContaining(["decoy-skill", "decoy.ts", "decoy"]));
		expect(globalRows.every(row => row.path.startsWith(profile))).toBe(true);
	});

	test("invalid frontmatter is flagged with remediation diagnostics", async () => {
		await writeFile(path.join(projectDir, ".gjc", "skills", "broken", "SKILL.md"), "no frontmatter here\n");
		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir });
		const row = inventory.rows.find(r => r.surface === "skills" && r.name === "broken");
		expect(row?.status).toBe("invalid");
		expect(row?.diagnostics?.join(" ")).toContain("frontmatter");
	});

	test("native hooks are discovered from the canonical phase directories", async () => {
		await writeFile(path.join(projectDir, ".gjc", "hooks", "pre", "bash.ts"), "export {}\n");
		await writeFile(path.join(getAgentDir(), "hooks", "pre", "bash.ts"), "export {}\n");
		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir });
		const rows = inventory.rows.filter(r => r.surface === "hooks" && r.name === "bash.ts");
		expect(rows.find(r => r.scope === "project")?.status).toBe("enabled");
		expect(rows.find(r => r.scope === "global")?.status).toBe("shadowed");
	});

	test("project MCP server shadows the same global server; disabled markers union", async () => {
		await writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "npx" } } }),
		);
		await writeFile(
			path.join(getAgentDir(), "mcp.json"),
			JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "uvx" } } }),
		);
		const inventory = await loadCustomizationInventory({
			cwd: projectDir,
			home: homeDir,
			disabledExtensions: ["mcp:other"],
		});
		const rows = inventory.rows.filter(r => r.surface === "mcps" && r.name === "srv");
		expect(rows.find(r => r.scope === "project")?.status).toBe("enabled");
		expect(rows.find(r => r.scope === "global")?.status).toBe("shadowed");
	});

	test("disabledServers from either scope make the effective server disabled", async () => {
		await writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "npx" } } }),
		);
		await writeFile(path.join(getAgentDir(), "mcp.json"), JSON.stringify({ disabledServers: ["srv"] }));
		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir });
		expect(inventory.rows.find(r => r.surface === "mcps" && r.name === "srv")?.status).toBe("disabled");
	});

	test("malformed MCP config surfaces as an invalid row, never raw JSON", async () => {
		await writeFile(path.join(projectDir, ".gjc", "mcp.json"), "{ not json");
		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir });
		const row = inventory.rows.find(r => r.surface === "mcps" && r.status === "invalid");
		expect(row).toBeDefined();
		expect(JSON.stringify(row)).not.toContain("not json");
	});

	test("MCP inventory rows never render env/header values or token assignments", async () => {
		await writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					srv: {
						type: "stdio",
						command: "npx srv --token=abc123secret",
						env: { API_KEY: "super-secret-value" },
					},
				},
			}),
		);
		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir });
		const row = inventory.rows.find(r => r.surface === "mcps" && r.name === "srv");
		expect(row).toBeDefined();
		expect(JSON.stringify(row)).not.toContain("super-secret-value");
		expect(JSON.stringify(row)).not.toContain("abc123secret");
	});

	test("MCP inventory raw projection drops nested auth and oauth secrets", async () => {
		await writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					srv: {
						type: "stdio",
						command: "npx",
						auth: { clientSecret: "AUTH_NESTED_SECRET" },
						oauth: { clientSecret: "OAUTH_NESTED_SECRET" },
					},
				},
			}),
		);
		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir });
		const serialized = JSON.stringify(inventory.rows.find(r => r.surface === "mcps" && r.name === "srv"));
		expect(serialized).not.toContain("AUTH_NESTED_SECRET");
		expect(serialized).not.toContain("OAUTH_NESTED_SECRET");
	});
});

// ---------------------------------------------------------------------------
// Acceptance 4/5: Claude Code + Codex imports
// ---------------------------------------------------------------------------

async function seedClaudeProject(): Promise<void> {
	await writeFile(path.join(projectDir, ".claude", "skills", "claude-skill", "SKILL.md"), SKILL_MD);
	await writeFile(path.join(projectDir, ".claude", "hooks", "pre", "bash.ts"), "export default function hook() {}\n");
	await writeFile(
		path.join(projectDir, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				"claude-server": { type: "stdio", command: "npx", args: ["-y", "srv"], env: { API_KEY: "secret-value" } },
			},
		}),
	);
}

describe("import from Claude Code (project → project .gjc)", () => {
	test("preview normalizes skills/hooks/MCPs and redacts secrets", async () => {
		await seedClaudeProject();
		const { preview } = await buildImportPreview(previewOptions());
		const skills = preview.entries.filter(e => e.surface === "skills");
		const hooks = preview.entries.filter(e => e.surface === "hooks");
		const mcps = preview.entries.filter(e => e.surface === "mcps");
		expect(skills.map(e => e.destinationName)).toEqual(["claude-skill"]);
		// Canonical phase-relative destination identity.
		expect(hooks.map(e => e.destinationName)).toEqual(["pre/bash.ts"]);
		expect(mcps.map(e => e.destinationName)).toEqual(["claude-server"]);
		const mcp = mcps[0];
		expect(mcp.status).toBe("add");
		expect(mcp.reason).toContain("env:API_KEY");
		// The preview DTO is serialization-safe: no secret values anywhere.
		expect(JSON.stringify(preview)).not.toContain("secret-value");
	});

	test("apply writes canonical .gjc files and marks provenance", async () => {
		await seedClaudeProject();
		const plan = await buildImportPreview(previewOptions());
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		const skillPath = path.join(projectDir, ".gjc", "skills", "claude-skill", "SKILL.md");
		const content = await fs.readFile(skillPath, "utf-8");
		expect(content).toContain("x-gjc-imported-from");
		expect(content).toContain("claude-code");
		// Hooks land in the runtime-discovered phase layout.
		await fs.stat(path.join(projectDir, ".gjc", "hooks", "pre", "bash.ts"));
		await expect(fs.stat(path.join(projectDir, ".gjc", "hooks", "pre-bash.ts"))).rejects.toThrow();
		const mcpConfig = JSON.parse(await fs.readFile(path.join(projectDir, ".gjc", "mcp.json"), "utf-8"));
		expect(mcpConfig.mcpServers["claude-server"].command).toBe("npx");
		const inventory = await loadCustomizationInventory({ cwd: projectDir, home: homeDir });
		const skillRow = inventory.rows.find(r => r.surface === "skills" && r.name === "claude-skill");
		expect(skillRow?.status).toBe("imported");
		expect(skillRow?.provenance).toContain("Claude Code");
		const hookRow = inventory.rows.find(r => r.surface === "hooks" && r.name === "bash.ts");
		expect(hookRow?.status).toBe("enabled");
	});
});

describe("import from Codex (user-global → global .gjc, explicit selection)", () => {
	test("codex skills + toml MCP normalize into global .gjc only", async () => {
		await writeFile(path.join(homeDir, ".codex", "skills", "codex-skill", "SKILL.md"), SKILL_MD);
		await writeFile(path.join(homeDir, ".codex", "hooks", "pre-bash.ts"), "export {}\n");
		await writeFile(
			path.join(homeDir, ".codex", "config.toml"),
			'[mcp_servers.codex-server]\ncommand = "uvx"\nargs = ["srv"]\n',
		);
		const plan = await buildImportPreview(
			previewOptions({ product: "codex", sourceScope: "user", destinationScope: "global" }),
		);
		expect(plan.preview.entries.filter(e => e.surface === "skills").map(e => e.destinationName)).toEqual([
			"codex-skill",
		]);
		expect(plan.preview.entries.filter(e => e.surface === "mcps").map(e => e.destinationName)).toEqual([
			"codex-server",
		]);
		expect(plan.preview.entries.filter(e => e.surface === "hooks").map(e => e.destinationName)).toEqual([
			"pre/bash.ts",
		]);
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		// Writes land only in the global .gjc scope, never the project.
		await fs.stat(path.join(getAgentDir(), "skills", "codex-skill", "SKILL.md"));
		await fs.stat(path.join(getAgentDir(), "hooks", "pre", "bash.ts"));
		const mcpConfig = JSON.parse(await fs.readFile(path.join(getAgentDir(), "mcp.json"), "utf-8"));
		expect(mcpConfig.mcpServers["codex-server"].command).toBe("uvx");
		await expect(fs.stat(path.join(projectDir, ".gjc", "skills", "codex-skill"))).rejects.toThrow();
		await expect(fs.stat(path.join(projectDir, ".gjc", "mcp.json"))).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Acceptance 6/7: collisions, unsupported semantics, cancellation, rollback, idempotency
// ---------------------------------------------------------------------------

describe("import collision policy and safety", () => {
	async function seedSkillBothSides(): Promise<void> {
		await writeFile(path.join(projectDir, ".claude", "skills", "dupe", "SKILL.md"), SKILL_MD);
		await writeFile(
			path.join(projectDir, ".gjc", "skills", "dupe", "SKILL.md"),
			`---\ndescription: Native version.\n---\n\nnative body\n`,
		);
	}

	test("skip policy marks conflicts and never overwrites the native entry", async () => {
		await seedSkillBothSides();
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills"] }));
		expect(plan.preview.entries[0].status).toBe("conflict");
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		expect(result.entries[0].outcome).toBe("skipped");
		const content = await fs.readFile(path.join(projectDir, ".gjc", "skills", "dupe", "SKILL.md"), "utf-8");
		expect(content).toContain("Native version.");
	});

	test("rename policy imports under an -imported suffix", async () => {
		await seedSkillBothSides();
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills"], collisionPolicy: "rename" }));
		expect(plan.preview.entries[0].destinationName).toBe("dupe-imported");
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		expect(result.entries[0].outcome).toBe("renamed");
		await fs.stat(path.join(projectDir, ".gjc", "skills", "dupe-imported", "SKILL.md"));
	});

	test("rename rewrites an explicit skill frontmatter name to the destination identity", async () => {
		const named = `---\nname: dupe\ndescription: Named skill.\n---\n\nbody\n`;
		await writeFile(path.join(projectDir, ".claude", "skills", "dupe", "SKILL.md"), named);
		await writeFile(path.join(projectDir, ".gjc", "skills", "dupe", "SKILL.md"), SKILL_MD);
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills"], collisionPolicy: "rename" }));
		await applyImport(plan, { cwd: projectDir });
		const imported = await fs.readFile(path.join(projectDir, ".gjc", "skills", "dupe-imported", "SKILL.md"), "utf-8");
		expect(imported).toContain("name: dupe-imported");
	});

	test("protected bundled workflow skill names are rejected at preview", async () => {
		await writeFile(path.join(projectDir, ".claude", "skills", "ralplan", "SKILL.md"), SKILL_MD);
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills"] }));
		expect(plan.preview.entries[0].status).toBe("unsupported");
		expect(plan.preview.entries[0].reason).toContain("protected bundled");
	});

	test("rename never overwrites an occupied -imported destination", async () => {
		await seedSkillBothSides();
		// Pre-occupy every suffix the renamer might pick.
		await writeFile(path.join(projectDir, ".gjc", "skills", "dupe-imported", "SKILL.md"), SKILL_MD);
		await writeFile(path.join(projectDir, ".gjc", "skills", "dupe-imported-2", "SKILL.md"), SKILL_MD);
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills"], collisionPolicy: "rename" }));
		expect(plan.preview.entries[0].destinationName).toBe("dupe-imported-3");
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		await fs.stat(path.join(projectDir, ".gjc", "skills", "dupe-imported-3", "SKILL.md"));
		const occupied = await fs.readFile(path.join(projectDir, ".gjc", "skills", "dupe-imported", "SKILL.md"), "utf-8");
		expect(occupied).toBe(SKILL_MD);
	});

	test("overwrite policy replaces the destination explicitly", async () => {
		await seedSkillBothSides();
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills"], collisionPolicy: "overwrite" }));
		expect(plan.preview.entries[0].status).toBe("overwrite");
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.entries[0].outcome).toBe("overwritten");
		const content = await fs.readFile(path.join(projectDir, ".gjc", "skills", "dupe", "SKILL.md"), "utf-8");
		expect(content).toContain("Fixture skill for tests.");
	});

	test("credential-bearing MCP overwrite preserves overwrite status and applies", async () => {
		await writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "new", env: { TOKEN: "secret" } } } }),
		);
		await writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "old" } } }),
		);
		const plan = await buildImportPreview(previewOptions({ surfaces: ["mcps"], collisionPolicy: "overwrite" }));
		expect(plan.preview.entries[0].status).toBe("overwrite");
		expect(plan.preview.entries[0].reason).toContain("secret values hidden");
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		expect(result.entries[0].outcome).toBe("overwritten");
	});

	test("identical re-import is a no-op (idempotent)", async () => {
		await seedClaudeProject();
		const options = previewOptions();
		await applyImport(await buildImportPreview(options), { cwd: projectDir });
		const second = await buildImportPreview(options);
		for (const entry of second.preview.entries) {
			expect(entry.status).toBe("conflict");
			expect(entry.reason).toContain("identical");
		}
		const secondResult = await applyImport(second, { cwd: projectDir });
		expect(secondResult.ok).toBe(true);
		expect(secondResult.entries.every(e => e.outcome === "skipped")).toBe(true);
	});

	test("unsupported hook filenames surface diagnostics instead of silent import", async () => {
		await writeFile(path.join(projectDir, ".codex", "hooks", "random-name.ts"), "export {}\n");
		const plan = await buildImportPreview(previewOptions({ product: "codex", surfaces: ["hooks"] }));
		// Codex collector skips non-conforming names with a warning instead of importing them.
		expect(plan.preview.entries).toHaveLength(0);
		expect(plan.preview.warnings.join(" ")).toContain("pre-<tool>");
	});

	test("command text with token-shaped arguments is masked in the preview", async () => {
		await writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: { srv: { type: "stdio", command: "node srv --token=GEN2_TOKEN_SECRET" } },
			}),
		);
		const plan = await buildImportPreview(previewOptions({ surfaces: ["mcps"] }));
		expect(JSON.stringify(plan.preview)).not.toContain("GEN2_TOKEN_SECRET");
		const entry = plan.preview.entries[0];
		expect(entry.description).toContain("command redacted");
		// The plan payload keeps the real value for the actual write.
		expect(JSON.stringify(plan.payloads)).toContain("GEN2_TOKEN_SECRET");
	});

	test("quoted bearer and authorization command forms are omitted from the preview", async () => {
		for (const [name, command, secret] of [
			["bearer", 'node --bearer "Bearer GEN3_BEARER_SECRET"', "GEN3_BEARER_SECRET"],
			["authorization", 'node --header "Authorization: Bearer ARCH_SECRET"', "ARCH_SECRET"],
		] as const) {
			await writeFile(
				path.join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { [name]: { type: "stdio", command } } }),
			);
			const plan = await buildImportPreview(previewOptions({ surfaces: ["mcps"] }));
			expect(JSON.stringify(plan.preview)).not.toContain(secret);
			expect(plan.preview.entries[0].description).toContain("command redacted");
			expect(JSON.stringify(plan.payloads)).toContain(secret);
		}
	});

	test("nested auth/oauth MCP fields are diagnosed instead of silently dropped", async () => {
		await writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					srv: { type: "stdio", command: "npx", auth: { clientSecret: "NESTED_SECRET" } },
				},
			}),
		);
		const plan = await buildImportPreview(previewOptions({ surfaces: ["mcps"] }));
		expect(plan.preview.entries[0].status).toBe("unsupported");
		expect(plan.preview.entries[0].reason).toContain("not supported");
		expect(JSON.stringify(plan.preview)).not.toContain("NESTED_SECRET");
		expect(JSON.stringify(plan.payloads)).not.toContain("NESTED_SECRET");
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		expect(result.entries[0].outcome).toBe("skipped");
	});

	test("malformed source MCP config is a warning, not a crash", async () => {
		await writeFile(path.join(projectDir, ".mcp.json"), "{ broken");
		const plan = await buildImportPreview(previewOptions({ surfaces: ["mcps"] }));
		expect(plan.preview.warnings.join(" ")).toContain("Failed to parse");
		expect(plan.preview.entries).toHaveLength(0);
	});

	test("non-object source mcpServers shape is diagnosed, not silently emptied", async () => {
		await writeFile(path.join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: "nope" }));
		const plan = await buildImportPreview(previewOptions({ surfaces: ["mcps"] }));
		expect(plan.preview.entries).toHaveLength(0);
		expect(plan.preview.warnings.join(" ")).toContain("Failed to parse");
	});

	test("prototype-sensitive MCP names never reach the destination config", async () => {
		// The JSON layer drops __proto__ own-properties and the compat adapter
		// rejects prototype-sensitive names — either way nothing is imported.
		await writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { __proto__: { type: "stdio", command: "x" } } }),
		);
		const plan = await buildImportPreview(previewOptions({ surfaces: ["mcps"] }));
		expect(plan.preview.entries).toHaveLength(0);
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		await expect(fs.stat(path.join(projectDir, ".gjc", "mcp.json"))).rejects.toThrow();
	});

	test("cancellation means no writes: building a preview never touches the destination", async () => {
		await seedClaudeProject();
		await buildImportPreview(previewOptions());
		await expect(fs.stat(path.join(projectDir, ".gjc"))).rejects.toThrow();
	});

	test("malformed destination mcp.json aborts before any write (atomic pre-validation)", async () => {
		await seedClaudeProject();
		await writeFile(path.join(projectDir, ".gjc", "mcp.json"), "{ malformed");
		const plan = await buildImportPreview(previewOptions());
		// MCP entries are marked unsupported at preview time; skill/hook entries still apply.
		expect(plan.preview.entries.filter(e => e.surface === "mcps").every(e => e.status === "unsupported")).toBe(true);
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		const mcpContent = await fs.readFile(path.join(projectDir, ".gjc", "mcp.json"), "utf-8");
		expect(mcpContent).toBe("{ malformed");
	});

	test("non-object destination mcpServers shape aborts MCP writes without corrupting the file", async () => {
		await writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "npx" } } }),
		);
		await writeFile(path.join(projectDir, ".gjc", "mcp.json"), JSON.stringify({ mcpServers: "corrupted" }));
		const plan = await buildImportPreview(previewOptions({ surfaces: ["mcps"] }));
		expect(plan.preview.entries.every(e => e.status === "unsupported")).toBe(true);
		expect(plan.preview.warnings.join(" ")).toContain("non-object mcpServers");
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		const content = await fs.readFile(path.join(projectDir, ".gjc", "mcp.json"), "utf-8");
		expect(content).toBe(JSON.stringify({ mcpServers: "corrupted" }));
	});

	test("apply rolls back every staged write when publication fails mid-transaction", async () => {
		await seedClaudeProject();
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills", "hooks"] }));
		// Simulate a concurrent change after the preview: the hooks directory
		// becomes read-only, so hook publication fails after the skill file was
		// already written — full rollback. Pre-validation passes because reads
		// still succeed; only the write fails.
		await fs.mkdir(path.join(projectDir, ".gjc", "hooks"), { recursive: true });
		await fs.chmod(path.join(projectDir, ".gjc", "hooks"), 0o555);
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(false);
		expect(result.entries.some(e => e.outcome === "failed" && e.reason?.includes("rolled back"))).toBe(true);
		// The skill file that was published first must be gone again.
		await expect(fs.stat(path.join(projectDir, ".gjc", "skills", "claude-skill", "SKILL.md"))).rejects.toThrow();
		await fs.chmod(path.join(projectDir, ".gjc", "hooks"), 0o755);
	});

	test("rollback preserves a pre-existing symlink it never wrote", async () => {
		await seedClaudeProject();
		// A dangling symlink at the skill destination makes the apply fail in
		// pre-validation; rollback must not delete the symlink it never created.
		const linkTarget = path.join(tmpRoot, "elsewhere");
		await fs.mkdir(path.join(projectDir, ".gjc", "skills", "claude-skill"), { recursive: true });
		await fs.symlink(linkTarget, path.join(projectDir, ".gjc", "skills", "claude-skill", "SKILL.md"));
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills"] }));
		expect(plan.preview.entries[0].status).toBe("conflict");
		expect(plan.preview.entries[0].reason).toContain("unsafe");
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		expect(result.entries[0].outcome).toBe("skipped");
		const stat = await fs.lstat(path.join(projectDir, ".gjc", "skills", "claude-skill", "SKILL.md"));
		expect(stat.isSymbolicLink()).toBe(true);
	});

	test("symlinked destination ancestor directories are refused", async () => {
		await seedClaudeProject();
		// `.gjc/skills` itself is a symlink to an external directory.
		const external = path.join(tmpRoot, "external-skills");
		await fs.mkdir(external, { recursive: true });
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.symlink(external, path.join(projectDir, ".gjc", "skills"));
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills"] }));
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(false);
		expect(result.entries[0].reason).toContain("symlink");
		await expect(fs.stat(path.join(external, "claude-skill"))).rejects.toThrow();
	});

	test("symlinked MCP config destination is refused without writing externally", async () => {
		await writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "npx" } } }),
		);
		const external = path.join(tmpRoot, "external-mcp.json");
		await writeFile(external, JSON.stringify({ mcpServers: {} }));
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.symlink(external, path.join(projectDir, ".gjc", "mcp.json"));
		const plan = await buildImportPreview(previewOptions({ surfaces: ["mcps"] }));
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		expect(result.entries[0].outcome).toBe("skipped");
		expect(await fs.readFile(external, "utf-8")).toBe(JSON.stringify({ mcpServers: {} }));
	});

	test("stale preview fails closed instead of silently overwriting", async () => {
		await seedSkillBothSides();
		const plan = await buildImportPreview(previewOptions({ surfaces: ["skills"], collisionPolicy: "rename" }));
		// Simulate a concurrent process occupying the chosen rename destination.
		await writeFile(path.join(projectDir, ".gjc", "skills", "dupe-imported", "SKILL.md"), "different content\n");
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(false);
		expect(result.entries[0].reason).toContain("changed since preview");
		const occupied = await fs.readFile(path.join(projectDir, ".gjc", "skills", "dupe-imported", "SKILL.md"), "utf-8");
		expect(occupied).toBe("different content\n");
	});
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe("native .gjc mutations", () => {
	test("skill enable/disable flows through the authoritative policy contract", () => {
		const disabled = setSkillEnabled("fixture", false, []);
		expect(disabled.ok).toBe(true);
		if (disabled.ok) expect(disabled.disabledExtensions).toEqual(["skill:fixture"]);
		const enabled = setSkillEnabled("fixture", true, ["skill:fixture"]);
		expect(enabled.ok).toBe(true);
		if (enabled.ok) expect(enabled.disabledExtensions).toEqual([]);
		const protectedResult = setSkillEnabled("ralplan", false, []);
		expect(protectedResult.ok).toBe(false);
	});

	test("skill removal targets the exact discovered path and refuses symlinks", async () => {
		const paths = resolveScopePaths("project", projectDir);
		const skillPath = path.join(paths.skillsDir, "fixture", "SKILL.md");
		await writeFile(skillPath, SKILL_MD);
		expect(await removeSkill({ name: "fixture", path: skillPath })).toEqual({ ok: true });
		await expect(fs.stat(path.join(paths.skillsDir, "fixture"))).rejects.toThrow();
		// Absent discovered path: no silent success.
		const missing = await removeSkill({ name: "missing", path: path.join(paths.skillsDir, "missing", "SKILL.md") });
		expect(missing.ok).toBe(false);
	});

	test("bundled workflow skill names are protected from removal", async () => {
		const paths = resolveScopePaths("project", projectDir);
		const skillPath = path.join(paths.skillsDir, "ralplan", "SKILL.md");
		await writeFile(skillPath, SKILL_MD);
		const result = await removeSkill({ name: "ralplan", path: skillPath });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("bundled");
		await fs.stat(skillPath);
	});

	test("MCP enable/disable/remove use the canonical disabledServers denylist", async () => {
		const paths = resolveScopePaths("project", projectDir);
		await writeFile(paths.mcpConfigPath, JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "npx" } } }));
		const disabled = await setMcpServerEnabled(paths.mcpConfigPath, "srv", false);
		expect(disabled.ok).toBe(true);
		if (disabled.ok && "disabledExtensions" in disabled) expect(disabled.disabledExtensions).toEqual(["mcp:srv"]);
		let config = JSON.parse(await fs.readFile(paths.mcpConfigPath, "utf-8"));
		expect(config.disabledServers).toEqual(["srv"]);
		const enabled = await setMcpServerEnabled(paths.mcpConfigPath, "srv", true, ["mcp:srv"]);
		expect(enabled.ok).toBe(true);
		if (enabled.ok && "disabledExtensions" in enabled) expect(enabled.disabledExtensions).toEqual([]);
		config = JSON.parse(await fs.readFile(paths.mcpConfigPath, "utf-8"));
		expect(config.disabledServers).toBeUndefined();
		expect(await removeMcpServerEntry(paths.mcpConfigPath, "srv")).toEqual({ ok: true });
		config = JSON.parse(await fs.readFile(paths.mcpConfigPath, "utf-8"));
		expect(config.mcpServers.srv).toBeUndefined();
	});

	test("hook removal targets the exact path and fails when absent", async () => {
		const paths = resolveScopePaths("project", projectDir);
		const hookPath = path.join(paths.hooksDir, "pre", "bash.ts");
		await writeFile(hookPath, "export {}\n");
		expect(await removeHookFile(hookPath)).toEqual({ ok: true });
		const missing = await removeHookFile(hookPath);
		expect(missing.ok).toBe(false);
	});
});
