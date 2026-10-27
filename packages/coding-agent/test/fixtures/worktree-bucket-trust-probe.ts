// Prints the launch worktree path the public reader resolves.
// Spawned with a controlled cwd so that directory's `.env` is loaded before
// the reader consults the project dotenv snapshot.
import * as fs from "node:fs";
import * as os from "node:os";
import { planLaunchWorktree, prepareLaunchWorktree } from "../../src/gjc-runtime/launch-worktree";

const drop = process.env.GJC_WORKTREE_BUCKET_PROBE_DROP;
if (drop === "unlink") fs.rmSync(".env", { force: true });
else if (drop === "chdir") process.chdir(os.tmpdir());

const repo = process.env.GJC_WORKTREE_BUCKET_PROBE_REPO;
if (!repo) throw new Error("missing repo");

const mode = process.env.GJC_WORKTREE_BUCKET_PROBE_MODE ?? "plan";

try {
	if (mode === "prepare") {
		const prepared = prepareLaunchWorktree(repo, ["--worktree", "lane"]);
		const worktree = prepared.worktree;
		console.log(
			JSON.stringify({
				error: null,
				worktreePath: worktree.enabled ? worktree.worktreePath : null,
				envValue: process.env.GJC_WORKTREE_DIR ?? null,
			}),
		);
	} else {
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "lane" });
		console.log(
			JSON.stringify({
				error: null,
				worktreePath: planned.enabled ? planned.worktreePath : null,
				envValue: process.env.GJC_WORKTREE_DIR ?? null,
			}),
		);
	}
} catch (error) {
	console.log(
		JSON.stringify({
			error: error instanceof Error ? error.message : String(error),
			worktreePath: null,
			envValue: process.env.GJC_WORKTREE_DIR ?? null,
		}),
	);
}
