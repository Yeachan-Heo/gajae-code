#!/usr/bin/env bun
/**
 * Closed evidence contracts for stable npm releases.
 *
 * Expected evidence is written before the first registry mutation. Final evidence
 * is written only after every retained package tarball has been downloaded back
 * from the registry and compared byte-for-byte where it matters.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { $ } from "bun";

export const RELEASE_EVIDENCE_SCHEMA_VERSION = 1;
export const EXPECTED_EVIDENCE_FILE = "gajae-release-packages-expected-v1.json";
export const FINAL_EVIDENCE_FILE = "gajae-release-packages-v1.json";

export interface PublicPackageDefinition {
	dir: string;
	name: string;
}

/** The complete, ordered-by-name public package contract. */
export const PUBLIC_PACKAGE_DEFINITIONS: readonly PublicPackageDefinition[] = [
	{ dir: "packages/agent", name: "@gajae-code/agent-core" },
	{ dir: "packages/ai", name: "@gajae-code/ai" },
	{ dir: "packages/bridge-client", name: "@gajae-code/bridge-client" },
	{ dir: "packages/coding-agent", name: "@gajae-code/coding-agent" },
	{ dir: "packages/natives", name: "@gajae-code/natives" },
	{ dir: "packages/natives-darwin-arm64", name: "@gajae-code/natives-darwin-arm64" },
	{ dir: "packages/natives-darwin-x64", name: "@gajae-code/natives-darwin-x64" },
	{ dir: "packages/natives-linux-arm64", name: "@gajae-code/natives-linux-arm64" },
	{ dir: "packages/natives-linux-x64", name: "@gajae-code/natives-linux-x64" },
	{ dir: "packages/natives-win32-x64", name: "@gajae-code/natives-win32-x64" },
	{ dir: "packages/stats", name: "@gajae-code/stats" },
	{ dir: "packages/tui", name: "@gajae-code/tui" },
	{ dir: "packages/utils", name: "@gajae-code/utils" },
	{ dir: "packages/gajae-code", name: "gajae-code" },
] as const;

const dependencyFieldNames = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const publicPackageByName = new Map(PUBLIC_PACKAGE_DEFINITIONS.map(definition => [definition.name, definition]));
const stableVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const sha512Pattern = /^[0-9a-f]{128}$/u;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;
const ownedInternalPackagePrefixes = ["@gajae-code/", "@gajae-code-sync-sandbox/"] as const;


interface JsonObject {
	[key: string]: unknown;
}

/** Bounded resource budget for every retained or registry package tarball. */
export interface TarballLimits {
	maxCompressedBytes: number;
	maxUnpackedBytes: number;
	maxEntryBytes: number;
	maxFileCount: number;
}

export const RELEASE_TARBALL_LIMITS: Readonly<TarballLimits> = {
	maxCompressedBytes: 64 * 1024 * 1024,
	maxUnpackedBytes: 256 * 1024 * 1024,
	maxEntryBytes: 64 * 1024 * 1024,
	maxFileCount: 10_000,
};

function assertTarballLimits(limits: TarballLimits): void {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) fail(`tarball limit ${name} must be a positive safe integer`);
	}
	if (limits.maxEntryBytes > limits.maxUnpackedBytes) fail("tarball maxEntryBytes cannot exceed maxUnpackedBytes");
}

/** Rejects every internal form except the release's exact stable version. */
export function assertExactInternalReleaseDependencies(
	dependencies: Readonly<Record<string, string>>,
	releaseVersion: string,
	label: string,
): void {
	if (!stableVersionPattern.test(releaseVersion)) fail(`${label} has a non-stable release version ${releaseVersion}`);
	for (const dependencyName of Object.keys(dependencies).sort()) {
		if (!publicPackageByName.has(dependencyName)) fail(`${label} names unknown internal dependency ${dependencyName}`);
		if (dependencies[dependencyName] !== releaseVersion) {
			fail(`${label} must resolve internal dependency ${dependencyName} to exact release version ${releaseVersion}`);
		}
	}
}
interface TarEntry {
	path: string;
	mode: number;
	type: "file" | "directory";
	data: Buffer;
}

export interface PackedManifest {
	name: string;
	version: string;
	internalDependencies: Record<string, string>;
}

export interface PackageEvidenceRecord {
	dir: string;
	name: string;
	version: string;
	tarball_sha512: string;
	expected_sri: string;
	manifest_sha256: string;
	unpacked_size: number;
	file_count: number;
	internal_dependencies: Record<string, string>;
}

export interface ExpectedReleaseEvidence {
	schema_version: 1;
	source_commit: string;
	release_version: string;
	packages: PackageEvidenceRecord[];
}

export interface FinalPackageEvidenceRecord extends PackageEvidenceRecord {
	registry_sri: string;
	registry_tarball_sha512: string;
	registry_manifest_sha256: string;
	registry_internal_dependencies: Record<string, string>;

}

export interface FinalReleaseEvidence {
	schema_version: 1;
	source_commit: string;
	release_version: string;
	expected_evidence_sha256: string;
	packages: FinalPackageEvidenceRecord[];
}

export interface RegistryPackageObservation {
	registry_sri: string;
	registry_tarball_sha512: string;
	registry_manifest_sha256: string;
	registry_internal_dependencies: Record<string, string>;
	registry_latest_version?: string;

}


export interface StableFinalizationInput {
	expected: ExpectedReleaseEvidence;
	final: FinalReleaseEvidence;
	expectedEvidenceSha256: string;
	tag: string;
	version: string;
	sourceCommit: string;
	tagCommit: string;
}

function fail(message: string): never {
	throw new Error(`Release evidence: ${message}`);
}

