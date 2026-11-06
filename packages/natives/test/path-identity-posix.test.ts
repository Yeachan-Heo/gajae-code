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
	exactUnlinkDirect,
	inspectConfigFilePermissionRepair,
	type NativeExactFileIdentity,
	NativeStagedDirectorySyncState,
	readOwnerOnlyFile,
	repairConfigFilePermissions,
	retainStagedDirectory,
	snapshotDirectoryTree,
	verifyOwnerOnlyPathSecurity,
} from "../native/index.js";

const temporaryDirectories: string[] = [];

function sha256(contents: string): string {
	return createHash("sha256").update(contents).digest("hex");
}

/** The canonical name is vacated and the retired payload is retained at its preauthorized destination. */
function expectDetachedCleanupPending(result: ReturnType<typeof exactUnlink>, detachedPath: string): void {
	expect(result).toMatchObject({ ok: true, detachedPath });
	expect(result.retainedPlaceholderPath).toBeUndefined();
	expect(result.retainedUnknownPath).toBeUndefined();
}

function expectTreeCleanupPending(result: ReturnType<typeof exactRemoveDirectoryTree>, plannedPath: string): void {
	expect(result).toEqual({
		ok: false,
		code: "cleanup_pending",
		payloadDurable: true,
		detachedPath: `${plannedPath}.removing`,
	});
}

