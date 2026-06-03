import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { validateToolArguments } from "@gajae-code/ai/utils/validation";
import type { BashInterceptorRule } from "../../src/config/settings-schema";
import type { ToolSession } from "../../src/tools";
import { BashTool, type BashToolInput } from "../../src/tools/bash";

function createBashTool(rules: BashInterceptorRule[]): BashTool {
	const session = {
		settings: {
			get(key: string) {
				if (key === "bashInterceptor.enabled") return true;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			getBashInterceptorRules() {
				return rules;
			},
		},
	} as unknown as ToolSession;

	return new BashTool(session);
}

describe("BashTool interception", () => {
	it("checks the original command before leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cd\\s+",
				tool: "bash",
				message: "Do not hide directory changes in the command string.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && echo ok" }, undefined, undefined, {
				toolNames: ["bash"],
			} as AgentToolContext),
		).rejects.toThrow("Do not hide directory changes");
	});

	it("checks the cwd-normalized command after leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cat\\s+",
				tool: "read",
				message: "Use read instead.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && cat package.json" }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow("Use read instead");
	});
});

describe("BashTool argument validation", () => {
	it("preserves async requests so disabled async mode returns the explicit error", async () => {
		const tool = createBashTool([]);
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "tool-call",
			name: tool.name,
			arguments: { command: "echo should-not-run", async: true },
		});

		await expect(tool.execute("tool-call", args as BashToolInput)).rejects.toThrow(
			"Async bash execution is disabled",
		);
	});
});

describe("BashTool head/tail stripping", () => {
	function createBashToolWithStrip(stripEnabled: boolean): BashTool {
		const session = {
			cwd: process.cwd(),
			getSessionFile: () => null,
			getSessionId: () => undefined,
			settings: {
				get(key: string) {
					if (key === "bashInterceptor.enabled") return false;
					if (key === "async.enabled") return false;
					if (key === "bash.autoBackground.enabled") return false;
					if (key === "bash.autoBackground.thresholdMs") return 60_000;
					if (key === "bash.stripTrailingHeadTail") return stripEnabled;
					return undefined;
				},
				getBashInterceptorRules() {
					return [];
				},
			},
		} as unknown as ToolSession;
		return new BashTool(session);
	}

	it("executes the stripped command", async () => {
		const tool = createBashToolWithStrip(true);
		// `seq 1 100 | head -3` would emit "1\n2\n3"; stripped, it emits 1..100.
		// We assert on the tail of the output rather than head, so a successful
		// strip is observable: line "100" only appears when head is gone.
		const result = await tool.execute("tool-call", { command: "seq 1 100 | head -3" }, undefined, undefined, {
			toolNames: ["bash"],
		} as AgentToolContext);
		const text = result.content.find(b => b.type === "text")?.text ?? "";
		expect(text).toContain("100");
	});

	it("does not strip when the setting is disabled", async () => {
		const tool = createBashToolWithStrip(false);
		const result = await tool.execute("tool-call", { command: "seq 1 100 | head -3" }, undefined, undefined, {
			toolNames: ["bash"],
		} as AgentToolContext);
		const text = result.content.find(b => b.type === "text")?.text ?? "";
		expect(text).toContain("1\n2\n3");
		expect(text).not.toContain("100");
	});
});

describe("BashTool restricted role-agent allowlist", () => {
	function createRestrictedBashTool(
		cwd = process.cwd(),
		bashAllowedPrefixes = ["gjc ralplan --write", "gjc state"],
	): BashTool {
		const session = {
			cwd,
			getSessionFile: () => null,
			getSessionId: () => undefined,
			bashAllowedPrefixes,
			settings: {
				get(key: string) {
					if (key === "bashInterceptor.enabled") return false;
					if (key === "async.enabled") return false;
					if (key === "bash.autoBackground.enabled") return false;
					if (key === "bash.autoBackground.thresholdMs") return 60_000;
					if (key === "bash.stripTrailingHeadTail") return false;
					return undefined;
				},
				getBashInterceptorRules() {
					return [];
				},
			},
		} as unknown as ToolSession;
		return new BashTool(session);
	}

	it("surfaces restricted prefixes in the tool description", () => {
		const tool = createRestrictedBashTool();

		expect(tool.description).toContain("This session's bash tool is restricted");
		expect(tool.description).toContain("gjc ralplan --write");
		expect(tool.description).toContain("gjc state");
	});

	it("blocks non-allowlisted commands before execution", async () => {
		const tool = createRestrictedBashTool();

		await expect(tool.execute("tool-call", { command: "echo should-not-run" })).rejects.toThrow(
			"restricted role-agent bash only allows commands starting with",
		);
	});

	it("blocks ralplan invocations that are not artifact writes", async () => {
		const tool = createRestrictedBashTool();

		await expect(tool.execute("tool-call", { command: "gjc ralplan --consensus 'task'" })).rejects.toThrow(
			"gjc ralplan --write",
		);
	});

	it("blocks per-command env overrides in restricted mode", async () => {
		const tool = createRestrictedBashTool();

		await expect(
			tool.execute("tool-call", {
				command: "gjc ralplan --write --stage architect --stage_n 1 --artifact ok",
				env: { PATH: "/tmp/fake" },
			}),
		).rejects.toThrow("does not allow per-command env overrides");
	});

	it("marks restricted CLI subprocesses so ralplan does not ingest artifact file paths", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-restricted-bash-"));
		try {
			const artifactPath = path.join(root, "secret.md");
			await fs.writeFile(artifactPath, "# Secret\nshould-not-be-read\n");
			const cliPath = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
			const bunPath = process.execPath;
			const tool = createRestrictedBashTool(root, [`${bunPath} ${cliPath} ralplan --write`]);
			const result = await tool.execute("tool-call", {
				command: `${bunPath} ${cliPath} ralplan --write --stage architect --stage_n 1 --artifact ${artifactPath} --run-id bash-marker`,
				timeout: 30,
			});

			expect(result.content.find(part => part.type === "text")?.text).toContain("stage-01-architect.md");
			const persisted = await fs.readFile(
				path.join(root, ".gjc", "plans", "ralplan", "bash-marker", "stage-01-architect.md"),
				"utf-8",
			);
			expect(persisted).toBe(`${artifactPath}\n`);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
