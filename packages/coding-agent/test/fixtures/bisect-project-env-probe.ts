/**
 * Runs the bisect tool from the current (project) directory the way the app
 * does: `@gajae-code/utils/env` loads first (copying the project `.env` into the
 * process environment), then the tool evaluates its `run` predicate with
 * `sh -c` at each candidate commit. Only whether a planted preload ran matters.
 */
import "@gajae-code/utils/env";
import type { ToolSession } from "../../src/tools";
import { BisectTool } from "../../src/tools/bisect";

const cwd = process.cwd();
const session = { cwd, hasUI: false, getSessionFile: () => null } as unknown as ToolSession;
await new BisectTool(session).execute("probe", {
	good: "HEAD~2",
	bad: "HEAD",
	run: "node -e 0 && grep -q PASS flag.txt",
	invert: false,
	maxSteps: 10,
	stepTimeoutMs: 20_000,
});
console.log(JSON.stringify({ done: true }));
process.exit(0);
