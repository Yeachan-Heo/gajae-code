import * as crypto from "node:crypto";
import { SessionManager } from "../../src/session/session-manager";

const [worker, cwd, agentDir, file] = process.argv.slice(2);
if (!worker || !cwd || !agentDir || !file || !process.send) throw new Error("Expected isolated IPC worker arguments");
const gates = new Map<string, PromiseWithResolvers<void>>();
for (const name of ["save", "release-claim", "read-before", "read-after", "close", "exit"])
	gates.set(name, Promise.withResolvers<void>());
process.on("message", (message: unknown) => {
	gates.get((message as { gate: string }).gate)?.resolve();
});
const send = (event: string, detail: Record<string, unknown> = {}) => process.send!({ worker, event, ...detail });
const deadline = setTimeout(() => {
	send("error", { error: "Worker deadline exceeded" });
	process.exit(1);
}, 25_000);
let manager: SessionManager | undefined;
let restore: (() => void) | undefined;
try {
	manager = await SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
	const artifacts = await manager.ensureArtifactManager();
	const store = artifacts?.getManagedStore();
	if (!artifacts || !store) throw new Error("Expected retained managed artifact store");
	const read = (event: string, ids: string[]) => {
		const files = ids.map(id => {
			const name = `${id}.ownership.log`;
			const snapshot = store.readExpected(name);
			if (!snapshot) throw new Error(`Missing retained artifact ${name}`);
			return {
				name,
				text: snapshot.bytes.toString("utf8"),
				digest: crypto.createHash("sha256").update(snapshot.bytes).digest("hex"),
			};
		});
		send(event, { files });
	};
	if (worker === "b") {
		const original = store.publishNoReplace;
		let held = false;
		store.publishNoReplace = async function (relativePath, bytes) {
			send("claim-call", { name: relativePath, size: bytes.byteLength });
			if (relativePath === ".artifact-id-0" && !held) {
				held = true;
				send("claim-ready", { name: relativePath, size: bytes.byteLength });
				await gates.get("release-claim")!.promise;
			}
			try {
				const result = await original.call(this, relativePath, bytes);
				send("claim-success", { name: relativePath });
				return result;
			} catch (error) {
				send("claim-conflict", {
					name: relativePath,
					message: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		};
		restore = () => {
			store.publishNoReplace = original;
		};
	}
	send("opened", { pid: process.pid, logicalId: manager.getSessionId(), dir: artifacts.dir });
	await gates.get("save")!.promise;
	const content = worker === "a" ? `payload-A-${"a".repeat(65536)}` : `payload-B-${"b".repeat(65536)}`;
	const id = await manager.saveArtifact(content, "ownership");
	send("saved", { id });
	if (worker === "b") {
		await gates.get("read-before")!.promise;
		read("read-before", ["0", "1"]);
		await gates.get("read-after")!.promise;
		read("read-after", ["0", "1"]);
		const third = await manager.saveArtifact(`payload-C-${"c".repeat(65536)}`, "ownership");
		send("continued", { id: third });
		read("read-three", ["0", "1", "2"]);
	}
	await gates.get("close")!.promise;
	restore?.();
	restore = undefined;
	const closed = await manager.closeStrict();
	if (closed.kind !== "closed") throw new Error(`Strict close failed: ${closed.kind}`);
	manager = undefined;
	send("closed", { outcome: closed.kind });
	await gates.get("exit")!.promise;
	send("done");
} catch (error) {
	send("error", { error: error instanceof Error ? error.stack : String(error) });
	process.exitCode = 1;
} finally {
	restore?.();
	try {
		if (manager) {
			const closed = await manager.closeStrict();
			if (closed.kind !== "closed") {
				send("error", { error: `Cleanup close failed: ${closed.kind}` });
				process.exitCode = 1;
			}
		}
	} catch (error) {
		send("error", { error: `Cleanup: ${String(error)}` });
		process.exitCode = 1;
	}
	clearTimeout(deadline);
	process.disconnect?.();
}
