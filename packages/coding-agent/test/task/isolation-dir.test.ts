import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	allocateDisjointIsolationDir,
	assertIsolationTeardownTarget,
	removeIsolationDirectory,
	resolveIsolationRemovalTarget,
} from "../../src/task/isolation-dir";

async function tempRoot(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "gjc-iso-dir-"));
}

describe("task isolation directories", () => {
	it("allocates a sibling and leaves a planted canonical tree in place", async () => {
		const root = await tempRoot();
		try {
			const canonical = path.join(root, "0-T1-abc1234");
			const planted = path.join(canonical, "merged", "in-flight-work.ts");
			await fs.mkdir(path.dirname(planted), { recursive: true });
			await fs.writeFile(planted, "session A in-flight work\n");
			await fs.mkdir(path.join(root, "0-T1-abc1234-aa"), { mode: 0o700 });
			await fs.writeFile(path.join(root, "0-T1-abc1234-aa", "owned.txt"), "other attempt\n");

			let issued = 0;
			const allocated = await allocateDisjointIsolationDir(canonical, () => {
				issued += 1;
				return issued === 1 ? "aa" : "bb";
			});
			const second = await allocateDisjointIsolationDir(canonical);

			expect(allocated).toBe(path.join(root, "0-T1-abc1234-bb"));
			expect(second).not.toBe(canonical);
			expect(second).not.toBe(allocated);
			expect(path.dirname(second)).toBe(root);
			expect(path.basename(second).startsWith("0-T1-abc1234-")).toBe(true);
			expect(await fs.readFile(planted, "utf8")).toBe("session A in-flight work\n");
			expect(await fs.readFile(path.join(root, "0-T1-abc1234-aa", "owned.txt"), "utf8")).toBe("other attempt\n");
			expect((await fs.stat(allocated)).isDirectory()).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("removes only the allocated directory", async () => {
		const root = await tempRoot();
		try {
			const canonical = path.join(root, "0-T1-abc1234");
			const planted = path.join(canonical, "merged", "in-flight-work.ts");
			await fs.mkdir(path.dirname(planted), { recursive: true });
			await fs.writeFile(planted, "session A in-flight work\n");
			const allocated = await allocateDisjointIsolationDir(canonical, () => "cc");
			await fs.writeFile(path.join(allocated, "live.txt"), "live\n");

			await removeIsolationDirectory(path.join(allocated, "merged"), root);

			expect(await fs.readFile(planted, "utf8")).toBe("session A in-flight work\n");
			await expect(fs.stat(allocated)).rejects.toMatchObject({ code: "ENOENT" });
			await removeIsolationDirectory(path.join(root, "missing-token", "merged"), root);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("refuses root, empty, and nested removal targets", () => {
		const root = path.resolve("/tmp/gjc-wt-root");
		expect(resolveIsolationRemovalTarget(path.join(root, "0-T1-abc-token", "merged"), root)).toBe(
			path.resolve(root, "0-T1-abc-token"),
		);
		expect(resolveIsolationRemovalTarget(path.join(root, "0-T1-abc-token", "merged") + path.sep, root)).toBe(
			path.resolve(root, "0-T1-abc-token"),
		);
		expect(() => resolveIsolationRemovalTarget("", root)).toThrow(/empty merged path/);
		expect(() => resolveIsolationRemovalTarget(path.join(root, "id", "merged"), "")).toThrow(
			/without a worktree root/,
		);
		expect(() => resolveIsolationRemovalTarget(path.join(root, "merged"), root)).toThrow(
			/not a single worktree entry/,
		);
		expect(() => resolveIsolationRemovalTarget("/", root)).toThrow(/not a single worktree entry/);
		expect(() => resolveIsolationRemovalTarget(path.join(root, "nested", "id", "merged"), root)).toThrow(
			/not a single worktree entry/,
		);
	});

	it("keeps Windows drive-letter parents inside one worktree entry", () => {
		const win = path.win32;
		const root = "C:\\Users\\me\\.gjc\\wt";
		const merged = "C:\\Users\\me\\.gjc\\wt\\0-T1-abc1234-token\\merged";
		expect(resolveIsolationRemovalTarget(merged, root, win)).toBe(
			win.resolve("C:\\Users\\me\\.gjc\\wt\\0-T1-abc1234-token"),
		);
		expect(resolveIsolationRemovalTarget(`${merged}\\`, root, win)).toBe(
			win.resolve("C:\\Users\\me\\.gjc\\wt\\0-T1-abc1234-token"),
		);
		expect(() => resolveIsolationRemovalTarget("C:\\merged", root, win)).toThrow(/not a single worktree entry/);
		expect(() => resolveIsolationRemovalTarget("C:\\Users\\me\\.gjc\\wt\\nested\\id\\merged", root, win)).toThrow(
			/not a single worktree entry/,
		);
		expect(() => resolveIsolationRemovalTarget("", root, win)).toThrow(/empty merged path/);
		expect(() =>
			resolveIsolationRemovalTarget("\\\\server\\share\\wt\\merged", "\\\\server\\share\\wt", win),
		).toThrow(/not a single worktree entry/);
	});

	it("skips teardown when the isolation directory is already gone", async () => {
		const root = await tempRoot();
		try {
			expect(await assertIsolationTeardownTarget(path.join(root, "missing-token", "merged"), root)).toBe("skip");
			const base = path.join(root, "0-T1-abc-token");
			await fs.mkdir(base, { mode: 0o700 });
			expect(await assertIsolationTeardownTarget(path.join(base, "merged"), root)).toBe("stop");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"refuses to remove a symlink planted at the isolation directory",
		async () => {
			const root = await tempRoot();
			const outside = await tempRoot();
			try {
				const targetFile = path.join(outside, "keep.txt");
				await fs.writeFile(targetFile, "keep\n");
				const link = path.join(root, "0-T1-abc-token");
				await fs.symlink(outside, link);
				await expect(assertIsolationTeardownTarget(path.join(link, "merged"), root)).rejects.toThrow(
					/symlinked isolation directory/,
				);
				await expect(removeIsolationDirectory(path.join(link, "merged"), root)).rejects.toThrow(/symlinked/);
				expect(await fs.readFile(targetFile, "utf8")).toBe("keep\n");
			} finally {
				await fs.rm(root, { recursive: true, force: true });
				await fs.rm(outside, { recursive: true, force: true });
			}
		},
	);
});
