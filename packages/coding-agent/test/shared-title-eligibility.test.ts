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

async function fixture(options?: { sharedAppend?: boolean }) {
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
		rootInteractiveSharedAppend: options?.sharedAppend ?? true,
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

	it("drops a queued background publication when the session switched under it", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let publications = 0;
		// A occupies the lane; neither publication reaches the manager below, so only the
		// origin fence can decide what the queued one does.
		vi.spyOn(f.manager, "appendModeChangeSharingSession").mockImplementation(async () => {
			publications++;
			entered.resolve();
			await gate.promise;
			return { kind: "rejected", error: new Error("lane holder released") };
		});
		const blocker = f.session.appendModeChangeInBackground("plan");
		await entered.promise;
		const queued = f.session.appendModeChangeInBackground("none");
		const notice = vi.spyOn(f.session, "emitNotice");

		try {
			// The switch rotates the same manager to a successor transcript while the queued
			// publication still waits for its lane predecessor.
			const successor = SessionManager.create(f.manager.getCwd(), f.destination);
			managers.push(successor);
			successor.appendMessage(user("successor root"));
			await successor.ensureOnDisk();
			await successor.flush();
			const successorFile = successor.getSessionFile();
			if (!successorFile) throw new Error("missing successor file");
			await f.manager.setSessionFile(successorFile);

			gate.resolve();
			await blocker;
			expect(await queued).toMatchObject({
				committed: false,
				cause: expect.stringContaining("session switched"),
			});
			// The predecessor's mode change must never be published into the successor.
			expect(publications).toBe(1);
			expect(notice).toHaveBeenCalledWith(
				"warning",
				expect.stringContaining("Could not save the mode change"),
				"session-publication",
			);
			await f.manager.flush();
			expect(await Bun.file(successorFile).text()).not.toContain('"type":"mode_change"');
		} finally {
			gate.resolve();
			await blocker.catch(() => {});
			await queued.catch(() => {});
		}
	});

	it("joins a paused recovery drain instead of publishing a deferred result twice", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		// Queue the first deferred command result without starting a turn.
		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("echo deferred-once", shellResult("deferred once"), { onPersisted: persisted });
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const publishedCommands: string[] = [];
		const original = f.manager.appendMessageSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role === "bashExecution") {
				publishedCommands.push(message.command);
				if (publishedCommands.length === 1) {
					entered.resolve();
					await gate.promise;
				}
			}
			return original(message);
		});

		// Force recovery starts the drain detached; make it pause inside the lease.
		vi.spyOn(f.session.agent, "waitForIdle").mockImplementation(() => new Promise<void>(() => {}));
		vi.spyOn(f.session.agent, "prompt").mockRejectedValue(new Error("successor run blocked by test"));
		await f.session.abort({ timeoutMs: 1 });
		await entered.promise;

		// A successor result queued after the drain started belongs to a later batch. A
		// second drain would publish it immediately, ahead of the entry this drain owns.
		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		f.session.recordBashResult("echo deferred-twice", shellResult("deferred twice"), { onPersisted: persisted });
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		// A successor prompt must join the retained drain owner, not start a second
		// traversal that overtakes this one.
		const successor = f.session.prompt("successor").catch((error: unknown) => error);
		await Bun.sleep(10);
		expect(publishedCommands).toEqual(["echo deferred-once"]);

		gate.resolve();
		await successor;
		await f.session.awaitSessionSettlement();
		// The joined owner settles first, then the successor batch it left behind drains.
		expect(publishedCommands).toEqual(["echo deferred-once", "echo deferred-twice"]);

		// A later prompt must not republish either entry.
		await f.session.prompt("retry").catch(() => {});
		await f.session.awaitSessionSettlement();
		// Each queued command is published exactly once, in its original order.
		expect(publishedCommands).toEqual(["echo deferred-once", "echo deferred-twice"]);
		expect(persisted).toHaveBeenCalledTimes(2);
		await f.manager.flush();
		const durable = await Bun.file(f.file).text();
		expect(durable.split("deferred once").length - 1).toBe(1);
		expect(durable.split("deferred twice").length - 1).toBe(1);
		expect(durable.indexOf("deferred once")).toBeLessThan(durable.indexOf("deferred twice"));
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
			"Could not save the python result to this session: the session refused the write.",
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
		// The transcript refused this entry, so session subscribers are the operator's only
		// view of the structured outcome: the mapped result must actually be delivered.
		const delivered: Array<{ isError: boolean; text: string }> = [];
		f.session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return;
			const first = event.message.content[0];
			delivered.push({ isError: event.message.isError === true, text: first?.type === "text" ? first.text : "" });
		});
		f.session.agent.emitExternalEvent({ type: "message_end", message: result as never });
		await f.session.awaitSessionSettlement().catch(() => {});

		// The shared wrapper must not swallow the typed outcome: the tool result carries
		// the structured failure and the recovery guidance the operator needs.
		expect(result.isError).toBe(true);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("managed per-file limit");
		// The shared rewrite bar refused the live-entry recovery, so the receipt is not
		// durable and the guidance must not promise a later write will land.
		expect(text).toContain("not durable");
		expect(text).not.toContain("will persist on the next successful write");
		// Nor may it offer compaction or `/clear`: both need the shared publication this
		// session refuses, so naming them would be dead guidance.
		expect(text).toContain("No in-session recovery is available");
		expect(text).toContain("this session refuses");
		expect(text).not.toContain(SESSION_LIMIT_RECOVERY_ACTIONS);
		expect(text).not.toContain("To continue");
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
		// Delivery, not just mutation: a subscriber must receive the mapped error result.
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.isError).toBe(true);
		expect(delivered[0]?.text).toContain("No in-session recovery is available");
	});

	it("keeps the legacy near-limit recovery promise for a non-shared tool result", async () => {
		const f = await fixture({ sharedAppend: false });
		const nearLimit = new SessionNearLimitAppendError({
			entryBytes: 900,
			liveBytes: 1000,
			capBytes: 1000,
			entryRetained: true,
		});
		// A legacy append runs the deterministic live-entry rewrite, so the receipt really
		// does persist on the next successful write; only the shared session may not claim it.
		vi.spyOn(f.manager, "appendMessage").mockImplementation(() => {
			throw nearLimit;
		});
		const result = {
			role: "toolResult" as const,
			toolCallId: "call-legacy",
			toolName: "edit",
			content: [{ type: "text" as const, text: "applied" }],
			isError: false,
			timestamp: 3,
		};
		const delivered: string[] = [];
		f.session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return;
			const first = event.message.content[0];
			if (first?.type === "text") delivered.push(first.text);
		});
		f.session.agent.emitExternalEvent({ type: "message_end", message: result as never });
		await f.session.awaitSessionSettlement().catch(() => {});

		expect(result.isError).toBe(true);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain(SESSION_LIMIT_RECOVERY_ACTIONS);
		expect(text).toContain("will persist on the next successful write");
		// The shared-only uncertainty must not leak into a legacy session's guidance.
		expect(text).not.toContain("not durable");
		expect(text).not.toContain("No in-session recovery is available");
		expect("details" in result ? result.details : undefined).toMatchObject({
			failureKind: "persistence",
			nearLimitAppend: { code: "near_limit_append", entryRetained: true },
		});
		// The legacy mapping must be delivered to subscribers too, not only mutated in place.
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain(SESSION_LIMIT_RECOVERY_ACTIONS);
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

	it("reconciles an unknown shared append against the committed transcript", async () => {
		const f = await fixture();
		const committed = await f.manager.appendMessageSharingSession(user("durable entry"));
		if (committed.kind !== "committed") throw new Error(committed.kind);
		expect(await f.manager.reconcileUnknownSharedAppend(committed.id, new Error("release failed"))).toEqual({
			kind: "committed",
			id: committed.id,
		});
		expect(await f.manager.reconcileUnknownSharedAppend("never-written-entry", new Error("release failed"))).toEqual({
			kind: "absent",
		});
		vi.spyOn(f.manager, "captureCommittedSnapshot").mockRejectedValue(new Error("transcript read failed"));
		expect(await f.manager.reconcileUnknownSharedAppend("never-written-entry", new Error("release failed"))).toEqual({
			kind: "unresolved",
			id: "never-written-entry",
			error: expect.any(Error),
		});
	});

	it("acknowledges a deferred result whose unknown append is already durable", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("echo durable-deferred", shellResult("durable deferred output"), {
			onPersisted: persisted,
		});
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		const original = f.manager.appendMessageSharingSession.bind(f.manager);
		let attemptedId = "";
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			const outcome = await original(message);
			if (message.role !== "bashExecution" || outcome.kind !== "committed") return outcome;
			attemptedId = outcome.id;
			// The entry was committed before the failure that produced the outcome.
			return { kind: "unknown", id: outcome.id, error: new Error("transaction release failed") };
		});
		vi.spyOn(f.session.agent, "prompt").mockRejectedValue(new Error("stop after the flush"));
		await f.session.prompt("flush").catch(() => {});

		expect(attemptedId).not.toBe("");
		// Reconciliation proved the entry durable, so this is neither a refusal nor a duplicate.
		expect(persisted).toHaveBeenCalledTimes(1);
		await f.manager.flush();
		expect((await Bun.file(f.file).text()).split("durable deferred output").length - 1).toBe(1);
	});

	it("holds a deferred result whose unknown outcome cannot be reconciled", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("echo unresolved", shellResult("unresolved output"), { onPersisted: persisted });
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		const original = f.manager.appendMessageSharingSession.bind(f.manager);
		let publications = 0;
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role !== "bashExecution") return original(message);
			publications++;
			return { kind: "unknown", id: "orphaned-attempt", error: new Error("release failed") };
		});
		vi.spyOn(f.manager, "captureCommittedSnapshot").mockRejectedValue(new Error("transcript read failed"));
		const notice = vi.spyOn(f.session, "emitNotice");

		await expect(f.session.prompt("first flush")).rejects.toThrow(
			/Could not confirm persistence of 1 of 1 deferred bash execution message/,
		);
		expect(notice).toHaveBeenCalledWith(
			"warning",
			expect.stringContaining("Could not confirm that the deferred command result was saved"),
			"session-publication",
		);
		// A later prompt must not resubmit it: it may already be in the transcript.
		await expect(f.session.prompt("second flush")).rejects.toThrow(/Could not confirm persistence/);
		expect(publications).toBe(1);
		expect(persisted).not.toHaveBeenCalled();
	});

	it("describes an unconfirmed background publication honestly", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();
		vi.spyOn(f.manager, "appendCustomEntrySharingSession").mockResolvedValue({
			kind: "unknown",
			id: "ghost-entry",
			error: new Error("release failed"),
		});
		vi.spyOn(f.manager, "captureCommittedSnapshot").mockRejectedValue(new Error("transcript read failed"));
		const notice = vi.spyOn(f.session, "emitNotice");

		expect(await f.session.appendCustomEntryInBackground("extension-state", { ok: true })).toMatchObject({
			committed: false,
			durability: "unknown",
			entryId: "ghost-entry",
			cause: expect.stringContaining("durability could not be confirmed or disproved"),
		});
		expect(notice).toHaveBeenCalledWith(
			"warning",
			expect.stringContaining("Could not confirm that the custom entry extension-state was saved"),
			"session-publication",
		);
		// The operator notice must not leak the attempted id or the raw failure: both stay
		// in the structured result and the log, where a caller can act on them.
		const [, noticeText = ""] = notice.mock.calls.at(-1) ?? [];
		expect(noticeText).not.toContain("ghost-entry");
		expect(noticeText).not.toContain("release failed");
		expect(noticeText).not.toContain("transcript read failed");
	});

	it("treats a thrown background publication as unconfirmed durability", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();
		vi.spyOn(f.manager, "appendCustomEntrySharingSession").mockRejectedValue(new Error("lease connection dropped"));
		const notice = vi.spyOn(f.session, "emitNotice");

		// A throw does not prove the entry was absent: it may have committed before the
		// failure, so the operator must be told the outcome is unconfirmed, not refused.
		expect(await f.session.appendCustomEntryInBackground("extension-state", { ok: true })).toMatchObject({
			committed: false,
			durability: "unknown",
			cause: "lease connection dropped",
		});
		expect(notice).toHaveBeenCalledWith(
			"warning",
			"Could not confirm that the custom entry extension-state was saved to this session: the write did not complete. It may already be in the transcript.",
			"session-publication",
		);
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
			"Could not save the custom entry extension-state to this session: the session refused the write.",
			"session-publication",
		);

		// A stale transcript reason is an internal code; the notice must name the outcome.
		vi.spyOn(f.manager, "appendCustomEntrySharingSession").mockResolvedValue({
			kind: "stale",
			reason: "transcript_moved",
		});
		expect(await f.session.appendCustomEntryInBackground("extension-state", { ok: true })).toEqual({
			committed: false,
			cause: "transcript_moved",
		});
		expect(notice).toHaveBeenLastCalledWith(
			"warning",
			"Could not save the custom entry extension-state to this session: the transcript changed while the entry was being saved.",
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

	it("drops a deferred result that outlived the transcript it was queued for", async () => {
		const f = await fixture();
		// A sole deferred row: the restored-row path is only taken when the batch retains
		// something, and a successor row would hide the leak behind an earlier failure.
		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("echo orphaned", shellResult("orphaned output"), { onPersisted: persisted });
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let publications = 0;
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role !== "bashExecution") throw new Error("unexpected publication");
			publications++;
			entered.resolve();
			await gate.promise;
			// The manager noticed the rotation while its lease was pending.
			return { kind: "stale", reason: "transcript_moved" };
		});
		vi.spyOn(f.session.agent, "prompt").mockRejectedValue(new Error("stop after the flush"));
		const flushing = f.session.prompt("flush deferred").catch((error: unknown) => error);
		await entered.promise;

		const successor = SessionManager.create(f.manager.getCwd(), f.destination);
		managers.push(successor);
		successor.appendMessage(user("successor root"));
		await successor.ensureOnDisk();
		await successor.flush();
		const successorFile = successor.getSessionFile();
		if (!successorFile) throw new Error("missing successor file");
		await f.manager.setSessionFile(successorFile);

		gate.resolve();
		await flushing;
		// The retired row must not be re-queued against the successor transcript.
		expect(f.session.hasPendingBashMessages).toBe(false);
		expect(persisted).not.toHaveBeenCalled();
		await f.session.prompt("after the switch").catch(() => {});
		expect(publications).toBe(1);
		await f.manager.flush();
		expect(await Bun.file(successorFile).text()).not.toContain("orphaned output");
	});

	it("recovers a retained unresolved deferred result by re-reading it, never resubmitting", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("echo recoverable", shellResult("recoverable output"), { onPersisted: persisted });
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		// The append commits, but the caller is told its durability is unknown.
		const original = f.manager.appendMessageSharingSession.bind(f.manager);
		let publications = 0;
		let failReads = false;
		// Fail only the reconciliation read that follows the unknown outcome; admission and
		// the append's own verification must still read the transcript normally.
		const originalSnapshot = f.manager.captureCommittedSnapshot.bind(f.manager);
		const snapshot = vi.spyOn(f.manager, "captureCommittedSnapshot").mockImplementation(async () => {
			if (failReads) throw new Error("transcript read failed");
			return await originalSnapshot();
		});
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role !== "bashExecution") return original(message);
			publications++;
			const outcome = await original(message);
			if (outcome.kind !== "committed") return outcome;
			failReads = true;
			return { kind: "unknown", id: outcome.id, error: new Error("transaction release failed") };
		});

		await expect(f.session.prompt("first flush")).rejects.toThrow(
			/Could not confirm persistence of 1 of 1 deferred bash/,
		);
		expect(f.session.hasPendingBashMessages).toBe(true);
		expect(persisted).not.toHaveBeenCalled();

		// Reads work again: the next prompt re-reads the retained id and acknowledges the
		// entry that was durable all along, without a second append.
		failReads = false;
		await f.session.prompt("second flush").catch(() => {});
		expect(persisted).toHaveBeenCalledTimes(1);
		expect(f.session.hasPendingBashMessages).toBe(false);
		expect(publications).toBe(1);
		await f.manager.flush();
		expect((await Bun.file(f.file).text()).split("recoverable output").length - 1).toBe(1);
		snapshot.mockRestore();
	});

	it("drains a successor batch before the successor prompt reaches the agent", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		f.session.recordBashResult("echo first-batch", shellResult("first batch output"));
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const original = f.manager.appendMessageSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role === "bashExecution") {
				entered.resolve();
				await gate.promise;
			}
			return original(message);
		});
		// Captured synchronously when the successor run is entered. A result that arrived
		// while the joined drain was awaiting must already be in agent state, in order.
		let enteredCommands: string[] | undefined;
		let durableAtEntry: string | undefined;
		const promptSpy = vi.spyOn(f.session.agent, "prompt").mockImplementation(async () => {
			enteredCommands = f.session.agent.state.messages.flatMap(message =>
				message.role === "bashExecution" ? [message.command] : [],
			);
			// The ordering claim is about the moment the successor run starts, not about the
			// settled transcript: read the durable order here, while the drain that fed it has
			// already settled and the successor prompt has not appended anything of its own.
			await f.manager.flush();
			durableAtEntry = await Bun.file(f.file).text();
		});

		const successor = f.session.prompt("successor").catch((error: unknown) => error);
		await entered.promise;

		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		f.session.recordBashResult("echo second-batch", shellResult("second batch output"));
		delete (f.session as { isStreaming?: unknown }).isStreaming;
		await Bun.sleep(10);
		expect(enteredCommands).toBeUndefined();

		gate.resolve();
		await successor;
		expect(promptSpy).toHaveBeenCalledTimes(1);
		// The successor invocation must not start while its result is still queued.
		expect(enteredCommands).toEqual(["echo first-batch", "echo second-batch"]);
		if (durableAtEntry === undefined) throw new Error("durable transcript was not captured at prompt entry");
		expect(durableAtEntry.indexOf("first batch output")).toBeGreaterThanOrEqual(0);
		expect(durableAtEntry.indexOf("second batch output")).toBeGreaterThan(
			durableAtEntry.indexOf("first batch output"),
		);
		await f.session.awaitSessionSettlement();
		await f.manager.flush();
		const durable = await Bun.file(f.file).text();
		expect(durable.indexOf("first batch output")).toBeLessThan(durable.indexOf("second batch output"));
	});

	it("stops a cancelled preflight from claiming a successor batch and settles the abort", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		f.session.recordBashResult("echo A", shellResult("A output"));
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		const aEntered = Promise.withResolvers<void>();
		const aGate = Promise.withResolvers<void>();
		const bEntered = Promise.withResolvers<void>();
		const bGate = Promise.withResolvers<void>();
		const publications: string[] = [];
		const original = f.manager.appendMessageSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role === "bashExecution") {
				publications.push(message.command);
				if (message.command === "echo A") {
					aEntered.resolve();
					await aGate.promise;
				} else {
					bEntered.resolve();
					await bGate.promise;
				}
			}
			return original(message);
		});
		const promptSpy = vi.spyOn(f.session.agent, "prompt").mockImplementation(async () => {});

		const preflight = f.session.prompt("successor prompt").catch((error: unknown) => error);
		await aEntered.promise;
		try {
			// B queues while A's publication is still awaiting: the preflight token keeps
			// isStreaming true, so the result is deferred instead of appended inline.
			Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
			f.session.recordBashResult("echo B", shellResult("B output"));
			delete (f.session as { isStreaming?: unknown }).isStreaming;

			// The underlying agent is already idle here: only the preflight is live, so the
			// abort has no run to unwind and its terminal wait is the only thing in its way.
			const settledAbort = f.session.abort().then(
				() => "settled" as const,
				(error: unknown) => error,
			);
			aGate.resolve();

			// A settles and B is claimed by turn finalization while its own publication is
			// gated. The cancelled preflight must not be the claimant, and the abort must not
			// wait on either of them.
			await bEntered.promise;
			expect(f.session.isStreaming).toBe(false);
			expect(await Promise.race([settledAbort, Bun.sleep(3000).then(() => "timeout" as const)])).toBe("settled");

			bGate.resolve();
			// Cancellation unwinds as a cancellation, not as a publication failure, and the
			// successor invocation never starts.
			expect(await preflight).toBeUndefined();
			expect(promptSpy).not.toHaveBeenCalled();
			expect(publications).toEqual(["echo A", "echo B"]);
			expect(f.session.hasPendingBashMessages).toBe(false);
			const agentCommands = f.session.agent.state.messages.flatMap(message =>
				message.role === "bashExecution" ? [message.command] : [],
			);
			expect(agentCommands).toEqual(["echo A", "echo B"]);
			await f.session.awaitSessionSettlement();
			await f.manager.flush();
			const durable = await Bun.file(f.file).text();
			expect(durable.split("A output").length - 1).toBe(1);
			expect(durable.split("B output").length - 1).toBe(1);
			expect(durable.indexOf("A output")).toBeLessThan(durable.indexOf("B output"));
		} finally {
			// Release both publications even when an assertion above fails, so a regression
			// cannot wedge session teardown behind a gate nothing opens.
			aGate.resolve();
			bGate.resolve();
		}
	});

	it("stops a cancelled preflight from claiming a mixed-kind successor batch", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		f.session.recordBashResult("echo A", shellResult("A output"));
		delete (f.session as { isStreaming?: unknown }).isStreaming;

		const aEntered = Promise.withResolvers<void>();
		const aGate = Promise.withResolvers<void>();
		const bEntered = Promise.withResolvers<void>();
		const bGate = Promise.withResolvers<void>();
		const publications: string[] = [];
		const original = f.manager.appendMessageSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role === "bashExecution") {
				publications.push(message.command);
				if (message.command === "echo A") {
					aEntered.resolve();
					await aGate.promise;
				}
			} else if (message.role === "pythonExecution") {
				publications.push(message.code);
				bEntered.resolve();
				await bGate.promise;
			}
			return original(message);
		});
		const promptSpy = vi.spyOn(f.session.agent, "prompt").mockImplementation(async () => {});

		const preflight = f.session.prompt("successor prompt").catch((error: unknown) => error);
		await aEntered.promise;
		try {
			// B is a different kind than A: the preflight token keeps isStreaming true, so a
			// Python result recorded now takes the Python queue while the drain is still
			// awaiting A's publication. Claiming that queue needs its own cancellation re-read
			// inside the same drain, not only once per drain invocation.
			Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
			f.session.recordPythonResult("print('B')", shellResult("B output"));
			delete (f.session as { isStreaming?: unknown }).isStreaming;
			expect(f.session.isStreaming).toBe(true);

			const settledAbort = f.session.abort().then(
				() => "settled" as const,
				(error: unknown) => error,
			);
			aGate.resolve();

			// A settles and turn finalization — never the cancelled preflight — claims B, which
			// stays gated. The preflight token must already be gone and the abort must have
			// settled before B is released; a preflight that claimed B here would keep both.
			await bEntered.promise;
			expect(f.session.isStreaming).toBe(false);
			expect(await Promise.race([settledAbort, Bun.sleep(3000).then(() => "timeout" as const)])).toBe("settled");

			bGate.resolve();
			// Cancellation unwinds as a cancellation, not as a publication failure, and the
			// successor invocation never starts.
			expect(await preflight).toBeUndefined();
			expect(promptSpy).not.toHaveBeenCalled();
			// One publication attempt per result: a double claim would show two attempts for B,
			// and dropping B for the cancelled preflight would show none.
			expect(publications).toEqual(["echo A", "print('B')"]);
			expect(f.session.hasPendingPythonMessages).toBe(false);
			const agentResults = f.session.agent.state.messages.flatMap(message =>
				message.role === "bashExecution"
					? [message.command]
					: message.role === "pythonExecution"
						? [message.code]
						: [],
			);
			expect(agentResults).toEqual(["echo A", "print('B')"]);
			await f.session.awaitSessionSettlement();
			await f.manager.flush();
			const durable = await Bun.file(f.file).text();
			expect(durable.split("A output").length - 1).toBe(1);
			expect(durable.split("B output").length - 1).toBe(1);
			expect(durable.indexOf("A output")).toBeLessThan(durable.indexOf("B output"));
		} finally {
			// Release both publications even when an assertion above fails, so a regression
			// cannot wedge session teardown behind a gate nothing opens.
			aGate.resolve();
			bGate.resolve();
		}
	});

	it("orders an awaited publication behind older queued background publications", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const original = f.manager.appendModeChangeSharingSession.bind(f.manager);
		vi.spyOn(f.manager, "appendModeChangeSharingSession").mockImplementation(async (mode, data) => {
			if (mode === "plan") {
				entered.resolve();
				await gate.promise;
			}
			return original(mode, data);
		});

		// The holder owns the lane and the older publication queues behind it; the awaited
		// publication is newer than both and must not overtake them through a free lease.
		const holder = f.session.appendModeChangeInBackground("plan");
		await entered.promise;
		const older = f.session.appendModeChangeInBackground("none");
		const awaited = f.session.appendMessageForSession(user("awaited publication"));
		try {
			await Bun.sleep(10);
			expect(
				f.manager
					.getEntries()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.content === "awaited publication",
					),
			).toBe(false);
		} finally {
			// Release the lane even when the ordering assertion fails, so teardown can join.
			gate.resolve();
		}

		await holder;
		await older;
		await awaited;
		await f.manager.flush();

		const ordered = f.manager.getEntries().filter(entry => entry.type === "mode_change" || entry.type === "message");
		expect(ordered.flatMap(entry => (entry.type === "mode_change" ? [entry.mode] : []))).toEqual(["plan", "none"]);
		const awaitedEntry = ordered.at(-1);
		if (awaitedEntry?.type !== "message" || awaitedEntry.message.role !== "user")
			throw new Error("missing awaited publication");
		expect(awaitedEntry.message.content).toBe("awaited publication");
		// Leaf-linked transcript: the newer entry hangs off the older publication in order.
		const predecessorEntry = ordered.at(-2);
		if (!predecessorEntry) throw new Error("missing older publication");
		expect(predecessorEntry.type).toBe("mode_change");
		expect(awaitedEntry.parentId).toBe(predecessorEntry.id);
	});

	it("observes a throwing completion callback instead of rejecting unhandled", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
		await f.session.awaitSessionSettlement();

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const notice = vi.spyOn(f.session, "emitNotice");
			const persisted = vi.fn(() => {
				throw new Error("completion callback exploded");
			});
			f.session.recordBashResult("echo callback", shellResult("callback output"), { onPersisted: persisted });
			await f.session.awaitSessionSettlement();
			await Bun.sleep(20);
			expect(persisted).toHaveBeenCalledTimes(1);
			expect(notice).toHaveBeenCalledWith(
				"warning",
				"Saved the bash result to this session, but its completion step failed.",
				"session-publication",
			);
			// A callback failure must never resend: the row stays durable exactly once.
			await f.manager.flush();
			expect((await Bun.file(f.file).text()).split("callback output").length - 1).toBe(1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toEqual([]);
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
