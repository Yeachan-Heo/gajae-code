import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	ManagedPreparedFileRemovalError,
	ManagedSessionDescendantStore,
	type ManagedTreeRemovalOutcome,
	ManagedTreeRemovalTestHooks,
	managedDirectoryRoot,
	managedSecurityFailureClassification,
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
	it("rejects a FIFO substituted at the first retained security open without blocking", async () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-recovery-fifo-")));
		fs.chmodSync(root, 0o700);
		roots.push(root);
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dirname, "fixtures/managed-recovery-fifo-probe.ts"), root],
			{
				stdout: "pipe",
				stderr: "pipe",
				timeout: 10_000,
				killSignal: "SIGKILL",
			},
		);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		try {
			const [exitCode, output, errors] = await Promise.all([child.exited, stdout, stderr]);
			expect({ exitCode, errors, signal: child.signalCode }).toEqual({ exitCode: 0, errors: "", signal: null });
			expect(JSON.parse(output)).toEqual({
				typedFailure: true,
				phase: "post_effect_authority_check",
				cause: "managed_recovery_security_identity_changed",
				outcomePreserved: true,
				substitutions: 1,
				firstOpenWasOriginal: true,
				fifoRetained: true,
				backupIdentityPreserved: true,
				backupBytesPreserved: true,
				transcriptAbsent: true,
				fdClosed: true,
				successReceipt: false,
			});
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
			await Promise.allSettled([stdout, stderr]);
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

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

	for (const kind of ["directory", "file"] as const) {
		for (const evidence of ["unsupported", "malformed"] as const) {
			it(`rejects ${evidence} ${kind} security evidence without mutation`, async () => {
				const f = await fixture("nested");
				let actual = "";
				let observed: ManagedTreeRemovalOutcome | undefined;
				let fileBefore: fs.BigIntStats | undefined;
				let directoryBefore: fs.BigIntStats | undefined;
				let checkedFd: number | undefined;
				const verify = native.verifyOwnerOnlyFdSecurity;
				ManagedTreeRemovalTestHooks.afterPreparedFileRemoval = (_target, outcome) => {
					observed = outcome;
					if (outcome.route !== "retained") throw new Error("expected retained route");
					actual = outcome.result.recoveryPhysicalPath!;
					fileBefore = fs.lstatSync(actual, { bigint: true });
					directoryBefore = fs.lstatSync(path.dirname(actual), { bigint: true });
					vi.spyOn(native, "verifyOwnerOnlyFdSecurity").mockImplementation((pathname, candidateKind, fd) => {
						if (candidateKind !== kind) return verify(pathname, candidateKind, fd);
						checkedFd = fd;
						return evidence === "unsupported" ? { ok: false, code: "acl_unavailable" } : { ok: true };
					});
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
				if (evidence === "unsupported")
					expect(managedSecurityFailureClassification(failure.cause)).toBe("acl_unavailable");
				else expect((failure.cause as Error).message).toBe("Malformed Linux security success envelope");
				expect(checkedFd).toBeDefined();
				expect(() => fs.fstatSync(checkedFd!)).toThrow();
				for (const store of stores) store.close();
				for (const [pathname, before] of [
					[actual, fileBefore],
					[path.dirname(actual), directoryBefore],
				] as const) {
					const after = fs.lstatSync(pathname, { bigint: true });
					for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const)
						expect(after[field]).toBe(before![field]);
				}
				expect(await Bun.file(actual).text()).toBe(f.snapshot.bytes.toString());
				expect(fs.existsSync(f.pathname)).toBe(false);
			});
		}
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
						if (!result.identity) throw new Error("Expected retained file identity");
						// Reach security verification independently of filesystem ctime granularity.
						result.identity.ctimeNs = fs.statSync(actual, { bigint: true }).ctimeNs.toString();
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
			const cause = failure.cause as NodeJS.ErrnoException;
			switch (attack) {
				case "absent-location":
				case "absent-namespace":
				case "noncanonical":
				case "wrong-basename":
					expect(cause.message).toBe("managed_recovery_location_unproven");
					break;
				case "wrong-namespace":
				case "namespace-rebound":
				case "namespace-symlink":
					expect(cause.message).toBe("managed_recovery_namespace_changed");
					break;
				case "insecure-file":
				case "insecure-namespace":
					expect(managedSecurityFailureClassification(cause)).toBe("mode_mismatch");
					break;
				case "nonexistent":
					expect(cause.code).toBe("ENOENT");
					break;
				default:
					expect(cause.message).toBe("managed_recovery_file_changed");
			}
			expect(actual).not.toBe("");
			if (attack === "insecure-file") {
				expect(fs.statSync(actual).mode & 0o777).toBe(0o644);
				expect(fs.statSync(actual, { bigint: true }).ino).toBe(f.snapshot.identity.ino);
				expect(Buffer.from(await Bun.file(actual).arrayBuffer()).equals(f.snapshot.bytes)).toBe(true);
			}
			expect(fs.existsSync(f.pathname)).toBe(false);
		});
	}
});
