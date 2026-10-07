import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertFileMatchesSha256, requireAssetSha256 } from "../src/utils/tools-checksum";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("release asset checksums", () => {
	it("requires a sha256 digest for the named asset", () => {
		expect(requireAssetSha256([{ name: "yt-dlp_macos", digest: `sha256:${ABC_SHA256}` }], "yt-dlp_macos")).toBe(
			ABC_SHA256,
		);
		expect(() => requireAssetSha256([{ name: "yt-dlp_macos" }], "yt-dlp_macos")).toThrow(/no sha256 digest/);
		expect(() => requireAssetSha256([{ name: "other", digest: `sha256:${ABC_SHA256}` }], "yt-dlp_macos")).toThrow(
			/no sha256 digest/,
		);
	});

	it("accepts matching bytes and deletes a mismatched file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "tools-checksum-"));
		const filePath = path.join(root, "yt-dlp_macos");
		await fs.writeFile(filePath, "abc");
		await expect(assertFileMatchesSha256(filePath, ABC_SHA256)).resolves.toBeUndefined();

		await fs.writeFile(filePath, "nope");
		await expect(assertFileMatchesSha256(filePath, ABC_SHA256)).rejects.toThrow(/Checksum mismatch/);
		await expect(fs.stat(filePath)).rejects.toThrow();
		await fs.rm(root, { recursive: true, force: true });
	});
});
