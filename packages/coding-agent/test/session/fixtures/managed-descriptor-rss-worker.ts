import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../../src/session/internal/managed-session-storage";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-descriptor-rss-")));
const transcript = path.join(root, "session.jsonl");
const chunk = Buffer.alloc(1024 * 1024, 0x78);
let fd: number | undefined;
let store: ManagedSessionDescendantStore | undefined;
try {
	fd = fs.openSync(transcript, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	for (let index = 0; index < 128; index++) fs.writeSync(fd, chunk);
	fs.fsyncSync(fd);
	fs.closeSync(fd);
	fd = undefined;
	store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
	Bun.gc(true);
	const before = process.memoryUsage();
	const descriptor = store.descriptorExpected("session.jsonl");
	Bun.gc(true);
	const after = process.memoryUsage();
	if (!descriptor) throw new Error("Managed descriptor is unavailable");
	process.stdout.write(
		JSON.stringify({
			sourceBytes: descriptor.size,
			rssGrowthBytes: Math.max(0, after.rss - before.rss),
			externalGrowthBytes: Math.max(0, after.external - before.external),
		}),
	);
} finally {
	if (fd !== undefined) fs.closeSync(fd);
	store?.close();
	fs.rmSync(root, { recursive: true, force: true });
}
