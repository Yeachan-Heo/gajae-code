/**
 * Phase 6 — E layer.
 *
 * Tests the skill-queue + custom-role dequeue contract that ties together:
 *   - InputController.#invokeSkillCommand (tag generation when streaming);
 *   - AgentSession.enqueueCustomMessageDisplay + #handleAgentEvent's
 *     custom-role `message_start` dequeue;
 *   - UiHelpers.updatePendingMessagesDisplay (compact slash-form rendering);
 *   - InputController.restoreQueuedMessagesToEditor (recovery of the slash-form
 *     into the editor).
 *
 * Tests split into:
 *   - E1-E3: InputController-side tag generation, stubbed session;
 *   - E4-E7: Real AgentSession driving synthetic `message_start` events
 *            for the tag-based custom-role dequeue;
 *   - E8: real UiHelpers render against a queued-display entry;
 *   - E9: real InputController.restoreQueuedMessagesToEditor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { getEmbeddedDefaultGjcSkills } from "@gajae-code/coding-agent/defaults/gjc-defaults";
import { resolveSkillSlashCommands, type Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Container } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";

// ============================================================================
// Shared helpers
// ============================================================================

function writeSkillFile(dir: string, skillName: string, body: string): string {
	const skillPath = path.join(dir, `${skillName}.md`);
	fs.writeFileSync(skillPath, `---\nname: ${skillName}\n---\n${body}\n`);
	return skillPath;
}

function isBusyRmError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
}

async function removeTempDirWithRetry(tempDir: TempDir): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			await fs.promises.rm(tempDir.path(), { recursive: true, force: true });
			return;
		} catch (error) {
			if (!isBusyRmError(error)) {
				throw error;
			}
			if (attempt === 9) {
				// Windows can keep the SQLite temp directory busy after close; do
				// not fail queue-behavior assertions on best-effort cleanup.
				return;
			}
			await Bun.sleep(100);
		}
	}
}

// ============================================================================
// E1-E3: InputController tag generation with a stubbed session.
// ============================================================================

type StubEditor = {
	setText: (text: string) => void;
	getText: () => string;
	addToHistory: ReturnType<typeof vi.fn>;
	onSubmit?: (text: string) => Promise<void>;
};

function createStubInputControllerContext(opts: {
	skillCommands: Map<string, Skill>;
	isStreaming: boolean;
	busyPromptMode?: "steer" | "queue";
}) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
	};
	const enqueueCustomMessageDisplay = vi.fn((_text: string, _mode: "steer" | "followUp") => "sk-test-0");
	// Annotate parameters so `mock.calls[N]` is typed as a tuple (not `[]`) and
	// `message` carries required skill prompt details for assertion below.
	const promptCustomMessage = vi.fn(
		async (_message: { content: string; details: SkillPromptDetails }, _options?: unknown) => {},
	);
	const sendCustomMessage = vi.fn(async (_message: { content: string; details: SkillPromptDetails }) => {});
	const prompt = vi.fn(async (_text: string, _options?: { streamingBehavior?: "steer" | "followUp" }) => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();

	const ctx = {
		editor,
		ui: { requestRender },
		skillCommands: opts.skillCommands,
		session: {
			sessionId: "stub-session",
			isStreaming: opts.isStreaming,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			enqueueCustomMessageDisplay,
			sendCustomMessage,
			promptCustomMessage,
			prompt,
		},
		settings: {
			get: (key: string) => (key === "busyPromptMode" ? opts.busyPromptMode : undefined),
		},
		sessionManager: {
			getCwd: () => process.cwd(),
		},
		showError,
		updatePendingMessagesDisplay,
		// Defaults that InputController touches on submit but don't matter here.
		isBashMode: false,
		isPythonMode: false,
		pendingImages: [],
		isBackgrounded: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, enqueueCustomMessageDisplay, promptCustomMessage, sendCustomMessage, prompt };
}

describe("InputController #invokeSkillCommand (E1-E3)", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, Skill>;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-skill-queue-stub-");
		const skillPath = writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, Skill>([
			[
				"skill:test-skill",
				{
					name: "test-skill",
					description: "Test skill",
					filePath: skillPath,
					baseDir: tempDir.path(),
					source: "test",
				},
			],
		]);
		const skill = skillCommands.get("skill:test-skill");
		if (!skill) throw new Error("expected test skill");
		skillCommands.set("test-skill", skill);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("E1: streaming + explicit steer setting -> enqueueCustomMessageDisplay called and details.__pendingDisplayTag set", async () => {
		const { ctx, editor, enqueueCustomMessageDisplay, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
			busyPromptMode: "steer",
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(enqueueCustomMessageDisplay).toHaveBeenCalledTimes(1);
		expect(enqueueCustomMessageDisplay).toHaveBeenCalledWith("/skill:test-skill arg1 arg2", "steer");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		const firstCall = promptCustomMessage.mock.calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) {
			throw new Error("expected promptCustomMessage to be called");
		}
		const messageArg = firstCall[0];
		expect(messageArg.details.__pendingDisplayTag).toBe("sk-test-0");
	});

	it("E2: streaming + followUp -> enqueueCustomMessageDisplay called with mode 'followUp', tag embedded", async () => {
		const { ctx, editor, enqueueCustomMessageDisplay, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});

		const controller = new InputController(ctx);
		editor.setText("/skill:test-skill arg1 arg2");
		// `handleFollowUp` is the Ctrl+Enter dispatcher; it routes through the same
		// `#invokeSkillCommand` helper with mode "followUp".
		await controller.handleFollowUp();

		expect(enqueueCustomMessageDisplay).toHaveBeenCalledWith("/skill:test-skill arg1 arg2", "followUp");

		const firstCall = promptCustomMessage.mock.calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) {
			throw new Error("expected promptCustomMessage to be called");
		}
		const messageArg = firstCall[0];
		expect(messageArg.details.__pendingDisplayTag).toBe("sk-test-0");
	});

	it("E3b: embedded default skill command does not require .gjc on disk", async () => {
		const embedded = getEmbeddedDefaultGjcSkills().find(skill => skill.name === "deep-interview");
		if (!embedded) throw new Error("expected embedded deep-interview skill");
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands: new Map<string, Skill>([["skill:deep-interview", embedded]]),
			isStreaming: false,
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:deep-interview clarify this");
		await editor.onSubmit?.("/skill:deep-interview clarify this");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		const firstCall = promptCustomMessage.mock.calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) throw new Error("expected promptCustomMessage to be called");
		const messageArg = firstCall[0];
		expect(messageArg.content).toContain("Deep Interview");
		expect(messageArg.details.path).toBe("embedded:gjc/skills/deep-interview/SKILL.md");
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("E3c: compaction queue flush replays /skill entries through the skill custom-message path", async () => {
		const { ctx, prompt, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});
		ctx.compactionQueuedMessages.push({ text: "/skill:test-skill from compaction", mode: "followUp" });

		const uiHelpers = new UiHelpers(ctx);
		await uiHelpers.flushCompactionQueue();

		expect(prompt).not.toHaveBeenCalled();
		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		const firstCall = promptCustomMessage.mock.calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) {
			throw new Error("expected promptCustomMessage to be called");
		}
		const messageArg = firstCall[0];
		expect(messageArg.content).toContain("Do the thing.");
		expect(messageArg.content).toContain("User: from compaction");
		expect(firstCall[1]).toEqual({ streamingBehavior: "followUp" });
		expect(ctx.compactionQueuedMessages).toEqual([]);
	});

	it("E3: not streaming -> enqueueCustomMessageDisplay NOT called and tag absent", async () => {
		const { ctx, editor, enqueueCustomMessageDisplay, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(enqueueCustomMessageDisplay).not.toHaveBeenCalled();
		const firstCall = promptCustomMessage.mock.calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) {
			throw new Error("expected promptCustomMessage to be called");
		}
		const messageArg = firstCall[0];
		expect(messageArg.details.__pendingDisplayTag).toBeUndefined();
	});

	it("dispatches inline canonical skill commands with surrounding prompt text as args", async () => {
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("please use /skill:test-skill for this plan");
		await editor.onSubmit?.("please use /skill:test-skill for this plan");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		expect(promptCustomMessage.mock.calls[0]?.[0].content).toContain("Do the thing.");
		expect(promptCustomMessage.mock.calls[0]?.[0].content).toContain("User: please use for this plan");
	});

	it("dispatches chained canonical skill commands in order while idle", async () => {
		const secondSkillPath = writeSkillFile(tempDir.path(), "second-skill", "Do the second thing.");
		skillCommands.set("skill:second-skill", {
			name: "second-skill",
			description: "Second skill",
			filePath: secondSkillPath,
			baseDir: tempDir.path(),
			source: "test",
		});
		const { ctx, editor, sendCustomMessage, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill alpha /skill:second-skill beta gamma");
		await editor.onSubmit?.("/skill:test-skill alpha /skill:second-skill beta gamma");

		expect(sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		expect(sendCustomMessage.mock.calls[0]?.[0].content).toContain("Do the thing.");
		expect(sendCustomMessage.mock.calls[0]?.[0].content).toContain("User: alpha");
		expect(promptCustomMessage.mock.calls[0]?.[0].content).toContain("Do the second thing.");
		expect(promptCustomMessage.mock.calls[0]?.[0].content).toContain("User: beta gamma");
	});
});

describe("InputController busyPromptMode + skill commands (issue #434)", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, Skill>;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-busy-prompt-mode-");
		const skillPath = writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		const skill: Skill = {
			name: "test-skill",
			description: "Test skill",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		};
		skillCommands = new Map<string, Skill>([
			["skill:test-skill", skill],
			["test-skill", skill],
		]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	// Skill-command-specific routing. Free-text Enter routing and the Ctrl+Enter
	// keybinding are covered in input-controller-busy-prompt-mode.test.ts; the
	// E1 case above already covers the default (steer) skill path.
	it("queue: Enter on a skill command while streaming queues it as followUp", async () => {
		const { ctx, editor, enqueueCustomMessageDisplay } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
			busyPromptMode: "queue",
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill go");
		await editor.onSubmit?.("/skill:test-skill go");

		expect(enqueueCustomMessageDisplay).toHaveBeenCalledWith("/skill:test-skill go", "followUp");
	});
});

describe("skill slash command resolution", () => {
	it("enables namespaced skill commands by default", () => {
		expect(Settings.isolated().get("skills.enableSkillCommands")).toBe(true);
	});

	it("exposes only namespaced skill commands", () => {
		const deepInterview = getEmbeddedDefaultGjcSkills().find(skill => skill.name === "deep-interview");
		if (!deepInterview) throw new Error("expected embedded deep-interview skill");

		const withFileCollision = resolveSkillSlashCommands([deepInterview], new Set(["deep-interview"]));
		expect(withFileCollision.map(command => command.name)).toEqual(["skill:deep-interview"]);

		const afterCollisionRemoved = resolveSkillSlashCommands([deepInterview], new Set());
		expect(afterCollisionRemoved.map(command => command.name)).toEqual(["skill:deep-interview"]);
		expect(afterCollisionRemoved.every(command => command.skill === deepInterview)).toBe(true);
	});
});

// ============================================================================
// E4-E7: Real AgentSession driving synthetic `message_start` events.
// ============================================================================

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

async function createRealSession(): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@pi-skill-queue-real-");
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
	});

	return { tempDir, authStorage, session };
}

/** Emit a `message_start` for a custom message whose `details` carries the supplied tag. */
function emitCustomMessageStart(session: AgentSession, content: string, tag?: string): void {
	const details: { __pendingDisplayTag?: string } | undefined =
		tag === undefined ? undefined : { __pendingDisplayTag: tag };
	session.agent.emitExternalEvent({
		type: "message_start",
		message: {
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content,
			display: true,
			details,
			timestamp: Date.now(),
		},
	});
}

