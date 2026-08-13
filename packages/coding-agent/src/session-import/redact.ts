/**
 * Fail-closed secret redaction for imported session content (issue #3709).
 *
 * Every string that crosses the import boundary passes through
 * {@link redactImportedText}. Patterns are conservative: a false positive costs
 * one `[REDACTED]` span in reconstructed context, a false negative leaks a
 * credential into a new session transcript, so the balance favors redaction.
 */

export const IMPORT_REDACTED_PLACEHOLDER = "[REDACTED]";
/** Bumped when patterns change; persisted in import provenance. */
export const IMPORT_SANITIZER_VERSION = 1;

interface RedactionRule {
	readonly id: string;
	readonly pattern: RegExp;
}

const HEX = "[0-9a-fA-F]";

/**
 * Ordered first-match-wins rules. Each rule replaces its full match with the
 * placeholder, so a matched credential never survives partially.
 */
const REDACTION_RULES: readonly RedactionRule[] = [
	// PEM private-key blocks, header through footer.
	{
		id: "pem-private-key",
		pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
	},
	// AWS access key ids.
	{ id: "aws-access-key", pattern: /(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}/g },
	// GitHub tokens (PAT, OAuth, server-to-server, refresh, fine-grained).
	{ id: "github-token", pattern: /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
	// Anthropic API keys.
	{ id: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
	// OpenAI-style keys (project keys, service accounts, legacy sk-).
	{ id: "openai-key", pattern: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}/g },
	// Slack tokens.
	{ id: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
	// Google API keys.
	{ id: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
	// Bearer tokens carried in Authorization text.
	{
		id: "bearer-token",
		pattern: /(authorization["'\s]*[:=]["'\s]*bearer\s+|bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
	},
	// JWTs (three base64url segments; middle segment non-trivial).
	{
		id: "jwt",
		pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	},
	// Long hex secrets (64+ hex chars: webhook secrets, signing keys).
	{ id: "hex-secret", pattern: new RegExp(`\\b${HEX}{64,}\\b`, "g") },
	// Basic-auth credentials embedded in URLs (https://user:pass@host).
	{ id: "url-credential", pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi },
	// Sensitive env/KEY assignments: OPENAI_API_KEY=..., token: ..., password = ...
	// The name prefix is optional so a bare sensitive name (`password: …`) also matches.
	{
		id: "secret-assignment",
		pattern:
			/\b(?:[A-Za-z_][A-Za-z0-9_]*)?(?:api[_-]?key|secret|token|password|passwd|credential|client[_-]?secret|private[_-]?key|access[_-]?key|refresh[_-]?token|session[_-]?key)[A-Za-z0-9_]*\b(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}&)]{4,})/gi,
	},
];

export interface ImportRedactionResult {
	value: string;
	redacted: number;
	kinds: string[];
}

/**
 * Redact every known credential shape from imported text. The same placeholder
 * is used for all kinds so a partial pattern overlap cannot leak fragments.
 */
export function redactImportedText(input: string): ImportRedactionResult {
	let value = input;
	let redacted = 0;
	const kinds = new Set<string>();
	for (const rule of REDACTION_RULES) {
		rule.pattern.lastIndex = 0;
		value = value.replace(rule.pattern, match => {
			redacted++;
			kinds.add(rule.id);
			if (rule.id === "url-credential") {
				// Keep the scheme visible; the match ends at "@" so the host survives.
				const schemeEnd = match.indexOf("://") + 3;
				return `${match.slice(0, schemeEnd)}${IMPORT_REDACTED_PLACEHOLDER}@`;
			}
			if (rule.id === "secret-assignment") {
				const sep = /(["']?\s*[:=]\s*)/.exec(match);
				if (sep) {
					const head = match.slice(0, (sep.index ?? 0) + sep[0].length);
					return `${head}${IMPORT_REDACTED_PLACEHOLDER}`;
				}
			}
			if (rule.id === "bearer-token") {
				const bearerAt = /bearer\s+/i.exec(match);
				if (bearerAt) return `${match.slice(0, bearerAt.index + bearerAt[0].length)}${IMPORT_REDACTED_PLACEHOLDER}`;
			}
			return IMPORT_REDACTED_PLACEHOLDER;
		});
	}
	return { value, redacted, kinds: [...kinds].sort() };
}

/** Redact a string, returning only the sanitized value. */
export function sanitizeImportedString(input: string): string {
	return redactImportedText(input).value;
}
