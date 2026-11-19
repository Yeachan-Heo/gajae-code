/**
 * Best-effort credential scrubbing for durable crash records.
 *
 * This is a *persistence-time* scrub: it keeps obvious credential shapes out of
 * a file GJC keeps indefinitely. It is explicitly NOT a privacy guarantee and
 * must never be treated as one for data that leaves the machine — outbound
 * text goes through `sanitizeExternalCrashV1` instead.
 */

declare const originalTextBrand: unique symbol;
declare const redactedTextBrand: unique symbol;

/**
 * Text no detection rule has edited yet. Every rule reads only this type, so output of a previous
 * redaction cannot be fed back into detection: `RedactedText` is a different brand.
 */
export type OriginalText = string & { readonly [originalTextBrand]: "original" };

/** Text produced by the single application pass; never accepted by a detector. */
export type RedactedText = string & { readonly [redactedTextBrand]: "redacted" };

/** One range of original text replaced by `label`; an empty label deletes the range. */
export interface RedactionRange {
	readonly start: number;
	readonly end: number;
	readonly label: string;
}

export type RedactionRanges = readonly RedactionRange[];

/** The only conversion from caller input to text a detector may read. */
export function asOriginalText(value: string): OriginalText {
	return value as OriginalText;
}

/**
 * Merge overlapping or touching ranges in application order. The range that starts first (the
 * longer one on a tie) keeps its label, so a container's mask owns the line rules inside it.
 */
export function mergeRedactionRanges(ranges: RedactionRanges): RedactionRange[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((left, right) => left.start - right.start || right.end - left.end);
	const merged: RedactionRange[] = [];
	for (const range of sorted) {
		if (range.end <= range.start) continue;
		const last = merged[merged.length - 1];
		if (last !== undefined && range.start < last.end) {
			if (range.end > last.end) {
				merged[merged.length - 1] = { start: last.start, end: range.end, label: last.label };
			}
			continue;
		}
		merged.push(range);
	}
	return merged;
}

/**
 * Replace every detection range in one pass over the original text. This is the only function that
 * turns `OriginalText` into `RedactedText`; overlapping ranges merge, and the range that starts
 * first (the longer one on a tie) keeps its label. A label may be a marker or empty to delete.
 */
export function applyRedactions(original: OriginalText, ranges: RedactionRanges): RedactedText {
	const merged = mergeRedactionRanges(ranges);
	if (merged.length === 0) return original as unknown as RedactedText;
	const parts: string[] = [];
	let cursor = 0;
	for (const range of merged) {
		parts.push(original.slice(cursor, range.start), range.label);
		cursor = range.end;
	}
	parts.push(original.slice(cursor));
	return parts.join("") as RedactedText;
}

const PEM_BEGIN = "-----BEGIN ";
const PEM_END = "-----END ";
const PEM_LABEL = "PRIVATE KEY-----";

/** Marker substituted for a complete private-key block. */
export const PRIVATE_KEY_REDACTION_MARKER = "«redacted-private-key»";

/** Half-open range of one private-key block inside the scanned text. */
export interface PrivateKeySpan {
	readonly start: number;
	readonly end: number;
}

/** Header or footer end, or -1. The type prefix is only A-Z, digits, and spaces, then the label. */
function privateKeyMarkerEnd(text: string, at: number, token: string): number {
	let j = at + token.length;
	const n = text.length;
	while (j < n) {
		if (text.startsWith(PEM_LABEL, j)) return j + PEM_LABEL.length;
		const c = text.charCodeAt(j);
		if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 32) {
			j++;
			continue;
		}
		return -1;
	}
	return -1;
}

/**
 * Find each complete private-key block in one forward pass.
 * An opening banner with no footer later in the text is left unmatched, and the
 * scan stops: nothing after it can close the same block.
 */
function findPrivateKeySpansIn(text: string): PrivateKeySpan[] {
	// Without any footer nothing can pair, so a long run of unclosed banners stays linear.
	if (!text.includes(PEM_END)) return [];
	const spans: PrivateKeySpan[] = [];
	// Openers pair with the nearest opener before a footer (LIFO). An opener that is itself inside
	// a YAML scalar or a credential container is therefore left unmatched when a real block opens
	// after it, instead of pairing forward and swallowing the diagnostics in between.
	const openers: number[] = [];
	let i = 0;
	while (i < text.length) {
		const begin = text.indexOf(PEM_BEGIN, i);
		const end = text.indexOf(PEM_END, i);
		if (begin < 0 && end < 0) break;
		if (begin >= 0 && (end < 0 || begin < end)) {
			const headerEnd = privateKeyMarkerEnd(text, begin, PEM_BEGIN);
			if (headerEnd >= 0) {
				openers.push(begin);
				i = headerEnd;
			} else {
				i = begin + PEM_BEGIN.length;
			}
			continue;
		}
		const footerEnd = privateKeyMarkerEnd(text, end, PEM_END);
		if (footerEnd >= 0 && openers.length > 0) {
			spans.push({ start: openers.pop() as number, end: footerEnd });
		}
		i = end + PEM_END.length;
	}
	spans.sort((left, right) => left.start - right.start);
	return spans;
}

/** Locate the private-key blocks of one original text. */
export function findPrivateKeySpans(text: OriginalText): PrivateKeySpan[] {
	return findPrivateKeySpansIn(text);
}

/** Whether `character` can appear in a printed PEM body value. */
function isPemBodyCharacter(character: string | undefined): boolean {
	if (character === undefined) return false;
	const code = character.charCodeAt(0);
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		character === "+" ||
		character === "/" ||
		character === "_" ||
		character === "-"
	);
}

/** Length of a physical or serialized line break at `at`, or 0. */
function lineBreakLengthAt(text: string, at: number): number {
	if (text[at] === "\n") return 1;
	if (text[at] === "\r") return text[at + 1] === "\n" ? 2 : 1;
	const serialized = serializedLineBreakEnd(text, at);
	return serialized < 0 ? 0 : serialized - at;
}

/**
 * Characters that can close a serialized value holding a PEM body. Inside a quoted serialized
 * value only that value's own quote ends it: a comma there is string content, not a delimiter.
 */
function isSerializedValueEnd(character: string | undefined, quote: string | undefined): boolean {
	if (character === undefined) return false;
	if (quote !== undefined) return character === quote;
	return (
		character === '"' ||
		character === "'" ||
		character === "," ||
		character === "}" ||
		character === "]" ||
		character === ")"
	);
}

/**
 * The quote that opened the serialized string still containing `at`, if any. A serialized string
 * cannot hold a raw line break, so its opening quote is on the same physical line. Text inside
 * that string is bounded by the quote alone; spaces and commas are content, not delimiters.
 */
function serializedValueQuoteAt(text: string, at: number): string | undefined {
	const lineStart = text.lastIndexOf("\n", at - 1) + 1;
	return quoteAt(text, { at: lineStart, quote: undefined }, at, lineStart);
}

/**
 * End of the body an unpaired opener still owns. The banner's own line is never body: the body
 * starts after the first break, and trailing spaces before that break belong to the banner, so a
 * banner padded with any run of spaces still owns the base64 line under it. The body is then the
 * maximal run of key-shaped lines: each line holds only base64 characters (plus optional padding
 * and indentation) and ends at a line break or at the delimiter that closes the serialized value.
 * Anything else ends the body, so a sibling field (`Note: keep`) or a prose suffix is not body and
 * a replacement bounded here never deletes it.
 */
function unpairedPrivateKeyBodyEnd(text: string, headerEnd: number): number {
	// A banner inside a quoted serialized value is ended by that value's quote, never by a comma
	// or brace that is string content.
	const valueQuote = serializedValueQuoteAt(text, headerEnd);
	let bannerEnd = headerEnd;
	while (text[bannerEnd] === " " || text[bannerEnd] === "\t") bannerEnd++;
	const firstBreak = lineBreakLengthAt(text, bannerEnd);
	if (firstBreak === 0) return headerEnd;
	let cursor = bannerEnd + firstBreak;
	let end = headerEnd;
	while (cursor < text.length) {
		let bodyStart = cursor;
		while (text[bodyStart] === " " || text[bodyStart] === "\t") bodyStart++;
		let bodyEnd = bodyStart;
		while (isPemBodyCharacter(text[bodyEnd])) bodyEnd++;
		if (bodyEnd === bodyStart) break;
		if (text[bodyEnd] === "=") {
			let padded = bodyEnd;
			while (text[padded] === "=" && padded - bodyEnd < 2) padded++;
			// `=` inside the value is not padding; this is an assignment, not a body line.
			if (isPemBodyCharacter(text[padded])) break;
			bodyEnd = padded;
		}
		let trailing = bodyEnd;
		while (text[trailing] === " " || text[trailing] === "\t") trailing++;
		const nextBreak = lineBreakLengthAt(text, trailing);
		// A break or the delimiter that actually closes this serialized value ends the body line;
		// any other text after the base64 run (a colon, another word, a comma inside the still-open
		// string) means this line is not body at all.
		if (nextBreak === 0 && trailing < text.length && !isSerializedValueEnd(text[trailing], valueQuote)) break;
		end = bodyEnd;
		if (nextBreak === 0) break;
		cursor = trailing + nextBreak;
	}
	return end;
}

/** Locate every private-key opener that no footer closes, bounded to the body it owns. */
export function findUnpairedPrivateKeySpans(text: string): PrivateKeySpan[] {
	const paired = findPrivateKeySpansIn(text);
	const spans: PrivateKeySpan[] = [];
	let at = 0;
	while (at < text.length) {
		const begin = text.indexOf(PEM_BEGIN, at);
		if (begin < 0) break;
		const headerEnd = privateKeyMarkerEnd(text, begin, PEM_BEGIN);
		if (headerEnd < 0) {
			at = begin + PEM_BEGIN.length;
			continue;
		}
		if (paired.some(span => begin >= span.start && begin < span.end)) {
			at = headerEnd;
			continue;
		}
		spans.push({ start: begin, end: unpairedPrivateKeyBodyEnd(text, headerEnd) });
		at = headerEnd;
	}
	return spans;
}

/** Historical v1 pairing: first opener with the first footer after it, stopping when unmatched. */
function findPrivateKeySpansLegacy(text: string): PrivateKeySpan[] {
	const spans: PrivateKeySpan[] = [];
	let i = 0;
	while (i < text.length) {
		const start = text.indexOf(PEM_BEGIN, i);
		if (start < 0) break;
		const headerEnd = privateKeyMarkerEnd(text, start, PEM_BEGIN);
		if (headerEnd < 0) {
			i = start + PEM_BEGIN.length;
			continue;
		}
		let footerEnd = -1;
		let j = headerEnd;
		while (j < text.length) {
			const endAt = text.indexOf(PEM_END, j);
			if (endAt < 0) break;
			const candidate = privateKeyMarkerEnd(text, endAt, PEM_END);
			if (candidate >= 0) {
				footerEnd = candidate;
				break;
			}
			j = endAt + PEM_END.length;
		}
		if (footerEnd < 0) break;
		spans.push({ start, end: footerEnd });
		i = footerEnd;
	}
	return spans;
}

/** Replace each complete private-key block in one forward pass (v1 rules only). */
function redactPemPrivateKeys(text: string): string {
	const spans = findPrivateKeySpansLegacy(text);
	if (spans.length === 0) return text;
	const parts: string[] = [];
	let cursor = 0;
	for (const span of spans) {
		parts.push(text.slice(cursor, span.start), PRIVATE_KEY_REDACTION_MARKER);
		cursor = span.end;
	}
	parts.push(text.slice(cursor));
	return parts.join("");
}

