import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeCheckpointChangeSet,
	parseGitNameStatus,
	parseGitUntrackedPaths,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-change-set";

describe("ultragoal change-set extraction", () => {
	it("preserves rename paths and categories", () => {
		expect(parseGitNameStatus("R100\told.ts\tpackages/coding-agent/src/tools/computer.ts\n")).toEqual([
			{
				path: "packages/coding-agent/src/tools/computer.ts",
				oldPath: "old.ts",
				status: "renamed",
				category: "tool",
			},
		]);
	});

	it("preserves spaces and rename boundaries from NUL-delimited Git output", () => {
		expect(
			parseGitNameStatus(
				"M\0docs/file with spaces.md\0R100\0old dir/old name.ts\0packages/coding-agent/src/new name.ts\0",
			),
		).toEqual([
			{
				path: "docs/file with spaces.md",
				oldPath: undefined,
				status: "modified",
				category: "other",
			},
			{
				path: "packages/coding-agent/src/new name.ts",
				oldPath: "old dir/old name.ts",
				status: "renamed",
				category: "other",
			},
		]);
	});

	it("preserves spaces in legacy tab-delimited input", () => {
		expect(parseGitNameStatus("M\tdocs/file with spaces.md\n")).toEqual([
			{
				path: "docs/file with spaces.md",
				oldPath: undefined,
				status: "modified",
				category: "other",
			},
		]);
	});

	it("classifies NUL-delimited untracked paths as added without truncating spaces", () => {
		expect(parseGitUntrackedPaths("new dir/untracked file.ts\0")).toEqual([
			{
				path: "new dir/untracked file.ts",
				status: "added",
				category: "other",
			},
		]);
	});

	it("includes untracked files in the computed cumulative change set", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-untracked-change-set-"));
		try {
			expect(await Bun.spawn(["git", "init"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
			await Bun.write(path.join(root, "tracked.txt"), "baseline\n");
			expect(
				await Bun.spawn(["git", "add", "tracked.txt"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			expect(
				await Bun.spawn(
					["git", "-c", "user.name=GJC Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"],
					{ cwd: root, stdout: "ignore", stderr: "ignore" },
				).exited,
			).toBe(0);
			expect(
				await Bun.spawn(["git", "branch", "dev"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			await Bun.write(path.join(root, "new file.ts"), "export const untracked = true;\n");
			const changeSet = await computeCheckpointChangeSet(root);
			expect(changeSet?.paths).toContainEqual({
				path: "new file.ts",
				status: "added",
				category: "other",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
