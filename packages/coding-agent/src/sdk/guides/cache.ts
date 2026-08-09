import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../../config/file-lock";
import { assertSupportedStateVersion, SDK_STATE_VERSION } from "../broker/state-version";
import {
	canonicalGuideManifestBytes,
	GUIDE_ADVISORY_MAX_BYTES,
	GUIDE_MANIFEST_MAX_BYTES,
	type GuideEntryV1,
	type GuideManifestV1,
	parseGuideManifest,
} from "./manifest";
import {
	type GuideVerificationErrorCode,
	guideRollbackCheck,
	verifyGuideAdvisoryText,
	verifyGuideManifest,
} from "./verify";

/**
 * Verified on-disk cache for trusted advisory guides.
 *
 * Layout under `<agentDir>/sdk/guides/cache/` (mode 0700):
 *   meta.json — atomic commit pointer {version, manifestId, sequence, generation, installedAt}
 *   meta.json.lock — cross-process install lock (project `withFileLock` convention)
 *   generations/<generation>/manifest.json — canonical manifest bytes
 *   generations/<generation>/manifest.sig — detached Ed25519 signature
 *   generations/<generation>/guides/<sha256> — immutable advisory text
 *
 * A complete generation is written and fsynced before `meta.json` is atomically
 * replaced under the install lock. Readers follow only the committed
 * generation, so an interrupted install cannot expose a new manifest with
 * stale metadata or disturb the previously valid cache.
 */
export interface GuideCacheMetaV1 {
	version: typeof SDK_STATE_VERSION;
	manifestId: string;
	sequence: number;
	installedAt: number;
	generation: string;
}

export interface GuideCacheGuideV1 {
	id: string;
	title: string;
	sha256: string;
	text: string;
}

export interface VerifiedGuideCache {
	manifest: GuideManifestV1;
	signatureBytes: Uint8Array;
	meta: GuideCacheMetaV1;
	guides: GuideCacheGuideV1[];
}

export type GuideCacheReadResult =
	| { ok: true; value: VerifiedGuideCache }
	| {
			ok: false;
			error: {
				code: "missing_cache" | "corrupt_cache" | "expired_cache" | "unsupported_state_version";
				message: string;
			};
	  };

export type GuideCacheInstallResult =
	| { ok: true; value: VerifiedGuideCache }
	| { ok: false; error: { code: GuideVerificationErrorCode | "invalid_input" | "io_error"; message: string } };

const GUIDE_CACHE_META_MAX_BYTES = 64 * 1024;

const guideUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function guideCacheDir(agentDir: string): string {
	return path.join(agentDir, "sdk", "guides", "cache");
}

function cacheFailure(
	code: "missing_cache" | "corrupt_cache" | "expired_cache" | "unsupported_state_version",
	message: string,
): GuideCacheReadResult {
	return { ok: false, error: { code, message } };
}

function isGuideCacheMetaV1(value: unknown): value is GuideCacheMetaV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<GuideCacheMetaV1>;
	return (
		record.version === SDK_STATE_VERSION &&
		typeof record.manifestId === "string" &&
		record.manifestId.length > 0 &&
		Number.isSafeInteger(record.sequence) &&
		(record.sequence as number) >= 1 &&
		Number.isSafeInteger(record.installedAt) &&
		(record.installedAt as number) >= 0 &&
		/^[a-zA-Z0-9._-]+$/.test(record.generation ?? "")
	);
}

/** Reads a file with O_NOFOLLOW, bounds its size, and returns raw bytes; undefined when absent. */
async function readBoundedBytes(file: string, maxBytes: number): Promise<Uint8Array | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) throw new Error(`Cache target is not a regular file: ${file}`);
		if (stat.size > BigInt(maxBytes)) throw new Error(`Cache file exceeds the maximum byte length: ${file}`);
		const bytes = Buffer.alloc(Number(stat.size) + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		return bytes.subarray(0, bytesRead);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		if (handle) await handle.close();
	}
}

function parseFatalUtf8Json(bytes: Uint8Array): unknown {
	return JSON.parse(guideUtf8Decoder.decode(bytes));
}

function corruptCache(message: string): GuideCacheReadResult {
	return cacheFailure("corrupt_cache", message);
}

/**
 * Reads and re-verifies the cache end to end: manifest parse, meta commit
 * record, detached signature, expiry against `now`, and every advisory hash.
 * Any failure is reported as `corrupt_cache` (or `expired_cache` when the
 * signature is valid but stale) and the cache is left untouched — a corrupt
 * entry never destroys the data a future, still-valid install may replace.
 */
