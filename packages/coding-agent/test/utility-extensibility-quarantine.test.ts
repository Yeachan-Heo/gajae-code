import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

function srcPath(...parts: string[]): string {
	return path.join(repoRoot, "packages", "coding-agent", "src", ...parts);
}

async function source(...parts: string[]): Promise<string> {
	return await Bun.file(srcPath(...parts)).text();
}

function extractSetValues(sourceText: string, name: string): string[] {
	const block = sourceText.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
	if (!block) return [];
	return [...block[1].matchAll(/"([^"]+)"/g)].map(match => match[1]).sort();
}

describe("GJC utility extensibility quarantine", () => {
	it("removes only non-ambiguous product-facing utility slash commands from the active registry", async () => {
		const registry = await source("slash-commands", "builtin-registry.ts");
		expect(extractSetValues(registry, "QUARANTINED_UTILITY_SLASH_COMMANDS")).toEqual(["agents"]);
		expect(registry).toContain("ACTIVE_BUILTIN_SLASH_COMMAND_REGISTRY");
		expect(registry).toContain("BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command)");
	});

	it("deletes approved non-critical slash command implementations", async () => {
		const registry = await source("slash-commands", "builtin-registry.ts");
		for (const removedCommand of [
			"extensions",
			"marketplace",
			"plugins",
			"reload-plugins",
			"plan",
			"share",
			"todo",
			"branch",
			"fork",
			"handoff",
			"force",
			// `quit` stays a non-standalone command: `/quit` is a TUI alias of
			// `/exit`, verified in slash-command-builtin-registry.test.ts.
			"quit",
			"loop",
		]) {
			expect(registry).not.toContain(`name: "${removedCommand}"`);
		}
		// `/changelog` was restored as a first-class built-in (see CHANGELOG
		// Unreleased), so it is intentionally no longer in the removed set above.
		expect(registry).toContain(`name: "changelog"`);
		expect(registry).toContain(`name: "ssh"`);
		expect(registry).toContain(`name: "provider"`);
		expect(await Bun.file(srcPath("slash-commands", "helpers", "marketplace-manager.ts")).exists()).toBe(false);
		expect(await Bun.file(srcPath("slash-commands", "marketplace-install-parser.ts")).exists()).toBe(false);
	});

	it("does not parse CLI plugin, extension, hook, or skill-loading flags", async () => {
		const args = await source("cli", "args.ts");
		for (const removedFlag of [
			"--plugin-dir",
			"--extension",
			"--hook",
			"--no-extensions",
			"--no-skills",
			"--skills",
		]) {
			expect(args).not.toContain(`arg === "${removedFlag}"`);
		}
		expect(args).not.toContain("extensionFlags");
	});

	it("does not default-discover skills, extensions, custom commands, custom tools, plugins, or marketplaces", async () => {
		const sdk = await source("sdk", "session.ts");
		const main = await source("main.ts");
		const settingsSchema = await source("config", "settings-schema.ts");

		for (const forbidden of [
			'logger.time("discoverSkills"',
			'logger.time("discoverSlashCommands"',
			'logger.time("discoverCustomCommands"',
			'logger.time("discoverAndLoadCustomTools"',
			'logger.time("discoverAndLoadExtensions"',
			'logger.time("loadExtensions"',
		]) {
			expect(sdk).not.toContain(forbidden);
		}
		expect(main).not.toContain("MarketplaceManager");
		expect(main).not.toContain("preloadPluginRoots");
		expect(settingsSchema).not.toContain("Marketplace Auto-Update");
		expect(settingsSchema).not.toContain("Skill Commands");
		expect(settingsSchema).not.toContain("Claude User Commands");
	});

	it("does not register or advertise arbitrary skill internal URLs", async () => {
		const router = await source("internal-urls", "router.ts");
		const barrel = await source("internal-urls", "index.ts");
		const readPrompt = await source("prompts", "tools", "read.md");
		const bashPrompt = await source("prompts", "tools", "bash.md");
		const systemPrompt = await source("prompts", "system", "system-prompt.md");
		const customSystemPrompt = await source("prompts", "system", "custom-system-prompt.md");

		expect(router).not.toContain("SkillProtocolHandler");
		expect(router).not.toContain("skill-protocol");
		expect(barrel).not.toContain("skill-protocol");
		for (const promptText of [readPrompt, bashPrompt, systemPrompt, customSystemPrompt]) {
			expect(promptText).not.toContain("skill://");
		}
	});
});