const CREDENTIAL_KEY_SEPARATOR = "[._\\t -]*";
const CREDENTIAL_KEY_LABELS = `api${CREDENTIAL_KEY_SEPARATOR}key|apikey|account${CREDENTIAL_KEY_SEPARATOR}key|shared${CREDENTIAL_KEY_SEPARATOR}access${CREDENTIAL_KEY_SEPARATOR}key|shared${CREDENTIAL_KEY_SEPARATOR}access${CREDENTIAL_KEY_SEPARATOR}signature|access${CREDENTIAL_KEY_SEPARATOR}token|refresh${CREDENTIAL_KEY_SEPARATOR}token|id${CREDENTIAL_KEY_SEPARATOR}token|session${CREDENTIAL_KEY_SEPARATOR}key|session${CREDENTIAL_KEY_SEPARATOR}token|client${CREDENTIAL_KEY_SEPARATOR}secret|aws${CREDENTIAL_KEY_SEPARATOR}secret${CREDENTIAL_KEY_SEPARATOR}access${CREDENTIAL_KEY_SEPARATOR}key|secret${CREDENTIAL_KEY_SEPARATOR}key${CREDENTIAL_KEY_SEPARATOR}base|secret${CREDENTIAL_KEY_SEPARATOR}key|secret${CREDENTIAL_KEY_SEPARATOR}access${CREDENTIAL_KEY_SEPARATOR}key|encryption${CREDENTIAL_KEY_SEPARATOR}key|signing${CREDENTIAL_KEY_SEPARATOR}key|password${CREDENTIAL_KEY_SEPARATOR}(?:confirmation|confirm)|password|passwd|pwd|pw|passphrase|auth|authorization|bearer|private${CREDENTIAL_KEY_SEPARATOR}token|token|secrets?|credentials?|private${CREDENTIAL_KEY_SEPARATOR}key|cookies?`;
const CREDENTIAL_KEY_LABELS_V1 = CREDENTIAL_KEY_LABELS.replace("|pw|", "|");
/**
 * A complete value that an earlier redaction pass (this module or a caller's) already
 * replaced. The closing `]` is optional because unquoted values stop before `]`; the
 * container rule only leaves a bracketed placeholder in place when a field boundary
 * follows it, so the unbracketed form never hides a trailing secret.
 */
const REDACTION_PLACEHOLDER_PATTERN = /^(?:«redacted(?:-[a-z]+(?:-[a-z]+)*)?»|\[REDACTED_[A-Z]+(?:_[A-Z]+)*\]?)$/;
const REDACTION_PLACEHOLDER_BOUNDARY_PATTERN = /^(?:$|[\s,;})"'`\\])/;
const UNQUOTED_VALUE_DELIMITER_PATTERN = /[\s,;"'`}\]]/;
const CREDENTIAL_CAMEL_COMPOUND_SUFFIXES =
	"AccessToken|RefreshToken|IdToken|SessionToken|ClientSecret|EncryptionKey|SigningKey";
const CREDENTIAL_CAMEL_SIMPLE_SUFFIXES =
	"SecretAccessKey|Authorization|Credentials|Credential|AccountKey|ApiKey|SecretKey|PrivateKey|SessionKey|Passphrase|Password|Passwd|Pwd|Pw|Secrets|Secret|Bearer|Cookies|Cookie|Token|Auth";
const CREDENTIAL_CAMEL_SIMPLE_SUFFIXES_V1 = CREDENTIAL_CAMEL_SIMPLE_SUFFIXES.replace("|Pw|", "|");
const CREDENTIAL_CAMEL_PREFIX = "(?:[a-z0-9]+(?:[A-Z]{2,})?|[A-Z][a-z0-9]+(?:[A-Z]{2,})?|[A-Z]{2,})";
const CREDENTIAL_CAMEL_COMPOUND_PREFIX = "(?:[a-z0-9]{2,}(?:[A-Z]{2,})?|[A-Z][a-z0-9]+(?:[A-Z]{2,})?|[A-Z]{2,})";
const CREDENTIAL_CAMEL_MULTI_PREFIX_SEGMENT = "(?:[A-Z][a-z0-9]+|[A-Z]{2,}(?=[A-Z][a-z0-9]))";
const CREDENTIAL_CAMEL_MULTI_PREFIX = `(?:[a-z0-9]{2,}|[A-Z][a-z0-9]+|[A-Z]{2,})(?:${CREDENTIAL_CAMEL_MULTI_PREFIX_SEGMENT})+(?:[A-Z]{2,})?`;
const AUTHORIZATION_HEADER_PREFIX = String.raw`(?<![A-Za-z0-9_-])((?:\\*["'\x60]?-*)(?:[A-Za-z0-9][A-Za-z0-9_-]*[_-])?(?:auth|authorization)(?:\\*["'\x60]?\s*:\s*))`;
// Avoid splitting recognized multiword labels at their final component (e.g. `API Key`).
const CREDENTIAL_COMPOUND_FIELD_PREFIX =
	"(?:api|account|access|refresh|id|session|client|aws|secret|private|encryption|signing|key)";
const CREDENTIAL_VALUE_QUOTED_BOUNDARY = String.raw`(?=$|[\s,;}):.\]]|/?>)`;
const CREDENTIAL_QUOTED_ADJACENT_SUFFIX_PATTERN = String.raw`[^\s,;}\]]*`;
const CREDENTIAL_AUTHORIZATION_VALUE_PATTERN = new RegExp(
	String.raw`${AUTHORIZATION_HEADER_PREFIX}(?!\s*(?:["'«\x60]|\\+["'\x60]))(?:(?!\\+n|\\+r\\+n)[^\r\n])+`,
	"gi",
);

interface CredentialRedactionRules {
	readonly keySuffix: RegExp;
	readonly camelKeySuffix: RegExp;
	readonly assignmentPrefix: string;
	readonly camelAssignmentPrefix: string;
	readonly assignmentCandidatePattern: RegExp;
	readonly containerCandidatePattern: RegExp;
	readonly camelAssignmentCandidatePattern: RegExp;
	readonly camelContainerCandidatePattern: RegExp;
	readonly authValuePattern: RegExp;
	/** Current policy: one line, and never the scheme word of the URL that follows it. */
	readonly authValueLinePattern: RegExp;
	readonly valuePattern: RegExp;
	readonly camelValuePattern: RegExp;
	readonly escapedBacktickValuePattern: RegExp;
	readonly camelEscapedBacktickValuePattern: RegExp;
	readonly escapedBacktickUnclosedPattern: RegExp;
	readonly camelEscapedBacktickUnclosedPattern: RegExp;
}

function createCredentialRedactionRules(keyLabels: string, camelSimpleSuffixes: string): CredentialRedactionRules {
	const keyPattern = `(?:[A-Za-z0-9][A-Za-z0-9_.-]*[_.-])?(?:${keyLabels})`;
	const camelKeyPattern = `(?:(?:${CREDENTIAL_CAMEL_COMPOUND_PREFIX}|${CREDENTIAL_CAMEL_MULTI_PREFIX})(?:${CREDENTIAL_CAMEL_COMPOUND_SUFFIXES})|(?:${CREDENTIAL_CAMEL_PREFIX}|${CREDENTIAL_CAMEL_MULTI_PREFIX})(?:${camelSimpleSuffixes}))`;
	const assignmentPrefix = String.raw`(?<![A-Za-z0-9_.-])((?:\\*["'\x60]?-*)(?:${keyPattern})(?:\\*["'\x60]?\s*[=:]\s*))`;
	const camelAssignmentPrefix = String.raw`(?<![A-Za-z0-9_-])((?:\\*["'\x60]?-*)(?:${camelKeyPattern})(?:\\*["'\x60]?\s*[=:]\s*))`;
	const whitespaceFollowingFieldPattern = String.raw`[ \t]+(?:${keyLabels}|(?<!(?:^|[^A-Za-z0-9_.=:-])${CREDENTIAL_COMPOUND_FIELD_PREFIX}[ \t])[A-Za-z][A-Za-z0-9_.-]{0,127})[ \t]*[=:]`;
	const followingFieldPattern = String.raw`(?:[,;][ \t]*[A-Za-z][A-Za-z0-9_. \t-]{0,127}[ \t]*[=:]|${whitespaceFollowingFieldPattern})`;
	const unquotedValuePatternBody = String.raw`(?:(?!\\+n|\\+r\\+n|${followingFieldPattern})(?:\\[^\r\n]|[^\s"'\x60}\]]))(?:(?!\\+n|\\+r\\+n|${followingFieldPattern})(?:\\[^\r\n]|[^\r\n"'}\]]))*`;
	const valuePatternBody = String.raw`(?:(\\+")((?:\\[^\r\n]|[^"\\\r\n])*?)(\\+")${CREDENTIAL_QUOTED_ADJACENT_SUFFIX_PATTERN}${CREDENTIAL_VALUE_QUOTED_BOUNDARY}|(")((?:\\[^\r\n]|[^"\\\r\n])*)(")${CREDENTIAL_QUOTED_ADJACENT_SUFFIX_PATTERN}${CREDENTIAL_VALUE_QUOTED_BOUNDARY}|(\\+')((?:\\[^\r\n]|[^'\\\r\n])*?)(\\+')${CREDENTIAL_QUOTED_ADJACENT_SUFFIX_PATTERN}${CREDENTIAL_VALUE_QUOTED_BOUNDARY}|(')((?:\\[^\r\n]|[^'\\\r\n])*)(')${CREDENTIAL_QUOTED_ADJACENT_SUFFIX_PATTERN}${CREDENTIAL_VALUE_QUOTED_BOUNDARY}|(\x60)((?:\\[^\r\n]|[^\x60\\\r\n])*)(\x60)${CREDENTIAL_QUOTED_ADJACENT_SUFFIX_PATTERN}${CREDENTIAL_VALUE_QUOTED_BOUNDARY}|(\\+")([^\r\n]*)(?=\r?\n|$)|(")([^\r\n]*)(?=\r?\n|$)|(\\+')([^\r\n]*)(?=\r?\n|$)|(')([^\r\n]*)(?=\r?\n|$)|(\x60)([^\r\n]*)(?=\r?\n|$)|(${unquotedValuePatternBody}))`;
	return {
		keySuffix: new RegExp(`^${keyPattern}$`, "i"),
		camelKeySuffix: new RegExp(`^${camelKeyPattern}$`),
		assignmentPrefix,
		camelAssignmentPrefix,
		assignmentCandidatePattern: new RegExp(
			String.raw`(?<![A-Za-z0-9_.-])(?:${keyLabels})(?:\\*["'\x60]?\s*[=:]\s*)`,
			"i",
		),
		containerCandidatePattern: new RegExp(
			String.raw`(?<![A-Za-z0-9_.-])(?:${keyLabels})(?:\\*["'\x60]?\s*[=:]\s*[\[{])`,
			"i",
		),
		camelAssignmentCandidatePattern: new RegExp(
			String.raw`(?:${CREDENTIAL_CAMEL_COMPOUND_SUFFIXES}|${camelSimpleSuffixes})(?:\\*["'\x60]?\s*[=:]\s*)`,
		),
		camelContainerCandidatePattern: new RegExp(
			String.raw`(?:${CREDENTIAL_CAMEL_COMPOUND_SUFFIXES}|${camelSimpleSuffixes})(?:\\*["'\x60]?\s*[=:]\s*[\[{])`,
		),
		authValuePattern: new RegExp(
			String.raw`${assignmentPrefix}(?:Bearer|Basic|Token)\s+${unquotedValuePatternBody}`,
			"gi",
		),
		authValueLinePattern: new RegExp(
			String.raw`${assignmentPrefix}(?:Bearer|Basic|Token)[ \t]+(?![A-Za-z0-9._~+/=-]*:\/\/)${unquotedValuePatternBody}`,
			"gi",
		),
		valuePattern: new RegExp(String.raw`${assignmentPrefix}(?!\\+\x60)${valuePatternBody}`, "gi"),
		camelValuePattern: new RegExp(String.raw`${camelAssignmentPrefix}(?!\\+\x60)${valuePatternBody}`, "g"),
		escapedBacktickValuePattern: new RegExp(
			String.raw`${assignmentPrefix}(\\+\x60)((?:\\[^\r\n]|[^\x60\\\r\n])*?)(\\+\x60)${CREDENTIAL_QUOTED_ADJACENT_SUFFIX_PATTERN}${CREDENTIAL_VALUE_QUOTED_BOUNDARY}`,
			"gi",
		),
		camelEscapedBacktickValuePattern: new RegExp(
			String.raw`${camelAssignmentPrefix}(\\+\x60)((?:\\[^\r\n]|[^\x60\\\r\n])*?)(\\+\x60)${CREDENTIAL_QUOTED_ADJACENT_SUFFIX_PATTERN}${CREDENTIAL_VALUE_QUOTED_BOUNDARY}`,
			"g",
		),
		escapedBacktickUnclosedPattern: new RegExp(
			String.raw`${assignmentPrefix}(\\+\x60)((?:(?!\\+\x60)[^\r\n])*)(?=\r?\n|$)`,
			"gi",
		),
		camelEscapedBacktickUnclosedPattern: new RegExp(
			String.raw`${camelAssignmentPrefix}(\\+\x60)((?:(?!\\+\x60)[^\r\n])*)(?=\r?\n|$)`,
			"g",
		),
	};
}

const CURRENT_CREDENTIAL_REDACTION_RULES = createCredentialRedactionRules(
	CREDENTIAL_KEY_LABELS,
	CREDENTIAL_CAMEL_SIMPLE_SUFFIXES,
);
// Historical v1 fingerprints were computed before these two short aliases were recognized.
const V1_CREDENTIAL_REDACTION_RULES = createCredentialRedactionRules(
	CREDENTIAL_KEY_LABELS_V1,
	CREDENTIAL_CAMEL_SIMPLE_SUFFIXES_V1,
);
const COOKIE_VALUE_PATTERN =
	/(?:(?<![A-Za-z0-9_-])|(?<=\\n))((?:[A-Za-z0-9][A-Za-z0-9_-]*[_-])?cookies?\s*[:=]\s*)((?:(?!\\+n|\\+r\\+n)[^\r\n])*)/gi;
// Basic-auth credentials embedded in a URL. Scheme and host stay readable because they are the
// diagnostic value; only the userinfo is dropped. The left boundary is consumed so the unbounded
// scheme scan starts only at the start of a scheme-character run, avoiding quadratic retries while
// accepting long standards-compliant schemes. The greedy authority scan consumes raw `@`
// characters in userinfo through its delimiter.
const URL_CREDENTIAL_SOURCE = String.raw`(^|[^A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@`;
// Cap key inspection; YAML permits the chomping and indentation indicators in either order.
const YAML_BLOCK_SCALAR_HEADER_PATTERN =
	/^([ \t]*(?:-[ \t]+)?)(?:"([^"\r\n]{1,128})"|'([^'\r\n]{1,128})'|([A-Za-z0-9][A-Za-z0-9_. \t-]{0,127}?))[ \t]*:[ \t]*(?:[ \t]+(?:&[^ \t\r\n]{1,128}|![^ \t\r\n]{1,128}))*[ \t]*([|>](?:[1-9][+-]?|[+-][1-9]?)?)(?:[ \t]+#.*|[ \t]*)$/;

