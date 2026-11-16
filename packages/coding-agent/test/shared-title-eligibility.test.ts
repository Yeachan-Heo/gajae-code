import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { Container } from "@gajae-code/tui";
import { logger } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { TreeSelectorComponent } from "../src/modes/components/tree-selector";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { TodoCommandController } from "../src/modes/controllers/todo-command-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { managedSessionTransactionLocksDirectory } from "../src/session/internal/managed-session-scope";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import {
	SESSION_LIMIT_RECOVERY_ACTIONS,
	SessionManager,
	SessionNearLimitAppendError,
	SharedSessionMutationUnsupportedError,
} from "../src/session/session-manager";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../src/tools/todo-write";
import * as titleGenerator from "../src/utils/title-generator";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const stores: AuthStorage[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const shellResult = (output: string) => ({
	output,
	exitCode: 0,
	cancelled: false,
	truncated: false,
	totalLines: 1,
	totalBytes: output.length,
	outputLines: 1,
	outputBytes: output.length,
	displayOutputs: [],
	stdinRequested: false,
});
let originalNoTitle: string | undefined;
let originalPiNoTitle: string | undefined;

beforeEach(() => {
	originalNoTitle = process.env.GJC_NO_TITLE;
	originalPiNoTitle = process.env.PI_NO_TITLE;
	delete process.env.GJC_NO_TITLE;
	delete process.env.PI_NO_TITLE;
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	if (originalNoTitle === undefined) delete process.env.GJC_NO_TITLE;
	else process.env.GJC_NO_TITLE = originalNoTitle;
	if (originalPiNoTitle === undefined) delete process.env.PI_NO_TITLE;
	else process.env.PI_NO_TITLE = originalPiNoTitle;
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-title-eligibility-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.reminders": false });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		rootInteractiveSharedAppend: true,
		thinkingLevel: ThinkingLevel.Off,
	});
	sessions.push(session);
	return { session, manager, file: manager.getSessionFile()!, destination };
}

