import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeCheckpointChangeSet,
	parseGitNameStatus,
	parseGitUntrackedPaths,
	spawnText,
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

	it("preserves leading, trailing, and embedded newline bytes in NUL-delimited paths", () => {
		const pathValue = " leading and trailing\nname.ts ";
		expect(parseGitUntrackedPaths(`${pathValue}\0`)).toEqual([
			{
				path: pathValue,
				status: "added",
				category: "other",
			},
		]);
	});

	it("keeps literal POSIX backslash pairs distinct from slash paths", () => {
		const backslashPath = "dir\\\\name.ts";
		expect(parseGitUntrackedPaths(`${backslashPath}\0dir/name.ts\0`).map(row => row.path)).toEqual([
			backslashPath,
			"dir/name.ts",
		]);
	});

	it("fails command capture closed when stdout is not valid UTF-8", async () => {
		const result = await spawnText([process.execPath, "-e", "process.stdout.write(Buffer.from([0xff]))"], {
			cwd: process.cwd(),
		});
		expect(result.ok).toBe(false);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("not valid UTF-8");
	});

	it("preserves a leading UTF-8 BOM as part of the first pathname", async () => {
		const result = await spawnText(
			[
				process.execPath,
				"-e",
				"process.stdout.write(Buffer.from([0xef,0xbb,0xbf,0x6e,0x61,0x6d,0x65,0x2e,0x74,0x73,0x00]))",
			],
			{ cwd: process.cwd() },
		);
		expect(result.ok).toBe(true);
		expect(parseGitUntrackedPaths(result.stdout)[0]?.path).toBe("\uFEFFname.ts");
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
