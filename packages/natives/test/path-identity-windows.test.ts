import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	applyOwnerOnlyPathSecurity,
	canonicalExistingDirectoryIdentity,
	exactRemoveDirectoryTree,
	exactReplacePath,
	exactRestore,
	exactUnlink,
	exactUnlinkDirect,
	renameNoReplacePath,
	repairOwnerOnlyPathSecurityExpected,
	retainBrokerPublication,
	snapshotDirectoryTree,
	symlinkNoReplacePath,
	verifyOwnerOnlyPathSecurity,
	verifyOwnerOnlyPathSecurityExpected,
} from "../native/index.js";

const temporaryDirectories: string[] = [];

function sha256(contents: string): string {
	return createHash("sha256").update(contents).digest("hex");
}

async function parentIdentity(pathname: string): Promise<{ parentDev: bigint; parentIno: bigint }> {
	const parent = await fs.stat(path.dirname(pathname), { bigint: true });
	return { parentDev: parent.dev, parentIno: parent.ino };
}

function expectRepairableOwnerOnlyMismatch(result: { ok: boolean; code?: string }): void {
	expect(result.ok).toBe(false);
	// Windows can assign a newly created object either to the token user SID or
	// to its enabled owner group. Both are fail-closed pre-repair states: the
	// former exposes an inherited DACL mismatch, while the latter is the more
	// specific owner mismatch that apply/repair subsequently corrects.
	if (!result.code) throw new Error("Missing fail-closed owner-only mismatch code");
	expect(["acl_verify_failed", "owner_mismatch"]).toContain(result.code);
}

