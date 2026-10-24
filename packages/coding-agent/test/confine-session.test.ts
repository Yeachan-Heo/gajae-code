import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionMatchesConfinement } from "../src/session/session-confinement";
import { SessionManager } from "../src/session/session-manager";
import { getActiveWorkspaceConfineRoot, runWithWorkspaceConfine } from "../src/tools/path-utils";

describe("--confine session selection", () => {
	it("keeps a confined transcript out of an ordinary resume match", () => {
		expect(sessionMatchesConfinement({ filesystemScope: "cwd" }, true)).toBe(true);
		expect(sessionMatchesConfinement({ filesystemScope: "cwd" }, false)).toBe(false);
		expect(sessionMatchesConfinement({}, false)).toBe(true);
		expect(sessionMatchesConfinement({}, true)).toBe(false);
	});
	it("does not leave an ordinary transcript when a confined resume path is missing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-missing-"));
		const missing = path.join(dir, "missing.jsonl");
		try {
			await expect(
				SessionManager.open(
					missing,
					SessionManager.explicitDestination(dir),
					undefined,
					"copy-retain",
					"enabled",
					true,
				),
			).rejects.toThrow(/missing path/);
			await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("keeps confinement when a confined transcript is resumed by id", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-resume-id-"));
		const created = SessionManager.create(dir, SessionManager.explicitDestination(dir), undefined, true);
		await created.ensureOnDisk();
		const sessionPath = created.getSessionFile();
		const sessionId = created.getSessionId();
		await created.close();
		if (!sessionPath || !sessionId) throw new Error("confined session was not persisted");
		try {
			const resumed = await SessionManager.open(
				sessionPath,
				SessionManager.explicitDestination(dir),
				undefined,
				"copy-retain",
				"shadow",
				true,
			);
			expect(resumed.isFilesystemConfined()).toBe(true);
			expect(resumed.getSessionId()).toBe(sessionId);
			await resumed.close();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
describe("confinement escapes", () => {
	it("keeps a lifecycle fork of a confined transcript confined", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confine-fork-"));
		const sourceDir = path.join(dir, "source");
		const forkDir = path.join(dir, "fork");
		await fs.mkdir(sourceDir);
		const created = SessionManager.create(sourceDir, SessionManager.explicitDestination(sourceDir), undefined, true);
		await created.ensureOnDisk();
		const sessionPath = created.getSessionFile();
		await created.close();
		if (!sessionPath) throw new Error("confined session was not persisted");
		try {
			const captured = SessionManager.captureTranscriptStrict(sessionPath);
			if (captured.kind !== "captured") throw new Error(captured.reason);
			const forked = await SessionManager.forkFromCaptured(
				captured.snapshot,
				sourceDir,
				SessionManager.explicitDestination(forkDir),
				"copy-retain",
				"shadow",
				true,
			);
			if (forked.kind !== "forked") throw new Error(forked.reason);
			expect(forked.manager.isFilesystemConfined()).toBe(true);
			const header = JSON.parse((await fs.readFile(forked.manager.getSessionFile()!, "utf8")).split(/\r?\n/, 1)[0]!);
			expect(header.filesystemScope).toBe("cwd");
			await forked.manager.close();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not follow an in-root symlink while a confined edit reads and writes", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-hashline-"));
		const root = path.join(parent, "root");
		const outside = path.join(parent, "outside.txt");
		const linked = path.join(root, "escape.txt");
		await fs.mkdir(root);
		await fs.writeFile(outside, "secret\n");
		await fs.writeFile(path.join(root, "inside.txt"), "inside\n");
		await fs.symlink(outside, linked);
		const { readFileTextInsideActiveWorkspace, writeFileTextInsideActiveWorkspace } = await import(
			"../src/tools/path-utils"
		);
		try {
			await runWithWorkspaceConfine(root, async () => {
				expect(getActiveWorkspaceConfineRoot()).toBe(root);
				await expect(readFileTextInsideActiveWorkspace(linked)).rejects.toThrow(/outside/);
				await expect(writeFileTextInsideActiveWorkspace(linked, "changed\n")).rejects.toThrow(/outside/);
				expect(await readFileTextInsideActiveWorkspace(path.join(root, "inside.txt"))).toBe("inside\n");
			});
			expect(await fs.readFile(outside, "utf8")).toBe("secret\n");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
});
