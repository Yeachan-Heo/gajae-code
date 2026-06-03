import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import { getDeepInterviewMutationDecision } from "../../src/skill-state/deep-interview-mutation-guard";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acl-gate-"));
	const priorSessionId = process.env.GJC_SESSION_ID;
	delete process.env.GJC_SESSION_ID;
	try {
		await fn(dir);
	} finally {
		if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function tool(name: string, extra: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		...extra,
	} as AgentTool;
}

describe("G2 gjc ACL gate", () => {
	it("blocks mutation tools targeting .gjc paths", async () => {
		await withTempCwd(async cwd => {
			const blockedCases: Array<[AgentTool, unknown]> = [
				[tool("write"), { path: ".gjc/state/foo.json", content: "{}" }],
				[tool("edit"), { path: ".gjc/specs/spec.md", edits: [{ old_text: "a", new_text: "b" }] }],
				[tool("ast_edit"), { paths: [".gjc/state/foo.json"], ops: [{ pat: "foo", out: "bar" }] }],
				[tool("bash"), { command: "echo x > .gjc/state/foo.json" }],
				[tool("bash"), { command: "rm -rf .gjc/specs" }],
			];

			for (const [targetTool, args] of blockedCases) {
				const decision = await getDeepInterviewMutationDecision({ cwd, tool: targetTool, args });
				expect(decision.blocked).toBe(true);
				expect(decision.message).toContain("runtime-owned");
				if (decision.reason !== "unknown-target") {
					expect(["gjc-target", "workflow-state-target"]).toContain(decision.reason as string);
				}
			}
		});
	});

	it("allows sanctioned gjc bash commands and non-.gjc writes", async () => {
		await withTempCwd(async cwd => {
			const gjcCommand = await getDeepInterviewMutationDecision({
				cwd,
				tool: tool("bash"),
				args: { command: "gjc state ralplan write --input '{}'" },
			});
			expect(gjcCommand.blocked).toBe(false);

			const productWrite = await getDeepInterviewMutationDecision({
				cwd,
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(productWrite.blocked).toBe(false);
		});
	});
});
