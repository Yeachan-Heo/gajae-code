/**
 * Crash fingerprinting, algorithm v1.
 *
 * A fingerprint is a stable, versioned identity for a crash *class*, computed
 * at `recordFatalCrash` time from the already-captured diagnostic text (error
 * name, message, stack) and nothing else. It exists so that N crash-loop
 * records collapse into one countable signature.
 *
 * ## Privacy posture
 *
 * The fingerprint is a **public, pseudonymous correlation token**. It is
 * deterministic over low-entropy inputs, therefore dictionary-testable, and it
 * links the same crash class across installs and accounts. It is NOT a
 * confidentiality control. Only *normalized* text is hashed — absolute paths,
 * home directories, uuids/hex/long digit runs and everything
 * `redactCrashSecrets` rewrites are replaced with placeholders before hashing —
 * so a fingerprint never encodes a secret or a raw filesystem path.
 *
 * ## Canonical serialization (v1)
 *
 * Fields are length-prefixed UTF-8 (`<byteLength>:<bytes>`) so no delimiter
 * ambiguity exists between an empty field and a missing one:
 *
 *     "gjc-crash-fp.v1" | errorName | messageClass | frame0 | frame1 | frame2
 *
 * Up to three normalized in-app frames participate; absent frames are omitted
 * (the length prefix of the preceding fields keeps the encoding unambiguous).
 * The digest is sha256 truncated to its first 16 bytes, published as 32
 * lowercase hex characters (128 bits).
 */
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { redactCrashSecrets } from "./crash-redaction";

/** Algorithm version recorded beside every emitted fingerprint. */
export const CRASH_FINGERPRINT_VERSION = 1;
/** Hex length of a published fingerprint (128 bits). */
export const CRASH_FINGERPRINT_HEX_LENGTH = 32;
/** Matches exactly a published fingerprint. */
export const CRASH_FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;
/** Marker used for the machine-readable identity line of each crash record. */
export const CRASH_RECORD_MARKER = "gjc-crash-record.v1";
/** Marker embedded in an external issue body, outside crash-derived blocks. */
export const CRASH_ISSUE_MARKER_PREFIX = "gjc-crash-fp.v1:";
/** Literal frame used when a stack carries no in-app frame at all. */
export const NO_APP_FRAME = "<no-app-frame>";

/** Byte caps applied before hashing, so a huge throwable cannot dominate cost. */
const MESSAGE_CLASS_MAX_BYTES = 512;
const FRAME_MAX_BYTES = 256;
const MAX_FRAMES = 3;

export interface CrashFingerprintInput {
	readonly name: string;
	readonly message: string;
	readonly stack: string;
}

export interface CrashFingerprint {
	/** 32 lowercase hex characters. */
	readonly fingerprint: string;
	/** Algorithm version (`fpv`). */
	readonly version: number;
	readonly errorName: string;
	/** Normalized, placeholder-substituted message class (safe to display). */
	readonly messageClass: string;
	/** Normalized in-app frames that participated in the digest. */
	readonly frames: readonly string[];
}

export interface CrashFingerprintOptions {
	/** Install root used to relativize in-app frames. Defaults to the GJC install root. */
	readonly installRoot?: string;
	/** Home directory used for `<home>` substitution. Defaults to `os.homedir()`. */
	readonly homeDir?: string;
}

/**
 * Root of this installation, used to relativize frames.
 *
 * Source checkouts resolve to the workspace root (this file lives at
 * `packages/utils/src/`); an npm install resolves to the `node_modules` root.
 * Both are stable per install *shape*, which is what frame identity needs;
 * compiled binaries never reach here because their frames are BunFS paths.
 */
function defaultInstallRoot(): string {
	return path.resolve(import.meta.dir, "..", "..", "..");
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	let end = maxBytes;
	while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end--;
	if (end > 0 && bytes[end - 1] >= 0xc0) end--;
	return bytes.subarray(0, end).toString("utf8");
}

const UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX_RUN_PATTERN = /\b[0-9a-fA-F]{8,}\b/g;
const DIGIT_RUN_PATTERN = /\d{4,}/g;
// UNC, Windows drive-letter, BunFS (posix + windows compiled forms), POSIX.
const PATH_PATTERN =
	/\\\\[^\s"'`,;)\]]+|\b[A-Za-z]:\\[^\s"'`,;)\]]*|\/\$bunfs\/[^\s"'`,;)\]]*|(?<![\w.~])\/[^\s"'`,;)\]]*/g;

function normalizeSeparators(value: string): string {
	return value.replace(/\\/g, "/");
}

/**
 * Replace absolute path-like tokens with `<home>` / `<path>`.
 *
 * Semantically meaningful codes are untouched: this rule only fires on tokens
 * that are recognizably absolute filesystem paths.
 */
export function replaceAbsolutePaths(text: string, homeDir: string = os.homedir()): string {
	const normalizedHome = normalizeSeparators(homeDir).replace(/\/+$/, "");
	return text.replace(PATH_PATTERN, match => {
		if (match === "/") return match;
		const normalized = normalizeSeparators(match);
		if (normalizedHome.length > 0 && (normalized === normalizedHome || normalized.startsWith(`${normalizedHome}/`)))
			return "<home>";
		return "<path>";
	});
}

/**
 * Typed message normalization.
 *
 * Deliberately *not* "strip all digits": HTTP statuses, exit codes and errno
 * names are the difference between distinct crash classes, so runs of three or
 * fewer digits and alphabetic error codes survive verbatim (`404` stays
 * distinct from `500`). Only high-entropy identifiers are collapsed.
 */
export function normalizeCrashMessage(message: string, options: CrashFingerprintOptions = {}): string {
	const homeDir = options.homeDir ?? os.homedir();
	let normalized = redactCrashSecrets(message);
	normalized = replaceAbsolutePaths(normalized, homeDir);
	normalized = normalized.replace(UUID_PATTERN, "<uuid>");
	normalized = normalized.replace(HEX_RUN_PATTERN, match => (/[a-fA-F]/.test(match) ? "<hex>" : "<num>"));
	normalized = normalized.replace(DIGIT_RUN_PATTERN, "<num>");
	normalized = normalized.replace(/\s+/g, " ").trim();
	return truncateUtf8(normalized, MESSAGE_CLASS_MAX_BYTES);
}

interface ParsedFrame {
	readonly functionName: string;
	readonly location: string;
}

function parseStackFrame(line: string): ParsedFrame | undefined {
	const trimmed = line.trim();
	const atMatch = /^at\s+(.*)$/.exec(trimmed);
	if (!atMatch) return undefined;
	const rest = atMatch[1] ?? "";
	const parenIndex = rest.lastIndexOf(" (");
	let functionName = "<anonymous>";
	let location = rest;
	if (parenIndex >= 0 && rest.endsWith(")")) {
		functionName = rest.slice(0, parenIndex).trim();
		location = rest.slice(parenIndex + 2, -1).trim();
	}
	if (!location) return undefined;
	return { functionName, location };
}

function stripLocation(location: string): string {
	let value = location;
	if (value.startsWith("file://")) value = Bun.fileURLToPath(value);
	// Drop `:line:col` / `:line` suffixes: they churn on every release.
	value = value.replace(/:\d+(?::\d+)?$/, "");
	return value;
}

function normalizeFunctionName(name: string): string {
	let value = name.replace(/^(?:async|new)\s+/, "").trim();
	value = value.replace(/\s+\[as\s+[^\]]+\]$/, "");
	if (!value || value === "<anonymous>") return "<anonymous>";
	return value;
}

