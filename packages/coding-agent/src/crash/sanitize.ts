/**
 * `sanitizeExternalCrashV1` — the outbound contract for crash text.
 *
 * This is deliberately a *different, stricter* contract than the persistence
 * scrub in `redactCrashSecrets`. That one is best-effort credential hygiene for
 * a local file; this one governs bytes that leave the machine, so it is an
 * allowlist with a residual scanner and a fail-closed verdict: if the scanner
 * is not certain the output is clean, the submission is refused rather than
 * "warned and continued".
 *
 * Applied to every crash-derived string:
 * - CRLF normalized, C0/C1/ANSI/OSC/bidi/zero-width controls removed
 * - absolute POSIX/Windows/UNC/BunFS paths and home prefixes → placeholders
 * - URLs parsed; userinfo, query and fragment dropped; unparseable URLs dropped
 * - credential shapes rewritten to redaction markers
 * - UUIDs and long hex runs (account/session/request ids) → placeholders
 * - pid and exact timestamps are never included (coarse dates only)
 * - per-field and whole-body byte caps
 */
import { redactCrashSecrets, replaceAbsolutePaths } from "@gajae-code/utils";

/** High-entropy identifiers: account/session/request ids carry no triage value. */
const UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX_RUN_PATTERN = /\b[0-9a-fA-F]{12,}\b/g;

/** Whole-body cap for a generated issue body. */
export const CRASH_BODY_MAX_BYTES = 48 * 1024;
/** Per-field cap for crash-derived text. */
export const CRASH_FIELD_MAX_BYTES = 8 * 1024;

export type SanitizeVerdict = { ok: true; value: string } | { ok: false; reason: string };

const OSC_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CLASS = "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]";
const INVISIBLE_CLASS = "[\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]";
const CONTROL_PATTERN = new RegExp(CONTROL_CLASS, "g");
const INVISIBLE_PATTERN = new RegExp(INVISIBLE_CLASS, "g");
// Separate non-global instances: `RegExp.test` on a /g regex is stateful, and a
// residual scanner that silently alternates verdicts is worse than none.
const CONTROL_PROBE = new RegExp(CONTROL_CLASS);
const INVISIBLE_PROBE = new RegExp(INVISIBLE_CLASS);
const URL_PATTERN = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>"'`)\]]+/g;
/** Anything still matching these after sanitization means the scanner is not certain. */
const RESIDUAL_PATTERNS: readonly RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{8,}/,
	/\bgh[opsur]_[A-Za-z0-9]{16,}/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
	/\bxox[baprs]-[A-Za-z0-9-]{8,}/,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	// Opaque URIs the URL rule cannot parse into an origin, and inline payloads.
	/\bdata:[^\s]{0,64};base64,/i,
	/:\/\//,
	/(?<![\w.~])\/[A-Za-z0-9._-]+\//,
	/\b[A-Za-z]:\\/,
	/\\\\[A-Za-z0-9]/,
];

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	let end = maxBytes;
	while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end--;
	if (end > 0 && (bytes[end - 1] ?? 0) >= 0xc0) end--;
	return `${bytes.subarray(0, end).toString("utf8")}…[truncated]`;
}

/**
 * Reduce one URL to origin + path. Userinfo, query and fragment are the parts
 * that routinely carry tokens and identifiers, so they are dropped outright;
 * an unparseable or non-http(s) URL is dropped entirely.
 */
function sanitizeUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return "«url dropped»";
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "«url dropped»";
	const host = parsed.hostname;
	if (!host) return "«url dropped»";
	const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
	return `«url ${host}${pathname}»`;
}

/**
 * Sanitize one crash-derived field. Returns a verdict: `ok:false` means the
 * residual scanner still found something it cannot vouch for, and the caller
 * must refuse to submit.
 */
export function sanitizeExternalCrashV1(text: string, maxBytes: number = CRASH_FIELD_MAX_BYTES): SanitizeVerdict {
	if (typeof text !== "string") return { ok: false, reason: "field is not text" };
	let value = text.replace(/\r\n?/g, "\n");
	value = value.replace(OSC_PATTERN, " ").replace(CSI_PATTERN, "");
	value = value.replace(CONTROL_PATTERN, "").replace(INVISIBLE_PATTERN, "");
	value = redactCrashSecrets(value);
	value = value.replace(URL_PATTERN, match => sanitizeUrl(match));
	value = replaceAbsolutePaths(value);
	value = value.replace(UUID_PATTERN, "<uuid>");
	value = value.replace(HEX_RUN_PATTERN, match => (/[a-fA-F]/.test(match) ? "<hex>" : "<num>"));
	value = value
		.split("\n")
		.map(line => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.trim();
	value = truncateUtf8(value, maxBytes);
	for (const pattern of RESIDUAL_PATTERNS) {
		if (pattern.test(value)) return { ok: false, reason: `residual scanner matched ${pattern.source}` };
	}
	if (CONTROL_PROBE.test(value) || INVISIBLE_PROBE.test(value))
		return { ok: false, reason: "residual control characters" };
	return { ok: true, value };
}

/**
 * Wrap already-sanitized crash-derived text for a fenced Markdown block:
 * backticks are neutralized so the fence cannot be escaped, and `@` is de-fanged
 * so a crash message can never notify a GitHub user or team.
 */
export function fenceCrashText(value: string): string {
	return value.replace(/`/g, "'").replace(/@/g, "(at)");
}

/** Sanitize a label (field name / heading) with the same rules as a value. */
export function sanitizeLabel(label: string): SanitizeVerdict {
	return sanitizeExternalCrashV1(label, 128);
}
