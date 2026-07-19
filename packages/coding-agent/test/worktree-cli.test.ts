import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandCtor, type CommandEntry, run } from "@gajae-code/utils/cli";
import { runWorktreeCommand } from "../src/cli/worktree-cli";
import {
	MAX_DEPTH,
	MAX_ENTRIES,
	scanWorktrees,
	type WorktreeDiagnostic,
	WorktreeRootError,
} from "../src/cli/worktree-scanner";
import { createWorktreeCommand } from "../src/commands/worktree";

const posixTest = test.skipIf(process.platform === "win32");

async function withRoot(callback: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "gjc-worktree-report-"));
	try {
		await callback(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function diagnostic(result: WorktreeDiagnostic[], candidate: string): WorktreeDiagnostic | undefined {
	return result.find(entry => entry.path === candidate);
}

async function captureOutput(
	callback: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout.push(String(chunk));
		return true;
	});
	const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderr.push(String(chunk));
		return true;
	});
	const previousExitCode = process.exitCode;
	process.exitCode = 0;
	try {
		await callback();
		return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: Number(process.exitCode ?? 0) };
	} finally {
		process.exitCode = previousExitCode;
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	}
}

async function capture(
	Command: CommandCtor,
	argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return captureOutput(async () => {
		await new Command(argv, { bin: "gjc", version: "test", commands: new Map() }).run();
	});
}

async function captureCli(
	commands: CommandEntry[],
	argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return captureOutput(async () => {
		await run({ bin: "gjc", version: "test", argv, commands });
	});
}

