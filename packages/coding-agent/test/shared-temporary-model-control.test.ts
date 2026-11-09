import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { isSettingsInitialized, resetSettingsForTest, Settings, settings } from "../src/config/settings";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import {
	ManagedAppendIdentityMismatchError,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import { managedSessionTransactionLockName } from "../src/session/internal/managed-session-transaction";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const stores: AuthStorage[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const options = { cause: "temporary-operation" as const, reason: "other" as const };

async function fixture(rebuild?: () => Promise<{ systemPrompt: string[] }>, rootInteractiveSharedAppend = true) {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-temporary-model-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	manager.appendMessage(user("first"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	const initial = getBundledModel("anthropic", "claude-sonnet-4-5");
	const selected = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!initial || !selected) throw new Error("Missing bundled models");
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.reminders": false });
	const edit: AgentTool = {
		name: "edit",
		label: "Edit",
		description: "Fixture edit tool",
		parameters: z.object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "edited" }] }),
	};
	const agent = new Agent({
		initialState: { model: initial, systemPrompt: ["Test"], tools: rebuild ? [edit] : [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		rootInteractiveSharedAppend,
		thinkingLevel: ThinkingLevel.Off,
		...(rebuild ? { toolRegistry: new Map([[edit.name, edit]]), rebuildSystemPrompt: rebuild } : {}),
	});
	sessions.push(session);
	const admitted = await manager.appendMessageSharingSession(user("shared root"));
	if (admitted.kind !== "committed") throw new Error(`Shared admission: ${admitted.kind}`);
	return { manager, session, agent, initial, selected, file, settings, destination, registry, admitted };
}

async function records(file: string) {
	return (await Bun.file(file).text())
		.trim()
		.split("\n")
		.map(
			line =>
				JSON.parse(line) as {
					type: string;
					id?: string;
					parentId?: string;
					model?: string;
					role?: string;
					thinkingLevel?: string;
				},
		);
}

async function bounded<T>(pending: Promise<T>, name: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`Timed out waiting for ${name}`)), 1500);
	try {
		return await Promise.race([pending, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function assertUncertainClose(f: { session: AgentSession; manager: SessionManager }, outcome: unknown) {
	sessions.splice(sessions.indexOf(f.session), 1);
	managers.splice(managers.indexOf(f.manager), 1);
	expect(await f.manager.closeStrict()).toMatchObject({ kind: "close_unknown", error: { cause: outcome } });
	await expect(f.session.dispose()).rejects.toBeInstanceOf(AggregateError);
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function configureRoleCycle(f: { settings: Settings; initial: Model; selected: Model }) {
	const roles = {
		default: `${f.initial.provider}/${f.initial.id}:off`,
		smol: `${f.selected.provider}/${f.selected.id}:high`,
	};
	f.settings.set("modelRoles", roles);
	f.settings.set("cycleOrder", ["default", "smol"]);
	return roles;
}

describe("shared temporary model control", () => {
	it("publishes temporary role cycles without changing settings or a peer branch", async () => {
		const f = await fixture();
		const roles = configureRoleCycle(f);
		const peer = await SessionManager.open(f.file, f.destination);
		managers.push(peer);
		const peerFirst = await peer.appendMessageSharingSession(user("peer before cycle"));
		if (peerFirst.kind !== "committed") throw new Error(peerFirst.kind);
		const prefix = await Bun.file(f.file).text();
		const before = (await records(f.file)).length;
		const revision = f.session.getUserModelSelectionRevision();
		expect(await f.session.cycleRoleModels(["default", "smol"], { temporary: true })).toMatchObject({
			role: "smol",
			model: f.selected,
			thinkingLevel: ThinkingLevel.High,
		});
		const appended = (await records(f.file)).slice(before);
		expect(appended).toHaveLength(2);
		expect(appended[0]).toMatchObject({ type: "model_change", role: "temporary", parentId: f.admitted.id });
		expect(appended[1]).toMatchObject({
			type: "thinking_level_change",
			thinkingLevel: ThinkingLevel.High,
			parentId: appended[0]?.id,
		});
		expect(await f.session.cycleRoleModels(["default", "smol"], { temporary: true })).toMatchObject({
			role: "default",
			model: f.initial,
			thinkingLevel: ThinkingLevel.Off,
		});
		expect(f.session.getUserModelSelectionRevision()).toBe(revision + 2);
		expect(f.settings.get("modelRoles")).toEqual(roles);
		expect((await Bun.file(f.file).text()).startsWith(prefix)).toBe(true);
		const peerSecond = await peer.appendMessageSharingSession(user("peer after cycle"));
		expect(peerSecond.kind).toBe("committed");
		if (peerSecond.kind === "committed")
			expect(peer.getBranch().find(entry => entry.id === peerSecond.id)?.parentId).toBe(peerFirst.id);
	});

	for (const optedIn of [false, true]) {
		it(`refuses ${optedIn ? "persistent" : "non-opted-in temporary"} role cycles before effects`, async () => {
			const f = await fixture(undefined, optedIn);
			const roles = configureRoleCycle(f);
			const before = await Bun.file(f.file).text();
			const revision = f.session.getUserModelSelectionRevision();
			const key = vi.spyOn(f.registry, "getApiKey");
			await expect(f.session.cycleRoleModels(["default", "smol"], { temporary: !optedIn })).rejects.toThrow(
				"Shared session mutation requires transaction admission: cycle role models",
			);
			expect(key).not.toHaveBeenCalled();
			expect(f.session.getUserModelSelectionRevision()).toBe(revision);
			expect(f.session.model).toBe(f.initial);
			expect(f.settings.get("modelRoles")).toEqual(roles);
			expect(await Bun.file(f.file).text()).toBe(before);
		});
	}

	it("reports temporary role-cycle uncertainty through the actual TUI action without success", async () => {
		const f = await fixture();
		const roles = configureRoleCycle(f);
		const capture = f.manager.captureCommittedSnapshot.bind(f.manager);
		const failure = new Error("role-cycle verification failed");
		let reads = 0;
		vi.spyOn(f.manager, "captureCommittedSnapshot").mockImplementation(async () => {
			if (++reads === 2) throw failure;
			return capture();
		});
		let thrown: unknown;
		const cycle = f.session.cycleRoleModels.bind(f.session);
		vi.spyOn(f.session, "cycleRoleModels").mockImplementation((...args) => {
			const pending = cycle(...args);
			void pending.catch(error => {
				thrown = error;
			});
			return pending;
		});
		const showError = vi.fn();
		const showStatus = vi.fn();
		const controller = new InputController({
			session: f.session,
			ui: {},
			showError,
			showStatus,
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
		} as unknown as InteractiveModeContext);
		const initialized = isSettingsInitialized();
		if (!initialized) await Settings.init({ inMemory: true });
		const previousOrder = settings.getOverride("cycleOrder");
		settings.override("cycleOrder", ["default", "smol"]);
		try {
			expect(await controller.actionRegistry.executeFresh("app.model.cycleBackward")).toBe(true);
			expect(thrown).toBeInstanceOf(Error);
			const outcome = (thrown as Error).cause;
			expect(outcome).toMatchObject({
				kind: "unknown",
				ids: [expect.any(String), expect.any(String)],
				error: failure,
			});
			expect(showError).toHaveBeenCalledWith((thrown as Error).message);
			expect(showStatus).not.toHaveBeenCalled();
			expect(f.session.model).toBe(f.initial);
			expect(f.session.thinkingLevel).toBe(ThinkingLevel.Off);
			expect(f.settings.get("modelRoles")).toEqual(roles);
			await assertUncertainClose(f, outcome);
		} finally {
			if (previousOrder === undefined) settings.clearOverride("cycleOrder");
			else settings.override("cycleOrder", previousOrder);
			if (!initialized) resetSettingsForTest();
		}
	});

	it("publishes only a temporary model record with unchanged reasoning and preserves peer cursor and settings", async () => {
		const f = await fixture();
		const peer = await SessionManager.open(f.file, f.destination);
		managers.push(peer);
		const peerFirst = await peer.appendMessageSharingSession(user("peer first"));
		if (peerFirst.kind !== "committed") throw new Error(peerFirst.kind);
		const prefix = await Bun.file(f.file).text();
		const roles = structuredClone(f.settings.get("modelRoles"));
		const priorSelection = f.session.getUserModelSelectionRevision();
		const scope = await f.session.setModelTemporary(f.selected, f.session.thinkingLevel, {
			...options,
			onMutationStarted: () => f.session.markUserModelSelection(),
		});
		expect(f.session.getUserModelSelectionRevision()).toBe(priorSelection + 1);
		expect(scope).toBeDefined();
		expect(f.session.model).toEqual(f.selected);
		const after = await Bun.file(f.file).text();
		expect(after.startsWith(prefix)).toBe(true);
		const appended = (await records(f.file)).filter(entry => !prefix.includes(`"id":"${entry.id}"`));
		expect(appended).toEqual([
			expect.objectContaining({
				type: "model_change",
				role: "temporary",
				model: `${f.selected.provider}/${f.selected.id}`,
				parentId: f.admitted.id,
			}),
		]);
		expect(f.settings.get("modelRoles")).toEqual(roles);
		const peerSecond = await peer.appendMessageSharingSession(user("peer second"));
		expect(peerSecond.kind).toBe("committed");
		if (peerSecond.kind === "committed")
			expect(peer.getBranch().find(entry => entry.id === peerSecond.id)?.parentId).toBe(peerFirst.id);
	});

	it("publishes two linked records and restores an auto-owned baseline without another append", async () => {
		const f = await fixture();
		const baselineThinking = f.session.thinkingLevel;
		const prefix = await records(f.file);
		const first = await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
		expect(first).toBeDefined();
		const appended = (await records(f.file)).slice(prefix.length);
		expect(appended).toHaveLength(2);
		expect(appended[0]).toMatchObject({ type: "model_change", role: "temporary", parentId: f.admitted.id });
		expect(appended[1]).toMatchObject({ type: "thinking_level_change", parentId: appended[0]?.id });
		const second = await f.session.setModelTemporary(f.initial, undefined, options);
		expect(second).toBeUndefined();
		expect(f.session.model).toEqual(f.initial);
		expect(f.session.thinkingLevel).toBe(baselineThinking);
		const restoredBytes = await Bun.file(f.file).text();
		if (first) expect(await f.session.restoreTemporaryProviderSessionScope(first)).toBe(false);
		expect(await Bun.file(f.file).text()).toBe(restoredBytes);
	});

	it("records repeated temporary reasoning against the restored baseline", async () => {
		const f = await fixture();
		const first = await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
		const before = (await records(f.file)).length;
		const second = await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
		expect((await records(f.file)).slice(before).map(entry => entry.type)).toEqual([
			"model_change",
			"thinking_level_change",
		]);
		if (!first || !second) throw new Error("Expected replaced auto-owned scopes");
		expect(await f.session.restoreTemporaryProviderSessionScope(first)).toBe(false);
		expect(await f.session.restoreTemporaryProviderSessionScope(second)).toBe(true);
		expect(f.session.model).toEqual(f.initial);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.Off);
	});

	it("keeps suspended provider maps intact until commit and closes only replaced auto state", async () => {
		const f = await fixture();
		const baselineMap = f.session.providerSessionState;
		const baselineClose = vi.fn();
		baselineMap.set("baseline", { close: baselineClose });
		const firstScope = await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
		if (!firstScope) throw new Error("Missing first auto scope");
		const firstMap = f.session.providerSessionState;
		const firstClose = vi.fn();
		firstMap.set("temporary", { close: firstClose });
		const refusal = new Error("model selection refused before mutation");
		const append = vi
			.spyOn(f.manager, "appendTemporaryModelChangeSharingSession")
			.mockResolvedValueOnce({ kind: "rejected", error: refusal });
		await expect(f.session.setModelTemporary(f.selected, ThinkingLevel.High, options)).rejects.toMatchObject({
			cause: { kind: "rejected", error: refusal },
		});
		expect(f.session.providerSessionState).toBe(firstMap);
		expect(firstClose).not.toHaveBeenCalled();
		expect(baselineClose).not.toHaveBeenCalled();
		append.mockRestore();
		const secondScope = await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
		if (!secondScope) throw new Error("Missing replacement auto scope");
		expect(await f.session.restoreTemporaryProviderSessionScope(firstScope)).toBe(false);
		expect(firstClose).toHaveBeenCalledTimes(1);
		expect(baselineClose).not.toHaveBeenCalled();
		expect(f.session.providerSessionState).not.toBe(firstMap);
		expect(await f.session.restoreTemporaryProviderSessionScope(secondScope)).toBe(true);
		expect(f.session.providerSessionState).toBe(baselineMap);
		expect(baselineClose).not.toHaveBeenCalled();
	});

	it("keeps an explicit scope caller-owned, rejects stale tokens and restores without recording a new model", async () => {
		const f = await fixture();
		const explicit = f.session.beginTemporaryProviderSessionScope("other");
		const chosen = await f.session.setModelTemporary(f.selected, ThinkingLevel.Low, {
			...options,
			providerSessionScope: explicit,
		});
		expect(chosen).toBe(explicit);
		const written = await Bun.file(f.file).text();
		expect(await f.session.restoreTemporaryProviderSessionScope(explicit)).toBe(true);
		expect(f.session.model).toEqual(f.initial);
		expect(await Bun.file(f.file).text()).toBe(written);
		await expect(
			f.session.setModelTemporary(f.selected, undefined, { ...options, providerSessionScope: explicit }),
		).rejects.toThrow(/superseded/);
		expect(await Bun.file(f.file).text()).toBe(written);
	});

	it("preserves nested explicit scope ownership and rejects a non-top supplied token", async () => {
		const f = await fixture();
		const outer = f.session.beginTemporaryProviderSessionScope("other");
		const inner = f.session.beginTemporaryProviderSessionScope("other");
		const prior = await Bun.file(f.file).text();
		await expect(
			f.session.setModelTemporary(f.selected, ThinkingLevel.Low, { ...options, providerSessionScope: outer }),
		).rejects.toThrow(/superseded/);
		expect(await Bun.file(f.file).text()).toBe(prior);
		expect(
			await f.session.setModelTemporary(f.selected, ThinkingLevel.Low, { ...options, providerSessionScope: inner }),
		).toBe(inner);
		const written = await Bun.file(f.file).text();
		expect(await f.session.restoreTemporaryProviderSessionScope(outer)).toBe(false);
		expect(f.session.model).toEqual(f.selected);
		expect(await Bun.file(f.file).text()).toBe(written);
		expect(await f.session.restoreTemporaryProviderSessionScope(inner)).toBe(true);
		expect(await f.session.restoreTemporaryProviderSessionScope(outer)).toBe(true);
		expect(f.session.model).toEqual(f.initial);
		expect(await Bun.file(f.file).text()).toBe(written);
	});

	for (const disposal of [false, true]) {
		it(`rejects ${disposal ? "disposed selection" : "restored scope"} during credential wait without late publication`, async () => {
			const f = await fixture();
			const explicit = disposal ? undefined : f.session.beginTemporaryProviderSessionScope("other");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const getKey = f.registry.getApiKey.bind(f.registry);
			vi.spyOn(f.registry, "getApiKey").mockImplementation(async (...args) => {
				entered.resolve();
				await release.promise;
				return getKey(...args);
			});
			const before = await Bun.file(f.file).text();
			const pending = f.session.setModelTemporary(f.selected, undefined, {
				...options,
				providerSessionScope: explicit,
			});
			void pending.catch(() => {});
			try {
				await bounded(entered.promise, "credential probe");
				if (disposal) {
					sessions.splice(sessions.indexOf(f.session), 1);
					await bounded(f.session.dispose(), "disposed temporary model session");
				} else expect(await f.session.restoreTemporaryProviderSessionScope(explicit!)).toBe(true);
			} finally {
				release.resolve();
			}
			await expect(bounded(pending, "superseded selection")).rejects.toThrow(/superseded/);
			if (!disposal) expect(f.session.model).toEqual(f.initial);
			expect(await Bun.file(f.file).text()).toBe(before);
		});
	}

	it("waits behind thinking and rejects a superseded selection before any shared write", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = f.manager.captureCommittedSnapshot.bind(f.manager);
		let reads = 0;
		vi.spyOn(f.manager, "captureCommittedSnapshot").mockImplementation(async () => {
			if (++reads === 1) {
				entered.resolve();
				await release.promise;
			}
			return original();
		});
		const thinking = f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
		void thinking.catch(() => {});
		let pending: Promise<unknown> | undefined;
		try {
			await bounded(entered.promise, "thinking publication");
			const before = await Bun.file(f.file).text();
			pending = f.session.setModelTemporary(f.selected, ThinkingLevel.Low, options);
			void pending.catch(() => {});
			f.session.markUserModelSelection();
			release.resolve();
			await bounded(thinking, "thinking release");
			await expect(bounded(pending, "superseded model selection")).rejects.toThrow(/superseded/);
			expect((await Bun.file(f.file).text()).slice(before.length)).not.toContain('"type":"model_change"');
			expect(f.session.model).toEqual(f.initial);
		} finally {
			release.resolve();
			await Promise.allSettled([thinking, ...(pending ? [pending] : [])]);
		}
	});

	for (const failingIndex of [1, 2] as const) {
		it(`reports ${failingIndex === 1 ? "first" : "second"} record refusal truthfully without live promotion`, async () => {
			const f = await fixture();
			const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
			let calls = 0;
			vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementation(function (
				this: ManagedSessionDescendantStore,
				...args
			) {
				if (++calls === failingIndex) throw new ManagedAppendIdentityMismatchError(args[0]);
				return original.apply(this, args);
			});
			let failure: unknown;
			try {
				await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			const outcome = (failure as Error).cause as { kind: string; ids?: string[]; error?: unknown };
			expect(outcome.kind).toBe(failingIndex === 1 ? "stale" : "unknown");
			if (failingIndex === 2) expect(outcome.ids).toHaveLength(2);
			expect(f.session.model).toEqual(f.initial);
			if (failingIndex === 2) await assertUncertainClose(f, outcome);
		});
	}

	for (const change of ["unchanged", "cancel", "thinking", "selection", "failure"] as const) {
		it(`reports postcommit ${change} with correct selection certainty`, async () => {
			const cancellation = new AbortController();
			const failure = new Error("edit synchronization failed after durable selection");
			let session!: AgentSession;
			const f = await fixture(async () => {
				if (change === "cancel") cancellation.abort();
				else if (change === "thinking") await session.setThinkingLevelForControl(ThinkingLevel.High, false);
				else if (change === "selection") session.markUserModelSelection();
				else if (change === "failure") throw failure;
				return { systemPrompt: ["Rebuilt"] };
			});
			session = f.session;
			let thrown: unknown;
			try {
				await session.setModelTemporary(f.selected, ThinkingLevel.Low, { ...options, signal: cancellation.signal });
			} catch (error) {
				thrown = error;
			}
			if (change === "unchanged") expect(thrown).toBeUndefined();
			else {
				expect(thrown).toBeInstanceOf(Error);
				expect((thrown as Error).message).toContain("Committed shared temporary model edit synchronization failed");
				const evidence = (thrown as Error).cause as { ids: string[]; error: unknown };
				expect(evidence.ids).toEqual([expect.any(String), expect.any(String)]);
				if (change === "failure") expect(evidence.error).toBe(failure);
			}
			expect(session.model).toEqual(f.selected);
			if (change === "thinking") expect(session.thinkingLevel).toBe(ThinkingLevel.High);
			expect(
				(await records(f.file)).filter(entry => entry.type === "model_change" && entry.role === "temporary"),
			).toHaveLength(1);
		});
	}

	for (const emitThinking of [false, true]) {
		it(`retains ${emitThinking ? "two" : "one"} ordered IDs and original verification failure without retry or live success`, async () => {
			const f = await fixture();
			const original = f.manager.captureCommittedSnapshot.bind(f.manager);
			const failure = new Error("post-batch verification failed");
			let reads = 0;
			vi.spyOn(f.manager, "captureCommittedSnapshot").mockImplementation(async () => {
				if (++reads === 2) throw failure;
				return original();
			});
			let thrown: unknown;
			try {
				await f.session.setModelTemporary(
					f.selected,
					emitThinking ? ThinkingLevel.High : ThinkingLevel.Off,
					options,
				);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			const outcome = (thrown as Error).cause as { kind: string; ids: readonly string[]; error: unknown };
			expect(outcome).toMatchObject({
				kind: "unknown",
				ids: Array.from({ length: emitThinking ? 2 : 1 }, () => expect.any(String)),
				error: failure,
			});
			expect(f.session.model).toEqual(f.initial);
			expect(
				await f.manager.appendTemporaryModelChangeSharingSession("anthropic/no-retry", undefined, () => true),
			).toEqual({ kind: "stale", reason: "persistence_latched" });
			await assertUncertainClose(f, outcome);
		});
	}

	for (const emitThinking of [false, true]) {
		it(`bootstraps pending history with ${emitThinking ? "two linked records" : "one temporary model record"}`, async () => {
			const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-temporary-bootstrap-"));
			roots.push(root);
			const cwd = path.join(root, "workspace");
			const agentDir = path.join(root, "agent");
			await fs.mkdir(cwd, { recursive: true });
			await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
			const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
			managers.push(manager);
			const pending = manager.appendMessage(user("original pending history"));
			const outcome = await manager.appendTemporaryModelChangeSharingSession(
				"anthropic/temporary",
				emitThinking ? { level: ThinkingLevel.High } : undefined,
				() => true,
			);
			expect(outcome.kind).toBe("committed");
			if (outcome.kind !== "committed") throw new Error(`Bootstrap: ${outcome.kind}`);
			expect(outcome.ids).toHaveLength(emitThinking ? 2 : 1);
			const file = manager.getSessionFile()!;
			const entries = await records(file);
			expect(entries[1]).toMatchObject({ type: "message", id: pending });
			expect(entries[2]).toMatchObject({
				type: "model_change",
				id: outcome.ids[0],
				parentId: pending,
				role: "temporary",
			});
			if (emitThinking)
				expect(entries[3]).toMatchObject({
					type: "thinking_level_change",
					id: outcome.ids[1],
					parentId: outcome.ids[0],
				});
			expect(manager.getLeafId()).toBe(outcome.ids[emitThinking ? 1 : 0]!);
			const later = await manager.appendMessageSharingSession(user("after bootstrap"));
			expect(later.kind).toBe("committed");
		});
	}

	it("retains both IDs and release failure after publication without live promotion", async () => {
		const f = await fixture();
		const capture = f.manager.captureCommittedSnapshot.bind(f.manager);
		const file = f.manager.getSessionFile()!;
		const lockName = `${managedSessionTransactionLockName(f.manager.getSessionId())}.lock`;
		let removedPath: string | undefined;
		let reads = 0;
		vi.spyOn(f.manager, "captureCommittedSnapshot").mockImplementation(async () => {
			const result = await capture();
			if (++reads === 2) {
				const directory = path.dirname(file);
				const relative = (await fs.readdir(directory, { recursive: true })).find(
					name => name === lockName || name.endsWith(`${path.sep}${lockName}`),
				);
				if (!relative) throw new Error("Active transaction lock not found");
				const lockPath = path.join(directory, relative);
				removedPath = `${lockPath}.held`;
				await fs.rename(lockPath, removedPath);
			}
			return result;
		});
		let failure: unknown;
		let cleanupError: unknown;
		try {
			await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
		} catch (error) {
			failure = error;
		} finally {
			if (removedPath)
				await fs.rm(removedPath, { force: true }).catch(error => {
					cleanupError = error;
				});
		}
		if (cleanupError !== undefined) throw new AggregateError([failure, cleanupError], "Release probe cleanup failed");
		expect(failure).toBeInstanceOf(Error);
		const outcome = (failure as Error).cause as { kind: string; ids: string[]; error: Error };
		expect(outcome).toMatchObject({ kind: "unknown", ids: [expect.any(String), expect.any(String)] });
		expect(outcome.error.name).toBe("ManagedSessionReleaseError");
		expect(f.session.model).toEqual(f.initial);
		await assertUncertainClose(f, outcome);
	});
});
