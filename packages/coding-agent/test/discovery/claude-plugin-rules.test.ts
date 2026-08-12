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

	async function writeRegistry(pluginId: string, installPath: string, scope: "user" | "project"): Promise<void> {
		const pluginsDir = path.join(tempDir, ".gjc", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });
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
						},
					],
				},
			}),
		);
	}

	async function loadPluginRules(): Promise<Rule[]> {
		const cap = getCapability(ruleCapability.id);
		if (!cap) throw new Error("rules capability missing");
		const provider = cap.providers.find(p => p.id === "claude-plugins");
		if (!provider) throw new Error("claude-plugins rules provider missing");
		const ctx: LoadContext = { cwd: tempDir, home: tempDir, repoRoot: tempDir };
		const result = await (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
		return result.items;
	}

	test("registers exactly one claude-plugins provider on the rules capability", () => {
		const cap = getCapability(ruleCapability.id);
		const providers = cap?.providers.filter(p => p.id === "claude-plugins") ?? [];
		expect(providers).toHaveLength(1);
		expect(providers[0]?.description).toBe("Load rules from GJC marketplace plugins");
	});

	test("loads rulebook and TTSR rules from the default rules/ directory", async () => {
		const pluginPath = path.join(tempDir, "plugins", "fixture-rules");
		await fs.mkdir(path.join(pluginPath, "rules"), { recursive: true });
		await writeRegistry("fixture-rules@market", pluginPath, "user");
		await fs.writeFile(path.join(pluginPath, "rules", "rust-skills.md"), RULEBOOK);
		await fs.writeFile(path.join(pluginPath, "rules", "rust-skills-inject.mdc"), TTSR);

		const items = await loadPluginRules();
		expect(items).toHaveLength(2);

		const rulebook = items.find(rule => rule.name === "rust-skills");
		const inject = items.find(rule => rule.name === "rust-skills-inject");
		expect(rulebook).toBeDefined();
		expect(inject).toBeDefined();

		expect(rulebook?.globs).toEqual(["**/*.rs"]);
		expect(rulebook?.description).toBe("Rust best practices for fixture tests.");
		expect(rulebook?._source.level).toBe("user");
		expect(rulebook?._source.provider).toBe("claude-plugins");

		expect(inject?.condition).toEqual([".*"]);
		expect(inject?.scope).toEqual(["tool:edit(*.rs)", "tool:write(*.rs)"]);
		expect(inject?.interruptMode).toBe("never");
		expect(inject?.repeatMode).toBe("once");
		expect(inject?._source.level).toBe("user");
	});

	test("reads rules directory from plugin manifest rules field", async () => {
		const pluginPath = path.join(tempDir, "plugins", "manifest-rules");
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "rules"), { recursive: true });
		await writeRegistry("manifest-rules@market", pluginPath, "project");
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ rules: "./.claude/rules" }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "rules", "rust-skills.md"), RULEBOOK);
		await fs.writeFile(path.join(pluginPath, ".claude", "rules", "rust-skills-inject.md"), TTSR);

		const result = await loadCapability<Rule>(ruleCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});
		expect(result.warnings).toEqual([]);
		expect(result.all).toHaveLength(2);

		const rulebook = result.all.find(rule => rule.name === "rust-skills");
		const inject = result.all.find(rule => rule.name === "rust-skills-inject");
		expect(rulebook?.path).toContain(path.join(".claude", "rules", "rust-skills.md"));
		expect(rulebook?.globs).toEqual(["**/*.rs"]);
		expect(rulebook?._source.level).toBe("project");
		expect(inject?.condition).toEqual([".*"]);
		expect(inject?.interruptMode).toBe("never");
		expect(inject?.repeatMode).toBe("once");
		expect(inject?._source.level).toBe("project");
	});
});
