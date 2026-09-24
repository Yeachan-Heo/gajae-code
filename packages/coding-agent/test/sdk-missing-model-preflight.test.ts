import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { type ControlSurface, dispatchControl } from "../src/sdk/host/control";
import { OPERATIONS } from "../src/sdk/protocol/operation-registry";

/**
 * A session that reaches SDK prompt admission with no effective model must
 * answer with a known, safe diagnostic instead of a generic internal error,
 * while every other failure keeps its existing classification and redaction.
 *
 * The expected code/message are asserted as literals on purpose: they are the
 * externally visible control-protocol contract, not an implementation detail
 * that may be re-exported and drift.
 */
const EXPECTED_CODE = "model_not_selected";
const EXPECTED_MESSAGE = "No model is selected for this session. Select a model before submitting a prompt.";

const PROMPT_ROW = OPERATIONS.find(operation => operation.sdkId === "turn.prompt");
if (!PROMPT_ROW) throw new Error("Expected a turn.prompt operation row");
const ABORT_AND_PROMPT_ROW = OPERATIONS.find(operation => operation.sdkId === "turn.abort_and_prompt");
if (!ABORT_AND_PROMPT_ROW) throw new Error("Expected a turn.abort_and_prompt operation row");

const sessions: AgentSession[] = [];
const tempDirs: TempDir[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
});

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	streamCalls: () => number;
}

/**
 * Real producer: `prompt` delegates to the live `AgentSession.prompt` preflight.
 * Nothing here throws a control error on the session's behalf, so the
 * classification under test is the one production actually produces.
 */
function promptSurface(harness: Harness, accepted: string[], method: "prompt" | "abortAndPrompt"): ControlSurface {
	const invoke = async (text: string) => {
		await harness.session.prompt(text);
		accepted.push(text);
		return { accepted: true };
	};
	return { [method]: invoke } as unknown as ControlSurface;
}

function sessionWithoutModel(): Harness {
	const tempDir = TempDir.createSync("@gjc-missing-model-preflight-");
	tempDirs.push(tempDir);
	let streamCalls = 0;
	const mock = createMockModel({ responses: [{ content: ["ok"] }] });
	const agent = new Agent({
		// The exact failing state: prompt admission with no resolved model.
		initialState: { model: undefined, systemPrompt: ["test"], messages: [], tools: [] },
		streamFn: (model, context, options) => {
			streamCalls++;
			return mock.stream(model, context, options);
		},
	});
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "registry-api-key", getAvailable: () => [] } as never,
	});
	sessions.push(session);
	return { session, sessionManager, streamCalls: () => streamCalls };
}

function sessionWithModel(getApiKey: () => Promise<string | undefined>): Harness {
	const tempDir = TempDir.createSync("@gjc-missing-model-preflight-credential-");
	tempDirs.push(tempDir);
	let streamCalls = 0;
	const mock = createMockModel({ responses: [{ content: ["ok"] }] });
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [] },
		streamFn: (model, context, options) => {
			streamCalls++;
			return mock.stream(model, context, options);
		},
	});
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey, getAvailable: () => [mock.model] } as never,
	});
	sessions.push(session);
	return { session, sessionManager, streamCalls: () => streamCalls };
}

/**
 * Real session-side evidence that no turn was admitted for this request: live
 * agent state, the durable transcript, the provider stream and the dispatch
 * result are all checked, not just the surface callback.
 *
 * The preflight does run before the model check, so the transcript can hold a
 * pre-admission `custom` routing entry that quotes the prompt text. That entry
 * is bookkeeping, not an admitted turn: no user message is committed and no
 * provider call happens.
 */
