import { afterEach, describe, expect, test } from "bun:test";
import {
	getActiveRules,
	type Rule,
	resetActiveRulesForTests,
	setActiveRules,
} from "@gajae-code/coding-agent/capability/rule";
import { TtsrManager } from "@gajae-code/coding-agent/export/ttsr";
import { InternalUrlRouter } from "@gajae-code/coding-agent/internal-urls";
import { buildSystemPrompt } from "../../src/system-prompt";

function rule(name: string, content: string): Rule {
	return {
		name,
		path: `/tmp/${name}.md`,
		content,
		description: `${name} description`,
		globs: ["**/*.rs"],
		_source: { provider: "test", providerName: "test", path: `/tmp/${name}.md`, level: "user" },
	};
}

afterEach(() => {
	resetActiveRulesForTests();
	InternalUrlRouter.resetForTests();
});

describe("session-scoped rule snapshots", () => {
	test("concurrent sessions cannot resolve each other's rule:// snapshots", async () => {
		setActiveRules([rule("alpha", "alpha body")], "session-a");
		setActiveRules([rule("beta", "beta body")], "session-b");

		const router = InternalUrlRouter.instance();
		const a = await router.resolve("rule://alpha", { sessionId: "session-a" });
		expect(a.content).toContain("alpha body");
		await expect(router.resolve("rule://beta", { sessionId: "session-a" })).rejects.toThrow(/Unknown rule: beta/);
		await expect(router.resolve("rule://alpha", { sessionId: "session-b" })).rejects.toThrow(/Unknown rule: alpha/);
		expect(getActiveRules("session-a").map(item => item.name)).toEqual(["alpha"]);
		expect(getActiveRules("session-b").map(item => item.name)).toEqual(["beta"]);
	});

	test("in-process session switch rebinds once-per-session TTSR state", () => {
		const manager = new TtsrManager();
		const inject = rule("rust-skills-inject", "inject");
		inject.mutationTargetGlobs = ["*.rs"];
		inject.repeatMode = "once";
		expect(manager.addRule(inject)).toBe(true);
		expect(manager.checkDelta("x", { source: "tool", toolName: "edit", filePaths: ["src/lib.rs"] })).toEqual([
			inject,
		]);
		manager.markInjected([inject]);
		expect(manager.checkDelta("x", { source: "tool", toolName: "edit", filePaths: ["src/lib.rs"] })).toEqual([]);

		manager.rebindSessionState({ messageCount: 0, records: [] });
		expect(manager.checkDelta("x", { source: "tool", toolName: "edit", filePaths: ["src/lib.rs"] })).toEqual([
			inject,
		]);
	});

	test("rulebook descriptors advertise only when the workspace matches the glob", async () => {
		const rustOnly = rule("rust-skills", "rust body");
		const withTree = await buildSystemPrompt({
			cwd: "/tmp",
			rules: [rustOnly],
			workspaceTree: {
				rootPath: "/tmp",
				rendered: "src/lib.rs\nCargo.toml",
				truncated: false,
				totalLines: 2,
				agentsMdFiles: [],
			},
		});
		expect(withTree.systemPrompt.join("\n")).toContain('name="rust-skills"');

		const withoutRust = await buildSystemPrompt({
			cwd: "/tmp",
			rules: [rustOnly],
			workspaceTree: {
				rootPath: "/tmp",
				rendered: "src/main.ts\npackage.json",
				truncated: false,
				totalLines: 2,
				agentsMdFiles: [],
			},
		});
		expect(withoutRust.systemPrompt.join("\n")).not.toContain('name="rust-skills"');
	});
});