describe("shared publication admission split", () => {
	it("keeps ordinary appends and message_end persistence available after an automatic title", async () => {
		const f = await fixture();
		vi.spyOn(titleGenerator, "generateSessionTitle").mockResolvedValue("Automatic title");
		expect(await f.session.generateAutoSessionTitle("first input")).toEqual({
			kind: "applied",
			title: "Automatic title",
		});
		expect(f.manager.getSessionName()).toBe("Automatic title");
		expect(() => f.manager.assertLegacyAppendAllowed("ordinary append")).not.toThrow();

		const custom = f.manager.appendCustomEntry("post-title", { value: 1 });
		expect(f.manager.getLeafId()).toBe(custom);

		f.session.agent.emitExternalEvent({ type: "message_end", message: user("ordinary user message") });
		await f.session.awaitSessionSettlement();
		f.session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "custom",
				customType: "post-title",
				content: "extension message",
				display: false,
				timestamp: 1,
			},
		});
		await f.session.awaitSessionSettlement();
		expect(f.session.agent.state.error).toBeUndefined();

		await f.manager.flush();
		const persisted = await Bun.file(f.file).text();
		expect(persisted).toContain("ordinary user message");
		expect(persisted).toContain('"customType":"post-title"');
	});

	it("still rejects a concurrent legacy mutation while the title publication is in flight", async () => {
		const f = await fixture();
		const title = f.manager.setSessionNameSharingSession("In flight", "user");
		expect(() => f.manager.appendMessage(user("concurrent"))).toThrow(SharedSessionMutationUnsupportedError);
		expect(await title).toEqual({ kind: "committed", title: "In flight" });
		expect(() => f.manager.assertLegacyAppendAllowed("after title")).not.toThrow();
	});

	it("keeps rewrite authority barred after a title adopts a sibling snapshot", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local root"));
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		const sibling = await SessionManager.open(f.file, f.destination);
		managers.push(sibling);
		const peer = await sibling.appendMessageSharingSession(user("peer branch"));
		if (peer.kind !== "committed") throw new Error(`peer append: ${peer.kind}`);
		expect(f.manager.getEntries().some(entry => entry.id === peer.id)).toBe(false);

		expect(await f.manager.setSessionNameSharingSession("Adopted title", "user")).toEqual({
			kind: "committed",
			title: "Adopted title",
		});
		const before = await fs.readFile(f.file);
		f.manager.appendMessage(user("local after title"));
		expect(() => f.manager.assertLegacyMutationAllowed("rewrite after adopted title")).toThrow(
			SharedSessionMutationUnsupportedError,
		);
		await expect(f.manager.fork()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(f.manager.setSessionStarred(true)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		expect((await fs.readFile(f.file)).subarray(0, before.length).equals(before)).toBe(true);

		const reopened = await SessionManager.open(f.file, f.destination);
		managers.push(reopened);
		expect(reopened.getEntries().some(entry => entry.id === peer.id)).toBe(true);
	});

	it("holds the in-flight fence until every queued title publication settles", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local root"));
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
		let publications = 0;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relative,
			bytes,
			expected,
		) {
			publications++;
			if (publications === 2)
				expect(() => f.manager.appendMessage(user("depth two must stay barred"))).toThrow(
					SharedSessionMutationUnsupportedError,
				);
			return original.call(this, relative, bytes, expected);
		});
		const first = f.manager.setSessionNameSharingSession("First title", "user");
		const second = f.manager.setSessionNameSharingSession("Second title", "user");
		expect(await first).toEqual({ kind: "committed", title: "First title" });
		// The first publication settled, but the second is still armed. Releasing one
		// reference must leave the fence closed until the last publication settles.
		expect(f.manager.getSessionName()).toBe("First title");
		expect(() => f.manager.appendMessage(user("between titles"))).toThrow(SharedSessionMutationUnsupportedError);
		expect(await second).toEqual({ kind: "committed", title: "Second title" });
		expect(publications).toBe(2);
		const appended = f.manager.appendMessage(user("after both titles"));
		expect(f.manager.getEntries().some(entry => entry.id === appended)).toBe(true);
	});

	it("releases scoped admission when publication setup throws before the transaction", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local root"));
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		const locks = managedSessionTransactionLocksDirectory(path.dirname(f.file));
		await fs.mkdir(path.dirname(locks), { recursive: true, mode: 0o700 });
		await fs.rm(locks, { recursive: true, force: true });
		await fs.writeFile(locks, "not a directory");
		await expect(
			f.manager.appendTemporaryModelChangeSharingSession("test/temporary", { level: "high" }, () => true),
		).rejects.toThrow();
		// A leaked admission count would keep the session barred after the setup failure.
		expect(() => f.manager.appendMessage(user("after failed publication"))).not.toThrow();
		const appended = f.manager.appendMessage(user("retry after failed publication"));
		expect(f.manager.getEntries().some(entry => entry.id === appended)).toBe(true);
		await fs.rm(locks);
		expect(
			(await f.manager.appendTemporaryModelChangeSharingSession("test/temporary", { level: "high" }, () => true))
				.kind,
		).toBe("committed");
	});

	it("scopes temporary-model append admission while retaining rewrite authority", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local root"));
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		const outcome = await f.manager.appendTemporaryModelChangeSharingSession(
			"test/temporary",
			{ level: "high" },
			() => true,
		);
		expect(outcome.kind).toBe("committed");
		const appended = f.manager.appendMessage(user("after temporary model"));
		expect(f.manager.getEntries().some(entry => entry.id === appended)).toBe(true);
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(f.manager.setSessionStarred(true)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
	});

	it("scopes thinking append admission while retaining rewrite authority", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local root"));
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		await f.manager.withSharedThinkingControl(async () => {
			expect(await f.manager.appendThinkingLevelChangeSharingSession("high", false, () => true)).toMatchObject({
				kind: "committed",
			});
		});
		expect(() => f.manager.appendMessage(user("after thinking"))).not.toThrow();
		const appended = f.manager.appendMessage(user("retry after thinking"));
		expect(f.manager.getEntries().some(entry => entry.id === appended)).toBe(true);
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
	});

	it("scopes discovered-tool append admission while retaining rewrite authority", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local root"));
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		const outcome = await f.manager.appendToolSelectionsSharingSession(["mcp__probe"], undefined, () => true);
		expect(outcome.kind).toBe("committed");
		const appended = f.manager.appendMessage(user("after tool selection"));
		expect(f.manager.getEntries().some(entry => entry.id === appended)).toBe(true);
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(f.manager.setSessionStarred(true)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
	});

	it("persists a custom message_end emitted after a committed canonical shared append", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("shared root") });
		await f.session.awaitSessionSettlement();
		// The reported sequence: the canonical append commits first and arms the
		// permanent append bar, so a legacy custom append would abort the run here.
		expect(() => f.manager.assertLegacyAppendAllowed("legacy after shared append")).toThrow(
			SharedSessionMutationUnsupportedError,
		);
		f.session.agent.emitExternalEvent({
			type: "message_end",
			message: { role: "custom", customType: "after-shared", content: "survives", display: false, timestamp: 1 },
		});
		await f.session.awaitSessionSettlement();
		expect(f.session.agent.state.error).toBeUndefined();
		expect(
			f.manager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === "after-shared"),
		).toBe(true);
		await f.manager.flush();
		expect(await Bun.file(f.file).text()).toContain("survives");
	});

	it("keeps appendEntry, setLabel, a bash result, and a recap durable after the first shared message", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("first canonical message") });
		await f.session.awaitSessionSettlement();
		// The permanent legacy-append refusal is armed now, so every producer below must
		// publish through the session's admitted shared path instead of the legacy append.
		expect(() => f.manager.assertLegacyAppendAllowed("legacy after shared append")).toThrow(
			SharedSessionMutationUnsupportedError,
		);

		const leaf = f.manager.getLeafId();
		if (!leaf) throw new Error("missing leaf");
		await f.session.appendCustomEntryForSession("extension-state", { ok: true });
		expect(await f.session.appendLabelChangeInBackground(leaf, "bookmark")).toEqual({ committed: true });

		const persistedBash = Promise.withResolvers<void>();
		f.session.recordBashResult("echo shared", shellResult("shared bash output"), {
			onPersisted: () => persistedBash.resolve(),
		});
		await persistedBash.promise;

		const request = await f.manager.appendMessageSharingSession(user("recap request"));
		if (request.kind !== "committed") throw new Error(request.kind);
		const source = await f.manager.appendMessageSharingSession({
			role: "assistant",
			content: [{ type: "text", text: "recap answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		if (source.kind !== "committed") throw new Error(source.kind);
		expect(
			await f.session.appendSessionRecapForSession({
				text: "recap text",
				sourceEntryId: source.id,
				requestEntryId: request.id,
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				generatedAt: new Date().toISOString(),
			}),
		).toEqual({ status: "appended", entryId: expect.any(String) });

		expect(f.session.agent.state.error).toBeUndefined();
		await f.manager.flush();
		const persisted = await Bun.file(f.file).text();
		expect(persisted).toContain('"customType":"extension-state"');
		expect(persisted).toContain('"label":"bookmark"');
		expect(persisted).toContain("shared bash output");
		expect(persisted).toContain('"customType":"session_recap"');
	});

	it("publishes a todo edit after a committed canonical shared message", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("first canonical message") });
		await f.session.awaitSessionSettlement();
		// The canonical append armed the permanent legacy-append bar, which is exactly the
		// state in which /todo used to refuse before the migrated publisher ever ran.
		expect(() => f.manager.assertLegacyAppendAllowed("legacy todo edit")).toThrow(
			SharedSessionMutationUnsupportedError,
		);

		const showStatus = vi.fn();
		const showError = vi.fn();
		const setTodos = vi.fn();
		const ctx = {
			session: f.session,
			sessionManager: f.manager,
			agent: f.session.agent,
			setTodos,
			showStatus,
			showError,
			showWarning: vi.fn(),
			ui: { suspend: vi.fn(), start: vi.fn(), requestRender: vi.fn() },
		} as unknown as InteractiveModeContext;
		await new TodoCommandController(ctx).handleTodoCommand('append "after shared"');
		await f.session.awaitSessionSettlement();
		await f.manager.flush();

		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Appended to Todos: After shared");
		expect(setTodos).toHaveBeenCalledWith([
			{ name: "Todos", tasks: [{ content: "After shared", status: "pending" }] },
		]);
		const persisted = f.manager.getEntries();
		const todoEntry = persisted.find(
			entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE,
		);
		expect(todoEntry?.type === "custom" ? todoEntry.data : undefined).toEqual({
			phases: [{ name: "Todos", tasks: [{ content: "After shared", status: "pending" }] }],
		});
		// The reminder is the second additive entry: the agent must retain the edit next turn.
		expect(
			persisted.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "developer" &&
					JSON.stringify(entry.message.content).includes("The user manually modified the todo list"),
			),
		).toBe(true);

		// Reload survival is the contract /todo actually relies on.
		const reopened = await SessionManager.open(f.file, f.destination);
		managers.push(reopened);
		const reloaded = reopened.getEntries();
		expect(reloaded.some(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE)).toBe(
			true,
		);
		expect(reloaded.some(entry => entry.type === "message" && entry.message.role === "developer")).toBe(true);
	});

	it("keeps a background mode change ahead of a newer canonical append", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const original = f.manager.appendModeChangeSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendModeChangeSharingSession").mockImplementation(async (mode, data) => {
			entered.resolve();
			await gate.promise;
			return original(mode, data);
		});
		const publication = f.session.appendModeChangeInBackground("plan");
		await entered.promise;

		f.session.agent.emitExternalEvent({ type: "message_end", message: user("newer canonical") });
		// The canonical append must queue behind the older background publication instead
		// of overtaking it through a free lease. Without the lane reservation it commits
		// here and the older mode change lands after newer state.
		await Bun.sleep(10);
		expect(
			f.manager
				.getEntries()
				.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.content === "newer canonical",
				),
		).toBe(false);

		gate.resolve();
		expect(await publication).toEqual({ committed: true });
		await f.session.awaitSessionSettlement();
		await f.manager.flush();
		const persisted = await Bun.file(f.file).text();
		const modeIndex = persisted.indexOf('"type":"mode_change"');
		const messageIndex = persisted.indexOf("newer canonical");
		expect(modeIndex).toBeGreaterThanOrEqual(0);
		expect(messageIndex).toBeGreaterThan(modeIndex);
	});

	it("joins a paused recovery drain instead of publishing a deferred result twice", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		// Queue one deferred command result without starting a turn.
		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("echo deferred-once", shellResult("deferred once"), { onPersisted: persisted });
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let publications = 0;
		const original = f.manager.appendMessageSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role === "bashExecution") {
				publications++;
				entered.resolve();
				await gate.promise;
			}
			return original(message);
		});

		// Force recovery starts the drain detached; make it pause inside the lease.
		vi.spyOn(f.session.agent, "waitForIdle").mockImplementation(() => new Promise<void>(() => {}));
		vi.spyOn(f.session.agent, "prompt").mockRejectedValue(new Error("successor run blocked by test"));
		await f.session.abort({ timeoutMs: 1 });
		await entered.promise;

		// A successor prompt joins the retained drain owner rather than starting a second
		// traversal of the same pending entry.
		const successor = f.session.prompt("successor").catch((error: unknown) => error);
		await Bun.sleep(10);
		expect(publications).toBe(1);

		gate.resolve();
		await successor;
		await f.session.awaitSessionSettlement();
		expect(publications).toBe(1);
		expect(persisted).toHaveBeenCalledTimes(1);
		await f.manager.flush();
		const durable = await Bun.file(f.file).text();
		expect(durable.split("deferred once").length - 1).toBe(1);
	});

	it("reports a Python result as persisted only after the shared append commits", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const original = f.manager.appendMessageSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role === "pythonExecution") {
				entered.resolve();
				await gate.promise;
			}
			return original(message);
		});
		const persisted = vi.fn();
		f.session.recordPythonResult("print('shared')", shellResult("python shared output"), { onPersisted: persisted });
		await entered.promise;
		expect(persisted).not.toHaveBeenCalled();

		gate.resolve();
		await f.session.awaitSessionSettlement();
		expect(persisted).toHaveBeenCalledTimes(1);
		await f.manager.flush();
		expect(await Bun.file(f.file).text()).toContain("python shared output");
	});

	it("withholds Python onPersisted when the shared append is refused", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();
		vi.spyOn(f.manager, "appendMessageSharingSession").mockResolvedValue({
			kind: "rejected",
			error: new Error("lease refused"),
		});
		const notice = vi.spyOn(f.session, "emitNotice");
		const persisted = vi.fn();
		f.session.recordPythonResult("print('refused')", shellResult("python refused output"), {
			onPersisted: persisted,
		});
		await f.session.awaitSessionSettlement();
		expect(persisted).not.toHaveBeenCalled();
		expect(notice).toHaveBeenCalledWith(
			"warning",
			"Could not save the python result to this session: lease refused",
			"session-publication",
		);
	});

	it("keeps the structured near-limit outcome on a canonical shared tool result", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		const nearLimit = new SessionNearLimitAppendError({
			entryBytes: 900,
			liveBytes: 1000,
			capBytes: 1000,
			entryRetained: true,
		});
		vi.spyOn(f.manager, "appendMessageSharingSession").mockResolvedValue({
			kind: "unknown",
			id: "near-limit-entry",
			error: nearLimit,
		});
		const result = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "edit",
			content: [{ type: "text" as const, text: "applied" }],
			isError: false,
			timestamp: 3,
		};
		f.session.agent.emitExternalEvent({ type: "message_end", message: result as never });
		await f.session.awaitSessionSettlement().catch(() => {});

		// The shared wrapper must not swallow the typed outcome: the tool result carries
		// the structured failure and the recovery guidance the operator needs.
		expect(result.isError).toBe(true);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("managed per-file limit");
		expect(text).toContain(SESSION_LIMIT_RECOVERY_ACTIONS);
		expect("details" in result ? result.details : undefined).toMatchObject({
			failureKind: "persistence",
			nearLimitAppend: {
				code: "near_limit_append",
				entryBytes: 900,
				liveBytes: 1000,
				capBytes: 1000,
				entryRetained: true,
			},
		});
	});

	it("refuses every additive legacy append of a shared logical session before mutating", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("first canonical message") });
		await f.session.awaitSessionSettlement();
		const leaf = f.manager.getLeafId();
		if (!leaf) throw new Error("missing leaf");
		// The append bar is early refusal policy: every additive legacy append of this
		// logical session throws before touching the graph, so a caller cannot observe a
		// half-applied transcript and does not need to guess which producer is admitted.
		const entryCount = f.manager.getEntries().length;
		const legacyAppends: Array<[string, () => unknown]> = [
			["custom entry", () => f.manager.appendCustomEntry("legacy-custom", { ok: true })],
			["label", () => f.manager.appendLabelChange(leaf, "legacy-label")],
			["ttsr", () => f.manager.appendTtsrInjection(["ttsr-rule"])],
			["mode change", () => f.manager.appendModeChange("plan")],
			["thinking level", () => f.manager.appendThinkingLevelChange("high")],
			["model change", () => f.manager.appendModelChange("anthropic/claude-sonnet-4-5")],
			["service tier", () => f.manager.appendServiceTierChange(null)],
			["session init", () => f.manager.appendSessionInit({ systemPrompt: "", task: "", tools: [] })],
			["mcp selection", () => f.manager.appendMCPToolSelection(["mcp__probe"])],
			["compaction", () => f.manager.appendCompaction("summary", undefined, leaf, 0)],
		];
		for (const [operation, append] of legacyAppends) {
			let refusal: unknown;
			try {
				append();
			} catch (error) {
				refusal = error;
			}
			expect(`${operation}: ${(refusal as Error | undefined)?.constructor.name}`).toBe(
				`${operation}: SharedSessionMutationUnsupportedError`,
			);
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(f.manager.getEntries().length).toBe(entryCount);
		}
	});

	it("keeps rewrite authority when a title adopts this manager's own transcript", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local root"));
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		expect(await f.manager.setSessionNameSharingSession("Renamed locally", "user")).toEqual({
			kind: "committed",
			title: "Renamed locally",
		});
		// The title adopted no foreign state: this manager wrote every byte on disk.
		expect(() => f.manager.assertLegacyAppendAllowed("append after own rename")).not.toThrow();
		expect(() => f.manager.assertLegacyMutationAllowed("rewrite after own rename")).not.toThrow();
		f.manager.appendMessage(user("local after rename"));
		await f.manager.rewriteEntries();
		await f.manager.setSessionStarred(true);
	});

	it("logs the cause when a refused canonical publication aborts the run", async () => {
		const f = await fixture();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const failure = new Error("injected shared append refusal");
		vi.spyOn(f.manager, "appendMessageSharingSession").mockResolvedValue({ kind: "rejected", error: failure });
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("cannot publish") });
		await f.session.awaitSessionSettlement().catch(() => {});
		const call = warn.mock.calls.find(
			([message]) => message === "Canonical session publication failed; aborting run",
		);
		expect(call?.[1]).toMatchObject({
			operation: "canonical user append",
			error: "Shared canonical append rejected",
			cause: failure.message,
		});
	});

	it("scopes mode-change append admission while retaining the rewrite fence", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local root"));
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		const outcome = await f.manager.appendModeChangeSharingSession("plan", { planFilePath: "/tmp/plan.md" });
		expect(outcome.kind).toBe("committed");
		const appended = f.manager.appendMessage(user("after mode change"));
		expect(f.manager.getEntries().some(entry => entry.id === appended)).toBe(true);
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(f.manager.setSessionStarred(true)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
	});

	it("publishes a tree-navigator label through the real controller after shared admission", async () => {
		const f = await fixture();
		await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
		await Settings.init({ inMemory: true });
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("first canonical message") });
		await f.session.awaitSessionSettlement();
		const leaf = f.manager.getLeafId();
		if (!leaf) throw new Error("missing leaf");

		const editor = new Container();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const ctx = {
			session: f.session,
			sessionManager: f.manager,
			settings: Settings.isolated(),
			editor,
			editorContainer,
			ui: { terminal: { rows: 40 }, setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			isStopped: () => false,
			statusLine: { invalidate: vi.fn(), setSessionStartTime: vi.fn() },
			resetIrcSidebarSession: vi.fn(),
			resetObserverRegistry: vi.fn(),
			updateEditorTopBorder: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			rebuildInitialMessages: vi.fn(),
			reloadTodos: vi.fn(async () => {}),
			goalModeController: { scheduleContinuation: vi.fn() },
		} as unknown as InteractiveModeContext;
		// The real producer: SelectorController owns the tree navigator's label callback.
		new SelectorController(ctx).showTreeSelector();
		const selector = editorContainer.children.find(child => child instanceof TreeSelectorComponent);
		if (!(selector instanceof TreeSelectorComponent)) throw new Error("tree selector was not shown");

		// Same submit path the navigator uses: Shift+L opens the label input, Enter submits it.
		selector.getTreeList().onLabelEdit?.(leaf, undefined);
		selector.handleInput("tree-label");
		selector.handleInput("\n");
		await f.session.awaitSessionSettlement();
		await f.manager.flush();

		expect(ctx.showError).not.toHaveBeenCalled();
		expect(await Bun.file(f.file).text()).toContain('"label":"tree-label"');
	});

	it("notifies the operator when a background publication is refused", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("first canonical message") });
		await f.session.awaitSessionSettlement();
		vi.spyOn(f.manager, "appendCustomEntrySharingSession").mockResolvedValue({
			kind: "rejected",
			error: new Error("lease refused"),
		});
		const notice = vi.spyOn(f.session, "emitNotice");
		expect(await f.session.appendCustomEntryInBackground("extension-state", { ok: true })).toEqual({
			committed: false,
			cause: "lease refused",
		});
		expect(notice).toHaveBeenCalledWith(
			"warning",
			"Could not save the custom entry extension-state to this session: lease refused",
			"session-publication",
		);
	});

	it("does not notify when a background publication commits", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("first canonical message") });
		await f.session.awaitSessionSettlement();
		const notice = vi.spyOn(f.session, "emitNotice");
		expect(await f.session.appendCustomEntryInBackground("extension-state", { ok: true })).toEqual({
			committed: true,
		});
		expect(notice).not.toHaveBeenCalled();
	});

	it("routes a TTSR injection marker through the shared lease instead of failing the run", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("first canonical message") });
		await f.session.awaitSessionSettlement();
		// The message_end TTSR path is driven by the ephemeral custom marker message.
		f.session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "custom",
				customType: "ttsr-injection",
				content: "matched rules",
				display: false,
				timestamp: 2,
				details: { rules: ["ttsr-rule-a"] },
			},
		});
		await f.session.awaitSessionSettlement();
		expect(f.session.agent.state.error).toBeUndefined();
		await f.manager.flush();
		expect(await Bun.file(f.file).text()).toContain('"injectedRules":["ttsr-rule-a"]');
	});

	it("keeps a refused deferred command result queued and withholds onPersisted", async () => {
		const f = await fixture();
		// Bun's spyOn cannot patch accessors; shadow the prototype getter so the result defers.
		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("echo deferred", shellResult("deferred output"), { onPersisted: persisted });
		delete (f.session as { isStreaming?: unknown }).isStreaming;
		const refused = vi
			.spyOn(f.manager, "appendMessageSharingSession")
			.mockResolvedValue({ kind: "rejected", error: new Error("lease refused") });
		const notice = vi.spyOn(f.session, "emitNotice");
		await expect(f.session.prompt("flush now")).rejects.toThrow(
			/Failed to persist 1 of 1 deferred bash execution message/,
		);
		expect(persisted).not.toHaveBeenCalled();
		expect(notice).toHaveBeenCalledWith(
			"warning",
			expect.stringContaining("Could not save the deferred command result to this session"),
			"session-publication",
		);
		// The entry stayed queued: the next prompt's flush persists it and fires the callback.
		refused.mockRestore();
		await f.session.prompt("retry flush").catch(() => {});
		expect(persisted).toHaveBeenCalledTimes(1);
		await f.manager.flush();
		expect(await Bun.file(f.file).text()).toContain("deferred output");
	});

	it("keeps the typed near-limit outcome when a shared session bars the recovery rewrite", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("first canonical message") });
		await f.session.awaitSessionSettlement();
		// Force the managed near-limit path; its only recovery is the whole-transcript
		// rewrite, which the shared rewrite bar refuses. The typed near-limit contract must
		// survive instead of degrading into a generic "rewrite required" abort.
		const store = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
			.mockImplementation(() => {
				throw new Error("content_too_large");
			});
		const outcome = await f.manager.appendMessageSharingSession(user("overflow entry"));
		store.mockRestore();
		expect(outcome.kind).toBe("unknown");
		if (outcome.kind !== "unknown") throw new Error(outcome.kind);
		expect(outcome.error).toBeInstanceOf(SessionNearLimitAppendError);
		// The refused recovery rewrite intentionally leaves this transcript needing a full
		// rewrite, which a shared session refuses again; the documented exit is the typed
		// error's SESSION_LIMIT_RECOVERY_ACTIONS, not a close-time rewrite. Detach the
		// fixture so the shared teardown does not retry a rewrite that is refused by design.
		sessions.splice(sessions.indexOf(f.session), 1);
		managers.splice(managers.indexOf(f.manager), 1);
	});
});
