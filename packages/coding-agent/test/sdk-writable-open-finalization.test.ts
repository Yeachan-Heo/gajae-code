import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import * as discovery from "../src/discovery";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk/session";
import { AuthStorage } from "../src/session/auth-storage";
import { managedSessionTransactionLocksDirectory } from "../src/session/internal/managed-session-scope";
import { CURRENT_SESSION_VERSION, SessionManager, SessionManagerTestHooks } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";

const roots: string[] = [];
const managers = new Set<SessionManager>();
const sessions: CreateAgentSessionResult[] = [];
const auths: AuthStorage[] = [];
const settingsStores: Settings[] = [];
const registries: ModelRegistry[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const created of sessions.splice(0)) await created.session.dispose();
	for (const manager of managers) expect((await manager.closeStrict()).kind).toBe("closed");
	managers.clear();
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const auth of auths.splice(0)) auth.close();
	for (const settings of settingsStores.splice(0)) await settings.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-finalize-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir, { mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const authStorage = await AuthStorage.create(path.join(agentDir, "testauth.db"));
	auths.push(authStorage);
	const settings = Settings.isolated({ "async.enabled": false });
	settingsStores.push(settings);
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
	registries.push(modelRegistry);
	vi.spyOn(modelRegistry, "refresh").mockResolvedValue(undefined);
	vi.spyOn(modelRegistry, "refreshInBackground").mockImplementation(() => {});
	const options = {
		cwd,
		agentDir,
		authStorage,
		settings,
		modelRegistry,
		model: getBundledModel("anthropic", "claude-sonnet-4-5"),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames: ["__none__"],
	};
	return { cwd, agentDir, destination, options };
}

