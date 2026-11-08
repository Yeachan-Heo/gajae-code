import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ManagedPreparedFileRemovalError,
	ManagedSessionDescendantStore,
	type ManagedTreeRemovalOutcome,
	ManagedTreeRemovalTestHooks,
	managedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";

const roots: string[] = [];
const stores: ManagedSessionDescendantStore[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	delete ManagedTreeRemovalTestHooks.afterPreparedFileRemoval;
	for (const store of stores.splice(0).reverse()) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(route: "direct" | "child" | "nested" | "direct-descendant" = "direct") {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-recovery-namespace-")));
	roots.push(root);
	fs.chmodSync(root, 0o700);
	let store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
	stores.push(store);
	if (route === "direct-descendant") {
		const directory = path.join(root, "direct");
		fs.mkdirSync(directory, { mode: 0o700 });
		store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), directory);
		stores.push(store);
	} else if (route !== "direct") {
		store = store.deriveSubtree("child");
		stores.push(store);
		if (route === "nested") {
			store = store.deriveSubtree("nested");
			stores.push(store);
		}
	}
	const pathname = path.join(store.dir, "transcript");
	await Bun.write(pathname, "original retained bytes");
	fs.chmodSync(pathname, 0o600);
	const snapshot = store.readExpected("transcript");
	if (!snapshot) throw new Error("missing fixture snapshot");
	return { root, store, pathname, snapshot };
}

describe.skipIf(process.platform !== "linux")("prepared recovery namespace", () => {
	for (const route of ["direct", "child", "nested", "direct-descendant"] as const) {
		it(`reads the actual ${route} authority location after close`, async () => {
			const f = await fixture(route);
			const result = f.store.removeExpectedForPreparedDiscard("transcript", f.snapshot);
			expect(result.kind).toBe("detached_retained");
			expect(result.physicalCleanup).toBe("pending");
			if (result.outcome.route !== "retained") throw new Error("expected retained proof");
			const proof = result.outcome.result;
			const retained = result.retainedNamespaces[0]!;
			expect(retained).toBe(proof.recoveryPhysicalPath!);
			expect(path.dirname(retained)).toBe(
				path.join(route === "direct-descendant" ? f.store.dir : f.root, ".gjc-recovery"),
			);
			expect(fs.lstatSync(path.dirname(retained), { bigint: true }).ino.toString()).toBe(
				proof.recoveryNamespaceIdentity!.ino,
			);
			expect(fs.lstatSync(retained, { bigint: true }).ino).toBe(f.snapshot.identity.ino);
			expect(fs.existsSync(f.pathname)).toBe(false);
			for (const store of stores) store.close();
			expect(await Bun.file(retained).text()).toBe(f.snapshot.bytes.toString());
			expect(fs.lstatSync(retained, { bigint: true }).ino).toBe(f.snapshot.identity.ino);
		});
	}

	for (const attack of [
		"absent-location",
		"absent-namespace",
		"wrong-namespace",
		"wrong-inode",
		"hardlink",
		"symlink",
		"namespace-rebound",
		"namespace-symlink",
		"same-size-modified",
		"insecure-file",
		"insecure-namespace",
		"noncanonical",
		"wrong-basename",
		"nonexistent",
	] as const) {
		it(`preserves native failure evidence for ${attack}`, async () => {
			const f = await fixture("nested");
			let observed: ManagedTreeRemovalOutcome | undefined;
			let actual = "";
			ManagedTreeRemovalTestHooks.afterPreparedFileRemoval = (_target, outcome) => {
				observed = outcome;
				if (outcome.route !== "retained") throw new Error("expected retained route");
				const result = outcome.result;
				actual = result.recoveryPhysicalPath!;
				if (!actual || !result.recoveryNamespaceIdentity) throw new Error("missing native prerequisite");
				const directory = path.dirname(actual);
				switch (attack) {
					case "absent-location":
						result.recoveryPhysicalPath = undefined;
						break;
					case "absent-namespace":
						result.recoveryNamespaceIdentity = undefined;
						break;
					case "wrong-namespace":
						result.recoveryNamespaceIdentity.ino = "0";
						break;
					case "wrong-inode":
						fs.renameSync(actual, `${actual}.saved`);
						fs.copyFileSync(`${actual}.saved`, actual);
						fs.chmodSync(actual, 0o600);
						break;
					case "hardlink":
						fs.linkSync(actual, path.join(f.root, "extra-link"));
						break;
					case "symlink":
						fs.renameSync(actual, `${actual}.saved`);
						fs.symlinkSync(`${actual}.saved`, actual);
						break;
					case "namespace-rebound":
						fs.renameSync(directory, `${directory}.saved`);
						fs.mkdirSync(directory, { mode: 0o700 });
						fs.copyFileSync(path.join(`${directory}.saved`, path.basename(actual)), actual);
						fs.chmodSync(actual, 0o600);
						break;
					case "namespace-symlink":
						fs.renameSync(directory, `${directory}.saved`);
						fs.symlinkSync(`${directory}.saved`, directory);
						break;
					case "same-size-modified": {
						const fd = fs.openSync(actual, fs.constants.O_WRONLY);
						try {
							fs.writeSync(fd, Buffer.alloc(f.snapshot.bytes.length, 120), 0, f.snapshot.bytes.length, 0);
						} finally {
							fs.closeSync(fd);
						}
						break;
					}
					case "insecure-file":
						fs.chmodSync(actual, 0o644);
						break;
					case "insecure-namespace":
						fs.chmodSync(directory, 0o755);
						break;
					case "noncanonical":
						result.recoveryPhysicalPath = `${directory}/../.gjc-recovery/${path.basename(actual)}`;
						break;
					case "wrong-basename":
						result.recoveryPhysicalPath = `${actual}-0`;
						break;
					case "nonexistent":
						fs.renameSync(actual, `${actual}.saved`);
						break;
				}
			};
			let failure: unknown;
			try {
				f.store.removeExpectedForPreparedDiscard("transcript", f.snapshot);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(ManagedPreparedFileRemovalError);
			if (!(failure instanceof ManagedPreparedFileRemovalError)) throw failure;
			expect(failure.outcome).toBe(observed);
			expect(actual).not.toBe("");
			expect(fs.existsSync(f.pathname)).toBe(false);
		});
	}
});
