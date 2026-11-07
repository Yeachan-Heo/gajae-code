import { SessionManager } from "../../src/session/session-manager";

// One child process of the two-process case: open the shared transcript, publish a fixed number
// of appends through the shared seam, and report every outcome with its reason so the parent can
// tell a commit from a refusal instead of inferring it from the file.

const [cwd, agentDir, file, label, countArgument] = process.argv.slice(2);
if (!cwd || !agentDir || !file || !label) throw new Error("usage: <cwd> <agentDir> <sessionFile> <label> <count>");
const count = Number(countArgument ?? "3");

// Derived the same way the parent does; a hand-built path would open a different scope and make
// the case meaningless.
const destination = SessionManager.managedDestination(cwd, agentDir);
const manager = await SessionManager.open(file, destination);
const outcomes: { label: string; index: number; kind: string; id?: string; reason?: string }[] = [];
for (let index = 0; index < count; index++) {
	const outcome = await manager.appendMessageSharingSession({
		role: "user" as const,
		content: `${label}-${index}`,
		timestamp: Date.now(),
	});
	if (outcome.kind === "committed") outcomes.push({ label, index, kind: outcome.kind, id: outcome.id });
	else if (outcome.kind === "stale") outcomes.push({ label, index, kind: outcome.kind, reason: outcome.reason });
	else
		outcomes.push({
			label,
			index,
			kind: outcome.kind,
			reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
		});
	if (outcome.kind !== "committed") break;
}
await manager.closeStrict().catch(() => undefined);
process.stdout.write(`${JSON.stringify(outcomes)}\n`);
