import { describe, expect, it } from "bun:test";
import {
	applyRedactions,
	asOriginalText,
	type MaskedCrashText,
	maskFieldPreview,
	maskStructureBlind,
	maskStructured,
	type RedactionRange,
	redactCrashSecrets,
} from "../src/crash-redaction";

/**
 * One declared corpus for the masking invariant. A fixture added here is checked by every
 * assertion below. `secrets` are the literals that must be absent from both outputs; `survives`
 * are the literals that must still be present in both. An entry with no secrets is a plain
 * document: the structure-aware path must return it untouched.
 */
interface CorpusEntry {
	readonly name: string;
	readonly text: string;
	readonly secrets: readonly string[];
	readonly survives: readonly string[];
	/** The case belongs to the captured-field preview path, which also bounds an unpaired body. */
	readonly preview?: boolean;
}

const PEM_BODY = `-----BEGIN RSA PRIVATE KEY-----
PEM_BODY_SENTINEL
${"A".repeat(64)}
-----END RSA PRIVATE KEY-----`;

const OVERSIZED_JSON_PEM = `{"detail":"-----BEGIN RSA PRIVATE KEY-----\\nPEM_BODY_SENTINEL\\n${"A".repeat(4100)}\\n-----END RSA PRIVATE KEY-----"}`;

const COMMENT_CONTAINER = `wrapper: visible # wrapper: ["ignored\nsecret: |\n  SYNTHETIC_PASSWORD\npublic: 'text"]'`;
const B64_CONTINUATION = "Zml4dHVyZTpwYXNzd29yZA==";
const ESCAPED_CONTINUATION = '{message:"fixture", code:{detail:"bearer\\nopaquecredential123\\ndiagnostic=keep"}}';
const UNPAIRED_WITH_SIBLING =
	'{message:"fixture", code:{detail:"-----BEGIN RSA PRIVATE KEY-----\\nBODY", note:"keep-me"}}';
const UNPAIRED_IN_PROSE = '{code:"PEM example: -----BEGIN RSA PRIVATE KEY-----; diagnostic=keep"}';

// Built from parts so the repository never stores a Slack-token-shaped literal; the fixture
// still exercises a token-shaped value against the masker.
const SLACK_TOKEN = ["xoxb", "123456789012", "abcdefghijklmn"].join("-");

