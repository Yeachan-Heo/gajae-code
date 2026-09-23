import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MUPDF_VERSION = "1.28.0";
export const MUPDF_RELEASE_MATERIALS_ENV = "GJC_MUPDF_RELEASE_MATERIALS_DIR";
export const MUPDF_SOURCE_ARCHIVE_URL = "https://mupdf.com/downloads/archive/mupdf-1.28.0-source.tar.gz";
export const MUPDF_SOURCE_ARCHIVE_SHA256 = "21c7f064903154f1c3a7458bee81f130fc36f9b5147ea13328f9980e02d2dea2";
export const MUPDF_SOURCE_ARCHIVE_BYTES = 68923736;
export const MUPDF_SOURCE_TAG_COMMIT = "205b8cf43551279d1215e88fe2845c5d595bade9";
export const MUPDF_EMSDK_VERSION = "4.0.8";
export const MUPDF_NPM_INTEGRITY = "sha512-ACUnbpECaQ5JLq04pwd89lS+0IGMest5qL5tb08g9TAR7bDtfqflHEkb2Xm3o4rvC/szguLiV+WEbW9kstj8Sg==";
export const MUPDF_RELEASE_MATERIALS = [
	"mupdf-source.tar.gz",
	"mupdf-built.wasm",
	"mupdf-build-recipe.txt",
	"mupdf-notices.txt",
	"mupdf-provenance.json",
] as const;

export interface MuPdfProvenance {
	schema: "gajae-mupdf-corresponding-source-v1";
	mupdfVersion: string;
	sourceArtifact: string;
	buildRecipe: string;
	notices: string;
	sourceArchiveUrl: string;
	sourceArchiveSha256: string;
	sourceTagCommit: string;
	emsdkVersion: string;
	npmIntegrity: string;
	npmWasmSha256: string;
	rebuiltWasmSha256: string;
	wasmHashesMatch: boolean;
	buildRecipeSha256: string;
	noticesSha256: string;
}

export interface MuPdfMaterialDigests {
	sourceArchiveSha256: string;
	sourceArchiveBytes: number;
	buildRecipeSha256: string;
	noticesSha256: string;
	installedNpmWasmSha256: string;
	builtWasmSha256: string;
}

const provenanceFields = [
	"schema",
	"mupdfVersion",
	"sourceArtifact",
	"buildRecipe",
	"notices",
	"sourceArchiveUrl",
	"sourceArchiveSha256",
	"sourceTagCommit",
	"emsdkVersion",
	"npmIntegrity",
	"npmWasmSha256",
	"rebuiltWasmSha256",
	"wasmHashesMatch",
	"buildRecipeSha256",
	"noticesSha256",
] as const;

