/**
 * Best-effort credential scrubbing for durable crash records.
 *
 * This is a *persistence-time* scrub: it keeps obvious credential shapes out of
 * a file GJC keeps indefinitely. It is explicitly NOT a privacy guarantee and
 * must never be treated as one for data that leaves the machine — outbound
 * text goes through `sanitizeExternalCrashV1` instead.
 */

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
	readonly authValuePattern: RegExp;
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
		assignmentCandidatePattern: new RegExp(String.raw`(?:${keyLabels})(?:\\*["'\x60]?\s*[=:]\s*)`, "i"),
		containerCandidatePattern: new RegExp(String.raw`(?:${keyLabels})(?:\\*["'\x60]?\s*[=:]\s*[\[{])`, "i"),
		camelAssignmentCandidatePattern: new RegExp(
			String.raw`(?:${CREDENTIAL_CAMEL_COMPOUND_SUFFIXES}|${camelSimpleSuffixes})(?:\\*["'\x60]?\s*[=:]\s*)`,
		),
		authValuePattern: new RegExp(
			String.raw`${assignmentPrefix}(?:Bearer|Basic|Token)\s+${unquotedValuePatternBody}`,
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

function redactYamlBlockScalars(text: string, rules: CredentialRedactionRules): string {
	const output: string[] = [];
	let copiedUntil = 0;
	let lineStart = 0;

	while (lineStart < text.length) {
		const { contentEnd, nextLineStart } = lineBounds(text, lineStart);
		const header = parseCredentialYamlBlockScalarHeader(text.slice(lineStart, contentEnd), rules);
		if (header === undefined) {
			lineStart = nextLineStart;
			continue;
		}

		output.push(text.slice(copiedUntil, nextLineStart));
		let bodyLineStart = nextLineStart;
		let copiedBodyUntil = bodyLineStart;
		while (bodyLineStart < text.length) {
			const bodyLine = lineBounds(text, bodyLineStart);
			let indentation = 0;
			while (
				bodyLineStart + indentation < bodyLine.contentEnd &&
				(text[bodyLineStart + indentation] === " " || text[bodyLineStart + indentation] === "\t")
			) {
				indentation++;
			}

			if (bodyLineStart + indentation === bodyLine.contentEnd) {
				bodyLineStart = bodyLine.nextLineStart;
				continue;
			}
			if (indentation <= header.indentation) break;

			output.push(text.slice(copiedBodyUntil, bodyLineStart));
			let bodyTextEnd = bodyLine.contentEnd;
			while (
				bodyTextEnd > bodyLineStart + indentation &&
				(text[bodyTextEnd - 1] === " " || text[bodyTextEnd - 1] === "\t")
			) {
				bodyTextEnd--;
			}
			output.push(
				text.slice(bodyLineStart, bodyLineStart + indentation),
				"«redacted»",
				text.slice(bodyTextEnd, bodyLine.nextLineStart),
			);
			copiedBodyUntil = bodyLine.nextLineStart;
			bodyLineStart = bodyLine.nextLineStart;
		}

		output.push(text.slice(copiedBodyUntil, bodyLineStart));
		copiedUntil = bodyLineStart;
		lineStart = bodyLineStart;
	}

	return copiedUntil === 0 ? text : output.join("") + text.slice(copiedUntil);
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

/**
 * Scrub credential material from crash text before it is persisted.
 * Covers bearer/basic-style headers, key=value or JSON key forms of common
 * credential names, and well-known vendor token shapes. Normal messages and
 * stack frames are untouched; matches are replaced in place so surrounding
 * diagnostic context survives.
 */
export function redactCrashSecrets(text: string): string {
	return redactCrashSecretsWithRules(text, CURRENT_CREDENTIAL_REDACTION_RULES);
}

/** Historical redaction rules used only to validate v1 crash fingerprints. */
export function redactCrashSecretsV1(text: string): string {
	return redactCrashSecretsWithRules(text, V1_CREDENTIAL_REDACTION_RULES);
}

function redactCrashSecretsWithRules(text: string, rules: CredentialRedactionRules): string {
	let redacted = redactCredentialContainers(text, rules);
	// Block scalar bodies span lines and must be masked before line-bounded rules handle the header.
	redacted = redactYamlBlockScalars(redacted, rules);
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
	redacted = redacted.replace(
		/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
		"«redacted-private-key»",
	);
	// Google API keys are a fixed 39-character shape that carries no label of its
	// own, so the labeled-value rule below never sees one.
	redacted = redacted.replace(
		/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
		"«redacted-google-api-key»",
	);
	// Basic-auth credentials embedded in a URL. Scheme and host stay readable
	// because they are the diagnostic value; only the userinfo is dropped. The
	// boundary is consumed so the unbounded scheme scan starts only at the start
	// of a scheme-character run, avoiding quadratic retries while accepting long
	// standards-compliant schemes. The greedy authority scan consumes raw `@`
	// characters in userinfo through its delimiter.
	redacted = redacted.replace(
		/(^|[^A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi,
		"$1$2«redacted-url-credential»@",
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

function redactCredentialContainers(text: string, rules: CredentialRedactionRules): string {
	if (!rules.containerCandidatePattern.test(text)) return text;
	const assignment = new RegExp(String.raw`${rules.assignmentPrefix}(?=[\[{])`, "gi");
	const camelAssignment = new RegExp(String.raw`${rules.camelAssignmentPrefix}(?=[\[{])`, "g");
	return redactCredentialContainersWithPattern(
		redactCredentialContainersWithPattern(text, assignment),
		camelAssignment,
	);
}

function redactCredentialContainersWithPattern(text: string, assignment: RegExp): string {
	let output = "";
	let copiedUntil = 0;
	for (let match = assignment.exec(text); match !== null; match = assignment.exec(text)) {
		const containerStart = assignment.lastIndex;
		if (containerStart < copiedUntil) continue;
		const containerEnd = findCredentialContainerEnd(text, containerStart);
		// `[REDACTED_TOKEN]` from an earlier pass is bracketed but is a placeholder, not a
		// container — only when a field boundary follows, so nothing can trail it unscrubbed.
		const container = text.slice(containerStart, containerEnd);
		if (
			container.endsWith("]") &&
			REDACTION_PLACEHOLDER_PATTERN.test(container) &&
			REDACTION_PLACEHOLDER_BOUNDARY_PATTERN.test(text.slice(containerEnd))
		) {
			assignment.lastIndex = containerEnd;
			continue;
		}
		output += `${text.slice(copiedUntil, containerStart)}«redacted»`;
		copiedUntil = containerEnd;
		assignment.lastIndex = containerEnd;
	}
	return copiedUntil === 0 ? text : output + text.slice(copiedUntil);
}

type EscapedQuoteDelimiter = { delimiter: "'" | '"' | "`"; backslashCount: number };

function findCredentialContainerEnd(text: string, start: number): number {
	const closing = [text[start] === "[" ? "]" : "}"];
	const escapedQuoteDelimiter = findEscapedQuoteDelimiter(text, start);
	const lineFeedIndex = text.indexOf("\n", start);
	const carriageReturnIndex = text.indexOf("\r", start);
	const unclosedEnd =
		lineFeedIndex < 0
			? carriageReturnIndex < 0
				? text.length
				: carriageReturnIndex
			: carriageReturnIndex < 0
				? lineFeedIndex
				: Math.min(lineFeedIndex, carriageReturnIndex);
	let quote: "'" | '"' | "`" | undefined;
	for (let index = start + 1; index < text.length; index++) {
		const character = text[index] ?? "";
		if (character === "\\") {
			let backslashEnd = index;
			while (text[backslashEnd + 1] === "\\") backslashEnd++;
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
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "[") closing.push("]");
		else if (character === "{") closing.push("}");
		else if (character === closing[closing.length - 1]) {
			closing.pop();
			if (closing.length === 0) return index + 1;
		}
	}
	return unclosedEnd;
}

function findEscapedQuoteDelimiter(text: string, start: number): EscapedQuoteDelimiter | undefined {
	const closing = [text[start] === "[" ? "]" : "}"];
	for (let index = start + 1; index < text.length; index++) {
		const character = text[index] ?? "";
		if (character === "\\") {
			let backslashEnd = index;
			while (text[backslashEnd + 1] === "\\") backslashEnd++;
			const backslashCount = backslashEnd - index + 1;
			const nextCharacter = text[backslashEnd + 1];
			if ((nextCharacter === '"' || nextCharacter === "'" || nextCharacter === "`") && backslashCount % 2 === 1) {
				return { delimiter: nextCharacter, backslashCount };
			}
			index = nextCharacter !== undefined && backslashCount % 2 === 1 ? backslashEnd + 1 : backslashEnd;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") return undefined;
		if (character === "[") closing.push("]");
		else if (character === "{") closing.push("}");
		else if (character === closing[closing.length - 1]) {
			closing.pop();
			if (closing.length === 0) return undefined;
		}
	}
	return undefined;
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
