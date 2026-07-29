/**
 * Child-process probe for resident-cache sweeping. Creates an EphemeralBlobStore
 * exactly the way SessionManager does, writes a blob into it, then either
 * disposes cleanly or waits to be signalled.
 *
 * Usage: bun run resident-cache-probe.ts <dir> <close|abort>
 */
import { EphemeralBlobStore } from "../../src/session/blob-store";

const [, , dir, mode] = process.argv;
if (!dir || (mode !== "close" && mode !== "abort")) {
	console.error("usage: resident-cache-probe.ts <dir> <close|abort>");
	process.exit(2);
}

const store = new EphemeralBlobStore(dir);
// Large enough that a leak is unmistakable on disk.
store.putSync(Buffer.alloc(8 * 1024 * 1024, 0x61));

if (mode === "close") {
	store.dispose();
	console.log("disposed");
	process.exit(0);
}

console.log("ready");
setInterval(() => {}, 1000);
