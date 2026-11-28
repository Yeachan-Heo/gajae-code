import { SessionManager } from "../../src/session/session-manager";
import { SessionHeldError } from "../../src/session/session-owner-holder";

// One writer of a managed transcript on the legacy route, in a process of its own. It reports a
// refused open (`held`) or every append outcome, so the parent can tell commits from refusals.
// Signals: it writes `<label>.opened`, appends after `<label>.go`, writes `<label>.appended`, and
// closes after `<label>.close`.
const [cwd, agentDir, file, label, countArgument, signalDir, releaseTimeoutArgument] = process.argv.slice(2);
if (!cwd || !agentDir || !file || !label || !signalDir)
	throw new Error("usage: <cwd> <agentDir> <sessionFile> <label> <count> <signalDir> [releaseTimeoutMs]");
const count = Number(countArgument ?? "3");
const releaseTimeoutMs = Number(releaseTimeoutArgument ?? "30000");
if (
	(releaseTimeoutArgument !== undefined && !/^\d+$/.test(releaseTimeoutArgument)) ||
	!Number.isSafeInteger(releaseTimeoutMs) ||
	releaseTimeoutMs < 0
)
	throw new Error("releaseTimeoutMs must be a nonnegative safe integer");

async function signal(name: string): Promise<void> {
	const deadline = performance.now() + releaseTimeoutMs;
	while (!(await Bun.file(`${signalDir}/${label}.${name}`).exists())) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw new Error(`timed out waiting for ${name} signal for ${label}`);
		await Bun.sleep(Math.min(25, remaining));
	}
}

type Outcome = { label: string; index?: number; kind: string; id?: string; reason?: string; holderPid?: number };
const report = (outcomes: Outcome[]) => process.stdout.write(`${JSON.stringify(outcomes)}\n`);

// Use the parent's managed scope, not a hand-built destination; the ownership mode is the process's.
const destination = SessionManager.managedDestination(cwd, agentDir);
let manager: SessionManager;
try {
	manager = await SessionManager.open(file, destination);
} catch (error) {
	if (!(error instanceof SessionHeldError)) throw error;
	report([{ label, kind: "held", reason: error.operatorMessage, holderPid: error.holder?.pid }]);
	process.exit(0);
}
await Bun.write(`${signalDir}/${label}.opened`, `${process.pid}\n`);
await signal("go");
const outcomes: Outcome[] = [];
for (let index = 0; index < count; index++) {
	let id: string | undefined;
	let failure: unknown;
	try {
		id = manager.appendMessage({ role: "user" as const, content: `${label}-${index}`, timestamp: Date.now() });
		await manager.flush();
	} catch (error) {
		failure = error;
	}
	const refused = manager.getAppendIdentityMismatch();
	if (refused) {
		outcomes.push({ label, index, kind: "refused", reason: refused.operatorMessage });
		break;
	}
	if (failure !== undefined) throw failure;
	outcomes.push({ label, index, kind: "committed", id });
}
report(outcomes);
await Bun.write(`${signalDir}/${label}.appended`, "appended\n");
await signal("close");
// A manager whose writes a peer stopped rethrows that refusal when it closes; it was reported above.
await manager.close().catch(() => undefined);
