import { parseArgs } from "../../src/cli/args";
import { runRootCommand } from "../../src/main";

const requested = process.argv[2];
const expectedExitCode = requested === "undefined" ? undefined : Number(requested);
if (expectedExitCode !== undefined) process.exitCode = expectedExitCode;

const originalExitCode = process.exitCode;
await runRootCommand(parseArgs(["--resume"]), [], {
	suppressProcessExit: true,
	isResumePickerTerminal: () => false,
});

if (process.exitCode !== originalExitCode) {
	throw new Error(`Expected process.exitCode ${String(originalExitCode)}, received ${String(process.exitCode)}`);
}

process.exitCode = 0;
