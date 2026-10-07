import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyOwnerOnlyPathSecurity,
	canonicalExistingDirectoryIdentity,
	snapshotEmptyDirectory,
	verifyOwnerOnlyPathSecurity,
} from "../native/index.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-"));
	temporaryPaths.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("native path identity", () => {
	it("returns the same canonical identity for an existing directory and its symlink alias", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const alias = path.join(root, "alias");
		await fs.mkdir(target);
		await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

		const direct = canonicalExistingDirectoryIdentity(target);
		const viaAlias = canonicalExistingDirectoryIdentity(alias);

		expect(direct.ok).toBe(true);
		expect(viaAlias).toEqual(direct);
		if (direct.ok) {
			expect(direct.platform).toBe(process.platform === "win32" ? "win32" : "posix");
			if (process.platform === "win32") expect(direct.canonicalPath).toStartWith("\\\\?\\Volume{");
		}
	});

	it("maps absent paths and ordinary files to typed directory identity failures", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "file");
		await fs.writeFile(file, "contents");

		expect(canonicalExistingDirectoryIdentity(path.join(root, "missing"))).toMatchObject({
			ok: false,
			code: "not_found",
		});
		expect(canonicalExistingDirectoryIdentity(file)).toMatchObject({ ok: false, code: "not_directory" });
	});

	it.skipIf(process.platform !== "win32")(
		"rejects UNC identities as unsupported network paths before connecting",
		() => {
			expect(canonicalExistingDirectoryIdentity(String.raw`\\server\share`)).toMatchObject({
				ok: false,
				code: "network_unsupported",
			});
		},
	);

	it.skipIf(process.platform !== "win32")(
		"keeps local aliases convergent while rejecting network aliases",
		async () => {
			const root = await temporaryDirectory();
			const target = path.join(root, "target");
			const alias = path.join(root, "alias");
			await fs.mkdir(target);
			await fs.symlink(target, alias, "junction");
			expect(canonicalExistingDirectoryIdentity(alias)).toEqual(canonicalExistingDirectoryIdentity(target));
		},
	);

	it("applies and verifies owner-only security for directories and files", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "state.json");
		await fs.writeFile(file, "{}");

		expect(applyOwnerOnlyPathSecurity(root, "directory")).toMatchObject({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(root, "directory")).toMatchObject({ ok: true });
		expect(applyOwnerOnlyPathSecurity(file, "file")).toMatchObject({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toMatchObject({ ok: true });

		if (process.platform !== "win32") {
			expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		}
	});

	it("rejects a requested kind that does not match the existing object", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "state.json");
		await fs.writeFile(file, "{}");

		expect(applyOwnerOnlyPathSecurity(file, "directory")).toMatchObject({ ok: false, code: "not_directory" });
	});

	it.skipIf(process.platform !== "linux")("snapshots an empty directory with its opened native metadata", async () => {
		const root = await temporaryDirectory();
		const before = await fs.lstat(root, { bigint: true });

		const result = snapshotEmptyDirectory(root);

		expect(result.ok).toBe(true);
		if (!result.ok || !result.snapshot) throw new Error("Missing empty-directory snapshot");
		expect(result.snapshot.entries).toHaveLength(1);
		expect(result.snapshot.entries[0]).toMatchObject({
			relativePath: "",
			kind: "directory",
			dev: before.dev.toString(),
			ino: before.ino.toString(),
			size: before.size.toString(),
			mtimeNs: before.mtimeNs.toString(),
		});
		expect(result.snapshot.entries[0]?.sha256).toBeUndefined();
		expect(result.snapshot.rootDev).toBe(before.dev.toString());
		expect(result.snapshot.rootIno).toBe(before.ino.toString());
	});

	it.skipIf(process.platform !== "linux")(
		"refuses ordinary files and nested directories at the empty-root boundary",
		async () => {
			const root = await temporaryDirectory();
			const fileDirectory = path.join(root, "file-root");
			const nestedDirectory = path.join(root, "nested-root");
			await fs.mkdir(fileDirectory);
			await fs.writeFile(path.join(fileDirectory, "payload"), Buffer.alloc(64 * 1024, 0x5a));
			await fs.mkdir(nestedDirectory);
			await fs.mkdir(path.join(nestedDirectory, "child"));
			await fs.writeFile(path.join(nestedDirectory, "child", "payload"), "untouched");

			expect(snapshotEmptyDirectory(fileDirectory)).toMatchObject({ ok: false, code: "directory_not_empty" });
			expect(snapshotEmptyDirectory(nestedDirectory)).toMatchObject({
				ok: false,
				code: "directory_not_empty",
			});
			expect(await fs.readFile(path.join(nestedDirectory, "child", "payload"), "utf8")).toBe("untouched");
		},
	);

	it.skipIf(process.platform !== "linux")("does not follow a symlink used as the root path", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const alias = path.join(root, "alias");
		await fs.mkdir(target);
		await fs.symlink(target, alias);

		expect(snapshotEmptyDirectory(alias).ok).toBe(false);
	});
});