type YamlBlockScalarHeader = { indentation: number };

function isCredentialKeyWithRules(key: string, rules: CredentialRedactionRules): boolean {
	return rules.keySuffix.test(key) || rules.camelKeySuffix.test(key);
}

function parseCredentialYamlBlockScalarHeader(
	line: string,
	rules: CredentialRedactionRules = CURRENT_CREDENTIAL_REDACTION_RULES,
): YamlBlockScalarHeader | undefined {
	const match = YAML_BLOCK_SCALAR_HEADER_PATTERN.exec(line);
	const key = (match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
	if (match === null || !isCredentialKeyWithRules(key, rules)) return undefined;
	return { indentation: (match[1] ?? "").length };
}

function lineBounds(text: string, start: number): { contentEnd: number; nextLineStart: number } {
	const newline = text.indexOf("\n", start);
	const nextLineStart = newline < 0 ? text.length : newline + 1;
	let contentEnd = newline < 0 ? text.length : newline;
	if (newline > start && text[newline - 1] === "\r") contentEnd--;
	return { contentEnd, nextLineStart };
}

export type CrashMaskStructure = "structured" | "blind";

/**
 * Locate the printed body text of every credential-named block scalar, one span per non-empty
 * body line. The spans exclude the line's indentation and trailing whitespace, exactly the text
 * the YAML rule replaces, so a caller can mask them alongside its own structural ranges instead
 * of letting a later pass re-read structure this one already classified.
 *
 * A structure-blind scan accepts a header at any indentation and ignores the containers and quoted
 * values around it. It therefore still finds an indented body whose structure-aware scan was
 * wrongly suppressed, which is what lets the containment property catch that defect.
 */
function findYamlBlockScalarSpansWithRules(
	text: string,
	rules: CredentialRedactionRules,
	structure: CrashMaskStructure = "structured",
): PrivateKeySpan[] {
	const spans: PrivateKeySpan[] = [];
	// A header line inside a credential container is data the container owns, not YAML structure:
	// the container's close bounds the scalar, so the body scan cannot walk past it into unrelated
	// text that merely looks indented. The blind scan still accepts an indented header there, but
	// it must stop at the same container close or it would delete text no structure-aware mask owns.
	const containers = findCredentialContainerSpansIn(text, rules);
	let quotedContainers: PrivateKeySpan[] | undefined;
	let lineStart = 0;

	while (lineStart < text.length) {
		const { contentEnd, nextLineStart } = lineBounds(text, lineStart);
		const header = parseCredentialYamlBlockScalarHeader(text.slice(lineStart, contentEnd), rules);
		if (header === undefined) {
			lineStart = nextLineStart;
			continue;
		}
		if (structure !== "blind") {
			// A "header" inside a quoted container value is data, not a block scalar.
			quotedContainers ??= findQuotedContainerDataSpansIn(text);
			if (
				positionInsideSpans(quotedContainers, lineStart) ||
				positionInsideSpans(quotedContainers, lineStart + header.indentation)
			) {
				lineStart = nextLineStart;
				continue;
			}
		}

		const bodyLimit = containingContainerEnd(containers, lineStart) ?? text.length;
		let bodyLineStart = nextLineStart;
		while (bodyLineStart < bodyLimit) {
			const bodyLine = lineBounds(text, bodyLineStart);
			const bodyContentEnd = Math.min(bodyLine.contentEnd, bodyLimit);
			let indentation = 0;
			while (
				bodyLineStart + indentation < bodyContentEnd &&
				(text[bodyLineStart + indentation] === " " || text[bodyLineStart + indentation] === "\t")
			) {
				indentation++;
			}

			if (bodyLineStart + indentation === bodyContentEnd) {
				bodyLineStart = bodyLine.nextLineStart;
				continue;
			}
			if (indentation <= header.indentation) break;

			let bodyTextEnd = bodyContentEnd;
			while (
				bodyTextEnd > bodyLineStart + indentation &&
				(text[bodyTextEnd - 1] === " " || text[bodyTextEnd - 1] === "\t")
			) {
				bodyTextEnd--;
			}
			spans.push({ start: bodyLineStart + indentation, end: bodyTextEnd });
			bodyLineStart = bodyLine.nextLineStart;
		}

		lineStart = bodyLineStart;
	}

	return spans;
}

/**
 * A container assignment under any key, not only a credential-named one. A quoted mapping key
 * (`"wrapper": [...]`) heads the same container as a bare one, so the bound must accept it.
 */
const ANY_CONTAINER_ASSIGNMENT =
	/(?<![A-Za-z0-9_.-])(?:"[^"\r\n]{0,127}"|'[^'\r\n]{0,127}'|[A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]*[:=][ \t]*(?=[[{])/g;

/**
 * A quote opens a bracketed value only after the delimiter that introduces it (`[`, `{`, `,`,
 * `:` or `=`). An apostrophe inside a plain scalar (`don't`) is data, and treating it as an
 * opening quote hides the container's real close.
 */
function opensQuotedValue(text: string, index: number, start: number): boolean {
	let previous = index - 1;
	while (
		previous >= start &&
		(text[previous] === " " || text[previous] === "\t" || text[previous] === "\n" || text[previous] === "\r")
	)
		previous--;
	if (previous < start) return false;
	const character = text[previous];
	return character === "[" || character === "{" || character === "," || character === ":" || character === "=";
}

/**
 * Whether `position` sits in a YAML comment. A comment starts at `#` in the first column or after
 * whitespace, and only outside a quoted scalar. An inline comment ends the structural line just
 * as a leading one does, so a container assignment written after it is prose, not structure.
 */
function positionOnCommentLine(text: string, position: number): boolean {
	const lineStart = text.lastIndexOf("\n", position - 1) + 1;
	let quote: string | undefined;
	for (let index = lineStart; index < position; index++) {
		const character = text[index] ?? "";
		if (character === "\\") {
			index++;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (
			(character === '"' || character === "'" || character === "`") &&
			(index === lineStart || opensQuotedValue(text, index, lineStart))
		) {
			quote = character;
			continue;
		}
		if (character !== "#") continue;
		if (index === lineStart || text[index - 1] === " " || text[index - 1] === "\t") return true;
	}
	return false;
}

/**
 * Quoted regions that belong to a bracketed container value. A YAML block-scalar header found
 * inside one of these is ordinary string data, not document structure, so the block scan must not
 * start there and eat the rest of the enclosing document.
 */
function findQuotedContainerDataSpansIn(text: string): PrivateKeySpan[] {
	const spans: PrivateKeySpan[] = [];
	ANY_CONTAINER_ASSIGNMENT.lastIndex = 0;
	for (let match = ANY_CONTAINER_ASSIGNMENT.exec(text); match !== null; ) {
		// A comment line is not YAML structure, so it cannot open a container that would
		// suppress the header scan for the real document below it.
		if (positionOnCommentLine(text, match.index)) {
			ANY_CONTAINER_ASSIGNMENT.lastIndex = match.index + match[0].length;
			match = ANY_CONTAINER_ASSIGNMENT.exec(text);
			continue;
		}
		const containerStart = ANY_CONTAINER_ASSIGNMENT.lastIndex;
		const containerEnd = findCredentialContainerEnd(
			text,
			containerStart,
			text.length - containerStart,
			createLineEndScan(),
		).value;
		let quote: string | undefined;
		let quoteStart = -1;
		for (let index = containerStart + 1; index < containerEnd; index++) {
			const character = text[index] ?? "";
			if (character === "\\") {
				index++;
				continue;
			}
			if (quote !== undefined) {
				if (character === quote) {
					spans.push({ start: quoteStart, end: index + 1 });
					quote = undefined;
				}
				continue;
			}
			if (
				(character === '"' || character === "'" || character === "`") &&
				opensQuotedValue(text, index, containerStart)
			) {
				quote = character;
				quoteStart = index;
			}
		}
		// An unterminated quote still owns every line up to the container's end.
		if (quote !== undefined) spans.push({ start: quoteStart, end: containerEnd });
		ANY_CONTAINER_ASSIGNMENT.lastIndex = containerEnd;
		match = ANY_CONTAINER_ASSIGNMENT.exec(text);
	}
	spans.sort((left, right) => left.start - right.start);
	return spans;
}

function positionInsideSpans(spans: readonly PrivateKeySpan[], position: number): boolean {
	let low = 0;
	let high = spans.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const span = spans[middle];
		if (position < span.start) high = middle - 1;
		else if (position >= span.end) low = middle + 1;
		else return true;
	}
	return false;
}

/** End of the innermost container that contains `position`, or undefined. */
function containingContainerEnd(containers: readonly PrivateKeySpan[], position: number): number | undefined {
	let low = 0;
	let high = containers.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const container = containers[middle];
		if (position < container.start) high = middle - 1;
		else if (position >= container.end) low = middle + 1;
		else return container.end;
	}
	return undefined;
}

