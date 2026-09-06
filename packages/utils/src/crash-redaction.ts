/**
 * Best-effort credential scrubbing for durable crash records.
 *
 * This is a *persistence-time* scrub: it keeps obvious credential shapes out of
 * a file GJC keeps indefinitely. It is explicitly NOT a privacy guarantee and
 * must never be treated as one for data that leaves the machine — outbound
 * text goes through `sanitizeExternalCrashV1` instead.
 */

/**
 * Scrub credential material from crash text before it is persisted.
 * Covers bearer/basic-style headers, key=value or JSON key forms of common
 * credential names, and well-known vendor token shapes. Normal messages and
 * stack frames are untouched; matches are replaced in place so surrounding
 * diagnostic context survives.
 */
export function redactCrashSecrets(text: string): string {
	let redacted = text;
	redacted = redacted.replace(/\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "«redacted-auth»");
	redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "«redacted-jwt»");
	redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "«redacted-api-key»");
	// `gh[opsur]_` covers the classic PAT/OAuth/server/user/refresh prefixes;
	// fine-grained PATs use an entirely different `github_pat_` prefix and would
	// otherwise survive into a log the module keeps indefinitely.
	redacted = redacted.replace(/\bgh[opsur]_[A-Za-z0-9]{16,}\b/g, "«redacted-github-token»");
	redacted = redacted.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "«redacted-github-token»");
	redacted = redacted.replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "«redacted-slack-token»");
	// A PEM block carries the key material itself, so it is redacted whole rather
	// than line by line. It runs before the narrower rules because they would
	// otherwise chew on the base64 body and leave a truncated key behind.
	redacted = redacted.replace(
		/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
		"«redacted-private-key»",
	);
	// Google API keys are a fixed 39-character shape that carries no label of its
	// own, so the labeled-value rule below never sees one.
	redacted = redacted.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "«redacted-google-api-key»");
	// Basic-auth credentials embedded in a URL. Scheme and host stay readable
	// because they are the diagnostic value; only the userinfo is dropped. The
	// scheme repetition is bounded: an unbounded `[a-z0-9+.-]*` in front of the
	// literal `://` re-tries every prefix of a long alphabetic run, which is
	// quadratic in input length and costs ~10s on a 200 KB crash body.
	redacted = redacted.replace(
		/\b([a-z][a-z0-9+.-]{0,15}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi,
		"$1«redacted-url-credential»@",
	);
	// AKIA is the long-term access key id; ASIA is the temporary/STS one, which is
	// the shape that actually shows up in a crashed request. ABIA (bearer) and
	// ACCA (context) complete the set the session-import scrubber already lists.
	// The id alone is not
	// the credential: an STS payload carries `SecretAccessKey` and `SessionToken`
	// alongside it, so the labeled-value rule below must name both. `secret_key`
	// does not match `SecretAccessKey` (the canonical field has `Access` in the
	// middle), and `access_token` does not match `SessionToken`.
	redacted = redacted.replace(/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, "«redacted-aws-key»");
	redacted = redacted.replace(
		/(?<![A-Za-z0-9_])(["']?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|secret[_-]?key|secret[_-]?access[_-]?key|password|passwd|authorization)["']?\s*[=:]\s*["']?)[^\s"',;}\]]{8,}/gi,
		"$1«redacted»",
	);
	return redacted;
}

/** Every placeholder `redactCrashSecrets` can emit. Used by downstream normalizers. */
export const CRASH_REDACTION_MARKERS: readonly string[] = [
	"«redacted-auth»",
	"«redacted-jwt»",
	"«redacted-api-key»",
	"«redacted-github-token»",
	"«redacted-slack-token»",
	"«redacted-aws-key»",
	"«redacted-private-key»",
	"«redacted-google-api-key»",
	"«redacted-url-credential»",
	"«redacted»",
];
