import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { containPath, pinMemoryRoot } from "../../src/policy/path-safety";
import { openVerifiedFile, publishVerified, VerifiedStorageError } from "../../src/storage/verified-open";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "gajae-memory-core-verified-")));
	temporaryRoots.push(root);
	await fsp.chmod(root, 0o700);
	return root;
}

function requireRootPin(root: string) {
	const pinned = pinMemoryRoot(root);
	if (!pinned.ok) throw new Error(`test root could not be pinned: ${JSON.stringify(pinned.error)}`);
	return pinned.value;
}

function expectTypedFailure(action: () => unknown): VerifiedStorageError {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(VerifiedStorageError);
	if (!(thrown instanceof VerifiedStorageError)) throw new Error("expected a typed verified-storage failure");
	expect(thrown.code).toBe("policy-denied");
	expect(thrown.exitCode).toBe(6);
	return thrown;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })));
});

describe("verified memory filesystem I/O", () => {
	it.skipIf(process.platform === "win32")("does not disclose bytes before path verification", async () => {
		const root = await makeRoot();
		const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "gajae-memory-core-secret-"));
		temporaryRoots.push(outside);
		const outsideFile = path.join(outside, "secret.md");
		await fsp.writeFile(outsideFile, "UNVERIFIED-SECRET-MATERIAL");
		await fsp.symlink(outsideFile, path.join(root, "alias.md"), "file");

		const readSyncSpy = spyOn(fs, "readSync");
		const readFileSyncSpy = spyOn(fs, "readFileSync");
		try {
			const failure = expectTypedFailure(() => openVerifiedFile(requireRootPin(root), "alias.md"));
			expect(failure.relPath).toBe("alias.md");
			expect(readSyncSpy).not.toHaveBeenCalled();
			expect(readFileSyncSpy).not.toHaveBeenCalled();
			expect(JSON.stringify(failure)).not.toContain("UNVERIFIED-SECRET-MATERIAL");
		} finally {
			readSyncSpy.mockRestore();
			readFileSyncSpy.mockRestore();
		}
	});

	it("creates an exclusive mode-0600 temporary and verifies the published binding", async () => {
		const root = await makeRoot();
		const target = path.join(root, "draft.md");
		const payload = "verified payload";
		const observedTemporaryNames: string[] = [];
		let afterAuthorizationCalls = 0;

		const receipt = publishVerified(requireRootPin(root), "draft.md", payload, {
			beforeRename() {
				const temporaryName = fs
					.readdirSync(root)
					.find(name => name.startsWith(".draft.md.") && name.endsWith(".tmp"));
				expect(temporaryName).toBeDefined();
				if (temporaryName === undefined) return;
				observedTemporaryNames.push(temporaryName);
				const temporaryPath = path.join(root, temporaryName);
				const temporaryStat = fs.lstatSync(temporaryPath);
				expect(temporaryStat.isFile()).toBe(true);
				expect(temporaryStat.nlink).toBe(1);
				expect(temporaryStat.mode & 0o777).toBe(0o600);
				expect(fs.readFileSync(temporaryPath, "utf8")).toBe(payload);
			},
			afterAuthorization() {
				afterAuthorizationCalls += 1;
			},
		});

		expect(observedTemporaryNames).toHaveLength(1);
		expect(afterAuthorizationCalls).toBe(1);
		expect(receipt).toMatchObject({
			relPath: "draft.md",
			target,
			changed: true,
			bytesWritten: Buffer.byteLength(payload),
			digest: createHash("sha256").update(payload).digest("hex"),
			sha256: createHash("sha256").update(payload).digest("hex"),
		});
		expect(await fsp.readFile(target, "utf8")).toBe(payload);
		expect(fs.readdirSync(root).some(name => name.endsWith(".tmp"))).toBe(false);

		const rebound = containPath(requireRootPin(root), "draft.md");
		expect(rebound.ok).toBe(true);
		if (!rebound.ok || rebound.value.leafIdentity === null) return;
		expect(openVerifiedFile(requireRootPin(root), "draft.md", "utf8")).toBe(payload);
	});

	it("rejects a leaf replacement after authorization without clobbering the replacement", async () => {
		const root = await makeRoot();
		const target = path.join(root, "state.md");
		await fsp.writeFile(target, "authorized preimage");

		const failure = expectTypedFailure(() =>
			publishVerified(requireRootPin(root), "state.md", "new bytes", {
				beforeRename() {
					fs.rmSync(target);
					fs.writeFileSync(target, "replacement leaf");
				},
			}),
		);
		expect(failure.relPath).toBe("state.md");
		expect(failure.reason).toContain("identity changed");
		expect(await fsp.readFile(target, "utf8")).toBe("replacement leaf");
	});

	it.skipIf(process.platform === "win32")(
		"rejects a target symlink replacement after authorization without touching its target",
		async () => {
			const root = await makeRoot();
			const target = path.join(root, "state.md");
			const outside = path.join(root, "outside.md");
			await fsp.writeFile(target, "authorized preimage");
			await fsp.writeFile(outside, "outside remains unchanged");

			const failure = expectTypedFailure(() =>
				publishVerified(requireRootPin(root), "state.md", "new bytes", {
					beforeRename() {
						fs.rmSync(target);
						fs.symlinkSync(outside, target, "file");
					},
				}),
			);
			expect(failure.relPath).toBe("state.md");
			expect(failure.reason).toContain("destination leaf is not bound");
			expect(await fsp.readFile(outside, "utf8")).toBe("outside remains unchanged");
			expect((await fsp.lstat(target)).isSymbolicLink()).toBe(true);
		},
	);

	it.skipIf(process.platform === "win32")(
		"rejects the moved-parent plus symlink post-authorization scenario and never reports verified success",
		async () => {
			const root = await makeRoot();
			const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "gajae-memory-core-verified-outside-"));
			temporaryRoots.push(outside);
			const parent = path.join(root, "managed");
			const movedParent = path.join(outside, "managed");
			const target = path.join(parent, "state.md");
			const movedTarget = path.join(movedParent, "state.md");
			await fsp.mkdir(parent, { mode: 0o700 });
			await fsp.writeFile(target, "authorized preimage");

			const failure = expectTypedFailure(() =>
				publishVerified(requireRootPin(root), "managed/state.md", "new bytes", {
					afterAuthorization() {
						fs.renameSync(parent, movedParent);
						fs.symlinkSync(movedParent, parent, "dir");
					},
				}),
			);
			expect(failure.relPath).toBe("managed/state.md");
			expect((await fsp.lstat(parent)).isSymbolicLink()).toBe(true);
			expect(await fsp.readFile(movedTarget, "utf8")).toBe("new bytes");

			// The pathname rename can escape before the post-operation binding check;
			// this test only requires that the escape is detected before success is reported.
		},
	);

	it("maps a missing verified file to a typed, destination-scoped failure", async () => {
		const root = await makeRoot();
		const failure = expectTypedFailure(() => openVerifiedFile(requireRootPin(root), "missing.md"));
		expect(failure).toMatchObject({
			code: "policy-denied",
			exitCode: 6,
			destination: "global-canonical",
			relPath: "missing.md",
			reason: "verified file does not exist",
		});
	});
});