function compareNumericIdentifiers(left: string, right: string): number {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Compares exact stable semver versions without lossy numeric conversion. */
export function compareStableVersions(left: string, right: string): number {
	if (!stableVersionPattern.test(left) || !stableVersionPattern.test(right)) {
		fail(`cannot compare non-stable versions ${left} and ${right}`);
	}
	const leftParts = left.split(".");
	const rightParts = right.split(".");
	for (let index = 0; index < leftParts.length; index += 1) {
		const comparison = compareNumericIdentifiers(leftParts[index]!, rightParts[index]!);
		if (comparison !== 0) return comparison;
	}
	return 0;
}

/** Ensures the final latest tag did not move below the release target version. */
export function assertMonotonicLatestVersion(targetVersion: string, latestVersion: string, label: string): void {
	if (compareStableVersions(latestVersion, targetVersion) < 0) {
		fail(`${label} latest version ${latestVersion} regresses below target version ${targetVersion}`);
	}
}



function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, label: string): JsonObject {
	if (!isObject(value)) fail(`${label} must be an object`);
	return value;
}

function keys(value: JsonObject, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		fail(`${label} has unknown or missing fields`);
	}
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") fail(`${label} must be a string`);
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative integer`);
	return value as number;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
	const record = object(value, label);
	const result: Record<string, string> = {};
	for (const key of Object.keys(record).sort()) {
		const entry = record[key];
		if (typeof entry !== "string") fail(`${label}.${key} must be a string`);
		result[key] = entry;
	}
	if (Object.keys(result).join("\u0000") !== Object.keys(result).sort().join("\u0000")) {
		fail(`${label} must have sorted keys`);
	}
	return result;
}

function assertSortedPackageRecords(records: readonly { name: string }[], label: string): void {
	if (records.length !== PUBLIC_PACKAGE_DEFINITIONS.length) {
		fail(`${label} must contain exactly ${PUBLIC_PACKAGE_DEFINITIONS.length} packages`);
	}
	const names = records.map(record => record.name);
	const expected = PUBLIC_PACKAGE_DEFINITIONS.map(definition => definition.name);
	if (names.some((name, index) => name !== expected[index])) {
		fail(`${label} must contain the complete public package set sorted by package name`);
	}
}

/** Extracts owned package dependencies from every packed dependency field. */
export function extractInternalDependencies(value: unknown, label: string): Record<string, string> {
	const manifest = object(value, label);
	const dependencies: Record<string, string> = {};
	for (const fieldName of dependencyFieldNames) {
		const field = manifest[fieldName];
		if (field === undefined) continue;
		const fieldRecord = object(field, `${label}.${fieldName}`);
		for (const dependencyName of Object.keys(fieldRecord).sort()) {
			if (!publicPackageByName.has(dependencyName)) {
				if (ownedInternalPackagePrefixes.some(prefix => dependencyName.startsWith(prefix))) {
					fail(`${label}.${fieldName} names unknown owned internal dependency ${dependencyName}`);
				}
				continue;
			}
			const spec = fieldRecord[dependencyName];
			if (typeof spec !== "string") fail(`${label}.${fieldName}.${dependencyName} must be a string`);
			if (dependencies[dependencyName] !== undefined && dependencies[dependencyName] !== spec) {
				fail(`${label} resolves ${dependencyName} inconsistently`);
			}
			dependencies[dependencyName] = spec;
		}
	}
	return dependencies;
}


function parsePackedManifest(manifestBytes: Buffer): PackedManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown;
	} catch {
		fail("package/package.json is not valid UTF-8 JSON");
	}
	const manifest = object(parsed, "package/package.json");
	const name = string(manifest.name, "package/package.json.name");
	const version = string(manifest.version, "package/package.json.version");
	const internalDependencies = extractInternalDependencies(manifest, "package/package.json");
	assertExactInternalReleaseDependencies(internalDependencies, version, "package/package.json");
	return { name, version, internalDependencies };
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function sha512(bytes: Uint8Array): string {
	return createHash("sha512").update(bytes).digest("hex");
}

export function sha512Sri(bytes: Uint8Array): string {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function canonicalJsonValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("canonical JSON cannot contain a non-finite number");
		return value;
	}
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!isObject(value)) fail("canonical JSON contains an unsupported value");
	const result: JsonObject = {};
	for (const key of Object.keys(value).sort()) result[key] = canonicalJsonValue(value[key]);
	return result;
}

export function canonicalJsonBytes(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`, "utf8");
}

function parseOctal(header: Buffer, offset: number, length: number, label: string): number {
	const raw = header.subarray(offset, offset + length).toString("ascii").replace(/[\0 ]+$/gu, "").trim();
	if (raw === "") return 0;
	if (!/^[0-7]+$/u.test(raw)) fail(`tar ${label} is not an octal value`);
	const value = Number.parseInt(raw, 8);
	if (!Number.isSafeInteger(value)) fail(`tar ${label} exceeds a safe integer`);
	return value;
}

function readTarString(header: Buffer, offset: number, length: number, label: string): string {
	const end = header.indexOf(0, offset);
	const boundedEnd = end === -1 || end > offset + length ? offset + length : end;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(header.subarray(offset, boundedEnd));
	} catch {
		fail(`tar ${label} is not valid UTF-8`);
	}
}

function assertTarChecksum(header: Buffer): void {
	const stored = parseOctal(header, 148, 8, "checksum");
	let calculated = 0;
	for (let index = 0; index < 512; index += 1) calculated += index >= 148 && index < 156 ? 0x20 : header[index]!;
	if (stored !== calculated) fail("tar header checksum mismatch");
}

function assertSafeTarPath(entryPath: string): void {
	const normalized = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
	if (
		(normalized !== "package" && !normalized.startsWith("package/")) ||
		normalized.includes("\\") ||
		normalized.startsWith("/") ||
		normalized.includes("\0")
	) {
		fail(`tar member path is unsafe: ${JSON.stringify(entryPath)}`);
	}
	if (normalized.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
		fail(`tar member path is unsafe: ${JSON.stringify(entryPath)}`);
	}
}