async function resumed(legacy: boolean) {
	const env = await fixture();
	const seed = SessionManager.create(env.cwd, env.destination);
	managers.add(seed);
	const root = seed.appendMessage({ role: "user", content: "root", timestamp: 1 });
	seed.appendMessage({ role: "user", content: "sibling", timestamp: 2 });
	seed.branch(root);
	const leaf = seed.appendMessage({ role: "user", content: "selected", timestamp: 3 });
	await seed.ensureOnDisk();
	const file = seed.getSessionFile()!;
	expect((await seed.closeStrict()).kind).toBe("closed");
	managers.delete(seed);
	if (legacy) {
		const bytes = await Bun.file(file).text();
		const newline = bytes.indexOf("\n");
		const header = JSON.parse(bytes.slice(0, newline));
		header.version = 4;
		await Bun.write(file, JSON.stringify(header) + bytes.slice(newline));
	}
	const before = await Bun.file(file).text();
	const manager = await SessionManager.open(file, env.destination);
	managers.add(manager);
	return { ...env, manager, file, before, leaf };
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

// Forwarding seams below observe real finalization; injected outcomes/errors are SDK routing evidence only.
describe("SDK writable-open finalization", () => {
	for (const supplied of [true, false]) {
		it(`pins ${supplied ? "the admitted manager" : "default manager ownership"} against options mutation`, async () => {
			const { manager, cwd, destination, options } = await resumed(true);
			const replacement = SessionManager.create(cwd, destination);
			managers.add(replacement);
			replacement.appendMessage({ role: "user", content: "unadmitted replacement", timestamp: 4 });
			const replacementIds = replacement.getEntries().map(entry => entry.id);
			const mutable = { ...options, sessionManager: supplied ? manager : undefined };
			const startup = createAgentSession(mutable);
			mutable.sessionManager = replacement;
			const created = await startup;
			sessions.push(created);
			managers.add(created.session.sessionManager);
			if (supplied) expect(created.session.sessionManager).toBe(manager);
			else expect(created.session.sessionManager).not.toBe(manager);
			expect(created.session.sessionManager).not.toBe(replacement);
			expect(replacement.getEntries().map(entry => entry.id)).toEqual(replacementIds);
			expect(await exists(replacement.getSessionFile()!)).toBe(false);
		});
	}
	it("preserves bounded current-format admission without full-transcript snapshots", async () => {
		const { cwd, destination, options } = await fixture();
		const seed = SessionManager.create(cwd, destination);
		managers.add(seed);
		seed.setSessionMemoryMode("off");
		await seed.ensureOnDisk();
		seed.appendCustomEntry("node", { payload: "old" });
		const kept = seed.appendCustomEntry("node", { payload: "kept" });
		seed.appendCompaction("summary", undefined, kept, 1);
		await seed.flush();
		const file = seed.getSessionFile()!;
		expect((await seed.closeStrict()).kind).toBe("closed");
		managers.delete(seed);
		const storage = new FileSessionStorage();
		let manager: SessionManager;
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
		try {
			manager = await SessionManager.open(file, destination, storage, "copy-retain", "enabled");
			managers.add(manager);
		} finally {
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
		}
		expect(manager.getSessionMemoryStats()).toMatchObject({
			lazyReopenSucceeded: true,
			lastReopenTransition: { kind: "rebuild", reason: "bounded_first_open" },
		});
		const snapshots = vi.spyOn(storage, "readSnapshotSync");
		const real = manager.finalizePendingWritableOpen.bind(manager);
		vi.spyOn(manager, "finalizePendingWritableOpen").mockImplementationOnce(async () => {
			const before = snapshots.mock.calls.filter(([candidate]) => candidate === file).length;
			const result = await real();
			expect(result).toBe("unchanged");
			expect(snapshots.mock.calls.filter(([candidate]) => candidate === file).length - before).toBe(0);
			return result;
		});
		sessions.push(await createAgentSession({ ...options, sessionManager: manager }));
	});
	it("validates conflicting borrowed auth ownership before finalizing", async () => {
		const { manager, file, before, options } = await resumed(true);
		const other = await AuthStorage.create(path.join(options.agentDir, "other-auth.db"));
		auths.push(other);
		const finalize = vi.spyOn(manager, "finalizePendingWritableOpen");
		const subscribe = vi.spyOn(options.authStorage, "onCredentialDisabled");
		await expect(createAgentSession({ ...options, authStorage: other, sessionManager: manager })).rejects.toThrow(
			"must be the same instance",
		);
		expect(finalize).not.toHaveBeenCalled();
		expect(subscribe).not.toHaveBeenCalled();
		expect(await Bun.file(file).text()).toBe(before);
	});

	for (const legacy of [true, false]) {
		it(`awaits real ${legacy ? "legacy migration" : "current resume"} before context, startup writes, and return`, async () => {
			const { manager, file, before, leaf, options } = await resumed(legacy);
			const entries = manager.getEntries();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const real = manager.finalizePendingWritableOpen.bind(manager);
			let outcome: string | undefined;
			const finalize = vi.spyOn(manager, "finalizePendingWritableOpen").mockImplementationOnce(async () => {
				const result = await real();
				outcome = result;
				entered.resolve();
				await release.promise;
				return result;
			});
			const context = vi.spyOn(manager, "buildSessionContext");
			const model = vi.spyOn(manager, "appendModelChange");
			const thinking = vi.spyOn(manager, "appendThinkingLevelChange");
			const shared = vi.spyOn(manager, "appendMessageSharingSession");
			const bindings = vi.spyOn(options.modelRegistry, "applyConfiguredModelBindings");
			const initialize = vi.spyOn(discovery, "initializeWithSettings");
			const subscribe = vi.spyOn(options.authStorage, "onCredentialDisabled");
			const onAttempt = vi.fn();
			let exposed = false;
			const startup = createAgentSession({
				...options,
				sessionManager: manager,
				modelRegistryStartupMutation: { owner: "cli-root", onAttempt },
			}).then(created => {
				exposed = true;
				sessions.push(created);
				return created;
			});
			try {
				await Promise.race([
					entered.promise,
					startup.then(() => {
						throw new Error("startup bypassed finalization");
					}),
				]);
				expect(outcome).toBe(legacy ? "published" : "unchanged");
				expect(exposed).toBe(false);
				for (const spy of [bindings, initialize, subscribe, onAttempt]) expect(spy).not.toHaveBeenCalled();
				expect(context).not.toHaveBeenCalled();
				expect(model).not.toHaveBeenCalled();
				expect(thinking).not.toHaveBeenCalled();
				expect(manager.getEntries()).toEqual(entries);
				expect(manager.getLeafId()).toBe(leaf);
				const published = await Bun.file(file).text();
				const records = Bun.JSONL.parse(published);
				expect((records[0] as { version: number }).version).toBe(CURRENT_SESSION_VERSION);
				expect(records.slice(1)).toEqual(Bun.JSONL.parse(before).slice(1));
				if (!legacy) expect(published).toBe(before);
				release.resolve();
				const created = await startup;
				expect(created.session.sessionManager).toBe(manager);
				expect(finalize).toHaveBeenCalledTimes(1);
				expect(context).toHaveBeenCalled();
				for (const spy of [bindings, initialize, subscribe]) expect(spy).toHaveBeenCalled();
				expect(shared).not.toHaveBeenCalled();
			} finally {
				release.resolve();
				await Promise.allSettled([startup]);
			}
		});
	}

	for (const kind of ["default", "pending", "memory", "new-session"] as const) {
		it(`preserves ${kind} bootstrap at the finalization boundary`, async () => {
			const env = await fixture();
			let manager: SessionManager | undefined;
			if (kind !== "default") {
				manager =
					kind === "memory" ? SessionManager.inMemory(env.cwd) : SessionManager.create(env.cwd, env.destination);
				managers.add(manager);
				if (kind === "new-session") {
					manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
					await manager.ensureOnDisk();
					const previousFile = manager.getSessionFile()!;
					expect((await manager.closeStrict()).kind).toBe("closed");
					managers.delete(manager);
					manager = await SessionManager.open(previousFile, env.destination);
					managers.add(manager);
					await manager.newSession();
				}
				manager.appendMessage({ role: "user", content: "pending", timestamp: 2 });
				manager.appendThinkingLevelChange("high");
			}
			const real = SessionManager.prototype.finalizePendingWritableOpen;
			let observed = false;
			const finalize = vi
				.spyOn(SessionManager.prototype, "finalizePendingWritableOpen")
				.mockImplementation(async function (this: SessionManager) {
					const entries = this.getEntries();
					const leaf = this.getLeafId();
					const file = this.getSessionFile();
					const locks = file ? managedSessionTransactionLocksDirectory(path.dirname(file)) : undefined;
					const hadLocks = locks ? await exists(locks) : false;
					// Managed scope initialization can already create this directory.
					const lockStat = locks && hadLocks ? await fs.stat(locks, { bigint: true }) : undefined;
					const lockEntries = locks && hadLocks ? await fs.readdir(locks) : undefined;
					const result = await real.call(this);
					expect(result).toBe("unchanged");
					expect(this.getEntries()).toEqual(entries);
					expect(this.getLeafId()).toBe(leaf);
					if (file) expect(await exists(file)).toBe(false);
					if (locks) {
						expect(await exists(locks)).toBe(hadLocks);
						if (lockStat) {
							if (!lockEntries) throw new Error("Missing prior lock inventory");
							const after = await fs.stat(locks, { bigint: true });
							expect([after.dev, after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
								lockStat.dev,
								lockStat.ino,
								lockStat.mtimeNs,
								lockStat.ctimeNs,
							]);
							expect(await fs.readdir(locks)).toEqual(lockEntries);
						}
					}
					observed = true;
					return result;
				});
			const created = await createAgentSession({ ...env.options, ...(manager ? { sessionManager: manager } : {}) });
			sessions.push(created);
			managers.add(created.session.sessionManager);
			expect(observed).toBe(kind !== "default");
			if (kind === "default") {
				expect(finalize).not.toHaveBeenCalled();
				const file = created.session.sessionManager.getSessionFile()!;
				expect(await exists(file)).toBe(false);
			} else expect(finalize).toHaveBeenCalledTimes(1);
		});
	}

	it("leaves a read-only legacy open unfinalized and unchanged", async () => {
		const finalize = vi.spyOn(SessionManager.prototype, "finalizePendingWritableOpen");
		const { manager, file, before } = await resumed(true);
		manager.buildSessionContext();
		expect(await Bun.file(file).text()).toBe(before);
		expect(finalize).not.toHaveBeenCalled();
	});

	it("refuses an actually stale legacy opener without rewriting its peer's transcript", async () => {
		const { manager, file, options, destination } = await resumed(true);
		const peer = await SessionManager.open(file, destination);
		managers.add(peer);
		expect(await peer.finalizePendingWritableOpen()).toBe("published");
		const bytes = await Bun.file(file).text();
		const finalize = vi.spyOn(manager, "finalizePendingWritableOpen");
		const context = vi.spyOn(manager, "buildSessionContext");
		const close = vi.spyOn(manager, "closeStrict");
		const reopen = vi.spyOn(SessionManager, "open");
		await expect(createAgentSession({ ...options, sessionManager: manager })).rejects.toThrow(
			"stale transcript identity",
		);
		expect(finalize).toHaveBeenCalledTimes(1);
		for (const spy of [context, close, reopen]) expect(spy).not.toHaveBeenCalled();
		expect(await Bun.file(file).text()).toBe(bytes);
	});

	for (const outcome of ["stale", "unsupported", "not_published", "throw"] as const) {
		it(`rejects injected ${outcome} without exposure, retry, reopening, or borrowed-manager disposal`, async () => {
			const { manager, file, before, options } = await resumed(false);
			const injected = new Error("injected transaction boundary failure (not a native failure)");
			const finalize = vi.spyOn(manager, "finalizePendingWritableOpen");
			if (outcome === "throw") finalize.mockRejectedValueOnce(injected);
			else finalize.mockResolvedValueOnce(outcome);
			const context = vi.spyOn(manager, "buildSessionContext");
			const close = vi.spyOn(manager, "close");
			const strict = vi.spyOn(manager, "closeStrict");
			const reopen = vi.spyOn(SessionManager, "open");
			const discard = vi.spyOn(manager, "discardPreparedNewSession");
			const shared = vi.spyOn(manager, "appendMessageSharingSession");
			const bindings = vi.spyOn(options.modelRegistry, "applyConfiguredModelBindings");
			const initialize = vi.spyOn(discovery, "initializeWithSettings");
			const subscribe = vi.spyOn(options.authStorage, "onCredentialDisabled");
			const onAttempt = vi.fn();
			const startup = createAgentSession({
				...options,
				sessionManager: manager,
				modelRegistryStartupMutation: { owner: "cli-root", onAttempt },
			});
			if (outcome === "throw") await expect(startup).rejects.toBe(injected);
			else await expect(startup).rejects.toThrow(outcome === "not_published" ? "migration not published" : outcome);
			expect(finalize).toHaveBeenCalledTimes(1);
			for (const spy of [
				context,
				close,
				strict,
				reopen,
				discard,
				shared,
				bindings,
				initialize,
				subscribe,
				onAttempt,
			])
				expect(spy).not.toHaveBeenCalled();
			expect(await Bun.file(file).text()).toBe(before);
		});
	}

	it("does not undo a real migration when an injected post-publication boundary throws", async () => {
		const { manager, file, before, options } = await resumed(true);
		const injected = new Error("injected post-publication boundary (not native release evidence)");
		const real = manager.finalizePendingWritableOpen.bind(manager);
		const finalize = vi.spyOn(manager, "finalizePendingWritableOpen").mockImplementationOnce(async () => {
			expect(await real()).toBe("published");
			throw injected;
		});
		const close = vi.spyOn(manager, "closeStrict");
		const reopen = vi.spyOn(SessionManager, "open");
		await expect(createAgentSession({ ...options, sessionManager: manager })).rejects.toBe(injected);
		expect(finalize).toHaveBeenCalledTimes(1);
		expect(close).not.toHaveBeenCalled();
		expect(reopen).not.toHaveBeenCalled();
		const after = Bun.JSONL.parse(await Bun.file(file).text());
		expect((after[0] as { version: number }).version).toBe(CURRENT_SESSION_VERSION);
		expect(after.slice(1)).toEqual(Bun.JSONL.parse(before).slice(1));
	});
});
