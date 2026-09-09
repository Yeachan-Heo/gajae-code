import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, ownedCompletionResumeAction } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	lookupOwnedRegistration,
	registerOwnedRegistration,
	registerTerminalTurnScope,
	resetTerminalAbortRegistriesForTests,
	type TurnRegistrationKey,
} from "@gajae-code/coding-agent/session/terminal-abort";
import { TempDir } from "@gajae-code/utils";

describe("owned follow-up admission", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-owned-admission-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		resetTerminalAbortRegistriesForTests();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		resetTerminalAbortRegistriesForTests();
		tempDir.removeSync();
	});

	function buildSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
		const agent = new Agent({
			initialState: { model, tools: [], systemPrompt: ["Test"] },
			getApiKey: () => "test-key",
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		return { agent, mock, model };
	}

	function completion(id: string, enabled: boolean) {
		const registration: TurnRegistrationKey = {
			endpointId: session!.sessionManager.getSessionId(),
			endpointGeneration: 0,
			lineageIdHash: `lineage-${id}`,
			promptAttemptEpoch: 7,
			jobId: id,
			jobGeneration: `generation-${id}`,
		};
		registerTerminalTurnScope({
			lineageIdHash: registration.lineageIdHash,
			promptAttemptEpoch: registration.promptAttemptEpoch,
			ownedCompletionPolicy: enabled ? "enabled" : "disabled",
		});
		registerOwnedRegistration(registration, { isJobTerminal: () => true });
		const message: AgentMessage = {
			role: "custom",
			customType: "task-notification",
			content: `completion-${id}`,
			display: false,
			timestamp: 1,
			details: {
				ownedCompletions: [
					{
						lineageIdHash: registration.lineageIdHash,
						promptAttemptEpoch: registration.promptAttemptEpoch,
						registration,
					},
				],
			},
		};
		const lookup = () => lookupOwnedRegistration(id, registration.jobGeneration, registration.endpointId);
		return { message, lookup };
	}

	for (const tail of ["assistant", "toolResult"] as const) {
		for (const rejection of ["no model", "maintenance owner"] as const) {
			it(`retains real authority after ${rejection} with ${tail} tail, then delivers exactly once`, async () => {
				const { agent, mock, model } = buildSession();
				// A real completed turn supplies the assistant history for continue().
				await agent.prompt("seed");
				if (tail === "toolResult")
					agent.appendMessage({
						role: "toolResult",
						toolCallId: "seed-call",
						toolName: "seed",
						content: [{ type: "text", text: "seed-result" }],
						isError: false,
						timestamp: 1,
					});
				const allowed = completion("allowed", true);
				const denied = completion("denied", false);
				agent.restoreFollowUp([denied.message, allowed.message]);
				agent.markFollowUpBatch([denied.message, allowed.message]);
				expect(ownedCompletionResumeAction(allowed.message)).toBe("fresh");
				expect(ownedCompletionResumeAction(denied.message)).toBe("drop");
				const resume = tail === "assistant" ? agent.continue.bind(agent) : agent.continueQueuedMessages.bind(agent);
				const accepted: AgentMessage[][] = [];
				if (rejection === "no model") agent.setModel(undefined);
				await expect(
					resume({
						maintenanceContinuation: rejection === "maintenance owner",
						onRunAccepted: (_handle, acceptance) => accepted.push([...acceptance.consumedQueuedMessages]),
					}),
				).rejects.toThrow(
					rejection === "no model" ? "No model configured" : "Maintenance continuation ownership is unavailable",
				);
				expect(accepted).toHaveLength(0);
				expect(mock.calls).toHaveLength(1);
				expect(agent.snapshotFollowUp()).toHaveLength(1);
				expect(agent.snapshotFollowUp()[0]).toBe(allowed.message);
				expect(allowed.lookup()).toBeDefined();
				expect(ownedCompletionResumeAction(allowed.message)).toBe("fresh");
				expect(denied.lookup()).toBeUndefined();
				// Restore only the model, never re-register or replace the completion.
				agent.setModel(model);
				await resume({
					onRunAccepted: (_handle, acceptance) => {
						accepted.push([...acceptance.consumedQueuedMessages]);
						expect(allowed.lookup()).toBeUndefined();
					},
				});
				expect(accepted).toHaveLength(1);
				expect(accepted[0]).toEqual([allowed.message]);
				expect(agent.state.messages.filter(message => message === allowed.message)).toHaveLength(1);
				expect(agent.state.messages).not.toContain(denied.message);
				expect(mock.calls).toHaveLength(2);
				const context = JSON.stringify(mock.calls[1]?.context.messages);
				expect(context.split("completion-allowed")).toHaveLength(2);
				expect(context).not.toContain("completion-denied");
				expect(agent.hasQueuedMessages()).toBe(false);
				expect(allowed.lookup()).toBeUndefined();
			});
		}
	}

	it("settles a real owned follow-up consumed inside an admitted run", async () => {
		const { agent, mock } = buildSession();
		const allowed = completion("in-run", true);
		let registrationAtAdmission = false;
		await agent.prompt("seed", {
			onRunAccepted: () => {
				registrationAtAdmission = allowed.lookup() !== undefined;
				agent.followUp(allowed.message);
			},
		});
		expect(registrationAtAdmission).toBe(true);
		expect(allowed.lookup()).toBeUndefined();
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[0]?.context.messages)).not.toContain("completion-in-run");
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("completion-in-run");
		expect(agent.state.messages.filter(message => message === allowed.message)).toHaveLength(1);
	});
});
