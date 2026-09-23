import { expect, test } from "bun:test";
import {
	MUPDF_RELEASE_MATERIALS_ENV,
	sha256,
	validateMuPdfSourceArchiveDigest,
	validateMuPdfWasmHashMatch,
	verifyMuPdfReleaseMaterials,
} from "./mupdf-release-materials";

test("requires an explicitly configured corresponding-source materials directory", async () => {
	await expect(verifyMuPdfReleaseMaterials("")).rejects.toThrow(MUPDF_RELEASE_MATERIALS_ENV);
});

test("rejects malformed source archive hashes", () => {
	const fixtureBytes = Buffer.from("not-an-official-MuPDF-archive");
	expect(() =>
		validateMuPdfSourceArchiveDigest("not-a-sha256", {
			sha256: sha256(fixtureBytes),
			bytes: fixtureBytes.length,
		}),
	).toThrow("source archive SHA-256 in provenance is malformed");
});

test("rejects source archive fixture bytes even when provenance repeats their digest", () => {
	const fixtureBytes = Buffer.from("fixture bytes are not the official source archive");
	const fixtureSha256 = sha256(fixtureBytes);
	expect(() =>
		validateMuPdfSourceArchiveDigest(fixtureSha256, {
			sha256: fixtureSha256,
			bytes: fixtureBytes.length,
		}),
	).toThrow("does not match the pinned official archive");
});

test("rejects unequal npm and source-built WASM hashes", () => {
	const npmFixtureBytes = Buffer.from("npm wasm fixture");
	const rebuiltFixtureBytes = Buffer.from("rebuilt wasm fixture");
	expect(() => validateMuPdfWasmHashMatch(sha256(npmFixtureBytes), sha256(rebuiltFixtureBytes))).toThrow(
		"npm and rebuilt MuPDF WASM SHA-256 values are unequal",
	);
});
