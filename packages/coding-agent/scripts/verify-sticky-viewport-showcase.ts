import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	SEMANTIC_ANCHOR_DOMAIN,
	STICKY_VIEWPORT_FRAME_TEXT_WITNESS,
	type StickyViewportShowcaseKey,
	semanticAnchorDigest,
	semanticAnchorNamespace,
} from "../test/fixtures/tui/sticky-viewport-showcase";
import {
	ansiToHtml,
	captureProvenance,
	committedBlobSha256,
	gitObjectType,
	PROVENANCE_DIFF_SCOPE,
	resolveRepositoryPath,
	xterm256Color,
} from "./capture-sticky-viewport-showcase";

const KEYS = [
	"live-overflow/80x24/unicode-color",
	"live-overflow/120x36/unicode-color",
	"manual-history/80x24/unicode-color",
	"manual-history/120x36/unicode-color",
	"manual-new-output/80x24/unicode-color",
	"manual-new-output/120x36/unicode-color",
	"multiline-editor-hooks-pet/80x24/unicode-color",
	"multiline-editor-hooks-pet/120x36/unicode-color",
	"capacity-many/80x24/unicode-color",
	"capacity-many/120x36/unicode-color",
	"capacity-one/80x24/unicode-color",
	"capacity-one/120x36/unicode-color",
	"capacity-zero/80x24/unicode-color",
	"capacity-zero/120x36/unicode-color",
	"selection-boundary/80x24/unicode-color",
	"selection-boundary/120x36/unicode-color",
	"manual-new-output/80x24/ascii-no-color",
	"capacity-zero/48x10/ascii-no-color",
	"multiline-editor-hooks-pet/48x10/unicode-color",
	"narrow-cjk/48x10/unicode-color",
] as const;
const PAYLOADS = ["terminal.txt", "terminal-ansi.txt", "terminal.html", "metadata.json"] as const;
const COMMAND =
	"bun packages/coding-agent/scripts/capture-sticky-viewport-showcase.ts --out .gjc/qa/sticky-viewport-<run>";
const TIMESTAMP = "1970-01-01T00:00:00.000Z";
const FIXTURE = "packages/coding-agent/test/fixtures/tui/sticky-viewport-showcase.ts";
const DEFAULT_FOREGROUND = "#ffe7dc";
const DEFAULT_BACKGROUND = "#110b0b";
const CJK = ["의미 있는 문장 경계", "意味のある文の境界", "保留语义短语边界"] as const;
const FONT_RENDERING_ASSUMPTIONS =
	"Embedded red-claw theme at deterministic truecolor; HTML uses a monospace terminal fallback stack.";
const WRAPPING_TRUNCATION_POLICY =
	"ANSI-aware terminal-cell wrapping preserves semantic CJK phrase boundaries; constrained height drops the notice, decorative pet, then low-priority hooks without truncating pinned status or the focused composer.";
const ACCEPTANCE_VERSION = "sticky-viewport-stage-03";
const DESIGN_VERSION = "modes-design-sticky-viewport-v3";
const HOST_MATRIX = { capture_host: "VirtualTerminal", live_pty: false, network: false } as const;
const ARTIFACT_CHECKS = {
	terminal_txt: true,
	terminal_ansi_txt: true,
	terminal_html: true,
	metadata_json: true,
} as const;
const INDEPENDENT_REVIEW_KEYS = [
	"schema_version",
	"manifest_sha256",
	"reviewer_identity",
	"reviewer_role",
	"fixture_revision",
	"expected_entry_count",
	"observed_entry_count",
	"final",
	"checked_keys",
	"defects",
	"artifact_decision",
	"cjk_semantic_line_breaks",
	"host_matrix",
	"per_key_results",
] as const;
const INDEPENDENT_REVIEW_RESULT_KEYS = ["key", "result", "notes", "artifact_checks"] as const;
const INDEPENDENT_REVIEW_DEFECT_KEYS = ["description", "accepted"] as const;
const ARTIFACT_CHECK_KEYS = ["terminal_txt", "terminal_ansi_txt", "terminal_html", "metadata_json"] as const;
const SEMANTIC_ANCHOR_KEYS = [
	"domain",
	"id",
	"namespace",
	"grapheme_start",
	"grapheme_end",
	"cell_start",
	"cell_end",
	"frame_start_row",
	"row_text_sha256",
	"frame_sha256",
	"frame_text_sha256",
] as const;
const SEMANTIC_ROOT_IDS = [
	"irc-split",
	"pending-messages",
	"status-container",
	"todos",
	"btw",
	"status-line",
	"hooks-above",
	"editor-container",
	"pet-floor",
	"hooks-below",
] as const;
const STATE_KEYS = [
	"manual",
	"notice",
	"observed_output_revision",
	"transcript_capacity",
	"composer_visible",
	"resize_probes",
	"visible_empty_irc_frame",
	"root_order",
	"pin_boundary",
	"focused_component",
	"cursor",
	"selection",
	"semantic_anchor",
	"cjk_contiguous_semantics",
	"coverage",
] as const;
type Style = {
	foreground: string;
	background: string;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	blink: boolean;
	inverse: boolean;
	invisible: boolean;
	strikethrough: boolean;
	overline: boolean;
};
type Run = { text: string; style: Style };
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const cellWidth = (grapheme: string) => {
	const scalar = grapheme.codePointAt(0)!;
	if (scalar === 0x200d || (scalar >= 0x300 && scalar <= 0x36f) || (scalar >= 0xfe00 && scalar <= 0xfe0f)) return 0;
	return (scalar >= 0x1100 && scalar <= 0x115f) ||
		(scalar >= 0x2e80 && scalar <= 0xa4cf) ||
		(scalar >= 0xac00 && scalar <= 0xd7a3) ||
		(scalar >= 0xf900 && scalar <= 0xfaff) ||
		(scalar >= 0xff01 && scalar <= 0xff60) ||
		(scalar >= 0xffe0 && scalar <= 0xffe6)
		? 2
		: 1;
};
const terminalRows = (text: string, columns: number) =>
	text
		.slice(0, -1)
		.split("\n")
		.map(text => {
			const cells = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(item => ({
				grapheme: item.segment,
				width: cellWidth(item.segment),
			}));
			const width = cells.reduce((total, cell) => total + cell.width, 0);
			if (width > columns) fail(`terminal row exceeds ${columns} cells`);
			return { text, cells, width };
		});
