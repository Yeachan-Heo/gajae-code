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
		expect(guide).toContain("SDK WebSocket integration");
		expect(guide).toContain("have been removed");
		expect(guide).not.toContain("RPC lifecycle below");
		expect(guide).not.toContain("gjc --mode " + "rpc");
		expect(guide).not.toContain("docs/rpc.md");
		expect(guide).not.toContain("docs/bridge.md");
		expect(guide).toContain("gjc_coordinator_register_session");
		expect(guide).toContain("SDK-discoverable session");
		expect(guide).toContain("advisory process metadata only");
		expect(guide).not.toContain("visible tmux fallback");
		expect(guide).toContain("active_turn_exists");
		expect(guide).toContain("Provider/auth failure");
		expect(guide).toContain("Coordinator cancellation");
		expect(guide).toContain('status: "cancelled"');
		expect(guide).toContain("not process control");

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

	it("documents Aside as an opt-in search/context sidecar only", async () => {
		const guide = await readRepoFile("docs", "aside-integration.md");
		const readme = await readRepoFile("README.md");
		const generated = await readRepoFile(
			"packages",
			"coding-agent",
			"src",
			"internal-urls",
			"docs-index.generated.ts",
		);

		expect(guide).toContain("docs-only");
		expect(guide).toContain("aside mcp");
		expect(guide).toContain("gjc mcp add aside aside mcp --project");
		expect(guide).toContain("browser actions and form submissions");
		expect(guide).toContain("login flows, credential autofill, MFA");
		expect(guide).toContain("payments, purchases, subscriptions, billing changes");
		expect(guide).toContain("internal-tool workflows");
		expect(guide).toContain("explicit user-provided endpoint, command, and credentials");
		expect(guide).toContain("no raw browser/session/private payloads");
		expect(guide).toContain("Benign smoke checklist");
		expect(guide).toContain("secrets are redacted");
		expect(readme).toContain("docs/aside-integration.md");
		expect(generated).toContain('"aside-integration.md"');
	});

	it("classifies external control surface readiness against code and smoke coverage", async () => {
		const readiness = await readRepoFile("docs", "external-control-readiness.md");
		const cli = await readRepoFile("packages", "coding-agent", "src", "cli.ts");
		const cliArgs = await readRepoFile("packages", "coding-agent", "src", "cli", "args.ts");
		const acpCommand = await readRepoFile("packages", "coding-agent", "src", "commands", "acp.ts");
		const mcpCommand = await readRepoFile("packages", "coding-agent", "src", "commands", "mcp-serve.ts");

		expect(readiness).toContain("# External control readiness");
		expect(readiness).toContain("SDK WebSocket");
		expect(readiness).toContain("Coordinator MCP");
		expect(readiness).toContain("ACP");
		expect(readiness).toContain("have been removed");

		for (const command of ["gjc mcp-serve coordinator", "gjc --mode acp", "gjc acp"]) {
			expect(readiness).toContain(command);
		}

		for (const smoke of [
			"packages/coding-agent/test/sdk-",
			"packages/coding-agent/test/acp-",
			"packages/coding-agent/test/workflow-gate-broker.test.ts",
			"packages/coding-agent/test/workflow-gate-schema.test.ts",
		]) {
			expect(readiness).toContain(smoke);
		}

		expect(cliArgs).toContain('export type Mode = "text" | "json" | "acp"');
		expect(cliArgs).toContain("was removed; external control now uses the Gajae-Code SDK");
		expect(cli).toContain('{ name: "acp", load: () => import("./commands/acp").then(m => m.default) }');
		expect(acpCommand).toContain("Run Gajae Code as an ACP (Agent Client Protocol) server over stdio");
		expect(mcpCommand).toContain('server !== "coordinator" && server !== "hermes"');
	});

	it("documents public-safe lifecycle notification forwarding", async () => {
		const guide = await readRepoFile("docs", "bot-integration.md");

		expect(guide).toContain("Forward finish/stop lifecycle notifications");
		expect(guide).toContain("turn_end");
		expect(guide).toContain("agent_end");
		expect(guide).toContain("gjc_coordinator_watch_events");
		expect(guide).toContain("waiting_for_answer");
		expect(guide).toContain("metadata-only");
		expect(guide).toContain("caller-supplied sanitized summary");
		expect(guide).toContain("does not currently expose a structured stop-reason field on `agent_end`");
		expect(guide).toContain("Do not forward raw prompts, transcripts, tool outputs");
		expect(guide).not.toContain("webhook.site");
		expect(guide).not.toContain("discord.com/api/webhooks");
	});

	it("documents the observational coordinator and hermes check contract", async () => {
		const guide = await readRepoFile("docs", "bot-integration.md");
		const bridge = await readRepoFile("docs", "hermes-mcp-bridge.md");

		for (const content of [guide, bridge]) {
			expect(content).toContain("discovery-only");
			expect(content).toContain("non-mutating");
			expect(content).toContain("catalog");
			expect(content).toContain("broker.discovery_status");
			expect(content).toContain("operational_ready");
			expect(content).toContain("bootstrap_supported");
			expect(content).toContain("bootstrap_attempted");
			expect(content).toContain("unsupported_state_version");
			expect(content).toContain("discovery_access_denied");
			expect(content).toContain("discovery_read_failed");
			expect(content).toContain("does not connect, ensure/bootstrap, write, repair, or delete");
			expect(content).toContain("human output remains the server/tools summary");
		}
		expect(bridge).toContain("identical coordinator check payload");
		expect(guide).toContain("SDK check behavior is separate and unchanged");
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