function tarPayload(tar: Buffer, offset: number, size: number, entryPath: string): { data: Buffer; nextOffset: number } {
	const contentStart = offset + 512;
	const paddedSize = Math.ceil(size / 512) * 512;
	if (contentStart + paddedSize > tar.length) fail(`tar member ${entryPath} is truncated`);
	return { data: Buffer.from(tar.subarray(contentStart, contentStart + size)), nextOffset: contentStart + paddedSize };
}

function parsePaxAttributes(data: Buffer): Record<string, string> {
	const attributes: Record<string, string> = {};
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		if (space === -1) fail("PAX header is missing its length separator");
		const lengthText = data.subarray(offset, space).toString("ascii");
		if (!/^[1-9][0-9]*$/u.test(lengthText)) fail("PAX header has an invalid record length");
		const length = Number(lengthText);
		const recordEnd = offset + length;
		if (!Number.isSafeInteger(length) || recordEnd > data.length || recordEnd <= space + 1) fail("PAX header record is truncated");
		const record = data.subarray(space + 1, recordEnd);
		if (record[record.length - 1] !== 0x0a) fail("PAX header record is not newline terminated");
		const equals = record.indexOf(0x3d);
		if (equals <= 0) fail("PAX header record is missing a key");
		let value: string;
		try {
			value = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(equals + 1, record.length - 1));
		} catch {
			fail("PAX header value is not valid UTF-8");
		}
		attributes[record.subarray(0, equals).toString("ascii")] = value;
		offset = recordEnd;
	}
	return attributes;
}

function parseGnuLongPath(data: Buffer): string {
	const terminator = data.indexOf(0);
	const raw = terminator === -1 ? data : data.subarray(0, terminator);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/\n$/u, "");
	} catch {
		fail("GNU long-path header is not valid UTF-8");
	}
}


function parseTarEntries(tarball: Uint8Array, limits: TarballLimits = RELEASE_TARBALL_LIMITS): TarEntry[] {
	assertTarballLimits(limits);
	if (tarball.byteLength > limits.maxCompressedBytes) {
		fail(`tarball compressed size exceeds ${limits.maxCompressedBytes} bytes`);
	}

	let tar: Buffer;
	try {
		tar = Buffer.from(gunzipSync(tarball, { maxOutputLength: limits.maxUnpackedBytes }));
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
			fail(`tarball unpacked size exceeds ${limits.maxUnpackedBytes} bytes`);
		}
		fail("tarball is not a valid gzip stream");
	}

	const entries: TarEntry[] = [];
	const seen = new Set<string>();
	let pendingPath: string | undefined;
	let totalFileBytes = 0;
	let fileCount = 0;
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) {
			if (pendingPath !== undefined) fail("tar terminates after a path extension without a member");
			if (offset + 1024 > tar.length || !tar.subarray(offset, offset + 1024).every(byte => byte === 0)) {
				fail("tar is missing its two zero-block terminator");
			}
			if (!tar.subarray(offset + 1024).every(byte => byte === 0)) fail("tar contains data after its terminator");
			return entries;
		}
		assertTarChecksum(header);
		const headerPath = readTarString(header, 0, 100, "member path");
		const prefix = readTarString(header, 345, 155, "member prefix");
		const size = parseOctal(header, 124, 12, "size");
		if (size > limits.maxEntryBytes) fail(`tar member ${headerPath} exceeds ${limits.maxEntryBytes} bytes`);
		const typeByte = header[156]!;
		const payload = tarPayload(tar, offset, size, headerPath);

		if (typeByte === "x".charCodeAt(0) || typeByte === "g".charCodeAt(0)) {
			const attributes = parsePaxAttributes(payload.data);
			if (typeByte === "g".charCodeAt(0) && attributes.path !== undefined) fail("global PAX path attributes are unsupported");
			if (typeByte === "x".charCodeAt(0) && attributes.path !== undefined) pendingPath = attributes.path;
			offset = payload.nextOffset;
			continue;
		}
		if (typeByte === "L".charCodeAt(0)) {
			pendingPath = parseGnuLongPath(payload.data);
			offset = payload.nextOffset;
			continue;
		}

		const entryPath = pendingPath ?? (prefix ? `${prefix}/${headerPath}` : headerPath);
		pendingPath = undefined;
		assertSafeTarPath(entryPath);
		const mode = parseOctal(header, 100, 8, "mode");
		if ((mode & ~0o777) !== 0 || (mode & 0o002) !== 0) fail(`tar member ${entryPath} has an unsafe mode`);
		const type = typeByte === 0 || typeByte === "0".charCodeAt(0) ? "file" : typeByte === "5".charCodeAt(0) ? "directory" : undefined;
		if (type === undefined) fail(`tar member ${entryPath} has unsupported type ${typeByte}`);
		if (type === "directory" && size !== 0) fail(`tar directory ${entryPath} has data`);
		if (seen.has(entryPath)) fail(`tar contains duplicate member ${entryPath}`);
		if (type === "file") {
			fileCount += 1;
			if (fileCount > limits.maxFileCount) fail(`tar contains more than ${limits.maxFileCount} files`);
			totalFileBytes += size;
			if (totalFileBytes > limits.maxUnpackedBytes) fail(`tar file data exceeds ${limits.maxUnpackedBytes} bytes`);
		}
		seen.add(entryPath);
		entries.push({ path: entryPath, mode, type, data: payload.data });
		offset = payload.nextOffset;
	}
	fail("tar is missing its zero terminator");
}

