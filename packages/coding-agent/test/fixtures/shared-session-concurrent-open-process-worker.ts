import * as path from "node:path";
import { ManagedLockTestHooks } from "../../src/session/internal/managed-session-storage";
import { managedSessionTransactionLockName } from "../../src/session/internal/managed-session-transaction";
import { SessionManager, SessionManagerTestHooks } from "../../src/session/session-manager";

const [worker, cwd, agentDir] = process.argv.slice(2);
if (!worker || !cwd || !agentDir || !process.send) throw new Error("Expected isolated IPC worker arguments");
const gates = new Map<string, PromiseWithResolvers<void>>();
for (const name of ["seed", "open", "hydrate", "append"]) gates.set(name, Promise.withResolvers<void>());
let file = "";
let logicalId = "";
process.on("message", (message: unknown) => {
	const command = message as { gate: string; file?: string; logicalId?: string };
	if (command.file) file = command.file;
	if (command.logicalId) logicalId = command.logicalId;
	gates.get(command.gate)?.resolve();
});
const send = (event: string, detail: Record<string, unknown> = {}) => process.send!({ worker, event, ...detail });
const deadline = setTimeout(() => {
	send("error", { error: "Worker deadline exceeded" });
	process.exit(1);
}, 25_000);
let manager: SessionManager | undefined;
try {
	const destination = SessionManager.managedDestination(cwd, agentDir);
	send("ready", { pid: process.pid });
	if (worker === "a") {
		await gates.get("seed")!.promise;
		const seed = SessionManager.create(cwd, destination);
		try {
			const parent = seed.appendMessage({ role: "user", content: "shared parent", timestamp: 1 });
			await seed.ensureOnDisk();
			file = seed.getSessionFile()!;
			logicalId = seed.getSessionId();
			send("seeded", { file, logicalId, parent, bytes: await Bun.file(file).text() });
		} finally {
			await seed.closeStrict();
		}
	}
	await gates.get("open")!.promise;
	let phase = "open";
	const reported = new Set<string>();
	ManagedLockTestHooks.beforeContentionWait = candidate => {
		if (path.basename(candidate) !== `${managedSessionTransactionLockName(logicalId)}.lock`) return;
		if (reported.has(phase)) return;
		reported.add(phase);
		send(`${phase}-contention`);
	};
	SessionManagerTestHooks.beforeExistingSessionHydration = async candidate => {
		if (candidate !== file) throw new Error(`Unexpected hydration path: ${candidate}`);
		send("hydrating");
		await gates.get("hydrate")!.promise;
	};
	send("opening");
	manager = await SessionManager.open(file, destination);
	send("opened", { logicalId: manager.getSessionId(), leaf: manager.getLeafId() });
	await gates.get("append")!.promise;
	phase = "append";
	send("appending");
	const outcome = await manager.appendMessageSharingSession({
		role: "user",
		content: `branch ${worker}`,
		timestamp: worker === "a" ? 2 : 3,
	});
	if (outcome.kind !== "committed") throw new Error(`Append did not commit: ${outcome.kind}`);
	send("appended", { id: outcome.id, leaf: manager.getLeafId(), logicalId: manager.getSessionId() });
	await manager.closeStrict();
	manager = undefined;
	send("done");
} catch (error) {
	send("error", { error: error instanceof Error ? error.stack : String(error) });
	process.exitCode = 1;
} finally {
	SessionManagerTestHooks.beforeExistingSessionHydration = undefined;
	ManagedLockTestHooks.beforeContentionWait = undefined;
	try {
		await manager?.closeStrict();
	} catch (error) {
		send("error", { error: String(error) });
		process.exitCode = 1;
	}
	clearTimeout(deadline);
	process.disconnect?.();
}
