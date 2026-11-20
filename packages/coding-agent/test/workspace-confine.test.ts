import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { confinedMkdirAll, confinedOpenRead, confinedUnlink, confinedWriteFileAtomic } from "@gajae-code/natives";
import fc from "fast-check";
import { confineSandboxProfile, sandboxedShellCommand } from "../src/tools/confine-sandbox";
import {
	directoryEscapesWorkspace,
	mkdirInsideWorkspace,
	openFileInsideWorkspace,
	pathEscapesWorkspace,
	readFileInsideWorkspace,
	realpathEscapesWorkspace,
	unlinkInsideWorkspace,
	writeFileInsideWorkspace,
} from "../src/tools/workspace-confine";

async function rootIdentity(dir: string): Promise<string> {
	const stat = await fs.stat(dir, { bigint: true });
	return `${stat.dev}:${stat.ino}`;
}

describe("--confine path boundary", () => {
	it("accepts the root and a descendant, and rejects a parent", () => {
		const root = path.join(os.tmpdir(), "confine-root");
		expect(pathEscapesWorkspace(root, root)).toBe(false);
		expect(pathEscapesWorkspace(root, path.join(root, "src", "file.ts"))).toBe(false);
		expect(pathEscapesWorkspace(root, path.resolve(root, "..", "secret"))).toBe(true);
		expect(pathEscapesWorkspace(root, path.resolve(root, ".."))).toBe(true);
	});

	it("accepts a root containing spaces and rejects its parent", () => {
		const root = path.join(os.tmpdir(), "My Project");
		expect(pathEscapesWorkspace(root, path.join(root, "src"))).toBe(false);
		expect(pathEscapesWorkspace(root, path.resolve(root, ".."))).toBe(true);
		expect(confineSandboxProfile(root)).toContain("My Project");
	});

	it("accepts a Korean directory name in the sandbox profile", () => {
		const root = path.join(os.tmpdir(), "프로젝트");
		expect(confineSandboxProfile(root)).toContain("프로젝트");
	});

	it("rejects a dangling symlink whose target is outside the root", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-dangling-"));
		const root = path.join(parent, "repo");
		const outside = path.join(parent, "outside-missing.txt");
		const linked = path.join(root, "link");
		await fs.mkdir(root);
		await fs.symlink(outside, linked);
		await expect(realpathEscapesWorkspace(root, linked)).resolves.toBe(true);
		await fs.rm(parent, { recursive: true, force: true });
	});
	it("admits the root and descendants, and rejects parents and sibling prefixes", () => {
		const root = path.join(os.tmpdir(), "confine-root");
		const cases = ["", "a", "a/b", "a/b/c", ".hidden", "name with space"];
		for (const relative of cases) {
			expect(pathEscapesWorkspace(root, relative ? path.join(root, relative) : root)).toBe(false);
		}
		expect(pathEscapesWorkspace(root, path.resolve(root, ".."))).toBe(true);
		expect(pathEscapesWorkspace(root, path.resolve(root, "..", "secret"))).toBe(true);
		expect(pathEscapesWorkspace(root, `${root}-sibling`)).toBe(true);
		expect(pathEscapesWorkspace(root, `${root}-sibling/file`)).toBe(true);
	});

	it("generates containment cases for descendants, dot segments, parents, and sibling prefixes", () => {
		const segment = fc
			.stringMatching(/^[A-Za-z0-9가-힣 ._-]{1,12}$/)
			.filter(value => value !== "." && value !== "..");
		fc.assert(
			fc.property(
				fc.array(segment, { minLength: 1, maxLength: 3 }),
				fc.array(segment, { maxLength: 3 }),
				(rootParts, relativeParts) => {
					const root = path.join(os.tmpdir(), ...rootParts);
					const descendant = path.resolve(root, ...relativeParts);
					expect(pathEscapesWorkspace(root, descendant)).toBe(false);
					expect(pathEscapesWorkspace(root, path.resolve(root, ".."))).toBe(true);
					expect(pathEscapesWorkspace(root, `${root}-sibling`)).toBe(true);
				},
			),
		);
	});
	it("follows the real directory when checking a shell cwd", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-cwd-"));
		const root = path.join(parent, "repo");
		const outside = path.join(parent, "outside");
		const linked = path.join(root, "link");
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.symlink(outside, linked);
		await expect(directoryEscapesWorkspace(root, root)).resolves.toBe(false);
		await expect(directoryEscapesWorkspace(root, outside)).resolves.toBe(true);
		await expect(directoryEscapesWorkspace(root, linked)).resolves.toBe(true);
		await fs.rm(parent, { recursive: true, force: true });
	});
	it("rejects an in-root symlink and a new file below it when they resolve outside", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-realpath-"));
		const root = path.join(parent, "repo");
		const outside = path.join(parent, "outside");
		const linked = path.join(root, "link");
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "secret.txt"), "hidden");
		await fs.symlink(outside, linked);
		await expect(realpathEscapesWorkspace(root, path.join(linked, "secret.txt"))).resolves.toBe(true);
		await expect(realpathEscapesWorkspace(root, path.join(linked, "new.txt"))).resolves.toBe(true);
		await expect(realpathEscapesWorkspace(root, path.join(root, "visible.txt"))).resolves.toBe(false);
		await fs.rm(parent, { recursive: true, force: true });
	});
	it("denies a parent path, a dotdot path, and a symlink from inside the sandboxed process", async () => {
		if (process.platform !== "darwin") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-sandbox-"));
		const root = path.join(parent, "repo");
		const outside = path.join(os.homedir(), `.gjc-confine-secret-${process.pid}`);
		await fs.mkdir(root);
		await fs.writeFile(outside, "hidden");
		try {
			await fs.writeFile(path.join(root, "visible.txt"), "visible");
			await fs.symlink(outside, path.join(root, "link"));
			const command = sandboxedShellCommand(
				[
					`cat ${JSON.stringify(path.join(root, "visible.txt"))}`,
					`cat ${JSON.stringify(outside)}`,
					`cat ${JSON.stringify(path.join(root, "link"))}`,
				].join("; "),
				root,
			);
			const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(stdout).toContain("visible");
			expect(stdout).not.toContain("hidden");
			expect(stderr).toContain("Operation not permitted");
		} finally {
			await fs.rm(outside, { force: true });
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
	it("denies a sibling under the same temp prefix from inside the sandboxed process", async () => {
		if (process.platform !== "darwin") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-sibling-"));
		const root = path.join(parent, "repo");
		const sibling = path.join(parent, "secret.txt");
		await fs.mkdir(root);
		await fs.writeFile(sibling, "hidden");
		await fs.writeFile(path.join(root, "visible.txt"), "visible");
		try {
			const command = sandboxedShellCommand(
				`cat ${JSON.stringify(path.join(root, "visible.txt"))}; cat ${JSON.stringify(sibling)}`,
				root,
			);
			const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(stdout).toContain("visible");
			expect(stdout).not.toContain("hidden");
			expect(stderr).toContain("Operation not permitted");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
	it("denies a relative parent write when the root is under the system temp directory", async () => {
		if (process.platform !== "darwin") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-tmp-parent-"));
		const root = path.join(parent, "repo");
		const secret = path.join(parent, "secret.txt");
		await fs.mkdir(root);
		await fs.writeFile(secret, "hidden");
		try {
			const command = sandboxedShellCommand(
				`echo OVERWRITE > ${JSON.stringify(path.join("..", "secret.txt"))}`,
				root,
			);
			const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" });
			await proc.exited;
			expect(await fs.readFile(secret, "utf8")).toBe("hidden");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
	it("pins the Seatbelt launcher to the trusted absolute executable", () => {
		if (process.platform !== "darwin") return;
		expect(sandboxedShellCommand("printf ok", os.tmpdir())).toContain("/usr/bin/sandbox-exec");
	});
	it("opens a file inside the root and rejects a swapped in-root symlink", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-open-"));
		const root = path.join(parent, "repo");
		const outside = path.join(parent, "outside.txt");
		const linked = path.join(root, "link");
		await fs.mkdir(root);
		await fs.writeFile(path.join(root, "visible.txt"), "visible");
		await fs.writeFile(outside, "hidden");
		await fs.symlink(outside, linked);
		const visible = await openFileInsideWorkspace(root, path.join(root, "visible.txt"));
		expect(await visible.readFile("utf8")).toBe("visible");
		await visible.close();
		await expect(openFileInsideWorkspace(root, linked)).rejects.toThrow(/outside/);
		await expect(readFileInsideWorkspace(root, linked)).rejects.toThrow(/outside/);
		expect(await readFileInsideWorkspace(root, path.join(root, "visible.txt"))).toEqual(Buffer.from("visible"));
		await fs.rm(parent, { recursive: true, force: true });
	});
	it("replaces an existing in-root file, keeps its mode, and creates a nested new file", async () => {
		if (process.platform === "win32") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-write-"));
		const root = path.join(parent, "repo");
		const existing = path.join(root, "existing.txt");
		await fs.mkdir(root);
		await fs.writeFile(existing, "before\n");
		await fs.chmod(existing, 0o640);
		try {
			await writeFileInsideWorkspace(root, existing, "after\n");
			expect(await fs.readFile(existing, "utf8")).toBe("after\n");
			expect((await fs.stat(existing)).mode & 0o777).toBe(0o640);
			const nested = path.join(root, "a", "b", "new.txt");
			await writeFileInsideWorkspace(root, nested, "new\n");
			expect(await fs.readFile(nested, "utf8")).toBe("new\n");
			expect((await fs.readdir(root)).sort()).toEqual(["a", "existing.txt"]);
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
	it("follows an in-root symlink whose target stays inside the root", async () => {
		if (process.platform === "win32") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-inroot-link-"));
		const root = path.join(parent, "repo");
		await fs.mkdir(path.join(root, "real"), { recursive: true });
		await fs.writeFile(path.join(root, "real", "file.txt"), "inside\n");
		await fs.symlink(path.join(root, "real"), path.join(root, "alias"));
		try {
			const read = await readFileInsideWorkspace(root, path.join(root, "alias", "file.txt"));
			expect(read.toString()).toBe("inside\n");
			await writeFileInsideWorkspace(root, path.join(root, "alias", "file.txt"), "changed\n");
			expect(await fs.readFile(path.join(root, "real", "file.txt"), "utf8")).toBe("changed\n");
			expect((await fs.lstat(path.join(root, "alias"))).isSymbolicLink()).toBe(true);
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
	it("refuses a parent that became an outside symlink after the path check", async () => {
		if (process.platform === "win32") return;
		// The JS realpath check ran against a real directory; the native walk then
		// meets the swapped symlink. Calling the native helper with the
		// already-checked relative path reproduces that window deterministically.
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-race-"));
		const root = path.join(parent, "repo");
		const outside = path.join(parent, "outside");
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "secret.txt"), "hidden\n");
		await fs.symlink(outside, path.join(root, "sub"));
		const realRoot = await fs.realpath(root);
		const rootId = await rootIdentity(realRoot);
		try {
			expect(() => confinedOpenRead(realRoot, rootId, "sub/secret.txt")).toThrow(/confine:escape/);
			expect(() =>
				confinedWriteFileAtomic(realRoot, rootId, "sub/secret.txt", Buffer.from("overwritten\n"), true),
			).toThrow(/confine:escape/);
			expect(() => confinedWriteFileAtomic(realRoot, rootId, "sub/new.txt", Buffer.from("new\n"), true)).toThrow(
				/confine:escape/,
			);
			expect(() => confinedUnlink(realRoot, rootId, "sub/secret.txt")).toThrow(/confine:escape/);
			expect(() => confinedMkdirAll(realRoot, rootId, "sub/created")).toThrow(/confine:escape/);
			expect(() => confinedOpenRead(realRoot, rootId, "../outside/secret.txt")).toThrow(/confine:escape/);
			expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("hidden\n");
			expect((await fs.readdir(outside)).sort()).toEqual(["secret.txt"]);
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
	it("refuses a final symlink even when it points inside the root", async () => {
		if (process.platform === "win32") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-final-link-"));
		const root = path.join(parent, "repo");
		await fs.mkdir(root);
		const realRoot = await fs.realpath(root);
		const rootId = await rootIdentity(realRoot);
		await fs.writeFile(path.join(root, "target.txt"), "inside\n");
		await fs.symlink(path.join(root, "target.txt"), path.join(root, "link.txt"));
		try {
			expect(() => confinedOpenRead(realRoot, rootId, "link.txt")).toThrow(/confine:escape/);
			expect(() => confinedWriteFileAtomic(realRoot, rootId, "link.txt", Buffer.from("x"), false)).toThrow(
				/confine:escape/,
			);
			expect(await fs.readFile(path.join(root, "target.txt"), "utf8")).toBe("inside\n");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	/* Regression tests for review findings */

	it("[P2] Preserves final-symlink semantics when unlinking an in-root symlink", async () => {
		if (process.platform === "win32") return;
		// Finding 4: unlinkInsideWorkspace should delete the symlink itself, not the target.
		// If resolved with realpath, deleting a symlink to an in-root target will delete the target instead.
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-unlink-symlink-"));
		const root = path.join(parent, "repo");
		const target = path.join(root, "target.txt");
		const link = path.join(root, "link.txt");
		await fs.mkdir(root);
		await fs.writeFile(target, "target content\n");
		await fs.symlink(target, link);
		try {
			await unlinkInsideWorkspace(root, link);
			// After deletion, the symlink should be gone but the target should still exist
			const linkExists = await fs
				.lstat(link)
				.then(() => true)
				.catch(e => (e.code === "ENOENT" ? false : Promise.reject(e)));
			const targetExists = await fs
				.lstat(target)
				.then(() => true)
				.catch(e => (e.code === "ENOENT" ? false : Promise.reject(e)));
			expect(linkExists).toBe(false);
			expect(targetExists).toBe(true);
			expect(await fs.readFile(target, "utf8")).toBe("target content\n");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	it("rejects a root renamed away and replaced by an outside symlink after pinning", async () => {
		if (process.platform === "win32") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-root-symlink-"));
		const root = path.join(parent, "repo");
		const moved = path.join(parent, "repo-moved");
		const outside = path.join(parent, "outside");
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
		try {
			// The first operation pins the root identity.
			await writeFileInsideWorkspace(root, path.join(root, "file1.txt"), "content1\n");
			await fs.rename(root, moved);
			await fs.symlink(outside, root);

			await expect(writeFileInsideWorkspace(root, path.join(root, "file2.txt"), "content2\n")).rejects.toThrow(
				/outside the confined session root/,
			);
			await expect(readFileInsideWorkspace(root, path.join(root, "secret.txt"))).rejects.toThrow(
				/outside the confined session root/,
			);
			await expect(unlinkInsideWorkspace(root, path.join(root, "secret.txt"))).rejects.toThrow(
				/outside the confined session root/,
			);
			expect((await fs.readdir(outside)).sort()).toEqual(["secret.txt"]);
			expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret\n");
			expect((await fs.readdir(moved)).sort()).toEqual(["file1.txt"]);
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	it("rejects a root replaced by a different directory at the same path after pinning", async () => {
		if (process.platform === "win32") return;
		// The replacement passes every pathname check: it is a real directory at
		// the pinned canonical path. Only the native descriptor identity check
		// can tell it apart from the pinned root.
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-root-replaced-"));
		const root = path.join(parent, "repo");
		const moved = path.join(parent, "repo-moved");
		await fs.mkdir(root);
		try {
			await writeFileInsideWorkspace(root, path.join(root, "file1.txt"), "content1\n");
			await fs.rename(root, moved);
			await fs.mkdir(root);
			await fs.writeFile(path.join(root, "planted.txt"), "planted\n");

			await expect(writeFileInsideWorkspace(root, path.join(root, "file2.txt"), "content2\n")).rejects.toThrow(
				/outside the confined session root/,
			);
			await expect(readFileInsideWorkspace(root, path.join(root, "planted.txt"))).rejects.toThrow(
				/outside the confined session root/,
			);
			await expect(mkdirInsideWorkspace(root, path.join(root, "made"))).rejects.toThrow(
				/outside the confined session root/,
			);
			expect((await fs.readdir(root)).sort()).toEqual(["planted.txt"]);
			expect((await fs.readdir(moved)).sort()).toEqual(["file1.txt"]);
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	it("rejects a native operation whose root descriptor does not match the pinned identity", async () => {
		if (process.platform === "win32") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-root-id-"));
		const root = path.join(parent, "repo");
		const other = path.join(parent, "other");
		await fs.mkdir(root);
		await fs.mkdir(other);
		await fs.writeFile(path.join(root, "file.txt"), "inside\n");
		const realRoot = await fs.realpath(root);
		const otherId = await rootIdentity(await fs.realpath(other));
		try {
			expect(() => confinedOpenRead(realRoot, otherId, "file.txt")).toThrow(/confine:escape/);
			expect(() => confinedWriteFileAtomic(realRoot, otherId, "new.txt", Buffer.from("x"), true)).toThrow(
				/confine:escape/,
			);
			expect(() => confinedUnlink(realRoot, otherId, "file.txt")).toThrow(/confine:escape/);
			expect(() => confinedMkdirAll(realRoot, otherId, "made")).toThrow(/confine:escape/);
			expect(() => confinedOpenRead(realRoot, "not-an-identity", "file.txt")).toThrow(/confine:escape/);
			expect((await fs.readdir(root)).sort()).toEqual(["file.txt"]);
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
});
