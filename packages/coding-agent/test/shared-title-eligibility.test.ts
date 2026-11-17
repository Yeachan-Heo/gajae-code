import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { logger } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { managedSessionTransactionLocksDirectory } from "../src/session/internal/managed-session-scope";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import {
	SessionManager,
	SessionNearLimitAppendError,
	SharedSessionMutationUnsupportedError,
} from "../src/session/session-manager";
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
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		// Starring selects shared publication from the manager's own eligibility: an
		// append-only header patch, never the legacy header upgrade.
		expect(await f.manager.setSessionStarred(true)).toBe(true);
		expect(f.manager.isSessionStarred()).toBe(true);
		expect((await fs.readFile(f.file)).subarray(0, before.length).equals(before)).toBe(true);

		const reopened = await SessionManager.open(f.file, f.destination);
		managers.push(reopened);
		expect(reopened.getEntries().some(entry => entry.id === peer.id)).toBe(true);
		expect(reopened.isSessionStarred()).toBe(true);
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
		expect(() => f.manager.appendMessage(user("after both titles"))).not.toThrow();
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
		expect(() => f.manager.appendMessage(user("after temporary model"))).not.toThrow();
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		// Starring is an append-only header patch, not a rewrite: it commits under the fence.
		expect(await f.manager.setSessionStarred(true)).toBe(true);
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
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
	});

	it("scopes discovered-tool append admission while retaining rewrite authority", async () => {
		const f = await fixture();
		f.manager.appendMessage(user("local root"));
		await f.manager.ensureOnDisk();
		await f.manager.flush();
		const outcome = await f.manager.appendToolSelectionsSharingSession(["mcp__probe"], undefined, () => true);
		expect(outcome.kind).toBe("committed");
		expect(() => f.manager.appendMessage(user("after tool selection"))).not.toThrow();
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		// Starring is an append-only header patch, not a rewrite: it commits under the fence.
		expect(await f.manager.setSessionStarred(true)).toBe(true);
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
		expect(() => f.manager.appendMessage(user("after mode change"))).not.toThrow();
		await expect(f.manager.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		// Starring is an append-only header patch, not a rewrite: it commits under the fence.
		expect(await f.manager.setSessionStarred(true)).toBe(true);
	});

	it("persists a tree-navigator label after shared admission", async () => {
		const f = await fixture();
		f.session.agent.emitExternalEvent({ type: "message_end", message: user("first canonical message") });
		await f.session.awaitSessionSettlement();
		const leaf = f.manager.getLeafId();
		if (!leaf) throw new Error("missing leaf");
		// modes/controllers/selector-controller.ts routes the tree navigator's label submit here.
		expect(await f.session.appendLabelChangeInBackground(leaf, "tree-label")).toEqual({ committed: true });
		await f.session.awaitSessionSettlement();
		await f.manager.flush();
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

	it("never re-queues an unknown deferred command result and closes with its receipt", async () => {
		const f = await fixture();
		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("echo unknown", shellResult("unknown output"), { onPersisted: persisted });
		delete (f.session as { isStreaming?: unknown }).isStreaming;
		const append = f.manager.appendMessageSharingSession.bind(f.manager);
		let attempted: string | undefined;
		// The entry lands, but the publication cannot prove it (e.g. a lease release failure).
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			const outcome = await append(message);
			if (outcome.kind !== "committed") throw new Error(`unexpected ${outcome.kind}`);
			attempted = outcome.id;
			return { kind: "unknown", id: outcome.id, error: new Error("lease release failed") };
		});
		const failure = await f.session.prompt("flush now").then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as Error).message).toContain(
			`Could not confirm 1 of 1 deferred bash execution message (attempted ids: ${attempted})`,
		);
		expect(persisted).not.toHaveBeenCalled();
		// Never queued for a retry that would append the same result under a new id.
		expect(f.session.hasPendingBashMessages).toBe(false);
		expect(f.session.isDisposed).toBe(true);
		const text = await Bun.file(f.file).text();
		expect(text.split("unknown output")).toHaveLength(2);
		expect(text).toContain(`"id":"${attempted}"`);
	});

	it("joins an in-flight deferred drain so one result publishes and reports exactly once", async () => {
		const f = await fixture();
		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("echo once", shellResult("once output"), { onPersisted: persisted });
		delete (f.session as { isStreaming?: unknown }).isStreaming;
		// Stop the prompt right after its deferred flush; no provider call is made.
		vi.spyOn(ModelRegistry.prototype, "getApiKey").mockResolvedValue(undefined);
		const append = f.manager.appendMessageSharingSession.bind(f.manager);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let publications = 0;
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role === "bashExecution" && ++publications === 1) {
				entered.resolve();
				await release.promise;
			}
			return append(message);
		});
		const settle = (pending: Promise<void>) =>
			pending.then(
				() => undefined,
				(error: unknown) => error,
			);
		const first = settle(f.session.prompt("first flush"));
		await entered.promise;
		// A wedged cleanup forces recovery, whose non-awaited drain overlaps the held one.
		const waitForIdle = vi.spyOn(f.session.agent, "waitForIdle").mockReturnValue(new Promise<void>(() => {}));
		const aborted = settle(f.session.abort({ timeoutMs: 0 }));
		await Bun.sleep(50);
		waitForIdle.mockRestore();
		release.resolve();
		await first;
		expect(await Promise.race([aborted.then(() => "settled"), Bun.sleep(2000).then(() => "timeout")])).toBe(
			"settled",
		);
		expect(publications).toBe(1);
		expect(persisted).toHaveBeenCalledTimes(1);
		expect(f.session.hasPendingBashMessages).toBe(false);
		await f.manager.flush();
		expect((await Bun.file(f.file).text()).split("once output")).toHaveLength(2);
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
