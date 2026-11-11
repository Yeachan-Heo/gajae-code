import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function isCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
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
	const directory = path.join(agentDir, "sdk");
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	try {
		await fs.mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if (!isCode(error, "EEXIST")) throw error;
	}
	const directoryStat = await fs.lstat(directory);
	if (
		!directoryStat.isDirectory() ||
		(directoryStat.mode & 0o022) !== 0 ||
		(process.getuid !== undefined && directoryStat.uid !== process.getuid())
	)
		throw new Error("Secure-local SDK authority directory is not trusted.");
	const file = path.join(directory, "secure-local-authority.key");
	const read = async (): Promise<string> => {
		const entry = await fs.lstat(file);
		if (!entry.isFile()) throw new Error("Secure-local SDK authority key must be a private regular 32-byte file.");
		const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat();
			if (
				!stat.isFile() ||
				stat.dev !== entry.dev ||
				stat.ino !== entry.ino ||
				(stat.mode & 0o7777) !== 0o600 ||
				stat.size !== 32 ||
				(process.getuid !== undefined && stat.uid !== process.getuid())
			)
				throw new Error("Secure-local SDK authority key must be a private regular 32-byte file.");
			const key = await handle.readFile();
			if (key.length !== 32) throw new Error("Secure-local SDK authority key changed during read.");
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
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		try {
			await handle.writeFile(randomBytes(32));
			await handle.sync();
		} finally {
			await handle.close();
		}
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
