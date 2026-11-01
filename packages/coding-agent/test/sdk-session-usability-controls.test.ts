import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager, SessionManagerTestHooks } from "@gajae-code/coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriter,
	type SessionStorageWriterOpenOptions,
} from "@gajae-code/coding-agent/session/session-storage";
import * as titleGenerator from "@gajae-code/coding-agent/utils/title-generator";
import { TempDir } from "@gajae-code/utils";

describe("SDK automatic session titles", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let generate: Mock<typeof titleGenerator.generateSessionTitle>;
	let originalNoTitle: string | undefined;
	let originalPiNoTitle: string | undefined;

	beforeEach(async () => {
		originalNoTitle = process.env.GJC_NO_TITLE;
		originalPiNoTitle = process.env.PI_NO_TITLE;
		delete process.env.GJC_NO_TITLE;
		delete process.env.PI_NO_TITLE;
		dir = TempDir.createSync();
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		const registry = new ModelRegistry(auth);
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		generate = spyOn(titleGenerator, "generateSessionTitle");
	});

	afterEach(async () => {
		generate.mockRestore();
		await session.dispose();
		auth.close();
		dir.removeSync();
		if (originalNoTitle === undefined) delete process.env.GJC_NO_TITLE;
		else process.env.GJC_NO_TITLE = originalNoTitle;
		if (originalPiNoTitle === undefined) delete process.env.PI_NO_TITLE;
		else process.env.PI_NO_TITLE = originalPiNoTitle;
	});

	it("applies a sanitized auto title and does not overwrite a name", async () => {
		generate.mockResolvedValue("  A title  ");
		expect(await session.generateAutoSessionTitle("hello")).toEqual({ kind: "applied", title: "A title" });
		expect(session.sessionManager.getSessionName()).toBe("A title");
		expect(await session.generateAutoSessionTitle("again")).toEqual({ kind: "skipped", reason: "named" });
		expect(generate).toHaveBeenCalledTimes(1);
	});

	it("deduplicates in-flight generation and lets a manual title win", async () => {
		const deferred = Promise.withResolvers<string | null>();
		generate.mockReturnValue(deferred.promise);
		const first = session.generateAutoSessionTitle("hello");
		expect(await session.generateAutoSessionTitle("hello")).toEqual({ kind: "skipped", reason: "in_flight" });
		await session.setSessionName("Manual", "user");
		deferred.resolve("Generated");
		expect(await first).toEqual({ kind: "skipped", reason: "named" });
		expect(session.sessionManager.getSessionName()).toBe("Manual");
		expect(generate).toHaveBeenCalledTimes(1);
	});

	it("rejects completion after identity change or host retirement", async () => {
		const deferred = Promise.withResolvers<string | null>();
		generate.mockReturnValue(deferred.promise);
		const first = session.generateAutoSessionTitle("hello");
		const identity = spyOn(session.sessionManager, "getSessionId").mockReturnValue("replacement");
		try {
			deferred.resolve("Old");
			expect(await first).toEqual({ kind: "skipped", reason: "stale" });
		} finally {
			identity.mockRestore();
		}
		expect(session.sessionManager.getSessionName()).toBeUndefined();
		const controller = new AbortController();
		const next = Promise.withResolvers<string | null>();
		generate.mockReturnValue(next.promise);
		const second = session.generateAutoSessionTitle("hello", { signal: controller.signal });
		controller.abort();
		next.resolve("Old");
		expect(await second).toEqual({ kind: "skipped", reason: "stale" });
		expect(session.sessionManager.getSessionName()).toBeUndefined();
	});

	it("rejects a stale title after direct same-ID copied-file adoption", async () => {
		const manager = SessionManager.create(dir.path(), dir.path());
		await manager.ensureOnDisk();
		const original = manager.getSessionFile();
		if (!original) throw new Error("Expected session file");
		const copied = path.join(dir.path(), "copy.jsonl");
		await fs.copyFile(original, copied);
		session.sessionManager = manager;
		const deferred = Promise.withResolvers<string | null>();
		generate.mockReturnValue(deferred.promise);
		const pending = session.generateAutoSessionTitle("hello");
		await manager.setSessionFile(copied);
		await manager.setSessionFile(original);
		deferred.resolve("Old");
		expect(await pending).toEqual({ kind: "skipped", reason: "stale" });
		expect(manager.getSessionName()).toBeUndefined();
	});

	it("rolls back definite pre-write title failure and allows retry", async () => {
		const manager = SessionManager.create(dir.path(), dir.path());
		await manager.ensureOnDisk();
		session.sessionManager = manager;
		generate.mockResolvedValue("Generated");
		try {
			SessionManagerTestHooks.beforePersistPatchFence = () => {
				throw new Error("before write");
			};
			expect(await session.generateAutoSessionTitle("hello")).toEqual({ kind: "failed" });
			expect(manager.getSessionName()).toBeUndefined();
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
			expect(await session.generateAutoSessionTitle("hello")).toEqual({ kind: "applied", title: "Generated" });
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
		}
	});

	it("does not roll back a newer same-value manual title after an earlier failure", async () => {
		const manager = SessionManager.create(dir.path(), dir.path());
		await manager.ensureOnDisk();
		session.sessionManager = manager;
		generate.mockResolvedValue("Generated");
		let manual: Promise<boolean> | undefined;
		try {
			SessionManagerTestHooks.beforePersistPatchFence = () => {
				SessionManagerTestHooks.beforePersistPatchFence = undefined;
				manual = manager.setSessionName("Generated", "user");
				throw new Error("before write");
			};
			expect(await session.generateAutoSessionTitle("hello")).toEqual({ kind: "failed" });
			if (!manual) throw new Error("Expected manual selection");
			expect(await manual).toBe(true);
			expect(manager.getSessionName()).toBe("Generated");
			expect(manager.titleSource).toBe("user");
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
		}
	});

	it("does not persist a queued title into a synchronously restored session", async () => {
		const manager = SessionManager.create(dir.path(), dir.path());
		await manager.ensureOnDisk();
		const original = manager.captureState();
		const originalFile = manager.getSessionFile();
		if (!originalFile) throw new Error("Expected original transcript");
		await manager.newSession();
		await manager.ensureOnDisk();
		session.sessionManager = manager;
		try {
			SessionManagerTestHooks.beforePersistPatchFence = () => {
				SessionManagerTestHooks.beforePersistPatchFence = undefined;
				manager.restoreState(original);
			};
			await expect(manager.setSessionName("Predecessor title", "user")).rejects.toThrow(
				"Session changed before title persistence",
			);
			expect(manager.getSessionFile()).toBe(originalFile);
			expect(manager.getSessionName()).toBeUndefined();
			await manager.flush();
			expect(await fs.readFile(originalFile, "utf8")).not.toContain("Predecessor title");
			expect(await manager.setSessionName("Current title", "user")).toBe(true);
			await manager.flush();
			expect(await fs.readFile(originalFile, "utf8")).toContain("Current title");
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
		}
	});

	it("serializes overlapping definite failures without restoring a phantom title", async () => {
		const manager = SessionManager.create(dir.path(), dir.path());
		await manager.ensureOnDisk();
		session.sessionManager = manager;
		try {
			SessionManagerTestHooks.beforePersistPatchFence = () => {
				throw new Error("before write");
			};
			const first = manager.setSessionName("First", "auto");
			const second = manager.setSessionName("Manual", "user");
			const results = await Promise.allSettled([first, second]);
			for (const result of results) {
				expect(result.status).toBe("rejected");
				if (result.status !== "rejected") throw new Error("Expected title persistence to fail");
				expect(result.reason).toBeInstanceOf(Error);
				expect(result.reason.message).toBe("before write");
			}
			expect(manager.getSessionName()).toBeUndefined();
			expect(manager.titleSource).toBeUndefined();
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
			generate.mockResolvedValue("Retry");
			expect(await session.generateAutoSessionTitle("hello")).toEqual({ kind: "applied", title: "Retry" });
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
		}
	});

	it("does not commit a queued automatic title after host abort", async () => {
		const manager = SessionManager.create(dir.path(), dir.path());
		await manager.ensureOnDisk();
		session.sessionManager = manager;
		const controller = new AbortController();
		let auto: Promise<boolean> | undefined;
		try {
			SessionManagerTestHooks.beforePersistPatchFence = () => {
				SessionManagerTestHooks.beforePersistPatchFence = undefined;
				auto = manager.setSessionName("Generated", "auto", { isCurrent: () => !controller.signal.aborted });
				controller.abort();
				throw new Error("before write");
			};
			const earlier = manager.setSessionName("Earlier", "user");
			await expect(earlier).rejects.toThrow("before write");
			if (!auto) throw new Error("Expected queued automatic title");
			expect(await auto).toBe(false);
			expect(manager.getSessionName()).toBeUndefined();
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
			controller.abort();
		}
	});

	it("fences SDK title generation when the host aborts during queued publication", async () => {
		const manager = SessionManager.create(dir.path(), dir.path());
		await manager.ensureOnDisk();
		session.sessionManager = manager;
		const controller = new AbortController();
		const generated = Promise.withResolvers<string | null>();
		generate.mockReturnValue(generated.promise);
		const auto = session.generateAutoSessionTitle("hello", { signal: controller.signal });
		try {
			SessionManagerTestHooks.beforePersistPatchFence = () => {
				SessionManagerTestHooks.beforePersistPatchFence = undefined;
				controller.abort();
				throw new Error("before write");
			};
			generated.resolve("Generated");
			const earlier = manager.setSessionName("Earlier", "user");
			await expect(earlier).rejects.toThrow("before write");
			expect(await auto).toEqual({ kind: "skipped", reason: "stale" });
			expect(manager.getSessionName()).toBeUndefined();
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
			controller.abort();
		}
	});

	it("rolls back a provisional title when the host aborts before queued persistence", async () => {
		const manager = SessionManager.create(dir.path(), dir.path());
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		session.sessionManager = manager;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		generate.mockResolvedValue("Provisional title");
		try {
			SessionManagerTestHooks.beforeTitlePatchPersistence = async () => {
				entered.resolve();
				await release.promise;
			};
			const pending = session.generateAutoSessionTitle("hello", { signal: controller.signal });
			await entered.promise;
			expect(manager.getSessionName()).toBe("Provisional title");
			controller.abort();
			release.resolve();
			expect(await pending).toEqual({ kind: "skipped", reason: "stale" });
			expect(manager.getSessionName()).toBeUndefined();
			expect(manager.titleSource).toBeUndefined();
			await manager.flush();
			expect(await fs.readFile(file, "utf8")).not.toContain("Provisional title");
			SessionManagerTestHooks.beforeTitlePatchPersistence = undefined;
			expect(await manager.setSessionName("Manual retry", "user")).toBe(true);
			await manager.flush();
			expect(await fs.readFile(file, "utf8")).toContain("Manual retry");
		} finally {
			release.resolve();
			SessionManagerTestHooks.beforeTitlePatchPersistence = undefined;
		}
	});

	it.each([
		false,
		true,
	])("fences a staged title rewrite across direct identity changes roundTrip=%s", async roundTrip => {
		const seed = SessionManager.create(dir.path(), dir.path());
		await seed.ensureOnDisk();
		const original = seed.getSessionFile();
		if (!original) throw new Error("Expected original transcript");
		await seed.close();
		const originalBytes = await fs.readFile(original, "utf8");
		const records = originalBytes.trimEnd().split("\n");
		const header = JSON.parse(records[0]!) as { version: number };
		header.version = 4;
		records[0] = JSON.stringify(header);
		await fs.writeFile(original, `${records.join("\n")}\n`);
		const copied = path.join(dir.path(), "rewrite-copy.jsonl");
		await fs.copyFile(original, copied);
		const target = await SessionManager.open(copied);
		const targetSnapshot = target.captureState();
		const manager = await SessionManager.open(original);
		const originalSnapshot = manager.captureState();
		session.sessionManager = manager;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		generate.mockResolvedValue("Retired title");
		try {
			SessionManagerTestHooks.beforeTitleRewriteFence = async () => {
				entered.resolve();
				await release.promise;
			};
			const pending = session.generateAutoSessionTitle("hello");
			await entered.promise;
			manager.restoreState(targetSnapshot);
			if (roundTrip) manager.restoreState(originalSnapshot);
			release.resolve();
			expect(await pending).toEqual({ kind: "skipped", reason: "stale" });
			expect(manager.getSessionName()).toBeUndefined();
			await manager.flush();
			expect(await fs.readFile(original, "utf8")).not.toContain("Retired title");
			expect(await fs.readFile(copied, "utf8")).not.toContain("Retired title");
			SessionManagerTestHooks.beforeTitleRewriteFence = undefined;
			expect(await manager.setSessionName("Current title", "user")).toBe(true);
			await manager.flush();
		} finally {
			release.resolve();
			SessionManagerTestHooks.beforeTitleRewriteFence = undefined;
			await target.close();
		}
	});

	it("latches an uncertain physical title write failure even when the host aborts", async () => {
		const controller = new AbortController();
		const failure = new Error("physical title write failed");
		let armed = false;
		class FailingStorage extends FileSessionStorage {
			override openWriter(file: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
				const writer = super.openWriter(file, options);
				return {
					writeLine: line => writer.writeLine(line),
					writeLineSync: line => {
						if (armed) {
							controller.abort();
							throw failure;
						}
						writer.writeLineSync(line);
					},
					flush: () => writer.flush(),
					fsync: () => writer.fsync(),
					...(writer.fsyncSync ? { fsyncSync: () => writer.fsyncSync!() } : {}),
					...(writer.statSync ? { statSync: () => writer.statSync!() } : {}),
					close: () => writer.close(),
					closeSync: () => writer.closeSync(),
					getError: () => writer.getError(),
					getCloseState: () => writer.getCloseState(),
					getCloseError: () => writer.getCloseError(),
				};
			}
		}
		const manager = SessionManager.create(dir.path(), dir.path(), new FailingStorage());
		await manager.ensureOnDisk();
		session.sessionManager = manager;
		generate.mockResolvedValue("Uncertain title");
		armed = true;
		expect(await session.generateAutoSessionTitle("hello", { signal: controller.signal })).toEqual({
			kind: "failed",
		});
		expect(manager.getSessionName()).toBe("Uncertain title");
		await expect(manager.flush()).rejects.toThrow("physical title write failed");
		await expect(manager.close()).rejects.toThrow("physical title write failed");
		// The intentionally failed manager remains fail-closed; isolate normal fixture cleanup.
		session.sessionManager = SessionManager.inMemory();
	});

	it("rejects completion after disposal starts", async () => {
		const deferred = Promise.withResolvers<string | null>();
		generate.mockReturnValue(deferred.promise);
		const pending = session.generateAutoSessionTitle("hello");
		const disposal = session.dispose();
		deferred.resolve("Old");
		expect(await pending).toEqual({ kind: "skipped", reason: "stale" });
		await disposal;
		expect(session.sessionManager.getSessionName()).toBeUndefined();
	});

	it("reports disabled, unavailable and failure without applying a title", async () => {
		process.env.GJC_NO_TITLE = "1";
		expect(await session.generateAutoSessionTitle("hello")).toEqual({ kind: "skipped", reason: "disabled" });
		expect(generate).not.toHaveBeenCalled();
		delete process.env.GJC_NO_TITLE;
		generate.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("credential secret"));
		expect(await session.generateAutoSessionTitle("hello")).toEqual({ kind: "skipped", reason: "unavailable" });
		expect(await session.generateAutoSessionTitle("hello")).toEqual({ kind: "failed" });
		expect(session.sessionManager.getSessionName()).toBeUndefined();
	});
});
