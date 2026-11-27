/**
 * Wire contract of a persisted session recap, shared by the transcript store and SDK
 * listing consumers. Dependency-free so SDK machine entrypoints can validate a recap
 * without reaching session mutation modules.
 */
export const SESSION_RECAP_SCHEMA_VERSION = 1;
/** Acceptance bound on recap text, counted in Unicode code points. Over-limit text is rejected, never truncated. */
export const SESSION_RECAP_MAX_CODEPOINTS = 120;
/**
 * Acceptance bound on recap text, counted in UTF-8 bytes. Equal to the generator's output
 * bound (`RECAP_MAX_OUTPUT_BYTES`) so the store never rejects text the generator accepted;
 * the code point bound is the effective limit for any script (120 four-byte characters
 * are 480 bytes), and this is the backstop against oversized payloads from other writers.
 */
export const SESSION_RECAP_MAX_BYTES = 720;
const SESSION_RECAP_MAX_TOKEN_LENGTH = 200;

/** Model that produced the recap text. */
export interface SessionRecapModel {
	provider: string;
	id: string;
}

/** Persisted payload of a `session_recap` custom entry. */
export interface SessionRecap {
	schemaVersion: typeof SESSION_RECAP_SCHEMA_VERSION;
	/** Model-generated single-line recap. Never original transcript text. */
	text: string;
	/** Entry id of the final assistant message (stopReason `stop`) the recap summarizes. */
	sourceEntryId: string;
	/** Entry id of the user message that began the summarized turn. Must precede `sourceEntryId` on the branch. */
	requestEntryId: string;
	model: SessionRecapModel;
	/** Canonical ISO-8601 UTC time at which the model finished generating `text`. */
	generatedAt: string;
}

/**
 * A recap read back from a branch, plus the id of the entry that stores it.
 * `source` is attached on read, never persisted: the `session_recap` custom type
 * is the authority that the text is model-generated, so a payload cannot claim it.
 */
export interface SessionRecapRecord extends SessionRecap {
	entryId: string;
	source: "model";
}

const RECAP_KEYS: ReadonlySet<string> = new Set([
	"schemaVersion",
	"text",
	"sourceEntryId",
	"requestEntryId",
	"model",
	"generatedAt",
]);
const MODEL_KEYS: ReadonlySet<string> = new Set(["provider", "id"]);

// Control characters, lone surrogates, line/paragraph separators, and invisible/bidi
// format characters. ZWNJ/ZWJ stay allowed: they are part of legitimate scripts and emoji.
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	const keys = Object.keys(value);
	return keys.length === allowed.size && keys.every(key => allowed.has(key));
}

function isToken(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= SESSION_RECAP_MAX_TOKEN_LENGTH &&
		value === value.trim() &&
		!FORBIDDEN_TEXT.test(value)
	);
}

function isCanonicalIsoTime(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** True when `text` is a non-empty, already-normalized single line within both size bounds. */
export function isValidSessionRecapText(text: unknown): text is string {
	if (typeof text !== "string" || text.length === 0 || text !== text.trim()) return false;
	if (FORBIDDEN_TEXT.test(text)) return false;
	// UTF-16 length bounds the code point count from above; skip the allocation for clearly oversized input.
	if (text.length > SESSION_RECAP_MAX_BYTES) return false;
	if (Array.from(text).length > SESSION_RECAP_MAX_CODEPOINTS) return false;
	return Buffer.byteLength(text, "utf8") <= SESSION_RECAP_MAX_BYTES;
}

/**
 * Strictly validate a persisted recap payload. Returns a fresh, detached copy or
 * `undefined`; unknown keys, wrong versions, and out-of-bound values are all rejected.
 */
export function validateSessionRecap(value: unknown): SessionRecap | undefined {
	if (!isPlainRecord(value) || !hasExactKeys(value, RECAP_KEYS)) return undefined;
	if (value.schemaVersion !== SESSION_RECAP_SCHEMA_VERSION) return undefined;
	if (!isValidSessionRecapText(value.text)) return undefined;
	if (!isToken(value.sourceEntryId) || !isToken(value.requestEntryId)) return undefined;
	if (value.sourceEntryId === value.requestEntryId) return undefined;
	const model = value.model;
	if (!isPlainRecord(model) || !hasExactKeys(model, MODEL_KEYS)) return undefined;
	if (!isToken(model.provider) || !isToken(model.id)) return undefined;
	if (!isCanonicalIsoTime(value.generatedAt)) return undefined;
	return {
		schemaVersion: SESSION_RECAP_SCHEMA_VERSION,
		text: value.text,
		sourceEntryId: value.sourceEntryId,
		requestEntryId: value.requestEntryId,
		model: { provider: model.provider, id: model.id },
		generatedAt: value.generatedAt,
	};
}