describe("AgentSession custom-role tag dequeue (E4-E7)", () => {
	let fixture: SessionFixture | undefined;

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			await removeTempDirWithRetry(fixture.tempDir);
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("E4: message_start with role=custom + matching tag removes the tagged display entry", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		const tag = session.enqueueCustomMessageDisplay("/skill:foo bar", "steer");
		expect(tag).not.toBe("");
		expect(session.getQueuedMessages().steering).toEqual(["/skill:foo bar"]);

		emitCustomMessageStart(session, "irrelevant content", tag);
		await Promise.resolve();
		await Promise.resolve();

		expect(session.getQueuedMessages().steering).toEqual([]);
		// And internal queue counters reflect the empty steer/followUp arrays. The
		// pending-next-turn store stays at zero too because this test never queued one.
		expect(session.queuedMessageCount).toBe(0);
	});

	it("E5: message_start with role=custom but no tag is a no-op", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		session.enqueueCustomMessageDisplay("/skill:foo bar", "steer");
		const beforeCount = session.queuedMessageCount;
		expect(beforeCount).toBe(1);

		emitCustomMessageStart(session, "irrelevant content"); // no tag
		await Promise.resolve();
		await Promise.resolve();

		expect(session.getQueuedMessages().steering).toEqual(["/skill:foo bar"]);
		expect(session.queuedMessageCount).toBe(beforeCount);
	});

	it("E6: two queued skills with identical args text are dequeued independently by tag", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		const tag1 = session.enqueueCustomMessageDisplay("/skill:foo bar", "steer");
		const tag2 = session.enqueueCustomMessageDisplay("/skill:foo bar", "steer");
		expect(tag1).not.toBe(tag2);
		expect(session.getQueuedMessages().steering).toEqual(["/skill:foo bar", "/skill:foo bar"]);

		// Consume the SECOND-enqueued tag. After dequeue, the SURVIVING entry must be
		// the one that was added FIRST — proves the dequeue keys off `tag`, not off
		// `indexOf(text)` (which would always have removed the first match).
		emitCustomMessageStart(session, "any", tag2);
		await Promise.resolve();
		await Promise.resolve();

		expect(session.getQueuedMessages().steering).toEqual(["/skill:foo bar"]);

		// Now dequeue the first; nothing left.
		emitCustomMessageStart(session, "any", tag1);
		await Promise.resolve();
		await Promise.resolve();

		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	it("E7: popLastQueuedMessage on a tagged entry leaves no orphan tag state", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		const firstTag = session.enqueueCustomMessageDisplay("/skill:foo bar", "steer");
		const popped = session.popLastQueuedMessage();
		expect(popped).toBe("/skill:foo bar");
		expect(session.getQueuedMessages().steering).toEqual([]);

		// Push a NEW tagged entry with the same text. Emitting `message_start` for the
		// FIRST (popped) tag must be a no-op — the dequeue cannot reach into the new
		// entry because the popped tag died with its record.
		const secondTag = session.enqueueCustomMessageDisplay("/skill:foo bar", "steer");
		expect(secondTag).not.toBe(firstTag);

		emitCustomMessageStart(session, "any", firstTag);
		await Promise.resolve();
		await Promise.resolve();
		expect(session.getQueuedMessages().steering).toEqual(["/skill:foo bar"]);

		// Sanity: the second tag still works.
		emitCustomMessageStart(session, "any", secondTag);
		await Promise.resolve();
		await Promise.resolve();
		expect(session.getQueuedMessages().steering).toEqual([]);
	});
	it("E7b: popLastQueuedMessage follows newest cross-queue insertion order", async () => {
		fixture = await createRealSession();
		const { session } = fixture;

		await session.steer("first steer");
		await session.followUp("latest follow-up");

		expect(session.popLastQueuedMessage()).toBe("latest follow-up");
		expect(session.getQueuedMessages().steering).toEqual(["first steer"]);
		expect(session.getQueuedMessages().followUp).toEqual([]);

		expect(session.popLastQueuedMessage()).toBe("first steer");
		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(session.getQueuedMessages().followUp).toEqual([]);
	});
});

