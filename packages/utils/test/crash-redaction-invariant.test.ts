import { describe, expect, it } from "bun:test";
import {
	applyRedactions,
	asOriginalText,
	type MaskedCrashText,
	maskStructureBlind,
	maskStructured,
	type RedactionRange,
} from "../src/crash-redaction";

/**
 * One declared corpus for the masking invariant. A fixture added here is checked by every
 * assertion below; `secret` entries are the ones whose output the structure-aware path must cover
 * at least as well as the structure-blind path, `plain` entries must come out untouched.
 */
interface CorpusEntry {
	readonly name: string;
	readonly text: string;
	readonly secret: boolean;
}

const PEM_BODY = `-----BEGIN RSA PRIVATE KEY-----
PEM_BODY_SENTINEL
${"A".repeat(64)}
-----END RSA PRIVATE KEY-----`;

const OVERSIZED_JSON_PEM = `{"detail":"-----BEGIN RSA PRIVATE KEY-----\\nPEM_BODY_SENTINEL\\n${"A".repeat(4100)}\\n-----END RSA PRIVATE KEY-----"}`;

// Built from parts so the repository never stores a Slack-token-shaped literal; the fixture
// still exercises a token-shaped value against the masker.
const SLACK_TOKEN = ["xoxb", "123456789012", "abcdefghijklmn"].join("-");

export const REDACTION_CORPUS: readonly CorpusEntry[] = [
	// This round's leaks: auth continuations, wrapped URIs, container bounds and comments.
	{ name: "auth continuation with token68 padding", text: "Basic\nZml4dHVyZTpwYXNzd29yZA==", secret: true },
	{ name: "auth continuation with bare token", text: "bearer\nabcdefghijopaquevalue", secret: true },
	{
		name: "auth continuation across an escaped newline",
		text: '{"code":"bearer\\nopaquecredential123"}',
		secret: true,
	},
	{
		name: "auth continuation with URI on the next line",
		text: "Token\npostgresql+asyncpg://app:synthetic@db.example.com/db",
		secret: true,
	},
	{ name: "wrapped URI after an auth cue", text: "Token\n_https://app:synthetic@db.example.com/db_", secret: true },
	{
		name: "plain-scalar apostrophe inside a container",
		text: `wrapper: [don't, "ordinary\n  secret: |\n    continuation"]\n    # keep-me\npublic: visible`,
		secret: false,
	},
	{
		name: "quoted container key",
		text: `"wrapper": ["ordinary\n  secret: |\n    continuation"]\n    # keep-me\npublic: visible`,
		secret: false,
	},
	{
		name: "comment line shaped like a container",
		text: `# wrapper: ["ignored\nsecret: |\n  SYNTHETIC_PASSWORD\npublic: 'text"]`,
		secret: true,
	},
	{
		name: "lower-case authorization with a trailing diagnostic",
		text: "Authorization: bearer opaquecredential123 diagnostic=keep",
		secret: true,
	},
	{
		name: "URL credential beyond the preview cap",
		text: `${"x".repeat(4030)} https://app:SYNTHETIC_PASSWORD${"a".repeat(40)}@db.example.com/db`,
		secret: true,
	},
	{ name: "oversized serialized PEM object", text: OVERSIZED_JSON_PEM, secret: true },

	// Existing redaction fixtures for these paths.
	{
		name: "authorization bearer header",
		text: "Authorization: Bearer abcdef0123456789abcdef0123456789",
		secret: true,
	},
	{ name: "bearer header", text: "Authorization: Bearer sk-abcdef0123456789abcdef", secret: true },
	{
		name: "jwt",
		text: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		secret: true,
	},
	{ name: "github classic token", text: "token ghp_abcdef0123456789abcdef0123", secret: true },
	{
		name: "github fine-grained token",
		text: "token github_pat_11ABCDEFG0hijklmnopq_RSTUVWXYZ0123456789abcdefghijklmnopqr",
		secret: true,
	},
	{ name: "slack token", text: SLACK_TOKEN, secret: true },
	{ name: "npm token", text: "npm_abcdefghijklmnopqrstuvwxyz0123456789", secret: true },
	{ name: "gitlab token", text: "glpat-abcdefghijklmnopqrstuvwxyz0123", secret: true },
	{ name: "stripe live key", text: "sk_live_abcdefghijklmnop012345", secret: true },
	{ name: "huggingface token", text: "hf_abcdefghijklmnopqrstuvwxyz", secret: true },
	{ name: "google api key", text: "AIzaSyA1234567890abcdefghijklmnopqrstuv", secret: true },
	{ name: "aws key id", text: "ASIA1234567890ABCDEF", secret: true },
	{ name: "bare aws secret", text: `${"A".repeat(20)}/${"B".repeat(19)}`, secret: true },
	{
		name: "labeled secrets with a surviving diagnostic",
		text: "password=opaque-one token=opaque-two note=keep",
		secret: true,
	},
	{ name: "json refresh token", text: '{"refresh_token": "rt-abcdef0123456789", "note": "keep"}', secret: true },
	{ name: "quoted password with digits", text: 'password="hunter2secret" note=keep', secret: true },
	{
		name: "cookie value with a trailing diagnostic",
		text: "Cookie: session=opaque-session-cookie; theme=dark diagnostic=keep",
		secret: true,
	},
	{ name: "url userinfo", text: "fetch https://user:pass@db.example.com/v1/items failed", secret: true },
	{ name: "wrapped url userinfo", text: "see https://app:synthetic@db.example.com/db/path.", secret: true },
	{ name: "complete pem block", text: PEM_BODY, secret: true },
	{
		name: "pem block inside url userinfo",
		text: "https://db.example.com(-----BEGIN RSA PRIVATE KEY-----\nBODY\n-----END RSA PRIVATE KEY-----)@note",
		secret: true,
	},
	{ name: "credential container", text: 'secret={"password":"opaque-password","note":"keep"}', secret: true },
	{
		name: "header collection",
		text: 'headers={"Authorization":"Bearer opaque-token","accept":"application/json"}',
		secret: true,
	},
	{
		name: "yaml block scalars",
		text: [
			"password: |",
			"  opaque-literal-secret-123",
			"  note: keep",
			"note=keep",
			"password: >-",
			"  opaque-folded-secret-456",
			"note=keep",
		].join("\n"),
		secret: true,
	},
	{
		name: "yaml block scalar inside a credential container",
		text: 'private_key: ["ordinary\n  secret: |\n    continuation"]\n    # keep-me\npublic: visible',
		secret: true,
	},
	{
		name: "indented yaml block scalar in a sequence",
		text: ["- password: |", "    opaque-sequence-literal-secret", "  note: keep after sequence"].join("\n"),
		secret: true,
	},

	// Plain documents: nothing may be deleted.
	{
		name: "ordinary prose",
		text: "The request failed after three retries; the host stayed reachable.",
		secret: false,
	},
	{
		name: "stack frame lines",
		text: ["Error: boom while streaming", "    at keptFrame (app.ts:4:2)", "    at alsoKept (app.ts:5:1)"].join("\n"),
		secret: false,
	},
	{
		name: "apostrophe in plain yaml",
		text: "note: don't panic\npath: /srv/o'brien/data\nlist: ['a', \"b\"]",
		secret: false,
	},
	{
		name: "quoted yaml mapping",
		text: '"title": "it\'s fine"\n"count": 3\n"nested": {"a": [1, 2, 3]}',
		secret: false,
	},
	{ name: "url without credentials", text: "GET https://db.example.com/v1/items?limit=3 returned 200", secret: false },
	{ name: "json with an escaped newline", text: '{"note":"first\\nsecond","count":2}', secret: false },
	{
		name: "bracketed ordinary data",
		text: 'wrapper: [alpha, beta, "gamma delta"]\n# note\npublic: visible',
		secret: false,
	},
	{
		name: "ordinary quoted container with a fake header",
		text: 'wrapper: ["ordinary\n  secret: |\n    continuation"]\n    # keep-me\npublic: visible',
		secret: false,
	},
	{ name: "bare auth cue before a diagnostic", text: "Token\ndiagnostics: keep-me", secret: false },
	{
		name: "long non-secret field beyond the preview cap",
		text: `diagnostic: ${"a plain sentence with spaces. ".repeat(300)}`,
		secret: false,
	},
];