export const REDACTION_CORPUS: readonly CorpusEntry[] = [
	// This round's leaks: auth continuations, wrapped URIs, container bounds and comments.
	{
		name: "auth continuation with token68 padding",
		text: `Basic\n${B64_CONTINUATION}`,
		secrets: [B64_CONTINUATION],
		survives: ["Basic"],
	},
	{
		name: "auth continuation with bare token",
		text: "bearer\nabcdefghijopaquevalue",
		secrets: ["abcdefghijopaquevalue"],
		survives: ["bearer"],
	},
	{
		name: "auth continuation across an escaped newline",
		text: '{"code":"bearer\\nopaquecredential123"}',
		secrets: ["opaquecredential123"],
		survives: ['{"code":"bearer\\n', '"}'],
	},
	{
		name: "auth continuation with URI on the next line",
		text: "Token\npostgresql+asyncpg://app:synthetic@db.example.com/db",
		secrets: ["synthetic"],
		survives: ["Token", "postgresql+asyncpg://", "db.example.com/db"],
	},
	{
		name: "wrapped URI after an auth cue",
		text: "Token\n_https://app:synthetic@db.example.com/db_",
		secrets: ["synthetic"],
		survives: ["Token", "_https://", "db.example.com/db_"],
	},
	{
		name: "plain-scalar apostrophe inside a container",
		text: `wrapper: [don't, "ordinary\n  secret: |\n    continuation"]\n    # keep-me\npublic: visible`,
		secrets: [],
		survives: [],
	},
	{
		name: "quoted container key",
		text: `"wrapper": ["ordinary\n  secret: |\n    continuation"]\n    # keep-me\npublic: visible`,
		secrets: [],
		survives: [],
	},
	{
		name: "comment line shaped like a container",
		text: `# wrapper: ["ignored\nsecret: |\n  SYNTHETIC_PASSWORD\npublic: 'text"]`,
		secrets: ["SYNTHETIC_PASSWORD"],
		survives: ["# wrapper:", `public: 'text"]`],
	},
	{
		name: "inline comment shaped like a container",
		text: COMMENT_CONTAINER,
		secrets: ["SYNTHETIC_PASSWORD"],
		survives: ["wrapper: visible", "# wrapper:", `public: 'text"]'`],
	},
	{
		name: "padded continuation token before a diagnostic",
		text: `Basic\n${B64_CONTINUATION} diagnostic=keep`,
		secrets: [B64_CONTINUATION],
		survives: ["Basic", "diagnostic=keep"],
	},
	{
		name: "padded continuation token and an independent password",
		text: `Basic\n${B64_CONTINUATION} diagnostic=keep\npassword=opaque-one`,
		secrets: [B64_CONTINUATION, "opaque-one"],
		survives: ["diagnostic=keep", "password="],
	},
	{
		name: "multi-character wrapped URI after an auth cue",
		text: "Token\n**https://app:synthetic@db.example.com/db**",
		secrets: ["app:synthetic"],
		survives: ["Token", "**https://", "@db.example.com/db**"],
	},
	{
		name: "escaped continuation stops at the next serialized line break",
		text: ESCAPED_CONTINUATION,
		secrets: ["opaquecredential123"],
		survives: ["bearer\\n", "\\ndiagnostic=keep", "code"],
	},
	{
		name: "unpaired private-key body keeps a nested sibling",
		text: UNPAIRED_WITH_SIBLING,
		secrets: ["-----BEGIN RSA PRIVATE KEY-----", "BODY"],
		survives: ['{detail:"', '", note:"keep-me"}'],
		preview: true,
	},
	{
		name: "unpaired private-key banner in prose keeps its suffix",
		text: UNPAIRED_IN_PROSE,
		secrets: ["-----BEGIN RSA PRIVATE KEY-----"],
		survives: ["PEM example:", "; diagnostic=keep"],
		preview: true,
	},
	{
		name: "lower-case authorization with a trailing diagnostic",
		text: "Authorization: bearer opaquecredential123 diagnostic=keep",
		secrets: ["opaquecredential123"],
		survives: ["Authorization:", "diagnostic=keep"],
	},
	{
		name: "URL credential beyond the preview cap",
		text: `${"x".repeat(4030)} https://app:SYNTHETIC_PASSWORD${"a".repeat(40)}@db.example.com/db`,
		secrets: ["SYNTHETIC_PASSWORD"],
		survives: ["https://", "db.example.com/db"],
	},
	{
		name: "oversized serialized PEM object",
		text: OVERSIZED_JSON_PEM,
		secrets: ["PEM_BODY_SENTINEL"],
		survives: ['{"detail":"', '"}'],
	},

	// Existing redaction fixtures for these paths.
	{
		name: "authorization bearer header",
		text: "Authorization: Bearer abcdef0123456789abcdef0123456789",
		secrets: ["abcdef0123456789abcdef0123456789"],
		survives: ["Authorization:"],
	},
	{
		name: "bearer header",
		text: "Authorization: Bearer sk-abcdef0123456789abcdef",
		secrets: ["sk-abcdef0123456789abcdef"],
		survives: ["Authorization:"],
	},
	{
		name: "jwt",
		text: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		secrets: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
		survives: ["jwt "],
	},
	{
		name: "github classic token",
		text: "token ghp_abcdef0123456789abcdef0123",
		secrets: ["ghp_abcdef0123456789abcdef0123"],
		survives: [],
	},
	{
		name: "github fine-grained token",
		text: "token github_pat_11ABCDEFG0hijklmnopq_RSTUVWXYZ0123456789abcdefghijklmnopqr",
		secrets: ["github_pat_11ABCDEFG0hijklmnopq_RSTUVWXYZ0123456789abcdefghijklmnopqr"],
		survives: [],
	},
	{
		name: "slack token",
		text: SLACK_TOKEN,
		secrets: [SLACK_TOKEN],
		survives: [],
	},
	{
		name: "npm token",
		text: "npm_abcdefghijklmnopqrstuvwxyz0123456789",
		secrets: ["npm_abcdefghijklmnopqrstuvwxyz0123456789"],
		survives: [],
	},
	{
		name: "gitlab token",
		text: "glpat-abcdefghijklmnopqrstuvwxyz0123",
		secrets: ["glpat-abcdefghijklmnopqrstuvwxyz0123"],
		survives: [],
	},
	{
		name: "stripe live key",
		text: "sk_live_abcdefghijklmnop012345",
		secrets: ["sk_live_abcdefghijklmnop012345"],
		survives: [],
	},
	{
		name: "huggingface token",
		text: "hf_abcdefghijklmnopqrstuvwxyz",
		secrets: ["hf_abcdefghijklmnopqrstuvwxyz"],
		survives: [],
	},
	{
		name: "google api key",
		text: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
		secrets: ["AIzaSyA1234567890abcdefghijklmnopqrstuv"],
		survives: [],
	},
	{ name: "aws key id", text: "ASIA1234567890ABCDEF", secrets: ["ASIA1234567890ABCDEF"], survives: [] },
	{
		name: "bare aws secret",
		text: `${"A".repeat(20)}/${"B".repeat(19)}`,
		secrets: [`${"A".repeat(20)}/${"B".repeat(19)}`],
		survives: [],
	},
	{
		name: "labeled secrets with a surviving diagnostic",
		text: "password=opaque-one token=opaque-two note=keep",
		secrets: ["opaque-one", "opaque-two"],
		survives: ["note=keep"],
	},
	{
		name: "json refresh token",
		text: '{"refresh_token": "rt-abcdef0123456789", "note": "keep"}',
		secrets: ["rt-abcdef0123456789"],
		survives: ['"note": "keep"'],
	},
	{
		name: "quoted password with digits",
		text: 'password="hunter2secret" note=keep',
		secrets: ["hunter2secret"],
		survives: ["note=keep"],
	},
	{
		name: "cookie value with a trailing diagnostic",
		text: "Cookie: session=opaque-session-cookie; theme=dark diagnostic=keep",
		secrets: ["opaque-session-cookie"],
		survives: ["diagnostic=keep"],
	},
	{
		name: "url userinfo",
		text: "fetch https://user:pass@db.example.com/v1/items failed",
		secrets: ["pass"],
		survives: ["fetch https://", "db.example.com/v1/items", "failed"],
	},
	{
		name: "wrapped url userinfo",
		text: "see https://app:synthetic@db.example.com/db/path.",
		secrets: ["synthetic"],
		survives: ["see https://", "db.example.com/db/path."],
	},
	{ name: "complete pem block", text: PEM_BODY, secrets: ["PEM_BODY_SENTINEL"], survives: [] },
	{
		name: "pem block inside url userinfo",
		text: "https://db.example.com(-----BEGIN RSA PRIVATE KEY-----\nBODY\n-----END RSA PRIVATE KEY-----)@note",
		secrets: ["BODY", "-----BEGIN RSA PRIVATE KEY-----"],
		survives: ["https://db.example.com(", ")@note"],
	},
	{
		name: "credential container",
		text: 'secret={"password":"opaque-password","note":"keep"}',
		secrets: ["opaque-password"],
		survives: ["secret="],
	},
	{
		name: "header collection",
		text: 'headers={"Authorization":"Bearer opaque-token","accept":"application/json"}',
		secrets: ["opaque-token"],
		survives: ["headers="],
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
		secrets: ["opaque-literal-secret-123", "opaque-folded-secret-456"],
		survives: ["password: |", "note=keep"],
	},
	{
		name: "yaml block scalar inside a credential container",
		text: 'private_key: ["ordinary\n  secret: |\n    continuation"]\n    # keep-me\npublic: visible',
		secrets: ["continuation"],
		survives: ["private_key:", "# keep-me", "public: visible"],
	},
	{
		name: "indented yaml block scalar in a sequence",
		text: ["- password: |", "    opaque-sequence-literal-secret", "  note: keep after sequence"].join("\n"),
		secrets: ["opaque-sequence-literal-secret"],
		survives: ["- password: |", "note: keep after sequence"],
	},

	// Plain documents: nothing may be deleted.
	{
		name: "ordinary prose",
		text: "The request failed after three retries; the host stayed reachable.",
		secrets: [],
		survives: [],
	},
	{
		name: "stack frame lines",
		text: ["Error: boom while streaming", "    at keptFrame (app.ts:4:2)", "    at alsoKept (app.ts:5:1)"].join("\n"),
		secrets: [],
		survives: [],
	},
	{
		name: "apostrophe in plain yaml",
		text: "note: don't panic\npath: /srv/o'brien/data\nlist: ['a', \"b\"]",
		secrets: [],
		survives: [],
	},
	{
		name: "quoted yaml mapping",
		text: '"title": "it\'s fine"\n"count": 3\n"nested": {"a": [1, 2, 3]}',
		secrets: [],
		survives: [],
	},
	{
		name: "url without credentials",
		text: "GET https://db.example.com/v1/items?limit=3 returned 200",
		secrets: [],
		survives: [],
	},
	{ name: "json with an escaped newline", text: '{"note":"first\\nsecond","count":2}', secrets: [], survives: [] },
	{
		name: "bracketed ordinary data",
		text: 'wrapper: [alpha, beta, "gamma delta"]\n# note\npublic: visible',
		secrets: [],
		survives: [],
	},
	{
		name: "ordinary quoted container with a fake header",
		text: 'wrapper: ["ordinary\n  secret: |\n    continuation"]\n    # keep-me\npublic: visible',
		secrets: [],
		survives: [],
	},
	{ name: "bare auth cue before a diagnostic", text: "Token\ndiagnostics: keep-me", secrets: [], survives: [] },
	{
		name: "long non-secret field beyond the preview cap",
		text: `diagnostic: ${"a plain sentence with spaces. ".repeat(300)}`,
		secrets: [],
		survives: [],
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

/**
 * Ground truth for both paths. A shared guard can hide a secret from both paths at once, so the
 * containment check alone is not enough: the declared secret literals must be absent and the
 * declared must-survive literals present in each output.
 */
function expectGroundTruth(entry: CorpusEntry, structured: MaskedCrashText, blind: MaskedCrashText): void {
	for (const secret of entry.secrets) {
		if (structured.text.includes(secret))
			throw new Error(`structured kept secret ${JSON.stringify(secret)} in ${JSON.stringify(entry.text)}`);
		if (blind.text.includes(secret))
			throw new Error(`blind kept secret ${JSON.stringify(secret)} in ${JSON.stringify(entry.text)}`);
	}
	for (const literal of entry.survives) {
		if (!structured.text.includes(literal))
			throw new Error(`structured dropped ${JSON.stringify(literal)} from ${JSON.stringify(entry.text)}`);
		if (!blind.text.includes(literal))
			throw new Error(`blind dropped ${JSON.stringify(literal)} from ${JSON.stringify(entry.text)}`);
	}
}

describe("crash redaction masking invariant", () => {
	it("holds for the whole corpus: both paths satisfy ground truth, and plain text survives", () => {
		const failures: string[] = [];
		for (const entry of REDACTION_CORPUS) {
			const structured = entry.preview ? maskFieldPreview(entry.text, "structured") : maskStructured(entry.text);
			const blind = entry.preview ? maskFieldPreview(entry.text, "blind") : maskStructureBlind(entry.text);
			if (entry.secrets.length > 0) {
				try {
					expectGroundTruth(entry, structured, blind);
				} catch (error) {
					failures.push(`${entry.name}: ${(error as Error).message}`);
				}
				try {
					expectMaskingMonotonicity(entry, structured, blind);
				} catch (error) {
					failures.push(`${entry.name}: ${(error as Error).message}`);
				}
				continue;
			}
			if (structured.masks.length > 0 || structured.text !== entry.text) {
				failures.push(`${entry.name}: plain text changed to ${JSON.stringify(structured.text)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("reports a deliberately suppressed mask, so the containment property discriminates", () => {
		const entry = REDACTION_CORPUS.find(candidate => candidate.name === "auth continuation with token68 padding");
		if (entry === undefined) throw new Error("corpus fixture missing");
		const structured = maskStructured(entry.text);
		const blind = maskStructureBlind(entry.text);
		expect(structured.masks.length).toBeGreaterThan(0);
		const suppressed: MaskedCrashText = { text: structured.text, masks: structured.masks.slice(1) };
		expect(() => expectMaskingMonotonicity(entry, suppressed, blind)).toThrow(/suppressed mask/);
	});

	it("reports a deliberate ground-truth failure, so the secret check discriminates", () => {
		const entry: CorpusEntry = {
			name: "negative control",
			text: "the literal SYNTHETIC_UNDETECTED_SECRET stays",
			secrets: ["SYNTHETIC_UNDETECTED_SECRET"],
			survives: [],
		};
		const structured = maskStructured(entry.text);
		const blind = maskStructureBlind(entry.text);
		expect(() => expectGroundTruth(entry, structured, blind)).toThrow(/kept secret "SYNTHETIC_UNDETECTED_SECRET"/);
	});

	it("reports the pre-fix preview replacement that erased text after an unpaired banner", () => {
		const entries = [
			REDACTION_CORPUS.find(candidate => candidate.name === "unpaired private-key body keeps a nested sibling"),
			REDACTION_CORPUS.find(candidate => candidate.name === "unpaired private-key banner in prose keeps its suffix"),
		];
		// The pre-fix preview rescanned its own masked output and replaced everything after the
		// banner, so a nested sibling and a prose suffix disappeared from both paths.
		const preFixPreview = (text: string): MaskedCrashText => {
			const masked = redactCrashSecrets(text);
			const banner = masked.indexOf("-----BEGIN ");
			const replaced = banner < 0 ? masked : `${masked.slice(0, banner)}«redacted-private-key»`;
			return { text: applyRedactions(asOriginalText(replaced), []), masks: [] };
		};
		for (const entry of entries) {
			if (entry === undefined) throw new Error("corpus fixture missing");
			expect(() => expectGroundTruth(entry, preFixPreview(entry.text), preFixPreview(entry.text))).toThrow(
				/dropped/,
			);
		}
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
