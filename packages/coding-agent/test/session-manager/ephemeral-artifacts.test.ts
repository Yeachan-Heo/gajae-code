import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../src/session/session-manager";

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

		await fs.rm(manager!.dir, { recursive: true, force: true });
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

		await fs.rm(session.getArtifactManager()!.dir, { recursive: true, force: true });
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