/** Locate the credential-named YAML block-scalar bodies of one original text. */
export function findYamlBlockScalarSpans(text: OriginalText): PrivateKeySpan[] {
	return findYamlBlockScalarSpansWithRules(text, CURRENT_CREDENTIAL_REDACTION_RULES);
}

function redactYamlBlockScalars(text: string, rules: CredentialRedactionRules): string {
	return applyContainerSpans(text, findYamlBlockScalarSpansWithRules(text, rules));
}

function isCookieFieldWhitespace(character: string | undefined): boolean {
	return character === " " || character === "\t";
}

function isCookieFieldNameStart(character: string | undefined): boolean {
	if (character === undefined) return false;
	const code = character.charCodeAt(0);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isCookieFieldNameCharacter(character: string | undefined): boolean {
	if (character === undefined) return false;
	const code = character.charCodeAt(0);
	return (
		character === "_" ||
		character === "-" ||
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122)
	);
}

function cookieDiagnosticSuffix(value: string): string {
	let quote: string | undefined;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (character === "\\") {
			index++;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (!isCookieFieldWhitespace(character)) continue;

		const boundary = index;
		while (isCookieFieldWhitespace(value[index])) index++;
		if (!isCookieFieldNameStart(value[index])) continue;
		while (isCookieFieldNameCharacter(value[index])) index++;
		while (isCookieFieldWhitespace(value[index])) index++;
		if (value[index] !== "=" && value[index] !== ":") continue;

		let previous = boundary - 1;
		while (previous >= 0 && isCookieFieldWhitespace(value[previous])) previous--;
		if (value[previous] !== ";" && value[previous] !== ",") return value.slice(boundary);
	}
	return "";
}

/** Whether a field name ends in a credential label recognized by the redactor. */
export function isCredentialKey(key: string): boolean {
	return isCredentialKeyWithRules(key, CURRENT_CREDENTIAL_REDACTION_RULES);
}

/** Whether a field name holds a collection of header or cookie name-value pairs. */
export function isHeaderCollectionKey(key: string | undefined): boolean {
	return key !== undefined && HEADER_COLLECTION_KEYS.has(key.toLowerCase());
}

/** Field names whose value is a collection of header or cookie name-value pairs. */
const HEADER_COLLECTION_KEYS = new Set([
	"header",
	"headers",
	"headerrecords",
	"header_records",
	"cookies",
	"cookie",
	"setcookie",
	"set_cookie",
]);

/** Context the caller established for a value tree. */
export interface StructuredRedactionOptions {
	/**
	 * Whether the value under `key` is a header collection: a flat `[name, value, ...]`
	 * string array, or records carrying a `name`/`key` and a `value`/`values` field.
	 * `true` treats every such shape as header pairs; a predicate keeps the heuristic
	 * to the field names that really hold header collections, so ordinary data such as
	 * `paths: ["auth", "src"]` or `{ name: "token", value: "identifier" }` keeps its values.
	 */
	readonly headerPairs?: boolean | ((key: string | undefined) => boolean);
	/**
	 * How a stored field name is resolved before it is classified. Defaults to the name as given,
	 * which is what a caller that already decodes names before serializing wants; a caller whose
	 * names can still carry an encoded spelling resolves them here instead, so the credential
	 * test, the header-collection test and the header-record member names all read one spelling.
	 */
	readonly resolveKey?: (key: string) => string;
}

function allowsHeaderPairs(options: StructuredRedactionOptions | undefined, key: string | undefined): boolean {
	const headerPairs = options?.headerPairs;
	if (typeof headerPairs !== "function") return headerPairs === true;
	return headerPairs(key === undefined ? undefined : resolvedField(options, key));
}

function resolvedField(options: StructuredRedactionOptions | undefined, key: string): string {
	return options?.resolveKey ? options.resolveKey(key) : key;
}

function isCredentialField(options: StructuredRedactionOptions | undefined, key: string): boolean {
	return isCredentialKey(resolvedField(options, key));
}

/**
 * Redact credential values in JSON-like data before serialization.
 * `key` lets callers preserve credential-field context when formatting one value.
 */
export function redactStructuredSecrets(value: unknown, key?: string, options?: StructuredRedactionOptions): unknown {
	if (key !== undefined && isCredentialField(options, key)) return "«redacted»";
	if (typeof value === "string") return redactCrashSecrets(value);
	if (Array.isArray(value)) {
		const headerPairs = allowsHeaderPairs(options, key);
		const isFlatKeyValueArray =
			headerPairs &&
			value.length > 0 &&
			value.length % 2 === 0 &&
			value.every((item, index) => index % 2 === 1 || typeof item === "string");
		if (isFlatKeyValueArray) {
			return value.map((item, index) => {
				if (index % 2 === 1) {
					const field = value[index - 1];
					if (typeof field === "string" && isCredentialField(options, field)) return "«redacted»";
				}
				return redactStructuredSecrets(item, undefined, options);
			});
		}
		return value.map(item => redactStructuredSecrets(item, key, options));
	}
	if (value === null || typeof value !== "object") return value;

	const source = value as Record<string, unknown>;
	const sourceKeys = Object.keys(source);
	let hasCredentialHeaderName = false;
	let hasHeaderValue = false;
	for (const field of sourceKeys) {
		const normalized = resolvedField(options, field).toLowerCase();
		if (normalized === "value" || normalized === "values") hasHeaderValue = true;
		if (normalized !== "name" && normalized !== "key") continue;
		const headerName = source[field];
		if (typeof headerName === "string" && isCredentialField(options, headerName)) hasCredentialHeaderName = true;
	}
	const redactHeaderValue = allowsHeaderPairs(options, key) && hasCredentialHeaderName && hasHeaderValue;
	const redacted = Object.create(null) as Record<string, unknown>;
	const nextSuffixByKey = new Map<string, number>();
	for (const field of sourceKeys) {
		const redactedKey = uniqueStructuredKey(redacted, redactCrashSecrets(field), nextSuffixByKey);
		const normalized = resolvedField(options, field).toLowerCase();
		if (redactHeaderValue && (normalized === "value" || normalized === "values")) {
			const headerValue = source[field];
			redacted[redactedKey] =
				normalized === "values" && Array.isArray(headerValue) ? headerValue.map(() => "«redacted»") : "«redacted»";
		} else {
			redacted[redactedKey] = redactStructuredSecrets(source[field], field, options);
		}
	}
	return redacted;
}

function uniqueStructuredKey(
	target: Record<string, unknown>,
	key: string,
	nextSuffixByKey: Map<string, number>,
): string {
	if (!Object.hasOwn(target, key)) return key;
	let suffix = nextSuffixByKey.get(key) ?? 2;
	let candidate = `${key}#${suffix}`;
	while (Object.hasOwn(target, candidate)) {
		suffix += 1;
		candidate = `${key}#${suffix}`;
	}
	nextSuffixByKey.set(key, suffix + 1);
	return candidate;
}

interface ValueOffsets {
	readonly markerStart: number;
	readonly markerEnd: number;
	readonly deleteStart?: number;
	readonly deleteEnd?: number;
}

/** Offsets of the secret inside one `valuePattern` match, mirroring the old replacement exactly. */
function credentialValueOffsets(match: RegExpExecArray): ValueOffsets | undefined {
	const whole = match[0];
	if (parseCredentialYamlBlockScalarHeader(whole) !== undefined) return undefined;
	const prefix = match[1] ?? "";
	const escapedDoubleQuoted = match[3];
	const doubleQuoted = match[6];
	const escapedSingleQuoted = match[9];
	const singleQuoted = match[12];
	const backtickQuoted = match[15];
	const unclosedEscapedDoubleQuoted = match[18];
	const unclosedDoubleQuoted = match[20];
	const unclosedEscapedSingleQuoted = match[22];
	const unclosedSingleQuoted = match[24];
	const unclosedBacktickQuoted = match[26];
	const value =
		escapedDoubleQuoted ??
		doubleQuoted ??
		escapedSingleQuoted ??
		singleQuoted ??
		backtickQuoted ??
		unclosedEscapedDoubleQuoted ??
		unclosedDoubleQuoted ??
		unclosedEscapedSingleQuoted ??
		unclosedSingleQuoted ??
		unclosedBacktickQuoted ??
		whole.slice(prefix.length);
	const open =
		match[2] ??
		match[5] ??
		match[8] ??
		match[11] ??
		match[14] ??
		match[17] ??
		match[19] ??
		match[21] ??
		match[23] ??
		match[25] ??
		"";
	const close = match[4] ?? match[7] ?? match[10] ?? match[13] ?? match[16] ?? "";
	const suffix = whole.slice(prefix.length + open.length + value.length + close.length);
	if (REDACTION_PLACEHOLDER_PATTERN.test(value.trim()) && /^(?:[):.]|\/?>)*$/.test(suffix)) return undefined;
	const markerStart = prefix.length + open.length;
	const markerEnd = markerStart + value.length;
	if (close.length > 0) {
		return { markerStart, markerEnd, deleteStart: markerEnd + close.length, deleteEnd: whole.length };
	}
	if (open.length > 0) return { markerStart, markerEnd: whole.length };
	return { markerStart: prefix.length, markerEnd: whole.length };
}

function collectValueRanges(pattern: RegExp, line: string, base: number, out: RedactionRange[]): void {
	pattern.lastIndex = 0;
	for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
		if (match[0].length === 0) {
			pattern.lastIndex += 1;
			continue;
		}
		const offsets = credentialValueOffsets(match);
		if (offsets === undefined) continue;
		if (offsets.markerEnd > offsets.markerStart) {
			out.push({
				start: base + match.index + offsets.markerStart,
				end: base + match.index + offsets.markerEnd,
				label: "«redacted»",
			});
		}
		if (offsets.deleteEnd !== undefined && offsets.deleteEnd > offsets.deleteStart!) {
			out.push({
				start: base + match.index + offsets.deleteStart!,
				end: base + match.index + offsets.deleteEnd,
				label: "",
			});
		}
	}
}

function collectWholeMatchRanges(
	pattern: RegExp,
	line: string,
	base: number,
	label: string,
	out: RedactionRange[],
): void {
	pattern.lastIndex = 0;
	for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
		if (match[0].length === 0) {
			pattern.lastIndex += 1;
			continue;
		}
		out.push({ start: base + match.index, end: base + match.index + match[0].length, label });
	}
}

