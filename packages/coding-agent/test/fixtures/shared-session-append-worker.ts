import { SessionManager } from "../../src/session/session-manager";

// Report every append outcome so the parent can distinguish commits from refusals.
const [cwd, agentDir, file, label, countArgument, signalDir, releaseTimeoutArgument] = process.argv.slice(2);
if (!cwd || !agentDir || !file || !label)
	throw new Error("usage: <cwd> <agentDir> <sessionFile> <label> <count> [signalDir] [releaseTimeoutMs]");
const count = Number(countArgument ?? "3");
const releaseTimeoutMs = Number(releaseTimeoutArgument ?? "30000");
if (
	(releaseTimeoutArgument !== undefined && !/^\d+$/.test(releaseTimeoutArgument)) ||
	!Number.isSafeInteger(releaseTimeoutMs) ||
	releaseTimeoutMs < 0
)
	throw new Error("releaseTimeoutMs must be a nonnegative safe integer");

// Use the parent's managed scope, not a hand-built destination.
const destination = SessionManager.managedDestination(cwd, agentDir);
const manager = await SessionManager.open(file, destination);
try {
	// Staggered opens isolate append publication from simultaneous-open identity mismatches.
	if (signalDir) {
		await Bun.write(`${signalDir}/${label}.opened`, "opened\n");
		const deadline = performance.now() + releaseTimeoutMs;
		while (!(await Bun.file(`${signalDir}/${label}.go`).exists())) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw new Error(`timed out waiting for release signal for ${label}`);
			await Bun.sleep(Math.min(25, remaining));
		}
	}
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
	process.stdout.write(`${JSON.stringify(outcomes)}\n`);
} finally {
	await manager.closeStrict();
}
