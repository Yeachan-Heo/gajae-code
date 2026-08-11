/**
 * Trusted advisory guide manifest: types, canonical encoding, and parsing.
 *
 * A manifest is a signed, time-boxed bundle of advisory guide bindings. Each
 * entry binds a stable guide id to the SHA-256 digest of its advisory text, so
 * the advisory content can be fetched separately and verified against the
 * signed manifest. Manifests are advisory text only: they never carry
 * instructions to execute or configuration to apply.
 */
export const GUIDES_MANIFEST_VERSION = 1;

/** Maximum byte length of a single advisory text file. */
export const GUIDE_ADVISORY_MAX_BYTES = 256 * 1024;
/** Maximum number of guides bound by a single manifest. */
export const GUIDE_MANIFEST_MAX_ENTRIES = 256;
/** Maximum manifest JSON byte length (enforced at fetch and cache read time). */
export const GUIDE_MANIFEST_MAX_BYTES = 1024 * 1024;
export const GUIDE_ID_MAX_LENGTH = 128;
export const GUIDE_TITLE_MAX_LENGTH = 256;

export interface GuideEntryV1 {
	/** Path-safe, stable guide id, e.g. "troubleshooting/socket". */
	id: string;
	/** Human-readable advisory title. */
	title: string;
	/** Hex SHA-256 of the advisory text bytes; binds content to the signed manifest. */
	sha256: string;
}

export interface GuideManifestV1 {
	version: 1;
	/** Stable channel identity the signature binds to; the rollback floor is per manifestId. */
	manifestId: string;
	/** Key id of the pinned Ed25519 public key that detached-signed the canonical manifest bytes. */
	keyId: string;
	/** Monotonic per-manifestId sequence; the cache refuses installs at or below the floor. */
	sequence: number;
	/** Milliseconds since epoch; the manifest is not authoritative before this instant. */
	issuedAt: number;
	/** Milliseconds since epoch; the manifest is not authoritative after this instant. */
	expiresAt: number;
	/** Minimum SDK advisory client version required to consume this manifest. */
	minimumSdkVersion: number;
	guides: GuideEntryV1[];
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const GUIDE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){0,15}$/;
const MANIFEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Deterministic UTF-8 encoding of a guide manifest. Object keys are sorted,
 * separators are compact, and the output is byte-identical for semantically
 * equal manifests regardless of the original JSON formatting. The detached
 * Ed25519 signature is verified over exactly these bytes, so a re-formatted
 * manifest file still verifies while any semantic change breaks the signature.
 */
export function canonicalGuideManifestBytes(manifest: GuideManifestV1): Buffer {
	return Buffer.from(canonicalGuideJson(manifest), "utf8");
}

function canonicalGuideJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalGuideJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalGuideJson(record[key])}`)
		.join(",")}}`;
}

export type GuideManifestParseResult =
	| { ok: true; manifest: GuideManifestV1 }
	| { ok: false; error: { code: "invalid_manifest" | "unsupported_version"; message: string } };

function manifestParseFailure(
	code: "invalid_manifest" | "unsupported_version",
	message: string,
): GuideManifestParseResult {
	return { ok: false, error: { code, message } };
}

/**
 * Strict shape validation for a parsed manifest value. Fails closed on any
 * out-of-bounds field; a manifest for a newer format version is refused with
 * `unsupported_version` so callers can distinguish "too new" from "malformed".
 */
export function parseGuideManifest(value: unknown): GuideManifestParseResult {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return manifestParseFailure("invalid_manifest", "Guide manifest must be a JSON object.");
	const record = value as Record<string, unknown>;
	if (!Number.isSafeInteger(record.version))
		return manifestParseFailure("invalid_manifest", "Guide manifest version must be an integer.");
	const version = record.version as number;
	if (version > GUIDES_MANIFEST_VERSION)
		return manifestParseFailure(
			"unsupported_version",
			`Guide manifest version ${version} is newer than the supported version ${GUIDES_MANIFEST_VERSION}.`,
		);
	if (version !== GUIDES_MANIFEST_VERSION)
		return manifestParseFailure(
			"invalid_manifest",
			`Guide manifest version ${version} is not supported (expected ${GUIDES_MANIFEST_VERSION}).`,
		);
	if (typeof record.manifestId !== "string" || !MANIFEST_ID_PATTERN.test(record.manifestId))
		return manifestParseFailure("invalid_manifest", "Guide manifestId is malformed.");
	if (typeof record.keyId !== "string" || !SHA256_HEX.test(record.keyId))
		return manifestParseFailure("invalid_manifest", "Guide manifest keyId must be a SHA-256 hex digest.");
	if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1)
		return manifestParseFailure("invalid_manifest", "Guide manifest sequence must be a positive integer.");
	if (!Number.isSafeInteger(record.issuedAt) || (record.issuedAt as number) < 0)
		return manifestParseFailure("invalid_manifest", "Guide manifest issuedAt must be a non-negative timestamp.");
	if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= (record.issuedAt as number))
		return manifestParseFailure("invalid_manifest", "Guide manifest expiresAt must be after issuedAt.");
	if (!Number.isSafeInteger(record.minimumSdkVersion) || (record.minimumSdkVersion as number) < 1)
		return manifestParseFailure("invalid_manifest", "Guide manifest minimumSdkVersion must be a positive integer.");
	if (!Array.isArray(record.guides) || record.guides.length === 0 || record.guides.length > GUIDE_MANIFEST_MAX_ENTRIES)
		return manifestParseFailure(
			"invalid_manifest",
			`Guide manifest guides must contain between 1 and ${GUIDE_MANIFEST_MAX_ENTRIES} entries.`,
		);
	const guides: GuideEntryV1[] = [];
	const seenIds = new Set<string>();
	for (const rawEntry of record.guides) {
		if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry))
			return manifestParseFailure("invalid_manifest", "Guide entry must be a JSON object.");
		const entry = rawEntry as Record<string, unknown>;
		if (typeof entry.id !== "string" || entry.id.length > GUIDE_ID_MAX_LENGTH || !GUIDE_ID_PATTERN.test(entry.id))
			return manifestParseFailure("invalid_manifest", "Guide entry id is malformed.");
		if (seenIds.has(entry.id))
			return manifestParseFailure("invalid_manifest", `Guide entry id ${entry.id} is duplicated.`);
		if (typeof entry.title !== "string" || entry.title.length === 0 || entry.title.length > GUIDE_TITLE_MAX_LENGTH)
			return manifestParseFailure("invalid_manifest", "Guide entry title is malformed.");
		if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256))
			return manifestParseFailure("invalid_manifest", "Guide entry sha256 must be a SHA-256 hex digest.");
		seenIds.add(entry.id);
		guides.push({ id: entry.id, title: entry.title, sha256: entry.sha256 });
	}
	return {
		ok: true,
		manifest: {
			version: GUIDES_MANIFEST_VERSION,
			manifestId: record.manifestId,
			keyId: record.keyId,
			sequence: record.sequence as number,
			issuedAt: record.issuedAt as number,
			expiresAt: record.expiresAt as number,
			minimumSdkVersion: record.minimumSdkVersion as number,
			guides,
		},
	};
}