describe("bounded worktree scanner", () => {
	test("keeps traversal bounds and handles missing or invalid roots", async () => {
		expect({ MAX_ENTRIES, MAX_DEPTH }).toEqual({ MAX_ENTRIES: 1024, MAX_DEPTH: 2 });
		expect(await scanWorktrees({ root: join(tmpdir(), "gjc-missing-worktree-root") })).toEqual([]);

		await withRoot(async root => {
			const file = join(root, "file");
			await writeFile(file, "not a directory");
			const error = await scanWorktrees({ root: file }).catch(cause => cause);
			expect(error).toBeInstanceOf(WorktreeRootError);
			expect((error as WorktreeRootError).code).toBe("root-invalid");
		});
	});

	posixTest("rejects a symlinked managed root", async () => {
		await withRoot(async root => {
			const target = join(root, "target");
			const linkedRoot = join(root, "linked-root");
			await mkdir(join(target, ".git"), { recursive: true });
			await symlink(target, linkedRoot);
			const error = await scanWorktrees({ root: linkedRoot }).catch(cause => cause);
			expect(error).toBeInstanceOf(WorktreeRootError);
			expect((error as WorktreeRootError).code).toBe("root-invalid");
		});
	});

	test("classifies only local marker types", async () => {
		await withRoot(async root => {
			const gitFile = join(root, "git-file");
			const gitDirectory = join(root, "git-directory");
			const task = join(root, "task");
			const empty = join(root, "empty");
			const stray = join(root, "stray");
			for (const candidate of [gitFile, gitDirectory, task, empty, stray]) await mkdir(candidate);
			await writeFile(join(gitFile, ".git"), "gitdir: /outside/the/managed/root\n");
			await mkdir(join(gitDirectory, ".git"));
			await mkdir(join(task, "merged"));
			await writeFile(join(stray, "note"), "content");

			const result = await scanWorktrees({ root });
			expect(diagnostic(result, gitFile)).toMatchObject({ kind: "pr-checkout", reasonCode: "worktree-metadata" });
			expect(diagnostic(result, gitDirectory)).toMatchObject({
				kind: "pr-checkout",
				reasonCode: "worktree-metadata",
			});
			expect(diagnostic(result, task)).toMatchObject({ kind: "task-isolation", reasonCode: "task-isolation" });
			expect(diagnostic(result, empty)).toMatchObject({ kind: "empty", reasonCode: "empty" });
			expect(diagnostic(result, stray)).toMatchObject({ kind: "stray", reasonCode: "stray" });
			expect(JSON.stringify(result)).not.toContain("/outside/the/managed/root");
		});
	});

	test("does not parse repository-controlled .git contents", async () => {
		await withRoot(async root => {
			const contents = [Buffer.alloc(0), Buffer.from([0xff, 0x00]), Buffer.alloc(70_000, 0x61)];
			for (const [index, content] of contents.entries()) {
				const candidate = join(root, `candidate-${index}`);
				await mkdir(candidate);
				await writeFile(join(candidate, ".git"), content);
			}
			const result = await scanWorktrees({ root });
			expect(result).toHaveLength(contents.length);
			expect(result.every(entry => entry.reasonCode === "worktree-metadata")).toBe(true);
		});
	});

	posixTest("does not follow candidate or marker symlinks", async () => {
		await withRoot(async root => {
			const target = join(root, "target");
			const linkedCandidate = join(root, "linked-candidate");
			const linkedMarker = join(root, "linked-marker");
			const linkedMerged = join(root, "linked-merged");
			await mkdir(target);
			await symlink(target, linkedCandidate);
			await mkdir(linkedMarker);
			await symlink(target, join(linkedMarker, ".git"));
			await mkdir(linkedMerged);
			await symlink(target, join(linkedMerged, "merged"));

			const result = await scanWorktrees({ root });
			expect(diagnostic(result, linkedCandidate)?.reasonCode).toBe("unsupported-link");
			expect(diagnostic(result, linkedMarker)?.reasonCode).toBe("unsupported-link");
			expect(diagnostic(result, linkedMerged)?.reasonCode).toBe("unsupported-link");
		});
	});

	test("supports legacy nesting without descending beyond the limit", async () => {
		await withRoot(async root => {
			const wrapper = join(root, "wrapper");
			const recognized = join(wrapper, "recognized");
			const bounded = join(wrapper, "bounded");
			const tooDeep = join(bounded, "too-deep");
			await mkdir(join(recognized, ".git"), { recursive: true });
			await mkdir(tooDeep, { recursive: true });
			await writeFile(join(tooDeep, ".git"), "ignored");

			const result = await scanWorktrees({ root });
			expect(diagnostic(result, recognized)).toMatchObject({
				kind: "pr-checkout",
				reasonCode: "worktree-metadata",
			});
			expect(diagnostic(result, bounded)).toMatchObject({ kind: "stray", reasonCode: "stray" });
			expect(diagnostic(result, wrapper)).toBeUndefined();
			expect(diagnostic(result, tooDeep)).toBeUndefined();
		});
	});

	test("reports the exact entry-limit boundary", async () => {
		await withRoot(async root => {
			for (let index = 0; index < MAX_ENTRIES; index++)
				await mkdir(join(root, `candidate-${String(index).padStart(4, "0")}`));

			const boundary = await scanWorktrees({ root });
			expect(boundary.filter(entry => entry.reasonCode === "empty")).toHaveLength(MAX_ENTRIES);
			expect(boundary.some(entry => entry.reasonCode === "overflow")).toBe(false);

			await mkdir(join(root, "candidate-overflow"));
			const overflow = await scanWorktrees({ root });
			expect(overflow.filter(entry => entry.reasonCode === "empty")).toHaveLength(MAX_ENTRIES);
			expect(overflow.filter(entry => entry.reasonCode === "overflow")).toHaveLength(1);
		});
	});

	posixTest("escapes control characters in displayed paths", async () => {
		await withRoot(async root => {
			const candidate = join(root, "line\nbreak");
			await mkdir(join(candidate, ".git"), { recursive: true });
			const result = await scanWorktrees({ root });
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toContain("line\\x0Abreak");
			expect(result[0]?.path).not.toContain("\n");
		});
	});
});

