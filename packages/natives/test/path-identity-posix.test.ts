import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	applyOwnerOnlyPathSecurity,
	canonicalExistingDirectoryIdentity,
	exactRemoveDirectoryTree,
	exactRestore,
	exactUnlink,
	snapshotDirectoryTree,
	verifyOwnerOnlyPathSecurity,
} from "../native/index.js";

const temporaryDirectories: string[] = [];

function sha256(contents: string): string {
	return createHash("sha256").update(contents).digest("hex");
}

function treeQuarantineName(entry: { relativePath: string; dev: string; ino: string }): string {
	const material = Buffer.concat([
		Buffer.from(entry.relativePath),
		Buffer.from([0]),
		Buffer.from(entry.dev),
		Buffer.from([0]),
		Buffer.from(entry.ino),
	]);
	return `.pi-tree-detached-${createHash("sha256").update(material).digest("hex")}`;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe.skipIf(process.platform === "win32")("POSIX native path identity", () => {
	it("rejects an existing directory whose canonical byte path is not UTF-8", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const nonUtf8Path = Buffer.concat([Buffer.from(`${root}${path.sep}`), Buffer.from([0x66, 0x80])]);
		await fs.mkdir(nonUtf8Path);

		expect(canonicalExistingDirectoryIdentity(nonUtf8Path)).toEqual({ ok: false, code: "not_utf8" });
	});

	it("classifies group-readable files as failing owner-only verification", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const file = path.join(root, "state.json");
		await fs.writeFile(file, "{}", { mode: 0o644 });
		await fs.chmod(file, 0o640);

		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "acl_verify_failed" });
	});

	it("applies and verifies exact owner-only modes without changing regular-file bytes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const directory = path.join(root, "managed");
		const file = path.join(directory, "state.json");
		const contents = '{"preserve":"payload"}';
		await fs.mkdir(directory, { mode: 0o755 });
		await fs.writeFile(file, contents, { mode: 0o644 });

		expect(applyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(applyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});

	it.skipIf(process.platform !== "darwin")("uses native ACL APIs for owner-only access", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const file = path.join(root, "state.json");
		await fs.writeFile(file, "{}", { mode: 0o644 });

		expect(applyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
	});

	it("rejects an unauthorized exact-unlink identity without deleting a replacement", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const file = path.join(root, "replacement.jsonl");
		await fs.writeFile(file, "replacement");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlink(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size + 1n,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("replacement"),
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(file, "utf8")).toBe("replacement");
	});

	it("retains a same-object content mutation when its authorized digest is stale", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const file = path.join(root, "state.jsonl");
		await fs.writeFile(file, "original");
		const authorizedDigest = sha256("original");
		await fs.writeFile(file, "mutated!");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlink(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: authorizedDigest,
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(file, "utf8")).toBe("mutated!");
	});

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"detaches an identity-bound directory to the preauthorized durable destination",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const directory = path.join(root, "artifact");
			const child = path.join(directory, "state.json");
			const quarantineName = ".gjc-delete-preauthorized";
			await fs.mkdir(directory);
			await fs.writeFile(child, "preserve");
			const stat = await fs.stat(directory, { bigint: true });

			const result = exactUnlink(directory, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				directory: true,
				quarantineName,
			});
			expect(result).toEqual({ ok: true, detachedPath: path.join(root, quarantineName) });
			expect(
				await fs.stat(directory).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(await fs.readFile(path.join(result.detachedPath!, "state.json"), "utf8")).toBe("preserve");
		},
	);
	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"keeps the detached authority when post-detach full-file digest verification succeeds",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const original = path.join(root, "state.jsonl");
			const detached = path.join(root, ".gjc-delete-state");
			const contents = "x".repeat(128 * 1024);
			await fs.writeFile(original, contents);
			const stat = await fs.stat(original, { bigint: true });

			expect(
				exactUnlink(original, {
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeNs: stat.mtimeNs,
					sha256: sha256(contents),
					quarantineName: path.basename(detached),
					detachOnly: true,
				}),
			).toEqual({ ok: true, detachedPath: detached });
			expect(await fs.readFile(detached, "utf8")).toBe(contents);
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"refuses a preauthorized quarantine collision without replacing either directory",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const directory = path.join(root, "artifact");
			const quarantine = path.join(root, ".gjc-delete-preauthorized");
			await fs.mkdir(directory);
			await fs.mkdir(quarantine);
			const stat = await fs.stat(directory, { bigint: true });

			expect(
				exactUnlink(directory, {
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeNs: stat.mtimeNs,
					directory: true,
					quarantineName: path.basename(quarantine),
				}),
			).toEqual({ ok: false, code: "quarantine_collision" });
			expect(await fs.stat(directory)).toBeDefined();
			expect(await fs.stat(quarantine)).toBeDefined();
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"restores a detached regular file only when its full identity remains authorized",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const original = path.join(root, "state.jsonl");
			const detached = path.join(root, ".gjc-delete-state");
			await fs.writeFile(original, "authorized");
			const stat = await fs.stat(original, { bigint: true });
			const identity = {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("authorized"),
				quarantineName: path.basename(detached),
				detachOnly: true,
			};

			expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
			expect(exactRestore(detached, original, identity)).toEqual({ ok: true });
			expect(await fs.readFile(original, "utf8")).toBe("authorized");
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"refuses exact restore collisions without clobbering the retained detached file",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const original = path.join(root, "state.jsonl");
			const detached = path.join(root, ".gjc-delete-state");
			await fs.writeFile(original, "authorized");
			const stat = await fs.stat(original, { bigint: true });
			const identity = {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("authorized"),
				quarantineName: path.basename(detached),
				detachOnly: true,
			};

			expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
			await fs.writeFile(original, "replacement");
			expect(exactRestore(detached, original, identity)).toEqual({ ok: false, code: "collision" });
			expect(await fs.readFile(original, "utf8")).toBe("replacement");
			expect(await fs.readFile(detached, "utf8")).toBe("authorized");
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"refuses restoring a detached regular-file replacement with a stale digest",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const original = path.join(root, "state.jsonl");
			const detached = path.join(root, ".gjc-delete-state");
			await fs.writeFile(original, "authorized");
			const stat = await fs.stat(original, { bigint: true });
			const identity = {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("authorized"),
				quarantineName: path.basename(detached),
				detachOnly: true,
			};

			expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
			await fs.writeFile(detached, "replacement");
			expect(exactRestore(detached, original, identity)).toEqual({ ok: false, code: "identity_mismatch" });
			expect(await fs.readFile(detached, "utf8")).toBe("replacement");
			expect(
				await fs.stat(original).then(
					() => true,
					() => false,
				),
			).toBe(false);
		},
	);

	it("rejects an ancestor replaced by a symlink after authorization", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const parent = path.join(root, "managed");
		const target = path.join(root, "target");
		const file = path.join(parent, "state.jsonl");
		await fs.mkdir(parent);
		await fs.mkdir(target);
		await fs.writeFile(file, "authorized");
		const stat = await fs.stat(file, { bigint: true });
		await fs.rename(parent, path.join(root, "managed-retained"));
		await fs.symlink(target, parent, "dir");

		expect(
			exactUnlink(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("authorized"),
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(root, "managed-retained", "state.jsonl"), "utf8")).toBe("authorized");
	});

	it("rejects final and ancestor symlinks without changing their targets", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const target = path.join(root, "target");
		const alias = path.join(root, "alias");
		const state = path.join(target, "state.json");
		const stateAlias = path.join(root, "state-alias.json");
		await fs.mkdir(target, { mode: 0o755 });
		await fs.chmod(target, 0o755);
		await fs.writeFile(state, "{}", { mode: 0o644 });
		await fs.chmod(state, 0o644);
		await fs.symlink(target, alias, "dir");
		await fs.symlink(state, stateAlias, "file");

		expect(verifyOwnerOnlyPathSecurity(alias, "directory")).toEqual({ ok: false, code: "reparse_point" });
		expect(applyOwnerOnlyPathSecurity(alias, "directory")).toEqual({ ok: false, code: "reparse_point" });
		expect(verifyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual({
			ok: false,
			code: "reparse_point",
		});
		expect(applyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual({
			ok: false,
			code: "reparse_point",
		});
		expect(verifyOwnerOnlyPathSecurity(stateAlias, "file")).toEqual({ ok: false, code: "reparse_point" });
		expect(applyOwnerOnlyPathSecurity(stateAlias, "file")).toEqual({ ok: false, code: "reparse_point" });
		expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
		expect((await fs.stat(state)).mode & 0o777).toBe(0o644);
	});
	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"retains the caller-planned root after a tree snapshot failure",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const detached = path.join(root, ".gjc-delete-planned");
			const originalFile = path.join(detached, "nested", "state.json");
			const preservedFile = path.join(detached, "nested", "authorized-before-swap.json");
			await fs.mkdir(path.join(detached, "nested", "child"), { recursive: true });
			await fs.writeFile(originalFile, "authorized");
			await fs.writeFile(path.join(detached, "nested", "child", "state.json"), "authorized-child");
			const snapshot = snapshotDirectoryTree(detached);
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok || !snapshot.snapshot) throw new Error("missing tree snapshot");

			await fs.rename(originalFile, preservedFile);
			await fs.writeFile(originalFile, "substituted");
			await fs.rm(path.join(detached, "nested", "child"), { recursive: true });
			await fs.mkdir(path.join(detached, "nested", "child"));
			await fs.writeFile(path.join(detached, "nested", "child", "state.json"), "substituted-child");
			const result = exactRemoveDirectoryTree(detached, snapshot.snapshot);
			expect(result).toEqual({
				ok: false,
				code: "identity_mismatch",
				detachedPath: detached,
			});
			expect(result.detachedPath).toBe(detached);
			const retainedContents = await Promise.all(
				(await fs.readdir(detached, { recursive: true })).map(async relative => {
					const pathname = path.join(detached, relative);
					return (await fs.stat(pathname)).isFile() ? await fs.readFile(pathname, "utf8") : undefined;
				}),
			);
			expect(retainedContents).toContain("substituted");
			expect(retainedContents).toContain("authorized");
			expect(retainedContents).toContain("substituted-child");
		},
	);
	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"validates all nested siblings before quarantining an earlier sibling",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const detached = path.join(root, ".gjc-delete-planned");
			const earlier = path.join(detached, "a-earlier.jsonl");
			const later = path.join(detached, "nested", "z-later.jsonl");
			await fs.mkdir(path.dirname(later), { recursive: true });
			await fs.writeFile(earlier, "authorized-earlier");
			await fs.writeFile(later, "authorized-later");
			const snapshot = snapshotDirectoryTree(detached);
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok || !snapshot.snapshot) throw new Error("missing tree snapshot");

			await fs.rm(later);
			await fs.writeFile(later, "substituted-later");

			expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({
				ok: false,
				code: "identity_mismatch",
				detachedPath: detached,
			});
			expect(await fs.readFile(earlier, "utf8")).toBe("authorized-earlier");
			expect(await fs.readFile(later, "utf8")).toBe("substituted-later");
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"replays a prior child-removal prefix against the original durable snapshot",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const detached = path.join(root, ".gjc-delete-planned");
			const nested = path.join(detached, "nested");
			const first = path.join(nested, "a-first.jsonl");
			await fs.mkdir(nested, { recursive: true });
			await fs.writeFile(first, "first");
			await fs.writeFile(path.join(nested, "z-later.jsonl"), "later");
			await fs.writeFile(path.join(detached, "root.jsonl"), "root");
			const snapshot = snapshotDirectoryTree(detached);
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok || !snapshot.snapshot) throw new Error("missing tree snapshot");

			await fs.rm(first);
			expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
			expect(
				await fs.stat(detached).then(
					() => true,
					() => false,
				),
			).toBe(false);
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"rejects a child that collides with a persisted quarantine hash",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const detached = path.join(root, ".gjc-delete-planned");
			const child = path.join(detached, "state.jsonl");
			await fs.mkdir(detached);
			await fs.writeFile(child, "authorized");
			const snapshot = snapshotDirectoryTree(detached);
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok || !snapshot.snapshot) throw new Error("missing tree snapshot");
			const entry = snapshot.snapshot.entries.find(value => value.relativePath === "state.jsonl");
			if (!entry) throw new Error("missing state entry");
			const collision = path.join(detached, treeQuarantineName(entry));
			await fs.writeFile(collision, "replacement");
			expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({
				ok: false,
				code: "identity_mismatch",
				detachedPath: detached,
			});
			expect(await fs.readFile(collision, "utf8")).toBe("replacement");
			expect(await fs.readFile(child, "utf8")).toBe("authorized");
		},
	);
	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"replays a near-NAME_MAX child through its bounded deterministic quarantine name",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const detached = path.join(root, ".gjc-delete-planned");
			const childName = "x".repeat(255);
			const child = path.join(detached, childName);
			await fs.mkdir(detached);
			await fs.writeFile(child, "authorized");
			const snapshot = snapshotDirectoryTree(detached);
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok || !snapshot.snapshot) throw new Error("missing tree snapshot");
			const entry = snapshot.snapshot.entries.find(value => value.relativePath === childName);
			if (!entry) throw new Error("missing near-NAME_MAX entry");
			const quarantine = treeQuarantineName(entry);
			expect(Buffer.byteLength(quarantine)).toBeLessThanOrEqual(255);
			await fs.rename(child, path.join(detached, quarantine));
			expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
		},
	);
	it.skipIf(process.platform !== "darwin")(
		"detects and repairs an adversarial extended ACL without changing bytes",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const file = path.join(root, "state.json");
			await fs.writeFile(file, '{"preserve":true}', { mode: 0o600 });
			const acl = Bun.spawnSync(["chmod", "+a", "everyone deny read", file]);
			if (acl.exitCode !== 0) throw new Error("failed to install Darwin ACL fixture");
			expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "acl_verify_failed" });
			expect(applyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
			expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
			expect(await fs.readFile(file, "utf8")).toBe('{"preserve":true}');
		},
	);
});