function relativizeInApp(location: string, installRoot: string): string | undefined {
	const normalized = normalizeSeparators(location);
	if (!normalized || normalized === "native" || normalized === "<anonymous>") return undefined;
	if (/^(?:node|bun):/.test(normalized)) return undefined;
	if (/(?:^|\/)node_modules\//.test(normalized)) return undefined;
	// Compiled-binary frames: posix `/$bunfs/root/...` and windows `B:\~BUN\root\...`.
	const bunfs = /^(?:[A-Za-z]:\/~BUN|\/\$bunfs)\/root\/(.*)$/.exec(normalized);
	if (bunfs) return bunfs[1] ?? undefined;
	const root = normalizeSeparators(installRoot).replace(/\/+$/, "");
	if (root.length > 0 && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
	return undefined;
}

/**
 * Normalized in-app frames, newest first, capped at three.
 *
 * A frame is `<install-root-relative path>#<function>` with no line or column
 * numbers. Stacks with no in-app frame yield the single literal
 * `<no-app-frame>`; distinct roots can merge under that literal, which is an
 * accepted and documented v1 property.
 */
export function normalizeCrashFrames(stack: string, options: CrashFingerprintOptions = {}): string[] {
	const installRoot = options.installRoot ?? defaultInstallRoot();
	const frames: string[] = [];
	for (const line of stack.split("\n")) {
		if (frames.length >= MAX_FRAMES) break;
		const parsed = parseStackFrame(line);
		if (!parsed) continue;
		const relative = relativizeInApp(stripLocation(parsed.location), installRoot);
		if (relative === undefined) continue;
		frames.push(truncateUtf8(`${relative}#${normalizeFunctionName(parsed.functionName)}`, FRAME_MAX_BYTES));
	}
	return frames.length > 0 ? frames : [NO_APP_FRAME];
}

function canonicalSerialization(fields: readonly string[]): Buffer {
	const parts: Buffer[] = [];
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		parts.push(Buffer.from(`${bytes.byteLength}:`, "utf8"), bytes);
	}
	return Buffer.concat(parts);
}

/** Compute the v1 fingerprint of an already-captured fatal diagnostic. */
export function computeCrashFingerprint(
	input: CrashFingerprintInput,
	options: CrashFingerprintOptions = {},
): CrashFingerprint {
	const errorName = truncateUtf8(normalizeCrashMessage(input.name, options) || "Error", 128);
	const messageClass = normalizeCrashMessage(input.message, options);
	const frames = normalizeCrashFrames(input.stack, options);
	const digest = createHash("sha256")
		.update(canonicalSerialization(["gjc-crash-fp.v1", errorName, messageClass, ...frames]))
		.digest();
	return {
		fingerprint: digest.subarray(0, CRASH_FINGERPRINT_HEX_LENGTH / 2).toString("hex"),
		version: CRASH_FINGERPRINT_VERSION,
		errorName,
		messageClass,
		frames,
	};
}

/** The machine-readable identity line appended to every new crash record. */
export function formatCrashRecordMarker(fingerprint: string, version: number, recordId: string): string {
	return `${CRASH_RECORD_MARKER} fp:${fingerprint} fpv:${version} id:${recordId}`;
}

export interface CrashRecordMarker {
	readonly fingerprint: string;
	readonly version: number;
	readonly recordId: string;
}

/**
 * Parse an identity line. Records written before this feature carry no marker
 * and are therefore `unmatchable`: this parser never guesses at them.
 */
export function parseCrashRecordMarker(line: string): CrashRecordMarker | undefined {
	const match = new RegExp(`^${CRASH_RECORD_MARKER} fp:([0-9a-f]{32}) fpv:(\\d{1,3}) id:([0-9a-f]{8,32})$`).exec(
		line.trim(),
	);
	if (!match) return undefined;
	const version = Number(match[2]);
	if (!Number.isSafeInteger(version) || version < 1) return undefined;
	return { fingerprint: match[1] as string, version, recordId: match[3] as string };
}
