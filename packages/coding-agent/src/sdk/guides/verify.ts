import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import {
	canonicalGuideManifestBytes,
	GUIDES_MANIFEST_VERSION,
	type GuideEntryV1,
	type GuideManifestV1,
} from "./manifest";

/**
 * Version of the SDK advisory guide client. Manifests carry a
 * `minimumSdkVersion` compatibility floor; a manifest that requires a newer
 * client is refused (`incompatible`) instead of being partially understood.
 */
export const GUIDE_CLIENT_VERSION = 1;

/** Ed25519 detached signatures are always exactly 64 bytes. */
export const GUIDE_SIGNATURE_BYTES = 64;

export interface GuidePinnedKey {
	keyId: string;
	/** DER-encoded SPKI public key, hex. */
	spkiDerHex: string;
	source: "bundled";
}

/**
 * Pinned Ed25519 public keys accepted for guide manifests. A manifest whose
 * `keyId` is not in this registry is refused (`unknown_key`) — the registry is
 * compiled into the binary and is the only trust root for advisory content.
 * Private key material is never shipped; manifests are signed out-of-band.
 */
const guidePinnedKeys: GuidePinnedKey[] = [
	{
		keyId: "6c4b134ff9fb86a52d55cb6bb7c2fab938405b53b4148afc4249a2cb6f504bce",
		spkiDerHex: "302a300506032b6570032100ef665d05c6795341dfc893866d8fe5be4b48891c0ed0d125940d7032de37723e",
		source: "bundled",
	},
];
export const GUIDE_PINNED_KEYS: readonly GuidePinnedKey[] = Object.freeze(
	guidePinnedKeys.map(key => Object.freeze({ ...key })),
);

export const GUIDE_PINNED_KEY_IDS: readonly string[] = Object.freeze(GUIDE_PINNED_KEYS.map(key => key.keyId));

export type GuideVerificationErrorCode =
	| "invalid_manifest"
	| "unsupported_version"
	| "unknown_key"
	| "corrupt_signature"
	| "invalid_signature"
	| "not_yet_valid"
	| "expired"
	| "incompatible"
	| "rollback"
	| "hash_mismatch"
	| (string & {});

export type GuideVerificationResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: GuideVerificationErrorCode; message: string } };

function guideFailure<T>(code: GuideVerificationErrorCode, message: string): GuideVerificationResult<T> {
	return { ok: false, error: { code, message } };
}

const guideKeyCache = new Map<string, KeyObject>();

/** Test-only override: installs an additional trusted key for deterministic tests. */
export function addTestGuidePinnedKey(key: GuidePinnedKey): void {
	if (process.env.GJC_TEST_GUIDE_KEYS !== "1") throw new Error("Test guide key injection is disabled.");
	guideKeyCache.delete(key.keyId);
	guidePinnedKeys.push(key);
}

/** Test-only override: removes a previously installed test key. */
export function removeTestGuidePinnedKey(keyId: string): void {
	if (process.env.GJC_TEST_GUIDE_KEYS !== "1") throw new Error("Test guide key injection is disabled.");
	guideKeyCache.delete(keyId);
	const index = guidePinnedKeys.findIndex(key => key.keyId === keyId);
	if (index >= 0) guidePinnedKeys.splice(index, 1);
}

function pinnedGuideKey(keyId: string): GuidePinnedKey | undefined {
	return guidePinnedKeys.find(key => key.keyId === keyId);
}

function guidePublicKey(pinned: GuidePinnedKey): KeyObject {
	const cached = guideKeyCache.get(pinned.keyId);
	if (cached) return cached;
	const key = createPublicKey({ key: Buffer.from(pinned.spkiDerHex, "hex"), format: "der", type: "spki" });
	guideKeyCache.set(pinned.keyId, key);
	return key;
}

/**
 * Verifies a guide manifest end to end and fails closed on the first broken
 * property. Order matters: identity and tamper checks (unknown key, malformed
 * or mismatched signature) run before temporal and compatibility checks, so a
 * tampered or untrusted manifest is never masked by an expiry message.
 */
export function verifyGuideManifest(params: {
	manifest: GuideManifestV1;
	signatureBytes: Uint8Array;
	now: number;
}): GuideVerificationResult<{ keyId: string }> {
	const { manifest, signatureBytes, now } = params;
	if (manifest.version !== GUIDES_MANIFEST_VERSION)
		return guideFailure(
			"unsupported_version",
			`Guide manifest version ${manifest.version} is newer than the supported version ${GUIDES_MANIFEST_VERSION}.`,
		);
	const pinned = pinnedGuideKey(manifest.keyId);
	if (!pinned) return guideFailure("unknown_key", `Guide manifest keyId ${manifest.keyId} is not pinned.`);
	if (signatureBytes.length !== GUIDE_SIGNATURE_BYTES)
		return guideFailure(
			"corrupt_signature",
			`Detached signature must be exactly ${GUIDE_SIGNATURE_BYTES} bytes (Ed25519), got ${signatureBytes.length}.`,
		);
	const canonical = canonicalGuideManifestBytes(manifest);
	let valid: boolean;
	try {
		valid = cryptoVerify(null, canonical, guidePublicKey(pinned), signatureBytes);
	} catch {
		return guideFailure("invalid_signature", "Detached signature verification failed.");
	}
	if (!valid)
		return guideFailure("invalid_signature", "Detached signature does not match the canonical manifest bytes.");
	if (!Number.isSafeInteger(now) || now < manifest.issuedAt)
		return guideFailure("not_yet_valid", "Guide manifest is not authoritative until its issuedAt instant.");
	if (now > manifest.expiresAt)
		return guideFailure("expired", "Guide manifest has expired and is no longer authoritative.");
	if (manifest.minimumSdkVersion > GUIDE_CLIENT_VERSION)
		return guideFailure(
			"incompatible",
			`Guide manifest requires SDK advisory client ${manifest.minimumSdkVersion}, this client is ${GUIDE_CLIENT_VERSION}.`,
		);
	return { ok: true, value: { keyId: manifest.keyId } };
}

/**
 * Monotonic floor check: a candidate manifest for a channel must strictly
 * advance that channel's sequence, otherwise an older (but still validly
 * signed) manifest is refused as a rollback.
 */
export function guideRollbackCheck(
	previous: { manifestId: string; sequence: number } | undefined,
	candidate: GuideManifestV1,
): GuideVerificationResult<{ monotonic: boolean }> {
	if (previous && previous.manifestId === candidate.manifestId && candidate.sequence <= previous.sequence)
		return guideFailure(
			"rollback",
			`Guide manifest sequence ${candidate.sequence} does not advance the cached floor ${previous.sequence} for ${candidate.manifestId}.`,
		);
	return { ok: true, value: { monotonic: true } };
}

export function guideAdvisoryDigest(text: Uint8Array): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Per-guide SHA-256 binding: the advisory text must match the digest the
 * signed manifest binds for that guide id. This is the tamper check for the
 * advisory payload itself — the manifest signature cannot cover content that
 * is fetched separately, so every advisory is hash-verified against it.
 */
export function verifyGuideAdvisoryText(
	entry: GuideEntryV1,
	text: Uint8Array,
): GuideVerificationResult<{ sha256: string }> {
	const digest = guideAdvisoryDigest(text);
	if (digest !== entry.sha256)
		return guideFailure(
			"hash_mismatch",
			`Advisory ${entry.id} digest ${digest} does not match the manifest binding ${entry.sha256}.`,
		);
	return { ok: true, value: { sha256: digest } };
}
