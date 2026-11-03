/**
 * Runs one of GJC's own direct `git` callers (outside `utils/git.ts`) from the
 * current (project) directory the way the app does: `@gajae-code/utils/env`
 * loads first (copying the project `.env` into the process environment), then
 * the caller spawns git. Only whether a planted git hook ran matters.
 */
import "@gajae-code/utils/env";
import { prepareLaunchWorktree } from "../../src/gjc-runtime/launch-worktree";
import { computeCheckpointChangeSet } from "../../src/gjc-runtime/ultragoal-change-set";

const op = process.argv[2];
const cwd = process.cwd();
try {
	// `gjc --worktree`: `git worktree add` checks out the tree and runs `post-checkout`.
	if (op === "launch-worktree") prepareLaunchWorktree(cwd, ["--worktree"]);
	// ultragoal checkpoints: `git status`/`git diff` run `core.fsmonitor`.
	else if (op === "checkpoint") await computeCheckpointChangeSet(cwd);
	else throw new Error(`unknown op ${op}`);
} catch {
	// Only the hook marker matters.
}
console.log(JSON.stringify({ done: true }));
process.exit(0);
