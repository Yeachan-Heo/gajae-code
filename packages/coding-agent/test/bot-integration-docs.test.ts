import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { COORDINATOR_MCP_TOOL_NAMES } from "../src/coordinator/contract";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

async function readRepoFile(...segments: string[]): Promise<string> {
	return await Bun.file(path.join(repoRoot, ...segments)).text();
}

const localOnlyLeakFixtures = [
	String.fromCharCode(109, 101, 101, 115, 101, 101, 107, 115, 50),
	`${String.fromCharCode(47, 104, 111, 109, 101)}/${String.fromCharCode(100, 111, 121, 117, 110)}`,
	String.fromCharCode(99, 108, 105, 112, 114, 111, 120, 121),
	`${String.fromCharCode(87, 97, 114, 112)}/tmux`,
	`${String.fromCharCode(47, 116, 109, 112)}/${String.fromCharCode(109, 101, 101, 115, 101, 101, 107, 115, 50)}`,
];

describe("external controller integration docs", () => {
	it("documents the coordinator contract bot authors need", async () => {
		const guide = await readRepoFile("docs", "bot-integration.md");

		expect(guide).toContain("# External controller integration guide");
		expect(guide).toContain("gjc mcp-serve coordinator");
		expect(guide).toContain("gjc setup hermes");
		expect(guide).toContain("compatibility alias, not a separate contract");
		expect(guide).toContain("Generic smoke strategy");
		expect(guide).toContain("Contract smoke");
		expect(guide).toContain("Dry-run lifecycle smoke");
		expect(guide).toContain("Optional live smoke");
		expect(guide).toContain("not privileged integration modes");
		expect(guide).toContain("gjc --mode rpc");
		expect(guide).toContain("gjc_coordinator_register_session");
		expect(guide).toContain("visible tmux fallback");
		expect(guide).toContain("active_turn_exists");
		expect(guide).toContain("Provider/auth failure");
		expect(guide).toContain("Coordinator cancellation");
		expect(guide).toContain('status: "cancelled"');
		expect(guide).toContain("not a tmux process kill");

		for (const toolName of COORDINATOR_MCP_TOOL_NAMES) {
			expect(guide).toContain(toolName);
		}
	});

	it("keeps the guide discoverable from top-level and embedded docs", async () => {
		const readme = await readRepoFile("README.md");
		const overview = await readRepoFile("docs", "codebase-overview.md");
		const generated = await readRepoFile(
			"packages",
			"coding-agent",
			"src",
			"internal-urls",
			"docs-index.generated.ts",
		);

		expect(readme).toContain("docs/bot-integration.md");
		expect(readme).toContain("External controller / bot");
		expect(readme).toContain("provider-independent smokes");
		expect(overview).toContain("docs/bot-integration.md");
		expect(generated).toContain('"bot-integration.md"');
	});

	it("keeps bot integration docs free of local-only operator details", async () => {
		const docs = [
			await readRepoFile("README.md"),
			await readRepoFile("docs", "bot-integration.md"),
			await readRepoFile("docs", "hermes-mcp-bridge.md"),
			await readRepoFile("docs", "codebase-overview.md"),
		];

		for (const content of docs) {
			for (const localOnlyLeak of localOnlyLeakFixtures) {
				expect(content).not.toContain(localOnlyLeak);
			}
		}
	});
});
