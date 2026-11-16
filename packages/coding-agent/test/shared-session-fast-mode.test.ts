import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession, SharedControlPublicationError } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager, type SharedEntriesAppendOutcome } from "../src/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const stores: AuthStorage[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

async function fixture(rootInteractiveSharedAppend = true) {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-fast-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	manager.appendMessage(user("seed"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry: registry,
		rootInteractiveSharedAppend,
	});
	sessions.push(session);
	return { session, manager, file, destination };
}

async function canonical(session: AgentSession, text: string) {
	session.agent.emitExternalEvent({ type: "message_end", message: user(text) });
	await session.awaitSessionSettlement();
}

async function autoDisable(session: AgentSession) {
	const state = { fastModeDisabled: true, close: vi.fn() };
	session.providerSessionState.set("anthropic-messages", state);
	session.agent.emitExternalEvent({
		type: "message_end",
		message: { ...createAssistantMessage("fallback"), disabledFeatures: ["priority"] },
	});
	await session.awaitSessionSettlement();
	expect(session.isFastModeActive()).toBe(false);
	return state;
}

function holdSnapshot(manager: SessionManager) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const capture = manager.captureCommittedSnapshot.bind(manager);
	let reads = 0;
	vi.spyOn(manager, "captureCommittedSnapshot").mockImplementation(async () => {
		if (++reads === 1) {
			entered.resolve();
			await release.promise;
		}
		return capture();
	});
	return { entered: entered.promise, release: () => release.resolve() };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("Timed out waiting for fast control")), 2000);
	try {
		return await Promise.race([pending, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

const tiers = (manager: SessionManager) => manager.getBranch().filter(entry => entry.type === "service_tier_change");

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("shared session fast controls", () => {
	it("publishes after canonical/title, preserves siblings and prefix, and reopens durable intent", async () => {
		const f = await fixture();
		await canonical(f.session, "shared canonical");
		expect(await f.session.setSessionName("Shared fast", "user")).toBe(true);
		const localParent = f.manager.getLeafId();
		const peer = await SessionManager.open(f.file, f.destination);
		managers.push(peer);
		const peerFirst = await peer.appendMessageSharingSession(user("peer before"));
		if (peerFirst.kind !== "committed") throw new Error(peerFirst.kind);
		const prefix = await Bun.file(f.file).text();
		await f.session.setFastMode(true);
		expect(f.session.serviceTier).toBe("priority");
		expect(tiers(f.manager)).toHaveLength(1);
		expect(tiers(f.manager)[0]?.parentId).toBe(localParent);
		const state = await autoDisable(f.session);
		const beforeRearm = await Bun.file(f.file).text();
		const publish = vi.spyOn(f.manager, "appendServiceTierChangeSharingSession");
		await f.session.setFastMode(true);
		expect(publish).toHaveBeenLastCalledWith("priority", false, expect.any(Function));
		expect(state.fastModeDisabled).toBe(false);
		expect(f.session.isFastModeActive()).toBe(true);
		expect(await Bun.file(f.file).text()).toBe(beforeRearm);
		await f.session.setFastMode(false);
		expect(f.session.serviceTier).toBeUndefined();
		expect(tiers(f.manager).map(entry => entry.serviceTier)).toEqual(["priority", null]);
		expect((await Bun.file(f.file).text()).startsWith(prefix)).toBe(true);
		await canonical(f.session, "canonical after fast");
		const peerSecond = await peer.appendMessageSharingSession(user("peer after"));
		if (peerSecond.kind !== "committed") throw new Error(peerSecond.kind);
		expect(peer.getEntry(peerSecond.id)?.parentId).toBe(peerFirst.id);
		const reopened = await SessionManager.open(f.file, f.destination);
		managers.push(reopened);
		expect(reopened.getEntries().filter(entry => entry.type === "service_tier_change").map(entry => entry.serviceTier))
			.toEqual(["priority", null]);
	});

	for (const scope of ["claude-only", "openai-only"] as const) {
		it(`resolves queued /fast on against ${scope} and two toggles compose`, async () => {
			const f = await fixture();
			await canonical(f.session, "shared");
			const held = holdSnapshot(f.manager);
			const select = f.session.setServiceTier(scope);
			void select.catch(() => {});
			let on: Promise<void> | undefined;
			try {
				await bounded(held.entered);
				on = f.session.setFastMode(true);
				held.release();
				await bounded(Promise.all([select, on]));
			} finally {
				held.release();
				await Promise.allSettled([select, ...(on ? [on] : [])]);
			}
			expect(f.session.serviceTier).toBe(scope);
			expect(tiers(f.manager).map(entry => entry.serviceTier)).toEqual([scope]);
			const first = f.session.toggleFastMode();
			const second = f.session.toggleFastMode();
			expect(await bounded(Promise.all([first, second]))).toEqual([false, true]);
			expect(tiers(f.manager).map(entry => entry.serviceTier)).toEqual([scope, null, "priority"]);
		});
	}

	it("unchanged granting tiers require count-zero admission before provider rearm", async () => {
		const f = await fixture();
		await f.session.setServiceTier("claude-only");
		const state = await autoDisable(f.session);
		const before = await Bun.file(f.file).text();
		const publish = vi.spyOn(f.manager, "appendServiceTierChangeSharingSession");
		await f.session.setServiceTier("claude-only");
		expect(publish).toHaveBeenLastCalledWith("claude-only", false, expect.any(Function));
		expect(state.fastModeDisabled).toBe(false);
		expect(f.session.isFastModeActive()).toBe(true);
		expect(await Bun.file(f.file).text()).toBe(before);
	});

	for (const outcome of [
		{ kind: "rejected", error: new Error("credential secret must not reach message") },
		{ kind: "stale", reason: "persistence_latched" },
	] as const) {
		it(`${outcome.kind} leaves tier/provider markers unchanged and does not poison the FIFO`, async () => {
			const f = await fixture();
			await f.session.setServiceTier("priority");
			const state = await autoDisable(f.session);
			const before = await Bun.file(f.file).text();
			vi.spyOn(f.manager, "appendServiceTierChangeSharingSession").mockResolvedValueOnce(outcome);
			const failed = f.session.setFastMode(true);
			const recovery = f.session.setFastMode(false);
			await expect(failed).rejects.toMatchObject({
				name: "SharedControlPublicationError", operation: "set fast mode", code: outcome.kind, outcome,
			});
			expect(state.fastModeDisabled).toBe(true);
			await recovery;
			expect(f.session.serviceTier).toBeUndefined();
			expect(state.fastModeDisabled).toBe(true);
			expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
			expect(tiers(f.manager).map(entry => entry.serviceTier)).toEqual(["priority", null]);
		});
	}

	it("retains exact unknown IDs and closes without retry, compensation, or promotion", async () => {
		const f = await fixture();
		await canonical(f.session, "shared");
		const capture = f.manager.captureCommittedSnapshot.bind(f.manager);
		const failure = new Error("verification failed with private details");
		let reads = 0;
		vi.spyOn(f.manager, "captureCommittedSnapshot").mockImplementation(async () => {
			if (++reads === 2) throw failure;
			return capture();
		});
		let thrown: unknown;
		try {
			await f.session.setFastMode(true);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SharedControlPublicationError);
		const error = thrown as SharedControlPublicationError;
		expect(error.message).not.toContain(failure.message);
		expect(error.outcome).toMatchObject({ kind: "unknown", ids: [expect.any(String)], error: failure });
		expect(error.cause).toBe(error.outcome);
		expect(f.session.serviceTier).toBeUndefined();
		expect(await f.manager.appendServiceTierChangeSharingSession("priority", true, () => true))
			.toEqual({ kind: "stale", reason: "persistence_latched" });
		expect((await Bun.file(f.file).text()).split('"type":"service_tier_change"')).toHaveLength(2);
		sessions.splice(sessions.indexOf(f.session), 1);
		managers.splice(managers.indexOf(f.manager), 1);
		expect(await f.manager.closeStrict()).toMatchObject({ kind: "close_unknown", error: { cause: error.outcome } });
		await expect(bounded(f.session.dispose())).rejects.toBeInstanceOf(AggregateError);
	});

	it("a committed receipt that loses applicability fails closed with the exact receipt", async () => {
		const f = await fixture();
		await canonical(f.session, "shared");
		const append = f.manager.appendServiceTierChangeSharingSession.bind(f.manager);
		let receipt: SharedEntriesAppendOutcome | undefined;
		vi.spyOn(f.manager, "appendServiceTierChangeSharingSession").mockImplementation(async (...args) => {
			receipt = await append(...args);
			void f.session.dispose().catch(() => {});
			return receipt;
		});
		let thrown: unknown;
		try { await f.session.setFastMode(true); } catch (error) { thrown = error; }
		expect(thrown).toMatchObject({ code: "committed_not_applied", operation: "set fast mode" });
		expect((thrown as SharedControlPublicationError).outcome).toBe(receipt);
		expect(f.session.serviceTier).toBeUndefined();
		await bounded(f.session.dispose());
	});

	it("idle settlement and disposal join active and queued controls without waiting on themselves", async () => {
		const f = await fixture();
		await canonical(f.session, "shared");
		const held = holdSnapshot(f.manager);
		const first = f.session.setFastMode(true);
		const second = f.session.toggleFastMode();
		void first.catch(() => {});
		void second.catch(() => {});
		try {
			await bounded(held.entered);
			expect(f.session.isAwaitingIdle).toBe(true);
			expect(() => f.session.prepareCloseIfIdle()).toThrow("Session is not idle");
			let settled = false;
			const idle = f.session.awaitSessionSettlement().then(() => { settled = true; });
			await Promise.resolve();
			expect(settled).toBe(false);
			const closing = f.session.dispose();
			held.release();
			await expect(bounded(first)).rejects.toBeInstanceOf(SharedControlPublicationError);
			await expect(bounded(second)).rejects.toBeInstanceOf(SharedControlPublicationError);
			await bounded(Promise.all([closing, idle]));
			expect(tiers(f.manager)).toHaveLength(0);
			expect(f.session.serviceTier).toBeUndefined();
		} finally {
			held.release();
			await Promise.allSettled([first, second]);
		}
	});

	it("thinking and canonical work can follow a queued fast control without a scheduling deadlock", async () => {
		const f = await fixture();
		await canonical(f.session, "before");
		const fast = f.session.setFastMode(true);
		const thinking = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
		const after = canonical(f.session, "after");
		await bounded(Promise.all([fast, thinking, after]));
		expect(f.session.serviceTier).toBe("priority");
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(f.manager.getBranch().slice(-3).map(entry => entry.type))
			.toEqual(["service_tier_change", "thinking_level_change", "message"]);
	});

	it("untouched root=false remains legacy, then adopted root=false routes fast/effort/canonical through shared admission", async () => {
		const f = await fixture(false);
		expect(f.session.usesSharedControlPublication()).toBe(false);
		const shared = vi.spyOn(f.manager, "appendServiceTierChangeSharingSession");
		const pending = f.session.setServiceTier("claude-only");
		// No transcript transaction is needed yet: legacy side effects stay synchronous.
		expect(f.session.serviceTier).toBe("claude-only");
		await pending;
		expect(shared).not.toHaveBeenCalled();
		await canonical(f.session, "legacy canonical");
		expect(f.manager.requiresSharedMutationAdmission()).toBe(false);
		const adopted = await f.manager.appendMessageSharingSession(user("adopt"));
		if (adopted.kind !== "committed") throw new Error(adopted.kind);
		expect(f.session.usesSharedControlPublication()).toBe(true);
		await f.session.setFastMode(false);
		await f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
		await canonical(f.session, "shared canonical after control");
		expect(shared).toHaveBeenCalledTimes(1);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(f.manager.getBranch().slice(-3).map(entry => entry.type))
			.toEqual(["service_tier_change", "thinking_level_change", "message"]);
	});
});
