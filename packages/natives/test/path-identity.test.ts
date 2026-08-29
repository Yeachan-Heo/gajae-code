import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyOwnerOnlyPathSecurity,
	canonicalExistingDirectoryIdentity,
	digestExactRegularFile,
	digestExactRegularFileAsync,
	exactReplacePath,
	exactReplacePathAsync,
	type NativeExactFileIdentity,
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
});

describe("exactReplacePathAsync", () => {
	function sha256(contents: string): string {
		return createHash("sha256").update(contents).digest("hex");
	}

	async function exactIdentity(pathname: string, contents: string): Promise<NativeExactFileIdentity> {
		const stat = await fs.stat(pathname, { bigint: true });
		const parent = await fs.stat(path.dirname(pathname), { bigint: true });
		return {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			parentDev: parent.dev,
			parentIno: parent.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256(contents),
		};
	}

	it("matches exactReplacePath on success and identity_mismatch", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged.json");
		const destination = path.join(root, "state.json");
		await fs.writeFile(source, "new-state");
		await fs.writeFile(destination, "old-state");
		const expectedSource = await exactIdentity(source, "new-state");
		const expectedDestination = await exactIdentity(destination, "old-state");
		expect(await exactReplacePathAsync(source, destination, expectedSource, expectedDestination)).toEqual({
			ok: true,
		});
		expect(await fs.readFile(destination, "utf8")).toBe("new-state");

		const refusedSource = path.join(root, "staged-refused.json");
		const refusedDestination = path.join(root, "state-refused.json");
		await fs.writeFile(refusedSource, "new-state");
		await fs.writeFile(refusedDestination, "old-state");
		const refusedExpectedSource = await exactIdentity(refusedSource, "new-state");
		const refusedExpectedDestination = await exactIdentity(refusedDestination, "old-state");
		refusedExpectedDestination.sha256 = sha256("not-old-state");
		const syncRefused = exactReplacePath(
			refusedSource,
			refusedDestination,
			refusedExpectedSource,
			refusedExpectedDestination,
		);
		const asyncSource = path.join(root, "staged-refused-async.json");
		const asyncDestination = path.join(root, "state-refused-async.json");
		await fs.writeFile(asyncSource, "new-state");
		await fs.writeFile(asyncDestination, "old-state");
		const asyncExpectedSource = await exactIdentity(asyncSource, "new-state");
		const asyncExpectedDestination = await exactIdentity(asyncDestination, "old-state");
		asyncExpectedDestination.sha256 = sha256("not-old-state");
		const asyncRefused = await exactReplacePathAsync(
			asyncSource,
			asyncDestination,
			asyncExpectedSource,
			asyncExpectedDestination,
		);
		expect(asyncRefused).toEqual(syncRefused);
		expect(syncRefused).toMatchObject({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(refusedDestination, "utf8")).toBe("old-state");
		expect(await fs.readFile(asyncDestination, "utf8")).toBe("old-state");
	});
});

describe("digestExactRegularFile", () => {
	it("returns known SHA-256 answers and rejects a symlink", async () => {
		const root = await temporaryDirectory();
		const empty = path.join(root, "empty");
		const abc = path.join(root, "abc");
		const alias = path.join(root, "alias");
		await fs.writeFile(empty, "");
		await fs.writeFile(abc, "abc");
		await fs.symlink(abc, alias);

		const emptyDigest = digestExactRegularFile(empty);
		expect(emptyDigest).toMatchObject({
			ok: true,
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		});
		const emptyStat = await fs.lstat(empty, { bigint: true });
		expect(emptyDigest.size).toBe(emptyStat.size.toString());
		expect(emptyDigest.dev).toBe(emptyStat.dev.toString());
		expect(emptyDigest.ino).toBe(emptyStat.ino.toString());

		expect(digestExactRegularFile(abc)).toMatchObject({
			ok: true,
			sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		});
		expect(await digestExactRegularFileAsync(abc)).toEqual(digestExactRegularFile(abc));

		expect(digestExactRegularFile(alias).ok).toBe(false);
		expect(digestExactRegularFile(path.join(root, "missing"))).toMatchObject({
			ok: false,
			code: "not_found",
		});
	});

	it.skipIf(process.platform !== "linux")("rejects an in-place mutation that races an async digest", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "large");
		const size = 256 * 1024 * 1024;
		const initial = await fs.open(file, "w");
		try {
			await initial.truncate(size);
		} finally {
			await initial.close();
		}

		const digest = digestExactRegularFileAsync(file);
		await Bun.sleep(2);
		const handle = await fs.open(file, "r+");
		const chunk = Buffer.alloc(4 * 1024 * 1024, 0x62);
		try {
			for (let offset = 0; offset < size; offset += chunk.length) {
				await handle.write(chunk, 0, chunk.length, offset);
			}
		} finally {
			await handle.close();
		}

		expect(await digest).toEqual({ ok: false, code: "identity_mismatch" });
	});
});
