/**
 * Runs one GJC git/gh wrapper operation from a project directory, the way the
 * app does: `@gajae-code/utils/env` loads first (copying the project `.env` into
 * the process environment), then the wrapper spawns `git` or `gh`.
 */
import "@gajae-code/utils/env";
import * as git from "@gajae-code/coding-agent/utils/git";

const op = process.argv[2];
const cwd = process.cwd();
try {
	if (op === "commit") await git.commit(cwd, "probe");
	else if (op === "push") await git.push(cwd, { remote: "origin", refspec: "HEAD:refs/heads/probe" });
	else if (op === "read-tree") await git.readTree(cwd, "HEAD", { env: { GIT_INDEX_FILE: `${cwd}/.git/probe-index` } });
	else if (op === "gh") await git.github.run(cwd, ["search", "repos", "gjc-probe", "--limit", "1"]);
	else throw new Error(`unknown op ${op}`);
} catch {
	// The operation may fail (unreachable remote, no network); only the hook marker matters.
}
console.log(JSON.stringify({ done: true }));