async function runIcacls(...args: string[]): Promise<void> {
	const process = Bun.spawn(["icacls", ...args], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
	if (exitCode !== 0) throw new Error(`icacls failed (${exitCode}): ${stderr}`);
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
	it("keeps retained publication refusal structured on Windows", async () => {
		const root = await temporaryDirectory();
		let refusal: unknown;
		try {
			retainBrokerPublication(root);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toMatchObject({ code: "GenericFailure" });
		expect((refusal as Error).message).toContain(
			"Retained broker publication authority is unavailable. [retained-publication object=sdk; reason=unsupported-platform]",
		);
	});

	it("rejects final and ancestor reparse points for every owner-only ACL operation", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const alias = path.join(root, "alias");
		const file = path.join(target, "state.json");
		await fs.mkdir(target);
		await fs.writeFile(file, "{}");
		await fs.symlink(target, alias, "junction");

		const rejected = { ok: false, code: "reparse_point" } as const;
		expect(repairOwnerOnlyPathSecurityExpected(alias, "directory", 0n, 0n)).toEqual(rejected);
		expect(repairOwnerOnlyPathSecurityExpected(path.join(alias, "state.json"), "file", 0n, 0n)).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurityExpected(alias, "directory", 0n, 0n)).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurityExpected(path.join(alias, "state.json"), "file", 0n, 0n)).toEqual(rejected);
		expect(applyOwnerOnlyPathSecurity(alias, "directory")).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurity(alias, "directory")).toEqual(rejected);
		expect(applyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual(rejected);
	});

	it("binds symbolic-link creation to the expected parent identity", async () => {
		const root = await temporaryDirectory();
		const other = await temporaryDirectory();
		const target = path.join(root, "target.txt");
		const destination = path.join(root, "published");
		await fs.writeFile(target, "target");
		const wrongParent = await fs.stat(other, { bigint: true });

		const rejected = symlinkNoReplacePath(target, destination, {
			dev: wrongParent.dev,
			ino: wrongParent.ino,
		});
		expect(rejected).toMatchObject({
			ok: false,
			code: "parent_mismatch",
			mutationState: "not_committed",
			reason: "identity_violation",
			primitive: "windows_symlink_noreplace",
		});
		await expect(fs.lstat(destination)).rejects.toMatchObject({ code: expect.any(String) });

		const parent = await fs.stat(root, { bigint: true });
		const created = symlinkNoReplacePath(target, destination, {
			dev: parent.dev,
			ino: parent.ino,
		});
		if (!created.ok) {
			expect(created).toMatchObject({
				ok: false,
				code: "atomic_unavailable",
				mutationState: "not_committed",
				reason: "atomic_unavailable",
				primitive: "windows_symlink_noreplace",
				phase: "symlink",
				diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
			});
			await expect(fs.lstat(destination)).rejects.toMatchObject({ code: expect.any(String) });
			return;
		}
		expect(created).toMatchObject({
			ok: true,
			mutationState: "committed",
			reason: "none",
			primitive: "windows_symlink_noreplace",
		});
		expect(await fs.readlink(destination)).toBe(target);
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
	it("binds exact replacement to both staged source and destination identities", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.json");
		const destination = path.join(root, "state.json");
		await fs.writeFile(source, "new-state");
		await fs.writeFile(destination, "old-state");
		const sourceStat = await fs.stat(source, { bigint: true });
		const destinationStat = await fs.stat(destination, { bigint: true });
		const parent = await parentIdentity(source);
		const sourceIdentity = {
			...parent,
			dev: sourceStat.dev,
			ino: sourceStat.ino,
			size: sourceStat.size,
			mtimeNs: sourceStat.mtimeNs,
			sha256: sha256("new-state"),
		};
		const destinationIdentity = {
			...parent,
			dev: destinationStat.dev,
			ino: destinationStat.ino,
			size: destinationStat.size,
			mtimeNs: destinationStat.mtimeNs,
			sha256: sha256("old-state"),
		};
		expect(exactReplacePath(source, destination, sourceIdentity, destinationIdentity)).toEqual({ ok: true });
		expect(await fs.readFile(destination, "utf8")).toBe("new-state");
		await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("retries a transient destination sharing violation and succeeds after the holder releases", async () => {
		// Issue #4330: a concurrent holder that denies delete sharing on the
		// destination makes the exact-replace destination open fail with
		// STATUS_SHARING_VIOLATION before any namespace mutation. The native
		// destination open retries a bounded number of times, so releasing the
		// holder within the budget completes the replacement exactly once.
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.json");
		const destination = path.join(root, "state.json");
		const marker = path.join(root, "holder-ready");
		const holder = path.join(root, "holder.cjs");
		await fs.writeFile(source, "new-state");
		await fs.writeFile(destination, "old-state");
		const sourceStat = await fs.stat(source, { bigint: true });
		const destinationStat = await fs.stat(destination, { bigint: true });
		const parent = await parentIdentity(source);
		const sourceIdentity = {
			...parent,
			dev: sourceStat.dev,
			ino: sourceStat.ino,
			size: sourceStat.size,
			mtimeNs: sourceStat.mtimeNs,
			sha256: sha256("new-state"),
		};
		const destinationIdentity = {
			...parent,
			dev: destinationStat.dev,
			ino: destinationStat.ino,
			size: destinationStat.size,
			mtimeNs: destinationStat.mtimeNs,
			sha256: sha256("old-state"),
		};
		// `r+` opens without delete sharing (same share semantics the existing
		// "refuses exact unlink while another writer can mutate the file" test
		// relies on), so the parent's DELETE-requesting destination open fails
		// with STATUS_SHARING_VIOLATION until the child closes.
		await Bun.write(
			holder,
			`const fs = require("node:fs");
const [file, ready, holdMs] = process.argv.slice(2);
const fd = fs.openSync(file, "r+");
fs.writeFileSync(ready, "ready");
setTimeout(() => { try { fs.closeSync(fd); } catch {} process.exit(0); }, Number(holdMs));\n`,
		);
		const child = Bun.spawn([process.execPath, holder, destination, marker, "1500"], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			let ready = false;
			for (let attempt = 0; attempt < 400 && !ready; attempt++) {
				ready = await Bun.file(marker).exists();
				if (!ready) await Bun.sleep(25);
			}
			expect(ready).toBe(true);

			const result = exactReplacePath(source, destination, sourceIdentity, destinationIdentity);
			expect(result.ok).toBe(true);
			expect(result.windowsErrorCode).toBeUndefined();
			expect(await fs.readFile(destination, "utf8")).toBe("new-state");
			await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await child.exited;
		}
	});

	it("exhausts the transient retry budget with a specific sharing violation instead of mutating", async () => {
		// A holder that never releases within the bounded budget must fail with
		// the specific pre-mutation category (not a bare io_error), preserve the
		// underlying Windows status without leaking paths, and leave both the
		// staged source and the destination untouched so the caller can retry.
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.json");
		const destination = path.join(root, "state.json");
		await fs.writeFile(source, "new-state");
		await fs.writeFile(destination, "old-state");
		const sourceStat = await fs.stat(source, { bigint: true });
		const destinationStat = await fs.stat(destination, { bigint: true });
		const parent = await parentIdentity(source);
		const sourceIdentity = {
			...parent,
			dev: sourceStat.dev,
			ino: sourceStat.ino,
			size: sourceStat.size,
			mtimeNs: sourceStat.mtimeNs,
			sha256: sha256("new-state"),
		};
		const destinationIdentity = {
			...parent,
			dev: destinationStat.dev,
			ino: destinationStat.ino,
			size: destinationStat.size,
			mtimeNs: destinationStat.mtimeNs,
			sha256: sha256("old-state"),
		};
		const holder = await fs.open(destination, "r+");
		try {
			const result = exactReplacePath(source, destination, sourceIdentity, destinationIdentity);
			expect(result.ok).toBe(false);
			expect(result.code).toBe("sharing_violation");
			expect(result.windowsErrorCode).toBe("0xC0000043");
			// Pre-mutation: no detached/retained namespace evidence, so nothing was
			// renamed or unlinked and the caller may safely retry.
			expect(result.detachedPath).toBeUndefined();
			expect(result.retainedSuccessorPath).toBeUndefined();
			expect(result.retainedPlaceholderPath).toBeUndefined();
			expect(result.retainedUnknownPath).toBeUndefined();
			expect(await fs.readFile(destination, "utf8")).toBe("old-state");
			expect(await fs.readFile(source, "utf8")).toBe("new-state");
		} finally {
			await holder.close();
		}
	});

	it("rejects a substituted staged source before deleting the exact destination", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.json");
		const retainedSource = path.join(root, "retained-staged.json");
		const destination = path.join(root, "state.json");
		await fs.writeFile(source, "authorized-stage");
		await fs.writeFile(destination, "old-state");
		const sourceStat = await fs.stat(source, { bigint: true });
		const destinationStat = await fs.stat(destination, { bigint: true });
		const parent = await parentIdentity(source);
		const sourceIdentity = {
			...parent,
			dev: sourceStat.dev,
			ino: sourceStat.ino,
			size: sourceStat.size,
			mtimeNs: sourceStat.mtimeNs,
			sha256: sha256("authorized-stage"),
		};
		const destinationIdentity = {
			...parent,
			dev: destinationStat.dev,
			ino: destinationStat.ino,
			size: destinationStat.size,
			mtimeNs: destinationStat.mtimeNs,
			sha256: sha256("old-state"),
		};
		await fs.rename(source, retainedSource);
		await fs.writeFile(source, "substituted-stage");

		expect(exactReplacePath(source, destination, sourceIdentity, destinationIdentity)).toEqual({
			ok: false,
			code: "identity_mismatch",
		});
		expect(await fs.readFile(destination, "utf8")).toBe("old-state");
		expect(await fs.readFile(source, "utf8")).toBe("substituted-stage");
		expect(await fs.readFile(retainedSource, "utf8")).toBe("authorized-stage");
	});

	it("rejects exact unlink while a foreign hard link preserves transcript bytes", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "session.jsonl");
		const alias = path.join(root, "foreign-session.jsonl");
		const contents = "transcript payload";
		await fs.writeFile(target, contents);
		await fs.link(target, alias);
		const stat = await fs.stat(target, { bigint: true });

		expect(
			exactUnlink(target, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256(contents),
			}),
		).toEqual({ ok: false, code: "hard_link_unsupported" });
		expect(await fs.readFile(target, "utf8")).toBe(contents);
		expect(await fs.readFile(alias, "utf8")).toBe(contents);
	});

	it("rejects exact replacement when the staged source has a foreign hard link", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "source.json");
		const sourceAlias = path.join(root, "source-alias.json");
		const destination = path.join(root, "destination.json");
		await fs.writeFile(source, "new-state");
		await fs.link(source, sourceAlias);
		await fs.writeFile(destination, "old-state");
		const [sourceStat, destinationStat] = await Promise.all([
			fs.stat(source, { bigint: true }),
			fs.stat(destination, { bigint: true }),
		]);
		const parent = await parentIdentity(source);

		expect(
			exactReplacePath(
				source,
				destination,
				{
					...parent,
					dev: sourceStat.dev,
					ino: sourceStat.ino,
					size: sourceStat.size,
					mtimeNs: sourceStat.mtimeNs,
					sha256: sha256("new-state"),
				},
				{
					...parent,
					dev: destinationStat.dev,
					ino: destinationStat.ino,
					size: destinationStat.size,
					mtimeNs: destinationStat.mtimeNs,
					sha256: sha256("old-state"),
				},
			),
		).toEqual({ ok: false, code: "hard_link_unsupported" });
		expect(await fs.readFile(source, "utf8")).toBe("new-state");
		expect(await fs.readFile(sourceAlias, "utf8")).toBe("new-state");
		expect(await fs.readFile(destination, "utf8")).toBe("old-state");
	});

	it("rejects exact replacement when the committed destination has a foreign hard link", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "source.json");
		const destination = path.join(root, "destination.json");
		const destinationAlias = path.join(root, "destination-alias.json");
		await fs.writeFile(source, "new-state");
		await fs.writeFile(destination, "old-state");
		await fs.link(destination, destinationAlias);
		const [sourceStat, destinationStat] = await Promise.all([
			fs.stat(source, { bigint: true }),
			fs.stat(destination, { bigint: true }),
		]);
		const parent = await parentIdentity(source);

		expect(
			exactReplacePath(
				source,
				destination,
				{
					...parent,
					dev: sourceStat.dev,
					ino: sourceStat.ino,
					size: sourceStat.size,
					mtimeNs: sourceStat.mtimeNs,
					sha256: sha256("new-state"),
				},
				{
					...parent,
					dev: destinationStat.dev,
					ino: destinationStat.ino,
					size: destinationStat.size,
					mtimeNs: destinationStat.mtimeNs,
					sha256: sha256("old-state"),
				},
			),
		).toEqual({ ok: false, code: "hard_link_unsupported" });
		expect(await fs.readFile(source, "utf8")).toBe("new-state");
		expect(await fs.readFile(destination, "utf8")).toBe("old-state");
		expect(await fs.readFile(destinationAlias, "utf8")).toBe("old-state");
	});

	it("rejects exact restore when retained content has a foreign hard link", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-delete-session");
		const alias = path.join(root, "foreign-session.jsonl");
		const original = path.join(root, "session.jsonl");
		const contents = "retained transcript";
		await fs.writeFile(detached, contents);
		await fs.link(detached, alias);
		const stat = await fs.stat(detached, { bigint: true });
		const parent = await parentIdentity(detached);

		expect(
			exactRestore(detached, original, {
				...parent,
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256(contents),
			}),
		).toEqual({ ok: false, code: "hard_link_unsupported" });
		expect(await fs.readFile(detached, "utf8")).toBe(contents);
		expect(await fs.readFile(alias, "utf8")).toBe(contents);
		await expect(fs.stat(original)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects exact tree removal when a child gains a foreign hard link", async () => {
		const root = await temporaryDirectory();
		const tree = path.join(root, "tree");
		const child = path.join(tree, "artifact.bin");
		const alias = path.join(root, "foreign-artifact.bin");
		await fs.mkdir(tree);
		await fs.writeFile(child, "artifact payload");
		const snapshot = snapshotDirectoryTree(tree);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error("Missing tree snapshot");
		await fs.link(child, alias);

		expect(exactRemoveDirectoryTree(tree, snapshot.snapshot)).toMatchObject({
			ok: false,
			code: "hard_link_unsupported",
		});
		expect(await fs.readFile(child, "utf8")).toBe("artifact payload");
		expect(await fs.readFile(alias, "utf8")).toBe("artifact payload");
	});

	it("refuses exact unlink while another writer can mutate the file", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "contended.jsonl");
		await fs.writeFile(target, "contended transcript");
		const stat = await fs.stat(target, { bigint: true });
		const writer = await fs.open(target, "r+");
		try {
			expect(
				exactUnlink(target, {
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeNs: stat.mtimeNs,
					sha256: sha256("contended transcript"),
				}),
			).toMatchObject({ ok: false });
			expect(await fs.readFile(target, "utf8")).toBe("contended transcript");
		} finally {
			await writer.close();
		}
	});

	it("refuses exact restore while another writer can mutate retained content", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-delete-contended");
		const original = path.join(root, "contended.jsonl");
		await fs.writeFile(detached, "retained content");
		const stat = await fs.stat(detached, { bigint: true });
		const parent = await parentIdentity(detached);
		const writer = await fs.open(detached, "r+");
		try {
			expect(
				exactRestore(detached, original, {
					...parent,
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeNs: stat.mtimeNs,
					sha256: sha256("retained content"),
				}),
			).toMatchObject({ ok: false });
			expect(await fs.readFile(detached, "utf8")).toBe("retained content");
			await expect(fs.stat(original)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await writer.close();
		}
	});

	it("refuses exact tree removal while another writer can mutate a child", async () => {
		const root = await temporaryDirectory();
		const tree = path.join(root, "contended-tree");
		const child = path.join(tree, "artifact.bin");
		await fs.mkdir(tree);
		await fs.writeFile(child, "contended artifact");
		const snapshot = snapshotDirectoryTree(tree);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error("Missing tree snapshot");
		const writer = await fs.open(child, "r+");
		try {
			expect(exactRemoveDirectoryTree(tree, snapshot.snapshot)).toMatchObject({ ok: false });
			expect(await fs.readFile(child, "utf8")).toBe("contended artifact");
		} finally {
			await writer.close();
		}
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
		const parent = await parentIdentity(original);
		const identity = {
			...parent,
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

		expectRepairableOwnerOnlyMismatch(verifyOwnerOnlyPathSecurity(directory, "directory"));
		expectRepairableOwnerOnlyMismatch(verifyOwnerOnlyPathSecurity(file, "file"));
		expect(applyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(applyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});
	it("repairs a legacy inherited ACL only for the captured directory and file identities", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "legacy-managed");
		const file = path.join(directory, "state.json");
		const contents = '{"legacy":true}';
		await fs.mkdir(directory);
		await fs.writeFile(file, contents);
		const directoryStat = await fs.stat(directory, { bigint: true });
		const fileStat = await fs.stat(file, { bigint: true });

		expectRepairableOwnerOnlyMismatch(verifyOwnerOnlyPathSecurity(directory, "directory"));
		expectRepairableOwnerOnlyMismatch(verifyOwnerOnlyPathSecurity(file, "file"));
		expect(repairOwnerOnlyPathSecurityExpected(file, "directory", fileStat.dev, fileStat.ino)).toMatchObject({
			ok: false,
		});
		expect(await fs.readFile(file, "utf8")).toBe(contents);
		expect(repairOwnerOnlyPathSecurityExpected(directory, "directory", directoryStat.dev, directoryStat.ino)).toEqual(
			{ ok: true },
		);
		expect(repairOwnerOnlyPathSecurityExpected(file, "file", fileStat.dev, fileStat.ino)).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});

	it("repairs an owner-correct DACL without requiring WRITE_OWNER", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "dacl-only.json");
		const user = process.env.USERNAME;
		if (!user) throw new Error("Missing Windows username");
		await fs.writeFile(file, "owner-correct");
		expect(applyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		await runIcacls(file, "/inheritance:r", "/grant:r", `${user}:(RC,WDAC,S,D,RD,WD,AD,REA,WEA,X,DC,RA,WA)`);
		const identity = await fs.stat(file, { bigint: true });

		try {
			expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "acl_verify_failed" });
			expect(repairOwnerOnlyPathSecurityExpected(file, "file", identity.dev, identity.ino)).toEqual({ ok: true });
			expect(verifyOwnerOnlyPathSecurityExpected(file, "file", identity.dev, identity.ino)).toEqual({ ok: true });
			expect(await fs.readFile(file, "utf8")).toBe("owner-correct");
		} finally {
			await runIcacls(file, "/reset");
		}
	});
	it("verifies only the captured identity without mutating a swapped replacement", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target.json");
		const retained = path.join(root, "retained.json");
		await fs.writeFile(target, "authorized");
		expect(applyOwnerOnlyPathSecurity(target, "file")).toEqual({ ok: true });
		const identity = await fs.stat(target, { bigint: true });
		expect(verifyOwnerOnlyPathSecurityExpected(target, "file", identity.dev, identity.ino)).toEqual({ ok: true });
		await fs.rename(target, retained);
		await fs.writeFile(target, "replacement");

		expect(verifyOwnerOnlyPathSecurityExpected(target, "file", identity.dev, identity.ino)).toEqual({
			ok: false,
			code: "identity_mismatch",
		});
		expectRepairableOwnerOnlyMismatch(verifyOwnerOnlyPathSecurity(target, "file"));
		expect(await fs.readFile(target, "utf8")).toBe("replacement");
		expect(await fs.readFile(retained, "utf8")).toBe("authorized");
	});
	it("rejects a swapped replacement before any expected-identity ACL repair", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target.json");
		const retained = path.join(root, "retained.json");
		await fs.writeFile(target, "authorized");
		const identity = await fs.stat(target, { bigint: true });
		await fs.rename(target, retained);
		await fs.writeFile(target, "replacement");

		expect(repairOwnerOnlyPathSecurityExpected(target, "file", identity.dev, identity.ino)).toEqual({
			ok: false,
			code: "identity_mismatch",
		});
		expect(await fs.readFile(target, "utf8")).toBe("replacement");
		expect(await fs.readFile(retained, "utf8")).toBe("authorized");
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
			mutationState: "not_committed",
			durabilityState: "not_attempted",
			reason: "destination_exists",
			primitive: "windows_rename_noreplace",
			phase: "rename",
			diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
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

	it("directly removes one authorized regular file without leaving exchange debris", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "stale-debris");
		const directQuarantine = ".gjc-direct-unlink-test";
		await fs.writeFile(file, "stale");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlinkDirect(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("stale"),
				quarantineName: directQuarantine,
			}),
		).toEqual({ ok: true });
		await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(root, directQuarantine))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("retains a regular file when direct cleanup parent authority changes", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "parent-bound-debris");
		await fs.writeFile(file, "stale");
		const stat = await fs.stat(file, { bigint: true });
		const parent = await parentIdentity(file);

		expect(
			exactUnlinkDirect(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("stale"),
				parentDev: parent.parentDev + 1n,
				parentIno: parent.parentIno,
				quarantineName: ".gjc-parent-mismatch",
			}),
		).toEqual({ ok: false, code: "parent_mismatch" });
		await expect(fs.readFile(file, "utf8")).resolves.toBe("stale");
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
		const parent = await parentIdentity(original);
		const identity = {
			...parent,
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
		const parent = await parentIdentity(original);
		const identity = {
			...parent,
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
		const parent = await parentIdentity(original);
		const identity = {
			...parent,
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
		expect(repairOwnerOnlyPathSecurityExpected(String.raw`\\server\share\workspace`, "directory", 0n, 0n)).toEqual({
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
