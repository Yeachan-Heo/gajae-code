import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as natives from "@gajae-code/natives";
import { $ } from "bun";
import { getSecureLocalAuthority, tryGetSecureLocalAuthority } from "../src/sdk/secure-local-authority";

const native = require("@gajae-code/natives") as typeof natives;
const roots: string[] = [];

async function fixture(): Promise<{ root: string; directory: string; file: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-windows-authority-"));
	roots.push(root);
	return { root, directory: path.join(root, "sdk"), file: path.join(root, "sdk", "secure-local-authority.key") };
}

async function expectPrivate(file: string, kind: "directory" | "file"): Promise<void> {
	const identity = await fs.lstat(file, { bigint: true });
	expect(native.verifyOwnerOnlyPathSecurityExpected(file, kind, identity.dev, identity.ino)).toEqual({ ok: true });
}

describe.skipIf(process.platform !== "win32")("secure-local authority on native Windows", () => {
	afterEach(async () => {
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	});

	test("protects an inherited shared SDK directory and publishes one private key across competing creators", async () => {
		const { root, directory, file } = await fixture();
		await fs.mkdir(directory);
		const keys = await Promise.all(Array.from({ length: 8 }, () => getSecureLocalAuthority(root)));
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
		expect(await fs.readFile(file)).toHaveLength(32);
		expect(await getSecureLocalAuthority(root)).toBe(keys[0]!);
		await expectPrivate(directory, "directory");
		await expectPrivate(file, "file");
		expect(await fs.readdir(directory)).toEqual(["secure-local-authority.key"]);
	});

	test("narrows a trusted SDK directory DACL without rotating an already private key", async () => {
		const { root, directory, file } = await fixture();
		const key = await getSecureLocalAuthority(root);
		await $`icacls ${directory} /grant ${"*S-1-1-0:(RX)"}`.quiet();
		const identity = await fs.lstat(directory, { bigint: true });
		expect(native.verifyOwnerOnlyPathSecurityExpected(directory, "directory", identity.dev, identity.ino)).toEqual({
			ok: false,
			code: "acl_verify_failed",
		});
		expect(await getSecureLocalAuthority(root)).toBe(key);
		await expectPrivate(directory, "directory");
		await expectPrivate(file, "file");
	});

	test("refuses a disclosed existing key without repairing, replacing or accepting it", async () => {
		const { root, file } = await fixture();
		await getSecureLocalAuthority(root);
		const bytes = await fs.readFile(file);
		await $`icacls ${file} /grant ${"*S-1-1-0:(R)"}`.quiet();
		const identity = await fs.lstat(file, { bigint: true });
		await expect(getSecureLocalAuthority(root)).rejects.toThrow("private regular");
		expect(await tryGetSecureLocalAuthority(root)).toBeUndefined();
		expect(await fs.readFile(file)).toEqual(bytes);
		expect(native.verifyOwnerOnlyPathSecurityExpected(file, "file", identity.dev, identity.ino)).toEqual({
			ok: false,
			code: "acl_verify_failed",
		});
	});

	test("rejects wrong key lengths and non-file keys without overwriting them", async () => {
		const { root, file } = await fixture();
		await getSecureLocalAuthority(root);
		for (const size of [0, 31, 33]) {
			const bytes = Buffer.alloc(size, 7);
			await fs.writeFile(file, bytes);
			await expect(getSecureLocalAuthority(root)).rejects.toThrow("private regular");
			expect(await fs.readFile(file)).toEqual(bytes);
		}
		await fs.unlink(file);
		await fs.mkdir(file);
		await expect(getSecureLocalAuthority(root)).rejects.toThrow("private regular");
		expect((await fs.lstat(file)).isDirectory()).toBe(true);
	});

	test("does not take over a foreign-owned SDK directory", async () => {
		const { root, directory, file } = await fixture();
		await getSecureLocalAuthority(root);
		const bytes = await fs.readFile(file);
		const user = process.env.USERNAME;
		if (!user) throw new Error("Missing Windows username");
		try {
			await $`icacls ${directory} /setowner ${"*S-1-5-18"}`.quiet();
			await expect(getSecureLocalAuthority(root)).rejects.toThrow("privacy could not be established");
			expect(await tryGetSecureLocalAuthority(root)).toBeUndefined();
			const identity = await fs.lstat(directory, { bigint: true });
			expect(native.verifyOwnerOnlyPathSecurityExpected(directory, "directory", identity.dev, identity.ino)).toEqual(
				{
					ok: false,
					code: "owner_mismatch",
				},
			);
			expect(await fs.readFile(file)).toEqual(bytes);
		} finally {
			await $`icacls ${directory} /setowner ${user}`.quiet();
		}
	});

	test("rejects a shared-directory junction without modifying its target", async () => {
		const { root, directory } = await fixture();
		const target = path.join(root, "target");
		await fs.mkdir(target);
		const file = path.join(target, "secure-local-authority.key");
		const bytes = Buffer.alloc(32, 8);
		await fs.writeFile(file, bytes);
		await fs.symlink(target, directory, "junction");
		await expect(getSecureLocalAuthority(root)).rejects.toThrow("directory is not trusted");
		expect(await fs.readFile(file)).toEqual(bytes);
	});

	test("fails closed before publishing when descriptor-bound ACL verification is unavailable", async () => {
		const { root, directory, file } = await fixture();
		const verification = spyOn(native, "verifyOwnerOnlyFdSecurity").mockReturnValue({
			ok: false,
			code: "identity_unavailable",
		});
		try {
			await expect(getSecureLocalAuthority(root)).rejects.toThrow("temporary key is not private");
			expect(await tryGetSecureLocalAuthority(root)).toBeUndefined();
			expect(await Bun.file(file).exists()).toBe(false);
			expect(await fs.readdir(directory)).toEqual([]);
		} finally {
			verification.mockRestore();
		}
	});
});
