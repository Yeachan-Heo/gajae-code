import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { preserveDirtyWorktree } from "../../src/harness-control-plane/preserve";

function git(ws: string, args: string[]): string {
	return execFileSync("git", args, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

let ws: string;

beforeEach(async () => {
	ws = await mkdtemp(path.join(tmpdir(), "h-pres-"));
	git(ws, ["init", "-q"]);
	git(ws, ["config", "user.email", "t@t"]);
	git(ws, ["config", "user.name", "t"]);
	git(ws, ["config", "commit.gpgsign", "false"]);
	await writeFile(path.join(ws, "a.txt"), "v1\n");
	git(ws, ["add", "."]);
	git(ws, ["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
	await rm(ws, { recursive: true, force: true });
});

describe("preserveDirtyWorktree (real git, B2)", () => {
	it("clean tree -> clean, no stash, snapshotComplete", () => {
		const r = preserveDirtyWorktree(ws);
		expect(r.gitDelta).toBe("clean");
		expect(r.stashRef).toBeNull();
		expect(r.snapshotComplete).toBe(true);
	});

	it("captures tracked diff + untracked manifest + stash ref WITHOUT mutating the worktree (no data loss)", async () => {
		await writeFile(path.join(ws, "a.txt"), "v2-modified\n");
		await writeFile(path.join(ws, "b.txt"), "new");
		const r = preserveDirtyWorktree(ws);
		expect(r.gitDelta).toBe("dirty");
		expect(r.trackedDiff).toContain("a.txt");
		expect(r.trackedDiffSha256.length).toBeGreaterThan(0);
		expect(r.untrackedManifest.map(e => e.path)).toContain("b.txt");
		expect(r.stashRef).toBeTruthy();
		expect(r.snapshotComplete).toBe(true);
		// No data loss: the working tree is untouched by the snapshot.
		expect(await readFile(path.join(ws, "a.txt"), "utf8")).toBe("v2-modified\n");
		expect(await readFile(path.join(ws, "b.txt"), "utf8")).toBe("new");
		// The snapshot is recoverable from the stash list.
		expect(git(ws, ["stash", "list"]).trim().length).toBeGreaterThan(0);
	});

	it("untracked-only dirty is manifested and never deleted", async () => {
		await writeFile(path.join(ws, "c.txt"), "untracked-only");
		const r = preserveDirtyWorktree(ws);
		expect(r.gitDelta).toBe("dirty");
		expect(r.untrackedManifest.map(e => e.path)).toContain("c.txt");
		expect(r.snapshotComplete).toBe(true);
		expect(await readFile(path.join(ws, "c.txt"), "utf8")).toBe("untracked-only");
	});
});
