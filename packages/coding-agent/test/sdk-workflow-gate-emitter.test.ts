import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import type { WorkflowGateEmitter } from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-session";
import type { OpenGateInput } from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { Settings } from "../src/config/settings";
import { SessionManager } from "../src/session/session-manager";

/**
 * G011 regression: the SDK-built ToolSession MUST forward getWorkflowGateEmitter
 * from the AgentSession, otherwise the real ask tool never emits workflow gates
 * in negotiated unattended RPC sessions (the bug found in review 38-ArchG011Review).
 */
describe("SDK ToolSession forwards getWorkflowGateEmitter (G011 real wiring)", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	it("makes the real ask tool emit a workflow_gate when an emitter is attached to the session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		try {
			const received: OpenGateInput[] = [];
			const emitter: WorkflowGateEmitter = {
				isUnattended: () => true,
				emitGate: input => {
					received.push(input);
					return Promise.resolve({ selected: ["JWT"], other: false });
				},
			};
			session.setWorkflowGateEmitter(emitter);
			expect(session.getWorkflowGateEmitter()).toBe(emitter);

			const askTool = session.getToolByName("ask");
			expect(askTool).toBeDefined();

			const ctx = {
				hasUI: true,
				ui: { select: async () => undefined, editor: async () => undefined },
				abort: () => {},
			} as unknown as AgentToolContext;

			const result = await askTool!.execute(
				"call-1",
				{ questions: [{ id: "auth", question: "Which auth?", options: [{ label: "JWT" }, { label: "OAuth2" }] }] },
				undefined,
				undefined,
				ctx,
			);
			// The real SDK toolSession forwarded the emitter -> the ask tool emitted a gate.
			expect(received).toHaveLength(1);
			expect(received[0].stage).toBe("deep-interview");
			expect(JSON.stringify(result.details)).toContain("JWT");
		} finally {
			await session.dispose();
		}
	});
});
