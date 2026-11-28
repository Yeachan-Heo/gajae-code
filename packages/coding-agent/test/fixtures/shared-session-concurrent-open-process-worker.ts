import * as path from "node:path";
import { ManagedLockTestHooks } from "../../src/session/internal/managed-session-storage";
import { managedSessionTransactionLockName } from "../../src/session/internal/managed-session-transaction";
import { getSessionMessageEntryId, SessionManager, SessionManagerTestHooks } from "../../src/session/session-manager";

const [worker, cwd, agentDir, scenario] = process.argv.slice(2);
if (!worker || !cwd || !agentDir || !process.send) throw new Error("Expected isolated IPC worker arguments");
const gates = new Map<string, PromiseWithResolvers<void>>();
for (const name of [
	"seed",
	"open",
	"hydrate",
	"append",
	"finalize",
	"snapshot-release",
	"stale-finalize",
	"reopen",
	"publish",
])
	gates.set(name, Promise.withResolvers<void>());
let file = "";
let logicalId = "";
process.on("message", (message: unknown) => {
	const command = message as { gate: string; file?: string; logicalId?: string };
	if (command.file) file = command.file;
	if (command.logicalId) logicalId = command.logicalId;
	gates.get(command.gate)?.resolve();
});
const send = (event: string, detail: Record<string, unknown> = {}) => process.send!({ worker, event, ...detail });

