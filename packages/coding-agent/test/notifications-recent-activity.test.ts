import { afterAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listRecentSessions } from "@gajae-code/coding-agent/sdk/bus/recent-activity";
import * as native from "@gajae-code/natives";
import {
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScope,
} from "../src/session/internal/managed-session-scope";
import { FileSessionStorage } from "../src/session/session-storage";

const roots: string[] = [];
function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-recent-"));
	roots.push(root);
	return root;
}
afterAll(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

async function managedDirectory(root: string, cwd: string): Promise<string> {
	fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
	const resolved = resolveManagedScope({ cwd, agentDir: root, sessionsRoot: root });
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(prepared.message);
	return prepared.scope.directoryPath;
}

type NativeSecurity = { ok: true } | { ok: false; code: string };

function secureOwnerOnlyFile(pathname: string): void {
	const applied = native.applyOwnerOnlyPathSecurity(pathname, "file") as NativeSecurity;
	if (!applied.ok) throw new Error(`Owner-only security rejected ${pathname}: ${applied.code}`);
	const verified = native.verifyOwnerOnlyPathSecurity(pathname, "file") as NativeSecurity;
	if (!verified.ok) throw new Error(`Owner-only security rejected ${pathname}: ${verified.code}`);
}

function writeSession(
	directory: string,
	filename: string,
	cwd: string,
	header: object,
	mtimeMs: number,
	entries: object[] = [{ type: "message" }],
): string {
	const file = path.join(directory, `${filename}.jsonl`);
	fs.writeFileSync(
		file,
		`${JSON.stringify({ type: "session", id: filename, cwd, ...header })}\n${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`,
		{ mode: 0o600 },
	);
	secureOwnerOnlyFile(file);
	fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	return file;
}

describe("recent-activity picker", () => {
	it("ranks validated workspace sessions by history mtime, newest first", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const directory = await managedDirectory(root, cwd);
		writeSession(directory, "old", cwd, {}, 1_000_000);
		writeSession(directory, "newer", cwd, { branch: "feat/x" }, 3_000_000);
		writeSession(directory, "mid", cwd, { title: "fix bug" }, 2_000_000);

		const result = await listRecentSessions({ cwd, sessionsRoot: root });
		expect(result.kind).toBe("complete");
		if (result.kind !== "complete") throw new Error(result.message);
		const out = result.entries;
		expect(out.map(entry => entry.sessionId)).toEqual(["newer", "mid", "old"]);
		expect(out[0]?.path).toBe(cwd);
		expect(out[0]?.branch).toBe("feat/x");
		expect(out[1]?.title).toBe("fix bug");
	});

	it("lists validated v2 sessions across workspaces when requested", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace-a");
		const otherCwd = path.join(root, "workspace-b");
		const directory = await managedDirectory(root, cwd);
		const otherDirectory = await managedDirectory(root, otherCwd);
		writeSession(directory, "current", cwd, {}, 1_000);
		writeSession(otherDirectory, "other", otherCwd, {}, 2_000);

		const result = await listRecentSessions({ cwd, sessionsRoot: root, allWorkspaces: true });
		expect(result).toMatchObject({ kind: "complete" });
		if (result.kind !== "complete") throw new Error(result.message);
		expect(result.entries.map(entry => entry.sessionId)).toEqual(["other", "current"]);
	});

	it("scans saved sessions when the current workspace is unavailable", async () => {
		const root = tempRoot();
		const savedCwd = path.join(root, "saved-workspace");
		const directory = await managedDirectory(root, savedCwd);
		writeSession(directory, "saved-elsewhere", savedCwd, {}, 2_000);

		const result = await listRecentSessions({
			cwd: path.join(root, "gone-launch-workspace"),
			sessionsRoot: root,
			allWorkspaces: true,
		});

		expect(result).toMatchObject({ kind: "complete" });
		if (result.kind !== "complete") throw new Error(result.message);
		expect(result.entries.map(entry => entry.sessionId)).toEqual(["saved-elsewhere"]);
	});

	it("silently ignores sessions whose workspace directories were removed", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const removedCwd = path.join(root, "removed-workspace");
		const directory = await managedDirectory(root, cwd);
		await managedDirectory(root, removedCwd);
		writeSession(directory, "stale-candidate", removedCwd, {}, 2_000);
		fs.rmSync(removedCwd, { recursive: true });

		const result = await listRecentSessions({ cwd, sessionsRoot: root, allWorkspaces: true });

		expect(result).toMatchObject({ kind: "complete", entries: [], warnings: [] });
	});

	it("preserves warnings for non-stale cwd identity failures", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const brokenCwd = path.join(root, "identity-error");
		const directory = await managedDirectory(root, cwd);
		writeSession(directory, "broken-candidate", brokenCwd, {}, 2_000);
		const canonicalIdentity = native.canonicalExistingDirectoryIdentity;
		const identity = vi
			.spyOn(native, "canonicalExistingDirectoryIdentity")
			.mockImplementation(pathname =>
				pathname === brokenCwd ? { ok: false, code: "io_error" } : canonicalIdentity(pathname),
			);
		try {
			const result = await listRecentSessions({ cwd, sessionsRoot: root });

			expect(result).toMatchObject({
				kind: "complete",
				entries: [],
				warnings: ["Ignored invalid managed session candidate: cwd_io_error"],
			});
		} finally {
			identity.mockRestore();
		}
	});

	it("silently ignores workspace bindings replaced by files", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const removedCwd = path.join(root, "removed-workspace");
		await managedDirectory(root, cwd);
		await managedDirectory(root, removedCwd);
		fs.rmSync(removedCwd, { recursive: true });
		fs.writeFileSync(removedCwd, "not a directory", { mode: 0o600 });

		const result = await listRecentSessions({ cwd, sessionsRoot: root, allWorkspaces: true });

		expect(result).toMatchObject({ kind: "complete", entries: [], warnings: [] });
	});

	it("warns about removed workspace candidates during direct scans", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const removedCwd = path.join(root, "removed-workspace");
		const directory = await managedDirectory(root, cwd);
		fs.mkdirSync(removedCwd, { recursive: true, mode: 0o700 });
		writeSession(directory, "stale-candidate", removedCwd, {}, 2_000);
		fs.rmSync(removedCwd, { recursive: true });

		const result = await listRecentSessions({ cwd, sessionsRoot: root });

		expect(result).toMatchObject({
			kind: "complete",
			entries: [],
			warnings: ["Ignored invalid managed session candidate: cwd_not_found"],
		});
	});
	it("fails closed for an unsafe all-workspace sessions root", async () => {
		if (process.platform === "win32") return;
		const root = tempRoot();
		const safeRoot = path.join(root, "safe-sessions");
		const unsafeRoot = path.join(root, "unsafe-sessions");
		fs.mkdirSync(safeRoot, { mode: 0o700 });
		fs.symlinkSync(safeRoot, unsafeRoot);

		const result = await listRecentSessions({
			cwd: path.join(root, "gone-launch-workspace"),
			sessionsRoot: unsafeRoot,
			allWorkspaces: true,
		});

		expect(result).toMatchObject({ kind: "error", code: "scope_unavailable" });
	});

	it("lists legacy-only workspaces before any v2 binding exists", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace-a");
		const legacyOnlyCwd = path.join(root, "workspace-b");
		const directory = await managedDirectory(root, cwd);
		fs.mkdirSync(legacyOnlyCwd, { recursive: true, mode: 0o700 });
		const legacyDirectory = path.join(root, `--${legacyOnlyCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
		fs.mkdirSync(legacyDirectory, { mode: 0o700 });
		writeSession(directory, "current", cwd, {}, 1_000);
		writeSession(legacyDirectory, "legacy-only", legacyOnlyCwd, {}, 2_000);

		const result = await listRecentSessions({ cwd, sessionsRoot: root, allWorkspaces: true });

		expect(result).toMatchObject({ kind: "complete" });
		if (result.kind !== "complete") throw new Error(result.message);
		expect(result.entries.map(entry => entry.sessionId)).toEqual(["legacy-only", "current"]);
	});

	it("treats an absent all-workspace sessions root as an empty scan", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionsRoot = path.join(root, "missing-sessions");

		const result = await listRecentSessions({ cwd, sessionsRoot, allWorkspaces: true });

		expect(result).toMatchObject({ kind: "complete", entries: [] });
		expect(fs.existsSync(sessionsRoot)).toBe(false);
	});
	it("uses only validated candidates across corrupt, foreign, and mixed-id collisions", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const foreignCwd = path.join(root, "foreign-workspace");
		const directory = await managedDirectory(root, cwd);
		fs.mkdirSync(foreignCwd);
		writeSession(directory, "shared", cwd, {}, 3_000);
		writeSession(directory, "foreign-copy", foreignCwd, { id: "shared" }, 2_000);
		fs.writeFileSync(path.join(directory, "corrupt.jsonl"), "not JSON\n", { mode: 0o600 });

		const result = await listRecentSessions({ cwd, sessionsRoot: root });
		expect(result.kind).toBe("complete");
		if (result.kind !== "complete") throw new Error(result.message);
		const out = result.entries;
		expect(out.map(entry => entry.sessionId)).toEqual(["shared"]);
		expect(out[0]?.path).toBe(cwd);
	});

	it("accepts validated legacy candidates with their historical 0644 mode", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
		const legacyDirectory = path.join(root, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
		fs.mkdirSync(legacyDirectory, { mode: 0o700 });
		const legacy = writeSession(legacyDirectory, "legacy", cwd, {}, 1_000);
		fs.chmodSync(legacy, 0o644);

		const result = await listRecentSessions({ cwd, sessionsRoot: root });
		expect(result).toMatchObject({ kind: "complete" });
		if (result.kind !== "complete") throw new Error(result.message);
		expect(result.entries.map(entry => entry.sessionId)).toEqual(["legacy"]);
	});

	it("flags breadcrumb-referenced candidates and filters internal sessions before the limit", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const directory = await managedDirectory(root, cwd);
		const live = writeSession(directory, "live", cwd, {}, 5_000);
		writeSession(directory, "visible", cwd, {}, 4_000);
		writeSession(directory, "helper", cwd, {}, 6_000, [{ type: "session_init" }]);

		const allResult = await listRecentSessions({ cwd, sessionsRoot: root, breadcrumbPaths: [live] });
		expect(allResult.kind).toBe("complete");
		if (allResult.kind !== "complete") throw new Error(allResult.message);
		const all = allResult.entries;
		expect(all.find(entry => entry.sessionId === "live")?.currentTerminal).toBe(true);
		expect(all.find(entry => entry.sessionId === "helper")?.internal).toBe(true);
		const visibleResult = await listRecentSessions({ cwd, sessionsRoot: root, includeInternal: false, limit: 2 });
		expect(visibleResult.kind).toBe("complete");
		if (visibleResult.kind !== "complete") throw new Error(visibleResult.message);
		expect(visibleResult.entries.map(entry => entry.sessionId)).toEqual(["live", "visible"]);
	});

	it("does not treat raw child names as session authority", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const directory = await managedDirectory(root, cwd);
		writeSession(directory, "timestamped-child-name", cwd, { id: "authoritative-id" }, 9_000);
		fs.writeFileSync(path.join(directory, "raw-name-only.jsonl"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });

		const result = await listRecentSessions({ cwd, sessionsRoot: root });
		expect(result.kind).toBe("complete");
		if (result.kind !== "complete") throw new Error(result.message);
		expect(result.entries.map(entry => entry.sessionId)).toEqual(["authoritative-id"]);
	});

	it("revalidates one concurrent append without discarding stable candidates", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const directory = await managedDirectory(root, cwd);
		const changing = writeSession(directory, "changing", cwd, {}, 9_000);
		writeSession(directory, "stable", cwd, {}, 10_000);
		const original = FileSessionStorage.prototype.readSnapshotSync;
		let appended = false;
		let changingReads = 0;
		const reader = vi.spyOn(FileSessionStorage.prototype, "readSnapshotSync").mockImplementation(function (
			this: FileSessionStorage,
			file: string,
		) {
			if (file === changing) changingReads++;
			if (file === changing && !appended) {
				appended = true;
				fs.appendFileSync(changing, `${JSON.stringify({ type: "message", append: true })}\n`);
			}
			return original.call(this, file);
		});
		try {
			const result = await listRecentSessions({ cwd, sessionsRoot: root });
			expect(result).toMatchObject({ kind: "complete", warnings: [] });
			if (result.kind !== "complete") return;
			expect(result.entries.map(entry => entry.sessionId)).toEqual(["changing", "stable"]);
			expect(changingReads).toBe(2);
		} finally {
			reader.mockRestore();
		}
	});

	it("omits a continuously changing candidate while retaining stable results", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const directory = await managedDirectory(root, cwd);
		const changing = writeSession(directory, "changing", cwd, {}, 9_000);
		writeSession(directory, "stable", cwd, {}, 10_000);
		const original = FileSessionStorage.prototype.readSnapshotSync;
		const reader = vi.spyOn(FileSessionStorage.prototype, "readSnapshotSync").mockImplementation(function (
			this: FileSessionStorage,
			file: string,
		) {
			if (file === changing) fs.appendFileSync(changing, `${JSON.stringify({ type: "message", append: true })}\n`);
			return original.call(this, file);
		});
		try {
			const result = await listRecentSessions({ cwd, sessionsRoot: root });
			expect(result).toMatchObject({
				kind: "complete",
				warnings: ["Ignored managed session candidate that changed during inspection."],
			});
			if (result.kind !== "complete") return;
			expect(result.entries.map(entry => entry.sessionId)).toEqual(["stable"]);
		} finally {
			reader.mockRestore();
		}
	});

	it("omits a same-inode rewrite instead of adopting rewritten metadata", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const directory = await managedDirectory(root, cwd);
		const changing = writeSession(directory, "changing", cwd, {}, 9_000);
		writeSession(directory, "stable", cwd, {}, 10_000);
		const original = FileSessionStorage.prototype.readSnapshotSync;
		let rewritten = false;
		const reader = vi.spyOn(FileSessionStorage.prototype, "readSnapshotSync").mockImplementation(function (
			this: FileSessionStorage,
			file: string,
		) {
			if (file === changing && !rewritten) {
				rewritten = true;
				fs.writeFileSync(
					changing,
					`${JSON.stringify({ type: "session", id: "rewritten", cwd, title: "rewritten" })}\n`,
					{ mode: 0o600 },
				);
			}
			return original.call(this, file);
		});
		try {
			const result = await listRecentSessions({ cwd, sessionsRoot: root });
			expect(result).toMatchObject({
				kind: "complete",
				warnings: ["Ignored managed session candidate that changed during inspection."],
			});
			if (result.kind !== "complete") return;
			expect(result.entries.map(entry => entry.sessionId)).toEqual(["stable"]);
		} finally {
			reader.mockRestore();
		}
	});

	it("omits a transcript replaced after the readonly managed inventory is captured", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const directory = await managedDirectory(root, cwd);
		const changing = writeSession(directory, "changing", cwd, {}, 9_000);
		writeSession(directory, "stable", cwd, {}, 10_000);
		const replacement = path.join(root, "replacement.jsonl");
		fs.writeFileSync(
			replacement,
			`${JSON.stringify({ type: "session", id: "replacement", cwd, title: "replacement" })}\n`,
			{ mode: 0o600 },
		);
		secureOwnerOnlyFile(replacement);
		const original = FileSessionStorage.prototype.readSnapshotSync;
		let replaced = false;
		const reader = vi.spyOn(FileSessionStorage.prototype, "readSnapshotSync").mockImplementation(function (
			this: FileSessionStorage,
			file: string,
		) {
			if (file === changing && !replaced) {
				replaced = true;
				fs.renameSync(replacement, changing);
			}
			return original.call(this, file);
		});
		try {
			const result = await listRecentSessions({ cwd, sessionsRoot: root });
			expect(result).toMatchObject({
				kind: "complete",
				warnings: ["Ignored managed session candidate that changed during inspection."],
			});
			if (result.kind !== "complete") return;
			expect(result.entries.map(entry => entry.sessionId)).toEqual(["stable"]);
		} finally {
			reader.mockRestore();
		}
	});

	it("rejects managed session metadata reached through a symlink", async () => {
		if (process.platform === "win32") return;
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const directory = await managedDirectory(root, cwd);
		const target = path.join(root, "target.jsonl");
		fs.writeFileSync(target, `${JSON.stringify({ type: "session", id: "linked", cwd })}\n`, { mode: 0o600 });
		fs.symlinkSync(target, path.join(directory, "linked.jsonl"));
		const result = await listRecentSessions({ cwd, sessionsRoot: root });
		expect(result).toMatchObject({ kind: "complete", entries: [] });
	});

	it("preserves unexpected metadata reader failures as request errors", async () => {
		const root = tempRoot();
		const cwd = path.join(root, "workspace");
		const directory = await managedDirectory(root, cwd);
		writeSession(directory, "stable", cwd, {}, 10_000);

		const result = await listRecentSessions({
			cwd,
			sessionsRoot: root,
			readInitialLines: () => {
				throw new Error("reader failed");
			},
		});
		expect(result).toMatchObject({
			kind: "error",
			code: "managed_scan_failed",
			message: "Could not read managed session metadata: reader failed",
		});
	});

	it("returns a diagnostic instead of treating an invalid workspace as no sessions", async () => {
		const root = tempRoot();
		const result = await listRecentSessions({ cwd: path.join(root, "missing"), sessionsRoot: root });
		expect(result).toMatchObject({ kind: "error", code: "scope_unavailable" });
	});
});
