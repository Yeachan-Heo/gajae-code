/**
 * Pins the no-authority nested-read contract of
 * `ManagedSessionDescendantStore.readExpected`.
 *
 * History: the deny-guard `#assertPathBackedReadRelative` was added to
 * `readExpected` by 8cc57de1fa, removed in favor of the per-component
 * `#assertPathBackedDirectoryChain` walk by #4188 (79e4e0a097), then
 * re-added by the drive-by 23261d448f — breaking every nested managed read
 * (fork artifact copy, moveTo topology, session-import verification) on
 * Darwin, where retained descriptor authority does not exist. Ubuntu-only CI
 * cannot catch a fourth flip: on Linux the constructor always retains root
 * authority (crates/pi-natives RecoveryFsRoot is Linux-only), so the guard
 * never fires there. These tests spoof the Darwin authority absence on every
 * platform so the restored contract stays pinned where CI runs.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

/**
 * Builds a store whose constructor observed a non-Linux platform, so it holds
 * no retained root authority — the Darwin condition on every CI runner is
 * spoofable only in this direction (Linux authority can be withheld, never
 * granted on Darwin). The spoof covers construction only, matching the
 * established pattern in managed-append-darwin-ctime.test.ts.
 */
function createStoreWithoutAuthority(): { store: ManagedSessionDescendantStore; baseDir: string } {
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-nested-read-pin-"));
	temporaryDirectories.push(baseDir);
	fs.chmodSync(baseDir, 0o700);
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	let store: ManagedSessionDescendantStore;
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		store = new ManagedSessionDescendantStore(managedDirectoryRoot(baseDir), baseDir);
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
	return { store, baseDir };
}

/** Publishes nested bytes with the real platform active (publishing is not under test). */
function publishNested(store: ManagedSessionDescendantStore, relativePath: string, text: string): Uint8Array {
	const bytes = Buffer.from(text, "utf8");
	store.publishNoReplaceSync(relativePath, bytes);
	return bytes;
}

describe("ManagedSessionDescendantStore.readExpected nested reads without retained authority", () => {
	it("returns exact nested bytes and identity instead of managed_nested_path_unsupported", () => {
		const { store } = createStoreWithoutAuthority();
		const text = '{"type":"session","id":"nested-read-pin"}\n';
		publishNested(store, "artifacts/kept.txt", text);

		const snapshot = store.readExpected("artifacts/kept.txt");

		expect(snapshot).not.toBeNull();
		expect(snapshot?.bytes.toString("utf8")).toBe(text);
		const onDisk = fs.readFileSync(path.join(store.dir, "artifacts", "kept.txt"));
		expect(snapshot?.identity.sha256).toBe(new Bun.CryptoHasher("sha256").update(onDisk).digest("hex"));
	});

	it("returns null for a missing nested leaf without throwing", () => {
		const { store } = createStoreWithoutAuthority();
		publishNested(store, "artifacts/kept.txt", "present");

		expect(store.readExpected("artifacts/missing.txt")).toBeNull();
	});

	it("still rejects a symlinked intermediate directory via the per-component chain walk", async () => {
		const { store, baseDir } = createStoreWithoutAuthority();
		publishNested(store, "artifacts/kept.txt", "present");
		const outside = path.join(baseDir, "outside");
		fs.mkdirSync(outside, { mode: 0o700 });
		fs.writeFileSync(path.join(outside, "escape.txt"), "attacker");
		fs.rmSync(path.join(store.dir, "artifacts"), { recursive: true });
		fs.symlinkSync(outside, path.join(store.dir, "artifacts"));

		expect(() => store.readExpected("artifacts/escape.txt")).toThrow();
	});
});