function collectPrefixedRanges(
	pattern: RegExp,
	line: string,
	base: number,
	label: string,
	out: RedactionRange[],
	skipYamlHeader: boolean,
): void {
	pattern.lastIndex = 0;
	for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
		if (match[0].length === 0) {
			pattern.lastIndex += 1;
			continue;
		}
		if (skipYamlHeader && parseCredentialYamlBlockScalarHeader(match[0]) !== undefined) continue;
		const start = match.index + (match[1]?.length ?? 0);
		if (match.index + match[0].length > start) {
			out.push({ start: base + start, end: base + match.index + match[0].length, label });
		}
	}
}

function collectCookieRanges(line: string, base: number, out: RedactionRange[]): void {
	COOKIE_VALUE_PATTERN.lastIndex = 0;
	for (let match = COOKIE_VALUE_PATTERN.exec(line); match !== null; match = COOKIE_VALUE_PATTERN.exec(line)) {
		if (match[0].length === 0) {
			COOKIE_VALUE_PATTERN.lastIndex += 1;
			continue;
		}
		if (parseCredentialYamlBlockScalarHeader(match[0]) !== undefined) continue;
		const [, prefix, value] = match;
		const start = match.index + prefix.length;
		const end = match.index + match[0].length - cookieDiagnosticSuffix(value).length;
		if (end > start) out.push({ start: base + start, end: base + end, label: "«redacted»" });
	}
}

function collectClosedEscapedBacktickRanges(pattern: RegExp, line: string, base: number, out: RedactionRange[]): void {
	pattern.lastIndex = 0;
	for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
		if (match[0].length === 0) {
			pattern.lastIndex += 1;
			continue;
		}
		const [, prefix, open, value, close] = match;
		const markerStart = match.index + prefix.length + open.length;
		const markerEnd = markerStart + value.length;
		if (markerEnd > markerStart) out.push({ start: base + markerStart, end: base + markerEnd, label: "«redacted»" });
		const deleteStart = markerEnd + close.length;
		const deleteEnd = match.index + match[0].length;
		if (deleteEnd > deleteStart) out.push({ start: base + deleteStart, end: base + deleteEnd, label: "" });
	}
}

function collectUnclosedEscapedBacktickRanges(
	pattern: RegExp,
	line: string,
	base: number,
	out: RedactionRange[],
): void {
	pattern.lastIndex = 0;
	for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
		if (match[0].length === 0) {
			pattern.lastIndex += 1;
			continue;
		}
		const start = match.index + match[1].length + match[2].length;
		if (match.index + match[0].length > start) {
			out.push({ start: base + start, end: base + match.index + match[0].length, label: "«redacted»" });
		}
	}
}

const AUTH_TOKEN_PATTERN =
	/(?<![A-Za-z0-9_-])(?:Bearer|Basic|Token)[ \t]+(?![A-Za-z0-9._~+/=-]*:\/\/)[A-Za-z0-9._~+/=-]{8,}/gi;

const RESIDUAL_WHOLE_MATCH_RULES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
	{ pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: "«redacted-jwt»" },
	{ pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, label: "«redacted-api-key»" },
	{ pattern: /\bgh[opsur]_[A-Za-z0-9]{16,}\b/g, label: "«redacted-github-token»" },
	{ pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "«redacted-github-token»" },
	{ pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, label: "«redacted-slack-token»" },
	{ pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, label: "«redacted-npm-token»" },
	{ pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, label: "«redacted-gitlab-token»" },
	{ pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, label: "«redacted-api-key»" },
	{ pattern: /\bhf_[A-Za-z0-9]{20,}\b/g, label: "«redacted-api-key»" },
	{ pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, label: "«redacted-google-api-key»" },
	{ pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, label: "«redacted-aws-key»" },
];

const RESIDUAL_TRAILING_PREFIX_RULES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
	{
		pattern: /(?<![A-Za-z0-9_])(["']?session(?:id|[_-]id)["']?\s*[=:]\s*["']?)[^\s"',;}\]]{8,}/gi,
		label: "«redacted»",
	},
	{
		pattern: /(?<![A-Za-z0-9_%])(session(?:id|[_-]id)%3[Dd])[A-Za-z0-9._~%-]{8,}/gi,
		label: "«redacted»",
	},
];

const RESIDUAL_TRAILING_WHOLE_MATCH_RULES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
	{
		pattern: /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]{0,39}[/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
		label: "«redacted-aws-key»",
	},
];

/**
 * Line-bounded rules of one original text. Every pattern is attempted on one physical line only,
 * so no rule can consume a line terminator or reinterpret text produced by another rule.
 */
const AUTH_SCHEME_AT_LINE_END = /(?:^|[:=])[ \t]*"?[ \t]*(?:Bearer|Basic|Token)[ \t]*$/i;
/** A URI may follow the cue after any run of wrapper characters, as in `**https://…**`. */
const URI_AT_LINE_START = /^[ \t]*[^A-Za-z0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const DIAGNOSTIC_ASSIGNMENT_AT_LINE_START = /^[ \t]*[A-Za-z][A-Za-z0-9_.-]{0,127}[ \t]*[=:]/;
/** token68/base64: the trailing `=` is padding, not an assignment separator. */
const BASE64_CONTINUATION_LINE = /^[ \t]*([A-Za-z0-9+/]{8,})(={0,2})[ \t]*$/;
/**
 * A padded token at the start of a line: base64 characters, then one or two `=` and the field
 * separator. The padding must complete a group of four. An all-lower-case payload can be an
 * English word (`diagnostic=`, `diagnostics=`), so it counts as a token only when two pads or a
 * field after it already show that the `=` is padding; otherwise a plain `<word>= value` line is
 * an assignment and keeps its key.
 */
const PADDED_TOKEN_AT_LINE_START = /^[ \t]*([A-Za-z0-9+/]{8,})(={1,2})(?=[ \t]|$)/;
const CONTINUATION_DELIMITER = /[\s,;"'`}\]]/;

/** Whether `line` starts with a base64 token whose `=` padding completes its final group. */
function startsWithPaddedToken(line: string): boolean {
	const match = PADDED_TOKEN_AT_LINE_START.exec(line);
	if (match === null) return false;
	const payload = match[1] as string;
	const padding = match[2] as string;
	if ((payload.length + padding.length) % 4 !== 0) return false;
	if (/[A-Z0-9+/]/.test(payload)) return true;
	if (padding === "==") return true;
	return DIAGNOSTIC_ASSIGNMENT_AT_LINE_START.test(line.slice(match[0].length));
}

/** Whether `line` is one base64 token68 value whose group of four is complete. */
function startsWithBase64Continuation(line: string): boolean {
	const match = BASE64_CONTINUATION_LINE.exec(line);
	if (match === null) return false;
	return ((match[1] as string).length + (match[2] as string).length) % 4 === 0;
}

/**
 * Whether a continuation line names a diagnostic field. Base64 is the exception: its padding is
 * not `key=value`, so `Basic\nZml4dHVyZTpwYXNzd29yZA==` stays a credential continuation. A
 * padded token followed by whitespace is the same exception with a diagnostic after it.
 */
function startsDiagnosticAssignment(line: string): boolean {
	return (
		!startsWithBase64Continuation(line) &&
		!startsWithPaddedToken(line) &&
		DIAGNOSTIC_ASSIGNMENT_AT_LINE_START.test(line)
	);
}

/** Whether a line already carries a URL whose userinfo rule masks its own credential. */
function carriesUrlCredential(line: string): boolean {
	return findUrlCredentialSpansIn(line).length > 0;
}

/** An auth cue followed by an escaped line break (`\\n`), as a JSON-serialized value prints it. */
const ESCAPED_AUTH_CUE = /(?:^|[^A-Za-z0-9_-])(?:Bearer|Basic|Token)[ \t]*(?:\\+r)?\\+n[ \t]*/gi;

/**
 * End of a serialized line break (`\\n` or `\\r\\n`) at `at`, or -1. An even backslash run is a
 * literal backslash, not an escape, so it does not separate fields.
 */
function serializedLineBreakEnd(text: string, at: number): number {
	if (text[at] !== "\\") return -1;
	let run = at;
	while (text[run] === "\\") run++;
	if ((run - at) % 2 === 0) return -1;
	if (text[run] === "n") return run + 1;
	if (text[run] === "r" && text[run + 1] === "\\" && text[run + 2] === "n") return run + 3;
	return -1;
}

/**
 * The logical line a continuation token belongs to, for classification only. Inside a quoted
 * serialized value a space or comma after a token is string content, so the guards must read the
 * whole value line; the token-sized replacement range stays `token`. The line ends at the quote
 * that closes the value or at the next escaped break, and a trailing run of value delimiters is
 * not part of the line the guards read.
 */
function serializedContinuationLine(line: string, start: number, token: string, quote: string | undefined): string {
	if (quote === undefined) return token;
	let end = start;
	while (end < line.length && line[end] !== quote && serializedLineBreakEnd(line, end) < 0) end++;
	// A comma, brace or bracket right before the closing quote is content that would also end an
	// unquoted value, so it is not part of the line the guards read.
	while (end > start) {
		const character = line[end - 1];
		if (character !== "," && character !== "}" && character !== "]" && character !== ")") break;
		end--;
	}
	return line.slice(start, end).trimEnd();
}

/** Forward-only quote state for one physical line, so each character is scanned once per pass. */
interface SerializedQuoteScan {
	at: number;
	quote: string | undefined;
}

/** The quote still open at `target`, advancing the scan forward to it. */
function quoteAt(text: string, scan: SerializedQuoteScan, target: number, start: number): string | undefined {
	while (scan.at < target) {
		const character = text[scan.at] as string;
		if (character === "\\") {
			scan.at += 2;
			continue;
		}
		if (scan.quote !== undefined) {
			if (character === scan.quote) scan.quote = undefined;
			scan.at++;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			if (opensQuotedValue(text, scan.at, start)) scan.quote = character;
		}
		scan.at++;
	}
	return scan.quote;
}

/**
 * Mask the credential a serialized value carries after an escaped line break. The escaped form
 * prints on one physical line, so the continuation rules would never see the value; the guards
 * are the same ones the physical continuation uses.
 */
function collectEscapedContinuations(
	line: string,
	base: number,
	structure: CrashMaskStructure,
	out: RedactionRange[],
): void {
	ESCAPED_AUTH_CUE.lastIndex = 0;
	const quoteScan: SerializedQuoteScan = { at: 0, quote: undefined };
	for (let match = ESCAPED_AUTH_CUE.exec(line); match !== null; ) {
		const start = match.index + match[0].length;
		let end = start;
		// A serialized value prints each of its lines on one physical line. The next escaped break
		// ends this continuation, so the field after it keeps its own text and its own rules.
		while (
			end < line.length &&
			!CONTINUATION_DELIMITER.test(line[end] as string) &&
			serializedLineBreakEnd(line, end) < 0
		)
			end++;
		const token = line.slice(start, end);
		const logical = serializedContinuationLine(line, start, token, quoteAt(line, quoteScan, start, 0));
		const hasUriValue = structure === "blind" ? carriesUrlCredential(token) : URI_AT_LINE_START.test(token);
		if (end - start >= 8 && !startsDiagnosticAssignment(logical) && !hasUriValue) {
			out.push({ start: base + start, end: base + end, label: "«redacted-auth»" });
		}
		ESCAPED_AUTH_CUE.lastIndex = Math.max(ESCAPED_AUTH_CUE.lastIndex, end);
		match = ESCAPED_AUTH_CUE.exec(line);
	}
}

function collectResidualRanges(text: OriginalText, structure: CrashMaskStructure = "structured"): RedactionRange[] {
	const ranges: RedactionRange[] = [];
	let lineStart = 0;
	while (lineStart <= text.length) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd < 0) lineEnd = text.length;
		const contentEnd = lineEnd > lineStart && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
		const line = text.slice(lineStart, contentEnd);
		collectLineRanges(line, CURRENT_CREDENTIAL_REDACTION_RULES, lineStart, ranges);
		collectEscapedContinuations(line, lineStart, structure, ranges);
		// A scheme marker alone at the end of a line carries its value on the next physical line.
		// The continuation is explicit and bounded: it is skipped when the next line is a field
		// assignment, so `Token\ndiagnostics: keep-me` keeps its newline and its key.
		if (AUTH_SCHEME_AT_LINE_END.test(line) && lineEnd < text.length) {
			const nextStart = lineEnd + 1;
			let nextEnd = text.indexOf("\n", nextStart);
			if (nextEnd < 0) nextEnd = text.length;
			const nextContentEnd = nextEnd > nextStart && text[nextEnd - 1] === "\r" ? nextEnd - 1 : nextEnd;
			const nextLine = text.slice(nextStart, nextContentEnd);
			// A URI supplies its own credentials; the scheme word is not the value of the cue above,
			// so a continuation must not swallow the whole adjacent URL.
			const hasUriValue = structure === "blind" ? carriesUrlCredential(nextLine) : URI_AT_LINE_START.test(nextLine);
			if (!startsDiagnosticAssignment(nextLine) && !hasUriValue) {
				let start = 0;
				while (start < nextLine.length && (nextLine[start] === " " || nextLine[start] === "\t")) start++;
				let end = start;
				while (end < nextLine.length && !CONTINUATION_DELIMITER.test(nextLine[end])) end++;
				if (end - start >= 8)
					ranges.push({ start: nextStart + start, end: nextStart + end, label: "«redacted-auth»" });
			}
		}
		if (lineEnd === text.length) break;
		lineStart = lineEnd + 1;
	}
	return ranges;
}

