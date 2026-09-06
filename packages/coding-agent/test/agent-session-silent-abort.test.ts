/**
 * AgentSession silent-abort marker tests (Phase 6 — A layer).
 *
 * Asserts that `#handleAgentEvent`:
 *   - stamps `SILENT_ABORT_MARKER` on aborted assistant `message_end` events
 *     when the `#planCompactAbortPending` flag is set and consumes the flag
 *     in the process (A1);
 *   - leaves `errorMessage` untouched (and the flag untouched) when the flag
 *     was never set (A2);
 *   - never consumes the flag on non-aborted message_end (A3);
 *   - stamps the marker BEFORE the obfuscator's display-event copy, so both
 *     the persisted message (in-place mutation) and the emitted display event
 *     (deobfuscated spread copy) carry the marker (A4).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentEvent } from "@gajae-code/agent-core";
import type { AssistantMessage, TextContent } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { SecretObfuscator } from "@gajae-code/coding-agent/secrets/obfuscator";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SILENT_ABORT_MARKER } from "@gajae-code/coding-agent/session/messages";
import { getSessionMessageEntryId, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function makeAbortedAssistantMessage(text = "partial draft"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "aborted",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function makeStoppedAssistantMessage(text = "done"): AssistantMessage {
	return {
		...makeAbortedAssistantMessage(text),
		stopReason: "stop",
	};
}

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

async function createSessionWithObfuscator(obfuscator?: SecretObfuscator): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@pi-silent-abort-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry,
		obfuscator,
	});

	return { tempDir, authStorage, session };
}

describe("AgentSession silent-abort marker stamping", () => {
	let fixture: SessionFixture | undefined;

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("A1: flag set + aborted assistant message_end stamps the marker and clears the flag", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		session.markPlanCompactAbortPending();
		expect(session.isPlanCompactAbortPending).toBe(true);

		const message = makeAbortedAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message });

		// `#handleAgentEvent` runs synchronously up through the stamp before awaiting
		// `#emitSessionEvent`; flush microtasks so observers see the settled state.
		await Promise.resolve();
		await Promise.resolve();

		expect(message.errorMessage).toBe(SILENT_ABORT_MARKER);
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	it("A2: flag unset + aborted assistant message_end leaves errorMessage and flag alone", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		expect(session.isPlanCompactAbortPending).toBe(false);

		const message = makeAbortedAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message });
		await Promise.resolve();
		await Promise.resolve();

		expect(message.errorMessage).toBeUndefined();
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	it("does not let a pending silent abort silence a later real abort", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		const waitForIdleGate = Promise.withResolvers<void>();
		vi.spyOn(session.agent, "waitForIdle").mockImplementation(() => waitForIdleGate.promise);

		const silentAbort = session.abort({ silent: true });
		await Promise.resolve();

		const realAbort = session.abort();
		await Promise.resolve();

		const message = makeAbortedAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message });
		await Promise.resolve();
		await Promise.resolve();

		expect(message.errorMessage).toBeUndefined();

		waitForIdleGate.resolve();
		await Promise.all([silentAbort, realAbort]);
	});

	it("canonically commits and classifies an orphan before publishing the same agent_end object", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		const { scope, dispose: disposeScope } = session.agent.mintSideAttemptScope();
		const seen: AgentSessionEvent[] = [];
		session.subscribe(event => seen.push(event));

		const provisional = makeStoppedAssistantMessage("retained orphan partial");
		session.agent.emitExternalEvent({ type: "message_start", message: provisional, scope });
		session.agent.emitExternalEvent({
			type: "message_update",
			message: provisional,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "retained orphan partial",
				partial: provisional,
			},
			scope,
		});
		const provisionalText = provisional.content[0];
		if (provisionalText?.type === "text") provisionalText.text = "mutated after captured update";
		session.markPlanCompactAbortPending();
		expect(session.isPlanCompactAbortPending).toBe(true);
		const rawAgentEnd: Extract<AgentEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [],
			stopReason: "cancelled",
			scope,
		};
		session.agent.emitExternalEvent(rawAgentEnd);
		let agentEnd: Extract<AgentSessionEvent, { type: "agent_end" }> | undefined;
		for (let attempt = 0; attempt < 50 && !agentEnd; attempt++) {
			await Bun.sleep(1);
			agentEnd = seen.find(
				(event): event is Extract<AgentSessionEvent, { type: "agent_end" }> =>
					event.type === "agent_end" && event.silentAbort === true,
			);
		}
		expect(agentEnd).toBe(rawAgentEnd);
		expect(agentEnd?.silentAbort).toBe(true);
		const recovered = agentEnd?.messages.find((message): message is AssistantMessage => message.role === "assistant");
		expect(recovered?.stopReason).toBe("aborted");
		expect(recovered?.errorMessage).toBe(SILENT_ABORT_MARKER);
		expect(recovered && getSessionMessageEntryId(recovered)).toBeDefined();
		expect(session.agent.state.messages.filter(message => message === recovered)).toHaveLength(1);
		expect(
			session
				.buildDisplaySessionContext()
				.messages.some(
					message =>
						message.role === "assistant" &&
						message.content.some(
							content => content.type === "text" && content.text === "retained orphan partial",
						),
				),
		).toBe(true);
		expect(session.isPlanCompactAbortPending).toBe(false);
		disposeScope();
	});

	it("matches forced recovery by attempt scope after abort advances prompt generation", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		const scope = { attemptId: "forced-orphan", generation: 1, lineage: "main" as const };
		const partial = makeStoppedAssistantMessage("forced partial");
		session.agent.emitExternalEvent({ type: "message_start", message: partial, scope });
		await session.awaitSessionSettlement();
		const beforeAbortGeneration = session.transcriptPromptGeneration;
		await session.abort();
		expect(session.transcriptPromptGeneration).toBeGreaterThan(beforeAbortGeneration);
		const terminal: Extract<AgentEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [],
			stopReason: "cancelled",
			scope,
		};
		session.agent.emitExternalEvent(terminal);
		await session.awaitSessionSettlement();

		const recovered = terminal.messages.find((message): message is AssistantMessage => message.role === "assistant");
		expect(recovered?.stopReason).toBe("aborted");
		expect(recovered?.content).toEqual([{ type: "text", text: "forced partial" }]);
		expect(recovered && getSessionMessageEntryId(recovered)).toBeDefined();
	});

	it("canonically admits an authoritative external terminal without message_end", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		const { scope, dispose: disposeScope } = session.agent.mintSideAttemptScope();
		const presentationMessage = makeStoppedAssistantMessage("external partial");
		const finalMessage = makeStoppedAssistantMessage("external final");
		session.agent.emitExternalEvent({ type: "message_start", message: presentationMessage, scope });
		const terminal: Extract<AgentEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [finalMessage],
			stopReason: "completed",
			scope,
		};
		session.agent.emitExternalEvent(terminal);
		await session.awaitSessionSettlement();

		expect(getSessionMessageEntryId(finalMessage)).toBeDefined();
		expect(getSessionMessageEntryId(presentationMessage)).toBe(getSessionMessageEntryId(finalMessage));
		expect(session.agent.state.messages.filter(message => message === finalMessage)).toHaveLength(1);
		expect(
			session
				.buildDisplaySessionContext()
				.messages.some(
					message =>
						message === finalMessage ||
						getSessionMessageEntryId(message) === getSessionMessageEntryId(finalMessage),
				),
		).toBe(true);
		disposeScope();
	});

	it("persists silent classification on a cancelled authoritative external terminal", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		const finalMessage: AssistantMessage = {
			...makeStoppedAssistantMessage("silent external final"),
			stopReason: "aborted",
		};
		session.markPlanCompactAbortPending();
		session.agent.emitExternalEvent({
			type: "agent_end",
			messages: [finalMessage],
			stopReason: "cancelled",
		});
		await session.awaitSessionSettlement();

		expect(finalMessage.errorMessage).toBe(SILENT_ABORT_MARKER);
		expect(getSessionMessageEntryId(finalMessage)).toBeDefined();
	});

	it("does not recover a predecessor partial after a branch rotates session identity", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "branch root" }],
			timestamp: Date.now(),
		};
		const entryId = session.sessionManager.appendMessage(userMessage);
		session.agent.appendMessage(userMessage);
		const predecessorScope = { attemptId: "predecessor", generation: 7, lineage: "main" as const };
		const partial = makeStoppedAssistantMessage("predecessor partial");
		session.agent.emitExternalEvent({ type: "message_start", message: partial, scope: predecessorScope });
		await Promise.resolve();

		const result = await session.branch(entryId);
		expect(result.cancelled).toBe(false);
		const clonedScope = { ...predecessorScope };
		const lateFinal = makeStoppedAssistantMessage("late cloned-scope final");
		const lateTerminal: Extract<AgentEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [lateFinal],
			stopReason: "completed",
			scope: clonedScope,
			disownedSteering: [
				{
					role: "user",
					content: [{ type: "text", text: "must not rearm in successor" }],
					timestamp: Date.now(),
				},
			],
		};
		session.agent.emitExternalEvent(lateTerminal);
		const unscopedLate = makeStoppedAssistantMessage("late unscoped final");
		session.agent.emitExternalEvent({ type: "message_start", message: unscopedLate });
		session.agent.emitExternalEvent({
			type: "agent_end",
			messages: [unscopedLate],
			stopReason: "completed",
		});
		await session.awaitSessionSettlement();

		expect(getSessionMessageEntryId(lateFinal)).toBeUndefined();
		expect(getSessionMessageEntryId(unscopedLate)).toBeUndefined();
		expect(session.agent.state.messages).not.toContain(lateFinal);
		expect(session.agent.state.messages).not.toContain(unscopedLate);
		expect(session.agent.state.streamMessage).toBeNull();
		expect(session.agent.snapshotSteering()).toHaveLength(0);
		expect(session.agent.snapshotFollowUp()).toHaveLength(0);
		expect(
			session
				.buildDisplaySessionContext()
				.messages.some(
					message =>
						message.role === "assistant" &&
						message.content.some(content => content.type === "text" && content.text === "predecessor partial"),
				),
		).toBe(false);
	});

	it("emits a visible notice when canonical orphan persistence fails", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		const { scope, dispose: disposeScope } = session.agent.mintSideAttemptScope();
		const partial = makeStoppedAssistantMessage("unpersisted partial");
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		session.agent.emitExternalEvent({ type: "message_start", message: partial, scope });
		vi.spyOn(session.sessionManager, "appendMessage").mockImplementationOnce(() => {
			throw new Error("synthetic persistence failure");
		});
		const terminal: Extract<AgentEvent, { type: "agent_end" }> = {
			type: "agent_end",
			messages: [],
			stopReason: "cancelled",
			scope,
		};
		session.agent.emitExternalEvent(terminal);
		await session.awaitSessionSettlement();

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "notice",
				level: "error",
				source: "session-persistence",
			}),
		);
		expect(events).toContain(terminal);
		expect((terminal as Extract<AgentSessionEvent, { type: "agent_end" }>).terminalPersistenceFailed).toBe(true);
		expect(terminal.messages).toHaveLength(0);
		expect(session.agent.state.messages.some(message => message === partial)).toBe(false);
		expect(session.agent.state.streamMessage).toBeNull();
		disposeScope();
		expect(() => session.newSession()).toThrow(expect.objectContaining({ code: "session_persistence_blocked" }));
		const recovery = vi
			.spyOn(session.sessionManager, "recoverPersistenceFailure")
			.mockRejectedValueOnce(new Error("still unreconciled"));
		await expect(session.prompt("must remain fenced")).rejects.toMatchObject({
			code: "session_persistence_blocked",
		});
		await Promise.all([
			session.runWithPromptAdmissionForTests(async () => {}),
			session.runWithPromptAdmissionForTests(async () => {}),
		]);
		expect(recovery).toHaveBeenCalledTimes(2);
		expect(
			events.filter(event => event.type === "notice" && event.source === "terminal-persistence-recovered"),
		).toHaveLength(1);
		expect(
			session
				.buildDisplaySessionContext()
				.messages.filter(
					message =>
						message.role === "assistant" &&
						message.content.some(content => content.type === "text" && content.text === "unpersisted partial"),
				),
		).toHaveLength(1);
	});

	it("A3: flag set + non-aborted message_end does NOT consume the flag", async () => {
		fixture = await createSessionWithObfuscator();
		const { session } = fixture;
		session.markPlanCompactAbortPending();

		// stop reason "stop" — the marker must NOT be stamped and the flag must stay armed.
		const stopMsg = makeStoppedAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message: stopMsg });
		await Promise.resolve();
		await Promise.resolve();

		expect(stopMsg.errorMessage).toBeUndefined();
		expect(session.isPlanCompactAbortPending).toBe(true);

		// Drive an explicit `error` stopReason next — same expectation.
		const errMsg: AssistantMessage = { ...makeStoppedAssistantMessage("err"), stopReason: "error" };
		session.agent.emitExternalEvent({ type: "message_end", message: errMsg });
		await Promise.resolve();
		await Promise.resolve();

		expect(errMsg.errorMessage).toBeUndefined();
		expect(session.isPlanCompactAbortPending).toBe(true);
	});

	it("A4: marker is stamped on event.message BEFORE the obfuscator's displayEvent copy", async () => {
		// Build a real obfuscator with a `plain` secret so `deobfuscateObject(content)`
		// returns a NEW content array — that's the only path that triggers the
		// `displayEvent = { ...event, message: { ...message, content } }` spread copy
		// in `#handleAgentEvent`. The marker must be stamped BEFORE that spread so
		// `displayEvent.message.errorMessage` inherits via the spread.
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "SECRET_VALUE" }]);
		// The test asserts a real deobfuscation diff by checking the emitted content
		// differs from the input ref, which is what we actually care about. The exact
		// placeholder string doesn't matter as long as it's a known secret reference.
		const obfuscatedText = obfuscator.obfuscate("hello SECRET_VALUE world");
		// Sanity: obfuscation produced a placeholder embedded in the text.
		expect(obfuscatedText).not.toBe("hello SECRET_VALUE world");

		fixture = await createSessionWithObfuscator(obfuscator);
		const { session } = fixture;

		// Capture session-emitted events.
		const seen: AgentSessionEvent[] = [];
		session.subscribe(event => {
			seen.push(event);
		});

		session.markPlanCompactAbortPending();

		// Use the obfuscated text as the message content so the deobfuscation walk
		// produces a different content array, exercising the spread-copy branch.
		const message: AssistantMessage = {
			...makeAbortedAssistantMessage(),
			content: [{ type: "text", text: obfuscatedText } as TextContent],
		};
		session.agent.emitExternalEvent({ type: "message_end", message });
		// `#emitSessionEvent` awaits an extension queue + extension dispatch; flush
		// microtasks a few times to settle observers.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// `event.message` (the persistence-side reference) carries the marker via the
		// in-place stamp.
		expect(message.errorMessage).toBe(SILENT_ABORT_MARKER);

		// The emitted display event ALSO carries the marker because the spread copy
		// happened AFTER the stamp.
		const emitted = seen.find(
			(event): event is Extract<AgentSessionEvent, { type: "message_end" }> => event.type === "message_end",
		);
		expect(emitted).toBeDefined();
		if (!emitted) {
			throw new Error("expected a message_end event to be emitted");
		}
		const emittedMessage = emitted.message;
		// `message_end` events are typed against AgentMessage (union over
		// custom/exec/etc. roles too); narrow by asserting `role` so the
		// `errorMessage` / `content` accesses below type-check.
		if (emittedMessage.role !== "assistant") {
			throw new Error("expected emitted message_end to be an assistant message");
		}
		expect(emittedMessage.errorMessage).toBe(SILENT_ABORT_MARKER);
		expect(emitted.silentAbort).toBe(true);
		expect(Object.getOwnPropertyDescriptor(emitted, "silentAbort")?.writable).toBe(false);

		// Prove the obfuscator branch actually ran by asserting the emitted message
		// is a distinct object (post-spread) AND its content was deobfuscated back to
		// the secret text. If the obfuscator branch had been skipped, `emittedMessage`
		// would be `===` to `message` and the content text would still carry the
		// placeholder.
		expect(emittedMessage).not.toBe(message);
		const emittedText = (emittedMessage.content[0] as TextContent).text;
		expect(emittedText).toBe("hello SECRET_VALUE world");

		// Flag is consumed.
		expect(session.isPlanCompactAbortPending).toBe(false);
	});
});
