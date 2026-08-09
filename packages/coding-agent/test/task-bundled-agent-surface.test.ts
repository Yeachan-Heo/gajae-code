import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const agentsEntry = path.join(repoRoot, "packages", "coding-agent", "src", "task", "agents.ts");
const promptsDir = path.join(repoRoot, "packages", "coding-agent", "src", "prompts", "agents");

function extractEmbeddedAgentFileNames(source: string): string[] {
	const defsBlock = source.match(/const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef\[\] = \[([\s\S]*?)\];/);
	if (!defsBlock) return [];
	return [...defsBlock[1].matchAll(/fileName: "([^"]+)"/g)].map(match => match[1]).sort();
}

function extractDeclaredTools(source: string): string[] | undefined {
	const declaration = source.match(/^tools:\s*(.+)$/m);
	return declaration?.[1].split(",").map(name => name.trim());
}

describe("GJC bundled task agent surface", () => {
	it("ships exactly the four canonical role agents", async () => {
		const source = await Bun.file(agentsEntry).text();
		expect(extractEmbeddedAgentFileNames(source)).toEqual(["architect.md", "critic.md", "executor.md", "planner.md"]);

		const promptFiles = Array.from(new Bun.Glob("*.md").scanSync({ cwd: promptsDir })).sort();
		expect(promptFiles).toEqual([
			"architect.md",
			"critic.md",
			"executor.md",
			"frontmatter.md",
			"init.md",
			"planner.md",
		]);
	});
});

describe("GJC bundled role agent tool declarations", () => {
	it("keeps web_search declared on the role agents that ask for it", async () => {
		const declared = new Map<string, string[] | undefined>();
		for (const agent of ["architect", "critic", "executor", "planner"]) {
			const source = await Bun.file(path.join(promptsDir, `${agent}.md`)).text();
			declared.set(agent, extractDeclaredTools(source));
		}

		expect(declared.get("critic")).toEqual(["read", "search", "find", "lsp", "ast_grep", "web_search", "bash", "irc"]);
		expect(declared.get("planner")).toEqual(["read", "search", "find", "lsp", "ast_grep", "web_search", "bash", "irc"]);
		expect(declared.get("architect")).toEqual([
			"read",
			"search",
			"find",
			"lsp",
			"ast_grep",
			"web_search",
			"bash",
			"report_finding",
			"irc",
		]);
		expect(declared.get("executor")).toBeUndefined();
	});
});
