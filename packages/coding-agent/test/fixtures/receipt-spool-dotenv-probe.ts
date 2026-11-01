// Spawned with cwd set to a fixture checkout so Bun autoloads that directory's
// `.env` before this file runs. Prints one marker line after finalize.
import { type FinalizeChecks, runFinalize } from "../../src/harness-control-plane/finalize";
import { RECEIPT_SPOOL_DIR_ENV, withReceiptSpoolDir } from "../../src/harness-control-plane/receipt-spool";

const root = process.argv[2];
if (!root) {
	console.error("missing root");
	process.exit(2);
}

const checks: FinalizeChecks = {
	async runValidation(spec) {
		return { exactCommand: spec.command, cwd: "/ws", exitStatus: 0, pass: true };
	},
	async resolveCommit() {
		return "abc123";
	},
	async commitOnBranch() {
		return true;
	},
	async prOrIssue() {
		return { prUrl: "https://example.test/pull/545", issueArtifact: null };
	},
};

const run = () =>
	runFinalize({
		root,
		sessionId: "spool-dotenv",
		workspace: "/ws",
		branch: "feat/545",
		requireTests: true,
		requireCommit: true,
		requirePr: true,
		validationCommands: [{ name: "probe", command: "true" }],
		checks,
	});

const requested = process.env[RECEIPT_SPOOL_DIR_ENV];
const result = requested?.trim() ? await withReceiptSpoolDir(requested, run) : await run();
console.log(`RECEIPT_SPOOL_PROBE ${JSON.stringify({ completed: result.completed === true })}`);