const verifyCjkCellOracle = (text: string, columns: number, pinRow: unknown, cursorRow: unknown) => {
	if (!Number.isInteger(pinRow) || !Number.isInteger(cursorRow)) fail("narrow CJK lane geometry missing");
	const pinnedRow = pinRow as number;
	const editorRow = cursorRow as number;
	const rows = terminalRows(text, columns);
	const phrase = CJK[1];
	const row = rows.findIndex(candidate => candidate.text.includes(phrase));
	if (row < 0) fail("narrow CJK cell oracle missing canonical phrase");
	const candidate = rows[row]!;
	const phraseIndex = candidate.text.indexOf(phrase);
	const prefix = candidate.text.slice(0, phraseIndex);
	const phraseCells = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(phrase)];
	const phraseStart = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(prefix)].reduce(
		(total, item) => total + cellWidth(item.segment),
		0,
	);
	const phraseWidth = phraseCells.reduce((total, item) => total + cellWidth(item.segment), 0);
	if (phraseStart + phraseWidth > columns || row >= pinnedRow || row === editorRow)
		fail("narrow CJK cell oracle lane overlap");
};
const fail = (message: string): never => {
	throw new Error(`Sticky viewport evidence invalid: ${message}`);
};
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string) => {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) fail(`${label} keys must be exact`);
};
const object = (value: unknown, label: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
	return value as Record<string, unknown>;
};
const array = (value: unknown, label: string): unknown[] =>
	Array.isArray(value) ? value : fail(`${label} must be an array`);