function fail(reason: string): never {
	throw new Error(`MuPDF release materials are invalid: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function sha256(value: Uint8Array | string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

export function validateMuPdfSourceArchiveDigest(
	declaredSha256: unknown,
	actual: { sha256: string; bytes: number },
): void {
	if (!isSha256(declaredSha256)) fail("source archive SHA-256 in provenance is malformed");
	if (declaredSha256 !== MUPDF_SOURCE_ARCHIVE_SHA256) fail("source archive SHA-256 does not match the pinned official archive");
	if (actual.sha256 !== declaredSha256) fail("source archive on disk does not match provenance SHA-256");
	if (actual.bytes !== MUPDF_SOURCE_ARCHIVE_BYTES) fail(`source archive has ${actual.bytes} bytes, expected ${MUPDF_SOURCE_ARCHIVE_BYTES}`);
}

export function validateMuPdfWasmHashMatch(npmWasmSha256: unknown, rebuiltWasmSha256: unknown): void {
	if (!isSha256(npmWasmSha256) || !isSha256(rebuiltWasmSha256)) fail("npm or rebuilt MuPDF WASM SHA-256 is malformed");
	if (npmWasmSha256 !== rebuiltWasmSha256) fail("npm and rebuilt MuPDF WASM SHA-256 values are unequal");
}

/** Validate provenance against both fixed release pins and bytes observed on disk. */
export function validateMuPdfReleaseProvenance(value: unknown, actual: MuPdfMaterialDigests): asserts value is MuPdfProvenance {
	if (!isRecord(value)) fail("provenance must be a JSON object");
	const suppliedFields = Object.keys(value).sort();
	const expectedFields = [...provenanceFields].sort();
	if (suppliedFields.length !== expectedFields.length || suppliedFields.some((field, index) => field !== expectedFields[index])) {
		fail("provenance fields do not match the strict schema");
	}
	for (const field of provenanceFields) {
		if (field === "wasmHashesMatch") continue;
		if (typeof value[field] !== "string") fail(`provenance field ${field} must be a string`);
	}
	if (value.wasmHashesMatch !== true) fail("provenance does not attest a successful byte-for-byte WASM match");
	if (value.schema !== "gajae-mupdf-corresponding-source-v1") fail("provenance has an unknown schema");
	if (value.mupdfVersion !== MUPDF_VERSION) fail(`provenance targets ${String(value.mupdfVersion)}, expected ${MUPDF_VERSION}`);
	if (value.sourceArtifact !== "mupdf-source.tar.gz" || value.buildRecipe !== "mupdf-build-recipe.txt" || value.notices !== "mupdf-notices.txt") {
		fail("provenance does not bind the required source, recipe, and notices");
	}
	if (value.sourceArchiveUrl !== MUPDF_SOURCE_ARCHIVE_URL) fail("provenance source URL is not the official pinned archive");
	if (value.sourceTagCommit !== MUPDF_SOURCE_TAG_COMMIT) fail("provenance source tag commit is not the official MuPDF 1.28.0 commit");
	if (value.emsdkVersion !== MUPDF_EMSDK_VERSION) fail(`provenance EMSDK version must be ${MUPDF_EMSDK_VERSION}`);
	if (value.npmIntegrity !== MUPDF_NPM_INTEGRITY) fail("provenance npm integrity does not match the pinned bun.lock package");
	validateMuPdfSourceArchiveDigest(value.sourceArchiveSha256, {
		sha256: actual.sourceArchiveSha256,
		bytes: actual.sourceArchiveBytes,
	});

	if (!isSha256(value.buildRecipeSha256) || actual.buildRecipeSha256 !== value.buildRecipeSha256) fail("build recipe SHA-256 does not match provenance");
	if (!isSha256(value.noticesSha256) || actual.noticesSha256 !== value.noticesSha256) fail("notices SHA-256 does not match provenance");
	if (!isSha256(value.npmWasmSha256) || actual.installedNpmWasmSha256 !== value.npmWasmSha256) {
		fail("installed npm MuPDF WASM SHA-256 does not match provenance");
	}
	if (!isSha256(value.rebuiltWasmSha256) || actual.builtWasmSha256 !== value.rebuiltWasmSha256) {
		fail("source-built MuPDF WASM on disk does not match provenance SHA-256");
	}
	validateMuPdfWasmHashMatch(value.npmWasmSha256, value.rebuiltWasmSha256);
}

async function requireFile(directory: string, name: string): Promise<Buffer> {
	const filePath = path.join(directory, name);
	const metadata = await fs.stat(filePath).catch(() => undefined);
	if (!metadata) throw new Error(`MuPDF release material is missing or unreadable: ${name}`);
	if (!metadata.isFile() || metadata.size <= 0) throw new Error(`MuPDF release material is missing or empty: ${name}`);
	try {
		return Buffer.from(await Bun.file(filePath).arrayBuffer());
	} catch {
		throw new Error(`MuPDF release material is unreadable: ${name}`);
	}
}

async function installedNpmWasm(): Promise<Buffer> {
	const codingAgent = path.resolve(import.meta.dir, "../packages/coding-agent");
	let modulePath: string;
	try {
		modulePath = Bun.resolveSync("mupdf", codingAgent);
	} catch {
		throw new Error("MuPDF release verification requires the lockfile-pinned mupdf npm package installed in packages/coding-agent");
	}
	const packageRoot = path.resolve(path.dirname(modulePath), "..");
	let metadata: { version?: unknown };
	try {
		metadata = JSON.parse(await Bun.file(path.join(packageRoot, "package.json")).text()) as { version?: unknown };
	} catch {
		throw new Error("Installed mupdf package metadata is missing or malformed");
	}
	if (metadata.version !== MUPDF_VERSION) throw new Error(`Installed mupdf package version is ${String(metadata.version)}, expected ${MUPDF_VERSION}`);
	const lockPath = path.resolve(import.meta.dir, "../bun.lock");
	const lockText = await Bun.file(lockPath).text();
	if (!lockText.includes(`"mupdf": ["mupdf@${MUPDF_VERSION}", "", {}, "${MUPDF_NPM_INTEGRITY}"]`)) {
		throw new Error("bun.lock does not bind the pinned MuPDF npm integrity to mupdf 1.28.0");
	}
	const wasmPath = path.join(path.dirname(modulePath), "mupdf-wasm.wasm");
	let wasm: Buffer;
	try {
		wasm = Buffer.from(await Bun.file(wasmPath).arrayBuffer());
	} catch {
		throw new Error(`Installed mupdf package WASM is missing or unreadable: ${wasmPath}`);
	}
	if (wasm.length === 0) throw new Error("Installed mupdf package WASM is empty");
	return wasm;
}

/**
 * Fail closed before a release binary embeds MuPDF unless maintainers have
 * supplied the exact corresponding-source package and its build evidence.
 */
export async function verifyMuPdfReleaseMaterials(
	directory = process.env[MUPDF_RELEASE_MATERIALS_ENV],
): Promise<{ directory: string; wasmPath: string }> {
	if (!directory) {
		throw new Error(
			`MuPDF release materials are required before embedding; set ${MUPDF_RELEASE_MATERIALS_ENV} to a directory containing the pinned source, built WASM, recipe, notices, and provenance`,
		);
	}
	const resolved = path.resolve(directory);
	for (const name of MUPDF_RELEASE_MATERIALS) {
		const metadata = await fs.stat(path.join(resolved, name)).catch(() => undefined);
		if (!metadata?.isFile() || metadata.size <= 0) throw new Error(`MuPDF release material is missing or empty: ${name}`);
	}
	const [source, wasm, recipe, notices, provenanceBytes, npmWasm] = await Promise.all([
		requireFile(resolved, "mupdf-source.tar.gz"),
		requireFile(resolved, "mupdf-built.wasm"),
		requireFile(resolved, "mupdf-build-recipe.txt"),
		requireFile(resolved, "mupdf-notices.txt"),
		requireFile(resolved, "mupdf-provenance.json"),
		installedNpmWasm(),
	]);
	if (!wasm.equals(npmWasm)) throw new Error("Source-built MuPDF WASM bytes do not exactly match the installed npm package WASM");
	let provenance: unknown;
	try {
		const json = new TextDecoder("utf-8", { fatal: true }).decode(provenanceBytes);
		provenance = JSON.parse(json) as unknown;
	} catch {
		throw new Error("MuPDF release provenance is malformed JSON or invalid UTF-8");
	}
	validateMuPdfReleaseProvenance(provenance, {
		sourceArchiveSha256: sha256(source),
		sourceArchiveBytes: source.length,
		buildRecipeSha256: sha256(recipe),
		noticesSha256: sha256(notices),
		installedNpmWasmSha256: sha256(npmWasm),
		builtWasmSha256: sha256(wasm),
	});
	return { directory: resolved, wasmPath: path.join(resolved, "mupdf-built.wasm") };
}