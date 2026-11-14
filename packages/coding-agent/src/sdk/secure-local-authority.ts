import { randomBytes, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as natives from "@gajae-code/natives";

type NativeAuthoritySecurity = Pick<
	typeof natives,
	"verifyOwnerOnlyPathSecurityExpected" | "repairOwnerOnlyPathSecurityExpected" | "verifyOwnerOnlyFdSecurity"
>;

function windowsSecurity(): NativeAuthoritySecurity {
	return require("@gajae-code/natives") as NativeAuthoritySecurity;
}

function isCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function establishWindowsPrivacy(file: string, kind: "directory" | "file", identity: BigIntStats): void {
	const native = windowsSecurity();
	const verified = native.verifyOwnerOnlyPathSecurityExpected(file, kind, identity.dev, identity.ino);
	if (!verified.ok) {
		// Narrow a trusted owner's inherited DACL, never take over a foreign
		// object. Only the shared SDK directory or our new empty temporary key
		// may be repaired; an existing authority key is always verification-only.
		if (
			verified.code !== "acl_verify_failed" ||
			!native.repairOwnerOnlyPathSecurityExpected(file, kind, identity.dev, identity.ino).ok
		)
			throw new Error("Secure-local SDK authority privacy could not be established.");
	}
	if (!native.verifyOwnerOnlyPathSecurityExpected(file, kind, identity.dev, identity.ino).ok)
		throw new Error("Secure-local SDK authority privacy could not be verified.");
}

/** Hosting remains available without authority; sensitive operations must stay uninstalled. */
export async function tryGetSecureLocalAuthority(agentDir: string): Promise<string | undefined> {
	try {
		return await getSecureLocalAuthority(agentDir);
	} catch {
		return undefined;
	}
}

/** SDK-owned authority; agentDir must come from trusted host configuration, never a request. */
export async function getSecureLocalAuthority(agentDir: string): Promise<string> {
	const windows = process.platform === "win32";
	const directory = path.join(agentDir, "sdk");
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	try {
		await fs.mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if (!isCode(error, "EEXIST")) throw error;
	}
	const directoryStat = await fs.lstat(directory, { bigint: true });
	if (
		!directoryStat.isDirectory() ||
		(!windows &&
			((directoryStat.mode & 0o022n) !== 0n ||
				(process.getuid !== undefined && directoryStat.uid !== BigInt(process.getuid()))))
	)
		throw new Error("Secure-local SDK authority directory is not trusted.");
	if (windows) establishWindowsPrivacy(directory, "directory", directoryStat);
	const verifyDirectory = async (): Promise<void> => {
		const current = await fs.lstat(directory, { bigint: true });
		if (
			!current.isDirectory() ||
			current.dev !== directoryStat.dev ||
			current.ino !== directoryStat.ino ||
			(windows &&
				!windowsSecurity().verifyOwnerOnlyPathSecurityExpected(
					directory,
					"directory",
					directoryStat.dev,
					directoryStat.ino,
				).ok)
		)
			throw new Error("Secure-local SDK authority directory changed.");
	};
	const file = path.join(directory, "secure-local-authority.key");
	const read = async (): Promise<string> => {
		await verifyDirectory();
		const entry = await fs.lstat(file, { bigint: true });
		if (!entry.isFile()) throw new Error("Secure-local SDK authority key must be a private regular 32-byte file.");
		const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat({ bigint: true });
			if (
				!stat.isFile() ||
				stat.dev !== entry.dev ||
				stat.ino !== entry.ino ||
				stat.size !== 32n ||
				(windows
					? !windowsSecurity().verifyOwnerOnlyFdSecurity(file, "file", handle.fd).ok
					: (stat.mode & 0o7777n) !== 0o600n ||
						(process.getuid !== undefined && stat.uid !== BigInt(process.getuid())))
			)
				throw new Error("Secure-local SDK authority key must be a private regular 32-byte file.");
			const key = await handle.readFile();
			if (key.length !== 32) throw new Error("Secure-local SDK authority key changed during read.");
			if (windows && !windowsSecurity().verifyOwnerOnlyFdSecurity(file, "file", handle.fd).ok)
				throw new Error("Secure-local SDK authority key changed during read.");
			await verifyDirectory();
			return key.toString("hex");
		} finally {
			await handle.close();
		}
	};
	try {
		return await read();
	} catch (error) {
		if (!isCode(error, "ENOENT")) throw error;
	}
	// Publish a complete key with an exclusive hard link: competing creators can
	// only read a fully written winner, and an existing key is never overwritten.
	const temporary = path.join(directory, `.secure-local-authority.${randomUUID()}.tmp`);
	await verifyDirectory();
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		try {
			if (windows) {
				const empty = await handle.stat({ bigint: true });
				if (!empty.isFile() || empty.size !== 0n)
					throw new Error("Secure-local SDK authority temporary key is not empty.");
				establishWindowsPrivacy(temporary, "file", empty);
				if (!windowsSecurity().verifyOwnerOnlyFdSecurity(temporary, "file", handle.fd).ok)
					throw new Error("Secure-local SDK authority temporary key is not private.");
			}
			await verifyDirectory();
			await handle.writeFile(randomBytes(32));
			await handle.sync();
			if (windows && !windowsSecurity().verifyOwnerOnlyFdSecurity(temporary, "file", handle.fd).ok)
				throw new Error("Secure-local SDK authority temporary key changed.");
		} finally {
			await handle.close();
		}
		await verifyDirectory();
		try {
			await fs.link(temporary, file);
		} catch (error) {
			if (!isCode(error, "EEXIST")) throw error;
		}
		return await read();
	} finally {
		await fs.unlink(temporary);
	}
}