function maskContained(outer: RedactionRange, inner: RedactionRange): boolean {
	return outer.start <= inner.start && outer.end >= inner.end;
}

/**
 * The invariant itself. `mask_structured` must still mask every span `mask_structure_blind`
 * masks: a structure guard may add confidence, never remove a detected credential.
 */
function expectMaskingMonotonicity(entry: CorpusEntry, structured: MaskedCrashText, blind: MaskedCrashText): void {
	for (const mask of blind.masks) {
		const covered = structured.masks.some(outer => maskContained(outer, mask));
		if (covered) continue;
		const suppressed = JSON.stringify(entry.text.slice(mask.start, mask.end));
		throw new Error(`suppressed mask ${suppressed} (${mask.label}) in input ${JSON.stringify(entry.text)}`);
	}
}

describe("crash redaction masking invariant", () => {
	it("holds for the whole corpus: structured covers blind, and plain text survives", () => {
		const failures: string[] = [];
		for (const entry of REDACTION_CORPUS) {
			const structured = maskStructured(entry.text);
			const blind = maskStructureBlind(entry.text);
			if (entry.secret) {
				try {
					expectMaskingMonotonicity(entry, structured, blind);
				} catch (error) {
					failures.push(`${entry.name}: ${(error as Error).message}`);
				}
				// A corpus fixture that masks nothing would make the containment check vacuous.
				if (structured.masks.length === 0) failures.push(`${entry.name}: secret fixture was not masked`);
				continue;
			}
			if (structured.masks.length > 0 || structured.text !== entry.text) {
				failures.push(`${entry.name}: plain text changed to ${JSON.stringify(structured.text)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("reports a deliberately suppressed mask, so the property discriminates", () => {
		const entry = REDACTION_CORPUS.find(candidate => candidate.name === "auth continuation with token68 padding");
		if (entry === undefined) throw new Error("corpus fixture missing");
		const structured = maskStructured(entry.text);
		const blind = maskStructureBlind(entry.text);
		expect(structured.masks.length).toBeGreaterThan(0);
		const suppressed: MaskedCrashText = { text: structured.text, masks: structured.masks.slice(1) };
		expect(() => expectMaskingMonotonicity(entry, suppressed, blind)).toThrow(/suppressed mask/);
	});

	it("reports the comment-line suppression the pre-fix structure gate produced", () => {
		const entry = REDACTION_CORPUS.find(candidate => candidate.name === "comment line shaped like a container");
		if (entry === undefined) throw new Error("corpus fixture missing");
		// The pre-fix structure-aware path let a comment-shaped container open and found no mask.
		const preFix: MaskedCrashText = { text: applyRedactions(asOriginalText(entry.text), []), masks: [] };
		expect(() => expectMaskingMonotonicity(entry, preFix, maskStructureBlind(entry.text))).toThrow(
			/suppressed mask "SYNTHETIC_PASSWORD"/,
		);
	});
});
