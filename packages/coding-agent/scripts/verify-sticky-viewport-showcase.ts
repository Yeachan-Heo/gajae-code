import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ansiToHtml, xterm256Color } from "./capture-sticky-viewport-showcase";

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
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
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
const transcriptCapacity = (text: string) => {
	const row = text.split("\n").findIndex(line => line.includes("status:"));
	return row < 0 ? fail("frame omits pinned status row") : row;
};
const expectedState = (state: string) => ({
	manual: state !== "live-overflow",
	notice: state === "manual-new-output",
	status: state === "live-overflow" ? "status: live follow" : "status: manual history · composer pinned",
	multiline: state === "multiline-editor-hooks-pet",
});
function validateOracle(
	key: string,
	text: string,
	metadata: Record<string, unknown>,
	stateEvidence: Record<string, unknown>,
) {
	const state = key.split("/")[0]!;
	const expected = expectedState(state);
	const lines = text.split("\n");
	if (stateEvidence.manual !== expected.manual || stateEvidence.notice !== expected.notice)
		fail(`immutable state oracle mismatch for ${key}`);
	if (lines.filter(line => line.includes(expected.status)).length !== 1)
		fail(`exact status oracle mismatch for ${key}`);
	const markers = [
		expected.status,
		...(expected.multiline
			? ["hook: ready", "completed: visual proof", "pet: ◕‿◕", "> ", "first composer line", "second composer line"]
			: ["> "]),
	];
	let position = -1;
	for (const marker of markers) {
		const next = text.indexOf(marker, position + 1);
		if (next < 0) fail(`ordered suffix oracle missing ${marker} for ${key}`);
		position = next;
	}
	if (text.split("New output — type to follow").length - 1 !== (expected.notice ? 1 : 0))
		fail(`notice cardinality oracle mismatch for ${key}`);
	if (
		expected.multiline !==
		(text.includes("hook: ready") &&
			text.includes("pet: ◕‿◕") &&
			text.includes("first composer line") &&
			text.includes("second composer line"))
	)
		fail(`multiline editor/hooks/pet oracle mismatch for ${key}`);
	if (metadata.output_revision !== (expected.notice ? "1" : "0")) fail(`manual notice invariant mismatch for ${key}`);
	if (state === "selection-boundary") {
		const copied = stateEvidence.selection_copied_text;
		if (
			stateEvidence.selection_scope !== "transcript" ||
			typeof copied !== "string" ||
			!copied.trim() ||
			copied.includes("status:") ||
			copied.includes("> ") ||
			!lines.some(line => line.includes(copied.trim()))
		)
			fail(`selection oracle mismatch for ${key}`);
	} else if (stateEvidence.selection_scope !== "none" || stateEvidence.selection_copied_text !== "")
		fail(`selection oracle mismatch for ${key}`);
	const historicalRows = stateEvidence.manual_historical_rows;
	const preOutputCapacity = stateEvidence.manual_pre_output_capacity;
	if (expected.manual) {
		if (
			!Number.isInteger(preOutputCapacity) ||
			(preOutputCapacity as number) < 0 ||
			!Array.isArray(historicalRows) ||
			historicalRows.length !== ((preOutputCapacity as number) > 0 ? 1 : 0) ||
			historicalRows.some(row => typeof row !== "string" || !row.trim() || !lines.includes(row))
		)
			fail(`manual historical transcript evidence mismatch for ${key}`);
	} else if (preOutputCapacity !== 0 || !Array.isArray(historicalRows) || historicalRows.length !== 0)
		fail(`manual historical transcript evidence mismatch for ${key}`);
}
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
	const entries = array(manifest.entries, "manifest entries");
	if (entries.length !== KEYS.length) fail("manifest entries must contain exactly 20 entries");
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
		if (state === "multiline-editor-hooks-pet" && (!ansi.includes("\x1b[9m") || !html.includes("line-through")))
			fail(`entry ${key} strikethrough evidence missing`);
		if (state === "selection-boundary" && !ansi.includes("\x1b[7m"))
			fail(`entry ${key} inverse selection evidence missing`);
		if (state === "narrow-cjk" && CJK.some(boundary => !text.includes(boundary)))
			fail("narrow CJK visible terminal evidence missing");
		if (
			text
				.split("\n")
				.slice(0, -1)
				.some(row => Bun.stringWidth(row) !== columns) ||
			text.split("\n").length - 1 !== rows
		)
			fail(`entry ${key} terminal dimensions mismatch`);
		if (mode === "ascii-no-color" ? /\x1b\[/.test(ansi) : !/\x1b\[[0-9;]*(?:3[0-9]|38;)/.test(ansi))
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
			metadata.source_revision !== "production-tui-virtual-terminal-v2" ||
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
			stateEvidence.composer_visible !== true
		)
			fail(`metadata schema mismatch for ${key}`);
		if (stateEvidence.transcript_capacity !== transcriptCapacity(text))
			fail(`capacity metadata/frame mismatch for ${key}`);
		validateOracle(key, text, metadata, stateEvidence);
		if (state === "capacity-zero" && transcriptCapacity(text) !== 0)
			fail(`zero capacity frame invariant mismatch for ${key}`);
		if (state === "capacity-one" && transcriptCapacity(text) !== 1)
			fail(`one capacity frame invariant mismatch for ${key}`);
		if (state === "capacity-many" && transcriptCapacity(text) < 2)
			fail(`many capacity frame invariant mismatch for ${key}`);
		if (state === "narrow-cjk") {
			strings(metadata.cjk_phrase_boundaries, CJK, "narrow CJK boundaries");
			if (CJK.some(boundary => !text.includes(boundary))) fail("narrow CJK visible terminal evidence missing");
		} else strings(metadata.cjk_phrase_boundaries, [], `non-narrow CJK boundaries for ${key}`);
	}
	const required = new Set([
		"manifest.json",
		"review-input.json",
		...KEYS.flatMap(key => PAYLOADS.map(file => `${key}/${file}`)),
		...(requireIndependentReview ? ["independent-review.json"] : []),
	]);
	for (const file of await allFiles(root)) if (!required.has(file)) fail(`unexpected file ${file}`);
	const reviewInput = await readJson(path.join(root, "review-input.json"), "review input");
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
