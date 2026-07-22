import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { openRecoveryFsRoot } from "../native/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-recovery-fs-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe.skipIf(process.platform !== "linux")("native recovery filesystem authority", () => {
	it("creates, installs, fsyncs, and reports descriptor identities", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);

		const created = authority.create("state.tmp", Buffer.from('{"generation":1}\n'));
		expect(created).toMatchObject({ ok: true, identity: { size: "17" } });
		expect(authority.install("state.tmp", "state.json")).toMatchObject({ ok: true });
		expect(authority.stat("state.json")).toMatchObject({
			ok: true,
			identity: {
				dev: created.identity?.dev,
				ino: created.identity?.ino,
				size: created.identity?.size,
				mtimeNs: created.identity?.mtimeNs,
			},
		});
		const read = authority.read("state.json", 1024);
		expect(read.ok).toBe(true);
		expect(Buffer.from(read.data ?? [])).toEqual(Buffer.from('{"generation":1}\n'));
		expect(authority.fsync()).toMatchObject({ ok: true });
		expect(authority.close()).toMatchObject({ ok: true });
		expect(authority.stat("state.json")).toEqual({ ok: false, code: "closed" });
	});

	it("rejects traversal, symlinks, special files, hard links, and oversized content", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);
		await fs.writeFile(path.join(root, "regular"), "trusted");
		await fs.link(path.join(root, "regular"), path.join(root, "hard-link"));
		await fs.symlink("regular", path.join(root, "link"));
		const fifo = path.join(root, "receipt.fifo");
		const mkfifo = Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "ignore" });
		expect(await mkfifo.exited).toBe(0);

		expect(authority.stat("../outside")).toMatchObject({ ok: false, code: "invalid_path" });
		expect(authority.read("link", 1024)).toMatchObject({ ok: false, code: "reparse_point" });
		expect(authority.stat("receipt.fifo")).toMatchObject({ ok: false, code: "not_regular_file" });
		expect(authority.stat("hard-link")).toMatchObject({ ok: false, code: "hard_link" });
		expect(authority.create("too-large", Buffer.alloc(1024 * 1024 + 1))).toMatchObject({
			ok: false,
			code: "content_too_large",
		});
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("supports managed-size content and identity-bound fsync", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);
		const payload = Buffer.alloc(2 * 1024 * 1024, 0x61);
		const created = authority.createManaged("managed.bin", payload);
		expect(created.ok).toBe(true);
		if (!created.identity) throw new Error("Expected managed identity");
		expect(authority.readManaged("managed.bin")).toMatchObject({ ok: true, identity: created.identity });
		expect(
			authority.fsyncExpected(
				"managed.bin",
				false,
				created.identity.dev,
				created.identity.ino,
				created.identity.size,
				created.identity.mtimeNs,
				createHash("sha256").update(payload).digest("hex"),
			),
		).toMatchObject({ ok: true, identity: created.identity });
		expect(authority.verifyOwnerOnlyDirectory()).toMatchObject({ ok: true });
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("requires ctime and digest evidence before replacing or removing managed content", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);
		const original = Buffer.from("original");
		const created = authority.createManaged("receipt", original);
		expect(created.ok).toBe(true);
		const read = authority.readManaged("receipt");
		expect(read.ok).toBe(true);
		expect(Buffer.from(read.data ?? [])).toEqual(original);
		if (!read.identity?.sha256) throw new Error("Expected managed digest evidence");
		expect(
			authority.replaceManaged(
				"receipt",
				Buffer.from("unauthorized"),
				read.identity.dev,
				read.identity.ino,
				read.identity.size,
				read.identity.mtimeNs,
				"0",
				read.identity.sha256,
			),
		).toMatchObject({ ok: false, code: "identity_mismatch" });
		const replacement = authority.replaceManaged(
			"receipt",
			Buffer.from("replacement"),
			read.identity.dev,
			read.identity.ino,
			read.identity.size,
			read.identity.mtimeNs,
			read.identity.ctimeNs,
			read.identity.sha256,
		);
		expect(replacement).toMatchObject({ ok: true });
		const replaced = authority.readManaged("receipt");
		if (!replaced.identity?.sha256) throw new Error("Expected replacement digest evidence");
		expect(
			authority.removeManaged(
				"receipt",
				replaced.identity.dev,
				replaced.identity.ino,
				replaced.identity.size,
				replaced.identity.mtimeNs,
				replaced.identity.ctimeNs,
				replaced.identity.sha256,
			),
		).toMatchObject({ ok: true });
		await expect(fs.access(path.join(root, "receipt"))).rejects.toThrow();
	});

	it("continues to use the retained root descriptor after the root pathname is swapped", async () => {
		const parent = await temporaryDirectory();
		const root = path.join(parent, "root");
		const retained = path.join(parent, "retained");
		const replacement = path.join(parent, "replacement");
		await fs.mkdir(root);
		await fs.mkdir(replacement);
		const authority = openRecoveryFsRoot(root);
		await fs.rename(root, retained);
		await fs.symlink(replacement, root, "dir");

		expect(authority.create("receipt.tmp", Buffer.from("receipt"))).toMatchObject({ ok: true });
		expect(await fs.readFile(path.join(retained, "receipt.tmp"), "utf8")).toBe("receipt");
		expect(await fs.readdir(replacement)).toEqual([]);
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("refuses to replace an existing install destination", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);
		expect(authority.create("candidate", Buffer.from("candidate"))).toMatchObject({ ok: true });
		expect(authority.create("receipt", Buffer.from("existing"))).toMatchObject({ ok: true });
		expect(authority.install("candidate", "receipt")).toMatchObject({ ok: false, code: "already_exists" });
		expect(await fs.readFile(path.join(root, "candidate"), "utf8")).toBe("candidate");
		expect(await fs.readFile(path.join(root, "receipt"), "utf8")).toBe("existing");
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("creates nested owner-only directories through the retained root and moves exact files without reopening root names", async () => {
		const parent = await temporaryDirectory();
		const root = path.join(parent, "root");
		const retained = path.join(parent, "retained");
		await fs.mkdir(root);
		const authority = openRecoveryFsRoot(root);
		expect(authority.ensureManagedDirectory("nested/empty")).toMatchObject({ ok: true });
		const created = authority.createManaged("nested/empty/source", Buffer.from("trusted"));
		expect(created.ok).toBe(true);
		if (!created.identity) throw new Error("Expected managed identity");
		await fs.rename(root, retained);
		expect(
			authority.renameManagedFileNoReplace(
				"nested/empty/source",
				"nested/empty/destination",
				created.identity.dev,
				created.identity.ino,
				created.identity.size,
				created.identity.mtimeNs,
				created.identity.ctimeNs,
				createHash("sha256").update("trusted").digest("hex"),
			),
		).toMatchObject({
			ok: true,
			identity: {
				dev: created.identity.dev,
				ino: created.identity.ino,
				size: created.identity.size,
				mtimeNs: created.identity.mtimeNs,
			},
		});
		expect(await fs.readFile(path.join(retained, "nested/empty/destination"), "utf8")).toBe("trusted");
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("refuses managed rename when the supplied source identity is stale", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);
		const created = authority.createManaged("source", Buffer.from("trusted"));
		if (!created.identity) throw new Error("Expected managed identity");
		expect(
			authority.renameManagedFileNoReplace(
				"source",
				"destination",
				created.identity.dev,
				"0",
				created.identity.size,
				created.identity.mtimeNs,
				created.identity.ctimeNs,
				createHash("sha256").update("trusted").digest("hex"),
			),
		).toMatchObject({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("trusted");
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("snapshots, moves, and removes nested managed trees through the retained root", async () => {
		const parent = await temporaryDirectory();
		const root = path.join(parent, "root");
		const retained = path.join(parent, "retained");
		await fs.mkdir(root);
		const authority = openRecoveryFsRoot(root);
		expect(authority.ensureManagedDirectory("source/nested")).toMatchObject({ ok: true });
		expect(authority.createManaged("source/nested/receipt", Buffer.from("trusted"))).toMatchObject({ ok: true });
		const snapshot = authority.snapshotManagedTree("source");
		expect(snapshot).toMatchObject({ ok: true });
		if (!snapshot.snapshot) throw new Error("Expected managed tree snapshot");
		await fs.rename(root, retained);
		expect(authority.renameManagedTreeNoReplace("source", "destination", snapshot.snapshot)).toMatchObject({
			ok: true,
		});
		expect(await fs.readFile(path.join(retained, "destination/nested/receipt"), "utf8")).toBe("trusted");
		const destinationSnapshot = authority.snapshotManagedTree("destination");
		if (!destinationSnapshot.snapshot) throw new Error("Expected destination tree snapshot");
		expect(authority.removeManagedTree("destination", destinationSnapshot.snapshot)).toMatchObject({ ok: true });
		await expect(fs.access(path.join(retained, "destination"))).rejects.toThrow();
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("preserves replacement trees when a managed tree snapshot is stale", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);
		expect(authority.ensureManagedDirectory("source")).toMatchObject({ ok: true });
		expect(authority.createManaged("source/receipt", Buffer.from("trusted"))).toMatchObject({ ok: true });
		const snapshot = authority.snapshotManagedTree("source");
		if (!snapshot.snapshot) throw new Error("Expected managed tree snapshot");
		await fs.rename(path.join(root, "source"), path.join(root, "saved"));
		await fs.mkdir(path.join(root, "source"), { mode: 0o700 });
		await fs.writeFile(path.join(root, "source", "receipt"), "replacement", { mode: 0o600 });
		expect(authority.renameManagedTreeNoReplace("source", "destination", snapshot.snapshot)).toMatchObject({
			ok: false,
			code: "identity_mismatch",
		});
		expect(authority.removeManagedTree("source", snapshot.snapshot)).toMatchObject({
			ok: false,
			code: "identity_mismatch",
		});
		expect(await fs.readFile(path.join(root, "source/receipt"), "utf8")).toBe("replacement");
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("does not replace an unauthorized destination tree during a retained move", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);
		expect(authority.ensureManagedDirectory("source")).toMatchObject({ ok: true });
		expect(authority.createManaged("source/receipt", Buffer.from("trusted"))).toMatchObject({ ok: true });
		const snapshot = authority.snapshotManagedTree("source");
		if (!snapshot.snapshot) throw new Error("Expected managed tree snapshot");
		await fs.mkdir(path.join(root, "destination"));
		await fs.writeFile(path.join(root, "destination", "receipt"), "replacement");
		expect(authority.renameManagedTreeNoReplace("source", "destination", snapshot.snapshot)).toMatchObject({
			ok: false,
			code: "already_exists",
		});
		expect(await fs.readFile(path.join(root, "source/receipt"), "utf8")).toBe("trusted");
		expect(await fs.readFile(path.join(root, "destination/receipt"), "utf8")).toBe("replacement");
		expect(authority.close()).toMatchObject({ ok: true });
	});
});