function collectLineRanges(line: string, rules: CredentialRedactionRules, base: number, out: RedactionRange[]): void {
	collectWholeMatchRanges(AUTH_TOKEN_PATTERN, line, base, "«redacted-auth»", out);
	for (const rule of RESIDUAL_WHOLE_MATCH_RULES) collectWholeMatchRanges(rule.pattern, line, base, rule.label, out);
	collectCookieRanges(line, base, out);
	collectPrefixedRanges(rules.authValueLinePattern, line, base, "«redacted»", out, false);
	collectAuthorizationRanges(line, base, out);
	if (rules.assignmentCandidatePattern.test(line)) {
		collectClosedEscapedBacktickRanges(rules.escapedBacktickValuePattern, line, base, out);
		collectUnclosedEscapedBacktickRanges(rules.escapedBacktickUnclosedPattern, line, base, out);
		collectValueRanges(rules.valuePattern, line, base, out);
	}
	if (rules.camelAssignmentCandidatePattern.test(line)) {
		collectClosedEscapedBacktickRanges(rules.camelEscapedBacktickValuePattern, line, base, out);
		collectUnclosedEscapedBacktickRanges(rules.camelEscapedBacktickUnclosedPattern, line, base, out);
		collectValueRanges(rules.camelValuePattern, line, base, out);
	}
	for (const rule of RESIDUAL_TRAILING_PREFIX_RULES) {
		collectPrefixedRanges(rule.pattern, line, base, rule.label, out, false);
	}
	for (const rule of RESIDUAL_TRAILING_WHOLE_MATCH_RULES) {
		collectWholeMatchRanges(rule.pattern, line, base, rule.label, out);
	}
}

/** `Authorization: Bearer …` is owned by the auth-token rule so a later diagnostic survives. */
function collectAuthorizationRanges(line: string, base: number, out: RedactionRange[]): void {
	CREDENTIAL_AUTHORIZATION_VALUE_PATTERN.lastIndex = 0;
	for (let match = CREDENTIAL_AUTHORIZATION_VALUE_PATTERN.exec(line); match !== null; ) {
		if (match[0].length === 0) {
			CREDENTIAL_AUTHORIZATION_VALUE_PATTERN.lastIndex += 1;
			match = CREDENTIAL_AUTHORIZATION_VALUE_PATTERN.exec(line);
			continue;
		}
		const prefix = match[1] ?? "";
		const valueStart = match.index + prefix.length;
		const value = line.slice(valueStart, match.index + match[0].length);
		if (
			!/^(?:Bearer|Basic|Token)[ \t]/i.test(value) &&
			parseCredentialYamlBlockScalarHeader(match[0]) === undefined &&
			match[0].length > prefix.length
		) {
			out.push({ start: base + valueStart, end: base + match.index + match[0].length, label: "«redacted»" });
		}
		match = CREDENTIAL_AUTHORIZATION_VALUE_PATTERN.exec(line);
	}
}

/** Whether two half-open spans share at least one character. */
function spansOverlap(left: PrivateKeySpan, right: PrivateKeySpan): boolean {
	return left.start < right.end && right.start < left.end;
}

/**
 * Collect every structural mask of one original text: caller-supplied private-key ranges, then
 * credential containers, URL userinfo and YAML block-scalar bodies. Detection reads only
 * `original`; no range here is derived from another range's output.
 */
function collectStructuralRanges(
	original: OriginalText,
	privateKeySpans: readonly PrivateKeySpan[],
	structure: CrashMaskStructure,
): RedactionRange[] {
	return [
		...privateKeySpans.map(span => ({ start: span.start, end: span.end, label: PRIVATE_KEY_REDACTION_MARKER })),
		...findCredentialContainerSpans(original).map(span => ({ ...span, label: "«redacted»" })),
		// A private-key block is masked as its own diagnostic value. When one sits between the
		// scheme and the `@` of a URL, the greedy userinfo scan sees the whole host as userinfo and
		// would delete the host too; the block rule owns that text, so the URL rule stands down.
		...findUrlCredentialSpans(original)
			.filter(span => !privateKeySpans.some(key => spansOverlap(span, key)))
			.map(span => ({ ...span, label: "«redacted-url-credential»" })),
		...findYamlBlockScalarSpansFor(original, structure).map(span => ({ ...span, label: "«redacted»" })),
	];
}

function findYamlBlockScalarSpansFor(original: OriginalText, structure: CrashMaskStructure): PrivateKeySpan[] {
	return structure === "blind"
		? findYamlBlockScalarSpansWithRules(original, CURRENT_CREDENTIAL_REDACTION_RULES, "blind")
		: findYamlBlockScalarSpans(original);
}

/**
 * Every mask of one original text, in one classification pass: the structural ranges above plus
 * the line-bounded rules, which return their own ranges instead of editing text. Callers pass
 * private-key ranges they mapped from a wider original source; otherwise the text itself is read.
 * `structure` selects the structure-aware pass or the blind baseline the containment property
 * compares it against; the blind pass only removes suppression gates, never a detector.
 */
export function collectCrashRedactionRanges(
	original: OriginalText,
	privateKeySpans: readonly PrivateKeySpan[] = findPrivateKeySpans(original),
	structure: CrashMaskStructure = "structured",
): RedactionRanges {
	return [
		...collectStructuralRanges(original, privateKeySpans, structure),
		...collectResidualRanges(original, structure),
	];
}

/** One masked text and the ranges of its input that were replaced. */
export interface MaskedCrashText {
	readonly text: RedactedText;
	readonly masks: readonly RedactionRange[];
}

/**
 * Structure-aware masking, the output `redactCrashSecrets` produces: credential containers, URL
 * userinfo, paired private-key blocks and YAML block-scalar bodies all suppress or bound the
 * line rules, so this is the path where a wrong gate can hide a secret.
 */
export function maskStructured(text: string): MaskedCrashText {
	return maskCrashText(text, "structured");
}

/**
 * Structure-blind baseline over the same collectors: no credential-container suppression, no
 * quoted-value gate and no indentation-dependent header. A block-scalar body still stops at the
 * container close that holds it, because a blind mask must not own text no structure-aware mask
 * covers. Its masks are the ones any correct structure-aware pass must still cover, so a gate
 * that suppresses one of them is a bug.
 */
export function maskStructureBlind(text: string): MaskedCrashText {
	return maskCrashText(text, "blind");
}

function maskCrashText(text: string, structure: CrashMaskStructure): MaskedCrashText {
	const original = asOriginalText(text);
	const masks = mergeRedactionRanges(collectCrashRedactionRanges(original, findPrivateKeySpans(original), structure));
	return { text: applyRedactions(original, masks), masks };
}

/**
 * Preview masking for one captured field. Unlike the general record pass, a field preview must
 * remove a private-key opener whose footer fell outside the captured text, or the body would
 * print unmasked. The unpaired opener and the body it owns are detected on this original text
 * and applied in the same single pass; nothing rescans masked output.
 */
export function maskFieldPreview(text: string, structure: CrashMaskStructure = "structured"): MaskedCrashText {
	const original = asOriginalText(text);
	const masks = mergeRedactionRanges([
		...collectCrashRedactionRanges(original, findPrivateKeySpans(original), structure),
		...findUnpairedPrivateKeySpans(original).map(span => ({ ...span, label: PRIVATE_KEY_REDACTION_MARKER })),
	]);
	return { text: applyRedactions(original, masks), masks };
}

/** Structure-aware field-preview masking; see `maskFieldPreview`. */
export function redactCrashSecretsForPreview(text: string): string {
	return maskFieldPreview(text).text;
}

/**
 * Scrub credential material from crash text before it is persisted.
 * Covers bearer/basic-style headers, key=value or JSON key forms of common
 * credential names, and well-known vendor token shapes. Normal messages and
 * stack frames are untouched; matches are replaced in place so surrounding
 * diagnostic context survives.
 */
export function redactCrashSecrets(text: string): string {
	return maskStructured(text).text;
}

/** Historical redaction rules used only to validate v1 crash fingerprints. */
export function redactCrashSecretsV1(text: string): string {
	return redactHistoricalCrashSecrets(asOriginalText(text), V1_CREDENTIAL_REDACTION_RULES);
}

