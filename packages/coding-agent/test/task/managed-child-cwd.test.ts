import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "../../src/session/artifacts";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";
import { createManagedTaskPersistence } from "../../src/task/executor";

const cleanupRoots: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("managed isolated child persistence", () => {
	it("binds fresh and resumed child session headers to the execution worktree", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-child-cwd-"));
		cleanupRoots.push(root);
		const artifactsDir = path.join(root, "artifacts");
		const firstWorktree = path.join(root, "first-worktree");
		const secondWorktree = path.join(root, "second-worktree");
		await Promise.all([
			fs.mkdir(artifactsDir, { recursive: true }),
			fs.mkdir(firstWorktree, { recursive: true }),
			fs.mkdir(secondWorktree, { recursive: true }),
		]);
		const manager = new ArtifactManager(new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir));
		const persistence = createManagedTaskPersistence(manager, "0-IsolatedCwd");

		const fresh = await persistence.openSession(firstWorktree);
		await fresh.flush();
		await fresh.close();
		const sessionPath = path.join(artifactsDir, "0-IsolatedCwd.jsonl");
		let header = JSON.parse((await fs.readFile(sessionPath, "utf8")).split("\n")[0]!) as { cwd: string };
		expect(header.cwd).toBe(path.resolve(firstWorktree));

		const resumed = await persistence.openSession(secondWorktree);
		await resumed.flush();
		await resumed.close();
		header = JSON.parse((await fs.readFile(sessionPath, "utf8")).split("\n")[0]!) as { cwd: string };
		expect(header.cwd).toBe(path.resolve(secondWorktree));
	});
});