const strings = (value: unknown, expected: readonly string[], label: string) => {
	if (
		!Array.isArray(value) ||
		value.length !== expected.length ||
		value.some((item, index) => item !== expected[index])
	)
		fail(`${label} differs from immutable matrix`);
};
async function readJson(file: string, label: string): Promise<Record<string, unknown>> {
	try {
		return object(JSON.parse(await fs.readFile(file, "utf8")), label);
	} catch (error) {
		return fail(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
}
async function allFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const item of await fs.readdir(directory, { withFileTypes: true })) {
			const target = path.join(directory, item.name);
			if (item.isDirectory()) await walk(target);
			else if (item.isFile()) result.push(path.relative(root, target).split(path.sep).join("/"));
			else fail(`unsupported filesystem entry ${target}`);
		}
	};
	await walk(root);
	return result.sort();
}
const baseStyle = (): Style => ({
	foreground: DEFAULT_FOREGROUND,
	background: DEFAULT_BACKGROUND,
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	blink: false,
	inverse: false,
	invisible: false,
	strikethrough: false,
	overline: false,
});
const color = (code: number): string | undefined => {
	const colors: Record<number, string> = {
		30: "#000000",
		31: "#cc0000",
		32: "#4e9a06",
		33: "#c4a000",
		34: "#3465a4",
		35: "#75507b",
		36: "#06989a",
		37: "#d3d7cf",
		90: "#555753",
		91: "#ef2929",
		92: "#8ae234",
		93: "#fce94f",
		94: "#729fcf",
		95: "#ad7fa8",
		96: "#34e2e2",
		97: "#eeeeec",
	};
	return colors[code];
};
const pushRun = (runs: Run[], text: string, style: Style) => {
	if (!text) return;
	const effective = style.inverse
		? {
				...style,
				foreground: style.background,
				background: style.foreground,
				inverse: false,
			}
		: { ...style };
	runs.push({ text, style: effective });
};
function ansiRuns(ansi: string): Run[] {
	const runs: Run[] = [];
	let style = baseStyle(),
		offset = 0;
	for (const match of ansi.matchAll(/\x1b\[([0-9;]*)m/g)) {
		pushRun(runs, ansi.slice(offset, match.index), style);
		offset = (match.index ?? 0) + match[0].length;
		const codes = (match[1] || "0").split(";").map(Number);
		for (let index = 0; index < codes.length; index += 1) {
			const code = codes[index]!;
			if (code === 0) style = baseStyle();
			else if (code === 1) style.bold = true;
			else if (code === 2) style.dim = true;
			else if (code === 3) style.italic = true;
			else if (code === 4) style.underline = true;
			else if (code === 5) style.blink = true;
			else if (code === 7) style.inverse = true;
			else if (code === 8) style.invisible = true;
			else if (code === 9) style.strikethrough = true;
			else if (code === 22) {
				style.bold = false;
				style.dim = false;
			} else if (code === 23) style.italic = false;
			else if (code === 24) style.underline = false;
			else if (code === 25) style.blink = false;
			else if (code === 27) style.inverse = false;
			else if (code === 28) style.invisible = false;
			else if (code === 29) style.strikethrough = false;
			else if (code === 53) style.overline = true;
			else if (code === 55) style.overline = false;
			else if (code === 39) style.foreground = DEFAULT_FOREGROUND;
			else if (code === 49) style.background = DEFAULT_BACKGROUND;
			else if (color(code)) style.foreground = color(code)!;
			else if (code >= 40 && code <= 47) style.background = color(code - 10)!;
			else if (code >= 100 && code <= 107) style.background = color(code - 10)!;
			else if ((code === 38 || code === 48) && codes[index + 1] === 5 && Number.isInteger(codes[index + 2])) {
				const value = xterm256Color(codes[index + 2]!);
				if (code === 38) style.foreground = value;
				else style.background = value;
				index += 2;
			} else if (
				(code === 38 || code === 48) &&
				codes[index + 1] === 2 &&
				[codes[index + 2], codes[index + 3], codes[index + 4]].every(Number.isInteger)
			) {
				const value = `rgb(${codes[index + 2]},${codes[index + 3]},${codes[index + 4]})`;
				if (code === 38) style.foreground = value;
				else style.background = value;
				index += 4;
			}
		}
	}
	pushRun(runs, ansi.slice(offset), style);
	return runs;
}
const decode = (value: string) =>
	value
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
function htmlRuns(html: string): Run[] {
	const preMatch = html.match(/<pre>([\s\S]*)<\/pre>/);
	if (preMatch?.[1] === undefined) return fail("HTML pre missing");
	const pre = preMatch[1];
	const runs: Run[] = [];
	let style = baseStyle();
	let offset = 0;
	for (const match of pre.matchAll(/<span style="([^"]*)">|<\/span>/g)) {
		pushRun(runs, decode(pre.slice(offset, match.index)), style);
		offset = (match.index ?? 0) + match[0].length;
		if (match[0] === "</span>") {
			style = baseStyle();
			continue;
		}
		const attributes = new Map<string, string>(
			match[1]!
				.split(";")
				.filter(Boolean)
				.map(part => {
					const separator = part.indexOf(":");
					if (separator < 0) return fail("HTML style declaration malformed");
					return [part.slice(0, separator), part.slice(separator + 1)] as const;
				}),
		);
		if (attributes.has("filter")) fail("HTML inverse must use effective colors, not CSS filter");
		const decorations = new Set((attributes.get("text-decoration") ?? "").split(" "));
		style = {
			...baseStyle(),
			foreground: attributes.get("color") ?? DEFAULT_FOREGROUND,
			background: attributes.get("background-color") ?? DEFAULT_BACKGROUND,
			bold: attributes.get("font-weight") === "700",
			dim: attributes.get("opacity") === ".65",
			italic: attributes.get("font-style") === "italic",
			underline: decorations.has("underline"),
			blink: attributes.get("animation") === "blink 1s step-end infinite",
			invisible: attributes.get("visibility") === "hidden",
			strikethrough: decorations.has("line-through"),
			overline: decorations.has("overline"),
		};
	}
	pushRun(runs, decode(pre.slice(offset)), style);
	return runs;
}
const normalized = (runs: Run[]) => {
	const merged: Run[] = [];
	for (const run of runs) {
		const prior = merged.at(-1);
		if (prior && JSON.stringify(prior.style) === JSON.stringify(run.style)) prior.text += run.text;
		else merged.push({ ...run, style: { ...run.style } });
	}
	return merged;
};
const equalRuns = (left: Run[], right: Run[]) => JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
const hasColorSgr = (ansi: string) =>
	[...ansi.matchAll(/\x1b\[([0-9;]*)m/g)].some(match => {
		const codes = (match[1] || "0").split(";").map(Number);
		return codes.some(
			code =>
				(code >= 30 && code <= 37) ||
				(code >= 40 && code <= 47) ||
				(code >= 90 && code <= 107) ||
				code === 38 ||
				code === 48,
		);
	});
// Independent, frame-derived transcript geometry. The renderer assigns
// `transcriptCapacity` and `pinBoundary.row` from one local (tui.ts), so
// comparing those two to each other can never fail. These derivations read the
// committed paint instead, so a renderer reporting stale geometry is rejected.
const STATUS_ROW_MARKER = "⬢";
const NOTICE_MARKER = "New output — type to follow";
const frameGeometry = (key: string, text: string) => {
	const rows = text.split("\n").slice(0, -1);
	const statusRows = rows.filter(row => row.includes(STATUS_ROW_MARKER));
	if (statusRows.length !== 1) fail(`entry ${key} status row cardinality is not exactly one`);
	const statusRow = rows.findIndex(row => row.includes(STATUS_ROW_MARKER));
	const noticeRows = text.split(NOTICE_MARKER).length - 1;
	if (noticeRows > 1) fail(`entry ${key} notice row cardinality exceeds one`);
	// The notice, when present, occupies the first row below the transcript, so
	// the painted status row sits one lower than the transcript capacity.
	return { capacity: statusRow - noticeRows, statusRow, noticeRows };
};
// Immutable per-entry anchor expectation. A recomputed digest only proves internal
// consistency: the producer chooses `frame_start_row` and the geometry, so it can
// mint a cryptographically valid id for a RELOCATED or TRANSPLANTED anchor. This
// table is the independent witness. It lives in verifier source, not in the bundle,
// and this file's own sha256 is inside `source_sha256`, so a bundle author cannot
// restate it. Geometry was measured identical across indexed-color and truecolor
// hosts, so pinning it costs no host portability.
// Files that OWN the verification contract itself: the expectation table, the
// anchor digest function, and every guard below. `source_sha256` cannot protect
// these, because it is produced by `captureProvenance()` from the worktree -- an
// author who edits an oracle and restamps provenance gets a self-consistent
// bundle. So these two are pinned to their committed blobs at the bundle's own
// `git_head` instead. Product-source diffs stay permitted for staged current-dev
// integration; oracle diffs do not.
const ORACLE_SOURCES = [
	"packages/coding-agent/scripts/verify-sticky-viewport-showcase.ts",
	"packages/coding-agent/test/fixtures/tui/sticky-viewport-showcase.ts",
] as const;
// The reviewed PR commit, supplied out-of-band by the verifying operator.
// `provenance.git_head` is `git rev-parse HEAD`, which is NOT the reviewed commit
// during an uncommitted synthetic merge: there HEAD is the integration base while
// the running oracle is the staged PR version. Comparing against HEAD alone
// therefore rejects an honest bundle before any evidence guard runs. This value is
// environment-supplied rather than bundle-supplied, so a bundle author cannot
// choose which commit vouches for the oracle.
const ORACLE_COMMIT_ENV = "GJC_STICKY_VIEWPORT_ORACLE_COMMIT";
const verifyOracleIntegrity = async (gitHead: string, declaredProvenanceCommit: unknown) => {
	// Authority is exactly one commit. Reachability is NOT authority: bytes
	// committed on an unrelated local or remote-tracking ref are reachable via
	// `--all` yet were never reviewed, so enumerating refs would let any pushed
	// or fetched branch authorize the oracle. The reviewed commit is therefore
	// either declared out-of-band by the review harness or it is `git_head`.
	const declared = process.env[ORACLE_COMMIT_ENV]?.trim();
	if (declared !== undefined && !/^[0-9a-f]{40}$/.test(declared))
		fail(`oracle integrity: ${ORACLE_COMMIT_ENV} must be a full 40-hex commit id`);
	const authority = declared ?? gitHead;
	// Fail closed when the authority is not a readable commit object.
	if ((await gitObjectType(authority)) !== "commit")
		fail(`oracle integrity: authority ${authority} is not a readable commit object`);
	// The bundle records which commit it claimed; a mismatch means the bundle was
	// captured against a different authority than the one being verified.
	if (declaredProvenanceCommit !== authority)
		fail(
			`oracle integrity: provenance oracle_commit ${String(declaredProvenanceCommit)} is not the authority ${authority}`,
		);
	// Both oracle files must resolve at that same commit; per-file provenance
	// from different refs is not accepted.
	for (const source of ORACLE_SOURCES) {
		const committed = await committedBlobSha256(authority, source);
		if (committed === null) fail(`oracle integrity: ${source} has no committed blob at ${authority}`);
		const running = hash(new Uint8Array(await fs.readFile(resolveRepositoryPath(source))));
		if (running !== committed) fail(`oracle integrity: ${source} differs from its committed blob at ${authority}`);
	}
};
const SEMANTIC_ANCHOR_EXPECTATION: Readonly<
	Record<string, { frameRow: number; graphemeStart: number; graphemeEnd: number; cellStart: number; cellEnd: number }>
> = Object.freeze({
	"live-overflow/80x24/unicode-color": {
		frameRow: 2,
		graphemeStart: 0,
		graphemeEnd: 1638400,
		cellStart: 0,
		cellEnd: 1638400,
	},
	"live-overflow/120x36/unicode-color": {
		frameRow: 2,
		graphemeStart: 0,
		graphemeEnd: 3276800,
		cellStart: 0,
		cellEnd: 3276800,
	},
	"manual-history/80x24/unicode-color": {
		frameRow: 0,
		graphemeStart: 1638400,
		graphemeEnd: 3276800,
		cellStart: 1638400,
		cellEnd: 3276800,
	},
	"manual-history/120x36/unicode-color": {
		frameRow: 0,
		graphemeStart: 0,
		graphemeEnd: 3276800,
		cellStart: 0,
		cellEnd: 3276800,
	},
	"manual-new-output/80x24/unicode-color": {
		frameRow: 0,
		graphemeStart: 1638400,
		graphemeEnd: 3276800,
		cellStart: 1638400,
		cellEnd: 3276800,
	},
	"manual-new-output/120x36/unicode-color": {
		frameRow: 0,
		graphemeStart: 0,
		graphemeEnd: 3276800,
		cellStart: 0,
		cellEnd: 3276800,
	},
	"multiline-editor-hooks-pet/80x24/unicode-color": {
		frameRow: 3,
		graphemeStart: 0,
		graphemeEnd: 1638400,
		cellStart: 0,
		cellEnd: 1638400,
	},
	"multiline-editor-hooks-pet/120x36/unicode-color": {
		frameRow: 3,
		graphemeStart: 0,
		graphemeEnd: 3276800,
		cellStart: 0,
		cellEnd: 3276800,
	},
	"capacity-many/80x24/unicode-color": {
		frameRow: 0,
		graphemeStart: 1638400,
		graphemeEnd: 3276800,
		cellStart: 1638400,
		cellEnd: 3276800,
	},
	"capacity-many/120x36/unicode-color": {
		frameRow: 0,
		graphemeStart: 0,
		graphemeEnd: 3276800,
		cellStart: 0,
		cellEnd: 3276800,
	},
	"capacity-one/80x24/unicode-color": {
		frameRow: 0,
		graphemeStart: 0,
		graphemeEnd: 1605632,
		cellStart: 0,
		cellEnd: 1605632,
	},
	"capacity-one/120x36/unicode-color": {
		frameRow: 0,
		graphemeStart: 0,
		graphemeEnd: 3211264,
		cellStart: 0,
		cellEnd: 3211264,
	},
	"selection-boundary/80x24/unicode-color": {
		frameRow: 0,
		graphemeStart: 1638400,
		graphemeEnd: 3276800,
		cellStart: 1638400,
		cellEnd: 3276800,
	},
	"selection-boundary/120x36/unicode-color": {
		frameRow: 0,
		graphemeStart: 0,
		graphemeEnd: 3276800,
		cellStart: 0,
		cellEnd: 3276800,
	},
	"manual-new-output/80x24/ascii-no-color": {
		frameRow: 0,
		graphemeStart: 1638400,
		graphemeEnd: 3276800,
		cellStart: 1638400,
		cellEnd: 3276800,
	},
	"multiline-editor-hooks-pet/48x10/unicode-color": {
		frameRow: 0,
		graphemeStart: 1638400,
		graphemeEnd: 3276800,
		cellStart: 1638400,
		cellEnd: 3276800,
	},
	"narrow-cjk/48x10/unicode-color": {
		frameRow: 3,
		graphemeStart: 0,
		graphemeEnd: 589824,
		cellStart: 0,
		cellEnd: 589824,
	},
});
// Semantic anchor identity guard. The persisted `semantic_anchor.id` is the only
// durable handle on WHICH painted row the evidence anchors, so it must be
// unforgeable rather than merely well-formed. A geometry-only digest failed both
// ways: distinct entries painting different content at equal offsets collapsed
// onto one id, and an 8-hex truncation is brute-forceable. This recomputes the
// full domain-separated digest from the persisted inputs plus the committed paint
// and rejects arbitrary, transplanted, aliased, malformed, and truncated ids. It
// runs BEFORE every downstream metadata check so a forged id can never ride
// through on an earlier-passing path.
const verifySemanticAnchor = (
	key: string,
	state: string,
	value: unknown,
	text: string,
	ansiSha256: string,
	seen: Map<string, string>,
) => {
	if (state === "capacity-zero") {
		if (value !== null) fail(`semantic anchor guard: ${key} must not carry an anchor at zero capacity`);
		return;
	}
	const anchor = object(value, `semantic anchor ${key}`);
	exactKeys(anchor, SEMANTIC_ANCHOR_KEYS, `semantic anchor ${key}`);
	if (anchor.domain !== SEMANTIC_ANCHOR_DOMAIN)
		fail(`semantic anchor guard: ${key} domain separation literal mismatch`);
	const id = anchor.id;
	const namespace = anchor.namespace;
	if (typeof id !== "string" || typeof namespace !== "string" || !namespace)
		fail(`semantic anchor guard: ${key} id or namespace is not a nonempty string`);
	const geometry = ["grapheme_start", "grapheme_end", "cell_start", "cell_end", "frame_start_row"] as const;
	for (const field of geometry)
		if (!Number.isInteger(anchor[field]) || (anchor[field] as number) < 0)
			fail(`semantic anchor guard: ${key} ${field} is not a nonnegative integer`);
	const graphemeStart = anchor.grapheme_start as number;
	const graphemeEnd = anchor.grapheme_end as number;
	const cellStart = anchor.cell_start as number;
	const cellEnd = anchor.cell_end as number;
	const frameRow = anchor.frame_start_row as number;
	if (graphemeEnd <= graphemeStart || cellEnd <= cellStart)
		fail(`semantic anchor guard: ${key} geometry span is empty or inverted`);
	// Independent witness: reject relocation/transplant even when every digest and
	// provenance field is internally consistent.
	const expectation = SEMANTIC_ANCHOR_EXPECTATION[key];
	if (!expectation) fail(`semantic anchor guard: ${key} has no immutable anchor expectation`);
	if (
		frameRow !== expectation!.frameRow ||
		graphemeStart !== expectation!.graphemeStart ||
		graphemeEnd !== expectation!.graphemeEnd ||
		cellStart !== expectation!.cellStart ||
		cellEnd !== expectation!.cellEnd
	)
		fail(`semantic anchor guard: ${key} anchor row or geometry does not match its immutable expectation`);
	// The row text is read from the committed paint, never from metadata, so the id
	// stays bound to what the artifact actually renders at the recorded row.
	const rows = text.split("\n");
	const rowText = rows[frameRow];
	if (rowText === undefined) fail(`semantic anchor guard: ${key} frame_start_row is outside the committed paint`);
	if (anchor.row_text_sha256 !== hash(rowText as string))
		fail(`semantic anchor guard: ${key} row content digest does not match the painted anchor row`);
	if (anchor.frame_sha256 !== ansiSha256)
		fail(`semantic anchor guard: ${key} frame digest does not match the committed frame`);
	const frameTextSha256 = hash(Bun.stripANSI(text));
	if (anchor.frame_text_sha256 !== frameTextSha256)
		fail(`semantic anchor guard: ${key} frame text digest does not match the committed paint`);
	if (semanticAnchorNamespace(id as string) !== namespace)
		fail(`semantic anchor guard: ${key} id namespace does not match the persisted namespace`);
	const expected = `${namespace}:${semanticAnchorDigest({
		entryKey: key,
		namespace: namespace as string,
		rowText: rowText as string,
		graphemeStart,
		graphemeEnd,
		cellStart,
		cellEnd,
		frameRow,
		frameTextSha256,
	})}`;
	if (id !== expected) fail(`semantic anchor guard: ${key} id is not the digest of its own persisted inputs`);
	// No silent aliasing: distinct evidence entries are distinct anchors by
	// construction, because the entry key is inside the preimage. A repeat here can
	// only mean a transplanted id, so it is a hard failure rather than an
	// equivalence to be tolerated.
	const owner = seen.get(id as string);
	if (owner !== undefined) fail(`semantic anchor guard: ${key} id aliases the anchor already claimed by ${owner}`);
	seen.set(id as string, key);
};
// Whole-frame content witness. The semantic anchor guard above pins exactly ONE
// painted row per entry, and `anchor.frame_sha256` is recomputed from the
// bundle's OWN artifact, so it only proves internal consistency: a producer who
// rewrites a non-anchor row and coordinately rehashes every dependent digest --
// artifacts, metadata, manifest entry, provenance blocks, review-input binding --
// stayed self-consistent and was ACCEPTED. In an 80x24 frame 13 rows carry
// content while one is anchored, so the transcript rows carrying the bundle's own
// evidence text were rewritable at will.
//
// This compares the painted frame against a value committed in oracle source,
// which no bundle can reach. It is invoked LAST in the per-entry loop, after the
// anchor guard and after every geometry, marker, and CJK oracle, so a mutation
// those already attribute keeps its narrower message and only the rows no other
// oracle inspects surface here.
//
// The digest is over the ANSI-STRIPPED paint. `frame_sha256` stays untouched as
// the artifact digest and legitimately diverges between an indexed-color and a
// truecolor host; the stripped paint does not, so it is the only frame-wide
// surface that a single committed value can pin on both hosts.
export const stickyViewportFrameTextDigest = (frame: string): string => hash(Bun.stripANSI(frame));
const verifyFrameTextWitness = (key: string, text: string) => {
	// Fail closed: an unwitnessed key is an unpinned frame, not a pass.
	const expected: string | undefined = STICKY_VIEWPORT_FRAME_TEXT_WITNESS[key as StickyViewportShowcaseKey];
	if (expected === undefined) fail(`frame content guard: ${key} has no committed frame text witness`);
	const observed = stickyViewportFrameTextDigest(text);
	if (observed !== expected)
		fail(
			`frame content guard: ${key} painted frame digest is ${observed} but the committed witness pins ${expected}`,
		);
};
export async function verifyStickyViewportShowcase(rootInput: string, requireIndependentReview = false): Promise<void> {
	const root = path.resolve(rootInput);
	const manifestText = await fs.readFile(path.join(root, "manifest.json"), "utf8");
	const manifest = await readJson(path.join(root, "manifest.json"), "manifest");
	if (
		manifest.schema_version !== 2 ||
		manifest.fixture_revision !== "sticky-viewport-showcase-v2" ||
		manifest.expected_entry_count !== 20 ||
		manifest.entry_count !== 20 ||
		manifest.command !== COMMAND ||
		manifest.capture_timestamp !== TIMESTAMP ||
		manifest.review_input_file !== "review-input.json"
	)
		fail("manifest schema or provenance literals mismatch");
	strings(manifest.ordered_keys, KEYS, "manifest ordered_keys");
	const provenance = object(manifest.provenance, "manifest provenance");
	const expectedProvenance = await captureProvenance();
	if (
		provenance.capture_mode !== "production-tui-virtual-terminal" ||
		provenance.live_pty !== false ||
		provenance.network !== false ||
		provenance.fixed_clock !== true ||
		typeof provenance.author_identity !== "string" ||
		!provenance.author_identity.trim() ||
		typeof provenance.executor_identity !== "string" ||
		!provenance.executor_identity.trim()
	)
		fail("manifest provenance mismatch");
	// `git_diff_scope` is compared against the verifier's own constant, so a bundle
	// cannot narrow the covered surface to dodge the digest: claiming a smaller
	// scope than the verifier requires is itself a staleness rejection.
	if (
		provenance.git_head !== expectedProvenance.git_head ||
		JSON.stringify(provenance.git_diff_scope) !== JSON.stringify(PROVENANCE_DIFF_SCOPE) ||
		provenance.git_diff_binary_sha256 !== expectedProvenance.git_diff_binary_sha256 ||
		JSON.stringify(provenance.source_sha256) !== JSON.stringify(expectedProvenance.source_sha256)
	)
		fail("manifest capture provenance is stale");
	// Runs before every entry check: a rewritten oracle would otherwise decide
	// what "valid" means for all of them.
	await verifyOracleIntegrity(provenance.git_head as string, provenance.oracle_commit);
	const entries = array(manifest.entries, "manifest entries");
	if (entries.length !== KEYS.length) fail("manifest entries must contain exactly 20 entries");
	// Cross-entry anchor identity ledger. Uniqueness is a hard contract, not a
	// tolerance: every distinct evidence entry must own a distinct anchor id.
	const anchorIds = new Map<string, string>();
	for (let index = 0; index < KEYS.length; index += 1) {
		const key = KEYS[index]!;
		const entry = object(entries[index], `entry ${index}`);
		const [state, id, mode] = key.split("/");
		const [columns, rows] = id!.split("x").map(Number);
		if (entry.key !== key || entry.state_id !== state || entry.render_mode !== mode)
			fail(`entry ${key} variant mismatch`);
		const viewport = object(entry.viewport, `entry ${key} viewport`);
		if (viewport.id !== id || viewport.columns !== columns || viewport.rows !== rows)
			fail(`entry ${key} viewport mismatch`);
		const listed = array(entry.files, `entry ${key} files`);
		if (listed.length !== PAYLOADS.length) fail(`entry ${key} file list is not exact`);
		strings(
			listed.map(value => object(value, `entry ${key} file`).path),
			PAYLOADS.map(name => `${key}/${name}`),
			`entry ${key} payload paths`,
		);
		for (const value of listed) {
			const file = object(value, `entry ${key} file`);
			if (typeof file.path !== "string" || typeof file.sha256 !== "string" || !Number.isInteger(file.byte_length))
				fail(`entry ${key} malformed file manifest`);
			const filePath = file.path as string;
			const content = await fs.readFile(path.join(root, filePath), "utf8");
			if (hash(content) !== file.sha256 || Buffer.byteLength(content) !== file.byte_length)
				fail(`entry ${key} hash or byte length mismatch`);
		}
		const text = await fs.readFile(path.join(root, key, "terminal.txt"), "utf8");
		const ansi = await fs.readFile(path.join(root, key, "terminal-ansi.txt"), "utf8");
		const html = await fs.readFile(path.join(root, key, "terminal.html"), "utf8");
		if (Bun.stripANSI(ansi) !== text) fail(`entry ${key} text/ANSI semantic evidence mismatch`);
		if (html !== ansiToHtml(ansi)) fail(`entry ${key} HTML artifact is not canonical ANSI conversion`);
		const ansiStyleRuns = ansiRuns(ansi);
		const htmlStyleRuns = htmlRuns(html);
		if (
			ansiStyleRuns.map(run => run.text).join("") !== text ||
			htmlStyleRuns.map(run => run.text).join("") !== text ||
			!equalRuns(ansiStyleRuns, htmlStyleRuns)
		)
			fail(`entry ${key} ANSI/HTML style-run mismatch`);
		if (text.split("\n").length - 1 !== rows) fail(`entry ${key} terminal row count mismatch`);
		// `ascii-no-color` artifacts must contain no escape sequence at all, which is
		// host-independent. The color branch keeps the widened check below because the
		// prior `3[0-9]|38;` regex missed background (40-47/100-107) and bright (90-97)
		// color, so a frame carrying only those would have passed as "no color".
		if (mode === "ascii-no-color" ? /\x1b\[/.test(ansi) : !hasColorSgr(ansi))
			fail(`entry ${key} ANSI mode/color mismatch`);
		const metadata = await readJson(path.join(root, key, "metadata.json"), `metadata ${key}`);
		exactKeys(
			metadata,
			[
				"schema_version",
				"entry_key",
				"fixture_revision",
				"capture_timestamp",
				"command_or_replay_source",
				"fixture_source",
				"terminal",
				"render_mode",
				"ansi_mode",
				"source_revision",
				"output_revision",
				"state",
				"provenance",
				"cjk_phrase_boundaries",
			],
			`metadata ${key}`,
		);
		const terminal = object(metadata.terminal, `metadata ${key} terminal`);
		exactKeys(
			terminal,
			["id", "columns", "rows", "font_rendering_assumptions", "wrapping_truncation_policy"],
			`metadata ${key} terminal`,
		);
		const stateEvidence = object(metadata.state, `metadata ${key} state`);
		const metaProvenance = object(metadata.provenance, `metadata ${key} provenance`);
		if (
			metadata.schema_version !== 2 ||
			metadata.entry_key !== key ||
			metadata.fixture_revision !== "sticky-viewport-showcase-v2" ||
			metadata.capture_timestamp !== TIMESTAMP ||
			metadata.command_or_replay_source !== COMMAND ||
			metadata.fixture_source !== FIXTURE ||
			metadata.render_mode !== mode ||
			metadata.ansi_mode !== (mode === "unicode-color") ||
			metadata.source_revision !== "production-tui-virtual-terminal-v3" ||
			terminal.id !== id ||
			terminal.columns !== columns ||
			terminal.rows !== rows ||
			terminal.font_rendering_assumptions !== FONT_RENDERING_ASSUMPTIONS ||
			terminal.wrapping_truncation_policy !== WRAPPING_TRUNCATION_POLICY ||
			metaProvenance.capture_mode !== provenance.capture_mode ||
			metaProvenance.live_pty !== false ||
			metaProvenance.network !== false ||
			metaProvenance.fixed_clock !== true ||
			metaProvenance.author_identity !== provenance.author_identity ||
			metaProvenance.executor_identity !== provenance.executor_identity ||
			metaProvenance.git_head !== expectedProvenance.git_head ||
			JSON.stringify(metaProvenance.git_diff_scope) !== JSON.stringify(PROVENANCE_DIFF_SCOPE) ||
			metaProvenance.git_diff_binary_sha256 !== expectedProvenance.git_diff_binary_sha256 ||
			JSON.stringify(metaProvenance.source_sha256) !== JSON.stringify(expectedProvenance.source_sha256) ||
			stateEvidence.composer_visible !== true
		)
			fail(`metadata schema mismatch for ${key}`);
		// Anchor identity is validated here, before any downstream metadata check, so
		// a forged, transplanted, or aliased id cannot ride through on an
		// earlier-passing path.
		verifySemanticAnchor(key, state!, stateEvidence.semantic_anchor, text, hash(ansi), anchorIds);
		// Frame-derived geometry must AGREE with the renderer's self-report, which is
		// strictly stronger than either alone. `transcript_capacity` and
		// `pin_boundary.row` both come from one renderer local, so they can only be
		// falsified against the committed paint: a renderer reporting stale capacity
		// or pin geometry now fails here instead of passing self-consistently.
		const frameGeom = frameGeometry(key, text);
		if (
			!Number.isInteger(stateEvidence.transcript_capacity) ||
			stateEvidence.transcript_capacity !== frameGeom.capacity ||
			frameGeom.noticeRows !== (state === "manual-new-output" ? 1 : 0)
		)
			fail(`capacity metadata/frame mismatch for ${key}`);
		// Ordered suffix markers follow the production root order: status-line (5),
		// hooks-above (6), editor-container (7). Painted order, not reported order.
		let markerPosition = -1;
		for (const marker of [STATUS_ROW_MARKER, "hook: ready", "> "]) {
			const next = text.indexOf(marker, markerPosition + 1);
			if (next < 0) fail(`entry ${key} ordered suffix marker missing: ${marker}`);
			markerPosition = next;
		}
		const observations = array(stateEvidence.resize_probes, `metadata ${key} resize observations`);
		const probeWidths = [64, 65, 80, 120, 160, 120, 80, 65, 64];
		const rootOrder = array(stateEvidence.root_order, `metadata ${key} root order`);
		const pinBoundary = object(stateEvidence.pin_boundary, `metadata ${key} pin boundary`);
		const cursor = object(stateEvidence.cursor, `metadata ${key} cursor`);
		const selection = stateEvidence.selection;
		const expectedManual = state !== "live-overflow" && state !== "capacity-zero";
		const expectedNotice = state === "manual-new-output";
		const expectedRevision = expectedNotice ? "1" : "0";
		if (
			stateEvidence.manual !== expectedManual ||
			stateEvidence.notice !== expectedNotice ||
			stateEvidence.observed_output_revision !== expectedRevision ||
			metadata.output_revision !== stateEvidence.observed_output_revision
		)
			fail(`renderer-owned viewport state mismatch for ${key}`);
		const visibleEmpty = object(stateEvidence.visible_empty_irc_frame, `metadata ${key} visible empty IRC frame`);
		exactKeys(stateEvidence, STATE_KEYS, `metadata ${key} state`);
		strings(rootOrder, SEMANTIC_ROOT_IDS, `metadata ${key} semantic root IDs`);
		const coverage = object(stateEvidence.coverage, `metadata ${key} coverage`);
		exactKeys(
			coverage,
			["irc", "todo", "widths", "heights", "viewport", "chrome", "evidence"],
			`metadata ${key} coverage`,
		);
		strings(coverage.irc, ["empty", "streaming", "long"], `metadata ${key} IRC coverage`);
		strings(
			coverage.todo,
			["empty", "populated", "long", "multi-phase", "collapsed", "expanded"],
			`metadata ${key} todo coverage`,
		);
		const emptyText = visibleEmpty.text as string;
		const capacityConstrained = state === "capacity-one" || state === "capacity-zero";
		if (
			JSON.stringify(coverage.widths) !== JSON.stringify(probeWidths) ||
			emptyText.includes("worker → you") ||
			emptyText.includes("long IRC observation") ||
			observations.length !== probeWidths.length ||
			observations.some((value, index) => {
				const probe = object(value, `metadata ${key} resize observation`);
				const frame = object(probe.frame, `metadata ${key} resize frame`);
				const split = probeWidths[index]! >= 65;
				return (
					probe.columns !== probeWidths[index] ||
					probe.effective_lane !== (split ? "split" : "transcript") ||
					probe.separator_width !== (split ? 3 : 0) ||
					(probe.left_width as number) + (probe.separator_width as number) + (probe.right_width as number) !==
						probeWidths[index] ||
					probe.irc_records !== (split ? 1 : 0) ||
					probe.todo_rows !== (split ? 1 : 0) ||
					probe.todo_expanded !== (probe.columns as number) >= 80 ||
					typeof frame.ansi !== "string" ||
					frame.text !== Bun.stripANSI(frame.ansi) ||
					frame.sha256 !== hash(frame.ansi) ||
					// Required ASCII metadata frames must be escape-free too, or the bundle
					// digest stays host-dependent even when the top-level payload is canonical.
					(mode === "ascii-no-color" && /\x1b\[/.test(frame.ansi as string)) ||
					(!capacityConstrained && split && !frame.text.includes("│")) ||
					(!capacityConstrained &&
						!split &&
						(frame.text.includes("worker → you") || frame.text.includes("Todos"))) ||
					(!capacityConstrained &&
						(probe.columns as number) >= 80 &&
						(!frame.text.includes("long IRC observation") ||
							!frame.text.includes("☑ verify production todo") ||
							!frame.text.includes("☐ expanded production todo"))) ||
					(!capacityConstrained && (probe.columns as number) >= 120 && !frame.text.includes("worker → you"))
				);
			}) ||
			typeof visibleEmpty.ansi !== "string" ||
			visibleEmpty.text !== Bun.stripANSI(visibleEmpty.ansi) ||
			visibleEmpty.sha256 !== hash(visibleEmpty.ansi) ||
			(mode === "ascii-no-color" && /\x1b\[/.test(visibleEmpty.ansi as string)) ||
			JSON.stringify(rootOrder) !==
				JSON.stringify([
					"irc-split",
					"pending-messages",
					"status-container",
					"todos",
					"btw",
					"status-line",
					"hooks-above",
					"editor-container",
					"pet-floor",
					"hooks-below",
				]) ||
			pinBoundary.component !== "status-line" ||
			pinBoundary.index !== 5 ||
			pinBoundary.row !== frameGeom.capacity ||
			pinBoundary.pinned !== true ||
			stateEvidence.focused_component !== "editor" ||
			!Number.isInteger(cursor.row) ||
			(cursor.row as number) < 0 ||
			(cursor.row as number) >= rows ||
			!Number.isInteger(cursor.col) ||
			(cursor.col as number) < 0 ||
			(cursor.col as number) >= columns ||
			cursor.frame_sha256 !== hash(ansi) ||
			cursor.blink !== true
		)
			fail(`runtime observation mismatch for ${key}`);
		if (
			(state === "capacity-many" && (stateEvidence.transcript_capacity as number) <= 1) ||
			(state === "capacity-one" && stateEvidence.transcript_capacity !== 1) ||
			(state === "capacity-zero" && stateEvidence.transcript_capacity !== 0)
		)
			fail(`capacity scenario mismatch for ${key}`);
		if (state === "selection-boundary") {
			const selected = object(selection, `metadata ${key} selection`);
			const start = object(selected.start, `metadata ${key} selection start`);
			const end = object(selected.end, `metadata ${key} selection end`);
			if (
				!Number.isInteger(start.row) ||
				!Number.isInteger(start.col) ||
				!Number.isInteger(end.row) ||
				!Number.isInteger(end.col) ||
				(start.row as number) < 0 ||
				(end.row as number) >= (stateEvidence.transcript_capacity as number) ||
				((start.row as number) === (end.row as number) && (start.col as number) >= (end.col as number))
			)
				fail(`selection boundary evidence missing for ${key}`);
		} else if (selection !== null) fail(`unexpected selection evidence for ${key}`);
		if (state === "narrow-cjk") {
			strings(metadata.cjk_phrase_boundaries, CJK, "narrow CJK boundaries");
			const probeTexts = observations.map(value => {
				const probe = object(value, `metadata ${key} resize observation`);
				return object(probe.frame, `metadata ${key} resize frame`).text;
			});
			if (
				CJK.some(
					boundary => ![text, ...probeTexts].some(frame => typeof frame === "string" && frame.includes(boundary)),
				)
			)
				fail("narrow CJK visible terminal evidence missing");
			verifyCjkCellOracle(text, columns, pinBoundary.row, cursor.row);
		} else strings(metadata.cjk_phrase_boundaries, [], `non-narrow CJK boundaries for ${key}`);
		// Whole-frame pin, LAST in the per-entry loop. It runs after the semantic
		// anchor guard so an anchor-row mutation keeps its narrower anchor
		// attribution, and after the geometry, marker, and CJK oracles so a case that
		// mutates the paint to reach one of those keeps its own attribution too.
		// Ordering costs nothing here: every check above reads the same painted frame
		// this pins, so none of them can be subverted by a paint this guard would
		// reject. What lands here is the residue -- rows no other oracle looks at,
		// which is precisely the unpinned surface this guard exists to close.
		verifyFrameTextWitness(key, text);
	}
	const required = new Set([
		"manifest.json",
		"review-input.json",
		...KEYS.flatMap(key => PAYLOADS.map(file => `${key}/${file}`)),
		...(requireIndependentReview ? ["independent-review.json"] : []),
	]);
	for (const file of await allFiles(root)) if (!required.has(file)) fail(`unexpected file ${file}`);
	const reviewInput = await readJson(path.join(root, "review-input.json"), "review input");
	const reviewProvenance = object(reviewInput.provenance, "review input provenance");
	if (
		reviewProvenance.git_head !== expectedProvenance.git_head ||
		JSON.stringify(reviewProvenance.git_diff_scope) !== JSON.stringify(PROVENANCE_DIFF_SCOPE) ||
		reviewProvenance.git_diff_binary_sha256 !== expectedProvenance.git_diff_binary_sha256 ||
		JSON.stringify(reviewProvenance.source_sha256) !== JSON.stringify(expectedProvenance.source_sha256)
	)
		fail("review input capture provenance is stale");
	if (
		reviewInput.schema_version !== 2 ||
		reviewInput.manifest_sha256 !== hash(manifestText) ||
		reviewInput.command_or_replay_source !== COMMAND ||
		reviewInput.capture_timestamp !== TIMESTAMP ||
		reviewInput.fixture_source !== FIXTURE ||
		reviewInput.fixed_clock !== true ||
		reviewInput.live_pty !== false ||
		reviewInput.network !== false ||
		reviewInput.author_identity !== provenance.author_identity ||
		reviewInput.executor_identity !== provenance.executor_identity
	)
		fail("review input manifest binding mismatch");
	strings(reviewInput.expected_keys, KEYS, "review input expected_keys");
	strings(reviewInput.required_artifacts, PAYLOADS, "review input required_artifacts");
	const reviewHostMatrix = object(reviewInput.host_matrix, "review input host matrix");
	if (
		reviewInput.acceptance_version !== ACCEPTANCE_VERSION ||
		reviewInput.design_version !== DESIGN_VERSION ||
		reviewHostMatrix.capture_host !== HOST_MATRIX.capture_host ||
		reviewHostMatrix.live_pty !== HOST_MATRIX.live_pty ||
		reviewHostMatrix.network !== HOST_MATRIX.network
	)
		fail("review input acceptance, design, or host matrix mismatch");
	const narrow = object(reviewInput.narrow_cjk, "review input narrow CJK");
	if (narrow.entry_key !== "narrow-cjk/48x10/unicode-color") fail("review input narrow CJK mismatch");
	strings(narrow.phrase_boundaries, CJK, "review input narrow CJK boundaries");
	if (requireIndependentReview) {
		const review = await readJson(path.join(root, "independent-review.json"), "independent review");
		exactKeys(review, INDEPENDENT_REVIEW_KEYS, "independent review");
		const reviewer = review.reviewer_identity;
		const canonicalReviewer = typeof reviewer === "string" ? reviewer.trim() : "";
		const canonicalAuthor = (provenance.author_identity as string).trim();
		const canonicalExecutor = (provenance.executor_identity as string).trim();
		const defects = array(review.defects, "independent review defects");
		if (
			review.schema_version !== 2 ||
			review.manifest_sha256 !== hash(manifestText) ||
			review.fixture_revision !== "sticky-viewport-showcase-v2" ||
			review.expected_entry_count !== 20 ||
			review.observed_entry_count !== 20 ||
			review.final !== "accept" ||
			review.reviewer_role !== "independent-terminal-reviewer" ||
			typeof reviewer !== "string" ||
			!canonicalReviewer ||
			reviewer !== canonicalReviewer ||
			canonicalReviewer === canonicalAuthor ||
			canonicalReviewer === canonicalExecutor ||
			review.artifact_decision !== "accept" ||
			review.cjk_semantic_line_breaks !== "accept" ||
			review.host_matrix !== "accept"
		)
			fail("independent review schema or decision mismatch");
		for (const defect of defects) {
			const item = object(defect, "independent review defect");
			exactKeys(item, INDEPENDENT_REVIEW_DEFECT_KEYS, "independent review defect");
			if (
				typeof item.description !== "string" ||
				!item.description.trim() ||
				item.description !== item.description.trim() ||
				item.accepted !== true
			)
				fail("independent review defect mismatch");
		}
		strings(review.checked_keys, KEYS, "independent review checked_keys");
		const results = array(review.per_key_results, "independent review per-key results");
		if (results.length !== KEYS.length) fail("independent review per-key results must contain exactly 20 entries");
		for (let index = 0; index < KEYS.length; index += 1) {
			const result = object(results[index], `independent review result ${index}`);
			exactKeys(result, INDEPENDENT_REVIEW_RESULT_KEYS, `independent review result ${index}`);
			if (
				result.key !== KEYS[index] ||
				result.result !== "accept" ||
				typeof result.notes !== "string" ||
				!result.notes.trim()
			)
				fail("independent review per-key result mismatch");
			const checks = object(result.artifact_checks, "independent review per-key artifact checks");
			exactKeys(checks, ARTIFACT_CHECK_KEYS, "independent review per-key artifact checks");
			for (const [artifact, expected] of Object.entries(ARTIFACT_CHECKS))
				if (checks[artifact] !== expected) fail("independent review per-key artifact checks missing");
		}
	}
}
async function main() {
	const args = process.argv.slice(2);
	const required = args.includes("--require-independent-review");
	const rest = args.filter(value => value !== "--require-independent-review");
	if (rest.length !== 2 || rest[0] !== "--root")
		throw new Error(
			"Usage: bun packages/coding-agent/scripts/verify-sticky-viewport-showcase.ts --root <root> [--require-independent-review]",
		);
	await verifyStickyViewportShowcase(rest[1]!, required);
	process.stdout.write("Sticky viewport evidence verified\n");
}
if (import.meta.main) await main();
