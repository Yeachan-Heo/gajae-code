import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryBlobStore } from "../../src/session/blob-store";
import { SessionManager } from "../../src/session/session-manager";

async function pathExists(target: string): Promise<boolean> {
	return fs.stat(target).then(
		() => true,
		() => false,
	);
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