function assertNothingAdmitted(harness: Harness, accepted: string[]): void {
	expect(accepted).toEqual([]);
	expect(harness.streamCalls()).toBe(0);
	expect(harness.session.isStreaming).toBe(false);
	// No user turn entered live agent state...
	expect(harness.session.agent.state.messages.filter(message => message.role === "user")).toEqual([]);
	// ...and no message entry of any role was committed to the transcript.
	expect(harness.sessionManager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
}

describe("SDK turn.prompt missing-model preflight diagnostic", () => {
	it("maps the live missing-model preflight failure to a safe typed control error", async () => {
		const harness = sessionWithoutModel();
		const accepted: string[] = [];

		const response = await dispatchControl(promptSurface(harness, accepted, "prompt"), PROMPT_ROW, {
			id: "req-missing-model",
			operation: "turn.prompt",
			input: { text: "unadmitted-prompt-text" },
		});

		expect(response.ok).toBe(false);
		expect(response.error?.code).toBe(EXPECTED_CODE);
		expect(response.error?.message).toBe(EXPECTED_MESSAGE);
		// Pre-acceptance rejection: no result, so no correlation was ever issued.
		expect(response.result).toBeUndefined();
		assertNothingAdmitted(harness, accepted);
	});

	it("does not leak onboarding provider, command, path, or credential detail publicly", async () => {
		const harness = sessionWithoutModel();

		const response = await dispatchControl(promptSurface(harness, [], "prompt"), PROMPT_ROW, {
			id: "req-missing-model-redaction",
			operation: "turn.prompt",
			input: { text: "hello" },
		});

		const publicText = JSON.stringify(response);
		for (const leak of ["/provider", "gjc setup provider", "--api-key-env", "--base-url", "/login", "OAuth"]) {
			expect(publicText).not.toContain(leak);
		}
	});

	it("classifies the same preflight failure for turn.abort_and_prompt", async () => {
		const harness = sessionWithoutModel();
		const accepted: string[] = [];

		const response = await dispatchControl(promptSurface(harness, accepted, "abortAndPrompt"), ABORT_AND_PROMPT_ROW, {
			id: "req-missing-model-abort-and-prompt",
			operation: "turn.abort_and_prompt",
			input: { text: "unadmitted-abort-prompt-text" },
		});

		expect(response.ok).toBe(false);
		expect(response.error?.code).toBe(EXPECTED_CODE);
		expect(response.error?.message).toBe(EXPECTED_MESSAGE);
		expect(response.result).toBeUndefined();
		assertNothingAdmitted(harness, accepted);
	});

	it("keeps a missing credential distinct from a missing model", async () => {
		const harness = sessionWithModel(async () => undefined);
		const accepted: string[] = [];

		const response = await dispatchControl(promptSurface(harness, accepted, "prompt"), PROMPT_ROW, {
			id: "req-missing-credential",
			operation: "turn.prompt",
			input: { text: "hello" },
		});

		expect(response.ok).toBe(false);
		expect(response.error?.code).toBe("internal");
		expect(response.error?.message).toBe("Control operation failed.");
		expect(accepted).toEqual([]);
	});

	it("keeps an arbitrary producer exception generic", async () => {
		const harness = sessionWithModel(async () => {
			throw new Error("boom: /Users/secret/path token=abcd");
		});

		const response = await dispatchControl(promptSurface(harness, [], "prompt"), PROMPT_ROW, {
			id: "req-arbitrary",
			operation: "turn.prompt",
			input: { text: "hello" },
		});

		expect(response.ok).toBe(false);
		expect(response.error?.code).toBe("internal");
		expect(response.error?.message).toBe("Control operation failed.");
		expect(JSON.stringify(response)).not.toContain("token=abcd");
	});

	it("preserves the existing not-found classification", async () => {
		const surface = {
			prompt: async () => {
				throw new Error("session not found");
			},
		} as unknown as ControlSurface;

		const response = await dispatchControl(surface, PROMPT_ROW, {
			id: "req-not-found",
			operation: "turn.prompt",
			input: { text: "hello" },
		});

		expect(response.ok).toBe(false);
		expect(response.error?.code).toBe("resource_gone");
	});
});