// ============================================================================
// E8-E9: Real UiHelpers / InputController against a session populated through
// enqueueCustomMessageDisplay.
// ============================================================================

function createStubInteractiveModeContextForUiHelpers(session: AgentSession) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
	};
	const pendingMessagesContainer = new Container();
	const requestRender = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();

	const ctx = {
		editor,
		ui: { requestRender },
		pendingMessagesContainer,
		session,
		compactionQueuedMessages: [],
		keybindings: {
			getDisplayString: (_action: string) => "Alt+Up",
		},
		updatePendingMessagesDisplay,
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, pendingMessagesContainer };
}

describe("UiHelpers / InputController against the queued-display layer (E8-E9)", () => {
	let fixture: SessionFixture | undefined;

	beforeEach(async () => {
		// E8 invokes the real `theme.fg(...)` codepath inside
		// updatePendingMessagesDisplay; without an initialized theme module the
		// global `theme` variable is undefined. Installs `dark` per-test —
		// matches the established suite convention used by other test files
		// (bash-execution-clamp.test.ts, bash-execution-sixel.test.ts) where
		// `dark` is the agreed default for every test that needs a theme.
		// No `afterEach` restore is required by that convention; the theme
		// module exposes no reset API, and `dark` is the suite-wide assumed
		// post-state.
		const themeInstance = await getThemeByName("red-claw");
		expect(themeInstance).toBeDefined();
		setThemeInstance(themeInstance!);
	});

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			await removeTempDirWithRetry(fixture.tempDir);
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("E8: updatePendingMessagesDisplay renders the compact slash form for queued skills", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		session.enqueueCustomMessageDisplay("/skill:test-skill arg1 arg2", "steer");

		const { ctx, pendingMessagesContainer } = createStubInteractiveModeContextForUiHelpers(session);
		const uiHelpers = new UiHelpers(ctx);
		uiHelpers.updatePendingMessagesDisplay();

		// Render the container at a generous width and assert the compact slash-form
		// chip appears verbatim. Matches the user-facing "Steer: /skill:..." format.
		const rendered = pendingMessagesContainer.render(120).join("\n");
		expect(rendered).toMatch(/Steer: \/skill:test-skill arg1 arg2/);
	});

	it("E8b: updatePendingMessagesDisplay labels normal follow-up prompts as queued", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		await session.followUp("queue this normal message");

		const { ctx, pendingMessagesContainer } = createStubInteractiveModeContextForUiHelpers(session);
		const uiHelpers = new UiHelpers(ctx);
		uiHelpers.updatePendingMessagesDisplay();

		const rendered = pendingMessagesContainer.render(120).join("\n");
		expect(rendered).toMatch(/Queued: queue this normal message/);
		expect(rendered).not.toMatch(/Follow-up: queue this normal message/);
	});

	it("E9: restoreQueuedMessagesToEditor recovers the compact slash form into the editor and clears the queue", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		session.enqueueCustomMessageDisplay("/skill:test-skill arg1 arg2", "steer");

		const { ctx, editor } = createStubInteractiveModeContextForUiHelpers(session);
		const controller = new InputController(ctx);
		const count = controller.restoreQueuedMessagesToEditor();
		expect(count).toBe(1);
		expect(editor.getText()).toBe("/skill:test-skill arg1 arg2");
		// Queue cleared on both arrays.
		const { steering, followUp } = session.getQueuedMessages();
		expect(steering).toEqual([]);
		expect(followUp).toEqual([]);
	});
});

