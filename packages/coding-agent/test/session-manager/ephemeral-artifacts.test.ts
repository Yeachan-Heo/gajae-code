import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "../../src/internal-urls";
import { ArtifactManager } from "../../src/session/artifacts";
import { MemoryBlobStore } from "../../src/session/blob-store";
import { CURRENT_SESSION_VERSION, SessionManager, SessionManagerTestHooks } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

async function pathExists(target: string): Promise<boolean> {
	return fs.stat(target).then(
		() => true,
		() => false,
	);
}

async function waitForPathRemoval(target: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (!(await pathExists(target))) return;
		await Bun.sleep(5);
	}
}

describe("non-persistent session artifacts", () => {
	it("writes artifacts to a lazily created temp directory and reads them back from disk", async () => {
		const session = SessionManager.inMemory();
		expect(session.getArtifactManager()).toBeNull();

		const content = "full tool output that must not be retained in memory";
		const id = await session.saveArtifact(content, "bash");
		expect(id).toBe("0");

		const artifactPath = await session.getArtifactPath(id!);
		expect(artifactPath).toBeTruthy();
		expect(path.dirname(path.dirname(artifactPath!))).toBe(path.resolve(os.tmpdir()));
		expect(path.basename(path.dirname(artifactPath!))).toStartWith("gjc-session-artifacts-");
		expect(await Bun.file(artifactPath!).text()).toBe(content);

		// The store is exposed so artifact:// authorization can reach the same root.
		const manager = session.getArtifactManager();
		expect(manager).toBeTruthy();
		expect(path.resolve(manager!.dir)).toBe(path.resolve(path.dirname(artifactPath!)));

		const second = await session.saveArtifact("second", "bash");
		expect(second).toBe("1");
		expect(path.dirname((await session.getArtifactPath(second!))!)).toBe(manager!.dir);

		await session.close();
		expect(await pathExists(manager!.dir)).toBe(false);
	});

	it("allocates one shared temp directory under concurrent saves", async () => {
		const session = SessionManager.inMemory();
		const ids = await Promise.all(
			Array.from({ length: 8 }, (_, index) => session.saveArtifact(`payload ${index}`, "bash")),
		);
		expect(new Set(ids).size).toBe(8);

		const paths = await Promise.all(ids.map(async id => await session.getArtifactPath(id!)));
		expect(new Set(paths.map(p => path.dirname(p!))).size).toBe(1);
		expect(await Bun.file(paths[0]!).text()).toStartWith("payload ");

		const root = session.getArtifactManager()!.dir;
		await session.close();
		expect(await pathExists(root)).toBe(false);
	});

	it("claims unique numeric IDs across managers sharing one root and resolves each URI exactly", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-artifact-shared-root-"));
		try {
			const first = new ArtifactManager(root);
			const second = new ArtifactManager(root);

			// Initialize both counters against the same artifact-free root before either
			// manager claims an ID. The pre-fix implementation then deterministically
			// published both tool types under numeric ID 0.
			await first.replaceNamed("first.seed", "first");
			await second.replaceNamed("second.seed", "second");

			const firstId = await first.save("first manager payload", "bash");
			const secondId = await second.save("second manager payload", "read");
			expect(firstId).toBe("0");
			expect(secondId).toBe("1");

			const context = {
				cwd: root,
				getArtifactsDir: () => root,
				getAuthorizedArtifactsDirs: () => [root],
			};
			const firstResolved = await InternalUrlRouter.instance().resolve(`artifact://${firstId}`, context);
			const secondResolved = await InternalUrlRouter.instance().resolve(`artifact://${secondId}`, context);
			expect(firstResolved.content).toBe("first manager payload");
			expect(secondResolved.content).toBe("second manager payload");
			expect(firstResolved.sourcePath).toBe(path.join(root, "0.bash.log"));
			expect(secondResolved.sourcePath).toBe(path.join(root, "1.read.log"));
		} finally {
			InternalUrlRouter.resetForTests();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects unsafe scanned numeric IDs without retrying forever", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-artifact-unsafe-id-"));
		try {
			await Bun.write(path.join(root, ".artifact-id-9007199254740992"), "");
			const manager = new ArtifactManager(root);
			const outcome = await Promise.race([
				manager.save("must not publish", "bash").then(
					() => new Error("unsafe artifact ID unexpectedly published"),
					error => error,
				),
				Bun.sleep(250).then(() => new Error("unsafe artifact ID allocation timed out")),
			]);
			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).message).toBe("artifact_id_out_of_range");
			expect((await fs.readdir(root)).sort()).toEqual([".artifact-id-9007199254740992"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("retires predecessor artifacts only after an existing-session transition commits", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-existing-session-artifacts-"));
		const predecessor = SessionManager.inMemory(cwd, new FileSessionStorage());
		try {
			const targetFile = path.join(cwd, "existing-populated.jsonl");
			const targetSessionId = "existing-populated-session";
			const targetMessageId = "existing-message";
			await Bun.write(
				targetFile,
				`${JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: targetSessionId,
					timestamp: "2026-08-04T00:00:00.000Z",
					cwd,
				})}\n${JSON.stringify({
					type: "message",
					id: targetMessageId,
					parentId: null,
					timestamp: "2026-08-04T00:00:01.000Z",
					message: { role: "user", content: "persisted resume target", timestamp: 1 },
				})}\n`,
			);

			expect(await predecessor.saveArtifact("predecessor zero", "bash")).toBe("0");
			expect(await predecessor.saveArtifact("predecessor one", "read")).toBe("1");
			const predecessorManager = predecessor.getArtifactManager()!;
			const predecessorRoot = predecessorManager.dir;
			expect((await fs.readdir(predecessorRoot)).sort()).toEqual([
				".artifact-id-0",
				".artifact-id-1",
				"0.bash.log",
				"1.read.log",
			]);

			SessionManagerTestHooks.beforeResidentTransitionIndexBuild = () => {
				throw new Error("injected existing-session transition failure");
			};
			await expect(predecessor.setSessionFile(targetFile!)).rejects.toThrow(
				"injected existing-session transition failure",
			);
			expect(predecessor.getArtifactManager()).toBe(predecessorManager);
			expect(await pathExists(predecessorRoot)).toBe(true);
			expect(await predecessor.getArtifactPath("0")).toBe(path.join(predecessorRoot, "0.bash.log"));

			SessionManagerTestHooks.beforeResidentTransitionIndexBuild = undefined;
			await predecessor.setSessionFile(targetFile!);
			await waitForPathRemoval(predecessorRoot);
			expect(await pathExists(predecessorRoot)).toBe(false);
			expect(predecessor.getSessionId()).toBe(targetSessionId);
			expect(predecessor.getEntry(targetMessageId)).toMatchObject({
				type: "message",
				message: { content: "persisted resume target" },
			});

			const resumedManager = predecessor.getArtifactManager();
			expect(resumedManager).not.toBe(predecessorManager);
			expect(resumedManager?.dir).toBe(targetFile!.slice(0, -6));
			expect(predecessor.isArtifactManagerAuthorized(resumedManager!)).toBe(true);
			expect(await predecessor.saveArtifact("resumed artifact", "bash")).toBe("0");
			expect(await Bun.file(path.join(resumedManager!.dir, "0.bash.log")).text()).toBe("resumed artifact");
		} finally {
			SessionManagerTestHooks.beforeResidentTransitionIndexBuild = undefined;
			await predecessor.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("removes its ephemeral root on terminal closeStrict", async () => {
		const session = SessionManager.inMemory();
		await session.saveArtifact("terminal", "bash");
		const root = session.getArtifactManager()!.dir;

		expect(await session.closeStrict()).toEqual({ kind: "closed" });
		expect(await pathExists(root)).toBe(false);
	});

	it("preserves the restored live session artifacts when a fresh transition fails", async () => {
		const session = SessionManager.inMemory();
		const id = await session.saveArtifact("live predecessor artifact", "bash");
		const manager = session.getArtifactManager()!;
		const root = manager.dir;
		const artifactPath = await session.getArtifactPath(id!);
		const prepared = await session.prepareNewSession();
		session.appendPreparedCustomMessageEntry(prepared, "large", "x".repeat(2 * 1024 * 1024), true);
		const putSync = spyOn(MemoryBlobStore.prototype, "putSync").mockImplementation(() => {
			throw new Error("injected fresh transition failure");
		});
		try {
			expect(() => session.commitPreparedNewSession(prepared)).toThrow("injected fresh transition failure");
		} finally {
			putSync.mockRestore();
		}

		expect(session.getArtifactManager()).toBe(manager);
		expect(await Bun.file(artifactPath!).text()).toBe("live predecessor artifact");
		expect(await pathExists(root)).toBe(true);

		await session.discardPreparedNewSession(prepared);
		await session.close();
		expect(await pathExists(root)).toBe(false);
	});
	it("prefers the session artifact directory when the session is persisted", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ephemeral-artifacts-"));
		try {
			const session = SessionManager.create(cwd, cwd);
			const id = await session.saveArtifact("persisted", "bash");
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeTruthy();
			expect(await session.getArtifactPath(id!)).toBe(path.join(sessionFile!.slice(0, -6), `${id}.bash.log`));
			expect(session.getArtifactManager()!.dir).toBe(sessionFile!.slice(0, -6));
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