function expectOwnerOnlySuccess(
	result: ReturnType<typeof applyOwnerOnlyPathSecurity>,
	kind: "directory" | "file",
	phase: "apply" | "verify" = "apply",
): void {
	expect(result).toMatchObject({ ok: true });
	if (process.platform !== "linux") return;
	expect(result).toMatchObject({
		ok: true,
		platform: "linux",
		protocol: phase,
		kind,
		aclEvidence: {
			access: {
				clear: expect.stringMatching(phase === "apply" ? /^(cleared|already_absent|unsupported)$/ : /^not_run$/),
				query: expect.stringMatching(/^(absent|unsupported)$/),
			},
		},
	});
	if (kind === "directory") {
		expect(result).toMatchObject({
			aclEvidence: {
				default: {
					clear: expect.stringMatching(phase === "apply" ? /^(cleared|already_absent|unsupported)$/ : /^not_run$/),
					query: expect.stringMatching(/^(absent|unsupported)$/),
				},
			},
		});
	} else {
		expect(result.aclEvidence).not.toHaveProperty("default");
	}
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

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("retained staged discard", () => {
	async function fixture() {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-staged-discard-"));
		temporaryDirectories.push(root);
		await fs.mkdir(path.join(root, "stage"));
		const expected = await fs.stat(root, { bigint: true });
		const parent = retainStagedDirectory(root, { dev: expected.dev, ino: expected.ino }, "stage");
		return { root, parent };
	}

	it("syncs the retained directory with live children without proving closure or publication", async () => {
		const { root, parent } = await fixture();
		const source = path.join(root, "stage", "source");
		const writer = await fs.open(source, "wx", 0o600);
		const file = parent.bindFile("source", writer.fd);
		try {
			await writer.writeFile("not yet published");
			expect(parent.syncSync()).toEqual({ state: NativeStagedDirectorySyncState.Confirmed, retryable: false });
			expect(parent.release()).toMatchObject({ code: "children_active", close: "open" });
			await writer.writeFile(" still open");
			expect(await Bun.file(source).text()).toBe("not yet published still open");
			expect(await fs.readdir(path.join(root, "stage"))).toEqual(["source"]);
			await Bun.write(path.join(root, "stage", "later"), "later namespace mutation");
			expect(parent.syncSync()).toEqual({ state: NativeStagedDirectorySyncState.Confirmed, retryable: false });
		} finally {
			await writer.close();
			file.release();
			parent.release();
		}
		expect(parent.syncSync()).toEqual({
			state: NativeStagedDirectorySyncState.Released,
			code: "released_capability",
			retryable: false,
		});
	});

	it("syncs the original retained directory after its pathname becomes a regular file", async () => {
		const { root, parent } = await fixture();
		try {
			await fs.rename(path.join(root, "stage"), path.join(root, "retained"));
			await Bun.write(path.join(root, "stage"), "replacement file");
			await Bun.write(path.join(root, "retained", "new-entry"), "new entry");
			expect(parent.syncSync()).toEqual({ state: NativeStagedDirectorySyncState.Confirmed, retryable: false });
			expect(await Bun.file(path.join(root, "stage")).text()).toBe("replacement file");
			expect(await Bun.file(path.join(root, "retained", "new-entry")).text()).toBe("new entry");
		} finally {
			parent.release();
		}
	});

	async function aliasFixture() {
		const { root, parent } = await fixture();
		const source = path.join(root, "stage", "source");
		const destination = path.join(root, "stage", "published");
		const writer = await fs.open(source, "wx", 0o600);
		const file = parent.bindFile("source", writer.fd);
		try {
			await writer.writeFile("committed publication bytes");
		} finally {
			await writer.close();
		}
		expect(file.sealSync()).toMatchObject({ state: "retained", fileClose: "closed" });
		await fs.link(source, destination);
		return { root, parent, file, source, destination };
	}

	it("retires a real publication alias with distinct non-rollback evidence", async () => {
		const { parent, file, source, destination } = await aliasFixture();
		try {
			const receipt = file.retirePublishedAliasSync("published");
			expect(receipt).toMatchObject({
				operation: "published_alias_retirement",
				state: "alias_retired",
				fileClose: "closed",
				durability: "confirmed",
				retryable: false,
			});
			expect(receipt.code).toBeUndefined();
			expect(await Bun.file(source).exists()).toBe(false);
			expect(await Bun.file(destination).text()).toBe("committed publication bytes");
			expect((await fs.stat(destination)).nlink).toBe(1);
			expect(file.retirePublishedAliasSync("published")).toEqual(receipt);
			expect(file.discardSync()).toMatchObject({ state: "rejected", code: "operation_conflict" });
			expect(file.sealSync()).toMatchObject({ state: "rejected", code: "operation_conflict" });
			expect(file.retirePublishedAliasSync("different")).toMatchObject({
				state: "rejected",
				code: "destination_conflict",
			});
			file.release();
			expect(file.retirePublishedAliasSync("published")).toMatchObject({
				state: "released",
				durability: "not_provable",
			});
		} finally {
			file.release();
			parent.release();
		}
	});

	it("refuses same-name and malformed alias requests before selecting the operation", async () => {
		const { parent, file, destination } = await aliasFixture();
		try {
			for (const name of ["source", "", ".", "..", "../published", "published\0"]) {
				expect(file.retirePublishedAliasSync(name)).toMatchObject({
					state: "rejected",
					code: "invalid_destination",
				});
			}
			expect(file.retirePublishedAliasSync("published")).toMatchObject({ state: "alias_retired" });
			expect(await Bun.file(destination).text()).toBe("committed publication bytes");
		} finally {
			file.release();
			parent.release();
		}
	});

	it("latches a failed alias attempt and never turns it into rollback", async () => {
		const { root, parent, file, source, destination } = await aliasFixture();
		try {
			await Bun.write(path.join(root, "stage", "wrong"), "unrelated destination");
			expect(file.retirePublishedAliasSync("wrong")).toMatchObject({ state: "retained", code: "identity_mismatch" });
			await fs.unlink(destination);
			expect(file.discardSync()).toMatchObject({ state: "rejected", code: "operation_conflict" });
			expect(file.retirePublishedAliasSync("published")).toMatchObject({
				state: "rejected",
				code: "destination_conflict",
			});
			expect(await Bun.file(source).text()).toBe("committed publication bytes");
			expect(await Bun.file(path.join(root, "stage", "wrong")).text()).toBe("unrelated destination");
		} finally {
			file.release();
			parent.release();
		}
	});

	it("rejects third links, changed bytes, and missing publication evidence without unlinking", async () => {
		for (const change of ["third-link", "bytes", "missing"] as const) {
			const { root, parent, file, source, destination } = await aliasFixture();
			try {
				if (change === "third-link") await fs.link(source, path.join(root, "third"));
				if (change === "bytes") await Bun.write(source, "changed bytes");
				if (change === "missing") await fs.rename(destination, path.join(root, "saved"));
				expect(file.retirePublishedAliasSync("published")).toMatchObject({ state: "retained", retryable: true });
				expect(await Bun.file(source).exists()).toBe(true);
				if (change !== "missing") {
					expect(await Bun.file(destination).text()).toBe(
						change === "bytes" ? "changed bytes" : "committed publication bytes",
					);
				}
			} finally {
				file.release();
				parent.release();
			}
		}
	});

	it("requires a successful seal rather than merely closed native descriptors", async () => {
		const { root, parent } = await fixture();
		const source = path.join(root, "stage", "source");
		const writer = await fs.open(source, "wx", 0o600);
		const file = parent.bindFile("source", writer.fd);
		try {
			await writer.writeFile("original bytes");
		} finally {
			await writer.close();
		}
		try {
			expect(file.retirePublishedAliasSync("published")).toMatchObject({
				state: "rejected",
				code: "successful_seal_required",
			});
			expect(file.sealSync()).toMatchObject({ state: "retained", fileClose: "closed" });
			await Bun.write(source, "changed bytes");
			expect(file.sealSync()).toMatchObject({ state: "retained", fileClose: "closed", code: "identity_mismatch" });
			await fs.link(source, path.join(root, "stage", "published"));
			expect(file.retirePublishedAliasSync("published")).toMatchObject({
				state: "rejected",
				code: "successful_seal_required",
			});
			expect(await Bun.file(source).text()).toBe("changed bytes");
		} finally {
			file.release();
			parent.release();
		}
	});

	it("ordinary discard still rejects a publication pair and excludes later alias mode", async () => {
		const { parent, file, source, destination } = await aliasFixture();
		try {
			expect(file.discardSync()).toMatchObject({ state: "retained", code: "identity_mismatch" });
			expect(file.retirePublishedAliasSync("published")).toMatchObject({
				state: "rejected",
				code: "operation_conflict",
			});
			expect(await Bun.file(source).exists()).toBe(true);
			expect(await Bun.file(destination).text()).toBe("committed publication bytes");
		} finally {
			file.release();
			parent.release();
		}
	});

	it("binds before O_WRONLY writes and proves nonempty durable unlink without touching independent data", async () => {
		const { root, parent } = await fixture();
		const source = path.join(root, "stage", "source");
		const writer = await fs.open(source, "wx", 0o600);
		const file = parent.bindFile("source", writer.fd);
		try {
			await writer.writeFile("nonempty staged bytes");
		} finally {
			await writer.close();
		}
		await Bun.write(path.join(root, "destination"), "published bytes");
		await Bun.write(path.join(root, "independent-source"), "original bytes");
		try {
			expect(parent.release()).toMatchObject({
				state: "retained",
				close: "open",
				code: "children_active",
				retryable: true,
			});
			const receipt = file.discardSync();
			expect(receipt).toMatchObject({
				state: "discarded",
				fileClose: "closed",
				durability: "confirmed",
				retryable: false,
			});
			expect(file.discardSync()).toEqual(receipt);
			expect(await fs.readdir(path.join(root, "stage"))).toEqual([]);
			expect(await Bun.file(path.join(root, "destination")).text()).toBe("published bytes");
			expect(await Bun.file(path.join(root, "independent-source")).text()).toBe("original bytes");
			expect(file.release()).toMatchObject({ state: "released", close: "closed" });
			expect(file.discardSync()).toMatchObject({ state: "released", durability: "not_provable", retryable: false });
		} finally {
			file.release();
			expect(parent.release()).toMatchObject({ state: "released", close: "closed", retryable: false });
		}
	});

	it("seals after caller close without revoking discard authority", async () => {
		const { root, parent } = await fixture();
		const writer = await fs.open(path.join(root, "stage", "source"), "wx", 0o600);
		const file = parent.bindFile("source", writer.fd);
		try {
			await writer.writeFile("sealed payload");
		} finally {
			await writer.close();
		}
		try {
			expect(file.sealSync()).toMatchObject({ state: "retained", fileClose: "closed", durability: "not_attempted" });
			expect(await Bun.file(path.join(root, "stage", "source")).text()).toBe("sealed payload");
			expect(parent.release().code).toBe("children_active");
			expect(file.discardSync()).toMatchObject({ state: "discarded", fileClose: "closed", durability: "confirmed" });
			expect(await fs.readdir(path.join(root, "stage"))).toEqual([]);
		} finally {
			file.release();
			parent.release();
		}
	});

	it("does not reauthorize altered contents through a sealed token", async () => {
		const { root, parent } = await fixture();
		const source = path.join(root, "stage", "source");
		const writer = await fs.open(source, "wx", 0o600);
		const file = parent.bindFile("source", writer.fd);
		try {
			await writer.writeFile("sealed payload");
		} finally {
			await writer.close();
		}
		try {
			expect(file.sealSync()).toMatchObject({ fileClose: "closed" });
			await Bun.write(source, "changed payload");
			expect(file.sealSync()).toMatchObject({ state: "retained", code: "identity_mismatch" });
			expect(file.discardSync()).toMatchObject({ state: "retained", code: "identity_mismatch" });
			expect(await Bun.file(source).text()).toBe("changed payload");
		} finally {
			file.release();
			parent.release();
		}
	});

	it("keeps retained parent authority when its old path names a different directory", async () => {
		const { root, parent } = await fixture();
		const writer = await fs.open(path.join(root, "stage", "source"), "wx", 0o600);
		const file = parent.bindFile("source", writer.fd);
		await writer.writeFile("original staging");
		await writer.close();
		try {
			await fs.rename(path.join(root, "stage"), path.join(root, "retained-parent"));
			await fs.mkdir(path.join(root, "stage"));
			await Bun.write(path.join(root, "stage", "source"), "replacement staging");
			expect(file.discardSync()).toMatchObject({ state: "discarded" });
			expect(await fs.readdir(path.join(root, "retained-parent"))).toEqual([]);
			expect(await Bun.file(path.join(root, "stage", "source")).text()).toBe("replacement staging");
		} finally {
			file.release();
			parent.release();
		}
	});

	it("refuses replaced or missing sources rather than turning absence into proof", async () => {
		const { root, parent } = await fixture();
		const source = path.join(root, "stage", "source");
		const original = path.join(root, "original");
		const writer = await fs.open(source, "wx", 0o600);
		const file = parent.bindFile("source", writer.fd);
		await writer.writeFile("original");
		await writer.close();
		try {
			await fs.rename(source, original);
			expect(file.discardSync()).toMatchObject({
				state: "retained",
				code: "missing_name",
				durability: "not_attempted",
			});
			await Bun.write(source, "replacement");
			expect(file.discardSync()).toMatchObject({ state: "retained", code: "identity_mismatch" });
			expect(await Bun.file(source).text()).toBe("replacement");
			expect(await Bun.file(original).text()).toBe("original");
		} finally {
			file.release();
			parent.release();
		}
	});

	it("refuses hardlinks at binding and cleanup while leaving both links intact", async () => {
		const { root, parent } = await fixture();
		const source = path.join(root, "stage", "source");
		const writer = await fs.open(source, "wx", 0o600);
		const file = parent.bindFile("source", writer.fd);
		try {
			await writer.writeFile("linked bytes");
			await fs.link(source, path.join(root, "alias"));
			expect(() => parent.bindFile("source", writer.fd)).toThrow("identity_mismatch");
		} finally {
			await writer.close();
		}
		try {
			expect(file.discardSync()).toMatchObject({ state: "retained", code: "identity_mismatch" });
			expect(await Bun.file(source).text()).toBe("linked bytes");
			expect(await Bun.file(path.join(root, "alias")).text()).toBe("linked bytes");
		} finally {
			file.release();
			parent.release();
		}
	});

	it("rejects invalid basenames, wrong descriptors, and reuse of released capabilities", async () => {
		const { root, parent } = await fixture();
		const writer = await fs.open(path.join(root, "stage", "source"), "wx", 0o600);
		const unrelated = await fs.open(path.join(root, "other"), "wx", 0o600);
		try {
			for (const name of ["", ".", "..", "../source", "nested/source", "source\0"]) {
				expect(() => parent.bindFile(name, writer.fd)).toThrow("invalid_basename");
			}
			expect(() => parent.bindFile("source", unrelated.fd)).toThrow("identity_mismatch");
			expect(() => parent.bindFile("source", -1)).toThrow("invalid_fd");
			const file = parent.bindFile("source", writer.fd);
			expect(file.release()).toMatchObject({ state: "released", close: "closed" });
			expect(file.discardSync()).toMatchObject({ state: "released", durability: "not_provable", retryable: false });
			expect(await fs.readdir(path.join(root, "stage"))).toEqual(["source"]);
		} finally {
			await writer.close();
			await unrelated.close();
			parent.release();
		}
		expect(() => parent.bindFile("source", -1)).toThrow("released_capability");
	});

	it("rejects root identity mismatch, traversal, and symlinked descendants", async () => {
		const { root, parent } = await fixture();
		parent.release();
		const expected = await fs.stat(root, { bigint: true });
		expect(() => retainStagedDirectory(root, { dev: expected.dev, ino: expected.ino + 1n }, "stage")).toThrow(
			"root_mismatch",
		);
		expect(() => retainStagedDirectory(root, expected, "../stage")).toThrow("invalid_directory");
		await fs.symlink(path.join(root, "stage"), path.join(root, "alias"));
		expect(() => retainStagedDirectory(root, expected, "alias")).toThrow("not_directory_or_symlink");
	});
});

it.skipIf(process.platform === "darwin" || process.platform === "linux")(
	"staged capability acquisition explicitly rejects unsupported platforms",
	() => {
		expect(() => retainStagedDirectory("unused", { dev: 0n, ino: 0n }, "stage")).toThrow("unsupported_platform");
	},
);

describe("native owner-only file reader", () => {
	it.skipIf(process.platform === "darwin" || process.platform === "linux")(
		"fails explicitly on unsupported platforms",
		() => {
			expect(readOwnerOnlyFile("binding.json", 65536)).toEqual({ ok: false, code: "unsupported_platform" });
		},
	);

	describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("retained private read", () => {
		async function fixture(contents: Uint8Array = Buffer.from('{"binding":true}\n')) {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-owner-read-"));
			temporaryDirectories.push(root);
			await fs.chmod(root, 0o700);
			const file = path.join(root, "binding.json");
			await fs.writeFile(file, contents, { mode: 0o600 });
			return { root, file, contents };
		}

		it("returns only exact bytes and leaves bytes and security unchanged", async () => {
			const { file, contents } = await fixture();
			const before = await fs.stat(file);
			const result = readOwnerOnlyFile(file, 65536);
			expect(result.ok).toBe(true);
			expect(result.data).toBeInstanceOf(Uint8Array);
			if (!result.data) throw new Error("successful read must return bytes");
			expect(Buffer.from(result.data)).toEqual(Buffer.from(contents));
			expect(Object.keys(result).sort()).toEqual(["data", "ok"]);
			const after = await fs.stat(file);
			expect([after.mode, after.ino, after.size, after.mtimeMs, after.ctimeMs]).toEqual([
				before.mode,
				before.ino,
				before.size,
				before.mtimeMs,
				before.ctimeMs,
			]);
			expect(await fs.readFile(file)).toEqual(Buffer.from(contents));
		});

		it("enforces exact nonzero byte and numeric limits without coercion", async () => {
			const { file } = await fixture(Buffer.alloc(65536, 42));
			expect(readOwnerOnlyFile(file, 65536).data?.length).toBe(65536);
			expect(readOwnerOnlyFile(file, 65535)).toEqual({ ok: false, code: "invalid_size" });
			for (const limit of [0, -1, 0.5, 65537, 2 ** 32 + 65536, NaN, Infinity]) {
				expect(readOwnerOnlyFile(file, limit)).toEqual({ ok: false, code: "invalid_limit" });
			}
			for (const size of [0, 65537]) {
				await fs.writeFile(file, Buffer.alloc(size));
				expect(readOwnerOnlyFile(file, 65536)).toEqual({ ok: false, code: "invalid_size" });
			}
			await fs.writeFile(file, Buffer.from([255]));
			expect(readOwnerOnlyFile(file, 1).data).toEqual(new Uint8Array([255]));
		});

		it("rejects unsafe file and lifecycle modes without repairing them", async () => {
			const { root, file } = await fixture();
			for (const [target, mode, restore] of [
				[file, 0o640, 0o600],
				[file, 0o4600, 0o600],
				[root, 0o755, 0o700],
			] as const) {
				await fs.chmod(target, mode);
				expect(readOwnerOnlyFile(file, 65536)).toEqual({ ok: false, code: "unsafe_security" });
				expect((await fs.stat(target)).mode & 0o7777).toBe(mode);
				await fs.chmod(target, restore);
			}
		});

		it("rejects leaf and ancestor symlinks, hardlinks, traversal, NUL and directories", async () => {
			const { root, file } = await fixture();
			const alias = path.join(root, "alias");
			await fs.symlink(file, alias);
			expect(readOwnerOnlyFile(alias, 65536)).toEqual({ ok: false, code: "unsafe_path" });
			const directoryAlias = path.join(root, "directory-alias");
			await fs.symlink(root, directoryAlias);
			expect(readOwnerOnlyFile(path.join(directoryAlias, "binding.json"), 65536)).toEqual({
				ok: false,
				code: "unsafe_path",
			});
			expect(readOwnerOnlyFile(`${root}/../${path.basename(root)}/binding.json`, 65536)).toEqual({
				ok: false,
				code: "unsafe_path",
			});
			expect(readOwnerOnlyFile(`${file}\0`, 65536)).toEqual({ ok: false, code: "invalid_path" });
			expect(readOwnerOnlyFile(root, 65536)).toEqual({ ok: false, code: "unsafe_path" });
			await fs.link(file, path.join(root, "hardlink"));
			expect(readOwnerOnlyFile(file, 65536)).toEqual({ ok: false, code: "unsafe_file" });
		});

		it.skipIf(process.getuid?.() !== 0)("rejects a different owner even when root can read the file", async () => {
			const { file } = await fixture();
			await fs.chown(file, 65534, 65534);
			expect(readOwnerOnlyFile(file, 65536)).toEqual({ ok: false, code: "unsafe_security" });
		});

		it.skipIf(process.platform !== "darwin")("allows only the exact macOS system aliases", async () => {
			const root = await fs.mkdtemp("/tmp/pi-owner-read-");
			temporaryDirectories.push(root);
			const file = path.join(root, "binding.json");
			await fs.writeFile(file, "binding", { mode: 0o600 });
			expect(readOwnerOnlyFile(file, 65536).ok).toBe(true);
			expect(readOwnerOnlyFile(`/private${file}`, 65536).data).toEqual(readOwnerOnlyFile(file, 65536).data);
		});

		it.skipIf(process.platform !== "darwin")("rejects read-denying ACLs without write retry or repair", async () => {
			const { file } = await fixture();
			const installed = Bun.spawnSync(["/bin/chmod", "+a", "everyone deny read", file]);
			expect(installed.exitCode).toBe(0);
			try {
				expect(readOwnerOnlyFile(file, 65536)).toEqual({ ok: false, code: "unsafe_path" });
				expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "acl_verify_failed" });
			} finally {
				expect(Bun.spawnSync(["/bin/chmod", "-N", file]).exitCode).toBe(0);
			}
		});
	});
});