function writeTarString(header: Buffer, offset: number, length: number, value: string, label: string): void {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length > length) fail(`${label} is too long for canonical ustar`);
	bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`);
	const encoded = value.toString(8);
	if (encoded.length > length - 1) fail(`${label} is too large for canonical ustar`);
	writeTarString(header, offset, length - 1, encoded.padStart(length - 1, "0"), label);
	header[offset + length - 1] = 0;
}

function splitUstarPath(entryPath: string): { name: string; prefix: string } {
	if (Buffer.byteLength(entryPath, "utf8") <= 100) return { name: entryPath, prefix: "" };
	for (let index = entryPath.length - 1; index > 0; index -= 1) {
		if (entryPath[index] !== "/") continue;
		const prefix = entryPath.slice(0, index);
		const name = entryPath.slice(index + 1);
		if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) return { name, prefix };
	}
	fail(`tar member path is too long for canonical ustar: ${entryPath}`);
}

function canonicalTarHeader(entry: TarEntry): Buffer {
	const header = Buffer.alloc(512);
	const { name, prefix } = splitUstarPath(entry.path);
	writeTarString(header, 0, 100, name, "tar name");
	writeTarOctal(header, 100, 8, entry.mode & 0o777, "tar mode");
	writeTarOctal(header, 108, 8, 0, "tar uid");
	writeTarOctal(header, 116, 8, 0, "tar gid");
	writeTarOctal(header, 124, 12, entry.type === "file" ? entry.data.length : 0, "tar size");
	writeTarOctal(header, 136, 12, 0, "tar mtime");
	header.fill(0x20, 148, 156);
	header[156] = entry.type === "file" ? "0".charCodeAt(0) : "5".charCodeAt(0);
	writeTarString(header, 257, 6, "ustar", "tar magic");
	header[262] = 0;
	writeTarString(header, 263, 2, "00", "tar version");
	writeTarString(header, 345, 155, prefix, "tar prefix");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	writeTarString(header, 148, 6, checksum.toString(8).padStart(6, "0"), "tar checksum");
	header[154] = 0;
	header[155] = 0x20;
	return header;
}

function createCanonicalTarball(entries: readonly TarEntry[]): Buffer {
	const ordered = [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
	const output: Buffer[] = [];
	for (const entry of ordered) {
		output.push(canonicalTarHeader(entry));
		if (entry.type !== "file") continue;
		output.push(entry.data);
		const padding = (512 - (entry.data.length % 512)) % 512;
		if (padding > 0) output.push(Buffer.alloc(padding));
	}
	output.push(Buffer.alloc(1024));
	const gzip = Buffer.from(gzipSync(Buffer.concat(output), { level: 9 }));
	gzip.fill(0, 4, 8); // gzip MTIME
	gzip[9] = 255; // gzip OS = unknown, not the runner platform
	return gzip;
}

/** Normalizes a package tarball to the release's reproducible ustar/gzip form. */
export function canonicalizePackageTarball(tarball: Uint8Array, limits: TarballLimits = RELEASE_TARBALL_LIMITS): Buffer {
	return createCanonicalTarball(parseTarEntries(tarball, limits));
}

export function inspectPackageTarball(tarball: Uint8Array, limits: TarballLimits = RELEASE_TARBALL_LIMITS): {
	manifestBytes: Buffer;
	manifest: PackedManifest;
	unpackedSize: number;
	fileCount: number;
} {
	const entries = parseTarEntries(tarball, limits);
	const manifestEntry = entries.find(entry => entry.path === "package/package.json" && entry.type === "file");
	if (manifestEntry === undefined) fail("tarball is missing package/package.json");
	const files = entries.filter(entry => entry.type === "file");
	return {
		manifestBytes: manifestEntry.data,
		manifest: parsePackedManifest(manifestEntry.data),
		unpackedSize: files.reduce((total, entry) => total + entry.data.length, 0),
		fileCount: files.length,
	};
}

export function packageEvidenceFromTarball(definition: PublicPackageDefinition, tarball: Uint8Array): PackageEvidenceRecord {
	const inspection = inspectPackageTarball(tarball);
	if (inspection.manifest.name !== definition.name) {
		fail(`${definition.dir} tarball declares ${inspection.manifest.name}, expected ${definition.name}`);
	}
	if (!stableVersionPattern.test(inspection.manifest.version)) {
		fail(`${definition.name} tarball has a non-stable version ${inspection.manifest.version}`);
	}
	return {
		dir: definition.dir,
		name: inspection.manifest.name,
		version: inspection.manifest.version,
		tarball_sha512: sha512(tarball),
		expected_sri: sha512Sri(tarball),
		manifest_sha256: sha256(inspection.manifestBytes),
		unpacked_size: inspection.unpackedSize,
		file_count: inspection.fileCount,
		internal_dependencies: inspection.manifest.internalDependencies,
	};
}

function validatePackageRecord(value: unknown, label: string): PackageEvidenceRecord {
	const record = object(value, label);
	keys(
		record,
		[
			"dir",
			"name",
			"version",
			"tarball_sha512",
			"expected_sri",
			"manifest_sha256",
			"unpacked_size",
			"file_count",
			"internal_dependencies",
		],
		label,
	);
	const dir = string(record.dir, `${label}.dir`);
	const name = string(record.name, `${label}.name`);
	const definition = publicPackageByName.get(name);
	if (definition === undefined || definition.dir !== dir) fail(`${label} is not a known public package`);
	const version = string(record.version, `${label}.version`);
	if (!stableVersionPattern.test(version)) fail(`${label}.version must be stable semver`);
	const tarballSha512 = string(record.tarball_sha512, `${label}.tarball_sha512`);
	if (!sha512Pattern.test(tarballSha512)) fail(`${label}.tarball_sha512 must be lowercase SHA-512`);
	const expectedSri = string(record.expected_sri, `${label}.expected_sri`);
	if (expectedSri !== `sha512-${Buffer.from(tarballSha512, "hex").toString("base64")}`) {
		fail(`${label}.expected_sri does not encode tarball_sha512`);
	}
	const manifestSha256 = string(record.manifest_sha256, `${label}.manifest_sha256`);
	if (!sha256Pattern.test(manifestSha256)) fail(`${label}.manifest_sha256 must be lowercase SHA-256`);
	const internalDependencies = stringRecord(record.internal_dependencies, `${label}.internal_dependencies`);
	assertExactInternalReleaseDependencies(internalDependencies, version, label);
	return {
		dir,
		name,
		version,
		tarball_sha512: tarballSha512,
		expected_sri: expectedSri,
		manifest_sha256: manifestSha256,
		unpacked_size: nonNegativeInteger(record.unpacked_size, `${label}.unpacked_size`),
		file_count: nonNegativeInteger(record.file_count, `${label}.file_count`),
		internal_dependencies: internalDependencies,
	};
}

export function validateExpectedEvidence(value: unknown): ExpectedReleaseEvidence {
	const evidence = object(value, "expected evidence");
	keys(evidence, ["schema_version", "source_commit", "release_version", "packages"], "expected evidence");
	if (evidence.schema_version !== RELEASE_EVIDENCE_SCHEMA_VERSION) fail("expected evidence schema_version is invalid");
	const sourceCommit = string(evidence.source_commit, "expected evidence.source_commit");
	if (!sourceCommitPattern.test(sourceCommit)) fail("expected evidence.source_commit must be a lowercase commit SHA");
	const releaseVersion = string(evidence.release_version, "expected evidence.release_version");
	if (!stableVersionPattern.test(releaseVersion)) fail("expected evidence.release_version must be stable semver");
	if (!Array.isArray(evidence.packages)) fail("expected evidence.packages must be an array");
	const packages = evidence.packages.map((record, index) => validatePackageRecord(record, `expected evidence.packages[${index}]`));
	assertSortedPackageRecords(packages, "expected evidence.packages");
	if (packages.some(record => record.version !== releaseVersion)) fail("expected evidence package versions must match release_version");
	return { schema_version: 1, source_commit: sourceCommit, release_version: releaseVersion, packages };
}

export function expectedEvidenceSha256(evidence: ExpectedReleaseEvidence): string {
	return sha256(canonicalJsonBytes(validateExpectedEvidence(evidence)));
}

export function validateExpectedTarball(record: PackageEvidenceRecord, tarball: Uint8Array): void {
	const actual = packageEvidenceFromTarball({ dir: record.dir, name: record.name }, tarball);
	if (JSON.stringify(canonicalJsonValue(actual)) !== JSON.stringify(canonicalJsonValue(record))) {
		fail(`${record.name} retained tarball does not match its expected evidence`);
	}
}

export function classifyRegistryObservation(
	expected: PackageEvidenceRecord,
	observation: RegistryPackageObservation | undefined,
): "publish" | "skip" | "conflict" {
	if (observation === undefined) return "publish";
	return observation.registry_sri === expected.expected_sri &&
		observation.registry_tarball_sha512 === expected.tarball_sha512 &&
		observation.registry_manifest_sha256 === expected.manifest_sha256 &&
		JSON.stringify(canonicalJsonValue(observation.registry_internal_dependencies)) ===
			JSON.stringify(canonicalJsonValue(expected.internal_dependencies))
		? "skip"
		: "conflict";


}

export function createExpectedEvidence(input: {
	sourceCommit: string;
	releaseVersion: string;
	packages: readonly PackageEvidenceRecord[];
}): ExpectedReleaseEvidence {
	if (!sourceCommitPattern.test(input.sourceCommit)) fail("sourceCommit must be a lowercase commit SHA");
	if (!stableVersionPattern.test(input.releaseVersion)) fail("releaseVersion must be stable semver");
	const evidence = validateExpectedEvidence({
		schema_version: RELEASE_EVIDENCE_SCHEMA_VERSION,
		source_commit: input.sourceCommit,
		release_version: input.releaseVersion,
		packages: [...input.packages],
	});
	return evidence;
}

function validateFinalPackageRecord(value: unknown, label: string): FinalPackageEvidenceRecord {
	const record = object(value, label);
	keys(
		record,
		[
			"dir",
			"name",
			"version",
			"tarball_sha512",
			"expected_sri",
			"manifest_sha256",
			"unpacked_size",
			"file_count",
			"internal_dependencies",
			"registry_sri",
			"registry_tarball_sha512",
			"registry_manifest_sha256",
			"registry_internal_dependencies",

		],
		label,
	);
	const base = validatePackageRecord(
		{
			dir: record.dir,
			name: record.name,
			version: record.version,
			tarball_sha512: record.tarball_sha512,
			expected_sri: record.expected_sri,
			manifest_sha256: record.manifest_sha256,
			unpacked_size: record.unpacked_size,
			file_count: record.file_count,
			internal_dependencies: record.internal_dependencies,
		},
		label,
	);
	const registrySri = string(record.registry_sri, `${label}.registry_sri`);
	const registryTarballSha512 = string(record.registry_tarball_sha512, `${label}.registry_tarball_sha512`);
	if (!sha512Pattern.test(registryTarballSha512)) fail(`${label}.registry_tarball_sha512 must be lowercase SHA-512`);
	if (registrySri !== `sha512-${Buffer.from(registryTarballSha512, "hex").toString("base64")}`) {
		fail(`${label}.registry_sri does not encode registry_tarball_sha512`);
	}
	const registryManifestSha256 = string(record.registry_manifest_sha256, `${label}.registry_manifest_sha256`);
	if (!sha256Pattern.test(registryManifestSha256)) fail(`${label}.registry_manifest_sha256 must be lowercase SHA-256`);
	const registryInternalDependencies = stringRecord(record.registry_internal_dependencies, `${label}.registry_internal_dependencies`);
	assertExactInternalReleaseDependencies(registryInternalDependencies, base.version, `${label}.registry_internal_dependencies`);

	return {
		...base,
		registry_sri: registrySri,
		registry_tarball_sha512: registryTarballSha512,
		registry_manifest_sha256: registryManifestSha256,
		registry_internal_dependencies: registryInternalDependencies,

	};
}

export function validateFinalEvidence(value: unknown): FinalReleaseEvidence {
	const evidence = object(value, "final evidence");
	keys(evidence, ["schema_version", "source_commit", "release_version", "expected_evidence_sha256", "packages"], "final evidence");
	if (evidence.schema_version !== RELEASE_EVIDENCE_SCHEMA_VERSION) fail("final evidence schema_version is invalid");
	const sourceCommit = string(evidence.source_commit, "final evidence.source_commit");
	if (!sourceCommitPattern.test(sourceCommit)) fail("final evidence.source_commit must be a lowercase commit SHA");
	const releaseVersion = string(evidence.release_version, "final evidence.release_version");
	if (!stableVersionPattern.test(releaseVersion)) fail("final evidence.release_version must be stable semver");
	const expectedEvidenceSha = string(evidence.expected_evidence_sha256, "final evidence.expected_evidence_sha256");
	if (!sha256Pattern.test(expectedEvidenceSha)) fail("final evidence.expected_evidence_sha256 must be lowercase SHA-256");
	if (!Array.isArray(evidence.packages)) fail("final evidence.packages must be an array");
	const packages = evidence.packages.map((record, index) => validateFinalPackageRecord(record, `final evidence.packages[${index}]`));
	assertSortedPackageRecords(packages, "final evidence.packages");
	if (packages.some(record => record.version !== releaseVersion)) fail("final evidence package versions must match release_version");
	return {
		schema_version: 1,
		source_commit: sourceCommit,
		release_version: releaseVersion,
		expected_evidence_sha256: expectedEvidenceSha,
		packages,
	};
}

export function createFinalEvidence(
	expected: ExpectedReleaseEvidence,
	expectedEvidenceSha256: string,
	observations: Readonly<Record<string, RegistryPackageObservation>>,
): FinalReleaseEvidence {
	const validatedExpected = validateExpectedEvidence(expected);
	if (!sha256Pattern.test(expectedEvidenceSha256)) fail("expectedEvidenceSha256 must be lowercase SHA-256");
	const packages = validatedExpected.packages.map(record => {
		const observation = observations[record.name];
		if (observation === undefined) fail(`registry observation is missing ${record.name}`);
		if (classifyRegistryObservation(record, observation) !== "skip") {
			fail(`registry observation conflicts with expected evidence for ${record.name}`);
		}
		return {
			...record,
			registry_sri: observation.registry_sri,
			registry_tarball_sha512: observation.registry_tarball_sha512,
			registry_manifest_sha256: observation.registry_manifest_sha256,
			registry_internal_dependencies: observation.registry_internal_dependencies,
		};
	});

	for (const name of Object.keys(observations)) {
		if (!publicPackageByName.has(name)) fail(`registry observation contains unknown package ${name}`);
	}
	return validateFinalEvidence({
		schema_version: RELEASE_EVIDENCE_SCHEMA_VERSION,
		source_commit: validatedExpected.source_commit,
		release_version: validatedExpected.release_version,
		expected_evidence_sha256: expectedEvidenceSha256,
		packages,
	});
}

export function verifyFinalEvidence(expected: ExpectedReleaseEvidence, final: FinalReleaseEvidence, expectedEvidenceSha?: string): void {
	const validatedExpected = validateExpectedEvidence(expected);
	const validatedFinal = validateFinalEvidence(final);
	const digest = expectedEvidenceSha ?? expectedEvidenceSha256(validatedExpected);
	if (validatedFinal.expected_evidence_sha256 !== digest) fail("final evidence does not link to the expected evidence digest");
	if (
		validatedFinal.source_commit !== validatedExpected.source_commit ||
		validatedFinal.release_version !== validatedExpected.release_version
	) {
		fail("final evidence does not match expected release identity");
	}
	for (let index = 0; index < validatedExpected.packages.length; index += 1) {
		const expectedRecord = validatedExpected.packages[index]!;
		const finalRecord = validatedFinal.packages[index]!;
		const registry: RegistryPackageObservation = {
			registry_sri: finalRecord.registry_sri,
			registry_tarball_sha512: finalRecord.registry_tarball_sha512,
			registry_manifest_sha256: finalRecord.registry_manifest_sha256,
			registry_internal_dependencies: finalRecord.registry_internal_dependencies,
		};
		if (JSON.stringify(canonicalJsonValue(expectedRecord)) !== JSON.stringify(canonicalJsonValue({
			dir: finalRecord.dir,
			name: finalRecord.name,
			version: finalRecord.version,
			tarball_sha512: finalRecord.tarball_sha512,
			expected_sri: finalRecord.expected_sri,
			manifest_sha256: finalRecord.manifest_sha256,
			unpacked_size: finalRecord.unpacked_size,
			file_count: finalRecord.file_count,
			internal_dependencies: finalRecord.internal_dependencies,
		}))) {
			fail(`final evidence changed expected record ${expectedRecord.name}`);
		}
		if (classifyRegistryObservation(expectedRecord, registry) !== "skip") {
			fail(`final evidence registry observation conflicts for ${expectedRecord.name}`);
		}
	}
}

async function readCanonicalEvidenceFile<T>(filePath: string, validator: (value: unknown) => T): Promise<{ value: T; sha256: string }> {
	const bytes = await fs.readFile(filePath);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
	} catch {
		fail(`${filePath} is not valid UTF-8 JSON`);
	}
	const validated = validator(value);
	if (!bytes.equals(canonicalJsonBytes(validated))) fail(`${filePath} is not canonical JSON`);
	return { value: validated, sha256: sha256(bytes) };
}

export async function readExpectedEvidenceFile(filePath: string): Promise<{ value: ExpectedReleaseEvidence; sha256: string }> {
	return readCanonicalEvidenceFile(filePath, validateExpectedEvidence);
}

export async function readFinalEvidenceFile(filePath: string): Promise<{ value: FinalReleaseEvidence; sha256: string }> {
	return readCanonicalEvidenceFile(filePath, validateFinalEvidence);
}

function isMissingFile(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

/**
 * Creates an immutable file exclusively, or proves that a concurrent creator wrote
 * the exact same bytes. The temporary file is fully written before an atomic hard
 * link claims the destination, so EEXIST readers never observe a partial artifact.
 */
export async function writeImmutableBytes(filePath: string, bytes: Uint8Array): Promise<string> {
	const directory = path.dirname(filePath);
	const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	let ownsTemporary = false;
	await fs.mkdir(directory, { recursive: true });
	try {
		const temporary = await fs.open(temporaryPath, "wx", 0o644);
		ownsTemporary = true;
		try {
			await temporary.writeFile(bytes);
		} finally {
			await temporary.close();
		}
		try {
			await fs.link(temporaryPath, filePath);
			return sha256(bytes);
		} catch (error) {
			if (!isExistingFile(error)) throw error;
			const existing = await fs.readFile(filePath);
			if (!existing.equals(bytes)) fail(`${filePath} already exists with different immutable evidence`);
			return sha256(existing);
		}
	} finally {
		if (ownsTemporary) await fs.rm(temporaryPath, { force: true });
	}
}

export async function writeImmutableEvidence(filePath: string, value: ExpectedReleaseEvidence | FinalReleaseEvidence): Promise<string> {
	const validated = "expected_evidence_sha256" in value ? validateFinalEvidence(value) : validateExpectedEvidence(value);
	return writeImmutableBytes(filePath, canonicalJsonBytes(validated));
}

export function assertStableFinalization(input: StableFinalizationInput): void {
	const expected = validateExpectedEvidence(input.expected);
	const final = validateFinalEvidence(input.final);
	if (!stableVersionPattern.test(input.version)) fail("stable finalization version must be exact X.Y.Z");
	if (input.tag !== `v${input.version}`) fail("stable finalization tag must be the exact vX.Y.Z tag");
	if (!sourceCommitPattern.test(input.sourceCommit)) fail("stable finalization sourceCommit must be a lowercase commit SHA");
	if (expected.release_version !== input.version || final.release_version !== input.version) {
		fail("stable finalization version does not match evidence");
	}
	if (expected.source_commit !== input.sourceCommit || final.source_commit !== input.sourceCommit) {
		fail("stable finalization source commit does not match evidence");
	}
	if (!sourceCommitPattern.test(input.tagCommit)) fail("stable finalization tagCommit must be a lowercase commit SHA");
	if (input.tagCommit !== input.sourceCommit) fail("release tag does not peel to the evidence source commit");
	verifyFinalEvidence(expected, final, input.expectedEvidenceSha256);
}

function createSelfTestTarball(manifest: string): Buffer {
	return createCanonicalTarball([
		{ path: "package/index.js", mode: 0o644, type: "file", data: Buffer.from("export {};\n") },
		{ path: "package/package.json", mode: 0o644, type: "file", data: Buffer.from(manifest, "utf8") },
	]);
}

export function selfTest(): void {
	const rawManifest = "{\r\n  \"name\": \"@gajae-code/ai\",\r\n  \"version\": \"1.2.3\"\r\n}\r\n";
	const tarball = createSelfTestTarball(rawManifest);
	const inspection = inspectPackageTarball(tarball);
	if (!inspection.manifestBytes.equals(Buffer.from(rawManifest))) fail("self-test lost raw manifest bytes");
	const canonical = canonicalizePackageTarball(tarball);
	if (!canonical.equals(tarball)) fail("self-test canonical tarball was unstable");
	const record = packageEvidenceFromTarball(PUBLIC_PACKAGE_DEFINITIONS[1]!, tarball);
	validateExpectedTarball(record, tarball);
	if (classifyRegistryObservation(record, undefined) !== "publish") fail("self-test missing registry classification failed");
	const observed: RegistryPackageObservation = {
		registry_sri: record.expected_sri,
		registry_tarball_sha512: record.tarball_sha512,
		registry_manifest_sha256: record.manifest_sha256,
		registry_internal_dependencies: record.internal_dependencies,
		registry_latest_version: record.version,

	};
	if (classifyRegistryObservation(record, observed) !== "skip") fail("self-test exact registry classification failed");
	if (classifyRegistryObservation(record, { ...observed, registry_manifest_sha256: "0".repeat(64) }) !== "conflict") {
		fail("self-test conflicting registry classification failed");
	}
}

/** Deterministic producer fixture for consumers of source release evidence. */
export interface GoldenReleaseEvidence {
	expected_evidence: ExpectedReleaseEvidence;
	expected_evidence_sha256: string;
	final_evidence: FinalReleaseEvidence;
	final_evidence_sha256: string;
}

export function createGoldenReleaseEvidence(): GoldenReleaseEvidence {
	const releaseVersion = "1.2.3";
	const packages = PUBLIC_PACKAGE_DEFINITIONS.map(definition => {
		const manifest = JSON.stringify({
			name: definition.name,
			version: releaseVersion,
			...(definition.name === "@gajae-code/coding-agent"
				? { devDependencies: { "@gajae-code/ai": releaseVersion } }
				: {}),
		});
		return packageEvidenceFromTarball(definition, createSelfTestTarball(manifest));
	});
	const expected = createExpectedEvidence({
		sourceCommit: "0".repeat(40),
		releaseVersion,
		packages,
	});
	const expectedDigest = expectedEvidenceSha256(expected);
	const observations: Record<string, RegistryPackageObservation> = {};
	for (const record of expected.packages) {
		observations[record.name] = {
			registry_sri: record.expected_sri,
			registry_tarball_sha512: record.tarball_sha512,
			registry_manifest_sha256: record.manifest_sha256,
			registry_internal_dependencies: record.internal_dependencies,
			registry_latest_version: record.version,
		};
	}
	const final = createFinalEvidence(expected, expectedDigest, observations);
	return {
		expected_evidence: expected,
		expected_evidence_sha256: expectedDigest,
		final_evidence: final,
		final_evidence_sha256: sha256(canonicalJsonBytes(final)),
	};
}

export function goldenReleaseEvidenceBytes(): Buffer {
	return canonicalJsonBytes(createGoldenReleaseEvidence());
}

export function goldenReleaseEvidenceSha256(): string {
	return sha256(goldenReleaseEvidenceBytes());
}


export type ReleaseEvidenceCli =
	| { mode: "self-test" }
	| { mode: "emit-golden-evidence" }
	| { mode: "verify-final"; expectedEvidence: string; finalEvidence: string }

	| {
		mode: "verify-stable-finalization";
		expectedEvidence: string;
		finalEvidence: string;
		tag: string;
		version: string;
		sourceCommit: string;
	};

function parseNamedArguments(
	argv: readonly string[],
	mode: string,
	allowed: readonly string[],
	required: readonly string[],
): ReadonlyMap<string, string> {
	const values = new Map<string, string>();
	const allowedArguments = new Set(allowed);
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!;
		if (!allowedArguments.has(argument)) fail(`${argument} is not valid with ${mode}`);
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) fail(`missing value for ${argument}`);
		if (values.has(argument)) fail(`duplicate argument ${argument}`);
		values.set(argument, value);
		index += 1;
	}
	for (const argument of required) {
		if (!values.has(argument)) fail(`missing ${argument}`);
	}
	return values;
}

function namedArgument(values: ReadonlyMap<string, string>, name: string): string {
	const value = values.get(name);
	if (value === undefined) fail(`missing ${name}`);
	return value;
}

export function parseReleaseEvidenceCli(argv: readonly string[]): ReleaseEvidenceCli {
	const [mode, ...argumentsForMode] = argv;
	if (mode === "--self-test") {
		if (argumentsForMode.length !== 0) fail("--self-test cannot be combined with other arguments");
		return { mode: "self-test" };
	}
	if (mode === "--emit-golden-evidence") {
		if (argumentsForMode.length !== 0) fail("--emit-golden-evidence cannot be combined with other arguments");
		return { mode: "emit-golden-evidence" };
	}

	if (mode === "--verify-final") {
		const values = parseNamedArguments(
			argumentsForMode,
			mode,
			["--expected-evidence", "--final-evidence"],
			["--expected-evidence", "--final-evidence"],
		);
		return {
			mode: "verify-final",
			expectedEvidence: namedArgument(values, "--expected-evidence"),
			finalEvidence: namedArgument(values, "--final-evidence"),
		};
	}
	if (mode === "--verify-stable-finalization") {
		const values = parseNamedArguments(
			argumentsForMode,
			mode,
			["--expected-evidence", "--final-evidence", "--tag", "--version", "--source-commit"],
			["--expected-evidence", "--final-evidence", "--tag", "--version", "--source-commit"],
		);
		return {
			mode: "verify-stable-finalization",
			expectedEvidence: namedArgument(values, "--expected-evidence"),
			finalEvidence: namedArgument(values, "--final-evidence"),
			tag: namedArgument(values, "--tag"),
			version: namedArgument(values, "--version"),
			sourceCommit: namedArgument(values, "--source-commit"),
		};
	}
	fail("use exactly one of --self-test, --emit-golden-evidence, --verify-final, or --verify-stable-finalization");
}

async function resolveTagCommit(tag: string): Promise<string> {
	const result = await $`git rev-parse ${`${tag}^{commit}`}`.quiet().nothrow();
	if (result.exitCode !== 0) fail(`cannot peel release tag ${tag}`);
	const commit = result.stdout.toString().trim();
	if (!sourceCommitPattern.test(commit)) fail(`release tag ${tag} did not resolve to a commit`);
	return commit;
}

function machineResult(value: Record<string, unknown>): void {
	console.log(JSON.stringify(value));
}

async function main(): Promise<void> {
	const command = parseReleaseEvidenceCli(process.argv.slice(2));
	if (command.mode === "emit-golden-evidence") {
		process.stdout.write(goldenReleaseEvidenceBytes());
		return;
	}
	if (command.mode === "self-test") {
		selfTest();
		machineResult({ ok: true, phase: "self-test" });
		return;
	}
	const expected = await readExpectedEvidenceFile(command.expectedEvidence);
	const final = await readFinalEvidenceFile(command.finalEvidence);
	if (command.mode === "verify-stable-finalization") {
		const tagCommit = await resolveTagCommit(command.tag);
		assertStableFinalization({
			expected: expected.value,
			final: final.value,
			expectedEvidenceSha256: expected.sha256,
			tag: command.tag,
			version: command.version,
			sourceCommit: command.sourceCommit,
			tagCommit,
		});
		machineResult({
			ok: true,
			phase: "stable-finalization",
			tag: command.tag,
			version: command.version,
			source_commit: command.sourceCommit,
			expected_evidence: command.expectedEvidence,
			final_evidence: command.finalEvidence,
		});
		return;
	}
	verifyFinalEvidence(expected.value, final.value, expected.sha256);
	machineResult({ ok: true, phase: "final-evidence", expected_evidence: command.expectedEvidence, final_evidence: command.finalEvidence });
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		machineResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
	}
}
