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
		expect(readme).toContain("docs/external-control-readiness.md");
		expect(overview).toContain("docs/external-control-readiness.md");
		expect(generated).toContain('"external-control-readiness.md"');
	});

	it("classifies external control surface readiness against code and smoke coverage", async () => {
		const readiness = await readRepoFile("docs", "external-control-readiness.md");
		const cliArgs = await readRepoFile("packages", "coding-agent", "src", "cli", "args.ts");
		const acpCommand = await readRepoFile("packages", "coding-agent", "src", "commands", "acp.ts");
		const mcpCommand = await readRepoFile("packages", "coding-agent", "src", "commands", "mcp-serve.ts");
		const bridgeMode = await readRepoFile("packages", "coding-agent", "src", "modes", "bridge", "bridge-mode.ts");

		expect(readiness).toContain("# External control surface readiness");
		expect(readiness).toContain("Coordinator MCP | Preferred multi-session bot/control-plane surface");
		expect(readiness).toContain("RPC stdio | Stable subprocess worker surface");
		expect(readiness).toContain("ACP mode | Editor/ACP client surface");
		expect(readiness).toContain("Bridge HTTPS | Experimental, fail-closed remote session-control surface");
		expect(readiness).toContain(
			"Do not document events, commands, controller ownership, UI responses, host tool results, or host URI results as enabled by default",
		);
		expect(readiness).toContain("Optional live smokes are useful diagnostics");

		for (const command of [
			"gjc mcp-serve coordinator",
			"gjc --mode rpc",
			"gjc --mode acp",
			"gjc acp",
			"gjc --mode bridge",
		]) {
			expect(readiness).toContain(command);
		}

		for (const smoke of [
			"packages/coding-agent/test/coordinator-mcp.test.ts",
			"packages/coding-agent/test/setup-cli.test.ts",
			"packages/coding-agent/test/rpc-unattended-stdio.test.ts",
			"packages/coding-agent/test/rpc-client.start.test.ts",
			"packages/coding-agent/test/acp-initialize-conformance.test.ts",
			"packages/coding-agent/test/acp-stdout-hygiene.test.ts",
			"packages/coding-agent/test/bridge/bridge-mode-handler.test.ts",
			"packages/bridge-client/test/bridge-client.test.ts",
		]) {
			expect(readiness).toContain(smoke);
		}

		expect(cliArgs).toContain('export type Mode = "text" | "json" | "rpc" | "acp" | "rpc-ui" | "bridge"');
		expect(acpCommand).toContain("Run Gajae Code as an ACP (Agent Client Protocol) server over stdio");
		expect(mcpCommand).toContain('server !== "coordinator" && server !== "hermes"');
		expect(bridgeMode).toContain("const FAIL_CLOSED_BRIDGE_ENDPOINTS");
		for (const endpoint of ["events", "commands", "control", "uiResponses", "hostToolResults", "hostUriResults"]) {
			expect(bridgeMode).toContain(`${endpoint}: false`);
		}
	});

	it("keeps bot integration docs free of local-only operator details", async () => {
		const docs = [
			await readRepoFile("README.md"),
			await readRepoFile("docs", "bot-integration.md"),
			await readRepoFile("docs", "hermes-mcp-bridge.md"),
			await readRepoFile("docs", "codebase-overview.md"),
			await readRepoFile("docs", "external-control-readiness.md"),
		];

		for (const content of docs) {
			for (const localOnlyLeak of localOnlyLeakFixtures) {
				expect(content).not.toContain(localOnlyLeak);
			}
		}
	});
});