/** A legacy append and flush, reported as the id it wrote or the error class that refused it. */
async function legacyAppend(
	target: SessionManager,
	message: Parameters<SessionManager["appendMessage"]>[0],
): Promise<{ kind: "appended"; id: string } | { kind: "refused"; error: string }> {
	try {
		const id = target.appendMessage(message);
		await target.flush();
		return { kind: "appended", id };
	} catch (error) {
		return { kind: "refused", error: error instanceof Error ? error.name : String(error) };
	}
}
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
		let seedClosed = false;
		try {
			let parent = seed.appendMessage({ role: "user", content: "shared parent", timestamp: 1 });
			if (scenario === "finalize") {
				const root = parent;
				seed.appendMessage({ role: "user", content: "older sibling", timestamp: 2 });
				seed.branch(root);
				parent = seed.appendMessage({ role: "user", content: "selected leaf", timestamp: 3 });
			}
			await seed.ensureOnDisk();
			file = seed.getSessionFile()!;
			logicalId = seed.getSessionId();
			const closed = await seed.closeStrict();
			if (closed.kind !== "closed") throw new Error(`Seed close failed: ${closed.kind}`);
			seedClosed = true;
			send("seed-closed", { outcome: closed.kind });
			const currentBytes = await Bun.file(file).text();
			if (scenario === "finalize") {
				const newline = currentBytes.indexOf("\n");
				const header = JSON.parse(currentBytes.slice(0, newline));
				header.version = 4;
				await Bun.write(file, JSON.stringify(header) + currentBytes.slice(newline));
			}
			send("seeded", { file, logicalId, parent, currentBytes, bytes: await Bun.file(file).text() });
		} finally {
			if (!seedClosed) {
				try {
					const closed = await seed.closeStrict();
					if (closed.kind !== "closed") {
						send("error", { error: `Seed cleanup close failed: ${closed.kind}` });
						process.exitCode = 1;
					}
				} catch (error) {
					send("error", { error: `Seed cleanup close failed: ${String(error)}` });
					process.exitCode = 1;
				}
			}
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
	if (scenario !== "finalize") {
		SessionManagerTestHooks.beforeExistingSessionHydration = async candidate => {
			if (candidate !== file) throw new Error(`Unexpected hydration path: ${candidate}`);
			send("hydrating");
			await gates.get("hydrate")!.promise;
		};
	}
	send("opening");
	try {
		manager = await SessionManager.open(file, destination);
	} catch (error) {
		if (scenario === "finalize") throw error;
		// A peer's legacy append changed the transcript under this open's hydration snapshot.
		// The open refuses it; a fresh open reads the transcript as it now stands.
		send("open-refused", { error: error instanceof Error ? error.message : String(error) });
		SessionManagerTestHooks.beforeExistingSessionHydration = undefined;
		manager = await SessionManager.open(file, destination);
	}
	send("opened", { logicalId: manager.getSessionId(), leaf: manager.getLeafId(), bytes: await Bun.file(file).text() });
	if (scenario === "finalize") {
		if (worker === "a") {
			await gates.get("finalize")!.promise;
			phase = "finalize";
			const original = manager.captureCommittedSnapshot;
			let held = false;
			manager.captureCommittedSnapshot = async function () {
				const read = await original.call(this);
				if (!held) {
					held = true;
					if (read.kind !== "snapshot") throw new Error(`Unexpected snapshot: ${read.kind}`);
					send("snapshot-observed", { digest: read.snapshot.digest, size: read.snapshot.size });
					await gates.get("snapshot-release")!.promise;
				}
				return read;
			};
			try {
				const outcome = await manager.finalizeWritableOpen();
				send("finalized", { outcome, leaf: manager.getLeafId(), bytes: await Bun.file(file).text() });
			} finally {
				manager.captureCommittedSnapshot = original;
			}
		} else {
			// The peer's own finalization waits for the migrating worker's transaction, then finds
			// the transcript it opened replaced.
			await gates.get("stale-finalize")!.promise;
			phase = "stale-finalize";
			const stale = await manager.finalizeWritableOpen();
			send("stale-finalized", { outcome: stale, leaf: manager.getLeafId(), bytes: await Bun.file(file).text() });
			// Its next legacy append is refused by the expected-identity fence before it writes.
			await gates.get("append")!.promise;
			phase = "append";
			const message = { role: "user" as const, content: "refused legacy append", timestamp: 4 };
			send("refused", {
				outcome: await legacyAppend(manager, message),
				attemptedId: getSessionMessageEntryId(message) ?? null,
				leaf: manager.getLeafId(),
				bytes: await Bun.file(file).text(),
			});
			await gates.get("reopen")!.promise;
			const closed = await manager.closeStrict();
			if (closed.kind !== "closed") throw new Error(`Legacy close failed: ${closed.kind}`);
			manager = undefined;
			send("legacy-closed", { outcome: closed.kind, bytes: await Bun.file(file).text() });
			manager = await SessionManager.open(file, destination);
			const reopened = await manager.finalizeWritableOpen();
			send("reopened", {
				outcome: reopened,
				leaf: manager.getLeafId(),
				logicalId: manager.getSessionId(),
				bytes: await Bun.file(file).text(),
			});
		}
	}
	await gates.get(scenario === "finalize" ? "publish" : "append")!.promise;
	phase = "append";
	send("appending");
	const outcome = await legacyAppend(manager, {
		role: "user",
		content: `branch ${worker}`,
		timestamp: worker === "a" ? 2 : 3,
	});
	send(outcome.kind === "appended" ? "appended" : "append-refused", {
		outcome,
		id: outcome.kind === "appended" ? outcome.id : undefined,
		leaf: manager.getLeafId(),
		logicalId: manager.getSessionId(),
		bytes: await Bun.file(file).text(),
	});
	const closed = await manager.closeStrict();
	if (closed.kind !== "closed") throw new Error(`Final close failed: ${closed.kind}`);
	manager = undefined;
	send("closed", { outcome: closed.kind });
	send("done");
} catch (error) {
	send("error", { error: error instanceof Error ? error.stack : String(error) });
	process.exitCode = 1;
} finally {
	SessionManagerTestHooks.beforeExistingSessionHydration = undefined;
	ManagedLockTestHooks.beforeContentionWait = undefined;
	try {
		if (manager) {
			const closed = await manager.closeStrict();
			if (closed.kind !== "closed") {
				send("error", { error: `Cleanup close failed: ${closed.kind}` });
				process.exitCode = 1;
			}
		}
	} catch (error) {
		send("error", { error: String(error) });
		process.exitCode = 1;
	}
	clearTimeout(deadline);
	process.disconnect?.();
}
