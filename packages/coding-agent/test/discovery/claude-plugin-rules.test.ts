import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability, loadCapability } from "@gajae-code/coding-agent/capability";
import { clearCache as clearFsCache } from "@gajae-code/coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@gajae-code/coding-agent/capability/rule";
import { clearClaudePluginRootsCache } from "@gajae-code/coding-agent/discovery/helpers";
import "@gajae-code/coding-agent/discovery/claude-plugins";
import type { LoadContext } from "@gajae-code/coding-agent/capability/types";
import {
	hashPluginTree,
	PLUGIN_RULE_TRUST_GRANT,
} from "../../src/extensibility/plugins/marketplace/plugin-rule-authority";

const RULEBOOK = `---
description: Rust best practices for fixture tests.
globs:
  - "**/*.rs"
---
Rulebook body
`;

const TTSR = `---
description: Auto-inject fixture rule on first Rust edit.
condition: "*.rs"
interruptMode: never
repeatMode: once
---
Inject body
`;

describe("claude-plugins rules discovery", () => {
	let tempDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-rules-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function cachePath(marketplace: string, plugin: string, version = "1.0.0"): string {
		return path.join(tempDir, ".gjc", "plugins", "cache", "plugins", `${marketplace}___${plugin}___${version}`);
	}

	async function writeTrustedRegistry(
		pluginId: string,
		installPath: string,
		scope: "user" | "project",
		extra: Record<string, unknown> = {},
	): Promise<void> {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });
		const treeDigest = extra.treeDigest ?? (await hashPluginTree(installPath));
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					[pluginId]: [
						{
							scope,
							installPath,
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
							trustGrant: PLUGIN_RULE_TRUST_GRANT,
							treeDigest,
							...extra,
						},
					],
				},
			}),
		);
	}

	async function seedTrustedPlugin(
		plugin: string,
		marketplace: string,
		files: Record<string, string>,
		scope: "user" | "project" = "user",
	): Promise<string> {
		const installPath = cachePath(marketplace, plugin);
		for (const [rel, content] of Object.entries(files)) {
			const abs = path.join(installPath, rel);
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, content);
		}
		await writeTrustedRegistry(`${plugin}@${marketplace}`, installPath, scope);
		return installPath;
	}

	async function loadPluginRules(): Promise<{ items: Rule[]; warnings: string[] }> {
		const cap = getCapability(ruleCapability.id);
		if (!cap) throw new Error("rules capability missing");
		const provider = cap.providers.find(p => p.id === "claude-plugins");
		if (!provider) throw new Error("claude-plugins rules provider missing");
		const ctx: LoadContext = { cwd: tempDir, home: tempDir, repoRoot: tempDir };
		return (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[]; warnings?: string[] }>)(ctx).then(
			result => ({ items: result.items, warnings: result.warnings ?? [] }),
		);
	}

	test("registers exactly one claude-plugins provider on the rules capability", () => {
		const cap = getCapability(ruleCapability.id);
		const providers = cap?.providers.filter(p => p.id === "claude-plugins") ?? [];
		expect(providers).toHaveLength(1);
		expect(providers[0]?.description).toBe("Load rules from GJC marketplace plugins");
	});

	test("loads rulebook and TTSR rules from a trusted manager cache root", async () => {
		await seedTrustedPlugin("fixture-rules", "market", {
			"rules/rust-skills.md": RULEBOOK,
			"rules/rust-skills-inject.mdc": TTSR,
		});

		const { items } = await loadPluginRules();
		expect(items).toHaveLength(2);

		const rulebook = items.find(rule => rule.name === "rust-skills");
		const inject = items.find(rule => rule.name === "rust-skills-inject");
		expect(rulebook).toBeDefined();
		expect(inject).toBeDefined();
		expect(rulebook?.globs).toEqual(["**/*.rs"]);
		expect(rulebook?.description).toBe("Rust best practices for fixture tests.");
		expect(rulebook?._source.level).toBe("user");
		expect(inject?.condition).toBeUndefined();
		expect(inject?.mutationTargetGlobs).toEqual(["*.rs"]);
		expect(inject?.scope).toEqual(["tool:edit(*.rs)", "tool:write(*.rs)", "tool:apply_patch(*.rs)"]);
		expect(inject?.interruptMode).toBe("never");
		expect(inject?.repeatMode).toBe("once");
	});

	test("reads rules directory from plugin manifest rules field", async () => {
		await seedTrustedPlugin(
			"manifest-rules",
			"market",
			{
				".claude-plugin/plugin.json": JSON.stringify({ rules: "./.claude/rules" }),
				".claude/rules/rust-skills.md": RULEBOOK,
				".claude/rules/rust-skills-inject.md": TTSR,
			},
			"project",
		);

		const result = await loadCapability<Rule>(ruleCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});
		expect(result.all).toHaveLength(2);
		const rulebook = result.all.find(rule => rule.name === "rust-skills");
		expect(rulebook?.path).toContain(path.join(".claude", "rules", "rust-skills.md"));
		expect(rulebook?._source.level).toBe("project");
	});

	test("rejects a repo-editable installPath outside the manager cache", async () => {
		const rogue = path.join(tempDir, "repo", "rogue-plugin");
		await fs.mkdir(path.join(rogue, "rules"), { recursive: true });
		await fs.writeFile(path.join(rogue, "rules", "rust-skills.md"), RULEBOOK);
		await writeTrustedRegistry("rogue@market", rogue, "user");

		const { items, warnings } = await loadPluginRules();
		expect(items).toHaveLength(0);
		expect(warnings.join("\n")).toContain("installPath is not the manager-owned cache identity");
	});

	test("rejects a cache identity whose recorded digest no longer matches", async () => {
		const installPath = await seedTrustedPlugin("stale-digest", "market", {
			"rules/rust-skills.md": RULEBOOK,
		});
		await fs.writeFile(path.join(installPath, "rules", "rust-skills.md"), `${RULEBOOK}\nmutated\n`);
		clearClaudePluginRootsCache();
		clearFsCache();

		const { items, warnings } = await loadPluginRules();
		expect(items).toHaveLength(0);
		expect(warnings.join("\n")).toContain("tree digest does not match");
	});

	test("rejects a symlinked rules directory that escapes the plugin root", async () => {
		const installPath = cachePath("market", "symlink-rules");
		const escapeDir = path.join(tempDir, "escaped");
		await fs.mkdir(escapeDir, { recursive: true });
		await fs.writeFile(path.join(escapeDir, "pwned.md"), RULEBOOK);
		await fs.mkdir(installPath, { recursive: true });
		await fs.symlink(escapeDir, path.join(installPath, "rules"));
		await writeTrustedRegistry("symlink-rules@market", installPath, "user");

		const { items, warnings } = await loadPluginRules();
		expect(items).toHaveLength(0);
		expect(warnings.join("\n")).toMatch(/symlink|outside plugin root/i);
	});

	test("rejects a symlinked rule file that escapes the plugin root", async () => {
		const installPath = cachePath("market", "symlink-file");
		const escapeFile = path.join(tempDir, "escaped.md");
		await fs.writeFile(escapeFile, RULEBOOK);
		await fs.mkdir(path.join(installPath, "rules"), { recursive: true });
		await fs.symlink(escapeFile, path.join(installPath, "rules", "rust-skills.md"));
		await writeTrustedRegistry("symlink-file@market", installPath, "user");

		const { items, warnings } = await loadPluginRules();
		expect(items.find(rule => rule.name === "rust-skills")).toBeUndefined();
		expect(warnings.join("\n")).toMatch(/symlink/i);
	});
});
