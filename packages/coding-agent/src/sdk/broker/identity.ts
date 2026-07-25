import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

const MODE = 0o600;

export function brokerIdentityPath(agentDir: string): string {
	return path.join(agentDir, "sdk", "broker.identity");
}

export async function getBrokerIdentityKey(agentDir: string): Promise<string> {
	const file = brokerIdentityPath(agentDir);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	while (true) {
		try {
			const key = (await fs.readFile(file, "utf8")).trim();
			if (/^[0-9a-f]{64}$/i.test(key)) return key;
			throw new Error(`Invalid broker identity key at ${file}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const key = randomBytes(32).toString("hex");
		const temporary = path.join(path.dirname(file), `.broker.identity-${randomBytes(16).toString("hex")}`);
		try {
			await fs.writeFile(temporary, `${key}\n`, { encoding: "utf8", mode: MODE, flag: "wx" });
			await fs.chmod(temporary, MODE);
			try {
				// Link publishes a fully written key without exposing a partial target.
				// Same-directory hard-link support is required (standard on Linux, macOS, and Windows NTFS).
				await fs.link(temporary, file);
				return key;
			} catch (linkError) {
				if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
			}
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}
}

export async function deriveIdempotencyIdentity(
	agentDir: string,
	operation: string,
	callerKey: string,
	canonicalTargetHash: string,
): Promise<string> {
	const key = await getBrokerIdentityKey(agentDir);
	return createHmac("sha256", Buffer.from(key, "hex"))
		.update(`3|${operation}|${callerKey}|${canonicalTargetHash}`)
		.digest("hex");
}