/** Sequential v1 rules, frozen for fingerprint validation only; current output never uses them. */
function redactHistoricalCrashSecrets(text: OriginalText, rules: CredentialRedactionRules): string {
	const structures = true;
	let redacted = structures ? redactCredentialContainers(text, rules, rules !== V1_CREDENTIAL_REDACTION_RULES) : text;
	if (structures) {
		// Block scalar bodies span lines and must be masked before line-bounded rules handle the
		// header. A residual caller detected and masked those bodies itself, so this pass may not
		// reinterpret the indentation its output left behind.
		redacted = redactYamlBlockScalars(redacted, rules);
	}
	// URL userinfo runs before the auth-token rule: `Token postgres://user:secret@host` would
	// otherwise lose its scheme word to the token rule and leave the authority unrecognizable.
	redacted = redacted.replace(new RegExp(URL_CREDENTIAL_SOURCE, "gi"), "$1$2«redacted-url-credential»@");
	redacted = redacted.replace(
		/(?<![A-Za-z0-9_-])(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
		"«redacted-auth»",
	);
	redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "«redacted-jwt»");
	redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "«redacted-api-key»");
	// `gh[opsur]_` covers the classic PAT/OAuth/server/user/refresh prefixes;
	// fine-grained PATs use an entirely different `github_pat_` prefix and would
	// otherwise survive into a log the module keeps indefinitely.
	redacted = redacted.replace(/\bgh[opsur]_[A-Za-z0-9]{16,}\b/g, "«redacted-github-token»");
	redacted = redacted.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "«redacted-github-token»");
	redacted = redacted.replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "«redacted-slack-token»");
	// The five shapes below are the ones `crash/upstream/envelope.ts` already
	// classifies as credential-like and refuses to transmit. That refusal only
	// guards the Sentry frame fields; the persisted crash log and the
	// `gjc crash report` body — which the user files as a public issue — reach
	// egress through this function alone, so the same shapes have to be named here.
	redacted = redacted.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "«redacted-npm-token»");
	redacted = redacted.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "«redacted-gitlab-token»");
	// Stripe separates with `_`, so the `sk-` rule above never matched one.
	redacted = redacted.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "«redacted-api-key»");
	redacted = redacted.replace(/\bhf_[A-Za-z0-9]{20,}\b/g, "«redacted-api-key»");
	// A PEM block carries the key material itself, so it is redacted whole rather
	// than line by line. It runs before the narrower rules because they would
	// otherwise chew on the base64 body and leave a truncated key behind.
	if (structures) redacted = redactPemPrivateKeys(redacted);
	// Google API keys are a fixed 39-character shape that carries no label of its
	// own, so the labeled-value rule below never sees one.
	redacted = redacted.replace(
		/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
		"«redacted-google-api-key»",
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
	// Cookie values may contain semicolon- or comma-separated pairs. Preserve a later,
	// whitespace-separated diagnostic assignment so the narrower rules can scrub
	// it independently without losing useful context after the cookie.
	redacted = redacted.replace(COOKIE_VALUE_PATTERN, (_match: string, prefix: string, value: string) =>
		parseCredentialYamlBlockScalarHeader(_match) === undefined
			? `${prefix}«redacted»${cookieDiagnosticSuffix(value)}`
			: _match,
	);
	redacted = redacted.replace(rules.authValuePattern, (_match, prefix: string) => `${prefix}«redacted»`);
	redacted = redacted.replace(CREDENTIAL_AUTHORIZATION_VALUE_PATTERN, (_match: string, prefix: string) =>
		parseCredentialYamlBlockScalarHeader(_match) === undefined ? `${prefix}«redacted»` : _match,
	);
	// Escaped delimiters support JSON nested in diagnostic strings. Quoted scalar
	// values stay within one physical line; closed values also require a field
	// boundary after the closing delimiter, while unterminated values redact
	// through the end of their line. Capture each complete key once and inspect
	// its suffix; repeated compound-prefix groups backtrack quadratically on long
	// attacker-controlled identifiers.
	if (rules.assignmentCandidatePattern.test(redacted)) {
		redacted = redacted.replace(
			rules.escapedBacktickValuePattern,
			(_match: string, prefix: string, open: string, _value: string, close: string) =>
				`${prefix}${open}«redacted»${close}`,
		);
		redacted = redacted.replace(
			rules.escapedBacktickUnclosedPattern,
			(_match: string, prefix: string, open: string) => `${prefix}${open}«redacted»`,
		);
		redacted = redacted.replace(rules.valuePattern, redactCredentialValue);
	}
	if (rules.camelAssignmentCandidatePattern.test(redacted)) {
		redacted = redacted.replace(
			rules.camelEscapedBacktickValuePattern,
			(_match: string, prefix: string, open: string, _value: string, close: string) =>
				`${prefix}${open}«redacted»${close}`,
		);
		redacted = redacted.replace(
			rules.camelEscapedBacktickUnclosedPattern,
			(_match: string, prefix: string, open: string) => `${prefix}${open}«redacted»`,
		);
		redacted = redacted.replace(rules.camelValuePattern, redactCredentialValue);
	}
	// Keep dev's literal session-id cookie variants, which are not credential labels.
	redacted = redacted.replace(
		/(?<![A-Za-z0-9_])(["']?session(?:id|[_-]id)["']?\s*[=:]\s*["']?)[^\s"',;}\]]{8,}/gi,
		"$1«redacted»",
	);
	redacted = redacted.replace(/(?<![A-Za-z0-9_%])(session(?:id|[_-]id)%3[Dd])[A-Za-z0-9._~%-]{8,}/gi, "$1«redacted»");
	// Bare AWS secret access keys have no label; require `/` or `+` to avoid
	// masking a 40-character alphanumeric diagnostic token.
	redacted = redacted.replace(
		/(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]{0,39}[/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
		"«redacted-aws-key»",
	);
	return redacted;
}

function redactCredentialValue(
	_match: string,
	prefix: string,
	escapedDoubleOpen: string | undefined,
	escapedDoubleQuoted: string | undefined,
	escapedDoubleClose: string | undefined,
	doubleOpen: string | undefined,
	doubleQuoted: string | undefined,
	doubleClose: string | undefined,
	escapedSingleOpen: string | undefined,
	escapedSingleQuoted: string | undefined,
	escapedSingleClose: string | undefined,
	singleOpen: string | undefined,
	singleQuoted: string | undefined,
	singleClose: string | undefined,
	backtickOpen: string | undefined,
	backtickQuoted: string | undefined,
	backtickClose: string | undefined,
	unclosedEscapedDoubleOpen: string | undefined,
	unclosedEscapedDoubleQuoted: string | undefined,
	unclosedDoubleOpen: string | undefined,
	unclosedDoubleQuoted: string | undefined,
	unclosedEscapedSingleOpen: string | undefined,
	unclosedEscapedSingleQuoted: string | undefined,
	unclosedSingleOpen: string | undefined,
	unclosedSingleQuoted: string | undefined,
	unclosedBacktickOpen: string | undefined,
	unclosedBacktickQuoted: string | undefined,
): string {
	if (parseCredentialYamlBlockScalarHeader(_match) !== undefined) return _match;
	const value =
		escapedDoubleQuoted ??
		doubleQuoted ??
		escapedSingleQuoted ??
		singleQuoted ??
		backtickQuoted ??
		unclosedEscapedDoubleQuoted ??
		unclosedDoubleQuoted ??
		unclosedEscapedSingleQuoted ??
		unclosedSingleQuoted ??
		unclosedBacktickQuoted ??
		_match.slice(prefix.length);
	const open =
		escapedDoubleOpen ??
		doubleOpen ??
		escapedSingleOpen ??
		singleOpen ??
		backtickOpen ??
		unclosedEscapedDoubleOpen ??
		unclosedDoubleOpen ??
		unclosedEscapedSingleOpen ??
		unclosedSingleOpen ??
		unclosedBacktickOpen ??
		"";
	const close = escapedDoubleClose ?? doubleClose ?? escapedSingleClose ?? singleClose ?? backtickClose ?? "";
	const suffix = _match.slice(prefix.length + open.length + value.length + close.length);
	// Only quoted-value boundary punctuation may follow a complete placeholder, never a credential suffix.
	if (REDACTION_PLACEHOLDER_PATTERN.test(value.trim()) && /^(?:[):.]|\/?>)*$/.test(suffix)) {
		return _match;
	}
	if (escapedDoubleQuoted !== undefined && escapedDoubleOpen !== undefined && escapedDoubleClose !== undefined) {
		return `${prefix}${escapedDoubleOpen}«redacted»${escapedDoubleClose}`;
	}
	if (doubleQuoted !== undefined && doubleOpen !== undefined && doubleClose !== undefined) {
		return `${prefix}${doubleOpen}«redacted»${doubleClose}`;
	}
	if (escapedSingleQuoted !== undefined && escapedSingleOpen !== undefined && escapedSingleClose !== undefined) {
		return `${prefix}${escapedSingleOpen}«redacted»${escapedSingleClose}`;
	}
	if (singleQuoted !== undefined && singleOpen !== undefined && singleClose !== undefined) {
		return `${prefix}${singleOpen}«redacted»${singleClose}`;
	}
	if (backtickQuoted !== undefined && backtickOpen !== undefined && backtickClose !== undefined) {
		return `${prefix}${backtickOpen}«redacted»${backtickClose}`;
	}
	if (unclosedEscapedDoubleQuoted !== undefined && unclosedEscapedDoubleOpen !== undefined) {
		return `${prefix}${unclosedEscapedDoubleOpen}«redacted»`;
	}
	if (unclosedDoubleQuoted !== undefined && unclosedDoubleOpen !== undefined) {
		return `${prefix}${unclosedDoubleOpen}«redacted»`;
	}
	if (unclosedEscapedSingleQuoted !== undefined && unclosedEscapedSingleOpen !== undefined) {
		return `${prefix}${unclosedEscapedSingleOpen}«redacted»`;
	}
	if (unclosedSingleQuoted !== undefined && unclosedSingleOpen !== undefined) {
		return `${prefix}${unclosedSingleOpen}«redacted»`;
	}
	if (unclosedBacktickQuoted !== undefined && unclosedBacktickOpen !== undefined) {
		return `${prefix}${unclosedBacktickOpen}«redacted»`;
	}
	return `${prefix}«redacted»`;
}

/**
 * Lookahead the nested-container scan may spend on one scrub call, in characters.
 * Proportional to the input so ordinary text always receives a complete scan while
 * repeated unterminated containers cannot force a quadratic rescan.
 */
const CONTAINER_SCAN_BUDGET_FACTOR = 16;

interface ContainerScanBudget {
	/**
	 * Lookahead left for container scans. A container is only examined when the whole remaining
	 * text fits in the budget, so a scan is never cut short and a later complete container can
	 * never expose its contents. When it does not fit, the rest of the text is redacted: the
	 * give-up point is reachable only by text already dominated by unclosed containers.
	 */
	remaining: number;
}

function createContainerScanBudget(length: number, bounded: boolean): ContainerScanBudget {
	// The historical rules only ever see already-persisted crash text, and their output feeds
	// fingerprint validation, so they keep the unbounded scan they were written against.
	return { remaining: bounded ? length * CONTAINER_SCAN_BUDGET_FACTOR + 1024 : Number.POSITIVE_INFINITY };
}

function redactCredentialContainers(text: string, rules: CredentialRedactionRules, bounded: boolean): string {
	if (!rules.containerCandidatePattern.test(text) && !rules.camelContainerCandidatePattern.test(text)) return text;
	const { assignment, camel } = containerAssignmentPatterns(rules);
	const state: ContainerScanState = { exhausted: false };
	const generic = redactCredentialContainersWithPattern(text, assignment, bounded, state);
	if (state.exhausted) {
		// The cutoff cannot prove that what it kept is safe for the rules that read this text next:
		// it removes the footer a block pairs with and the `@` that ends a URL's userinfo. One
		// marker for the whole text is the only cut that holds for every later rule.
		return "«redacted»";
	}
	const camelMasked = redactCredentialContainersWithPattern(generic, camel, bounded, state);
	return state.exhausted ? "«redacted»" : camelMasked;
}

/**
 * Locate the userinfo of every URL that carries one, without mutating the text.
 * Only the userinfo is a range: the scheme and host stay readable because they say which remote
 * failed. Detection has to read the original text, because an auth-token rule that runs first can
 * consume the scheme word and leave `://user:secret@host` without an authority the URL rule
 * recognizes.
 */
export function findUrlCredentialSpans(text: OriginalText): PrivateKeySpan[] {
	return findUrlCredentialSpansIn(text);
}

function findUrlCredentialSpansIn(text: string): PrivateKeySpan[] {
	if (!text.includes("://")) return [];
	const spans: PrivateKeySpan[] = [];
	const pattern = new RegExp(URL_CREDENTIAL_SOURCE, "gi");
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		const userinfoStart = match.index + match[1].length + match[2].length;
		// The match ends with the `@` that closes the userinfo; it stays printed.
		const userinfoEnd = match.index + match[0].length - 1;
		if (userinfoEnd > userinfoStart) spans.push({ start: userinfoStart, end: userinfoEnd });
	}
	return spans;
}

