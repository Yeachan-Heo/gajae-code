import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { verifyOwnerOnlyFdSecurity } from "@gajae-code/natives";

export interface DoctorSafetyResult {
	readonly safe: boolean;
	readonly reasonCode?: string;
	readonly platform?: string;
}
export interface DoctorExpectedIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

export async function authorizePosixConfigPermission(
	filePath: string,
	expected?: DoctorExpectedIdentity,
): Promise<DoctorSafetyResult> {
	if (process.platform === "win32") return { safe: false, reasonCode: "unsupported", platform: process.platform };
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) return { safe: false, reasonCode: "not_regular" };
		if (stat.nlink !== 1n) return { safe: false, reasonCode: "hardlink" };
		if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))
			return { safe: false, reasonCode: "identity_mismatch" };
		const parent = await fs.realpath(path.dirname(filePath));
		if (path.dirname(path.resolve(filePath)) !== parent) return { safe: false, reasonCode: "unsafe_parent" };
		const verified = verifyOwnerOnlyFdSecurity(filePath, "file", handle.fd);
		return verified.ok
			? { safe: true, platform: process.platform }
			: { safe: false, reasonCode: verified.code, platform: process.platform };
	} catch (error) {
		return { safe: false, reasonCode: error instanceof Error ? error.name : "unavailable" };
	} finally {
		await handle?.close();
	}
}
