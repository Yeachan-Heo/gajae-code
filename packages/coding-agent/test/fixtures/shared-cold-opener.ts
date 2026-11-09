import { SessionManager } from "../../src/session/session-manager";

const [worker, cwd, agentDir, file] = process.argv.slice(2);
if (!worker || !cwd || !agentDir || !file || !process.send) throw new Error("Expected cold opener IPC arguments");

const gates = new Map(["append", "continue", "close", "exit"].map(name => [name, Promise.withResolvers<void>()]));
process.on("message", (message: unknown) => {
	const gate = (message as { gate?: string }).gate;
	if (gate) gates.get(gate)?.resolve();
});
const send = (event: string, detail: Record<string, unknown> = {}) => process.send!({ worker, event, ...detail });
let manager: SessionManager | undefined;
try {
	const destination = SessionManager.managedDestination(cwd, agentDir);
	manager = await SessionManager.open(file, destination, undefined, "copy-retain", "enabled");
	send("opened", {
		pid: process.pid,
		logicalId: manager.getSessionId(),
		leaf: manager.getLeafId(),
		cold: manager.getSessionMemoryStats().coldRetirementActive,
	});
	await gates.get("append")!.promise;
	const outcome = await manager.appendMessageSharingSession({
		role: "user",
		content: `branch ${worker}`,
		timestamp: worker === "a" ? 2 : 3,
	});
	send("appended", { outcome, leaf: manager.getLeafId() });
	if (worker === "b") {
		await gates.get("continue")!.promise;
		const continued = await manager.appendMessageSharingSession({
			role: "user",
			content: "branch b after a closed",
			timestamp: 4,
		});
		send("continued", { outcome: continued, leaf: manager.getLeafId() });
	}
	await gates.get("close")!.promise;
	const closed = await manager.closeStrict();
	manager = undefined;
	send("closed", { outcome: closed.kind });
	await gates.get("exit")!.promise;
} catch (error) {
	const reason = error instanceof Error ? error : new Error(String(error));
	send("failed", {
		message: reason.message,
		stack: reason.stack,
		cause: reason.cause instanceof Error ? `${reason.cause.name}: ${reason.cause.message}` : String(reason.cause),
	});
	process.exitCode = 1;
} finally {
	if (manager) {
		try {
			const closed = await manager.closeStrict();
			if (closed.kind !== "closed") send("cleanup-failed", { reason: closed.kind });
		} catch (error) {
			send("cleanup-failed", { reason: String(error) });
		}
	}
	process.disconnect?.();
}
