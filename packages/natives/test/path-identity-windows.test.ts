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
	renameNoReplacePath,
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

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-windows-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe.skipIf(process.platform !== "win32")("Windows native path identity", () => {
	it("rejects final and ancestor reparse points for every owner-only ACL operation", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const alias = path.join(root, "alias");
		const file = path.join(target, "state.json");
		await fs.mkdir(target);
		await fs.writeFile(file, "{}");
		await fs.symlink(target, alias, "junction");

		const rejected = { ok: false, code: "reparse_point" } as const;
		expect(applyOwnerOnlyPathSecurity(alias, "directory")).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurity(alias, "directory")).toEqual(rejected);
		expect(applyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual(rejected);
	});
	it("rejects an ancestor junction inserted after exact identity capture without touching its target", async () => {
		const root = await temporaryDirectory();
		const managed = path.join(root, "managed");
		const relocated = path.join(root, "relocated");
		const file = path.join(managed, "state.jsonl");
		await fs.mkdir(managed);
		await fs.writeFile(file, "authorized");
		const stat = await fs.stat(file, { bigint: true });
		await fs.rename(managed, relocated);
		await fs.symlink(relocated, managed, "junction");

		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
		};
		expect(exactUnlink(file, identity)).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(relocated, "state.jsonl"), "utf8")).toBe("authorized");
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "reparse_point" });
	});
	it("rejects a replaced ancestor junction during exact restore and retains detached content", async () => {
		const root = await temporaryDirectory();
		const managed = path.join(root, "managed");
		const relocated = path.join(root, "relocated");
		const original = path.join(managed, "state.jsonl");
		const detached = path.join(managed, ".gjc-delete-state");
		await fs.mkdir(managed);
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
		await fs.rename(managed, relocated);
		await fs.symlink(relocated, managed, "junction");

		expect(exactRestore(detached, original, identity)).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(relocated, ".gjc-delete-state"), "utf8")).toBe("authorized");
	});

	it("replaces inherited ACLs with a protected owner-only DACL without changing content", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "managed");
		const file = path.join(directory, "state.json");
		const contents = '{"preserve":"payload"}';
		await fs.mkdir(directory);
		await fs.writeFile(file, contents);

		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: false, code: "acl_verify_failed" });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "acl_verify_failed" });
		expect(applyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(applyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});
	it("rejects a contended cross-parent destination without replacing its committed bytes", async () => {
		const root = await temporaryDirectory();
		const staging = path.join(root, "staging");
		const published = path.join(root, "published");
		const source = path.join(staging, "candidate.json");
		const destination = path.join(published, "candidate.json");
		await fs.mkdir(staging);
		await fs.mkdir(published);
		await fs.writeFile(source, "candidate-bytes");
		await fs.writeFile(destination, "committed-bytes");

		expect(renameNoReplacePath(source, destination)).toEqual({
			ok: false,
			code: "quarantine_collision",
		});
		expect(await fs.readFile(destination, "utf8")).toBe("committed-bytes");
		expect(await fs.readFile(source, "utf8")).toBe("candidate-bytes");
	});

	it("does not delete a replacement when exact handle identity differs", async () => {
		const root = await temporaryDirectory();
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
		const root = await temporaryDirectory();
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

	it("atomically detaches only the identified directory to its preauthorized destination", async () => {
		const root = await temporaryDirectory();
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
	});
	it("detaches through the exact FILE_RENAME_INFO trailing-name offset", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "artifact-long-name");
		const quarantineName = `.gjc-${"q".repeat(190)}`;
		await fs.mkdir(directory);
		await fs.writeFile(path.join(directory, "state.json"), "preserve");
		const stat = await fs.stat(directory, { bigint: true });

		expect(
			exactUnlink(directory, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				directory: true,
				quarantineName,
			}),
		).toEqual({ ok: true, detachedPath: path.join(root, quarantineName) });
		expect(await fs.readFile(path.join(root, quarantineName, "state.json"), "utf8")).toBe("preserve");
	});
	it("keeps the detached authority when post-detach full-file digest verification succeeds", async () => {
		const root = await temporaryDirectory();
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
	});

	it("restores a handle-bound detached regular file only when the full identity remains authorized", async () => {
		const root = await temporaryDirectory();
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
	});

	it("refuses a Windows exact-restore collision without clobbering either object", async () => {
		const root = await temporaryDirectory();
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
	});

	it("refuses a detached Windows replacement whose digest no longer matches", async () => {
		const root = await temporaryDirectory();
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
	});

	it("rejects ancestor junction exact deletes without touching their targets", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const junction = path.join(root, "junction");
		const file = path.join(target, "state.json");
		await fs.mkdir(target);
		await fs.writeFile(file, "preserve");
		await fs.symlink(target, junction, "junction");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlink(path.join(junction, "state.json"), {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("preserve"),
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(file, "utf8")).toBe("preserve");
	});

	it("rejects an ancestor replaced by a junction after authorization", async () => {
		const root = await temporaryDirectory();
		const parent = path.join(root, "managed");
		const target = path.join(root, "target");
		const file = path.join(parent, "state.jsonl");
		await fs.mkdir(parent);
		await fs.mkdir(target);
		await fs.writeFile(file, "authorized");
		const stat = await fs.stat(file, { bigint: true });
		await fs.rename(parent, path.join(root, "managed-retained"));
		await fs.symlink(target, parent, "junction");

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

	it("rejects final junction directory detach without touching its target", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const junction = path.join(root, "junction");
		await fs.mkdir(target);
		await fs.writeFile(path.join(target, "state.json"), "preserve");
		await fs.symlink(target, junction, "junction");
		const stat = await fs.stat(target, { bigint: true });

		expect(
			exactUnlink(junction, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				directory: true,
				quarantineName: ".gjc-delete-preauthorized",
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(target, "state.json"), "utf8")).toBe("preserve");
	});

	it("keeps local case aliases classified as the same volume identity", async () => {
		const root = await temporaryDirectory();
		const mixedCase = path.join(root, "MixedCase");
		await fs.mkdir(mixedCase);

		const direct = canonicalExistingDirectoryIdentity(mixedCase);
		const caseAlias = canonicalExistingDirectoryIdentity(path.join(root, "mixedcase"));
		expect(direct.ok).toBe(true);
		expect(caseAlias).toEqual(direct);
	});

	it("classifies UNC paths as unsupported network identities without probing a share", () => {
		expect(canonicalExistingDirectoryIdentity(String.raw`\\server\share\workspace`)).toEqual({
			ok: false,
			code: "network_unsupported",
		});
	});

	it("classifies extended UNC paths as unsupported network identities without probing a share", () => {
		expect(canonicalExistingDirectoryIdentity(String.raw`\\?\UNC\server\share\workspace`)).toEqual({
			ok: false,
			code: "network_unsupported",
		});
	});

	it.skipIf(!process.env.GJC_TEST_SUBST_WORKSPACE)(
		"resolves a configured subst workspace through the local volume",
		() => {
			const substWorkspace = process.env.GJC_TEST_SUBST_WORKSPACE;
			if (!substWorkspace) throw new Error("Missing subst workspace");

			const resolved = canonicalExistingDirectoryIdentity(substWorkspace);
			expect(resolved.ok).toBe(true);
			if (resolved.ok) expect(resolved.canonicalPath).toStartWith("\\\\?\\Volume{");
		},
	);
	it("snapshots and removes nested files and empty directories through retained NT handles", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached");
		await fs.mkdir(path.join(detached, "nested", "empty"), { recursive: true });
		await fs.writeFile(path.join(detached, "nested", "state.jsonl"), "authorized");
		await fs.writeFile(path.join(detached, "root.json"), "root");

		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		expect(snapshot.snapshot.entries.map(entry => entry.relativePath)).toEqual([
			"",
			"nested",
			"nested/empty",
			"nested/state.jsonl",
			"root.json",
		]);
		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
		expect(
			await fs.stat(detached).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("rejects a descendant substitution after snapshot without deleting the replacement", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached");
		const state = path.join(detached, "state.jsonl");
		await fs.mkdir(detached);
		await fs.writeFile(state, "authorized");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		await fs.rm(state);
		await fs.writeFile(state, "replacement");

		const result = exactRemoveDirectoryTree(detached, snapshot.snapshot);
		expect(result).toEqual({ ok: false, code: "identity_mismatch", detachedPath: detached });
		expect(await fs.readFile(state, "utf8")).toBe("replacement");
	});

	it("returns retained root evidence after a partial failure and allows a fresh retry", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached");
		const later = path.join(detached, "z-later.jsonl");
		await fs.mkdir(detached);
		await fs.writeFile(path.join(detached, "a-first.jsonl"), "first");
		await fs.writeFile(later, "later");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		await fs.rm(later);
		await fs.writeFile(later, "replacement");

		const failed = exactRemoveDirectoryTree(detached, snapshot.snapshot);
		expect(failed).toEqual({ ok: false, code: "identity_mismatch", detachedPath: detached });
		expect(await fs.readFile(later, "utf8")).toBe("replacement");
		const retry = snapshotDirectoryTree(detached);
		expect(retry.ok).toBe(true);
		if (!retry.ok || !retry.snapshot) throw new Error(`retry snapshot failed: ${retry.code}`);
		expect(exactRemoveDirectoryTree(detached, retry.snapshot)).toEqual({ ok: true });
		expect(
			await fs.stat(detached).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
	it("validates all nested siblings before quarantining an earlier sibling", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached-prevalidation");
		const earlier = path.join(detached, "a-earlier.jsonl");
		const later = path.join(detached, "nested", "z-later.jsonl");
		await fs.mkdir(path.dirname(later), { recursive: true });
		await fs.writeFile(earlier, "authorized-earlier");
		await fs.writeFile(later, "authorized-later");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);

		await fs.rm(later);
		await fs.writeFile(later, "substituted-later");

		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({
			ok: false,
			code: "identity_mismatch",
			detachedPath: detached,
		});
		expect(await fs.readFile(earlier, "utf8")).toBe("authorized-earlier");
		expect(await fs.readFile(later, "utf8")).toBe("substituted-later");
	});
	it("replays a previous child-removal prefix from the original snapshot", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached-prefix");
		const first = path.join(detached, "a-first.jsonl");
		await fs.mkdir(detached);
		await fs.writeFile(first, "first");
		await fs.writeFile(path.join(detached, "z-later.jsonl"), "later");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);

		await fs.rm(first);
		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
	});
	it.skipIf(!process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY)(
		"preserves case-distinct direct children in a configured case-sensitive directory",
		async () => {
			const detached = process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY!;
			await fs.writeFile(path.join(detached, "State.jsonl"), "upper");
			await fs.writeFile(path.join(detached, "state.jsonl"), "lower");
			const snapshot = snapshotDirectoryTree(detached);
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
			expect(snapshot.snapshot.entries.map(entry => entry.relativePath)).toEqual(["", "State.jsonl", "state.jsonl"]);
			expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
		},
	);
	it("removes nested read-only artifacts through their verified handles", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached-readonly");
		const nested = path.join(detached, "nested");
		const readonly = path.join(nested, "state.jsonl");
		await fs.mkdir(nested, { recursive: true });
		await fs.writeFile(readonly, "authorized");
		await fs.chmod(readonly, 0o444);
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
	});
	it("replays a crash after deterministic child quarantine before delete", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached-child-crash");
		const state = path.join(detached, "state.jsonl");
		await fs.mkdir(detached);
		await fs.writeFile(state, "authorized");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		const stateEntry = snapshot.snapshot.entries.find(entry => entry.relativePath === "state.jsonl");
		if (!stateEntry) throw new Error("missing state entry");

		await fs.rename(state, path.join(detached, treeQuarantineName(stateEntry)));
		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
		expect(
			await fs.stat(detached).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
});