export async function readGuideCache(params: { agentDir: string; now: number }): Promise<GuideCacheReadResult> {
	const dir = guideCacheDir(params.agentDir);
	try {
		const metaRaw = await readBoundedBytes(path.join(dir, "meta.json"), GUIDE_CACHE_META_MAX_BYTES);
		if (metaRaw === undefined) return cacheFailure("missing_cache", "No guide cache has been installed.");
		let metaValue: unknown;
		try {
			metaValue = parseFatalUtf8Json(metaRaw);
		} catch {
			return corruptCache("Guide cache meta.json is not valid UTF-8 JSON.");
		}
		try {
			assertSupportedStateVersion(path.join(dir, "meta.json"), metaValue);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "unsupported_state_version")
				return cacheFailure("unsupported_state_version", error.message);
			throw error;
		}
		if (!isGuideCacheMetaV1(metaValue)) return corruptCache("Guide cache meta.json is malformed.");
		const meta = metaValue;
		const generationDir = path.join(dir, "generations", meta.generation);

		const manifestRaw = await readBoundedBytes(path.join(generationDir, "manifest.json"), GUIDE_MANIFEST_MAX_BYTES);
		if (manifestRaw === undefined) return corruptCache("Guide cache manifest.json is missing.");
		let manifestValue: unknown;
		try {
			manifestValue = parseFatalUtf8Json(manifestRaw);
		} catch {
			return corruptCache("Guide cache manifest.json is not valid UTF-8 JSON.");
		}
		const parsed = parseGuideManifest(manifestValue);
		if (!parsed.ok) return corruptCache(`Guide cache manifest is invalid: ${parsed.error.message}`);
		const manifest = parsed.manifest;
		if (manifest.manifestId !== meta.manifestId)
			return corruptCache("Guide cache manifest manifestId does not match meta.json.");

		const signatureRaw = await readBoundedBytes(path.join(generationDir, "manifest.sig"), 1024);
		if (signatureRaw === undefined) return corruptCache("Guide cache manifest.sig is missing.");

		const verified = verifyGuideManifest({ manifest, signatureBytes: signatureRaw, now: params.now });
		if (!verified.ok) {
			if (verified.error.code === "expired")
				return cacheFailure("expired_cache", `Guide cache is expired: ${verified.error.message}`);
			return corruptCache(`Guide cache failed verification: ${verified.error.message}`);
		}

		const guides: GuideCacheGuideV1[] = [];
		for (const entry of manifest.guides) {
			const advisoryRaw = await readBoundedBytes(
				path.join(generationDir, "guides", entry.sha256),
				GUIDE_ADVISORY_MAX_BYTES,
			);
			if (advisoryRaw === undefined) return corruptCache(`Guide cache is missing advisory content for ${entry.id}.`);
			const binding = verifyGuideAdvisoryText(entry, advisoryRaw);
			if (!binding.ok) return corruptCache(`Guide cache advisory failed verification: ${binding.error.message}`);
			let text: string;
			try {
				text = guideUtf8Decoder.decode(advisoryRaw);
			} catch {
				return corruptCache(`Guide cache advisory ${entry.id} is not valid UTF-8.`);
			}
			guides.push({ id: entry.id, title: entry.title, sha256: entry.sha256, text });
		}
		return { ok: true, value: { manifest, signatureBytes: signatureRaw, meta, guides } };
	} catch (error) {
		return corruptCache(`Guide cache could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function installFailure(
	code: GuideVerificationErrorCode | "invalid_input" | "io_error",
	message: string,
): GuideCacheInstallResult {
	return { ok: false, error: { code, message } };
}

async function writeVerifiedTemp(file: string, bytes: Uint8Array): Promise<void> {
	const temporary = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
	try {
		const handle = await fs.open(
			temporary,
			fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, file);
	} catch (error) {
		await fs.unlink(temporary).catch(() => {});
		throw error;
	}
}

async function syncDirectory(dir: string): Promise<void> {
	const directory = await fs.open(dir, fsSync.constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/**
 * Installs a verified manifest plus its advisory content into the cache.
 *
 * Order of operations:
 *   1. Verify the manifest signature, expiry, and every advisory hash before
 *      any write — a tampered or expired payload never touches disk.
 *   2. Under the cache's cross-process install lock, enforce the monotonic
 *      version floor against the committed meta record (`rollback` when the
 *      candidate does not advance the channel).
 *   3. Write and fsync a complete immutable generation, then atomically replace
 *      `meta.json` as the only commit pointer.
 *
 * Steps 2–3 are serialized with `<cacheDir>/meta.json.lock` (the project's
 * `withFileLock` convention): the floor is re-read under the same lock that
 * guards the commit pointer replacement, so a concurrent install can never
 * read an older floor, observe a newer commit, and then downgrade the channel.
 * Any failure aborts before the commit, leaving the prior valid cache fully
 * intact and readable.
 */
export async function installGuideCache(params: {
	agentDir: string;
	manifest: GuideManifestV1;
	signatureBytes: Uint8Array;
	advisories: readonly { entry: GuideEntryV1; text: Uint8Array }[];
	now: number;
}): Promise<GuideCacheInstallResult> {
	const { manifest, signatureBytes, advisories, now } = params;
	const verified = verifyGuideManifest({ manifest, signatureBytes, now });
	if (!verified.ok) return installFailure(verified.error.code, verified.error.message);

	if (advisories.length !== manifest.guides.length)
		return installFailure(
			"invalid_input",
			`Advisory count ${advisories.length} does not match the manifest guide count ${manifest.guides.length}.`,
		);
	const advisoryById = new Map(advisories.map(advisory => [advisory.entry.id, advisory]));
	for (const entry of manifest.guides) {
		const advisory = advisoryById.get(entry.id);
		if (!advisory) return installFailure("invalid_input", `Advisory text is missing for manifest entry ${entry.id}.`);
		if (advisory.text.byteLength > GUIDE_ADVISORY_MAX_BYTES)
			return installFailure("invalid_input", `Advisory ${entry.id} exceeds the maximum byte length.`);
		const binding = verifyGuideAdvisoryText(entry, advisory.text);
		if (!binding.ok) return installFailure(binding.error.code, binding.error.message);
	}

	const dir = guideCacheDir(params.agentDir);
	const metaPath = path.join(dir, "meta.json");
	try {
		return await withFileLock(metaPath, async () => {
			let priorMeta: GuideCacheMetaV1 | undefined;
			try {
				const metaRaw = await readBoundedBytes(metaPath, GUIDE_CACHE_META_MAX_BYTES);
				if (metaRaw !== undefined) {
					let metaValue: unknown;
					try {
						metaValue = parseFatalUtf8Json(metaRaw);
					} catch {
						return installFailure("corrupt_cache", "Existing guide cache meta.json is not valid UTF-8 JSON.");
					}
					try {
						assertSupportedStateVersion(metaPath, metaValue);
					} catch (error) {
						if (error instanceof Error && "code" in error && error.code === "unsupported_state_version")
							return installFailure("unsupported_state_version", error.message);
						throw error;
					}
					if (!isGuideCacheMetaV1(metaValue))
						return installFailure("corrupt_cache", "Existing guide cache meta.json is malformed.");
					priorMeta = metaValue;
				}
			} catch (error) {
				return installFailure(
					"io_error",
					`Guide cache meta could not be read: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			const floor = guideRollbackCheck(priorMeta, manifest);
			if (!floor.ok) return installFailure(floor.error.code, floor.error.message);

			const generation = `${manifest.sequence}-${randomUUID()}`;
			const generationDir = path.join(dir, "generations", generation);
			const guidesDir = path.join(generationDir, "guides");
			await fs.mkdir(guidesDir, { recursive: true, mode: 0o700 });
			for (const advisory of advisories) {
				await writeVerifiedTemp(path.join(guidesDir, advisory.entry.sha256), advisory.text);
			}
			await writeVerifiedTemp(path.join(generationDir, "manifest.json"), canonicalGuideManifestBytes(manifest));
			await writeVerifiedTemp(path.join(generationDir, "manifest.sig"), Buffer.from(signatureBytes));
			await syncDirectory(generationDir);
			const meta: GuideCacheMetaV1 = {
				version: SDK_STATE_VERSION,
				manifestId: manifest.manifestId,
				sequence: manifest.sequence,
				installedAt: now,
				generation,
			};
			await writeVerifiedTemp(metaPath, Buffer.from(`${JSON.stringify(meta)}\n`));
			await syncDirectory(dir);
			return {
				ok: true,
				value: {
					manifest,
					signatureBytes,
					meta,
					guides: advisories.map(advisory => ({
						id: advisory.entry.id,
						title: advisory.entry.title,
						sha256: advisory.entry.sha256,
						text: guideUtf8Decoder.decode(advisory.text),
					})),
				},
			};
		});
	} catch (error) {
		return installFailure(
			"io_error",
			`Guide cache install failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
