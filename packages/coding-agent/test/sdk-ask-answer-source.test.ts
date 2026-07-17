import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { registerAskAnswerSource } from "@gajae-code/coding-agent/tools/ask-answer-registry";

/**
 * Regression for the "ask buttons only appear after finalize" report: the
 * production ToolSession built by createAgentSession must forward
 * getAskAnswerSource, otherwise AskTool.execute never reaches the notifications
 * awaitAnswer path and never broadcasts action_needed at invocation. A unit test
 * that constructs AskTool directly does NOT cover this — the bug lived in the SDK
 * toolSession literal, not in AskTool.
 */
describe("createAgentSession wires getAskAnswerSource into built-in AskTool", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("invokes the registered ask answer source before opening the local selector", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ask-source-"));
		tempDirs.push(tempDir);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			hasUI: true,
		});
		session.setWorkflowGateEmitter(undefined);

		try {
			const order: string[] = [];
			registerAskAnswerSource(session.sessionId, {
				awaitAnswer: async () => undefined,
				awaitAnswerRequest: async () => {
					order.push("remote");
					return {
						source: "remote" as const,
						interaction: { kind: "value" as const, value: "yes" },
						settle: async settlement =>
							settlement.kind === "commit"
								? { kind: "committed" as const, ack: { status: "delivered" as const, messageId: 1 } }
								: { kind: "resolved_without_commit" as const },
					};
				},
			});

			const askTool = session.getToolByName("ask");
			expect(askTool).toBeDefined();

			const context = {
				hasUI: true,
				ui: {
					select: async () => {
						order.push("local");
						return "yes";
					},
					editor: async () => undefined,
				},
				abort: () => {},
			} as unknown as AgentToolContext;

			const result = await askTool!.execute(
				"call-prod-ask",
				{ questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] },
				undefined,
				undefined,
				context,
			);

			// The remote source must be consulted (proving the SDK forwarded
			// getAskAnswerSource), and at invocation — before the local selector.
			expect(order[0]).toBe("remote");
			expect(result.content[0]?.type).toBe("text");
			if (result.content[0]?.type === "text") expect(result.content[0].text).toContain("yes");
		} finally {
			await session.dispose?.();
		}
	}, 20_000);
});