describe("report-only worktree command", () => {
	test("public clear forms report zero removals and leave entries unchanged", async () => {
		await withRoot(async root => {
			const candidate = join(root, "candidate");
			const marker = join(candidate, ".git");
			await mkdir(candidate);
			await writeFile(marker, "gitdir: /outside\n");
			const beforeEntries = await readdir(candidate);
			const beforeMarker = await readFile(marker);
			const Command = createWorktreeCommand(() => root);

			expect(await capture(Command, ["clear"])).toEqual({
				stdout: `kept    ${candidate}\n\n0 removed · 1 kept\n`,
				stderr: "",
				exitCode: 0,
			});
			expect(await capture(Command, ["clear", "--json"])).toEqual({
				stdout: '{"removed":0,"kept":1}\n',
				stderr: "",
				exitCode: 0,
			});
			expect(await capture(Command, ["clear", "--dry-run"])).toEqual({
				stdout: "No worktrees are eligible for removal; cleanup is report-only.\n",
				stderr: "",
				exitCode: 0,
			});
			expect(await capture(Command, ["clear", "--dry-run", "--json"])).toEqual({
				stdout: '{"wouldRemove":[]}\n',
				stderr: "",
				exitCode: 0,
			});
			expect(await readdir(candidate)).toEqual(beforeEntries);
			expect(await readFile(marker)).toEqual(beforeMarker);
		});
	});

	test("list emits text and JSON diagnostics", async () => {
		await withRoot(async root => {
			const candidate = join(root, "candidate");
			await mkdir(join(candidate, ".git"), { recursive: true });
			const Command = createWorktreeCommand(() => root);
			expect(await capture(Command, [])).toEqual({
				stdout: `diagnostic  ${candidate}  .git metadata observed; preserved\n\n1 total\n`,
				stderr: "",
				exitCode: 0,
			});
			expect(await capture(Command, ["list", "--json"])).toEqual({
				stdout: `${JSON.stringify([
					{
						path: candidate,
						kind: "pr-checkout",
						reasonCode: "worktree-metadata",
						message: ".git metadata observed; preserved",
					},
				])}\n`,
				stderr: "",
				exitCode: 0,
			});
		});
	});

	test("maps invalid roots to stable text and JSON errors", async () => {
		await withRoot(async root => {
			const file = join(root, "file");
			await writeFile(file, "not a directory");
			expect(await runWorktreeCommand({ root: file, action: "list", json: false, dryRun: false })).toEqual({
				stdout: "",
				stderr: "error: managed worktree root cannot be read\n",
				exitCode: 1,
			});
			expect(await runWorktreeCommand({ root: file, action: "list", json: true, dryRun: false })).toEqual({
				stdout: '{"error":{"code":"worktree_scan_failed","message":"managed worktree root cannot be read"}}\n',
				stderr: "",
				exitCode: 1,
			});
		});
	});

	test("rejects every cleanup flag form before resolving the root", async () => {
		let rootCalls = 0;
		const Command = createWorktreeCommand(() => {
			rootCalls++;
			return "/must-not-be-read";
		});
		for (const argv of [
			["--all"],
			["--dry-run"],
			["list", "--all"],
			["clear", "--all"],
			["--all", "clear"],
			["clear", "--all", "--dry-run"],
			["--all=true"],
		])
			expect(await capture(Command, argv)).toEqual({
				stdout: "",
				stderr: "error: worktree cleanup is report-only\n",
				exitCode: 2,
			});
		for (const argv of [
			["clear", "--all", "--json"],
			["--all", "-j", "clear"],
			["--all=false", "-j", "clear"],
		])
			expect(await capture(Command, argv)).toEqual({
				stdout: '{"error":{"code":"worktree_cleanup_disabled","message":"worktree cleanup is report-only"}}\n',
				stderr: "",
				exitCode: 2,
			});
		expect(rootCalls).toBe(0);
	});

	test("resolves the root once for valid forms", async () => {
		await withRoot(async root => {
			for (const argv of [[], ["list", "--json"], ["clear", "--json"]]) {
				let rootCalls = 0;
				const Command = createWorktreeCommand(() => {
					rootCalls++;
					return root;
				});
				const result = await capture(Command, argv);
				expect(result.exitCode).toBe(0);
				expect(result.stderr).toBe("");
				expect(rootCalls).toBe(1);
			}
		});
	});

	test("publishes help while rejecting all even on help fast paths", async () => {
		let rootCalls = 0;
		const Command = createWorktreeCommand(() => {
			rootCalls++;
			return "/must-not-be-read";
		});
		expect(Command.description).toBe("List report-only diagnostics for agent-managed worktrees");
		expect(Command.delegateHelp).toBe(true);
		expect(Command.examples).toEqual([
			"gjc worktree",
			"gjc worktree list --json",
			"gjc worktree clear",
			"gjc worktree clear --dry-run",
		]);
		const commands: CommandEntry[] = [{ name: "worktree", aliases: ["wt"], load: async () => Command }];
		const help = await captureCli(commands, ["worktree", "--help"]);
		expect(help.stdout).toContain("Unavailable: cleanup is report-only");
		expect(help.exitCode).toBe(0);
		expect(await captureCli(commands, ["worktree", "clear", "--all", "--help"])).toEqual({
			stdout: "",
			stderr: "error: worktree cleanup is report-only\n",
			exitCode: 2,
		});
		expect(await captureCli(commands, ["wt", "--all", "-j", "-h"])).toEqual({
			stdout: '{"error":{"code":"worktree_cleanup_disabled","message":"worktree cleanup is report-only"}}\n',
			stderr: "",
			exitCode: 2,
		});
		expect(await captureCli(commands, ["worktree", "--all=true", "--help"])).toEqual({
			stdout: "",
			stderr: "error: worktree cleanup is report-only\n",
			exitCode: 2,
		});
		expect(await captureCli(commands, ["wt", "--all=false", "-j", "-h"])).toEqual({
			stdout: '{"error":{"code":"worktree_cleanup_disabled","message":"worktree cleanup is report-only"}}\n',
			stderr: "",
			exitCode: 2,
		});
		expect(rootCalls).toBe(0);
	});
});
