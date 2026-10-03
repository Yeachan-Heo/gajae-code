import { vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ManagedSessionDescendantStore } from "../../src/session/internal/managed-session-storage";
import { SessionManager } from "../../src/session/session-manager";

const input = process.env.GJC_REPLACEMENT_WRITER_INPUT;
if (!input) throw new Error("Missing replacement writer fixture input");
const value: unknown = JSON.parse(input);
if (typeof value !== "object" || value === null) throw new Error("Invalid replacement writer input");
const record = value as Record<string, unknown>;
const { cwd, agentDir, transcript, filename, ready, release } = record;
if (
	typeof cwd !== "string" ||
	typeof agentDir !== "string" ||
	typeof transcript !== "string" ||
	typeof filename !== "string" ||
	typeof ready !== "string" ||
	typeof release !== "string"
)
	throw new Error("Invalid replacement writer paths");
if (path.basename(filename) !== filename) throw new Error("Replacement fixture requires a single owned filename");
const destination = SessionManager.managedDestination(cwd, agentDir);
if (destination.kind !== "managed") throw new Error("Expected managed fixture destination");
const manager = await SessionManager.open(transcript, destination);
const owner = manager.getArtifactManager();
if (!owner) throw new Error("Missing verified fixture owner");
const stat = fs.lstatSync(owner.dir, { bigint: true });
const store = new ManagedSessionDescendantStore(
	destination.securityContext.rootAuthority,
	owner.dir,
	undefined,
	process.platform === "win32" ? "windows-existing-verify-first" : "default",
	agentDir,
	{ canonicalPath: owner.dir, dev: stat.dev, ino: stat.ino },
);
const originalWrite = fs.writeSync;
let held = false;
const write = new Proxy(originalWrite, {
	apply(target, receiver: unknown, args: unknown[]): unknown {
		const fd = args[0];
		if (!held && typeof fd === "number") {
			const descriptor = fs.fstatSync(fd, { bigint: true });
			const replacement = fs.readdirSync(owner.dir).find(name => {
				if (!name.endsWith(".replacement")) return false;
				const named = fs.lstatSync(path.join(owner.dir, name), { bigint: true });
				return named.dev === descriptor.dev && named.ino === descriptor.ino;
			});
			if (replacement) {
				held = true;
				void Bun.write(
					ready,
					JSON.stringify({
						pid: process.pid,
						replacement,
						dev: descriptor.dev.toString(),
						ino: descriptor.ino.toString(),
					}),
				);
				const deadline = Date.now() + 10000;
				const wait = new Int32Array(new SharedArrayBuffer(4));
				while (!fs.existsSync(release)) {
					if (Date.now() > deadline) throw new Error("Replacement writer fixture release timed out");
					Atomics.wait(wait, 0, 0, 10);
				}
			}
		}
		return Reflect.apply(target, receiver, args);
	},
});
const spy = vi.spyOn(fs, "writeSync").mockImplementation(write);
try {
	store.replaceSync(filename, Buffer.from("acknowledged independent replacement payload"));
	if (!held) throw new Error("Replacement descriptor boundary did not execute");
	process.stdout.write(
		JSON.stringify({ kind: "managed-replacement-writer-receipt", pid: process.pid, status: "acknowledged" }),
	);
} finally {
	spy.mockRestore();
	store.close();
	await manager.close();
}
