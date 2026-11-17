// Child for broken-pipe-stderr.test.ts (#7790): writes to stderr after the parent closed
// its read end, or throws an ordinary error, with postmortem's handlers installed.
import { getCrashLogPath } from "../../src/dirs";
import "../../src/postmortem";

process.stdout.write(`${getCrashLogPath()}\n`);
setTimeout(() => {
	if (process.argv[2] === "ordinary") throw new Error("ordinary fatal");
	process.stderr.write("written after the stderr reader closed\n");
}, 200);
