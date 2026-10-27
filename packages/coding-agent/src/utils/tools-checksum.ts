import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";

const SHA256_DIGEST_RE = /^sha256:([a-fA-F0-9]{64})$/;

export interface ReleaseAssetDigest {
	name?: string;
	digest?: string | null;
}

export function sha256FromReleaseDigest(digest: string | null | undefined): string | null {
	if (typeof digest !== "string") return null;
	const match = SHA256_DIGEST_RE.exec(digest.trim());
	return match ? match[1].toLowerCase() : null;
}

export function requireAssetSha256(assets: readonly ReleaseAssetDigest[], assetName: string): string {
	const asset = assets.find(entry => entry.name === assetName);
	const sha256 = sha256FromReleaseDigest(asset?.digest);
	if (!sha256) {
		throw new Error(`Release asset ${assetName} has no sha256 digest; refusing to install an unverified binary`);
	}
	return sha256;
}

export async function assertFileMatchesSha256(filePath: string, expectedSha256: string): Promise<void> {
	const actual = createHash("sha256")
		.update(await fs.readFile(filePath))
		.digest("hex");
	if (actual !== expectedSha256.toLowerCase()) {
		await fs.rm(filePath, { force: true });
		throw new Error(`Checksum mismatch for ${filePath}`);
	}
}