/**
 * Locate every credential container in `text` without mutating it.
 * Ranges are the value the scrubber replaces: the opening bracket through its closing bracket, so
 * a caller can keep the assignment that names the container in place. Both passes read `text`
 * itself, so a container is classified from what the source says rather than from output a
 * previous replacement produced. A scan that runs out of lookahead reports the whole text,
 * because a cutoff cannot prove what it kept is safe for a later rule.
 */
export function findCredentialContainerSpans(text: OriginalText): PrivateKeySpan[] {
	return findCredentialContainerSpansIn(text, CURRENT_CREDENTIAL_REDACTION_RULES);
}

function findCredentialContainerSpansIn(text: string, rules: CredentialRedactionRules): PrivateKeySpan[] {
	if (!rules.containerCandidatePattern.test(text) && !rules.camelContainerCandidatePattern.test(text)) return [];
	const { assignment, camel } = containerAssignmentPatterns(rules);
	const spans: PrivateKeySpan[] = [];
	const state: ContainerScanState = { exhausted: false };
	collectCredentialContainerSpans(text, assignment, true, state, spans);
	// The camel pass scans the same original text instead of the generic pass's output. Its key
	// pattern is expensive on a long run of one letter, so it only runs when a camel-shaped key is
	// actually followed by an assignment; without one the container pattern cannot match.
	if (!state.exhausted && rules.camelContainerCandidatePattern.test(text)) {
		collectCredentialContainerSpans(text, camel, true, state, spans);
	}
	if (state.exhausted) return [{ start: 0, end: text.length }];
	spans.sort((left, right) => left.start - right.start || right.end - left.end);
	const merged: PrivateKeySpan[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last !== undefined && span.start < last.end) {
			if (span.end > last.end) merged[merged.length - 1] = { start: last.start, end: span.end };
			continue;
		}
		merged.push(span);
	}
	return merged;
}

function containerAssignmentPatterns(rules: CredentialRedactionRules): { assignment: RegExp; camel: RegExp } {
	return {
		assignment: new RegExp(String.raw`${rules.assignmentPrefix}(?=[\[{])`, "gi"),
		camel: new RegExp(String.raw`${rules.camelAssignmentPrefix}(?=[\[{])`, "g"),
	};
}

function redactCredentialContainersWithPattern(
	text: string,
	assignment: RegExp,
	bounded: boolean,
	state: ContainerScanState,
): string {
	const spans: PrivateKeySpan[] = [];
	collectCredentialContainerSpans(text, assignment, bounded, state, spans);
	return applyContainerSpans(text, spans);
}

/**
 * Collect the value range of every credential container in one forward pass, without mutating the
 * text. `maskedUntil` mirrors the replacement cursor: a match that starts inside a container already
 * found is part of that container and is not scanned again.
 */
function collectCredentialContainerSpans(
	text: string,
	assignment: RegExp,
	bounded: boolean,
	state: ContainerScanState,
	spans: PrivateKeySpan[],
): void {
	const budget = createContainerScanBudget(text.length, bounded);
	const lineScan = createLineEndScan();
	let maskedUntil = 0;
	for (let match = assignment.exec(text); match !== null; match = assignment.exec(text)) {
		const containerStart = assignment.lastIndex;
		if (containerStart < maskedUntil) continue;
		const suffixLength = text.length - containerStart;
		if (budget.remaining < suffixLength) {
			// The remaining lookahead cannot prove where this container ends, and a partial scan
			// could leave a later closed container's contents behind.
			state.exhausted = true;
			return;
		}
		const scan = findCredentialContainerEnd(text, containerStart, suffixLength, lineScan);
		budget.remaining -= scan.scanned;
		const containerEnd = scan.value;
		// `[REDACTED_TOKEN]` from an earlier pass is bracketed but is a placeholder, not a
		// container — only when a field boundary follows, so nothing can trail it unscrubbed.
		const container = text.slice(containerStart, containerEnd);
		if (container.endsWith("]") && REDACTION_PLACEHOLDER_PATTERN.test(container)) {
			if (REDACTION_PLACEHOLDER_BOUNDARY_PATTERN.test(text.slice(containerEnd))) {
				assignment.lastIndex = containerEnd;
				continue;
			}
			// A placeholder followed immediately by more value text is only the first fragment of
			// the assigned value. Mask the whole value up to the same delimiter the unquoted rule
			// uses, so the fragment after `]` cannot survive the one application pass.
			let end = containerEnd;
			while (end < text.length && !UNQUOTED_VALUE_DELIMITER_PATTERN.test(text[end])) end++;
			spans.push({ start: containerStart, end });
			maskedUntil = end;
			assignment.lastIndex = end;
			continue;
		}
		spans.push({ start: containerStart, end: containerEnd });
		maskedUntil = containerEnd;
		assignment.lastIndex = containerEnd;
	}
}

/** Replace each credential-container range with the container marker. */
function applyContainerSpans(text: string, spans: readonly PrivateKeySpan[]): string {
	if (spans.length === 0) return text;
	const parts: string[] = [];
	let cursor = 0;
	for (const span of spans) {
		parts.push(text.slice(cursor, span.start), "«redacted»");
		cursor = span.end;
	}
	parts.push(text.slice(cursor));
	return parts.join("");
}

/** Whether a container pass gave up and masked a suffix it could not delimit. */
interface ContainerScanState {
	exhausted: boolean;
}

type EscapedQuoteDelimiter = { delimiter: "'" | '"' | "`"; backslashCount: number };

interface BoundedScan<T> {
	readonly value: T;
	/** Characters this call examined; charged against the caller's scan budget. */
	readonly scanned: number;
}

/** One terminator's cached search state, advanced forward within a pass. */
interface TerminatorSearch {
	/** Next occurrence found by the last search, or -1 for none at or after `searchedFrom`. */
	next: number;
	/** Position the last search started from, or -1 before the first search. */
	searchedFrom: number;
}

/**
 * Forward-only line-end lookup shared by one container pass.
 * Each terminator search resumes where the previous one stopped, so every character is
 * examined at most once per pass no matter how many containers ask for their line.
 */
interface LineEndScan {
	readonly lineFeed: TerminatorSearch;
	readonly carriageReturn: TerminatorSearch;
	/** Position the next lookup starts from. */
	from: number;
	/** Line end found for the last request, or -1 before the first request. */
	end: number;
}

function createLineEndScan(): LineEndScan {
	return {
		lineFeed: { next: -1, searchedFrom: -1 },
		carriageReturn: { next: -1, searchedFrom: -1 },
		from: 0,
		end: -1,
	};
}

function nextTerminator(text: string, terminator: string, search: TerminatorSearch, from: number): number {
	if (search.searchedFrom >= 0) {
		if (search.next >= from) return search.next;
		if (search.next < 0) return -1;
	}
	search.searchedFrom = from;
	search.next = text.indexOf(terminator, from);
	return search.next;
}

function currentLineEnd(text: string, start: number, scan: LineEndScan): number {
	if (scan.end >= start) return scan.end;
	const from = Math.max(scan.from, start);
	// Both terminators count, as they always have.
	const lineFeed = nextTerminator(text, "\n", scan.lineFeed, from);
	const carriageReturn = nextTerminator(text, "\r", scan.carriageReturn, from);
	const terminator =
		lineFeed < 0 ? carriageReturn : carriageReturn < 0 ? lineFeed : Math.min(lineFeed, carriageReturn);
	scan.end = terminator >= 0 ? terminator : text.length;
	scan.from = scan.end + 1;
	return scan.end;
}

/**
 * End of the container that opens at `start`.
 * The scan never looks past `start + lookahead`; a container that has not closed
 * there ends at its line, which is also where an unterminated container ends.
 */
function findCredentialContainerEnd(
	text: string,
	start: number,
	lookahead: number,
	lineScan: LineEndScan,
): BoundedScan<number> {
	const limit = Math.min(text.length, start + lookahead);
	// An unterminated container always consumes at least its opening character so the
	// caller's scan position strictly advances.
	const unclosedEnd = Math.max(Math.min(currentLineEnd(text, start, lineScan), limit), start + 1);
	const delimiterScan = findEscapedQuoteDelimiter(text, start, limit);
	const escapedQuoteDelimiter = delimiterScan.value;
	const closing = [text[start] === "[" ? "]" : "}"];
	let quote: "'" | '"' | "`" | undefined;
	for (let index = start + 1; index < limit; index++) {
		const character = text[index] ?? "";
		if (character === "\\") {
			let backslashEnd = index;
			while (backslashEnd + 1 < limit && text[backslashEnd + 1] === "\\") backslashEnd++;
			const backslashCount = backslashEnd - index + 1;
			const nextCharacter = text[backslashEnd + 1];
			// The opening escape run identifies this serialization layer; matching runs delimit strings.
			if (
				escapedQuoteDelimiter !== undefined &&
				nextCharacter === escapedQuoteDelimiter.delimiter &&
				backslashCount === escapedQuoteDelimiter.backslashCount
			) {
				if (quote === undefined) quote = escapedQuoteDelimiter.delimiter;
				else if (quote === escapedQuoteDelimiter.delimiter) quote = undefined;
				index = backslashEnd + 1;
				continue;
			}
			index = nextCharacter !== undefined && backslashCount % 2 === 1 ? backslashEnd + 1 : backslashEnd;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if ((character === '"' || character === "'" || character === "`") && opensQuotedValue(text, index, start)) {
			quote = character;
			continue;
		}
		if (character === "[") closing.push("]");
		else if (character === "{") closing.push("}");
		else if (character === closing[closing.length - 1]) {
			closing.pop();
			if (closing.length === 0) {
				return { value: index + 1, scanned: delimiterScan.scanned + (index + 1 - start) };
			}
		}
	}
	return { value: unclosedEnd, scanned: delimiterScan.scanned + (limit - start) };
}

function findEscapedQuoteDelimiter(
	text: string,
	start: number,
	limit: number,
): BoundedScan<EscapedQuoteDelimiter | undefined> {
	const closing = [text[start] === "[" ? "]" : "}"];
	for (let index = start + 1; index < limit; index++) {
		const character = text[index] ?? "";
		if (character === "\\") {
			let backslashEnd = index;
			while (backslashEnd + 1 < limit && text[backslashEnd + 1] === "\\") backslashEnd++;
			const backslashCount = backslashEnd - index + 1;
			const nextCharacter = text[backslashEnd + 1];
			if ((nextCharacter === '"' || nextCharacter === "'" || nextCharacter === "`") && backslashCount % 2 === 1) {
				return { value: { delimiter: nextCharacter, backslashCount }, scanned: index + 1 - start };
			}
			index = nextCharacter !== undefined && backslashCount % 2 === 1 ? backslashEnd + 1 : backslashEnd;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			return { value: undefined, scanned: index + 1 - start };
		}
		if (character === "[") closing.push("]");
		else if (character === "{") closing.push("}");
		else if (character === closing[closing.length - 1]) {
			closing.pop();
			if (closing.length === 0) return { value: undefined, scanned: index + 1 - start };
		}
	}
	return { value: undefined, scanned: limit - start };
}

/** Every placeholder `redactCrashSecrets` can emit. Used by downstream normalizers. */
export const CRASH_REDACTION_MARKERS: readonly string[] = [
	"«redacted-auth»",
	"«redacted-jwt»",
	"«redacted-api-key»",
	"«redacted-github-token»",
	"«redacted-slack-token»",
	"«redacted-npm-token»",
	"«redacted-gitlab-token»",
	"«redacted-aws-key»",
	"«redacted-private-key»",
	"«redacted-google-api-key»",
	"«redacted-url-credential»",
	"«redacted»",
];