// ============================================================================
// E10: EventController refreshes the pending-messages bar on tagged custom
// dequeue.
//
// Regression guard for the OpenAI code backend P2 review finding on PR #1043: the
// custom-role `message_start` branch in AgentSession.#handleAgentEvent spliced
// the matching entry out of #steeringMessages / #followUpMessages correctly,
// but EventController.#handleMessageStart only called updatePendingMessagesDisplay
// from the `role === "user"` branch. The custom branch — which is where queued
// /skill: invocations flow — never rebuilt `pendingMessagesContainer`, so the
// chip kept painting until an unrelated trigger fired a refresh.
//
// The fix: in EventController's custom branch, when the dequeued message
// carries the `__pendingDisplayTag` (proof it was queued via
// enqueueCustomMessageDisplay), call updatePendingMessagesDisplay() before
// requestRender(). E10 covers both gate branches:
//   - positive: tagged custom -> refresh fires once
//   - negative: untagged custom (ttsr-injection, irc:*, async-result, hookMessage)
//     -> refresh NOT fired (over-refresh guard)
// ============================================================================

function createEventControllerFixtureForE10() {
	const updatePendingMessagesDisplay = vi.fn();
	const addMessageToChat = vi.fn();
	const requestRender = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		addMessageToChat,
		updatePendingMessagesDisplay,
		session: {},
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, updatePendingMessagesDisplay, addMessageToChat };
}