describe.skipIf(process.platform === "win32")("POSIX native path identity", () => {
	it("removes only non-owner bits and verifies the exact file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const file = path.join(root, "config.json");
		await fs.writeFile(file, "{}", { mode: 0o644 });
		await fs.chmod(file, 0o644);
		const stat = await fs.stat(file, { bigint: true });
		const parent = await fs.stat(root, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			parentDev: parent.dev,
			parentIno: parent.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("{}"),
		};
		expect(inspectConfigFilePermissionRepair(file, identity, Number(stat.mode))).toMatchObject({
			status: "ready",
			changed: false,
			verified: false,
		});
		expect(repairConfigFilePermissions(file, identity, Number(stat.mode))).toEqual({
			status: "changed",
			changed: true,
			verified: true,
		});
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		expect(
			inspectConfigFilePermissionRepair(file, identity, Number((await fs.stat(file, { bigint: true })).mode)),
		).toMatchObject({ status: "verified", changed: false, verified: true });
	});

	it("refuses links, hardlinks, and shared-writable parents", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const file = path.join(root, "config.json");
		await fs.writeFile(file, "{}", { mode: 0o644 });
		await fs.link(file, `${file}.hard`);
		const stat = await fs.stat(file, { bigint: true });
		const parent = await fs.stat(root, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			parentDev: parent.dev,
			parentIno: parent.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("{}"),
		};
		expect(inspectConfigFilePermissionRepair(file, identity, Number(stat.mode))).toMatchObject({
			status: "refused",
			code: "hardlink",
		});
		await fs.unlink(`${file}.hard`);
		await fs.symlink(file, `${file}.link`);
		expect(inspectConfigFilePermissionRepair(`${file}.link`, identity, Number(stat.mode))).toMatchObject({
			status: "refused",
		});
		await fs.unlink(`${file}.link`);
		await fs.chmod(root, 0o777);
		const current = await fs.stat(file, { bigint: true });
		expect(
			inspectConfigFilePermissionRepair(file, { ...identity, nlink: current.nlink }, Number(current.mode)),
		).toMatchObject({ status: "refused", code: "parent_shared_writable" });
	});
	it("rejects an existing directory whose canonical byte path is not UTF-8", async () => {
		if (process.platform === "darwin") return;
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

		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "mode_mismatch" });
	});

	it("applies and verifies exact owner-only modes without changing regular-file bytes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const directory = path.join(root, "managed");
		const file = path.join(directory, "state.json");
		const contents = '{"preserve":"payload"}';
		await fs.mkdir(directory, { mode: 0o755 });
		await fs.writeFile(file, contents, { mode: 0o644 });
		await fs.chmod(file, 0o400);

		expectOwnerOnlySuccess(applyOwnerOnlyPathSecurity(directory, "directory"), "directory");
		expectOwnerOnlySuccess(applyOwnerOnlyPathSecurity(file, "file"), "file");
		expectOwnerOnlySuccess(verifyOwnerOnlyPathSecurity(directory, "directory"), "directory", "verify");
		expectOwnerOnlySuccess(verifyOwnerOnlyPathSecurity(file, "file"), "file", "verify");
		expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});

	it.skipIf(process.platform !== "darwin")("uses native ACL APIs for owner-only access", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const file = path.join(root, "state.json");
		await fs.writeFile(file, "{}", { mode: 0o644 });

		expectOwnerOnlySuccess(applyOwnerOnlyPathSecurity(file, "file"), "file");
		expectOwnerOnlySuccess(verifyOwnerOnlyPathSecurity(file, "file"), "file", "verify");
	});

	it("reports a wrong expected kind without mutating the opened directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const directory = path.join(root, "managed");
		await fs.mkdir(directory, { mode: 0o755 });
		await fs.chmod(directory, 0o755);

		expect(applyOwnerOnlyPathSecurity(directory, "file")).toEqual({
			ok: false,
			code: "not_directory",
		});
		expect((await fs.stat(directory)).mode & 0o777).toBe(0o755);
	});
	it("rejects a FIFO without blocking on open", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const fifo = path.join(root, "state.fifo");
		const created = Bun.spawnSync(["mkfifo", fifo]);
		expect(created.exitCode, created.stderr.toString()).toBe(0);

		expect(verifyOwnerOnlyPathSecurity(fifo, "file")).toEqual({ ok: false, code: "not_directory" });
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

	it("directly removes one authorized regular file without leaving exchange debris", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const file = path.join(root, "stale-debris");
		const directQuarantine = ".gjc-direct-unlink-test";
		await fs.writeFile(file, "stale");
		const stat = await fs.stat(file, { bigint: true });
		const parent = await fs.stat(root, { bigint: true });

		expect(
			exactUnlinkDirect(file, {
				dev: stat.dev,
				ino: stat.ino,
				parentDev: parent.dev,
				parentIno: parent.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("stale"),
				quarantineName: directQuarantine,
			}),
		).toEqual({ ok: true });
		await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(root, directQuarantine))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes one authorized hard-link name without deleting the remaining alias", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const staged = path.join(root, "staged.bin");
		const published = path.join(root, "published.bin");
		await fs.writeFile(staged, "authorized");
		await fs.link(staged, published);
		const stat = await fs.stat(staged, { bigint: true });
		const parent = await fs.stat(root, { bigint: true });
		const cleanup = exactUnlink(staged, {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			parentDev: parent.dev,
			parentIno: parent.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
			quarantineName: "staged.bin.cleanup",
			allowHardLink: true,
		});
		// The authorized alias is fully removed, so no quarantine copy is retained.
		expect(cleanup).toEqual({ ok: true });
		await expect(fs.stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(root, "staged.bin.cleanup"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(published, "utf8")).toBe("authorized");
	});

	it("keeps allowHardLink permissive for one-link cleanup while requiring aliases explicitly", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
		temporaryDirectories.push(root);
		const file = path.join(root, "single-link.tmp");
		await fs.writeFile(file, "authorized");
		const stat = await fs.stat(file, { bigint: true });
		const parent = await fs.stat(root, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			parentDev: parent.dev,
			parentIno: parent.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
			quarantineName: "single-link.tmp.cleanup",
			allowHardLink: true,
		};

		expect(exactUnlinkDirect(file, { ...identity, requireHardLink: true })).toEqual({
			ok: false,
			code: "identity_mismatch",
		});
		expect(await fs.readFile(file, "utf8")).toBe("authorized");
		expect(exactUnlinkDirect(file, identity)).toEqual({ ok: true });
		await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
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
		"rejects hard-linked regular files before exact detach or restore",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-posix-"));
			temporaryDirectories.push(root);
			const original = path.join(root, "session.jsonl");
			const originalAlias = path.join(root, "session-alias.jsonl");
			const detached = path.join(root, ".gjc-delete-session");
			await fs.writeFile(original, "authorized");
			await fs.link(original, originalAlias);
			const originalStat = await fs.stat(original, { bigint: true });
			const identity = {
				dev: originalStat.dev,
				ino: originalStat.ino,
				size: originalStat.size,
				mtimeNs: originalStat.mtimeNs,
				sha256: sha256("authorized"),
				quarantineName: path.basename(detached),
				detachOnly: true,
			};

			expect(exactUnlink(original, identity)).toEqual({ ok: false, code: "hard_link_unsupported" });
			expect(await fs.readFile(original, "utf8")).toBe("authorized");
			expect(await fs.readFile(originalAlias, "utf8")).toBe("authorized");

			await fs.rm(originalAlias);
			expectDetachedCleanupPending(exactUnlink(original, identity), detached);
			const detachedAlias = path.join(root, "detached-alias.jsonl");
			await fs.link(detached, detachedAlias);
			expect(exactRestore(detached, original, identity)).toEqual({ ok: false, code: "hard_link_unsupported" });
			expect(await fs.readFile(detached, "utf8")).toBe("authorized");
			expect(await fs.readFile(detachedAlias, "utf8")).toBe("authorized");
		},
	);

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
			expectDetachedCleanupPending(result, path.join(root, quarantineName));

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

			const result = exactUnlink(original, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256(contents),
				quarantineName: path.basename(detached),
				detachOnly: true,
			});
			expectDetachedCleanupPending(result, detached);

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

			expectDetachedCleanupPending(exactUnlink(original, identity), detached);

			expect(exactRestore(detached, original, identity)).toMatchObject({ ok: true });
			expect(await fs.readFile(original, "utf8")).toBe("authorized");
			expect((await fs.readdir(root)).sort()).toEqual([path.basename(original)]);
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

			expectDetachedCleanupPending(exactUnlink(original, identity), detached);

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

			expectDetachedCleanupPending(exactUnlink(original, identity), detached);

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

	for (const location of ["immediate", "intermediate"] as const) {
		it(`rejects direct unlink through a replaced ${location} parent symlink`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-direct-unlink-parent-"));
			temporaryDirectories.push(root);
			const ancestor = path.join(root, "managed");
			const parent = path.join(ancestor, "nested");
			const file = path.join(parent, "state.jsonl");
			await fs.mkdir(parent, { recursive: true });
			await fs.writeFile(file, "authorized");
			const stat = await fs.stat(file, { bigint: true });
			const parentStat = await fs.stat(parent, { bigint: true });
			const identity: NativeExactFileIdentity = {
				dev: stat.dev,
				ino: stat.ino,
				nlink: stat.nlink,
				parentDev: parentStat.dev,
				parentIno: parentStat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("authorized"),
				quarantineName: ".direct-unlink-quarantine",
			};
			const replaced = location === "immediate" ? parent : ancestor;
			const retained = `${replaced}-retained`;
			const foreign = path.join(root, "foreign");
			const relativeFile = path.relative(replaced, file);
			const foreignFile = path.join(foreign, relativeFile);
			await fs.mkdir(path.dirname(foreignFile), { recursive: true });
			await fs.writeFile(foreignFile, "foreign payload");
			await fs.rename(replaced, retained);
			await fs.symlink(foreign, replaced, "dir");

			expect(exactUnlinkDirect(file, identity)).toEqual({ ok: false, code: "reparse_point" });
			expect(await fs.readFile(foreignFile, "utf8")).toBe("foreign payload");
			expect(await fs.readFile(path.join(retained, relativeFile), "utf8")).toBe("authorized");
			await expect(fs.stat(path.join(path.dirname(foreignFile), identity.quarantineName!))).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
	}

	for (const replacement of ["missing", "regular"] as const) {
		it(`preserves a ${replacement} ancestor open failure without deleting retained payload`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-direct-unlink-failed-parent-"));
			temporaryDirectories.push(root);
			const parent = path.join(root, "parent");
			const file = path.join(parent, "state.jsonl");
			await fs.mkdir(parent);
			await fs.writeFile(file, "authorized");
			const stat = await fs.stat(file, { bigint: true });
			const parentStat = await fs.stat(parent, { bigint: true });
			await fs.rename(parent, `${parent}-retained`);
			if (replacement === "regular") await fs.writeFile(parent, "not a directory");
			expect(
				exactUnlinkDirect(file, {
					dev: stat.dev,
					ino: stat.ino,
					parentDev: parentStat.dev,
					parentIno: parentStat.ino,
					size: stat.size,
					mtimeNs: stat.mtimeNs,
					sha256: sha256("authorized"),
					quarantineName: ".direct-unlink-quarantine",
				}),
			).toEqual({ ok: false, code: replacement === "missing" ? "not_found" : "not_directory" });
			expect(await fs.readFile(path.join(`${parent}-retained`, "state.jsonl"), "utf8")).toBe("authorized");
			if (replacement === "regular") expect(await fs.readFile(parent, "utf8")).toBe("not a directory");
		});
	}

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
			expectTreeCleanupPending(exactRemoveDirectoryTree(detached, snapshot.snapshot), detached);

			expect(
				await fs.stat(detached).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(await fs.stat(`${detached}.removing`).then(stat => stat.isDirectory())).toBe(true);
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
			expectTreeCleanupPending(exactRemoveDirectoryTree(detached, snapshot.snapshot), detached);
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