describe("EventController custom-role dequeue refresh (E10)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("E10: message_start with role=custom refreshes pending bar ONLY when __pendingDisplayTag is present", async () => {
		const { controller, updatePendingMessagesDisplay, addMessageToChat } = createEventControllerFixtureForE10();

		// Positive case: tagged custom => refresh fires exactly once. The tag is the
		// unambiguous signal "this message was queued via enqueueCustomMessageDisplay";
		// AgentSession.#handleAgentEvent has already spliced the matching entry out of
		// the display arrays (ran before this emit), so the rebuild repaints the now-
		// correct queue state.
		const taggedEvent: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "first",
				display: true,
				details: {
					__pendingDisplayTag: "sk-test-0",
					name: "foo",
					path: "/s.md",
					args: "bar",
					lineCount: 1,
				} satisfies SkillPromptDetails,
				timestamp: Date.now(),
			},
		};
		await controller.handleEvent(taggedEvent);
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		// Chat rendering still ran — refresh is additive, not a replacement for the
		// chat path.
		expect(addMessageToChat).toHaveBeenCalledTimes(1);

		// Negative case: untagged custom => refresh NOT fired. Over-refresh guard.
		// Non-queued customs (ttsr-injection, irc:*, async-result, hookMessage) never
		// registered a pending chip, so rebuilding pendingMessagesContainer for them
		// would be pure waste. Distinct timestamp avoids the #renderedCustomMessages
		// signature-dedup early-return.
		const untaggedEvent: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "second",
				display: true,
				details: undefined,
				timestamp: Date.now() + 1,
			},
		};
		await controller.handleEvent(untaggedEvent);
		// Still exactly 1 — no additional call from the untagged path.
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		// Chat rendering still ran for the untagged custom (the chat-add path is
		// unconditional inside the custom branch; only the pending-bar refresh is
		// tag-gated).
		expect(addMessageToChat).toHaveBeenCalledTimes(2);
	});
});
